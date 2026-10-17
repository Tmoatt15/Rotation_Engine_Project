import { describe, expect, it } from 'vitest';
import { findPositionGaps } from '../position-gap';

const player = (name: string, positions: string[], backup_positions: string[] = [], extra: Record<string, unknown> = {}) => ({
  name,
  primary_positions: positions,
  backup_positions,
  ...extra,
});

describe('pre-generation position gaps', () => {
  it('uses the six field slots in the 2-1-2-1 formation', () => {
    const gaps = findPositionGaps('2-1-2-1', [
      player('D1', ['D']),
      player('D2', ['D']),
      player('M1', ['M']),
      player('M2', ['M']),
      player('M3', ['M']),
      player('F1', ['F']),
    ]);
    expect(gaps.map((gap) => [gap.position, gap.required])).toEqual([
      ['D', 2],
      ['M', 3],
      ['F', 1],
    ]);
  });

  it('reports a hard gap when fewer players cover a group than required slots', () => {
    const gaps = findPositionGaps('4-3-3', [
      player('D1', ['D']),
      player('D2', ['D']),
      player('D3', ['D']),
      player('M1', ['M']),
    ]);
    expect(gaps.find((gap) => gap.position === 'D')).toMatchObject({ kind: 'hard', required: 4, eligible: 3 });
  });

  it('does not report a group with enough depth', () => {
    const players = Array.from({ length: 5 }, (_, index) => player(`D${index}`, ['D']));
    expect(findPositionGaps('4-3-3', players).find((gap) => gap.position === 'D')).toBeUndefined();
  });

  it('ranks no-backup nearby players before backed-up and distant players', () => {
    const gaps = findPositionGaps('4-3-3', [
      player('D1', ['D']),
      player('D2', ['D']),
      player('D3', ['D']),
      player('Mid With Backup', ['M'], ['F']),
      player('Mid No Backup', ['M']),
      player('Forward No Backup', ['F']),
    ]);
    expect(gaps.find((gap) => gap.position === 'D')?.suggestions.map((candidate) => candidate.player)).toEqual([
      'Mid No Backup',
      'Forward No Backup',
      'Mid With Backup',
    ]);
  });

  it('excludes keepers, unavailable players, and already eligible players', () => {
    const gaps = findPositionGaps('4-3-3', [
      player('D1', ['D']),
      player('D2', ['D']),
      player('D3', ['D']),
      player('Already D', ['M'], ['D']),
      player('Keeper', ['GK'], [], { keeper: true }),
      player('Absent Mid', ['M'], [], { available: false }),
    ]);
    expect(gaps.find((gap) => gap.position === 'D')?.suggestions.map((candidate) => candidate.player)).toEqual([]);
  });

  it('returns a soft gap when coverage exactly equals the required slots', () => {
    const gaps = findPositionGaps('4-3-3', [
      ...Array.from({ length: 4 }, (_, index) => player(`D${index}`, ['D'])),
      ...Array.from({ length: 3 }, (_, index) => player(`M${index}`, ['M'])),
      ...Array.from({ length: 3 }, (_, index) => player(`F${index}`, ['F'])),
    ]);
    expect(gaps).toContainEqual(expect.objectContaining({ position: 'D', kind: 'soft' }));
  });
});
