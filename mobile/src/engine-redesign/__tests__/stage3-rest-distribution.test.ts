import { describe, expect, it } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, placeStage3 } from '..';
import type { RedesignPlayerInput } from '../model';

describe('Stage 3 rest distribution', () => {
  it("balances each player's dynamic rests between both halves", () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `Core D${index + 1}`, group: 'core', general_positions: ['D'], rest_preset: 'none' as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core', general_positions: ['M'], rest_preset: 'none' as const,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        name: `Core F${index + 1}`, group: 'core', general_positions: ['F'], rest_preset: 'none' as const,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        name: `Rot D${index + 1}`, group: 'rotational', general_positions: ['D'],
      })),
      { name: 'Rot M', group: 'rotational', general_positions: ['M'] },
      ...Array.from({ length: 2 }, (_, index) => ({
        name: `Rot F${index + 1}`, group: 'rotational', general_positions: ['F'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['GK'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['GK'], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '11v11',
      formation: '4-3-3',
      totalBlocks: 8,
      firstHalfKeeper: 'Keeper A',
      secondHalfKeeper: 'Keeper B',
    }, roster);
    const demand = buildDemandModel(game);
    const placement = placeStage3(game, demand, assignQuotas(game, demand));

    expect(placement.complete).toBe(true);
    for (const player of game.players.filter((candidate) => candidate.group === 'core')) {
      const firstHalfRests = placement.blocks.slice(0, 4)
        .filter((block) => ![...block.assignments.values()].includes(player.name)).length;
      const secondHalfRests = placement.blocks.slice(4)
        .filter((block) => ![...block.assignments.values()].includes(player.name)).length;
      expect(Math.abs(firstHalfRests - secondHalfRests)).toBeLessThanOrEqual(1);
    }
  });
});
