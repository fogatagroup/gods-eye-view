import * as Cesium from 'cesium';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STEM_UPDATE_INTERVAL_MS = 300;
const STEM_TARGET_PX = 65;
const OVERLAY_COHORT_LIMIT = 160;
const OVERLAY_COLLISION_CAPACITY = 96;
const OVERLAY_MAX_DISTANCE_M = 14_000_000;

export const PANAMA_OFFICIAL_LAYER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'panama-official-hotels',
    name: 'Panamá Oficial · Hotels',
    icon: '🏨',
    color: '#36dcff',
    categories: Object.freeze(['hotel', 'hostel', 'resort']),
  }),
  Object.freeze({
    id: 'panama-official-agencies',
    name: 'Panamá Oficial · Agencies',
    icon: '🧭',
    color: '#60d394',
    categories: Object.freeze(['travel_agency', 'tour_operator']),
  }),
  Object.freeze({
    id: 'panama-official-tourism',
    name: 'Panamá Oficial · Tourism',
    icon: '✦',
    color: '#f2c94c',
    categories: Object.freeze([
      'attraction',
      'museum',
      'restaurant',
      'nightlife',
      'beach',
      'park',
      'event',
      'transport',
      'other',
    ]),
  }),
]);

const CATEGORY_LABELS = Object.freeze({
  hotel: 'Hotel',
  hostel: 'Hostal',
  resort: 'Resort',
  travel_agency: 'Agencia de viajes',
  tour_operator: 'Operador turístico',
  attraction: 'Atracción',
  museum: 'Museo',
  restaurant: 'Restaurante',
  nightlife: 'Vida nocturna',
  beach: 'Playa',
  park: 'Parque',
  event: 'Evento',
  transport: 'Transporte',
  other: 'Turismo',
});

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || 'Turismo';
}

