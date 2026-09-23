import { describe, expect, it } from 'vitest';

import cases from './fixtures/rotation_contract_cases.json';
import { createPlayer, generateSchedule } from '../rotation';
import { eligiblePlayers } from '../positional';
import { canCoverSlot } from '../timeline';
import type { GameInput, PlayerInput, ScheduleBlock } from '../models';

function assertBlockInvariants(block: ScheduleBlock, fieldPlayers: number, hasGoalkeeper: boolean): void {
  const assigned = Object.values(block.positions);
  expect(assigned).not.toContain('UNASSIGNED');
  expect(assigned).not.toContain('NO GK AVAILABLE');
  expect(new Set(assigned).size).toBe(assigned.length);
  expect(assigned.length).toBe(fieldPlayers + (hasGoalkeeper ? 1 : 0));
  if (hasGoalkeeper) {
    expect(block.positions.GK).toBeTruthy();
    expect(block.positions.GK).toBe(block.GK);
  }
}

describe('rotation engine contract fixtures', () => {
  for (const testCase of cases) {
    it(`${testCase.id} preserves legal block invariants`, () => {
      const result = generateSchedule(
        testCase.game as GameInput,
        testCase.players.map((player) => createPlayer(player as PlayerInput)),
      );

      expect(result.errors).toEqual([]);
      result.timeline.forEach((block) => assertBlockInvariants(
        block,
        testCase.expect.field_players,
        testCase.expect.has_goalkeeper,
      ));
      if (testCase.expect.first_goalkeeper) {
        const midpoint = Math.ceil(result.timeline.length / 2);
        expect(result.timeline[0].GK).toBe(testCase.expect.first_goalkeeper);
        expect(result.timeline[midpoint].GK).toBe(testCase.expect.second_goalkeeper);
      }
    });
  }
});

describe('goalkeeper and minimum protection', () => {
  it('treats Any as every legal field group but never as goalkeeper eligibility', () => {
    const player = createPlayer({ name: 'Any Player', group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY'] });

    expect(eligiblePlayers([player], 'D')).toEqual([player]);
    expect(eligiblePlayers([player], 'M')).toEqual([player]);
    expect(eligiblePlayers([player], 'F')).toEqual([player]);
    expect(player.primary_positions.includes('GK')).toBe(false);
  });

  it('scopes primary Any to the player general group', () => {
    const midfieldAny = createPlayer({ name: 'Midfield Any', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] });
    const unrestrictedAny = createPlayer({ name: 'Unrestricted Any', group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY'] });

    expect(canCoverSlot(midfieldAny, 'CM', 'M')).toBe(true);
    expect(canCoverSlot(midfieldAny, 'CB', 'D')).toBe(false);
    expect(canCoverSlot(unrestrictedAny, 'CB', 'D')).toBe(true);
    expect(canCoverSlot(unrestrictedAny, 'CM', 'M')).toBe(true);
  });

  it('keeps dual-role goalkeepers within the two-to-three field-block range', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['D'] })),
      createPlayer({ name: 'F1', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'] }),
      createPlayer({ name: 'F2', group: 'rotational', general_positions: ['F'], primary_positions: ['RF'] }),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      ...['RM1', 'RM2', 'RM3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      createPlayer({ name: 'Thanish', group: 'developing', general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM'] }),
      createPlayer({ name: 'Cameron', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM', 'GK'] }),
      createPlayer({ name: 'Eitan', group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB', 'GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'Cameron', second_half_gk: 'Eitan' }, players);
    const cameron = players.find((player) => player.name === 'Cameron');
    const eitan = players.find((player) => player.name === 'Eitan');

    expect(result.errors).toEqual([]);
    expect(cameron?.gk_blocks).toBe(5);
    expect(cameron?.field_blocks).toBeGreaterThanOrEqual(2);
    expect(cameron?.field_blocks).toBeLessThanOrEqual(3);
    expect(eitan?.gk_blocks).toBe(5);
    expect(eitan?.field_blocks).toBeGreaterThanOrEqual(2);
    expect(eitan?.field_blocks).toBeLessThanOrEqual(3);
    expect(players.find((player) => player.name === 'Thanish')?.field_blocks).toBeGreaterThanOrEqual(4);
  });
});

function compactRoster(): PlayerInput[] {
  return [
    ...['LB1', 'LB2', 'RB1', 'RB2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'RB'] })),
    ...['M1', 'M2', 'M3', 'M4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LCM', 'RCM', 'LM', 'RM'] })),
    ...['F1', 'F2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] })),
    { name: 'GK1', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'] },
    { name: 'GK2', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'] },
  ];
}

describe('quota fairness and controlled coverage', () => {
  it('keeps core players at a seven-block baseline when minimum capacity is constrained', () => {
    const players = [
      ...compactRoster(),
      ...['Core D1', 'Core D2', 'Core D3', 'Core D4', 'Core M1', 'Core M2', 'Core F1'].map((name) => ({ name, group: 'core' as const, general_positions: ['D'], primary_positions: ['LB', 'RB', 'LCB', 'RCB'] })),
    ].map(createPlayer);
    generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(players.filter((player) => player.group === 'core').every((player) => player.target_blocks === 7)).toBe(true);
    expect(players.filter((player) => player.group === 'core').every((player) => player.hard_maximum_blocks === 7)).toBe(true);
  });

  it('rotates conditional eighth-block bonuses using cumulative season totals', () => {
    const players = [
      ...compactRoster().filter((player) => !player.general_positions?.includes('F')),
      { name: 'Core A', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
      { name: 'Core B', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
    ].map(createPlayer);
    generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2', season_game_number: 2, season_player_blocks: { 'Core A': 8, 'Core B': 0 } }, players);

    expect(players.find((player) => player.name === 'Core A')?.target_blocks).toBe(7);
    expect(players.find((player) => player.name === 'Core B')?.target_blocks).toBe(8);
  });

  it('reports exact-position starts separately from total position usage', () => {
    const players = compactRoster().map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);
    const firstBlockPlayers = Object.entries(result.timeline[0].positions).map(([position, player]) => [player, position]);

    expect(result.starting_position_counts).toBeDefined();
    firstBlockPlayers.forEach(([player, position]) => expect(result.starting_position_counts?.[player]?.[position]).toBe(1));
  });

  it('allows a named-position player to use their general group for exact assignment', () => {
    const players = [
      ...compactRoster().filter((player) => !player.general_positions?.includes('M')),
      { name: 'M1', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM'] },
      { name: 'M2', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LCM'] },
      { name: 'M3', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['RCM'] },
      { name: 'Versatile', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['CAM'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(result.errors).toEqual([]);
    expect(result.timeline.some((block) => Object.values(block.positions).includes('Versatile'))).toBe(true);
  });

  it('repairs avoidable defender minimum deficits when defender capacity permits', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB'] })),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM'] })),
      ...['F1', 'F2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] })),
      { name: 'GK1', group: 'rotational' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      { name: 'GK2', group: 'rotational' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(result.errors).toEqual([]);
    expect(players.filter((player) => player.general_positions.includes('D')).every((player) => player.field_blocks >= 5)).toBe(true);
  });
});