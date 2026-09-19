import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COASTAL_FLOOD_PAGE_SIZE,
  createCoastalFloodSource,
  normalizeCoastalFloodFeature,
} from './source.js';

function feature(id, depth = '0.5 - 1.0') {
  return {
    type: 'Feature',
    properties: { OBJECTID: id, Inundacion_m: depth },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-80, 9],
          [-79.9, 9],
          [-79.9, 9.1],
          [-80, 9],
        ],
      ],
    },
  };
}

test('normalizes only official depth polygons with stable layer-owned ids', () => {
  assert.equal(normalizeCoastalFloodFeature(feature(7)).id, 'coastal-flood:7');
  assert.equal(normalizeCoastalFloodFeature(feature(8, 'unknown')), null);
  assert.equal(
    normalizeCoastalFloodFeature({
      ...feature(9),
      geometry: { type: 'Point' },
    }),
    null,
  );
});

test('queries the visible envelope and paginates past ArcGIS maxRecordCount', async () => {
  const urls = [];
  const source = createCoastalFloodSource({
    serviceUrl: 'https://example.test/MapServer/0',
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      const offset = Number(urls.at(-1).searchParams.get('resultOffset'));
      const features =
        offset === 0
          ? Array.from({ length: COASTAL_FLOOD_PAGE_SIZE }, (_, index) =>
              feature(index + 1),
            )
          : [feature(COASTAL_FLOOD_PAGE_SIZE + 1, '2.5 - 3.0')];
      return {
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          features,
          exceededTransferLimit: offset === 0,
        }),
      };
    },
  });
  const result = await source.getFeatures(
    { west: -80, south: 8.8, east: -79.5, north: 9.2 },
    { maxAllowableOffset: 0.0002 },
  );
  assert.equal(result.features.length, 2001);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, '/MapServer/0/query');
  assert.equal(urls[0].searchParams.get('where'), '1=1');
  assert.equal(urls[0].searchParams.get('geometry'), '-80,8.8,-79.5,9.2');
  assert.equal(urls[0].searchParams.get('outFields'), '*');
  assert.equal(urls[0].searchParams.get('returnGeometry'), 'true');
  assert.equal(urls[0].searchParams.get('outSR'), '4326');
  assert.equal(urls[0].searchParams.get('f'), 'geojson');
  assert.equal(urls[0].searchParams.get('resultRecordCount'), '2000');
  assert.equal(urls[1].searchParams.get('resultOffset'), '2000');
});

test('surfaces ArcGIS errors instead of treating them as empty data', async () => {
  const source = createCoastalFloodSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: { message: 'bad query' } }),
    }),
  });
  await assert.rejects(
    source.getFeatures({ west: -80, south: 8, east: -79, north: 9 }),
    /bad query/,
  );
});
