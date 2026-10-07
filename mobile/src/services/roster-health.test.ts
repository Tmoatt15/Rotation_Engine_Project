import { describe, expect, it } from 'vitest';

import type { SeasonRosterPlayer } from '../engine/models';
import { positionHealth, recommendedCoverage } from './roster-health';

function player(name: string, positions: Partial<Pick<SeasonRosterPlayer, 'general_positions' | 'primary_positions' | 'backup_positions'>> = {}): SeasonRosterPlayer {
  return {
    name,
    group: 'rotational',
    general_positions: positions.general_positions ?? [],
    primary_positions: positions.primary_positions ?? [],
    backup_positions: positions.backup_positions ?? [],
    excluded_positions: [],
  };
}

describe('roster position health', () => {
  it.each([
    [14, ['5-6', '4-5', '4-5']],
    [16, ['5-6', '4-5', '4-5']],
    [19, ['6-7', '5-6', '5-6']],
  ])('scales recommendations for %s players', (rosterSize, ranges) => {
    expect(recommendedCoverage('4-3-3', rosterSize).map((item) => item.range)).toEqual(ranges);
  });

  it('counts primary, general, and backup coverage once per position group', () => {
    const health = positionHealth('4-3-3', [
      player('Primary defender', { primary_positions: ['CB'] }),
      player('General midfielder', { general_positions: ['M'] }),
      player('Backup midfielder', { backup_positions: ['M'] }),
      player('Forward', { general_positions: ['F'], primary_positions: ['CF'], backup_positions: ['M'] }),
    ]);

    expect(health.find((item) => item.group === 'D')).toMatchObject({ eligible: ['Primary defender'], primary: ['Primary defender'] });
    expect(health.find((item) => item.group === 'M')).toMatchObject({ eligible: ['General midfielder', 'Backup midfielder', 'Forward'], general: ['General midfielder'], backup: ['Backup midfielder', 'Forward'] });
    expect(health.find((item) => item.group === 'F')).toMatchObject({ eligible: ['Forward'], primary: ['Forward'], general: ['Forward'] });
  });

  it('uses red, yellow, and green thresholds without blocking the caller', () => {
    const health = positionHealth('4-3-3', [
      player('D1', { general_positions: ['D'] }),
      player('D2', { general_positions: ['D'] }),
      player('D3', { general_positions: ['D'] }),
      player('D4', { general_positions: ['D'] }),
      player('M1', { general_positions: ['M'] }),
      player('M2', { general_positions: ['M'] }),
      player('M3', { general_positions: ['M'] }),
      player('M4', { general_positions: ['M'] }),
      player('F1', { general_positions: ['F'] }),
      player('F2', { general_positions: ['F'] }),
      player('F3', { general_positions: ['F'] }),
      player('F4', { general_positions: ['F'] }),
    ]);

    expect(health.find((item) => item.group === 'D')?.status).toBe('yellow');
    expect(health.find((item) => item.group === 'M')?.status).toBe('green');
    expect(health.find((item) => item.group === 'F')?.status).toBe('green');
  });
});