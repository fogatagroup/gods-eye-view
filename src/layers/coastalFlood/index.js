import * as Cesium from 'cesium';

export const COASTAL_FLOOD_LAYER_ID = 'coastal-flood-2050';
export const COASTAL_FLOOD_DEPTH_STYLES = Object.freeze([
  Object.freeze({ value: '0.0 - 0.5', label: '0.0–0.5 m', color: '#bfe9ff' }),
  Object.freeze({ value: '0.5 - 1.0', label: '0.5–1.0 m', color: '#73c2ff' }),
  Object.freeze({ value: '1.0 - 1.5', label: '1.0–1.5 m', color: '#268fff' }),
  Object.freeze({ value: '1.5 - 2.0', label: '1.5–2.0 m', color: '#005fe3' }),
  Object.freeze({ value: '2.0 - 2.5', label: '2.0–2.5 m', color: '#0041ab' }),
  Object.freeze({ value: '2.5 - 3.0', label: '2.5–3.0 m', color: '#002673' }),
]);

const STYLE_BY_DEPTH = new Map(
  COASTAL_FLOOD_DEPTH_STYLES.map((style) => [style.value, style]),
);
const PANAMA_BOUNDS = Object.freeze({
  west: -83.1,
  south: 7.0,
  east: -77.0,
  north: 9.8,
});
const MAX_VIEW_SPAN_DEGREES = 0.9;
export const COASTAL_FLOOD_MAX_ALTITUDE_M = 50_000;
const MOVE_DEBOUNCE_MS = 300;

export function coastalFloodTooltipModel(depth) {
  return {
    title: 'COASTAL FLOOD PROJECTION',
    details: [
      `Depth: ${depth} m`,
      'Horizon: 2050',
      'Scenario: SSP5-8.5',
      'Confidence: Low',
      'Percentile: 50%',
      'Source: MiAmbiente Panamá',
    ],
    accent: STYLE_BY_DEPTH.get(depth)?.color || '#73c2ff',
  };
}

function viewportBounds(viewer) {
  const altitude = Number(viewer?.camera?.positionCartographic?.height);
  if (Number.isFinite(altitude) && altitude > COASTAL_FLOOD_MAX_ALTITUDE_M)
    return { tooWide: true };
  const rectangle = viewer?.camera?.computeViewRectangle(
    viewer.scene.globe.ellipsoid,
  );
  if (!rectangle) return null;
  const raw = {
    west: Cesium.Math.toDegrees(rectangle.west),
    south: Cesium.Math.toDegrees(rectangle.south),
    east: Cesium.Math.toDegrees(rectangle.east),
    north: Cesium.Math.toDegrees(rectangle.north),
  };
  if (!Object.values(raw).every(Number.isFinite) || raw.east <= raw.west)
    return null;
  const clipped = {
    west: Math.max(PANAMA_BOUNDS.west, raw.west),
    south: Math.max(PANAMA_BOUNDS.south, raw.south),
    east: Math.min(PANAMA_BOUNDS.east, raw.east),
    north: Math.min(PANAMA_BOUNDS.north, raw.north),
  };
  if (clipped.west >= clipped.east || clipped.south >= clipped.north)
    return { outside: true };
  const span = Math.max(raw.east - raw.west, raw.north - raw.south);
  if (span > MAX_VIEW_SPAN_DEGREES) return { tooWide: true };
  const pad = span * 0.12;
  return {
    west: Math.max(PANAMA_BOUNDS.west, clipped.west - pad),
    south: Math.max(PANAMA_BOUNDS.south, clipped.south - pad),
    east: Math.min(PANAMA_BOUNDS.east, clipped.east + pad),
    north: Math.min(PANAMA_BOUNDS.north, clipped.north + pad),
  };
}

function contains(outer, inner) {
  return (
    outer &&
    inner &&
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  );
}

function entityCenter(entity) {
  const hierarchy = entity.polygon?.hierarchy?.getValue(
    Cesium.JulianDate.now(),
  );
  return hierarchy?.positions?.length
    ? Cesium.BoundingSphere.fromPoints(hierarchy.positions).center
    : null;
}

