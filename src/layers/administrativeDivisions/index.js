import * as Cesium from 'cesium';

export const ADMINISTRATIVE_LAYER_ID = 'administrative-divisions';
export const ADMINISTRATIVE_DISTRICT_ALTITUDE_M = 500_000;
export const ADMINISTRATIVE_CORREGIMIENTO_ALTITUDE_M = 100_000;

const LABEL_SOURCE = `${ADMINISTRATIVE_LAYER_ID}:labels`;
const HOVER_SOURCE = `${ADMINISTRATIVE_LAYER_ID}:hover`;
const PANAMA_BOUNDS = Object.freeze({
  west: -83.1,
  south: 7,
  east: -77,
  north: 9.8,
});
const LEVEL_ORDER = Object.freeze(['province', 'district', 'corregimiento']);
const LEVEL_STYLES = Object.freeze({
  province: Object.freeze({ color: '#ff6000', width: 3.5, fillAlpha: 0.018 }),
  district: Object.freeze({ color: '#ff6000', width: 2.2, fillAlpha: 0.012 }),
  corregimiento: Object.freeze({
    color: '#ff6000',
    width: 1.25,
    fillAlpha: 0.008,
  }),
});

export function administrativeLodForAltitude(altitudeM) {
  const altitude = Number(altitudeM);
  if (
    !Number.isFinite(altitude) ||
    altitude > ADMINISTRATIVE_DISTRICT_ALTITUDE_M
  )
    return 'province';
  if (altitude > ADMINISTRATIVE_CORREGIMIENTO_ALTITUDE_M) return 'district';
  return 'corregimiento';
}

function hierarchyRings(hierarchy, output = []) {
  if (hierarchy?.positions?.length) output.push(hierarchy.positions);
  for (const hole of hierarchy?.holes || []) hierarchyRings(hole, output);
  return output;
}

function entityCenter(entity) {
  const hierarchy = entity.polygon?.hierarchy?.getValue(
    Cesium.JulianDate.now(),
  );
  if (!hierarchy?.positions?.length) return null;
  const center = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
  const cartographic = Cesium.Cartographic.fromCartesian(center);
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    120,
  );
}

function entitySpan(entity) {
  const hierarchy = entity.polygon?.hierarchy?.getValue(
    Cesium.JulianDate.now(),
  );
  return hierarchy?.positions?.length
    ? Cesium.BoundingSphere.fromPoints(hierarchy.positions).radius
    : 0;
}

function featureProperties(entity) {
  return entity.properties?.getValue(Cesium.JulianDate.now()) || {};
}

function legalField(properties, level) {
  if (level === 'province') return properties.LMPRO_LEY;
  if (level === 'district') return properties.LMCO_Ley;
  return properties.LMCO_LEY;
}

function extraDetails(properties, level) {
  return [
    properties.__adminCode ? `Code: ${properties.__adminCode}` : null,
    level !== 'province' && properties.LMPR_NOMB
      ? `Province / Comarca: ${properties.LMPR_NOMB}`
      : null,
    level === 'corregimiento' && properties.LMDI_NOMB
      ? `District: ${properties.LMDI_NOMB}`
      : null,
    legalField(properties, level)
      ? `Legal basis: ${legalField(properties, level)}`
      : null,
    properties.COD_GACETA ? `Gazette: ${properties.COD_GACETA}` : null,
    properties.Observacion || properties.OBSERVACI
      ? `Observation: ${properties.Observacion || properties.OBSERVACI}`
      : null,
  ].filter(Boolean);
}

export function administrativeTooltipModel(
  properties,
  { compact = false } = {},
) {
  const details = [
    `Name: ${properties.__adminName}`,
    `Type: ${properties.__adminType}`,
    'Source: MiAmbiente Panamá',
  ];
  if (!compact)
    details.push(...extraDetails(properties, properties.__adminLevel));
  return {
    title: 'ADMINISTRATIVE DIVISION',
    details,
    accent: LEVEL_STYLES[properties.__adminLevel]?.color || '#58e8ff',
  };
}

