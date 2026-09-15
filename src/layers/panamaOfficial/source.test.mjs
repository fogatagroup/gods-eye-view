import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPanamaOfficialSource,
  normalizePanamaOfficialFeature,
} from './source.js';

function feature(id, category = 'hotel', coordinates = [-79.5, 9]) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates },
    properties: {
      id,
      category,
      name: 'Lugar de prueba',
      province: 'Panamá',
      website: 'https://example.com',
      source_url: 'https://panamaoficial.com/?place=1',
      internal_note: 'must not cross the adapter',
    },
  };
}

test('normalization keeps the public contract and rejects malformed locations', () => {
  const record = normalizePanamaOfficialFeature(
    feature('panamaoficial:hotel:1'),
  );
  assert.deepEqual(
    {
      id: record.id,
      category: record.category,
      longitude: record.longitude,
      latitude: record.latitude,
    },
    {
      id: 'panamaoficial:hotel:1',
      category: 'hotel',
      longitude: -79.5,
      latitude: 9,
    },
  );
  assert.equal(record.internal_note, undefined);
  assert.equal(record.website, 'https://example.com/');
  assert.equal(normalizePanamaOfficialFeature(feature('bad-id')), null);
  assert.equal(
    normalizePanamaOfficialFeature(
      feature('panamaoficial:hotel:2', 'hotel', [999, 9]),
    ),
    null,
  );
  assert.equal(
    normalizePanamaOfficialFeature({
      ...feature('panamaoficial:hotel:3'),
      geometry: { type: 'Polygon' },
    }),
    null,
  );
});

test('the source follows opaque cursors, deduplicates, and keeps removals', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const cursor = url.searchParams.get('cursor');
    return {
      ok: true,
      async json() {
        return cursor
          ? {
              type: 'FeatureCollection',
              generated_at: '2026-09-14T12:01:00Z',
              next_cursor: null,
              removed_ids: ['panamaoficial:hotel:gone'],
              features: [feature('panamaoficial:hotel:2')],
            }
          : {
              type: 'FeatureCollection',
              generated_at: '2026-09-14T12:00:00Z',
              next_cursor: 'opaque-page-2',
              removed_ids: [],
              features: [
                feature('panamaoficial:hotel:1'),
                feature('panamaoficial:hotel:1'),
              ],
            };
      },
    };
  };
  const source = createPanamaOfficialSource({
    apiBase: 'https://api.example.test/v1/',
    fetchImpl,
  });
  const result = await source.getPlaces(['hotel', 'hotel']);
  assert.deepEqual(
    result.records.map(({ id }) => id),
    ['panamaoficial:hotel:1', 'panamaoficial:hotel:2'],
  );
  assert.deepEqual(result.removedIds, ['panamaoficial:hotel:gone']);
  assert.equal(result.generatedAt, '2026-09-14T12:01:00Z');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('categories'), 'hotel');
  assert.equal(requests[0].searchParams.get('limit'), '1000');
  assert.equal(requests[1].searchParams.get('cursor'), 'opaque-page-2');
});

test('the source fails closed on HTTP, schema, category, and cursor defects', async () => {
  await assert.rejects(
    createPanamaOfficialSource({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }).getPlaces(['hotel']),
    /HTTP 503/,
  );
  await assert.rejects(
    createPanamaOfficialSource({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }).getPlaces(['hotel']),
    /invalid GeoJSON/,
  );
  await assert.rejects(
    createPanamaOfficialSource({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }).getPlaces(['unknown']),
    /category is required/,
  );
  const loop = createPanamaOfficialSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        features: [],
        removed_ids: [],
        next_cursor: 'same',
      }),
    }),
  });
  await assert.rejects(loop.getPlaces(['hotel']), /cursor loop/);
});
