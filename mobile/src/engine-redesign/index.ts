export * from './model';
export { normalizeGame } from './stage0';
export { buildDemandModel, ZONE_POSITIONS } from './stage1';
export { assignQuotas, BANDS, maximumBlocks, percentageBlocks } from './stage2';
export { deriveRestPins, placeStage3 } from './stage3';
export type { FrozenBlock, PlacementBlock, PlacementResult, RestPin } from './stage3';
export { polishStage4, runStages3And4 } from './stage4';
export type { PolishMetrics, PolishedPlacement } from './stage4';
