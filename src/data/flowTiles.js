import { createFlowTileSource } from '../layers/traffic/flowSource.js';
export { tilesForBounds } from './tomtomTiles.js';
export {
  decodeFlowTile,
  normalizeFlowProperties,
} from '../layers/traffic/flowDecode.js';
const source = createFlowTileSource();
export const { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache } =
  source;