export function createCoastalFloodLayer({ source, services } = {}) {
  if (typeof source?.getFeatures !== 'function')
    throw new TypeError('Coastal Flood 2050 requires an ArcGIS source');
  const { context, picking, render } = services || {};
  if (
    !context?.registerEntityContext ||
    !picking?.registerPickOwner ||
    !render?.governorRequestRender
  )
    throw new TypeError('Coastal Flood 2050 application services are required');

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    loading: false,
    error: null,
    status: 'idle',
    statusMessage: '',
    lastUpdate: null,
    count: 0,
    loadedBounds: null,
    request: null,
    generation: 0,
    moveRemover: null,
    moveTimer: null,
    clickHandler: null,
    credit: null,
    counts: new Map(),
  };

  function clearData() {
    if (state.dataSource && state.viewer)
      state.viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.loadedBounds = null;
    state.count = 0;
    state.counts = new Map();
    context.removeEntityContextsForLayer(COASTAL_FLOOD_LAYER_ID);
  }

  function registerEntity(entity, dataSource) {
    const properties =
      entity.properties?.getValue(Cesium.JulianDate.now()) || {};
    const depth = String(properties.Inundacion_m || '').trim();
    const style = STYLE_BY_DEPTH.get(depth) || COASTAL_FLOOD_DEPTH_STYLES[1];
    entity.polygon.material = Cesium.Color.fromCssColorString(
      style.color,
    ).withAlpha(0.64);
    entity.polygon.outline = false;
    entity.polygon.classificationType = Cesium.ClassificationType.BOTH;
    entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    entity.gevTrackedId = entity.id;
    entity.gevDisplayPosition = () => entityCenter(entity);
    entity.gevLabelModel = coastalFloodTooltipModel(depth);
    const center = entityCenter(entity);
    const cartographic = center
      ? Cesium.Cartographic.fromCartesian(center)
      : null;
    context.registerEntityContext(entity, {
      id: entity.id,
      layerId: COASTAL_FLOOD_LAYER_ID,
      layerName: 'Coastal Flood 2050',
      source: 'MIAMBIENTE PANAMÁ',
      dataSource,
      label: 'Coastal Flood Projection',
      latitude: cartographic
        ? Cesium.Math.toDegrees(cartographic.latitude)
        : null,
      longitude: cartographic
        ? Cesium.Math.toDegrees(cartographic.longitude)
        : null,
      properties: {
        ...properties,
        horizon: 2050,
        scenario: 'SSP5-8.5',
        confidence: 'Low',
        percentile: '50%',
      },
    });
    state.counts.set(depth, (state.counts.get(depth) || 0) + 1);
  }

  async function refresh() {
    if (!state.enabled || !state.viewer) return true;
    const bounds = viewportBounds(state.viewer);
    if (!bounds || bounds.outside || bounds.tooWide) {
      state.request?.abort();
      state.request = null;
      clearData();
      state.loading = false;
      state.error = null;
      state.status = bounds?.outside ? 'empty' : 'zoom-in';
      state.statusMessage = bounds?.outside
        ? 'Move to the Panama coastline'
        : 'Zoom closer to load flood polygons';
      render.governorRequestRender('coastal-flood-guidance');
      return true;
    }
    if (contains(state.loadedBounds, bounds)) return true;
    state.request?.abort();
    const request = new AbortController();
    const generation = ++state.generation;
    state.request = request;
    state.loading = true;
    state.error = null;
    state.status = 'loading';
    state.statusMessage = 'Loading MiAmbiente polygons';
    render.governorRequestRender('coastal-flood-loading');
    try {
      const span = Math.max(
        bounds.east - bounds.west,
        bounds.north - bounds.south,
      );
      const geojson = await source.getFeatures(bounds, {
        signal: request.signal,
        maxAllowableOffset: Math.max(0.00002, span / 2500),
      });
      const next = await Cesium.GeoJsonDataSource.load(geojson, {
        clampToGround: true,
      });
      if (
        request.signal.aborted ||
        generation !== state.generation ||
        !state.enabled
      ) {
        next.destroy?.();
        return true;
      }
      next.name = COASTAL_FLOOD_LAYER_ID;
      state.counts = new Map();
      for (const entity of next.entities.values) registerEntity(entity, next);
      const previous = state.dataSource;
      await state.viewer.dataSources.add(next);
      state.dataSource = next;
      state.loadedBounds = bounds;
      state.count = next.entities.values.length;
      state.lastUpdate = Date.now();
      state.status = state.count ? 'ready' : 'empty';
      state.statusMessage = state.count ? '' : 'No flood polygons in this view';
      if (previous) state.viewer.dataSources.remove(previous, true);
      context.removeEntityContextsForLayer(COASTAL_FLOOD_LAYER_ID, {
        retainIds: new Set(
          next.entities.values.map((entity) => String(entity.id)),
        ),
      });
      return true;
    } catch (error) {
      if (request.signal.aborted || error?.name === 'AbortError') return true;
      state.error = error?.message || 'MiAmbiente source unavailable';
      state.status = 'unavailable';
      state.statusMessage = state.error;
      return true;
    } finally {
      if (state.request === request) state.request = null;
      if (generation === state.generation) state.loading = false;
      render.governorRequestRender('coastal-flood-status');
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.moveTimer);
    if (!state.enabled) return;
    state.moveTimer = setTimeout(() => void refresh(), MOVE_DEBOUNCE_MS);
  }

  return {
    id: COASTAL_FLOOD_LAYER_ID,
    name: 'Coastal Flood 2050',
    icon: '🌊',
    source: source.label || 'MIAMBIENTE · SSP5-8.5 · P50',
    updateInterval: 0,
    statsRefreshInterval: 500,
    init(viewer) {
      if (state.viewer)
        throw new Error('Coastal Flood 2050 is already initialized');
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
        const pickedId = picking.resolvePickId(picked);
        const entity =
          picked?.id instanceof Cesium.Entity
            ? picked.id
            : picked?.primitive?.id;
        if (pickedId?.startsWith('coastal-flood:') && entity)
          context.selectEntityContext(entity);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    enable() {
      state.enabled = true;
      state.viewer.creditDisplay?.addStaticCredit(state.credit);
      picking.registerPickOwner(COASTAL_FLOOD_LAYER_ID, (id) =>
        id.startsWith('coastal-flood:'),
      );
    },
    update: refresh,
    disable() {
      state.enabled = false;
      state.generation++;
      state.request?.abort();
      state.request = null;
      clearTimeout(state.moveTimer);
      state.moveTimer = null;
      state.viewer?.creditDisplay?.removeStaticCredit(state.credit);
      picking.unregisterPickOwner(COASTAL_FLOOD_LAYER_ID);
      context.clearSelectedEntityContextForLayer(COASTAL_FLOOD_LAYER_ID);
      clearData();
      state.loading = false;
      state.status = 'idle';
      state.statusMessage = '';
      render.governorRequestRender('coastal-flood-disable');
    },
    destroy() {
      this.disable();
      state.moveRemover?.();
      state.moveRemover = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      state.viewer = null;
      state.credit = null;
    },
    getRowControls() {
      return {
        legend: COASTAL_FLOOD_DEPTH_STYLES.map((style) => ({
          label: style.label,
          color: style.color,
          count: state.counts.get(style.value) || 0,
          blurb: 'Projected permanent coastal inundation depth.',
        })),
      };
    },
    getStats() {
      return {
        count: state.count,
        countLabel: state.enabled
          ? state.status === 'zoom-in'
            ? 'ZOOM IN'
            : `${state.count} polygons`
          : '',
        lastUpdate: state.lastUpdate,
        error: state.error,
        status: state.status,
        statusMessage: state.statusMessage,
        loading: state.loading,
        loadingLabel: state.loading ? 'loading MiAmbiente polygons' : '',
        cameraAltitudeM: state.viewer?.camera?.positionCartographic?.height,
        maxVisibleAltitudeM: COASTAL_FLOOD_MAX_ALTITUDE_M,
      };
    },
  };
}
