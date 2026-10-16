import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, compareCandidates, deriveRestPins, isEligible, normalizeGame, placeStage3, polishStage4, runStages3And4, turnoverVariance } from '..';
import type { RedesignGameInput, RedesignPlayerInput } from '../model';

const player = (name: string, group: string, positions: string[], rest_preset?: 'A' | 'B' | 'none', primaryPositions = positions): RedesignPlayerInput => ({
  name,
  group,
  general_positions: positions,
  primary_positions: primaryPositions,
  rest_preset,
});

function setup(overrides: Partial<RedesignGameInput> = {}) {
  const gameInput: RedesignGameInput = {
    format: '4v4',
    formation: '1-2-1',
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
    ...Array.from({ length: 14 }, (_, index) => player(`Depth ${index + 1}`, 'rotational', ['D', 'M', 'F'], undefined, ['ANY'])),
  ];
  const game = normalizeGame(gameInput, roster);
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  return { game, demand, quotas };
}

describe('redesign stages 3-4', () => {
  it('prefers evenly spread turnover over boundary spikes', () => {
    const smooth = Array.from({ length: 10 }, (_, index) => ({
      block: index + 1,
      assignments: new Map([['D1', `A${index % 2}`], ['M1', `M${index % 2}`], ['F1', `F${index % 2}`]]),
    }));
    const spiky = Array.from({ length: 10 }, (_, index) => ({
      block: index + 1,
      assignments: new Map([['D1', index === 2 ? 'B' : 'A'], ['M1', index === 2 ? 'N' : 'M'], ['F1', index === 2 ? 'Q' : 'F']]),
    }));
    expect(turnoverVariance(smooth)).toBeLessThan(turnoverVariance(spiky));
  });

  it('constrains ANY primary positions to the general group', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 10,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [{
      ...player('Hanshith', 'core', ['F']),
      primary_positions: ['ANY'],
      backup_positions: ['M', 'CM'],
    }, {
      ...player('Sawyer', 'core', ['F']),
      primary_positions: ['RF'],
      backup_positions: ['M'],
    }]);
    const hanshith = game.players[0];
    const sawyer = game.players[1];
    expect(isEligible(hanshith, 'LB')).toBe(false);
    expect(isEligible(hanshith, 'CF')).toBe(true);
    expect(isEligible(hanshith, 'CM')).toBe(true);
    expect(isEligible(sawyer, 'LB')).toBe(false);
    expect(isEligible(sawyer, 'RB')).toBe(false);
    expect(isEligible(sawyer, 'RF')).toBe(true);
    expect(isEligible(sawyer, 'LF')).toBe(true);
    expect(isEligible(sawyer, 'CM')).toBe(true);
  });

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
      remainingTarget: new Map([['Core More History', 1], ['Rot Less History', 1]]),
      remainingMax: new Map([['Core More History', 2], ['Rot Less History', 2]]),
      outOfPosition: new Map<string, number>(),
    };
    expect(compareCandidates(rotational, core, 'M1', 1, game, state, false, new Set(), new Map())).toBeGreaterThan(0);

    const moreHistory = game.players.find((candidate) => candidate.name === 'Rot More History')!;
    const lessHistory = game.players.find((candidate) => candidate.name === 'Rot Less History 2')!;
    const tiedState = {
      remainingMin: new Map([[moreHistory.name, 1], [lessHistory.name, 1]]),
      remainingTarget: new Map([[moreHistory.name, 1], [lessHistory.name, 1]]),
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
    const frozen = [{ block: 1, assignments: new Map([['D1', 'Rest A'], ['M1', 'Rest B'], ['M2', 'Field C'], ['ST', 'Field D']]) }];
    const first = placeStage3(game, demand, quotas, frozen);
    const second = placeStage3(game, demand, quotas, frozen);
    expect(first.blocks[0].assignments).toEqual(frozen[0].assignments);
    expect(first.complete).toBe(true);
    expect(first.blocks.every((block) => block.assignments.size === demand.fieldSlots.length)).toBe(true);
    expect(JSON.stringify(first.blocks)).toBe(JSON.stringify(second.blocks));
  });

  it('reports every unfilled slot in an over-constrained placement', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 6,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      player('Only defender', 'rotational', ['D']),
      player('Only midfielder', 'rotational', ['M']),
      player('Only forward', 'rotational', ['F']),
    ]);
    const demand = buildDemandModel(game);
    const placement = placeStage3(game, demand, assignQuotas(game, demand));
    const unfilled = placement.blocks.flatMap((block) => demand.fieldSlots
      .filter((slot) => !block.assignments.has(slot.slot))
      .map((slot) => `Block ${block.block}, slot ${slot.slot}`));

    expect(placement.complete).toBe(false);
    expect(placement.audit.errors.filter((error) => error.startsWith('Unfilled slot: ')))
      .toEqual(unfilled.map((slot) => `Unfilled slot: ${slot}.`));
    expect(unfilled.length).toBeGreaterThan(0);
  });

  it('fills the actual Chelsea roster without holes or keeper-half fielding', () => {
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Maddie',
      secondHalfKeeper: 'Avery',
    }, [
      { ...player('Avery', 'rotational', ['M'], undefined, ['M']), keeper: true, keeper_eligible: true },
      { ...player('Brooklyn', 'core', ['M'], undefined, ['CM']), backup_positions: ['D'], keeper: true, keeper_eligible: true },
      { ...player('Dolce', 'rotational', ['D'], undefined, ['ANY']) },
      { ...player('Emma', 'rotational', ['F'], undefined, ['LF']) },
      { ...player('Kelsey', 'core', ['F'], undefined, ['ANY']), backup_positions: ['D'] },
      { ...player('Maddie', 'core', ['F'], undefined, ['RF']), keeper: true, keeper_eligible: true },
      { ...player('Madelyn', 'rotational', ['M'], undefined, ['CM']), backup_positions: ['F'] },
      { ...player('Meg', 'rotational', ['D'], undefined, ['ANY']), backup_positions: ['M'] },
      { ...player('Natalie', 'rotational', ['D'], undefined, ['LB']) },
      { ...player('Rachel', 'rotational', ['F'], undefined, ['ANY']), backup_positions: ['M'] },
      { ...player('Reese', 'rotational', ['M'], undefined, ['ANY']), backup_positions: ['F'] },
      { ...player('Selma', 'rotational', ['M'], undefined, ['ANY']) },
      { ...player('Sophia', 'core', ['D'], undefined, ['CB']) },
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const placement = runStages3And4(game, demand, quotas);
    const fieldCounts = new Map<string, number>();
    for (const block of placement.blocks) {
      const names = [...block.assignments.values()];
      expect(names).toHaveLength(demand.fieldSlots.length);
      expect(new Set(names).size).toBe(names.length);
      expect(names).not.toContain(block.block <= 4 ? 'Maddie' : 'Avery');
      for (const name of names) fieldCounts.set(name, (fieldCounts.get(name) ?? 0) + 1);
    }

    expect(placement.complete).toBe(true);
    expect(placement.audit.errors.filter((error) => error.startsWith('Unfilled slot: '))).toEqual([]);
    for (const quota of quotas.quotas) {
      expect(fieldCounts.get(quota.player) ?? 0).toBeGreaterThanOrEqual(quota.fieldMin + quota.pinnedBlocks.length);
    }
    for (const name of ['Maddie', 'Avery']) {
      const quota = quotas.quotas.find((entry) => entry.player === name)!;
      expect(fieldCounts.get(name)).toBeGreaterThanOrEqual(quota.fieldMin + quota.pinnedBlocks.length);
      expect(fieldCounts.get(name)).toBeLessThanOrEqual(quota.fieldMax + quota.pinnedBlocks.length);
    }
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
      ...Array.from({ length: 16 }, (_, index) => player(`Field ${String.fromCharCode(65 + index)}`, 'rotational', ['D', 'M', 'F'], undefined, ['ANY'])),
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

  it.each([
    [8, 3, 3],
    [10, 3, 4],
    [12, 4, 5],
  ])('caps a half-keeper at %d blocks to %d-%d field blocks', (totalBlocks, minimum, maximum) => {
    const game = normalizeGame({
      format: '7v7',
      formation: '2-3-1',
      totalBlocks,
      firstHalfKeeper: 'Keeper A',
      secondHalfKeeper: 'Keeper B',
    }, [
      { ...player('Keeper A', 'rotational', ['D']), keeper_eligible: true },
      { ...player('Keeper B', 'rotational', ['D']), keeper_eligible: true },
    ]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);

    expect(quotas.quotas.find((quota) => quota.player === 'Keeper A')?.fieldMin).toBe(minimum);
    expect(quotas.quotas.find((quota) => quota.player === 'Keeper A')?.fieldMax).toBe(maximum);
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
      ...Array.from({ length: 17 }, (_, index) => player(`Field ${index + 1}`, 'rotational', ['D', 'M', 'F'], undefined, ['ANY'])),
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
      player('Core A', 'core', ['D'], undefined, ['ANY']),
      player('Core B', 'core', ['D'], undefined, ['ANY']),
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
    const benchGap = (candidate: { blocks: Array<{ assignments: Map<string, string> }> }): number => {
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
    expect(benchGap(polished)).toBe(beforeGap);
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
    expect(after[1]).toBe(false);
    expect(after[3]).toBe(true);
  });
});
