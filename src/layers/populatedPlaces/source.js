export const POPULATED_PLACES_SERVICE_URL =
  'https://geoportal.miambiente.gob.pa/server/rest/services/Nodo_Caracteristica_General/MapServer/2';

export const POPULATED_PLACES_FIELDS = Object.freeze([
  'OBJECTID',
  'CODIGO',
  'LUPO_NOMB',
  'LUPO_TIPO',
  'PTOT',
  'PHOM',
  'PMUJ',
  'VPO',
]);

const PAGE_SIZE = 2000;
const MAX_PAGES = 20;

function cleanText(value, max = 240) {
  if (value == null || typeof value === 'object') return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function censusNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function normalizedBounds(bounds) {
  const west = Number(bounds?.west);
  const south = Number(bounds?.south);
  const east = Number(bounds?.east);
  const north = Number(bounds?.north);
  if (![west, south, east, north].every(Number.isFinite))
    throw new TypeError('Populated Places requires finite viewport bounds');
  if (west >= east || south >= north)
    throw new RangeError('Populated Places viewport is empty');
  return { west, south, east, north };
}

function cacheKey(bounds, minPopulation) {
  return `${[bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => value.toFixed(3))
    .join(',')}:p${minPopulation}`;
}

export function normalizePopulatedPlaceFeature(feature) {
  if (feature?.type !== 'Feature' || feature?.geometry?.type !== 'Point')
    return null;
  const [longitude, latitude] = feature.geometry.coordinates || [];
  const properties = feature.properties || {};
  const objectId = censusNumber(properties.OBJECTID ?? feature.id);
  const name = cleanText(properties.LUPO_NOMB, 180);
  if (
    objectId === null ||
    !name ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  )
    return null;
  return Object.freeze({
    id: `populated-place:${objectId}`,
    objectId,
    code: cleanText(properties.CODIGO, 80),
    name,
    placeType: cleanText(properties.LUPO_TIPO, 100),
    population: censusNumber(properties.PTOT),
    male: censusNumber(properties.PHOM),
    female: censusNumber(properties.PMUJ),
    occupiedDwellings: censusNumber(properties.VPO),
    longitude,
    latitude,
    referenceYear: 2010,
  });
}

/** Lazy, viewport-bounded ArcGIS source with paginated session caching. */
export function createPopulatedPlacesSource({
  serviceUrl = POPULATED_PLACES_SERVICE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Populated Places source requires fetch');
  const base = String(serviceUrl || POPULATED_PLACES_SERVICE_URL).replace(
    /\/$/,
    '',
  );
  const cache = new Map();
  const featureStore = new Map();

  return Object.freeze({
    label: 'MIAMBIENTE · 2010 CENSUS DATA',
    attribution: 'MIAMBIENTE PANAMÁ',
    async getFeatures(bounds, { signal, minPopulation = 0 } = {}) {
      const box = normalizedBounds(bounds);
      const threshold = Math.max(0, Math.trunc(Number(minPopulation) || 0));
      const key = cacheKey(box, threshold);
      if (cache.has(key)) return cache.get(key);

      const records = new Map();
      for (
        let offset = 0, page = 0;
        page < MAX_PAGES;
        page += 1, offset += PAGE_SIZE
      ) {
        signal?.throwIfAborted();
        const params = new URLSearchParams({
          where: threshold > 0 ? `PTOT >= ${threshold}` : '1=1',
          geometry: `${box.west},${box.south},${box.east},${box.north}`,
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          outFields: POPULATED_PLACES_FIELDS.join(','),
          returnGeometry: 'true',
          outSR: '4326',
          orderByFields: 'OBJECTID ASC',
          resultOffset: String(offset),
          resultRecordCount: String(PAGE_SIZE),
          f: 'geojson',
        });
        const response = await fetchImpl(`${base}/query?${params}`, {
          signal,
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (!response?.ok)
          throw new Error(
            `MiAmbiente populated places request failed (${response?.status ?? '?'})`,
          );
        const payload = await response.json();
        signal?.throwIfAborted();
        if (payload?.error)
          throw new Error(
            payload.error.message || 'MiAmbiente populated places query failed',
          );
        if (
          payload?.type !== 'FeatureCollection' ||
          !Array.isArray(payload.features)
        )
          throw new Error(
            'MiAmbiente returned invalid populated places GeoJSON',
          );
        for (const feature of payload.features) {
          const record = normalizePopulatedPlaceFeature(feature);
          if (!record) continue;
          records.set(record.id, record);
          featureStore.set(record.id, record);
        }
        if (
          payload.features.length < PAGE_SIZE &&
          payload.exceededTransferLimit !== true
        ) {
          const result = Object.freeze([...records.values()]);
          cache.set(key, result);
          return result;
        }
      }
      throw new Error('MiAmbiente populated places pagination exceeded limit');
    },
    getCachedFeatures() {
      return Object.freeze([...featureStore.values()]);
    },
    clearCache() {
      cache.clear();
      featureStore.clear();
    },
    getCacheSize() {
      return cache.size;
    },
  });
}
