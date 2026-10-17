import type { DemandModel, NormalizedGame, QuotaAssignment } from './model';
import { deriveRestPins, excludedFromSlot, placeStage3, positionTier } from './stage3';
import type { PlacementBlock, PlacementResult, FrozenBlock } from './stage3';

export interface PolishMetrics {
  maxCoreBenches: number;
  maxBoundaryTurnovers: number;
  restWindowViolations: number;
}

export interface PolishedPlacement extends PlacementResult {
  metrics: PolishMetrics;
}

export function runStages3And4(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[] = [],
): PolishedPlacement {
  const hard = placeStage3(game, demand, quotas, frozen, false);
  if (hard.complete) return polishStage4(game, demand, quotas, hard);
  const soft = placeStage3(game, demand, quotas, frozen, true);
  if (soft.complete) {
    soft.audit.softRestFallback = true;
    return polishStage4(game, demand, quotas, soft);
  }
  return polishStage4(game, demand, quotas, {
    ...soft,
    audit: { ...soft.audit, errors: [...hard.audit.errors, ...soft.audit.errors] },
  });
}

function coreNames(game: NormalizedGame): Set<string> {
  return new Set(game.players.filter((player) => player.group === 'core').map((player) => player.name));
}

function isInGoal(game: NormalizedGame, player: string, block: number): boolean {
  const half = game.totalBlocks / 2;
  return (player === game.firstHalfKeeper && block <= half)
    || (player === game.secondHalfKeeper && block > half);
}

function benchedCoreCount(game: NormalizedGame, block: PlacementBlock, cores: Set<string>): number {
  const playing = new Set(block.assignments.values());
  return [...cores].filter((name) => !playing.has(name) && !isInGoal(game, name, block.block)).length;
}

function metrics(game: NormalizedGame, blocks: PlacementBlock[]): PolishMetrics {
  const cores = coreNames(game);
  const maxCoreBenches = blocks.reduce((maximum, block) => {
    return Math.max(maximum, benchedCoreCount(game, block, cores));
  }, 0);
  const maxBoundaryTurnovers = blocks.slice(1).reduce((maximum, block, index) => {
    const previous = new Set(blocks[index].assignments.values());
    const current = new Set(block.assignments.values());
    const changes = [...new Set([...previous, ...current])].filter((name) => previous.has(name) !== current.has(name)).length;
    return Math.max(maximum, changes);
  }, 0);
  return { maxCoreBenches, maxBoundaryTurnovers, restWindowViolations: 0 };
}

function restWindow(game: NormalizedGame): Set<number> {
  const mid = (game.totalBlocks + 1) / 2;
  const lower = Math.max(1, Math.ceil(mid - 2));
  const upper = Math.min(game.totalBlocks - 2, Math.floor(mid + 1));
  return new Set(Array.from({ length: Math.max(0, upper - lower + 1) }, (_, index) => lower + index));
}

function playerByName(game: NormalizedGame, name: string) {
  return game.players.find((player) => player.name === name);
}

function exchangeAllowed(game: NormalizedGame, blocks: PlacementBlock[], blockIndex: number, slot: string, incoming: string, rest: Map<string, Set<number>>): boolean {
  const block = blocks[blockIndex];
  const player = playerByName(game, incoming);
  const half = game.totalBlocks / 2;
  const inGoalkeeperHalf = player && ((player.name === game.firstHalfKeeper && block.block <= half)
    || (player.name === game.secondHalfKeeper && block.block > half));
  if (!player || inGoalkeeperHalf || positionTier(player, slot) === 0
    || excludedFromSlot(player, slot) || [...block.assignments.values()].includes(incoming)
    || rest.get(incoming)?.has(block.block)) return false;
  return true;
}

