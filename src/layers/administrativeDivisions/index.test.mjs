import test from 'node:test';
import assert from 'node:assert/strict';
import {
  administrativeLodForAltitude,
  administrativeTooltipModel,
} from './index.js';

test('administrative LOD exposes progressively finer boundaries', () => {
  assert.equal(administrativeLodForAltitude(900_000), 'province');
  assert.equal(administrativeLodForAltitude(500_001), 'province');
  assert.equal(administrativeLodForAltitude(500_000), 'district');
  assert.equal(administrativeLodForAltitude(100_001), 'district');
  assert.equal(administrativeLodForAltitude(100_000), 'corregimiento');
});

test('hover tooltip uses official normalized fields and exact source copy', () => {
  assert.deepEqual(
    administrativeTooltipModel(
      {
        __adminName: 'Panamá',
        __adminType: 'District',
        __adminLevel: 'district',
      },
      { compact: true },
    ).details,
    ['Name: Panamá', 'Type: District', 'Source: MiAmbiente Panamá'],
  );
});
