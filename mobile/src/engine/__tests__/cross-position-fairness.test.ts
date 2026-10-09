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
  const result = generateSchedule({
    total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan',
    season_total_games: 10, season_game_number: 1, allow_emergency_assignments: true,
    disable_maximum_limits: false,
  }, rows);
  const fieldBlocks = (name: string): number => result.timeline.filter((block) =>
    [...block.D, ...block.M, ...block.F].includes(name)).length;
  expect(fieldBlocks('Max')).toBe(6);
  expect(fieldBlocks('Mahaswin')).toBe(5);
  expect(fieldBlocks('Prerith')).toBe(5);
});
