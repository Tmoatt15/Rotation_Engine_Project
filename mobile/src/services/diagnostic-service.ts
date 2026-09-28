import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';

import { getTeams } from '@/services/team-service';
import { getRoster } from '@/services/team-service';
import { getSavedReports } from '@/services/report-service';
import { getSavedSchedules } from '@/services/schedule-service';
import { createPlayer } from '@/engine/rotation';
import { calculateMovementMetrics } from '@/engine/timeline';
import type { LiveSchedule } from '@/engine/models';

export interface DiagnosticSnapshot {
  format: 'rotation-engine-diagnostic';
  version: 2;
  created_at: string;
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
    version: 2,
    created_at: new Date().toISOString(),
    teams: snapshotTeams,
  };
}

export async function shareDiagnosticSnapshot(): Promise<void> {
  const snapshot = await buildDiagnosticSnapshot();
  const filename = `rotation-engine-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const path = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(path, JSON.stringify(snapshot, null, 2));
  await Share.share({
    title: 'Rotation Engine diagnostic snapshot',
    message: 'Rotation Engine diagnostic snapshot',
    url: path,
  });
}