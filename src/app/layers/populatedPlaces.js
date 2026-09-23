import { createPopulatedPlacesLayer } from '../../layers/populatedPlaces/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

export function createApplicationPopulatedPlaces({ source }) {
  return createPopulatedPlacesLayer({
    source,
    services: { render, context, picking, overlayHost },
  });
}
