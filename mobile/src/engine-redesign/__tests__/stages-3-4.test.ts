import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, deriveRestPins, normalizeGame, placeStage3, polishStage4 } from '..';
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
});
