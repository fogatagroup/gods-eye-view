import * as Cesium from 'cesium';

export const POPULATED_PLACES_LAYER_ID = 'populated-places';
export const POPULATED_PLACES_COLOR = '#ff5fd0';

const PANAMA_BOUNDS = Object.freeze({
  west: -83.1,
  south: 7,
  east: -77,
  north: 9.8,
});
const HOVER_SOURCE = `${POPULATED_PLACES_LAYER_ID}:hover`;
const LABEL_SOURCE = `${POPULATED_PLACES_LAYER_ID}:labels`;
const MOVE_DEBOUNCE_MS = 300;

export function populatedPlacesLod(altitudeM) {
  const altitude = Number(altitudeM);
  if (!Number.isFinite(altitude) || altitude > 600_000)
    return Object.freeze({
      name: 'far',
      minPopulation: 0,
      labelPopulation: 50_000,
      labelLimit: 24,
      snap: 0.5,
    });
  if (altitude > 180_000)
    return Object.freeze({
      name: 'regional',
      minPopulation: 0,
      labelPopulation: 10_000,
      labelLimit: 60,
      snap: 0.35,
    });
  if (altitude > 60_000)
    return Object.freeze({
      name: 'near',
      minPopulation: 0,
      labelPopulation: 5_000,
      labelLimit: 100,
      snap: 0.2,
    });
  return Object.freeze({
    name: 'local',
    minPopulation: 0,
    labelPopulation: 1_000,
    labelLimit: 160,
    snap: 0.1,
  });
}

export function populatedPlacePixelSize(population) {
  const value = Number(population);
  if (!Number.isFinite(value) || value <= 0) return 0.8;
  // Point area, rather than diameter, tracks population. This prevents tiny
  // settlements from visually overstating how much of the country is populated.
  return Math.min(11, 0.8 + 10.2 * Math.sqrt(value / 50_000));
}

function populatedPlaceOutlineWidth(pixelSize) {
  if (pixelSize >= 8) return 1.5;
  if (pixelSize >= 4) return 1;
  if (pixelSize >= 2) return 0.6;
  return 0;
}

function formattedCensusNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unknown';
}

export function populatedPlaceTooltipModel(record, { compact = false } = {}) {
  const details = compact
    ? [
        `Population (2010): ${formattedCensusNumber(record.population)}`,
        `Type: ${record.placeType || 'Unknown'}`,
        '2010 CENSUS DATA',
      ]
    : [
        `Name: ${record.name}`,
        `Code: ${record.code || 'Unknown'}`,
        `Type: ${record.placeType || 'Unknown'}`,
        `Population: ${formattedCensusNumber(record.population)}`,
        `Male: ${formattedCensusNumber(record.male)}`,
        `Female: ${formattedCensusNumber(record.female)}`,
        `Occupied dwellings: ${formattedCensusNumber(record.occupiedDwellings)}`,
        'Reference year: 2010',
        'Source: MiAmbiente Panamá',
      ];
  return {
    title: compact ? 'POPULATED PLACE' : record.name,
    details,
    accent: POPULATED_PLACES_COLOR,
  };
}

