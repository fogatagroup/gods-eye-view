export const COASTAL_FLOOD_SERVICE_URL =
  'https://geoportal.miambiente.gob.pa/server/rest/services/IC_P_2050_SSP585_cb_p50_MI/MapServer/0';

export const COASTAL_FLOOD_PAGE_SIZE = 2000;

const DEPTH_VALUES = new Set([
  '0.0 - 0.5',
  '0.5 - 1.0',
  '1.0 - 1.5',
  '1.5 - 2.0',
  '2.0 - 2.5',
  '2.5 - 3.0',
]);

function finiteBounds(bounds) {
  const west = Number(bounds?.west);
  const south = Number(bounds?.south);
  const east = Number(bounds?.east);
  const north = Number(bounds?.north);
  if (![west, south, east, north].every(Number.isFinite))
    throw new TypeError('Coastal flood query requires finite bounds');
  if (west >= east || south >= north)
    throw new RangeError('Coastal flood query bounds are empty');
  return { west, south, east, north };
}

export function normalizeCoastalFloodFeature(feature) {
  if (
    feature?.type !== 'Feature' ||
    !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  )
    return null;
  const objectId = feature.properties?.OBJECTID ?? feature.id;
  const depth = String(feature.properties?.Inundacion_m || '').trim();
  if (objectId === null || objectId === undefined || !DEPTH_VALUES.has(depth))
    return null;
  return {
    type: 'Feature',
    id: `coastal-flood:${objectId}`,
    geometry: feature.geometry,
    properties: { ...feature.properties, Inundacion_m: depth },
  };
}

/** Lazy, viewport-bounded ArcGIS REST source with transfer-limit pagination. */
export function createCoastalFloodSource({
  serviceUrl = COASTAL_FLOOD_SERVICE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Coastal flood source requires fetch');
  const base = String(serviceUrl || COASTAL_FLOOD_SERVICE_URL).replace(
    /\/$/,
    '',
  );
  return Object.freeze({
    label: 'MIAMBIENTE · SSP5-8.5 · P50',
    attribution: 'MIAMBIENTE PANAMÁ',
    async getFeatures(bounds, { signal, maxAllowableOffset } = {}) {
      const box = finiteBounds(bounds);
      const records = new Map();
      for (
        let offset = 0, page = 0;
        page < 100;
        page++, offset += COASTAL_FLOOD_PAGE_SIZE
      ) {
        const params = new URLSearchParams({
          where: '1=1',
          geometry: `${box.west},${box.south},${box.east},${box.north}`,
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          outFields: '*',
          returnGeometry: 'true',
          outSR: '4326',
          orderByFields: 'OBJECTID ASC',
          resultOffset: String(offset),
          resultRecordCount: String(COASTAL_FLOOD_PAGE_SIZE),
          f: 'geojson',
        });
        if (Number.isFinite(maxAllowableOffset) && maxAllowableOffset > 0)
          params.set('maxAllowableOffset', String(maxAllowableOffset));
        const response = await fetchImpl(`${base}/query?${params}`, {
          signal,
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (!response.ok)
          throw new Error(`MiAmbiente request failed (${response.status})`);
        const payload = await response.json();
        if (payload?.error)
          throw new Error(payload.error.message || 'MiAmbiente query failed');
        if (
          payload?.type !== 'FeatureCollection' ||
          !Array.isArray(payload.features)
        )
          throw new Error('MiAmbiente returned an invalid GeoJSON response');
        for (const raw of payload.features) {
          const feature = normalizeCoastalFloodFeature(raw);
          if (feature) records.set(feature.id, feature);
        }
        if (
          payload.features.length < COASTAL_FLOOD_PAGE_SIZE &&
          payload.exceededTransferLimit !== true
        )
          return { type: 'FeatureCollection', features: [...records.values()] };
      }
      throw new Error('MiAmbiente pagination exceeded the safe viewport limit');
    },
  });
}
