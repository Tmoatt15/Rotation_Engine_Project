import { describe, expect, it } from 'vitest';

import { calculateGroupCoverage } from './coverage-utils';
import { rosterMatchesFormation } from './position-validation';

function groupCoverage(formation: string, players: Parameters<typeof calculateGroupCoverage>[1], group: string) {
  return calculateGroupCoverage(formation, players).find((item) => item.group === group);
}

describe('position analytics coverage', () => {
  it('changes recommended depth with the saved formation', () => {
    expect(groupCoverage('2-1-2-1', [], 'D')?.recommended).toBe(3);
    expect(groupCoverage('4-2-3-1', [], 'D')?.recommended).toBe(6);
  });

  it('counts normal group assignments separately from backups', () => {
    const midfield = groupCoverage('2-1-2-1', [
      { primary_positions: ['RM'], general_positions: ['M'] },
      { primary_positions: ['F'], backup_positions: ['M'] },
    ], 'M');

    expect(midfield).toMatchObject({ assigned: 1, backups: 1, backupNeeded: 3 });
  });

  it('treats general group assignments as coverage for the whole group', () => {
    const midfield = groupCoverage('4-2-3-1', [
      { general_positions: ['M'] },
      { general_positions: ['M'] },
    ], 'M');

    expect(midfield).toMatchObject({ assigned: 2, backups: 0 });
  });

  it('counts Any as field coverage but not goalkeeper coverage', () => {
    const coverage = calculateGroupCoverage('4-4-2', [
      { general_positions: ['ANY'], primary_positions: ['ANY'] },
    ]);

    expect(coverage.find((item) => item.group === 'D')).toMatchObject({ assigned: 1 });
    expect(coverage.find((item) => item.group === 'M')).toMatchObject({ assigned: 1 });
    expect(coverage.find((item) => item.group === 'F')).toMatchObject({ assigned: 1 });
    expect(coverage.find((item) => item.group === 'GK')).toMatchObject({ assigned: 0 });
  });

  it('scopes primary Any coverage to the general position group', () => {
    const coverage = calculateGroupCoverage('4-4-2', [
      { general_positions: ['M'], primary_positions: ['ANY'] },
    ]);

    expect(coverage.find((item) => item.group === 'M')).toMatchObject({ assigned: 1 });
    expect(coverage.find((item) => item.group === 'D')).toMatchObject({ assigned: 0 });
    expect(coverage.find((item) => item.group === 'F')).toMatchObject({ assigned: 0 });
    expect(rosterMatchesFormation('4-2', [
      { name: 'Midfielder', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] },
    ])).toBe(false);
  });

  it('does not count excluded group assignments or excluded backups', () => {
    const defense = groupCoverage('2-1-2-1', [
      { primary_positions: ['CB'], excluded_positions: ['D'] },
      { primary_positions: ['F'], backup_positions: ['D'], excluded_positions: ['D'] },
    ], 'D');

    expect(defense).toMatchObject({ assigned: 0, backups: 0, backupNeeded: 3 });
  });

  it('does not reduce the recommendation when current coverage increases', () => {
    const empty = groupCoverage('2-1-2-1', [], 'F');
    const covered = groupCoverage('2-1-2-1', [
      { primary_positions: ['F'] },
      { general_positions: ['F'] },
      { backup_positions: ['F'] },
    ], 'F');

    expect(empty?.recommended).toBe(2);
    expect(covered?.recommended).toBe(2);
  });

  it('detects exact positions left behind by a formation change', () => {
    expect(rosterMatchesFormation('4-4-2', [
      { name: 'Alex', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'], backup_positions: [], excluded_positions: [] },
    ])).toBe(true);
    expect(rosterMatchesFormation('4-2-3-1', [
      { name: 'Alex', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'], backup_positions: [], excluded_positions: [] },
    ])).toBe(false);
  });

  it('keeps Any, group, and goalkeeper assignments valid across formations', () => {
    expect(rosterMatchesFormation('2-1-2-1', [
      { name: 'Alex', group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY', 'GK'], backup_positions: ['D'], excluded_positions: [] },
    ])).toBe(true);
  });
});