function exchangePlayers(game: NormalizedGame, blocks: PlacementBlock[], highIndex: number, lowIndex: number, first: string, second: string, rest: Map<string, Set<number>>): PlacementBlock[] | null {
  const high = blocks[highIndex];
  const low = blocks[lowIndex];
  const highSlot = [...high.assignments].find(([, player]) => player === second)?.[0];
  const lowSlot = [...low.assignments].find(([, player]) => player === first)?.[0];
  if (!highSlot || !lowSlot) return null;
  const highAllowed = exchangeAllowed(game, blocks, highIndex, highSlot, first, rest);
  const lowAllowed = exchangeAllowed(game, blocks, lowIndex, lowSlot, second, rest);
  if (!highAllowed || !lowAllowed) return null;
  return blocks.map((block, index) => {
    if (index === highIndex) return { ...block, assignments: new Map([...block.assignments].map(([slot, player]) => [slot, slot === highSlot ? first : player])) };
    if (index === lowIndex) return { ...block, assignments: new Map([...block.assignments].map(([slot, player]) => [slot, slot === lowSlot ? second : player])) };
    return block;
  });
}

function restWindowPass(game: NormalizedGame, quotas: QuotaAssignment, blocks: PlacementBlock[]): PlacementBlock[] {
  const window = restWindow(game);
  const rest = new Map(deriveRestPins(game, quotas).map((pin) => [pin.player, new Set(pin.blocks)]));
  const coreWithoutPreset = game.players.filter((player) => player.group === 'core' && player.restPreset === 'none').map((player) => player.name);
  for (const player of coreWithoutPreset) {
    const outside = blocks.findIndex((block) => !window.has(block.block) && !new Set(block.assignments.values()).has(player));
    const inside = blocks.findIndex((block) => window.has(block.block) && new Set(block.assignments.values()).has(player));
    if (outside < 0 || inside < 0 || rest.get(player)?.has(blocks[outside].block)) continue;
    const other = [...new Set(blocks[outside].assignments.values())].find((candidate) => coreWithoutPreset.includes(candidate)
      && !new Set(blocks[inside].assignments.values()).has(candidate));
    if (!other) continue;
    const exchanged = exchangePlayers(game, blocks, outside, inside, player, other, rest);
    if (exchanged) return exchanged;
  }
  return blocks;
}

function spreadPass(game: NormalizedGame, blocks: PlacementBlock[], rest: Map<string, Set<number>>): PlacementBlock[] {
  const cores = coreNames(game);
  const counts = blocks.map((block) => benchedCoreCount(game, block, cores));
  const high = counts.indexOf(Math.max(...counts));
  const low = counts.indexOf(Math.min(...counts));
  if (high < 0 || low < 0 || counts[high] - counts[low] <= 1) return blocks;
  const highPlaying = new Set(blocks[high].assignments.values());
  const lowPlaying = new Set(blocks[low].assignments.values());
  const first = [...cores].find((name) => !highPlaying.has(name) && lowPlaying.has(name));
  const second = game.players.map((player) => player.name)
    .filter((name) => !cores.has(name))
    .find((name) => highPlaying.has(name) && !lowPlaying.has(name));
  if (!first || !second) return blocks;
  const exchanged = exchangePlayers(game, blocks, high, low, first, second, rest);
  return exchanged ?? blocks;
}

export function polishStage4(game: NormalizedGame, _demand: DemandModel, quotas: QuotaAssignment, placement: PlacementResult): PolishedPlacement {
  if (!placement.complete) return { ...placement, metrics: metrics(game, placement.blocks) };
  const window = restWindow(game);
  const blocks = placement.blocks.map((block) => ({ ...block, assignments: new Map(block.assignments) }));
  const rest = new Map(deriveRestPins(game, quotas).map((pin) => [pin.player, new Set(pin.blocks)]));
  let current = restWindowPass(game, quotas, blocks);
  current = spreadPass(game, current, rest);
  const cores = coreNames(game);
  const result = { ...placement, blocks: current };
  const resultMetrics = metrics(game, current);
  resultMetrics.restWindowViolations = current.reduce((count, block) => {
    const playing = new Set(block.assignments.values());
    return count + [...cores].filter((name) => game.players.find((player) => player.name === name)?.restPreset === 'none'
      && !playing.has(name) && !window.has(block.block)).length;
  }, 0);
  return { ...result, metrics: resultMetrics };
}
