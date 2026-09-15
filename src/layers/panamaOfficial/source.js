const DEFAULT_API_BASE = 'https://api.panamaoficial.com/api/world/v1';
const MAX_PAGES = 50;
const PAGE_LIMIT = 1000;

export const PANAMA_OFFICIAL_CATEGORIES = Object.freeze([
  'hotel',
  'hostel',
  'resort',
  'travel_agency',
  'tour_operator',
  'attraction',
  'museum',
  'restaurant',
  'nightlife',
  'beach',
  'park',
  'event',
  'transport',
  'other',
]);

const CATEGORY_SET = new Set(PANAMA_OFFICIAL_CATEGORIES);

function cleanText(value, max = 500) {
  if (value == null || typeof value === 'object') return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function httpsUrl(value) {
  const text = cleanText(value, 2000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Convert one public GeoJSON feature into the layer's bounded record shape. */
export function normalizePanamaOfficialFeature(feature) {
  if (feature?.type !== 'Feature' || feature?.geometry?.type !== 'Point')
    return null;
  const [longitude, latitude] = feature.geometry.coordinates || [];
  const properties = feature.properties || {};
  const id = cleanText(feature.id ?? properties.id, 180);
  const category = cleanText(properties.category, 40);
  const name = cleanText(properties.name, 180);
  if (
    !id?.startsWith('panamaoficial:') ||
    !CATEGORY_SET.has(category) ||
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
    id,
    category,
    name,
    longitude,
    latitude,
    summary: cleanText(properties.summary),
    address: cleanText(properties.address, 240),
    province: cleanText(properties.province, 100),
    district: cleanText(properties.district, 100),
    corregimiento: cleanText(properties.corregimiento, 100),
    phone: cleanText(properties.phone, 80),
    whatsapp: cleanText(properties.whatsapp, 80),
    email: cleanText(properties.email, 180),
    website: httpsUrl(properties.website),
    imageUrl: httpsUrl(properties.image_url),
    rating: Number.isFinite(Number(properties.rating))
      ? Number(properties.rating)
      : null,
    verified: properties.verified === true,
    sourceUrl: httpsUrl(properties.source_url),
    updatedAt: cleanText(properties.updated_at, 80),
  });
}

function normalizedBase(value) {
  const candidate = cleanText(value, 2000) || DEFAULT_API_BASE;
  return candidate.replace(/\/+$/, '');
}

/** Create the keyless, read-only Panamá Oficial catalog source. */
export function createPanamaOfficialSource({
  apiBase = DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Panamá Oficial requires fetch');
  const base = normalizedBase(apiBase);

  return Object.freeze({
    label: 'PANAMAOFICIAL.COM · OFICIAL',
    attribution: Object.freeze({
      name: 'Panamá Oficial',
      href: 'https://panamaoficial.com/',
    }),
    async getPlaces(categories, { signal } = {}) {
      const selected = [...new Set(categories || [])].filter((item) =>
        CATEGORY_SET.has(item),
      );
      if (!selected.length)
        throw new TypeError('At least one Panamá Oficial category is required');
      const records = new Map();
      const removedIds = new Set();
      const seenCursors = new Set();
      let cursor = null;
      let generatedAt = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(`${base}/places`);
        url.searchParams.set('categories', selected.join(','));
        url.searchParams.set('limit', String(PAGE_LIMIT));
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetchImpl(url, {
          signal,
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (!response?.ok)
          throw new Error(`Panamá Oficial HTTP ${response?.status ?? '?'}`);
        const body = await response.json();
        if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features))
          throw new Error('Panamá Oficial returned invalid GeoJSON');
        generatedAt = cleanText(body.generated_at, 80) || generatedAt;
        for (const feature of body.features) {
          const record = normalizePanamaOfficialFeature(feature);
          if (record && selected.includes(record.category))
            records.set(record.id, record);
        }
        for (const id of body.removed_ids || []) {
          const normalized = cleanText(id, 180);
          if (normalized?.startsWith('panamaoficial:'))
            removedIds.add(normalized);
        }
        const next = cleanText(body.next_cursor, 4000);
        if (!next) {
          return Object.freeze({
            records: Object.freeze([...records.values()]),
            removedIds: Object.freeze([...removedIds]),
            generatedAt,
          });
        }
        if (seenCursors.has(next))
          throw new Error('Panamá Oficial cursor loop');
        seenCursors.add(next);
        cursor = next;
      }
      throw new Error(`Panamá Oficial exceeded ${MAX_PAGES} pages`);
    },
  });
}
