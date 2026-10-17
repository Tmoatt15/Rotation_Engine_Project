import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '..';
import type { NormalizedGame, RedesignPlayerInput } from '../model';
import type { PlacementResult } from '../stage3';

const corePositions: Record<string, { primary: string; backup: string[] }> = {
  Alvin: { primary: 'D', backup: ['M'] },
  Blake: { primary: 'D', backup: ['M'] },
  Dane: { primary: 'M', backup: ['D'] },
  Everett: { primary: 'D', backup: ['M'] },
  Hanshith: { primary: 'F', backup: ['M'] },
  Jonathan: { primary: 'M', backup: ['D'] },
  Max: { primary: 'F', backup: ['M'] },
  Sawyer: { primary: 'F', backup: ['M'] },
  Sid: { primary: 'D', backup: ['F', 'M'] },
};

const coreNames = Object.keys(corePositions);
const rotationals = ['Frank', 'Artur', 'Brad', 'Ryan', 'Mahaswin', 'Prerith', 'Thanish', 'Extra1', 'Extra2', 'Extra3', 'Extra4'];
const rotationalPositions: Record<string, { primary: string; backup: string[] }> = {
  Frank: { primary: 'D', backup: ['M'] },
  Artur: { primary: 'M', backup: ['F'] },
  Brad: { primary: 'M', backup: ['F'] },
  Ryan: { primary: 'D', backup: ['M', 'F'] },
  Mahaswin: { primary: 'M', backup: [] },
  Prerith: { primary: 'M', backup: [] },
  Thanish: { primary: 'M', backup: ['D'] },
  Extra1: { primary: 'F', backup: ['M'] },
  Extra2: { primary: 'D', backup: ['M'] },
  Extra3: { primary: 'M', backup: [] },
  Extra4: { primary: 'F', backup: ['D'] },
};

function player(
  name: string,
  group: string,
  position: string,
  keeper = false,
  backupPositions: string[] = [],
): RedesignPlayerInput {
  return {
    name,
    group,
    general_positions: keeper ? [position, 'GK'] : [position],
    primary_positions: keeper ? ['ANY', 'GK'] : ['ANY'],
    backup_positions: backupPositions,
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
    if (name === 'Cameron') return player(name, 'rotational', 'M', true, ['D']);
    if (name === 'Eitan') return player(name, 'rotational', 'D', true, ['M']);
    if (coreNames.includes(name)) {
      const role = corePositions[name]!;
      return player(name, 'core', role.primary, false, role.backup);
    }
    const role = rotationalPositions[name]!;
    return player(name, 'rotational', role.primary, false, role.backup);
  }));
}

function generateWaterfill(game: NormalizedGame) {
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand, true);
  return { ...runStages3And4(game, demand, quotas), quotas };
}

