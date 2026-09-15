import {
  createPanamaOfficialLayer,
  PANAMA_OFFICIAL_LAYER_DEFINITIONS,
} from '../../layers/panamaOfficial/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct the three independently toggleable Panamá Oficial layers. */
export function createApplicationPanamaOfficial({ source }) {
  return PANAMA_OFFICIAL_LAYER_DEFINITIONS.map((definition) =>
    createPanamaOfficialLayer({
      definition,
      source,
      services: { render, context, picking },
    }),
  );
}
