import { describe, expect, it } from 'vitest';

import { appendBackupPosition, backupProgressText, backupSuggestions, calculateBackupNeeds, calculateGroupCoverage, calculateRosterCheck, countAssignedBackups, countGroupBackups, formatGeneralPositions, isMissingGeneralGroup } from './coverage-utils';
import { formationPositionDisplayLines, formationPositionRows, rosterMatchesFormation } from './position-validation';
import { calculatePlayingTimeNotices } from './playing-time-notices';

function groupCoverage(formation: string, players: Parameters<typeof calculateGroupCoverage>[1], group: string) {
  return calculateGroupCoverage(formation, players).find((item) => item.group === group);
}

describe('position analytics coverage', () => {
  const settings = { formation: '2-3-1', total_blocks: 10, game_format: '7v7' as const, has_goalkeeper: true };

  it('keeps balanced rotational groups quiet', () => {
    const players = [
      ...Array.from({ length: 9 }, (_, index) => ({ name: `Player ${index}`, group: 'rotational' as const, general_positions: ['ANY'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] })),
      { name: 'Keeper', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'], backup_positions: [], excluded_positions: [] },
    ];
    expect(calculatePlayingTimeNotices(settings, players)).toEqual({ playingTimeNotice: false, positionCoverageNotice: false });
  });

  describe('roster helper', () => {
    it('distributes backup suggestions by formation slots and rounds decimal needs to ranges', () => {
      expect(calculateBackupNeeds('3-3-2', 13)).toEqual({
        total: 7,
        groups: [
          { group: 'D', slots: 3, minimum: 2, maximum: 3, range: '2-3' },
          { group: 'M', slots: 3, minimum: 2, maximum: 3, range: '2-3' },
          { group: 'F', slots: 2, minimum: 1, maximum: 2, range: '1-2' },
        ],
      });
    });

    it('updates total and group backup progress from current assignments', () => {
      const players = [
        { name: 'Alex', backup_positions: ['D'] },
        { name: 'Bailey', backup_positions: ['CB', 'F'] },
        { name: 'Casey', backup_positions: ['M', 'CM'] },
      ];

      expect(countGroupBackups(players, 'D')).toBe(2);
      expect(countGroupBackups(players, 'F')).toBe(1);
      expect(countAssignedBackups(players)).toBe(4);
      expect(backupProgressText({ minimum: 2, maximum: 3 }, 0)).toBe('Suggest 2-3 backups');
      expect(backupProgressText({ minimum: 2, maximum: 3 }, 1)).toBe('Suggest 1-2 backups');
      expect(backupProgressText({ minimum: 2, maximum: 3 }, 2)).toBe('✓ 2 added (minimum met)');
      expect(backupProgressText({ minimum: 2, maximum: 3 }, 3)).toBe('✓ 3 added (maximum met)');
    });

    it('formats candidate positions from their general group assignments', () => {
      expect(formatGeneralPositions(['m', ' D ', 'M'])).toBe('M/D');
      expect(formatGeneralPositions(['NONE'])).toBe('—');
    });

    it('scales Roster Check targets by field roster size and formation slots', () => {
      const players = [
        ...Array.from({ length: 7 }, (_, index) => ({ name: `Defender ${index}`, general_positions: ['D'] })),
        ...Array.from({ length: 5 }, (_, index) => ({ name: `Midfielder ${index}`, general_positions: ['M'] })),
        ...Array.from({ length: 6 }, (_, index) => ({ name: `Forward ${index}`, general_positions: ['F'] })),
        { name: 'Keeper 1', keeper_eligible: true, general_positions: ['GK'] },
        { name: 'Keeper 2', keeper_eligible: true, general_positions: ['GK'] },
        { name: 'Unassigned', general_positions: ['NONE'] },
      ];

      expect(calculateRosterCheck('4-3-3', players, true)).toEqual([
        { group: 'D', label: 'Defenders', count: 7, minimum: 6, maximum: 8, status: 'in-range' },
        { group: 'M', label: 'Midfielders', count: 5, minimum: 4, maximum: 6, status: 'in-range' },
        { group: 'F', label: 'Forwards', count: 6, minimum: 4, maximum: 6, status: 'in-range' },
        { group: 'GK', label: 'Goalies', count: 2, minimum: 2, maximum: 3, status: 'in-range' },
      ]);
    });

    it('hides goalkeeper targets when the format has no keeper', () => {
      const groups = calculateRosterCheck('1-2-1', [], false);
      expect(groups.map((group) => group.group)).toEqual(['D', 'M', 'F']);
    });

    it('reports only field players missing a general group', () => {
      expect(isMissingGeneralGroup({ name: 'No group', general_positions: ['NONE'] })).toBe(true);
      expect(isMissingGeneralGroup({ name: 'Keeper', keeper_eligible: true, general_positions: ['NONE'] })).toBe(false);
      expect(isMissingGeneralGroup({ name: 'Midfielder', general_positions: ['M'] })).toBe(false);
    });

    it('ranks eligible backup suggestions in the specified order', () => {
      const players = [
        { name: 'Zed Midfield', group: 'rotational' as const, general_positions: ['M'] },
        { name: 'Beth Midfield', group: 'developing' as const, general_positions: ['M'] },
        { name: 'Amy Midfield', group: 'rotational' as const, general_positions: ['M'], backup_positions: ['D'] },
        { name: 'Dana Defense', group: 'rotational' as const, general_positions: ['D'] },
        { name: 'Excluded Midfield', group: 'rotational' as const, general_positions: ['M'], excluded_positions: ['F'] },
        { name: 'Already Forward', group: 'rotational' as const, general_positions: ['F'] },
        { name: 'Primary Striker', group: 'rotational' as const, general_positions: ['F'], primary_positions: ['ST'] },
        { name: 'Excluded Striker', group: 'rotational' as const, general_positions: ['M'], excluded_positions: ['ST'] },
        { name: 'Unassigned Midfield', group: 'rotational' as const, general_positions: ['NONE'] },
      ];

      expect(backupSuggestions(players, 'F').map((player) => player.name))
        .toEqual(['Zed Midfield', 'Amy Midfield', 'Beth Midfield', 'Dana Defense']);
    });

    it('appends a backup without replacing existing assignments', () => {
      const player = { name: 'Alex', general_positions: ['M'], backup_positions: ['D'] };
      expect(appendBackupPosition(player, 'F').backup_positions).toEqual(['D', 'F']);
      expect(appendBackupPosition(player, 'D')).toBe(player);
    });
  });

  it('allows a feasible top-heavy roster without a playing-time notice', () => {
    const players = Array.from({ length: 7 }, (_, index) => ({ name: `Core ${index}`, group: 'core' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['D', 'F'], excluded_positions: [] }));
    expect(calculatePlayingTimeNotices(settings, players).playingTimeNotice).toBe(false);
  });

  it('notices when group minimums exceed field capacity', () => {
    const players = Array.from({ length: 10 }, (_, index) => ({ name: `Core ${index}`, group: 'core' as const, general_positions: ['ANY'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] }));
    expect(calculatePlayingTimeNotices(settings, players).playingTimeNotice).toBe(true);
  });

  it('separates position coverage notices from playing-time notices', () => {
    const players = Array.from({ length: 10 }, (_, index) => ({ name: `Forward ${index}`, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['F'], backup_positions: [], excluded_positions: [] }));
    expect(calculatePlayingTimeNotices(settings, players)).toMatchObject({ playingTimeNotice: true, positionCoverageNotice: true });
  });

  it('does not require a goalkeeper for 4v4', () => {
    const players = Array.from({ length: 8 }, (_, index) => ({ name: `Player ${index}`, group: 'rotational' as const, general_positions: ['ANY'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] }));
    expect(calculatePlayingTimeNotices({ formation: '1-2-1', total_blocks: 10, game_format: '4v4', has_goalkeeper: false }, players).positionCoverageNotice).toBe(false);
  });

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

  it('accepts NONE and uses ST for the two special formations', () => {
    expect(rosterMatchesFormation('2-1-2-1', [
      { name: 'Keeper only', group: 'rotational', general_positions: ['NONE'], primary_positions: [], backup_positions: [], excluded_positions: [] },
    ])).toBe(true);
    expect(formationPositionRows('2-1-2-1').find((row) => row.label === 'F')?.exactPositions).toEqual(['ST']);
    expect(formationPositionRows('4-2-3-1').find((row) => row.label === 'F')?.exactPositions).toEqual(['ST']);
    expect(formationPositionRows('4-2-3-1').find((row) => row.label === 'M')?.exactPositions).toEqual(['LDM', 'RDM', 'LM', 'CAM', 'RM']);
  });

  it('orders midfield primary positions in formation shape rows', () => {
    expect(formationPositionDisplayLines('4-2-3-1', 'M', ['LDM', 'RDM', 'LM', 'CAM', 'RM']))
      .toEqual([['LM', 'CAM', 'RM'], ['LDM', 'RDM']]);
    expect(formationPositionDisplayLines('2-1-2-1', 'M', ['CDM', 'LM', 'RM']))
      .toEqual([['LM', 'RM'], ['CDM']]);
  });
});