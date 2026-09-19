export const ADMINISTRATIVE_SERVICE_URL =
  'https://geoportal.miambiente.gob.pa/server/rest/services/Nodo_Caracteristica_General/MapServer';

export const ADMINISTRATIVE_LEVELS = Object.freeze({
  province: Object.freeze({
    layer: 14,
    nameField: 'LMPR_NOMB',
    codeField: 'LMPR_COD',
    type: 'Province / Comarca',
  }),
  district: Object.freeze({
    layer: 15,
    nameField: 'LMDI_NOMB',
    codeField: 'Cod_Distrito',
    type: 'District',
  }),
  corregimiento: Object.freeze({
    layer: 16,
    nameField: 'LMCO_NOMB',
    codeField: 'Cod_Correg',
    type: 'Corregimiento',
  }),
});

const PAGE_SIZE = 2000;

function normalizedBounds(bounds) {
  if (!bounds) return null;
  const west = Number(bounds.west);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  if (![west, south, east, north].every(Number.isFinite))
    throw new TypeError('Administrative query requires finite bounds');
  if (west >= east || south >= north)
    throw new RangeError('Administrative query bounds are empty');
  return { west, south, east, north };
}

function cacheKey(level, bounds) {
  if (!bounds) return `${level}:all`;
  return `${level}:${[bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => Number(value).toFixed(2))
    .join(',')}`;
}

export function normalizeAdministrativeFeature(feature, level) {
  const definition = ADMINISTRATIVE_LEVELS[level];
  if (
    !definition ||
    feature?.type !== 'Feature' ||
    !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  )
    return null;
  const objectId = feature.properties?.OBJECTID ?? feature.id;
  const name = String(feature.properties?.[definition.nameField] || '').trim();
  if (objectId === null || objectId === undefined || !name) return null;
  return {
    type: 'Feature',
    id: `administrative:${level}:${objectId}`,
    geometry: feature.geometry,
    properties: {
      ...feature.properties,
      __adminLevel: level,
      __adminName: name,
      __adminType: definition.type,
      __adminCode: String(
        feature.properties?.[definition.codeField] || '',
      ).trim(),
    },
  };
}

/** Lazy ArcGIS source. Resolved GeoJSON pages remain cached for this session. */
export function createAdministrativeDivisionsSource({
  serviceUrl = ADMINISTRATIVE_SERVICE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Administrative Divisions source requires fetch');
  const base = String(serviceUrl || ADMINISTRATIVE_SERVICE_URL).replace(
    /\/$/,
    '',
  );
  const cache = new Map();

  return Object.freeze({
    label: 'MIAMBIENTE · OFFICIAL',
    attribution: 'MIAMBIENTE PANAMÁ',
    async getFeatures(level, { bounds, signal, maxAllowableOffset } = {}) {
      const definition = ADMINISTRATIVE_LEVELS[level];
      if (!definition)
        throw new TypeError(`Unknown administrative level: ${level}`);
      const box = normalizedBounds(bounds);
      const key = cacheKey(level, box);
      if (cache.has(key)) return cache.get(key);

      const records = new Map();
      for (let offset = 0, page = 0; page < 100; page++, offset += PAGE_SIZE) {
        const params = new URLSearchParams({
          where: '1=1',
          outFields: '*',
          returnGeometry: 'true',
          outSR: '4326',
          orderByFields: 'OBJECTID ASC',
          resultOffset: String(offset),
          resultRecordCount: String(PAGE_SIZE),
          f: 'geojson',
        });
        if (box) {
          params.set(
            'geometry',
            `${box.west},${box.south},${box.east},${box.north}`,
          );
          params.set('geometryType', 'esriGeometryEnvelope');
          params.set('inSR', '4326');
          params.set('spatialRel', 'esriSpatialRelIntersects');
        }
        if (Number.isFinite(maxAllowableOffset) && maxAllowableOffset > 0)
          params.set('maxAllowableOffset', String(maxAllowableOffset));
        const response = await fetchImpl(
          `${base}/${definition.layer}/query?${params}`,
          {
            signal,
            headers: { Accept: 'application/geo+json, application/json' },
          },
        );
        if (!response.ok)
          throw new Error(`MiAmbiente request failed (${response.status})`);
        const payload = await response.json();
        if (payload?.error)
          throw new Error(payload.error.message || 'MiAmbiente query failed');
        if (
          payload?.type !== 'FeatureCollection' ||
          !Array.isArray(payload.features)
        )
          throw new Error('MiAmbiente returned invalid administrative GeoJSON');
        for (const raw of payload.features) {
          const feature = normalizeAdministrativeFeature(raw, level);
          if (feature) records.set(feature.id, feature);
        }
        if (
          payload.features.length < PAGE_SIZE &&
          payload.exceededTransferLimit !== true
        ) {
          const result = {
            type: 'FeatureCollection',
            features: [...records.values()],
          };
          cache.set(key, result);
          return result;
        }
      }
      throw new Error('MiAmbiente pagination exceeded the safe query limit');
    },
    clearCache() {
      cache.clear();
    },
    getCacheSize() {
      return cache.size;
    },
  });
}
