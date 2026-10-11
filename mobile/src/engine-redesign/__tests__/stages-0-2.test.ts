import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, ZONE_POSITIONS } from '..';
import type { RedesignGameInput, RedesignPlayerInput } from '../model';
import fingerprintCases from '../../engine/__tests__/fixtures/rotation_fingerprint_cases.json';

const player = (name: string, group: string, positions: string[]): RedesignPlayerInput => ({
  name,
  group,
  general_positions: positions,
  primary_positions: positions,
});

function game(overrides: Partial<RedesignGameInput> = {}): RedesignGameInput {
  return {
    format: '11v11',
    formation: '4-3-3',
    totalBlocks: 10,
    firstHalfKeeper: 'Keeper A',
    secondHalfKeeper: 'Keeper B',
    ...overrides,
  };
}

describe('redesign stages 0-2', () => {
  it('normalizes core aliases and bypasses keeper gating for 4v4', () => {
    const normalized = normalizeGame(
      game({ format: '4v4', formation: '1-2-1', firstHalfKeeper: null, secondHalfKeeper: null }),
      [player('Core A', 'core_a', ['M']), player('Core B', 'core_b', ['F'])],
    );
    expect(normalized.players.map((item) => item.group)).toEqual(['core', 'core']);
  });

  it('requires both keepers for goalkeeper formats', () => {
    expect(() => normalizeGame(game({ secondHalfKeeper: null }), [player('Keeper A', 'rotational', ['GK'])])).toThrow('Choose a goalkeeper for both halves.');
  });

  it('rejects core field over-capacity before quota assignment', () => {
    const roster = Array.from({ length: 11 }, (_, index) => player(`Core ${index}`, 'core', ['D']));
    expect(() => normalizeGame(game(), roster)).toThrow(/Core is limited to 10 field players/);
  });

  it('emits deterministic demand and immutable zone constants', () => {
    const normalized = normalizeGame(game(), [
      player('Keeper A', 'rotational', ['GK']),
      player('Keeper B', 'rotational', ['GK']),
    ]);
    const demand = buildDemandModel(normalized);
    expect(demand.fieldSlots).toHaveLength(10);
    expect(demand.fieldSlots.filter((slot) => slot.zone === 'CB')).toHaveLength(2);
    expect(ZONE_POSITIONS.CM.has('CAM')).toBe(true);
    expect(demand.goalkeeperBlocks).toEqual([5, 5]);
  });

  it('uses the new bands and endpoint accounting for ten blocks', () => {
    const normalized = normalizeGame(game(), [
      player('Core', 'core', ['M']),
      player('Rotational', 'rotational', ['M']),
      player('Developing', 'developing', ['M']),
      player('Keeper A', 'rotational', ['GK']),
      player('Keeper B', 'rotational', ['GK']),
    ]);
    const quotas = assignQuotas(normalized, buildDemandModel(normalized));
    const core = quotas.quotas.find((item) => item.player === 'Core')!;
    expect(core.pinnedBlocks).toEqual([1, 10]);
    expect(core.totalMax).toBe(8);
    expect(core.remainingMin).toBe(6);
    expect(core.remainingMax).toBe(6);
  });

  it('keeps goalkeeper blocks separate from field limits', () => {
    const normalized = normalizeGame(game(), [
      player('Keeper A', 'rotational', ['M', 'GK']),
      player('Keeper B', 'rotational', ['M', 'GK']),
      player('Field', 'rotational', ['M']),
    ]);
    const quotas = assignQuotas(normalized, buildDemandModel(normalized));
    const keeper = quotas.quotas.find((item) => item.player === 'Keeper A')!;
    expect(keeper.keeperBlocks).toBe(5);
    expect(keeper.gkMin).toBe(5);
    expect(keeper.fieldMax).toBeGreaterThan(0);
  });

  it('honors an explicit late-arrival target and block-10 core endpoint', () => {
    const normalized = normalizeGame(game({
      lateArrival: { player: 'Late Core', arrivalBlock: 4, targetBlocks: 3 },
    }), [
      player('Late Core', 'core', ['M']),
      player('Keeper A', 'rotational', ['GK']),
      player('Keeper B', 'rotational', ['GK']),
    ]);
    const quota = assignQuotas(normalized, buildDemandModel(normalized)).quotas.find((item) => item.player === 'Late Core')!;
    expect(quota.pinnedBlocks).toEqual([10]);
    expect(quota.totalMin).toBe(3);
    expect(quota.totalMax).toBe(3);
  });

  it('adapts the shared fingerprint fixtures without importing the shipping engine', () => {
    const supported = fingerprintCases.filter((fixture) => fixture.game.game_format !== '5v5');
    for (const fixture of supported) {
      const format = fixture.game.game_format
        ?? (fixture.game.formation === '2-3-1' ? '7v7'
          : fixture.game.formation === '3-3-2' ? '9v9'
            : fixture.game.formation === '4-4-2' || fixture.game.formation === '4-3-3' ? '11v11'
              : '4v4');
      const input: RedesignGameInput = {
        format: format as RedesignGameInput['format'],
        formation: fixture.game.formation,
        totalBlocks: fixture.game.total_blocks,
        firstHalfKeeper: fixture.game.first_half_gk ?? null,
        secondHalfKeeper: fixture.game.second_half_gk ?? null,
      };
      const roster = fixture.players as RedesignPlayerInput[];
      if (input.format === '4v4') {
        expect(() => normalizeGame(input, roster)).not.toThrow();
      } else if (input.firstHalfKeeper && input.secondHalfKeeper) {
        expect(() => normalizeGame(input, roster)).not.toThrow();
      } else {
        expect(() => normalizeGame(input, roster)).toThrow('Choose a goalkeeper for both halves.');
      }
    }
  });
});
