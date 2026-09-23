import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPopulatedPlacesSource,
  normalizePopulatedPlaceFeature,
} from './source.js';

const feature = (id, population = 1200) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [-79.5, 9] },
  properties: {
    OBJECTID: id,
    CODIGO: `code-${id}`,
    LUPO_NOMB: `Place ${id}`,
    LUPO_TIPO: 'URBANO',
    PTOT: population,
    PHOM: 600,
    PMUJ: 600,
    VPO: 300,
  },
});

test('normalizes the verified 2010 census fields without inventing null values', () => {
  const record = normalizePopulatedPlaceFeature(feature(7, null));
  assert.equal(record.id, 'populated-place:7');
  assert.equal(record.population, null);
  assert.equal(record.referenceYear, 2010);
  assert.equal(record.placeType, 'URBANO');
});

test('queries only required fields, paginates, and caches an exact viewport', async () => {
  const calls = [];
  const source = createPopulatedPlacesSource({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const offset = Number(parsed.searchParams.get('resultOffset'));
      return Response.json({
        type: 'FeatureCollection',
        features:
          offset === 0
            ? Array.from({ length: 2000 }, (_, index) => feature(index + 1))
            : [feature(2001)],
        exceededTransferLimit: offset === 0,
      });
    },
  });
  const bounds = { west: -80, south: 8, east: -79, north: 9.5 };
  const first = await source.getFeatures(bounds, { minPopulation: 500 });
  const second = await source.getFeatures(bounds, { minPopulation: 500 });
  assert.equal(first.length, 2001);
  assert.equal(second, first);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].searchParams.get('outFields'),
    'OBJECTID,CODIGO,LUPO_NOMB,LUPO_TIPO,PTOT,PHOM,PMUJ,VPO',
  );
  assert.equal(calls[0].searchParams.get('where'), 'PTOT >= 500');
  assert.equal(calls[0].searchParams.get('outSR'), '4326');
  assert.equal(calls[1].searchParams.get('resultOffset'), '2000');
  assert.equal(source.getCachedFeatures().length, 2001);
});
