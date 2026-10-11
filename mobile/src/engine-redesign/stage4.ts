import type { DemandModel, NormalizedGame, QuotaAssignment } from './model';
import { placeStage3 } from './stage3';
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
  const hard = placeStage3(game, demand, quotas, frozen);
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

function metrics(game: NormalizedGame, blocks: PlacementBlock[]): PolishMetrics {
  const cores = coreNames(game);
  const maxCoreBenches = blocks.reduce((maximum, block) => {
    const playing = new Set(block.assignments.values());
    return Math.max(maximum, [...cores].filter((name) => !playing.has(name)).length);
  }, 0);
  const maxBoundaryTurnovers = blocks.slice(1).reduce((maximum, block, index) => {
    const previous = new Set(blocks[index].assignments.values());
    const changes = [...new Set([...previous, ...block.assignments.values()])].filter((name) => previous.has(name) !== block.assignments.has(name)).length;
    return Math.max(maximum, changes);
  }, 0);
  return { maxCoreBenches, maxBoundaryTurnovers, restWindowViolations: 0 };
}

function swap(block: PlacementBlock, first: string, second: string): PlacementBlock {
  const assignments = new Map(block.assignments);
  for (const [slot, player] of assignments) {
    if (player === first) assignments.set(slot, second);
    else if (player === second) assignments.set(slot, first);
  }
  return { ...block, assignments };
}

function restWindow(game: NormalizedGame): Set<number> {
  const mid = (game.totalBlocks + 1) / 2;
  const lower = Math.max(1, Math.ceil(mid - 2));
  const upper = Math.min(game.totalBlocks - 2, Math.floor(mid + 1));
  return new Set(Array.from({ length: Math.max(0, upper - lower + 1) }, (_, index) => lower + index));
}

export function polishStage4(game: NormalizedGame, _demand: DemandModel, _quotas: QuotaAssignment, placement: PlacementResult): PolishedPlacement {
  if (!placement.complete) return { ...placement, metrics: metrics(game, placement.blocks) };
  const cores = coreNames(game);
  const window = restWindow(game);
  const blocks = placement.blocks.map((block) => ({ ...block, assignments: new Map(block.assignments) }));
  const passes = [
    (current: PlacementBlock[]): PlacementBlock[] => current,
    (current: PlacementBlock[]): PlacementBlock[] => {
      const counts = current.map((block) => [...cores].filter((name) => !new Set(block.assignments.values()).has(name)).length);
      const maximum = Math.max(...counts);
      const minimum = Math.min(...counts);
      if (maximum - minimum <= 1) return current;
      const high = counts.indexOf(maximum);
      const low = counts.indexOf(minimum);
      const highBenched = [...cores].find((name) => !new Set(current[high].assignments.values()).has(name));
      const lowPlaying = [...cores].find((name) => new Set(current[low].assignments.values()).has(name));
      if (!highBenched || !lowPlaying) return current;
      return current.map((block, index) => index === high ? swap(block, highBenched, lowPlaying) : index === low ? swap(block, lowPlaying, highBenched) : block);
    },
    (current: PlacementBlock[]): PlacementBlock[] => current,
  ];
  let current = blocks;
  for (const pass of passes) current = pass(current);
  const result = { ...placement, blocks: current };
  const resultMetrics = metrics(game, current);
  resultMetrics.restWindowViolations = current.reduce((count, block) => {
    const playing = new Set(block.assignments.values());
    return count + [...cores].filter((name) => game.players.find((player) => player.name === name)?.restPreset === 'none'
      && !playing.has(name) && !window.has(block.block)).length;
  }, 0);
  return { ...result, metrics: resultMetrics };
}
