import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getTeams } from '@/services/team-service';
import { getRoster } from '@/services/team-service';
import { getSavedReports } from '@/services/report-service';
import { getSavedSchedules } from '@/services/schedule-service';
import { createPlayer } from '@/engine/rotation';
import { calculateMovementMetrics } from '@/engine/timeline';
import type { LiveSchedule } from '@/engine/models';
import { getAcceptedSchedule } from '@/live-schedule';

export interface DiagnosticSnapshot {
  format: 'rotation-engine-diagnostic';
  version: 3;
  created_at: string;
  app_version: string;
  platform: string;
  os_version: string;
  accepted_schedule: Awaited<ReturnType<typeof getAcceptedSchedule>>;
  teams: Array<{
    id: string;
    name: string;
    active: boolean;
    players: unknown[];
    season_settings?: unknown;
    saved_schedules: unknown[];
    game_reports: unknown[];
  }>;
}

function diagnosticFilename(teamNames: string[], date = new Date()): string {
  const teamName = teamNames.length === 1
    ? teamNames[0].replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : 'rotation-engine';
  const safeTeamName = teamName || 'rotation-engine';
  return `${safeTeamName}-backup-${date.toISOString().slice(0, 10)}.json`;
}

function safeExportFilename(filename: string): string {
  const withoutExtension = filename.trim().replace(/\.json$/i, '');
  const safeName = withoutExtension.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safeName) throw new Error('A filename is required.');
  return `${safeName}.json`;
}

export async function getDefaultDiagnosticFilename(): Promise<string> {
  const { teams } = await getTeams();
  return diagnosticFilename(teams.map((team) => team.name));
}

function movementSlots(positionRows: NonNullable<LiveSchedule['position_rows']> = []) {
  const slots = { D: [] as string[], M: [] as string[], F: [] as string[] };
  for (const row of positionRows) {
    const group = row.label.includes('DEFENDER') ? 'D' : row.label.includes('MIDFIELD') ? 'M' : row.label.includes('FORWARD') ? 'F' : null;
    if (group) slots[group].push(...row.positions.filter((position) => position !== 'GK'));
  }
  return slots;
}

export async function buildDiagnosticSnapshot(): Promise<DiagnosticSnapshot> {
  const { teams } = await getTeams();
  const acceptedSchedule = await getAcceptedSchedule();
  const snapshotTeams = await Promise.all(teams.map(async (team) => {
    const savedSchedules = await getSavedSchedules(team.id);
    const roster = (await getRoster(team.id)).players.map(createPlayer);
    return {
    id: team.id,
    name: team.name,
    active: Boolean(team.active),
    players: team.season_roster ?? [],
    season_settings: team.season_settings,
    saved_schedules: savedSchedules.map((savedSchedule) => ({
      ...savedSchedule,
      review_status: savedSchedule.schedule.errors?.length ? 'generated_with_errors' : savedSchedule.schedule.review_status ?? 'generated',
        movement_metrics: calculateMovementMetrics(savedSchedule.schedule.blocks, savedSchedule.schedule.blocks.length, roster, movementSlots(savedSchedule.schedule.position_rows)),
    })),
    game_reports: await getSavedReports(team.id),
    };
  }));
  return {
    format: 'rotation-engine-diagnostic',
    version: 3,
    created_at: new Date().toISOString(),
    app_version: Constants.expoConfig?.version ?? 'Unknown',
    platform: Platform.OS,
    os_version: String(Platform.Version),
    accepted_schedule: acceptedSchedule,
    teams: snapshotTeams,
  };
}

export async function shareDiagnosticSnapshot(filename: string): Promise<void> {
  const snapshot = await buildDiagnosticSnapshot();
  const path = `${FileSystem.cacheDirectory}${safeExportFilename(filename)}`;
  await FileSystem.writeAsStringAsync(path, JSON.stringify(snapshot, null, 2));
  await Sharing.shareAsync(path, { dialogTitle: 'Share Rotation Engine backup', mimeType: 'application/json' });
}