import { it, expect } from 'vitest';
import { createPlayer, generateSchedule } from '../rotation';

it('rebalances the exported Real Folsom roster across positions', () => {
  const rows = [
    ['Alvin', 'core', ['D'], ['LCB', 'RCB'], ['M']], ['Artur', 'rotational', ['M'], ['ANY'], ['F']],
    ['Blake', 'core', ['D', 'M'], ['ANY'], []], ['Brad', 'rotational', ['M'], ['ANY'], ['F']],
    ['Cameron', 'rotational', ['M'], ['ANY', 'GK'], ['D']], ['Dane', 'core', ['M'], ['ANY'], ['D']],
    ['Eitan', 'rotational', ['D'], ['ANY', 'GK'], ['M']], ['Everett', 'core', ['D'], ['LCB', 'RCB'], ['CM']],
    ['Frank', 'rotational', ['D'], ['ANY'], ['M']], ['Hanshith', 'core', ['F'], ['ANY'], ['M', 'CM']],
    ['Jonathan', 'core', ['M'], ['ANY'], ['D']], ['Mahaswin', 'rotational', ['M'], ['ANY'], []],
    ['Max', 'core', ['F'], ['LF'], ['M']], ['Prerith', 'rotational', ['M'], ['ANY'], []],
    ['Ryan', 'rotational', ['D'], ['ANY'], ['M', 'F']], ['Sawyer', 'core', ['F'], ['RF'], ['M']],
    ['Sid', 'core', ['D'], ['ANY'], ['F', 'M']], ['Thanish', 'rotational', ['M'], ['ANY'], ['LB', 'RB']],
    ['Yash', 'rotational', ['D'], ['ANY'], ['M']],
  ].map(([name, group, general_positions, primary_positions, backup_positions]) => createPlayer({
    name: name as string, group: group as 'core' | 'rotational',
    general_positions: general_positions as string[], primary_positions: primary_positions as string[],
    backup_positions: backup_positions as string[],
  }));
  const activeRows = rows.filter((player) => player.name !== 'Blake');
  const seasonPlayerBlocks = {
    Alvin: 6, Artur: 5, Blake: 6, Brad: 5, Cameron: 7, Dane: 6, Eitan: 7, Everett: 6,
    Frank: 5, Hanshith: 7, Jonathan: 6, Mahaswin: 5, Max: 6, Prerith: 5, Ryan: 5,
    Sawyer: 7, Sid: 6, Thanish: 5, Yash: 5,
  };
  const seasonPositionStarts = {
    Alvin: { LCB: 1 }, Blake: { LB: 1 }, Cameron: { GK: 1 }, Dane: { LM: 1 },
    Eitan: { CM: 1 }, Everett: { RCB: 1 }, Hanshith: { CF: 1 }, Jonathan: { RM: 1 },
    Max: { LF: 1 }, Sawyer: { RF: 1 }, Sid: { RB: 1 },
  };
  const fullResult = generateSchedule({
    total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan',
    season_total_games: 10, season_game_number: 1, allow_emergency_assignments: true,
    disable_maximum_limits: false,
  }, rows);
  const result = generateSchedule({
    total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan',
    season_total_games: 10, season_game_number: 2, allow_emergency_assignments: true,
    season_player_blocks: seasonPlayerBlocks,
    season_position_starts: seasonPositionStarts,
    season_goalkeeper_starts: { Cameron: 1, Eitan: 0 },
    disable_maximum_limits: false,
  }, activeRows);
  const fieldBlocks = (schedule: ReturnType<typeof generateSchedule>, name: string): number => schedule.timeline.filter((block) =>
    [...block.D, ...block.M, ...block.F].includes(name)).length;
  expect(fieldBlocks(fullResult, 'Max')).toBe(6);
  expect(fieldBlocks(fullResult, 'Mahaswin')).toBe(5);
  expect(fieldBlocks(fullResult, 'Prerith')).toBe(5);
  expect(fieldBlocks(result, 'Thanish')).toBe(5);
  expect(fieldBlocks(result, 'Yash')).toBe(5);
});
