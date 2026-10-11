import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, compareCandidates, deriveRestPins, normalizeGame, placeStage3, polishStage4 } from '..';
import type { RedesignGameInput, RedesignPlayerInput } from '../model';

const player = (name: string, group: string, positions: string[], rest_preset?: 'A' | 'B' | 'none'): RedesignPlayerInput => ({
  name,
  group,
  general_positions: positions,
  primary_positions: positions,
  rest_preset,
});

function setup(overrides: Partial<RedesignGameInput> = {}) {
  const gameInput: RedesignGameInput = {
    format: '11v11',
    formation: '4-3-3',
    totalBlocks: 10,
    firstHalfKeeper: 'Keeper A',
    secondHalfKeeper: 'Keeper B',
    ...overrides,
  };
  const roster = [
    player('Rest A', 'core', ['M'], 'A'),
    player('Rest B', 'core', ['M'], 'B'),
    player('Keeper A', 'rotational', ['GK']),
    player('Keeper B', 'rotational', ['GK']),
    ...Array.from({ length: 14 }, (_, index) => player(`Depth ${index + 1}`, 'rotational', ['ANY'])),
  ];
  const game = normalizeGame(gameInput, roster);
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  return { game, demand, quotas };
}

describe('redesign stages 3-4', () => {
  it('derives the specified A and B rest pins', () => {
    const { game, quotas } = setup();
    expect(deriveRestPins(game, quotas)).toEqual([
      { player: 'Rest A', blocks: [3, 8] },
      { player: 'Rest B', blocks: [5, 6] },
    ]);
  });

  it('uses season field history only after higher-priority candidate dimensions tie', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 10,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      player('Core More History', 'core', ['M']),
      player('Rot Less History', 'rotational', ['M']),
      { ...player('Rot More History', 'rotational', ['M']), historicalFieldBlocks: 5 },
      { ...player('Rot Less History 2', 'rotational', ['M']), historicalFieldBlocks: 1 },
    ]);
    const [core, rotational] = game.players;
    const state = {
      remainingMin: new Map([['Core More History', 1], ['Rot Less History', 1]]),
      remainingMax: new Map([['Core More History', 2], ['Rot Less History', 2]]),
      outOfPosition: new Map<string, number>(),
    };
    expect(compareCandidates(rotational, core, 'M1', 1, game, state, false, new Set(), new Map())).toBeGreaterThan(0);

    const moreHistory = game.players.find((candidate) => candidate.name === 'Rot More History')!;
    const lessHistory = game.players.find((candidate) => candidate.name === 'Rot Less History 2')!;
    const tiedState = {
      remainingMin: new Map([[moreHistory.name, 1], [lessHistory.name, 1]]),
      remainingMax: new Map([[moreHistory.name, 2], [lessHistory.name, 2]]),
      outOfPosition: new Map<string, number>(),
    };
    expect(compareCandidates(lessHistory, moreHistory, 'M1', 1, game, tiedState, false, new Set(), new Map())).toBeLessThan(0);
  });

  it('drops rest pins before a late arrival block', () => {
    const { game, quotas } = setup({ lateArrival: { player: 'Rest A', arrivalBlock: 5, targetBlocks: 3 } });
    expect(deriveRestPins(game, quotas).find((pin) => pin.player === 'Rest A')?.blocks.every((block) => block >= 5)).toBe(true);
  });

  it('honors frozen blocks and keeps placement deterministic', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 4,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      player('Rest A', 'rotational', ['D']),
      player('Rest B', 'rotational', ['M']),
      player('Field C', 'rotational', ['M']),
      player('Field D', 'rotational', ['F']),
      player('Field E', 'rotational', ['D']),
      player('Field F', 'rotational', ['M']),
      player('Field G', 'rotational', ['M']),
      player('Field H', 'rotational', ['F']),
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const frozen = [{ block: 1, assignments: new Map([['D1', 'Rest A'], ['M1', 'Rest B'], ['M2', 'Field C'], ['F1', 'Field D']]) }];
    const first = placeStage3(game, demand, quotas, frozen);
    const second = placeStage3(game, demand, quotas, frozen);
    expect(first.blocks[0].assignments).toEqual(frozen[0].assignments);
    expect(first.complete).toBe(true);
    expect(JSON.stringify(first.blocks)).toBe(JSON.stringify(second.blocks));
  });

  it('keeps half-keepers out of field slots during their keeper half', () => {
    const game = normalizeGame({
      format: '7v7',
      formation: '2-3-1',
      totalBlocks: 10,
      firstHalfKeeper: 'Keeper A',
      secondHalfKeeper: 'Keeper B',
    }, [
      { ...player('Keeper A', 'rotational', ['D']), primary_positions: ['ANY', 'GK'] },
      { ...player('Keeper B', 'rotational', ['D']), primary_positions: ['ANY', 'GK'] },
      player('Field A', 'rotational', ['ANY']),
      player('Field B', 'rotational', ['ANY']),
      player('Field C', 'rotational', ['ANY']),
      player('Field D', 'rotational', ['ANY']),
      player('Field E', 'rotational', ['ANY']),
      player('Field F', 'rotational', ['ANY']),
      player('Field G', 'rotational', ['ANY']),
      player('Field H', 'rotational', ['ANY']),
      player('Field I', 'rotational', ['ANY']),
      player('Field J', 'rotational', ['ANY']),
      player('Field K', 'rotational', ['ANY']),
      player('Field L', 'rotational', ['ANY']),
      player('Field M', 'rotational', ['ANY']),
      player('Field N', 'rotational', ['ANY']),
      player('Field O', 'rotational', ['ANY']),
      player('Field P', 'rotational', ['ANY']),
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const placement = placeStage3(game, demand, quotas);

    expect(placement.complete).toBe(true);
    for (const block of placement.blocks) {
      const values = [...block.assignments.values()];
      expect(new Set(values).size).toBe(values.length);
      const keeper = block.block <= 5 ? 'Keeper A' : 'Keeper B';
      expect(values).not.toContain(keeper);
    }
    for (const keeper of ['Keeper A', 'Keeper B']) {
      const fieldBlocks = placement.blocks.filter((block) => [...block.assignments.values()].includes(keeper)).map((block) => block.block);
      expect(fieldBlocks.length).toBeGreaterThanOrEqual(2);
      expect(fieldBlocks.length).toBeLessThanOrEqual(4);
      expect(fieldBlocks.every((block) => keeper === 'Keeper A' ? block > 5 : block <= 5)).toBe(true);
    }

  });

  it('completes a tight 19-player 11v11 placement deterministically', () => {
    const game = normalizeGame({
      format: '11v11',
      formation: '4-3-3',
      totalBlocks: 10,
      firstHalfKeeper: 'Keeper A',
      secondHalfKeeper: 'Keeper B',
    }, [
      { ...player('Keeper A', 'rotational', ['D']), primary_positions: ['ANY', 'GK'], keeper: true },
      { ...player('Keeper B', 'rotational', ['D']), primary_positions: ['ANY', 'GK'], keeper: true },
      ...Array.from({ length: 17 }, (_, index) => player(`Field ${index + 1}`, 'rotational', ['ANY'])),
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const first = placeStage3(game, demand, quotas);
    const second = placeStage3(game, demand, quotas);
    expect(first.complete).toBe(true);
    expect(first.blocks).toHaveLength(10);
    expect(first.blocks).toEqual(second.blocks);
  });

  it('runs polish metrics without changing a failed placement into success', () => {
    const { game, demand, quotas } = setup();
    const placement = placeStage3(game, demand, quotas);
    const polished = polishStage4(game, demand, quotas, placement);
    expect(polished.complete).toBe(placement.complete);
    expect(polished.metrics.maxCoreBenches).toBeGreaterThanOrEqual(0);
  });

  it('measures boundary turnovers using player values, not slot keys', () => {
    const { game } = setup({ format: '4v4', formation: '1-2-1', totalBlocks: 4, firstHalfKeeper: null, secondHalfKeeper: null });
    const placement = {
      blocks: [
        { block: 1, assignments: new Map([['D1', 'A'], ['M1', 'B'], ['M2', 'C'], ['F1', 'D']]) },
        { block: 2, assignments: new Map([['D1', 'A'], ['M1', 'B'], ['M2', 'E'], ['F1', 'F']]) },
      ],
      complete: true,
      audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] },
    };
    const polished = polishStage4(game, buildDemandModel(game), assignQuotas(game, buildDemandModel(game)), placement);
    expect(polished.metrics.maxBoundaryTurnovers).toBe(4);
  });

  it('improves the core bench spread with a non-core counterpart and preserves totals', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 4,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      player('Core A', 'core', ['ANY']),
      player('Core B', 'core', ['ANY']),
      player('Core C', 'core', ['M']),
      player('Rot A', 'rotational', ['D']),
      player('Rot B', 'rotational', ['ANY']),
      player('Rot C', 'rotational', ['M']),
      player('Rot D', 'rotational', ['F']),
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const placement = {
      blocks: [
        { block: 1, assignments: new Map([['D1', 'Rot A'], ['M1', 'Rot B'], ['M2', 'Rot C'], ['F1', 'Rot D']]) },
        { block: 2, assignments: new Map([['D1', 'Core A'], ['M1', 'Core B'], ['M2', 'Core C'], ['F1', 'Rot A']]) },
        { block: 3, assignments: new Map([['D1', 'Core A'], ['M1', 'Core B'], ['M2', 'Core C'], ['F1', 'Rot B']]) },
        { block: 4, assignments: new Map([['D1', 'Core A'], ['M1', 'Core B'], ['M2', 'Core C'], ['F1', 'Rot C']]) },
      ],
      complete: true,
      audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] },
    };
    const benchGap = (candidate: typeof placement): number => {
      const values = candidate.blocks.map((block) => 3 - ['Core A', 'Core B', 'Core C'].filter((name) => [...block.assignments.values()].includes(name)).length);
      return Math.max(...values) - Math.min(...values);
    };
    const beforeGap = benchGap(placement);
    const polished = polishStage4(game, demand, quotas, placement);
    const counts = new Map<string, number>();
    for (const block of polished.blocks) for (const name of block.assignments.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    const beforeCounts = new Map<string, number>();
    for (const block of placement.blocks) for (const name of block.assignments.values()) beforeCounts.set(name, (beforeCounts.get(name) ?? 0) + 1);
    expect(counts).toEqual(beforeCounts);
    expect(benchGap(polished)).toBeLessThan(beforeGap);
  });

  it('moves a generic core rest into the rest window without changing totals', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 10,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      player('Core A', 'core', ['ANY']),
      player('Core B', 'core', ['ANY']),
      player('Rot A', 'rotational', ['D']),
      player('Rot B', 'rotational', ['M']),
      player('Rot C', 'rotational', ['F']),
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const blocks = Array.from({ length: 10 }, (_, index) => ({
      block: index + 1,
      assignments: new Map([
        ['D1', index === 1 ? 'Core B' : 'Core A'],
        ['M1', 'Rot A'],
        ['M2', 'Rot B'],
        ['F1', 'Rot C'],
      ]),
    }));
    const placement = { blocks, complete: true, audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] } };
    const before = blocks.map((block) => [...block.assignments.values()].includes('Core A'));
    const polished = polishStage4(game, demand, quotas, placement);
    const after = polished.blocks.map((block) => [...block.assignments.values()].includes('Core A'));
    expect(before[1]).toBe(false);
    expect(after[1]).toBe(true);
    expect(after[3]).toBe(false);
  });
});
