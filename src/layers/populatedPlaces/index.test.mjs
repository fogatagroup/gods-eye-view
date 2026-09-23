import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POPULATED_PLACES_COLOR,
  createPopulatedPlaceLabelEntry,
  populatedPlacePixelSize,
  populatedPlacesLod,
  populatedPlaceTooltipModel,
} from './index.js';

test('point area scales with population while preserving the existing maximum', () => {
  assert.equal(populatedPlacePixelSize(null), 0.8);
  assert.ok(populatedPlacePixelSize(5) < 1);
  assert.ok(populatedPlacePixelSize(100) < 1.5);
  assert.ok(populatedPlacePixelSize(1_000) < 2.5);
  assert.ok(populatedPlacePixelSize(10_000) > 5);
  assert.equal(populatedPlacePixelSize(50_000), 11);
  assert.equal(populatedPlacePixelSize(1_000_000), 11);
});

test('place names use the same bounded overlay cards as hotel labels', () => {
  const position = { x: 1, y: 2, z: 3 };
  const entry = createPopulatedPlaceLabelEntry(
    { id: 'place:1', name: 'AGUADULCE', population: 16_000 },
    position,
  );
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, 'AGUADULCE');
  assert.equal(entry.accent, '#ff5fd0');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'none');
  assert.equal(entry.position, position);
});

test('all populated places remain visible at every altitude while labels use LOD', () => {
  const lods = [700_000, 300_000, 100_000, 20_000].map(populatedPlacesLod);
  assert.deepEqual(
    lods.map((lod) => lod.minPopulation),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    lods.map((lod) => lod.labelPopulation),
    [50_000, 10_000, 5_000, 1_000],
  );
  assert.equal(POPULATED_PLACES_COLOR, '#ff5fd0');
});

test('tooltip always identifies the historical reference year', () => {
  const model = populatedPlaceTooltipModel({
    name: 'SANTA ANA',
    code: '080803001',
    placeType: 'URBANO',
    population: 18210,
    male: 9287,
    female: 8923,
    occupiedDwellings: 5919,
  });
  assert.equal(model.title, 'SANTA ANA');
  assert.ok(model.details.includes('Population: 18,210'));
  assert.ok(model.details.includes('Reference year: 2010'));
  assert.ok(model.details.includes('Source: MiAmbiente Panamá'));
});