export function panamaOfficialDisplayName(value) {
  const text = String(value || '').trim();
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

export function panamaOfficialStemHeight(
  distance,
  canvasHeight = 1080,
  fov = Math.PI / 3,
) {
  const range = Math.max(1, Number(distance) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1080);
  const fieldOfView = Number.isFinite(fov) ? fov : Math.PI / 3;
  return range * 2 * Math.tan(fieldOfView / 2) * (STEM_TARGET_PX / height);
}

export function createPanamaOfficialOverlayEntry(
  record,
  definition,
  position,
  cullPosition,
) {
  return {
    id: record.id,
    position,
    cullPosition,
    variant: 'card',
    title: panamaOfficialDisplayName(record.name),
    details: [],
    accent: definition.color,
    priority: (record.verified ? 1200 : 1000) + (record.rating || 0),
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: OVERLAY_MAX_DISTANCE_M,
    distanceFadeStartRatio: 250_000 / OVERLAY_MAX_DISTANCE_M,
    distanceScale: {
      near: 250_000,
      nearValue: 1,
      far: 9_000_000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

function locationLine(record) {
  return [record.address, record.district, record.province]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' · ');
}

function contactLine(record) {
  const phone = record.whatsapp
    ? `WhatsApp ${record.whatsapp}`
    : record.phone
      ? `Tel. ${record.phone}`
      : null;
  return (
    phone ||
    record.website?.replace(/^https:\/\//, '').replace(/\/$/, '') ||
    null
  );
}

export function panamaOfficialLabelModel(record, accent) {
  return {
    title: record.name,
    details: [
      `PANAMÁ OFICIAL · ${categoryLabel(record.category).toUpperCase()}`,
      locationLine(record),
      contactLine(record),
      record.sourceUrl ? 'Ficha: panamaoficial.com' : null,
    ].filter(Boolean),
    accent,
  };
}

/** Construct one independently toggleable Panamá Oficial point layer. */
export function createPanamaOfficialLayer({
  definition,
  source,
  services,
} = {}) {
  if (!definition?.id || !Array.isArray(definition.categories))
    throw new TypeError('A Panamá Oficial layer definition is required');
  if (typeof source?.getPlaces !== 'function')
    throw new TypeError('A Panamá Oficial source is required');
  const { context, overlayHost, picking, render } = services || {};
  if (
    !context?.registerEntityContext ||
    !overlayHost?.setEntries ||
    !overlayHost?.setVisible ||
    !overlayHost?.clearSource ||
    !picking?.registerPickOwner ||
    !render?.governorRequestRender
  )
    throw new TypeError('Panamá Oficial application services are required');

  const color = Cesium.Color.fromCssColorString(definition.color);
  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    records: new Map(),
    visuals: new Map(),
    selectedId: null,
    loading: false,
    stale: false,
    error: null,
    lastUpdate: null,
    abort: null,
    clickHandler: null,
    contextSelectedHandler: null,
    preRenderRemover: null,
    lastStemUpdate: Number.NEGATIVE_INFINITY,
  };

  function updateVisualGeometry(visual) {
    if (!state.viewer || !visual) return;
    const distance = Cesium.Cartesian3.distance(
      state.viewer.camera.positionWC,
      visual.base,
    );
    const canvasHeight =
      state.viewer.scene.canvas.clientHeight ||
      state.viewer.scene.canvas.height ||
      1080;
    const stemHeight = panamaOfficialStemHeight(
      distance,
      canvasHeight,
      state.viewer.camera.frustum?.fov,
    );
    Cesium.Cartesian3.fromDegrees(
      visual.longitude,
      visual.latitude,
      stemHeight,
      Cesium.Ellipsoid.WGS84,
      visual.tip,
    );
    visual.bufferIndex = 1 - visual.bufferIndex;
    const stemPositions = visual.stemPositionBuffers[visual.bufferIndex];
    stemPositions[0] = visual.base;
    stemPositions[1] = visual.tip;
    visual.entity.position.setValue(visual.tip);
    visual.entity.polyline.positions.setValue(stemPositions);
  }

  function publishOverlayEntries() {
    if (!state.enabled) return;
    const entries = [];
    for (const [id, visual] of state.visuals) {
      const record = state.records.get(id);
      if (!record) continue;
      entries.push(
        createPanamaOfficialOverlayEntry(
          record,
          definition,
          () => visual.tip,
          visual.base,
        ),
      );
    }
    overlayHost.setEntries(definition.id, entries, {
      cohortLimit: OVERLAY_COHORT_LIMIT,
      collisionCapacity: OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function styleEntity(entity, selected) {
    if (!entity?.point) return;
    entity.point.pixelSize = selected ? 15 : 10;
    entity.point.color = selected ? Cesium.Color.WHITE : color;
    entity.point.outlineWidth = selected ? 3 : 2;
  }

  function clearLocalSelection({ clearContext = true } = {}) {
    if (state.selectedId) {
      styleEntity(state.dataSource?.entities.getById(state.selectedId), false);
    }
    state.selectedId = null;
    if (clearContext) context.clearSelectedEntityContextForLayer(definition.id);
    render.governorRequestRender(`panama-official-selection:${definition.id}`);
  }

  function selectRecord(id) {
    const entity = state.dataSource?.entities.getById(id);
    if (!entity || !state.records.has(id)) return false;
    clearLocalSelection();
    state.selectedId = id;
    styleEntity(entity, true);
    context.selectEntityContext(entity);
    render.governorRequestRender(`panama-official-selection:${definition.id}`);
    return true;
  }

  function registerRecordContext(entity, record) {
    entity.gevTrackedId = record.id;
    entity.gevDisplayPosition = () =>
      entity.position?.getValue(Cesium.JulianDate.now()) || null;
    entity.gevLabelModel = panamaOfficialLabelModel(record, definition.color);
    context.registerEntityContext(entity, {
      id: record.id,
      layerId: definition.id,
      layerName: definition.name,
      source: source.label || 'PANAMAOFICIAL.COM · OFICIAL',
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        category: record.category,
        summary: record.summary,
        address: record.address,
        province: record.province,
        district: record.district,
        corregimiento: record.corregimiento,
        phone: record.phone,
        whatsapp: record.whatsapp,
        email: record.email,
        website: record.website,
        imageUrl: record.imageUrl,
        rating: record.rating,
        verified: record.verified,
        sourceUrl: record.sourceUrl,
        updatedAt: record.updatedAt,
      },
    });
  }

  function renderSnapshot(records) {
    const next = new Map(records.map((record) => [record.id, record]));
    for (const entity of [...state.dataSource.entities.values]) {
      if (!next.has(entity.id)) {
        state.dataSource.entities.remove(entity);
        state.visuals.delete(entity.id);
      }
    }
    context.removeEntityContextsForLayer(definition.id, {
      retainIds: new Set(next.keys()),
    });

    for (const record of next.values()) {
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      let entity = state.dataSource.entities.getById(record.id);
      let visual = state.visuals.get(record.id);
      if (!entity) {
        const base = position;
        const tip = Cesium.Cartesian3.clone(base);
        visual = {
          entity: null,
          longitude: record.longitude,
          latitude: record.latitude,
          base,
          tip,
          stemPositionBuffers: [
            [base, tip],
            [base, tip],
          ],
          bufferIndex: 0,
        };
        entity = state.dataSource.entities.add({
          id: record.id,
          name: record.name,
          position: tip,
          polyline: {
            positions: visual.stemPositionBuffers[0],
            width: 3.5,
            material: color.withAlpha(0.92),
          },
          point: {
            pixelSize: 10,
            color,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.82),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        visual.entity = entity;
        state.visuals.set(record.id, visual);
        updateVisualGeometry(visual);
      } else {
        const previous = state.records.get(record.id);
        entity.name = record.name;
        if (
          previous?.longitude !== record.longitude ||
          previous?.latitude !== record.latitude
        ) {
          visual.longitude = record.longitude;
          visual.latitude = record.latitude;
          Cesium.Cartesian3.clone(position, visual.base);
          updateVisualGeometry(visual);
        }
      }
      entity.__panamaOfficialLayerId = definition.id;
      styleEntity(entity, record.id === state.selectedId);
      registerRecordContext(entity, record);
    }
    state.records = next;
    if (state.selectedId && !next.has(state.selectedId))
      state.selectedId = null;
    publishOverlayEntries();
    render.governorRequestRender(`panama-official-data:${definition.id}`);
  }

  async function load() {
    if (!state.enabled || state.loading) return true;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.loading = true;
    state.error = null;
    try {
      const snapshot = await source.getPlaces(definition.categories, {
        signal: abort.signal,
      });
      if (abort.signal.aborted || state.abort !== abort || !state.enabled)
        return true;
      renderSnapshot(snapshot.records);
      state.lastUpdate = Date.now();
      state.stale = false;
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || abort.signal.aborted) return true;
      state.stale = state.records.size > 0;
      state.error = error?.message || 'Panamá Oficial unavailable';
      return true;
    } finally {
      if (state.abort === abort) state.abort = null;
      state.loading = false;
      render.governorRequestRender(`panama-official-status:${definition.id}`);
    }
  }

  return {
    id: definition.id,
    name: definition.name,
    icon: definition.icon,
    source: source.label || 'PANAMAOFICIAL.COM · OFICIAL',
    updateInterval: REFRESH_INTERVAL_MS,
    statsRefreshInterval: 1000,
    init(viewer) {
      if (state.viewer)
        throw new Error(`${definition.id} is already initialized`);
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(definition.id);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      overlayHost.setVisible(definition.id, false);
      state.preRenderRemover = viewer.scene.preRender.addEventListener(() => {
        if (!state.enabled || !state.visuals.size) return;
        const now = performance.now();
        if (now - state.lastStemUpdate < STEM_UPDATE_INTERVAL_MS) return;
        state.lastStemUpdate = now;
        for (const visual of state.visuals.values())
          updateVisualGeometry(visual);
      });
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        if (!state.enabled) return;
        const picked = viewer.scene.pick(click.position);
        const pickedId = picking.resolvePickId(picked);
        if (pickedId && state.records.has(pickedId)) selectRecord(pickedId);
        else if (
          pickedId &&
          picking.isOwnedByOtherLayer(definition.id, pickedId)
        )
          return;
        else if (state.selectedId) clearLocalSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      state.contextSelectedHandler = (event) => {
        if (state.selectedId && event.detail?.layerId !== definition.id)
          clearLocalSelection({ clearContext: false });
      };
      globalThis.window?.addEventListener?.(
        'gev:entity-selected',
        state.contextSelectedHandler,
      );
    },
    enable() {
      state.enabled = true;
      state.dataSource.show = true;
      overlayHost.setVisible(definition.id, true);
      state.lastStemUpdate = Number.NEGATIVE_INFINITY;
      for (const visual of state.visuals.values()) updateVisualGeometry(visual);
      publishOverlayEntries();
      picking.registerPickOwner(definition.id, (pickedId) =>
        state.records.has(pickedId),
      );
    },
    disable() {
      state.enabled = false;
      state.abort?.abort();
      state.abort = null;
      picking.unregisterPickOwner(definition.id);
      if (state.dataSource) state.dataSource.show = false;
      overlayHost.clearSource(definition.id);
      overlayHost.setVisible(definition.id, false);
      clearLocalSelection();
    },
    update: load,
    destroy(viewer = state.viewer) {
      this.disable();
      state.clickHandler?.destroy();
      state.clickHandler = null;
      state.preRenderRemover?.();
      state.preRenderRemover = null;
      if (state.contextSelectedHandler)
        globalThis.window?.removeEventListener?.(
          'gev:entity-selected',
          state.contextSelectedHandler,
        );
      state.contextSelectedHandler = null;
      context.removeEntityContextsForLayer(definition.id);
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.records = new Map();
      state.visuals = new Map();
      state.viewer = null;
    },
    getRowControls() {
      const counts = new Map();
      for (const record of state.records.values())
        counts.set(record.category, (counts.get(record.category) || 0) + 1);
      return {
        legend: [...counts.entries()].map(([category, count]) => ({
          label: categoryLabel(category),
          color: definition.color,
          count,
          blurb: 'Ubicación publicada por Panamá Oficial.',
        })),
      };
    },
    getStats() {
      return {
        count: state.records.size,
        countLabel: state.enabled ? `${state.records.size} lugares` : '',
        lastUpdate: state.lastUpdate,
        stale: state.stale,
        error: state.error,
        status: state.loading
          ? 'loading'
          : state.error
            ? 'unavailable'
            : 'ready',
        loading: state.loading,
        loadingLabel: state.loading ? 'loading Panamá Oficial places' : '',
      };
    },
  };
}
