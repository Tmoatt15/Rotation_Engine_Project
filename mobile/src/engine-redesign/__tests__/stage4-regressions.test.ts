import { describe, expect, it } from 'vitest';

import { buildDemandModel, normalizeGame, polishStage4 } from '..';
import type { PlacementBlock } from '../stage3';

function emptyQuotas(fieldSlots: number) {
  return {
    quotas: [],
    audit: { relaxedGroups: [], surplusAssignments: [], unfillableWithinMax: 0 },
    fieldSlots,
    goalkeeperSlots: 0,
  };
}

describe('Stage 4 regressions', () => {
  it('does not count a core goalkeeper as benched while assigned in goal', () => {
    const game = normalizeGame({
      format: '7v7',
      formation: '2-3-1',
      totalBlocks: 4,
      firstHalfKeeper: 'Core Keeper',
      secondHalfKeeper: 'Rot Keeper',
    }, [
      { name: 'Core Keeper', group: 'core', general_positions: ['M'], keeper_eligible: true },
      { name: 'Core D', group: 'core', general_positions: ['D'] },
      { name: 'Core M', group: 'core', general_positions: ['M'] },
      { name: 'Rot Keeper', group: 'rotational', general_positions: ['D'], keeper_eligible: true },
      { name: 'Depth D', group: 'rotational', general_positions: ['D'] },
      { name: 'Depth M1', group: 'rotational', general_positions: ['M'] },
      { name: 'Depth M2', group: 'rotational', general_positions: ['M'] },
      { name: 'Depth F', group: 'rotational', general_positions: ['F'] },
    ]);
    const blocks: PlacementBlock[] = [1, 2, 3, 4].map((block) => ({
      block,
      assignments: block <= 2
        ? new Map([
          ['D1', 'Core D'], ['D2', 'Rot Keeper'], ['M1', 'Core M'],
          ['M2', 'Depth M1'], ['M3', 'Depth M2'], ['F1', 'Depth F'],
        ])
        : new Map([
          ['D1', 'Core D'], ['D2', 'Depth D'], ['M1', 'Core M'],
          ['M2', 'Core Keeper'], ['M3', 'Depth M1'], ['F1', 'Depth F'],
        ]),
    }));
    const demand = buildDemandModel(game);
    const placement = { blocks, complete: true, audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] } };

    const polished = polishStage4(game, demand, emptyQuotas(demand.fieldSlots.length), placement);

    expect(polished.metrics.maxCoreBenches).toBe(0);
    expect(polished.blocks).toEqual(blocks);
  });

  it('rejects a spread exchange that puts a player in a tier-0 slot', () => {
    const game = normalizeGame({
      format: '4v4',
      formation: '1-2-1',
      totalBlocks: 4,
      firstHalfKeeper: null,
      secondHalfKeeper: null,
    }, [
      { name: 'Core A', group: 'core', general_positions: ['D'], rest_preset: 'none' },
      { name: 'Core B', group: 'core', general_positions: ['M'], rest_preset: 'none' },
      { name: 'Core C', group: 'core', general_positions: ['M'], rest_preset: 'none' },
      { name: 'Rot D', group: 'rotational', general_positions: ['D'] },
      { name: 'Rot F', group: 'rotational', general_positions: ['F'] },
      { name: 'Rot M', group: 'rotational', general_positions: ['M'] },
      { name: 'Rot M2', group: 'rotational', general_positions: ['M'] },
    ]);
    const blocks: PlacementBlock[] = [
      {
        block: 1,
        assignments: new Map([['D1', 'Rot D'], ['M1', 'Rot M'], ['M2', 'Rot M2'], ['F1', 'Rot F']]),
      },
      {
        block: 2,
        assignments: new Map([['D1', 'Rot D'], ['M1', 'Core B'], ['M2', 'Core C'], ['F1', 'Core A']]),
      },
    ];
    const demand = buildDemandModel(game);
    const placement = { blocks, complete: true, audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] } };

    const polished = polishStage4(game, demand, emptyQuotas(demand.fieldSlots.length), placement);

    expect(polished.blocks).toEqual(blocks);
  });
});