function focusBounds(viewer) {
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  const ellipsoid = viewer?.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  if (!camera || !canvas) return null;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const focus = camera.pickEllipsoid?.(
    new Cesium.Cartesian2(width / 2, height / 2),
    ellipsoid,
  );
  if (!focus) return null;
  const location = Cesium.Cartographic.fromCartesian(focus);
  const range = Cesium.Cartesian3.distance(camera.positionWC, focus);
  const radius = Math.max(12_000, Math.min(130_000, range * 1.7));
  const latitude = Cesium.Math.toDegrees(location.latitude);
  const longitude = Cesium.Math.toDegrees(location.longitude);
  const latSpan = radius / 111_000;
  const lonSpan = latSpan / Math.max(0.2, Math.cos(location.latitude));
  const bounds = {
    west: Math.max(PANAMA_BOUNDS.west, longitude - lonSpan),
    south: Math.max(PANAMA_BOUNDS.south, latitude - latSpan),
    east: Math.min(PANAMA_BOUNDS.east, longitude + lonSpan),
    north: Math.min(PANAMA_BOUNDS.north, latitude + latSpan),
  };
  return bounds.west < bounds.east && bounds.south < bounds.north
    ? bounds
    : null;
}

function snappedBounds(bounds) {
  if (!bounds) return null;
  const step = 0.25;
  return {
    west: Math.floor(bounds.west / step) * step,
    south: Math.floor(bounds.south / step) * step,
    east: Math.ceil(bounds.east / step) * step,
    north: Math.ceil(bounds.north / step) * step,
  };
}

