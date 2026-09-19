import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdministrativeDivisionsSource,
  normalizeAdministrativeFeature,
} from './source.js';

function feature(id, fields = {}) {
  return {
    type: 'Feature',
    properties: { OBJECTID: id, ...fields },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-80, 8],
          [-79, 8],
          [-79, 9],
          [-80, 8],
        ],
      ],
    },
  };
}

test('uses the inspected official name and code fields for every level', () => {
  const province = normalizeAdministrativeFeature(
    feature(1, { LMPR_NOMB: 'Coclé', LMPR_COD: '02' }),
    'province',
  );
  const district = normalizeAdministrativeFeature(
    feature(2, { LMDI_NOMB: 'Penonomé', Cod_Distrito: '0201' }),
    'district',
  );
  const corregimiento = normalizeAdministrativeFeature(
    feature(3, { LMCO_NOMB: 'El Coco', Cod_Correg: '020102' }),
    'corregimiento',
  );
  assert.deepEqual(
    [province, district, corregimiento].map((row) => [
      row.properties.__adminName,
      row.properties.__adminCode,
      row.properties.__adminType,
    ]),
    [
      ['Coclé', '02', 'Province / Comarca'],
      ['Penonomé', '0201', 'District'],
      ['El Coco', '020102', 'Corregimiento'],
    ],
  );
});

test('requests WGS84 GeoJSON, spatially filters, and caches resolved geometry', async () => {
  const urls = [];
  const source = createAdministrativeDivisionsSource({
    serviceUrl: 'https://example.test/MapServer',
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return {
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          features: [feature(7, { LMCO_NOMB: 'Bella Vista' })],
        }),
      };
    },
  });
  const options = {
    bounds: { west: -80, south: 8, east: -79, north: 9 },
    maxAllowableOffset: 0.0001,
  };
  const first = await source.getFeatures('corregimiento', options);
  const second = await source.getFeatures('corregimiento', options);
  assert.equal(first, second);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, '/MapServer/16/query');
  assert.equal(urls[0].searchParams.get('outSR'), '4326');
  assert.equal(urls[0].searchParams.get('f'), 'geojson');
  assert.equal(
    urls[0].searchParams.get('geometryType'),
    'esriGeometryEnvelope',
  );
  assert.equal(urls[0].searchParams.get('resultRecordCount'), '2000');
});

test('paginates defensively when ArcGIS reaches its transfer limit', async () => {
  const offsets = [];
  const source = createAdministrativeDivisionsSource({
    fetchImpl: async (url) => {
      const offset = Number(new URL(url).searchParams.get('resultOffset'));
      offsets.push(offset);
      return {
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          exceededTransferLimit: offset === 0,
          features:
            offset === 0
              ? Array.from({ length: 2000 }, (_, index) =>
                  feature(index + 1, { LMPR_NOMB: `Province ${index + 1}` }),
                )
              : [feature(2001, { LMPR_NOMB: 'Final Province' })],
        }),
      };
    },
  });
  const result = await source.getFeatures('province');
  assert.deepEqual(offsets, [0, 2000]);
  assert.equal(result.features.length, 2001);
});
