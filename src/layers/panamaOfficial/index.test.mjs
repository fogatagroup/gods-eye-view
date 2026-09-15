import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANAMA_OFFICIAL_LAYER_DEFINITIONS,
  panamaOfficialLabelModel,
} from './index.js';

test('Panamá Oficial categories are complete, disjoint, and grouped into three layers', () => {
  assert.deepEqual(
    PANAMA_OFFICIAL_LAYER_DEFINITIONS.map(({ id }) => id),
    [
      'panama-official-hotels',
      'panama-official-agencies',
      'panama-official-tourism',
    ],
  );
  const categories = PANAMA_OFFICIAL_LAYER_DEFINITIONS.flatMap(
    ({ categories: values }) => values,
  );
  assert.equal(new Set(categories).size, categories.length);
  assert.deepEqual(categories.sort(), [
    'attraction',
    'beach',
    'event',
    'hostel',
    'hotel',
    'museum',
    'nightlife',
    'other',
    'park',
    'resort',
    'restaurant',
    'tour_operator',
    'transport',
    'travel_agency',
  ]);
});

test('selected-place copy identifies the official source and public contact', () => {
  const model = panamaOfficialLabelModel(
    {
      name: 'Hotel Central',
      category: 'hotel',
      address: 'Avenida Central',
      district: 'Panamá',
      province: 'Panamá',
      whatsapp: '6000-0000',
      sourceUrl: 'https://panamaoficial.com/?place=hotel-1',
    },
    '#36dcff',
  );
  assert.equal(model.title, 'Hotel Central');
  assert.deepEqual(model.details, [
    'PANAMÁ OFICIAL · HOTEL',
    'Avenida Central · Panamá',
    'WhatsApp 6000-0000',
    'Ficha: panamaoficial.com',
  ]);
  assert.equal(model.accent, '#36dcff');
});
