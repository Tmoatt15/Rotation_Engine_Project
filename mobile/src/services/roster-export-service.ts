import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { Platform, Share } from 'react-native';

import { GAME_FORMATS } from '@/engine/season';
import type { SeasonRosterPlayer } from '@/engine/models';
import { getSeasonSettings, getTeams } from '@/services/team-service';

export interface RosterSnapshot {
  format: 'rotation-engine-roster';
  version: 1;
  created_at: string;
  app_version: string;
  platform: string;
  teams: {
    id: string;
    name: string;
    active: boolean;
    players: SeasonRosterPlayer[];
    settings: {
      game_format: string;
      formation: string;
      total_blocks: number;
      players_on_field: number;
      has_goalkeeper: boolean;
      game_length_minutes: number;
    };
  }[];
}

export async function buildRosterSnapshot(): Promise<RosterSnapshot> {
  const { teams } = await getTeams();
  const snapshotTeams = await Promise.all(teams.map(async (team) => {
    const settings = await getSeasonSettings(team.id);
    const formatDefaults = GAME_FORMATS[settings.game_format];
    return {
      id: team.id,
      name: team.name,
      active: Boolean(team.active),
      players: team.season_roster ?? [],
      settings: {
        game_format: settings.game_format,
        formation: settings.formation,
        total_blocks: settings.total_blocks,
        players_on_field: settings.players_on_field ?? formatDefaults.players_on_field,
        has_goalkeeper: settings.has_goalkeeper ?? formatDefaults.has_goalkeeper,
        game_length_minutes: settings.game_length_minutes,
      },
    };
  }));

  return {
    format: 'rotation-engine-roster',
    version: 1,
    created_at: new Date().toISOString(),
    app_version: Constants.expoConfig?.version ?? 'Unknown',
    platform: Platform.OS,
    teams: snapshotTeams,
  };
}

export async function shareRosterSnapshot(): Promise<void> {
  console.log('[roster-export] Building snapshot');
  const snapshot = await buildRosterSnapshot();
  const json = JSON.stringify(snapshot, null, 2);
  const byteSize = new TextEncoder().encode(json).byteLength;
  console.log(`[roster-export] Serialized snapshot: ${byteSize} bytes`);
  await Promise.race([
    Share.share({ title: 'Rotation Engine roster export', message: json }),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
}

export async function copyRosterSnapshot(): Promise<void> {
  console.log('[roster-export] Building snapshot for clipboard');
  const snapshot = await buildRosterSnapshot();
  const json = JSON.stringify(snapshot, null, 2);
  const byteSize = new TextEncoder().encode(json).byteLength;
  console.log(`[roster-export] Clipboard snapshot: ${byteSize} bytes`);
  await Clipboard.setStringAsync(json);
}
