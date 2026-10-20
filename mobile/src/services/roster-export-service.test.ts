import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SeasonRosterPlayer, SeasonSettings, Team } from '@/engine/models';
import { buildRosterSnapshot } from './roster-export-service';

const { getSeasonSettings, getTeams } = vi.hoisted(() => ({
  getSeasonSettings: vi.fn(),
  getTeams: vi.fn(),
}));

vi.mock('@/services/team-service', () => ({ getSeasonSettings, getTeams }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Share: { share: vi.fn() } }));

function storedTeam(
  id: string,
  name: string,
  active: boolean,
  players: SeasonRosterPlayer[],
): Team & { saved_schedules: unknown[]; game_reports: unknown[] } {
  return {
    id,
    name,
    active,
    players: players.map((player) => player.name),
    season_roster: players,
    season_settings: undefined,
    saved_schedules: [{
      id: `schedule-${id}`,
      name: 'Saved schedule',
      game_number: 1,
      schedule: { game_number: 1, blocks: [] },
    }],
    game_reports: [{
      id: `report-${id}`,
      game_number: 1,
      created_at: '2026-10-20T00:00:00.000Z',
      total_blocks: 8,
      players: [],
    }],
  };
}

describe('roster export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports every team roster and only the six required settings', async () => {
    const chelseaPlayers: SeasonRosterPlayer[] = [
      {
        name: 'Emma',
        number: 7,
        keeper_eligible: false,
        group: 'rotational',
        general_positions: ['F'],
        primary_positions: ['LF'],
        backup_positions: [],
        excluded_positions: [],
      },
      {
        name: 'Brooklyn',
        keeper_eligible: true,
        group: 'rotational',
        general_positions: ['D', 'F'],
        primary_positions: ['D'],
        backup_positions: ['D', 'F'],
        excluded_positions: [],
      },
    ];
    const teams = [
      storedTeam('chelsea-id', 'Chelsea', true, chelseaPlayers),
      storedTeam('team-2', 'Blue', false, [{ ...chelseaPlayers[0], name: 'Alex', number: undefined }]),
    ];
    const settings: Record<string, SeasonSettings> = {
      'chelsea-id': {
        game_format: '9v9',
        formation: '3-3-2',
        total_blocks: 8,
        players_on_field: 9,
        has_goalkeeper: true,
        game_length_minutes: 50,
        block_length_minutes: 5,
        total_games: 1,
        substitution_alert: 'flash_and_vibrate',
        substitution_warning_seconds: 30,
      },
      'team-2': {
        game_format: '7v7',
        formation: '2-3-1',
        total_blocks: 6,
        players_on_field: 7,
        has_goalkeeper: true,
        game_length_minutes: 40,
        block_length_minutes: 5,
        total_games: 1,
        substitution_alert: 'flash_and_vibrate',
        substitution_warning_seconds: 30,
      },
    };

    getTeams.mockResolvedValue({ teams });
    getSeasonSettings.mockImplementation(async (teamId: string) => ({
      ...settings[teamId],
      formation_options: { '9v9': ['3-3-2', '3-4-1'], '7v7': ['2-3-1'] },
    }));

    const snapshot = await buildRosterSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      format: 'rotation-engine-roster',
      version: 1,
      app_version: '1.0.0',
      platform: 'ios',
      teams: [
        {
          id: 'chelsea-id',
          name: 'Chelsea',
          active: true,
          players: chelseaPlayers,
          settings: {
            game_format: '9v9',
            formation: '3-3-2',
            total_blocks: 8,
            players_on_field: 9,
            has_goalkeeper: true,
            game_length_minutes: 50,
          },
        },
        {
          id: 'team-2',
          name: 'Blue',
          active: false,
          players: [{ ...chelseaPlayers[0], name: 'Alex', number: undefined }],
          settings: {
            game_format: '7v7',
            formation: '2-3-1',
            total_blocks: 6,
            players_on_field: 7,
            has_goalkeeper: true,
            game_length_minutes: 40,
          },
        },
      ],
    });
    expect(snapshot.teams).toHaveLength(2);
    expect(snapshot.teams[0].players[0]).toEqual(chelseaPlayers[0]);
    expect(snapshot.teams[0].players[1]).toEqual(chelseaPlayers[1]);
    expect(Object.keys(snapshot.teams[0].settings)).toEqual([
      'game_format',
      'formation',
      'total_blocks',
      'players_on_field',
      'has_goalkeeper',
      'game_length_minutes',
    ]);
    expect(serialized).not.toContain('saved_schedules');
    expect(serialized).not.toContain('game_reports');
    expect(serialized).not.toContain('formation_options');
  });
});