export function createAdministrativeDivisionsLayer({ source, services } = {}) {
  if (typeof source?.getFeatures !== 'function')
    throw new TypeError('Administrative Divisions requires an ArcGIS source');
  const { context, overlayHost, picking, render } = services || {};
  if (
    !context?.registerEntityContext ||
    !overlayHost?.setEntries ||
    !picking?.registerPickOwner ||
    !render?.governorRequestRender
  )
    throw new TypeError(
      'Administrative Divisions application services are required',
    );

  const state = {
    viewer: null,
    enabled: false,
    dataSources: new Map(LEVEL_ORDER.map((level) => [level, []])),
    records: new Map(),
    recordsByFeature: new Map(),
    featureIds: new Map(LEVEL_ORDER.map((level) => [level, new Set()])),
    queryKeys: new Set(),
    labels: new Map(LEVEL_ORDER.map((level) => [level, new Map()])),
    lod: 'province',
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

  function isLevelVisible(level) {
    return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(state.lod);
  }

  function styleRecord(record) {
    const { entity, boundary, level } = record;
    const style = LEVEL_STYLES[level];
    const selected = record.logicalId === state.selectedId;
    const hovered = record.logicalId === state.hoveredId;
    const color = Cesium.Color.fromCssColorString(style.color);
    entity.polygon.material = color.withAlpha(
      selected ? 0.18 : hovered ? 0.1 : style.fillAlpha,
    );
    for (const line of boundary) {
      line.polyline.width = selected
        ? style.width + 2
        : hovered
          ? style.width + 1
          : style.width;
      line.polyline.material = selected
        ? Cesium.Color.WHITE.withAlpha(0.96)
        : color.withAlpha(0.9);
    }
  }

  function styleFeature(logicalId) {
    for (const record of state.recordsByFeature.get(logicalId) || [])
      styleRecord(record);
  }

  function setHover(id) {
    const next = state.records.get(id);
    const logicalId = next?.logicalId || null;
    if (state.hoveredId === logicalId) return;
    const previousId = state.hoveredId;
    state.hoveredId = logicalId;
    if (previousId) styleFeature(previousId);
    if (next) {
      styleFeature(logicalId);
      overlayHost.setEntries(
        HOVER_SOURCE,
        [
          {
            id: `hover:${next.id}`,
            position: next.center,
            variant: 'card',
            ...administrativeTooltipModel(next.properties, { compact: true }),
            priority: Number.MAX_SAFE_INTEGER,
            collisionGroup: 'ambient-card',
            protected: true,
            interactive: false,
            minDistance: 0,
            maxDistance: 2_000_000,
            horizonCull: true,
            terrainOcclusion: false,
          },
        ],
        { cohortLimit: 1, collisionCapacity: 0, moving: false },
      );
    } else overlayHost.clearSource(HOVER_SOURCE);
    render.governorRequestRender('administrative-hover');
  }

  function selectRecord(id) {
    const record = state.records.get(id);
    if (!record) return;
    const previousId = state.selectedId;
    state.selectedId = record.logicalId;
    if (previousId) styleFeature(previousId);
    styleFeature(record.logicalId);
    context.selectEntityContext(record.entity);
    render.governorRequestRender('administrative-selection');
  }

  function labelEntry(record) {
    return {
      id: `label:${record.id}`,
      position: record.center,
      variant: 'label',
      title: record.properties.__adminName,
      accent: LEVEL_STYLES[record.level].color,
      priority: 1000 - LEVEL_ORDER.indexOf(record.level) * 100,
      collisionGroup: 'ambient-label',
      paintLane: 'ambient-label',
      interactive: false,
      minDistance: 0,
      maxDistance: 3_000_000,
      distanceFadeStartRatio: 0.72,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 10,
      verticalOnly: true,
    };
  }

  function publishLabels() {
    if (!state.enabled) return;
    const entries = [...(state.labels.get(state.lod)?.values() || [])].map(
      ({ entry }) => entry,
    );
    overlayHost.setEntries(LABEL_SOURCE, entries, {
      cohortLimit:
        state.lod === 'province' ? 24 : state.lod === 'district' ? 70 : 100,
      collisionCapacity:
        state.lod === 'province' ? 20 : state.lod === 'district' ? 42 : 58,
      moving: false,
    });
    overlayHost.setVisible(LABEL_SOURCE, true);
  }

  function applyLod() {
    if (!state.viewer) return;
    state.lod = administrativeLodForAltitude(
      state.viewer.camera.positionCartographic?.height,
    );
    for (const level of LEVEL_ORDER)
      for (const dataSource of state.dataSources.get(level))
        dataSource.show = state.enabled && isLevelVisible(level);
    publishLabels();
    render.governorRequestRender('administrative-lod');
  }

  function registerEntity(entity, dataSource, level) {
    const properties = featureProperties(entity);
    const style = LEVEL_STYLES[level];
    const hierarchy = entity.polygon?.hierarchy?.getValue(
      Cesium.JulianDate.now(),
    );
    if (!hierarchy) return null;
    entity.polygon.outline = false;
    entity.polygon.classificationType = Cesium.ClassificationType.BOTH;
    const boundary = hierarchyRings(hierarchy).map((positions, index) =>
      dataSource.entities.add({
        id: `${entity.id}:boundary:${index}`,
        polyline: {
          positions,
          width: style.width,
          material: Cesium.Color.fromCssColorString(style.color).withAlpha(0.9),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      }),
    );
    const center = entityCenter(entity);
    const logicalId = `administrative:${level}:${properties.OBJECTID ?? properties.__adminCode ?? properties.__adminName}`;
    const record = {
      id: String(entity.id),
      logicalId,
      entity,
      boundary,
      center,
      level,
      properties,
    };
    entity.gevTrackedId = record.id;
    entity.gevDisplayPosition = () => center;
    entity.gevLabelModel = administrativeTooltipModel(properties);
    context.registerEntityContext(entity, {
      id: record.id,
      layerId: ADMINISTRATIVE_LAYER_ID,
      layerName: 'Administrative Divisions',
      source: 'MIAMBIENTE PANAMÁ',
      dataSource,
      label: properties.__adminName,
      properties: { ...properties },
    });
    state.records.set(record.id, record);
    for (const line of boundary) state.records.set(String(line.id), record);
    const group = state.recordsByFeature.get(logicalId) || [];
    group.push(record);
    state.recordsByFeature.set(logicalId, group);
    if (center) {
      const span = entitySpan(entity);
      const current = state.labels.get(level).get(logicalId);
      if (!current || span > current.span)
        state.labels
          .get(level)
          .set(logicalId, { span, entry: labelEntry(record) });
    }
    styleRecord(record);
    return record;
  }

  async function loadLevel(level, bounds = null, request, generation) {
    const key = bounds
      ? `${level}:${Object.values(bounds)
          .map((value) => value.toFixed(2))
          .join(',')}`
      : `${level}:all`;
    if (state.queryKeys.has(key)) return;
    const geojson = await source.getFeatures(level, {
      bounds,
      signal: request.signal,
      maxAllowableOffset:
        level === 'province'
          ? 0.00015
          : level === 'district'
            ? 0.00008
            : 0.00003,
    });
    if (
      request.signal.aborted ||
      generation !== state.generation ||
      !state.enabled
    )
      return;
    const unseen = geojson.features.filter(
      (feature) => !state.featureIds.get(level).has(String(feature.id)),
    );
    if (!unseen.length) {
      state.queryKeys.add(key);
      return;
    }
    const dataSource = await Cesium.GeoJsonDataSource.load(
      { type: 'FeatureCollection', features: unseen },
      { clampToGround: true },
    );
    if (
      request.signal.aborted ||
      generation !== state.generation ||
      !state.enabled
    )
      return;
    dataSource.name = `${ADMINISTRATIVE_LAYER_ID}:${level}:${state.dataSources.get(level).length}`;
    dataSource.show = false;
    await state.viewer.dataSources.add(dataSource);
    if (
      request.signal.aborted ||
      generation !== state.generation ||
      !state.enabled
    ) {
      state.viewer.dataSources.remove(dataSource, true);
      return;
    }
    const originals = [...dataSource.entities.values];
    for (const entity of originals) {
      registerEntity(entity, dataSource, level);
    }
    for (const feature of unseen)
      state.featureIds.get(level).add(String(feature.id));
    dataSource.show = state.enabled && isLevelVisible(level);
    state.dataSources.get(level).push(dataSource);
    state.queryKeys.add(key);
  }

  async function refresh() {
    if (!state.enabled || !state.viewer) return true;
    state.request?.abort();
    const request = new AbortController();
    const generation = ++state.generation;
    state.request = request;
    state.loading = true;
    state.error = null;
    applyLod();
    try {
      await loadLevel('province', null, request, generation);
      if (state.lod !== 'province')
        await loadLevel('district', null, request, generation);
      if (state.lod === 'corregimiento') {
        const bounds = snappedBounds(focusBounds(state.viewer));
        if (bounds)
          await loadLevel('corregimiento', bounds, request, generation);
      }
      if (
        request.signal.aborted ||
        generation !== state.generation ||
        !state.enabled
      )
        return true;
      state.lastUpdate = Date.now();
      applyLod();
      return true;
    } catch (error) {
      if (request.signal.aborted || error?.name === 'AbortError') return true;
      state.error =
        error?.message || 'MiAmbiente administrative source unavailable';
      return true;
    } finally {
      if (state.request === request) state.request = null;
      if (generation === state.generation) state.loading = false;
      render.governorRequestRender('administrative-status');
    }
  }

  function scheduleRefresh() {
    if (!state.enabled) return;
    applyLod();
    clearTimeout(state.moveTimer);
    state.moveTimer = setTimeout(() => void refresh(), 280);
  }

  function clearSelection({ clearContext = true } = {}) {
    const previousId = state.selectedId;
    state.selectedId = null;
    if (previousId) styleFeature(previousId);
    if (clearContext)
      context.clearSelectedEntityContextForLayer(ADMINISTRATIVE_LAYER_ID);
  }

  return {
    id: ADMINISTRATIVE_LAYER_ID,
    name: 'Administrative Divisions',
    icon: '🗺️',
    source: source.label || 'MIAMBIENTE · OFFICIAL',
    updateInterval: 0,
    statsRefreshInterval: 500,
    init(viewer) {
      if (state.viewer)
        throw new Error('Administrative Divisions is already initialized');
      state.viewer = viewer;
      state.credit = new Cesium.Credit('MIAMBIENTE PANAMÁ', true);
      state.moveRemover =
        viewer.camera.moveEnd.addEventListener(scheduleRefresh);
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        if (!state.enabled) return;
        const picked = viewer.scene.pick(click.position);
        const id = picking.resolvePickId(picked);
        if (id && state.records.has(id)) selectRecord(state.records.get(id).id);
        else if (id && picking.isOwnedByOtherLayer(ADMINISTRATIVE_LAYER_ID, id))
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
        setHover(id && state.records.has(id) ? state.records.get(id).id : null);
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      state.contextSelectedHandler = (event) => {
        if (
          state.selectedId &&
          event.detail?.layerId !== ADMINISTRATIVE_LAYER_ID
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
      overlayHost.setVisible(LABEL_SOURCE, true);
      overlayHost.setVisible(HOVER_SOURCE, true);
      state.viewer.creditDisplay?.addStaticCredit(state.credit);
      picking.registerPickOwner(ADMINISTRATIVE_LAYER_ID, (id) =>
        state.records.has(id),
      );
      applyLod();
    },
    update: refresh,
    disable() {
      state.enabled = false;
      state.generation++;
      state.request?.abort();
      state.request = null;
      clearTimeout(state.moveTimer);
      for (const level of LEVEL_ORDER)
        for (const dataSource of state.dataSources.get(level))
          dataSource.show = false;
      setHover(null);
      clearSelection();
      overlayHost.clearSource(LABEL_SOURCE);
      overlayHost.clearSource(HOVER_SOURCE);
      overlayHost.setVisible(LABEL_SOURCE, false);
      overlayHost.setVisible(HOVER_SOURCE, false);
      state.viewer?.creditDisplay?.removeStaticCredit(state.credit);
      picking.unregisterPickOwner(ADMINISTRATIVE_LAYER_ID);
      state.loading = false;
    },
    destroy() {
      this.disable();
      state.moveRemover?.();
      state.clickHandler?.destroy();
      state.hoverHandler?.destroy();
      if (state.contextSelectedHandler)
        globalThis.window?.removeEventListener?.(
          'gev:entity-selected',
          state.contextSelectedHandler,
        );
      context.removeEntityContextsForLayer(ADMINISTRATIVE_LAYER_ID);
      for (const level of LEVEL_ORDER)
        for (const dataSource of state.dataSources.get(level))
          state.viewer?.dataSources.remove(dataSource, true);
      state.viewer = null;
    },
    getRowControls() {
      return {
        legend: [
          {
            label: 'Province / Comarca · all heights',
            color: LEVEL_STYLES.province.color,
            count: state.featureIds.get('province').size,
          },
          {
            label: 'District · ≤500 km',
            color: LEVEL_STYLES.district.color,
            count: state.featureIds.get('district').size,
          },
          {
            label: 'Corregimiento · ≤100 km',
            color: LEVEL_STYLES.corregimiento.color,
            count: state.featureIds.get('corregimiento').size,
          },
        ],
      };
    },
    getStats() {
      const count = LEVEL_ORDER.filter(isLevelVisible).reduce(
        (sum, level) => sum + state.featureIds.get(level).size,
        0,
      );
      return {
        count,
        countLabel: state.enabled ? `${count} boundaries` : '',
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        loadingLabel: state.loading ? `loading ${state.lod} boundaries` : '',
        error: state.error,
        status: state.error
          ? 'unavailable'
          : state.loading
            ? 'loading'
            : 'ready',
        lod: state.lod,
      };
    },
  };
}
