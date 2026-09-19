import { createCoastalFloodLayer } from '../../layers/coastalFlood/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

export function createApplicationCoastalFlood({ source }) {
  return createCoastalFloodLayer({
    source,
    services: { render, context, picking },
  });
}