function fieldCounts(result: ReturnType<typeof generateWaterfill>): Map<string, number> {
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
  for (const count of [12, 14, 16, 18, 19]) {
    it(`${count}-player roster generates a complete schedule`, () => {
      const result = generateWaterfill(buildGame(count));
      expect(result.blocks).toHaveLength(10);
      expect(result.complete).toBe(true);
    });
  }

  it('keeps quota minimums, keeper halves, and endpoint pins valid for 12 players', () => {
    const game = buildGame(12);
    const result = generateWaterfill(game);
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

  it('meets the v6 19-player Folsom floor, guardrail, and core M minimums', () => {
    const game = buildGame(19);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const totals = new Map(quotas.quotas.map((quota) => [
      quota.player,
      quota.fieldTarget + quota.pinnedBlocks.length,
    ]));
    const nonKeepers = quotas.quotas.filter((quota) => quota.keeperBlocks === 0);
    const coreTotals = nonKeepers.filter((quota) => quota.group === 'core').map((quota) => totals.get(quota.player)!);
    const rotationalTotals = nonKeepers.filter((quota) => quota.group === 'rotational').map((quota) => totals.get(quota.player)!);

    expect(quotas.audit.errors).toEqual([]);
    expect(Math.min(...coreTotals)).toBeGreaterThanOrEqual(Math.max(...rotationalTotals));
    for (const quota of nonKeepers) expect(totals.get(quota.player)).toBeGreaterThanOrEqual(4);
    expect(totals.get('Jonathan')).toBeGreaterThanOrEqual(5);
    expect(totals.get('Dane')).toBeGreaterThanOrEqual(5);
  });

  it('preserves core totals when removing a non-keeper and prioritizes eligible core surplus', () => {
    const fullGame = buildGame(19);
    const reducedGame = buildGame(18);
    const fullQuotas = assignQuotas(fullGame, buildDemandModel(fullGame));
    const reducedQuotas = assignQuotas(reducedGame, buildDemandModel(reducedGame));
    const fullTotals = new Map(fullQuotas.quotas.map((quota) => [quota.player, quota.fieldTarget + quota.pinnedBlocks.length]));
    const reducedTotals = new Map(reducedQuotas.quotas.map((quota) => [quota.player, quota.fieldTarget + quota.pinnedBlocks.length]));
    for (const name of coreNames) {
      expect(reducedTotals.get(name)).toBeGreaterThanOrEqual(fullTotals.get(name)!);
    }

    const maxCore = Math.round(fullGame.totalBlocks * 0.8);
    for (const group of ['D', 'M', 'F'] as const) {
      const primaryCores = fullGame.players.filter((player) =>
        player.group === 'core' && player.generalPositions.includes(group));
      const coreHasHeadroom = primaryCores.some((player) => fullTotals.get(player.name)! < maxCore);
      if (!coreHasHeadroom) continue;
      const primaryRotationals = fullGame.players.filter((player) =>
        player.group === 'rotational' && player.generalPositions.includes(group)
        && player.name !== 'Cameron' && player.name !== 'Eitan');
      for (const player of primaryRotationals) {
        const quota = fullQuotas.quotas.find((entry) => entry.player === player.name)!;
        const pinnedInPrimary = quota.pinnedBlocks.length;
        const primaryBlocks = (quota.groupTargets?.[group] ?? 0) + pinnedInPrimary;
        expect(primaryBlocks).toBeLessThanOrEqual(Math.round(fullGame.totalBlocks * 0.6));
      }
    }
  });

  it('completes the 12-player schedule within five seconds', () => {
    const start = Date.now();
    const result = generateWaterfill(buildGame(12));
    expect(result.complete).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('produces deterministic water-fill assignments', () => {
    const first = generateWaterfill(buildGame(12));
    const second = generateWaterfill(buildGame(12));
    expect(first.blocks).toEqual(second.blocks);
  });

  it('preserves minimums across all tested roster sizes', () => {
    for (const count of [12, 14, 16, 18]) {
      const result = generateWaterfill(buildGame(count));
      const counts = fieldCounts(result);
      for (const quota of result.quotas.quotas) {
        expect(counts.get(quota.player) ?? 0).toBeGreaterThanOrEqual(quota.fieldMin);
      }
    }
  });

  it('reduces minimums for an oversized 22-player roster before placement', () => {
    const game = buildGame(22);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand, true);
    expect(quotas.quotas.reduce((total, quota) => total + quota.fieldMin, 0)).toBeLessThanOrEqual(demand.slotsPerBlock * game.totalBlocks);
    const result = runStages3And4(game, demand, quotas);
    expect(result.complete).toBe(true);
  });

  it('reports closeness metrics for the 17-player crowding scenario', () => {
    const game = buildGame(17);
    const demand = buildDemandModel(game);
    const result = runStages3And4(game, demand, assignQuotas(game, demand, true));
    const closeness = measureCloseness(result, game.players.map((player) => player.name), demand.slotsPerBlock * game.totalBlocks);
    expect(closeness.complete).toBe(true);
    expect(closeness.strandedCount).toBe(0);
    expect(closeness.blocksPlaced).toBeGreaterThanOrEqual(demand.slotsPerBlock * game.totalBlocks - 5);
    expect(closeness.score).toBeGreaterThanOrEqual(0.95);
  });
});
