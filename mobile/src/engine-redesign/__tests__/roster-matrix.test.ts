import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, placeStage3 } from '..';
import type { NormalizedGame, RedesignPlayerInput } from '../model';
import type { PlacementResult } from '../stage3';

const corePositions: Record<string, string[]> = {
  Alvin: ['D', 'M'],
  Blake: ['D'],
  Dane: ['M'],
  Everett: ['D', 'M'],
  Hanshith: ['M', 'F'],
  Jonathan: ['M'],
  Max: ['F', 'M'],
  Sawyer: ['D', 'M'],
  Sid: ['F'],
};

const coreNames = Object.keys(corePositions);
const rotationals = ['Frank', 'Artur', 'Brad', 'Ryan', 'Mahaswin', 'Prerith', 'Thanish', 'Extra1', 'Extra2', 'Extra3', 'Extra4'];

function player(name: string, group: string, positions: string[], keeper = false): RedesignPlayerInput {
  return {
    name,
    group,
    general_positions: positions,
    primary_positions: positions,
    keeper,
  };
}

function buildGame(count: number): NormalizedGame {
  const names = [...coreNames, 'Cameron', 'Eitan', ...rotationals].slice(0, count);
  return normalizeGame({
    format: '11v11',
    formation: '4-3-3',
    totalBlocks: 10,
    firstHalfKeeper: 'Cameron',
    secondHalfKeeper: 'Eitan',
  }, names.map((name) => {
    if (name === 'Cameron' || name === 'Eitan') return player(name, 'rotational', ['D', 'GK'], true);
    return player(name, coreNames.includes(name) ? 'core' : 'rotational', corePositions[name] ?? ['ANY']);
  }));
}

function generateWithTiers(game: NormalizedGame) {
  const demand = buildDemandModel(game);
  for (let tier = 0; tier <= 3; tier += 1) {
    const quotas = assignQuotas(game, demand, tier);
    const result = placeStage3(game, demand, quotas);
    if (result.complete) {
      result.audit.relaxationTier = tier;
      return { ...result, quotas };
    }
  }
  throw new Error('No tier produced a complete schedule');
}

function fieldCounts(result: ReturnType<typeof generateWithTiers>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of result.blocks) {
    for (const player of block.assignments.values()) counts.set(player, (counts.get(player) ?? 0) + 1);
  }
  return counts;
}

function measureCloseness(result: PlacementResult, playerNames: string[], totalSlots: number) {
  const counts = new Map<string, number>();
  const blocksPlaced = result.blocks.reduce((total, block) => {
    for (const player of block.assignments.values()) counts.set(player, (counts.get(player) ?? 0) + 1);
    return total + block.assignments.size;
  }, 0);
  const strandedCount = playerNames.filter((player) => (counts.get(player) ?? 0) === 0).length;
  return {
    strandedCount,
    blocksPlaced,
    score: blocksPlaced / totalSlots - strandedCount * 0.1,
    complete: result.complete,
  };
}

describe('realistic roster-size matrix', () => {
  for (const [count, expectedTier] of [[12, 1], [14, 0], [16, 0], [18, 0], [19, 0]] as const) {
    it(`${count}-player roster generates a complete schedule`, () => {
      const result = generateWithTiers(buildGame(count));
      expect(result.blocks).toHaveLength(10);
      expect(result.audit.relaxationTier).toBeGreaterThanOrEqual(expectedTier);
      expect(result.audit.relaxationTier).toBeLessThanOrEqual(expectedTier + (count === 14 ? 1 : 0));
    });
  }

  it('keeps quota minimums, keeper halves, and endpoint pins valid for 12 players', () => {
    const game = buildGame(12);
    const result = generateWithTiers(game);
    const counts = fieldCounts(result);
    for (const quota of result.quotas.quotas) {
      expect(counts.get(quota.player) ?? 0).toBeGreaterThanOrEqual(quota.fieldMin);
    }
    for (const block of result.blocks) {
      const values = [...block.assignments.values()];
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain(block.block <= 5 ? 'Cameron' : 'Eitan');
    }
    expect([...result.blocks[9].assignments.values()]).toEqual(expect.arrayContaining(coreNames));
  });

  it('completes the 12-player schedule within five seconds', () => {
    const start = Date.now();
    const result = generateWithTiers(buildGame(12));
    expect(result.complete).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('produces deterministic tier and assignments', () => {
    const first = generateWithTiers(buildGame(12));
    const second = generateWithTiers(buildGame(12));
    expect(first.blocks).toEqual(second.blocks);
    expect(first.audit.relaxationTier).toBe(second.audit.relaxationTier);
  });

  it('preserves minimums across all tested tiers', () => {
    for (const count of [12, 14, 16, 18]) {
      const result = generateWithTiers(buildGame(count));
      const counts = fieldCounts(result);
      for (const quota of result.quotas.quotas) {
        expect(counts.get(quota.player) ?? 0).toBeGreaterThanOrEqual(quota.fieldMin);
      }
    }
  });

  it('reduces minimums for an oversized 22-player roster before placement', () => {
    const game = buildGame(22);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    expect(quotas.quotas.reduce((total, quota) => total + quota.fieldMin, 0)).toBeLessThanOrEqual(demand.slotsPerBlock * game.totalBlocks);
    const result = placeStage3(game, demand, quotas);
    expect(result.complete).toBe(true);
  });

  it('reports closeness metrics for the 17-player crowding scenario', () => {
    const game = buildGame(17);
    const demand = buildDemandModel(game);
    const result = placeStage3(game, demand, assignQuotas(game, demand));
    const closeness = measureCloseness(result, game.players.map((player) => player.name), demand.slotsPerBlock * game.totalBlocks);
    expect(closeness.complete).toBe(true);
    expect(closeness.strandedCount).toBe(0);
    expect(closeness.blocksPlaced).toBe(demand.slotsPerBlock * game.totalBlocks);
    expect(closeness.score).toBe(1);
  });
});