export function createPopulatedPlaceLabelEntry(record, position) {
  return {
    id: `label:${record.id}`,
    position,
    variant: 'card',
    title: record.name,
    details: [],
    accent: POPULATED_PLACES_COLOR,
    priority: populationValue(record),
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: 1_200_000,
    distanceFadeStartRatio: 0.75,
    distanceScale: {
      near: 250_000,
      nearValue: 1,
      far: 1_200_000,
      farValue: 0.65,
    },
    edgeFade: 'none',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

function intersectPanama(bounds) {
  if (!bounds) return null;
  const result = {
    west: Math.max(PANAMA_BOUNDS.west, bounds.west),
    south: Math.max(PANAMA_BOUNDS.south, bounds.south),
    east: Math.min(PANAMA_BOUNDS.east, bounds.east),
    north: Math.min(PANAMA_BOUNDS.north, bounds.north),
  };
  return result.west < result.east && result.south < result.north
    ? result
    : null;
}

function visibleBounds(viewer) {
  const ellipsoid = viewer?.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  const rectangle = viewer?.camera?.computeViewRectangle?.(ellipsoid);
  if (rectangle) {
    const bounds = intersectPanama({
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    });
    if (bounds) return bounds;
  }
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  if (!camera || !canvas) return null;
  const center = camera.pickEllipsoid?.(
    new Cesium.Cartesian2(
      (canvas.clientWidth || canvas.width) / 2,
      (canvas.clientHeight || canvas.height) / 2,
    ),
    ellipsoid,
  );
  if (!center) return null;
  const location = Cesium.Cartographic.fromCartesian(center);
  const altitude = Math.max(10_000, camera.positionCartographic?.height || 0);
  const latSpan = Math.min(2.2, altitude / 85_000);
  const lonSpan = latSpan / Math.max(0.25, Math.cos(location.latitude));
  return intersectPanama({
    west: Cesium.Math.toDegrees(location.longitude) - lonSpan,
    south: Cesium.Math.toDegrees(location.latitude) - latSpan,
    east: Cesium.Math.toDegrees(location.longitude) + lonSpan,
    north: Cesium.Math.toDegrees(location.latitude) + latSpan,
  });
}

function snapBounds(bounds, step) {
  if (!bounds) return null;
  return intersectPanama({
    west: Math.floor(bounds.west / step) * step,
    south: Math.floor(bounds.south / step) * step,
    east: Math.ceil(bounds.east / step) * step,
    north: Math.ceil(bounds.north / step) * step,
  });
}

function populationValue(record) {
  return Number.isFinite(record?.population) ? record.population : 0;
}

/** Viewport-driven 2010 populated-place points with primitive-based LOD. */
export function createPopulatedPlacesLayer({ source, services } = {}) {
  if (typeof source?.getFeatures !== 'function')
    throw new TypeError('Populated Places requires an ArcGIS source');
  const { context, overlayHost, picking, render } = services || {};
  if (
    !context?.registerEntityContext ||
    !overlayHost?.setEntries ||
    !picking?.registerPickOwner ||
    !render?.governorRequestRender
  )
    throw new TypeError('Populated Places application services are required');

  const color = Cesium.Color.fromCssColorString(POPULATED_PLACES_COLOR);
  const state = {
    viewer: null,
    enabled: false,
    points: null,
    selectionSource: null,
    records: new Map(),
    visuals: new Map(),
    loadedQueries: new Set(),
    lod: populatedPlacesLod(Number.POSITIVE_INFINITY),
    visibleCount: 0,
    loading: false,
    error: null,
    lastUpdate: null,
    request: null,
    generation: 0,
    moveRemover: null,
    moveTimer: null,
    clickHandler: null,
    hoverHandler: null,
    hoveredId: null,
    selectedId: null,
    contextSelectedHandler: null,
    credit: null,
  };

  function pointStyle(record, mode = 'normal') {
    const base = populatedPlacePixelSize(record.population);
    const point = state.visuals.get(record.id)?.point;
    if (!point) return;
    point.pixelSize =
      mode === 'selected' ? base + 6 : mode === 'hover' ? base + 3 : base;
    point.color =
      mode === 'selected'
        ? Cesium.Color.WHITE
        : mode === 'hover'
          ? color.brighten(0.35, new Cesium.Color())
          : color.withAlpha(0.92);
    point.outlineColor =
      mode === 'selected'
        ? color.withAlpha(1)
        : Cesium.Color.fromCssColorString('#4a0b35').withAlpha(0.9);
    const baseOutline = populatedPlaceOutlineWidth(base);
    point.outlineWidth =
      mode === 'selected'
        ? 2.5
        : mode === 'hover'
          ? Math.max(1, baseOutline + 0.8)
          : baseOutline;
  }

  function recordPosition(record) {
    return Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 40);
  }

  function addRecord(record) {
    if (state.records.has(record.id)) return;
    const position = recordPosition(record);
    const point = state.points.add({
      id: record.id,
      position,
      pixelSize: populatedPlacePixelSize(record.population),
      color: color.withAlpha(0.92),
      outlineColor: Cesium.Color.fromCssColorString('#4a0b35').withAlpha(0.9),
      outlineWidth: populatedPlaceOutlineWidth(
        populatedPlacePixelSize(record.population),
      ),
      scaleByDistance: new Cesium.NearFarScalar(500, 1.25, 1_500_000, 0.75),
      translucencyByDistance: new Cesium.NearFarScalar(500, 1, 2_500_000, 0.72),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    state.records.set(record.id, record);
    state.visuals.set(record.id, { point, position });
  }

  function publishLabels() {
    if (!state.enabled) {
      overlayHost.clearSource(LABEL_SOURCE);
      return;
    }
    const candidates = [...state.records.values()]
      .filter(
        (record) =>
          populationValue(record) >= state.lod.labelPopulation &&
          state.visuals.get(record.id)?.point.show,
      )
      .sort((a, b) => populationValue(b) - populationValue(a))
      .slice(0, state.lod.labelLimit);
    overlayHost.setEntries(
      LABEL_SOURCE,
      candidates.map((record) =>
        createPopulatedPlaceLabelEntry(
          record,
          state.visuals.get(record.id).position,
        ),
      ),
      {
        cohortLimit: state.lod.labelLimit,
        collisionCapacity: Math.min(96, state.lod.labelLimit),
        moving: false,
      },
    );
  }

  function applyLod() {
    if (!state.viewer) return;
    state.lod = populatedPlacesLod(
      state.viewer.camera.positionCartographic?.height,
    );
    let visibleCount = 0;
    for (const [id, record] of state.records) {
      const visual = state.visuals.get(id);
      const visible =
        state.enabled && populationValue(record) >= state.lod.minPopulation;
      visual.point.show = visible;
      if (visible) visibleCount += 1;
    }
    state.visibleCount = visibleCount;
    publishLabels();
    render.governorRequestRender('populated-places-lod');
  }

  function setHover(id) {
    if (state.hoveredId === id) return;
    const previous = state.hoveredId;
    state.hoveredId = id;
    if (previous && previous !== state.selectedId)
      pointStyle(state.records.get(previous));
    const record = id ? state.records.get(id) : null;
    if (record) {
      if (id !== state.selectedId) pointStyle(record, 'hover');
      overlayHost.setEntries(
        HOVER_SOURCE,
        [
          {
            id: `hover:${id}`,
            position: state.visuals.get(id).position,
            variant: 'selected',
            ...populatedPlaceTooltipModel(record, { compact: true }),
            priority: Number.MAX_SAFE_INTEGER,
            collisionGroup: 'ambient-card',
            protected: true,
            edgeFade: 'none',
            interactive: false,
            minDistance: 0,
            maxDistance: 1_200_000,
            horizonCull: true,
            terrainOcclusion: false,
          },
        ],
        { cohortLimit: 1, collisionCapacity: 0, moving: false },
      );
    } else overlayHost.clearSource(HOVER_SOURCE);
    render.governorRequestRender('populated-places-hover');
  }

  function clearSelection({ clearContext = true } = {}) {
    const previous = state.selectedId;
    state.selectedId = null;
    if (previous) pointStyle(state.records.get(previous));
    state.selectionSource?.entities.removeAll();
    if (clearContext)
      context.clearSelectedEntityContextForLayer(POPULATED_PLACES_LAYER_ID);
  }

  function selectRecord(id) {
    const record = state.records.get(id);
    const visual = state.visuals.get(id);
    if (!record || !visual) return;
    clearSelection();
    state.selectedId = id;
    pointStyle(record, 'selected');
    const entity = state.selectionSource.entities.add({
      id,
      name: record.name,
      position: visual.position,
      point: {
        pixelSize: populatedPlacePixelSize(record.population) + 8,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: color,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevTrackedId = id;
    entity.gevDisplayPosition = () => visual.position;
    entity.gevLabelModel = populatedPlaceTooltipModel(record);
    context.removeEntityContextsForLayer(POPULATED_PLACES_LAYER_ID);
    context.registerEntityContext(entity, {
      id,
      layerId: POPULATED_PLACES_LAYER_ID,
      layerName: 'Populated Places',
      source: source.label || 'MIAMBIENTE · 2010 CENSUS DATA',
      dataSource: state.selectionSource,
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        code: record.code,
        type: record.placeType,
        population: record.population,
        male: record.male,
        female: record.female,
        occupiedDwellings: record.occupiedDwellings,
        referenceYear: 2010,
      },
    });
    context.selectEntityContext(entity);
    render.governorRequestRender('populated-places-selection');
  }

  async function refresh() {
    if (!state.enabled || !state.viewer) return true;
    applyLod();
    const bounds = snapBounds(visibleBounds(state.viewer), state.lod.snap);
    if (!bounds) return true;
    const queryKey = `${Object.values(bounds)
      .map((value) => value.toFixed(3))
      .join(',')}:p${state.lod.minPopulation}`;
    if (state.loadedQueries.has(queryKey)) return true;
    state.request?.abort();
    const request = new AbortController();
    const generation = ++state.generation;
    state.request = request;
    state.loading = true;
    state.error = null;
    try {
      const records = await source.getFeatures(bounds, {
        signal: request.signal,
        minPopulation: state.lod.minPopulation,
      });
      if (
        request.signal.aborted ||
        generation !== state.generation ||
        !state.enabled
      )
        return true;
      for (const record of records) addRecord(record);
      state.loadedQueries.add(queryKey);
      state.lastUpdate = Date.now();
      applyLod();
      return true;
    } catch (error) {
      if (request.signal.aborted || error?.name === 'AbortError') return true;
      state.error = error?.message || 'MiAmbiente populated places unavailable';
      return true;
    } finally {
      if (state.request === request) state.request = null;
      if (generation === state.generation) state.loading = false;
      render.governorRequestRender('populated-places-status');
    }
  }

  function scheduleRefresh() {
    if (!state.enabled) return;
    applyLod();
    clearTimeout(state.moveTimer);
    state.moveTimer = setTimeout(() => void refresh(), MOVE_DEBOUNCE_MS);
  }

  return {
    id: POPULATED_PLACES_LAYER_ID,
    name: 'Populated Places',
    icon: '🏘️',
    source: source.label || 'MIAMBIENTE · 2010 CENSUS DATA',
    updateInterval: 0,
    statsRefreshInterval: 500,
    init(viewer) {
      if (state.viewer)
        throw new Error('Populated Places is already initialized');
      state.viewer = viewer;
      state.points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      state.points.show = false;
      viewer.scene.primitives.add(state.points);
      state.selectionSource = new Cesium.CustomDataSource(
        `${POPULATED_PLACES_LAYER_ID}:selection`,
      );
      viewer.dataSources.add(state.selectionSource);
      state.credit = new Cesium.Credit(
        'MIAMBIENTE PANAMÁ · 2010 CENSUS DATA',
        true,
      );
      state.moveRemover =
        viewer.camera.moveEnd.addEventListener(scheduleRefresh);
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        if (!state.enabled) return;
        const id = picking.resolvePickId(viewer.scene.pick(click.position));
        if (id && state.records.has(id)) selectRecord(id);
        else if (
          id &&
          picking.isOwnedByOtherLayer(POPULATED_PLACES_LAYER_ID, id)
        )
          return;
        else clearSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      state.hoverHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.hoverHandler.setInputAction((movement) => {
        if (!state.enabled) return;
        const id = picking.resolvePickId(
          viewer.scene.pick(movement.endPosition),
        );
        setHover(id && state.records.has(id) ? id : null);
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      state.contextSelectedHandler = (event) => {
        if (
          state.selectedId &&
          event.detail?.layerId !== POPULATED_PLACES_LAYER_ID
        )
          clearSelection({ clearContext: false });
      };
      globalThis.window?.addEventListener?.(
        'gev:entity-selected',
        state.contextSelectedHandler,
      );
    },
    enable() {
      state.enabled = true;
      state.points.show = true;
      overlayHost.setVisible(HOVER_SOURCE, true);
      overlayHost.setVisible(LABEL_SOURCE, true);
      state.viewer.creditDisplay?.addStaticCredit(state.credit);
      picking.registerPickOwner(POPULATED_PLACES_LAYER_ID, (id) =>
        state.records.has(id),
      );
      applyLod();
    },
    update: refresh,
    disable() {
      state.enabled = false;
      state.generation += 1;
      state.request?.abort();
      state.request = null;
      clearTimeout(state.moveTimer);
      state.points.show = false;
      setHover(null);
      clearSelection();
      overlayHost.clearSource(HOVER_SOURCE);
      overlayHost.setVisible(HOVER_SOURCE, false);
      overlayHost.clearSource(LABEL_SOURCE);
      overlayHost.setVisible(LABEL_SOURCE, false);
      state.viewer?.creditDisplay?.removeStaticCredit(state.credit);
      picking.unregisterPickOwner(POPULATED_PLACES_LAYER_ID);
      state.loading = false;
      state.visibleCount = 0;
    },
    destroy(viewer) {
      if (state.enabled) this.disable();
      state.generation += 1;
      state.request?.abort();
      clearTimeout(state.moveTimer);
      state.moveRemover?.();
      state.moveRemover = null;
      state.clickHandler?.destroy();
      state.hoverHandler?.destroy();
      globalThis.window?.removeEventListener?.(
        'gev:entity-selected',
        state.contextSelectedHandler,
      );
      context.removeEntityContextsForLayer(POPULATED_PLACES_LAYER_ID);
      if (state.selectionSource)
        viewer.dataSources.remove(state.selectionSource, true);
      if (state.points) viewer.scene.primitives.remove(state.points);
      overlayHost.clearSource(LABEL_SOURCE);
      state.records.clear();
      state.visuals.clear();
      state.viewer = null;
      state.points = null;
      state.selectionSource = null;
    },
    getStats() {
      return {
        count: state.visibleCount,
        totalLoaded: state.records.size,
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        loadingLabel: state.loading
          ? `LOADING · ${state.lod.name.toUpperCase()} LOD`
          : `${state.lod.name.toUpperCase()} LOD`,
        error: state.error,
        cameraAltitudeM: state.viewer?.camera?.positionCartographic?.height,
      };
    },
    getCachedFeatures() {
      return (
        source.getCachedFeatures?.() ||
        Object.freeze([...state.records.values()])
      );
    },
  };
}
