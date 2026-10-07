import type { SeasonRosterPlayer } from '../engine/models';
import { formationPositionRows } from '../position-validation';

export type HealthGroup = 'D' | 'M' | 'F';
export type HealthStatus = 'red' | 'yellow' | 'green';

export type PositionHealth = {
  group: HealthGroup;
  label: string;
  slots: number;
  eligible: string[];
  primary: string[];
  general: string[];
  backup: string[];
  buffer: number;
  status: HealthStatus;
};

const primaryGroups: Record<HealthGroup, Set<string>> = {
  D: new Set(['D', 'LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB']),
  M: new Set(['M', 'LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM', 'LAM', 'RAM', 'LDM', 'RDM']),
  F: new Set(['F', 'LF', 'CF', 'RF', 'ST', 'LW', 'LS', 'RS', 'RW']),
};

const labels: Record<HealthGroup, string> = { D: 'Defense', M: 'Midfield', F: 'Forwards' };

function normalized(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toUpperCase());
}

function coversGroup(values: string[] | undefined, group: HealthGroup, includeExact: boolean): boolean {
  const groupValues = normalized(values);
  return groupValues.some((value) => value === group || (includeExact && primaryGroups[group].has(value)));
}

function coverageSources(player: SeasonRosterPlayer, group: HealthGroup): Record<'primary' | 'general' | 'backup', boolean> {
  return {
    primary: coversGroup(player.primary_positions, group, true),
    general: coversGroup(player.general_positions, group, false),
    backup: coversGroup(player.backup_positions, group, true),
  };
}

export function positionHealth(formation: string, players: SeasonRosterPlayer[]): PositionHealth[] {
  const rows = formationPositionRows(formation);
  const rosterSize = players.length;
  const buffer = Math.max(1, Math.floor((rosterSize - 11) / 3));
  return (['D', 'M', 'F'] as const).map((group) => {
    const row = rows.find((candidate) => candidate.label === group);
    const slots = row?.exactPositions.length ?? 0;
    const classified = players.reduce((result, player) => {
      const sources = coverageSources(player, group);
      (Object.keys(sources) as Array<'primary' | 'general' | 'backup'>).forEach((category) => {
        if (sources[category]) result[category].push(player.name);
      });
      return result;
    }, { primary: [], general: [], backup: [] } as Record<'primary' | 'general' | 'backup', string[]>);
    const eligible = [...new Set([...classified.primary, ...classified.general, ...classified.backup])];
    const status: HealthStatus = eligible.length < slots
      ? 'red'
      : eligible.length < slots + buffer
        ? 'yellow'
        : 'green';
    return { group, label: labels[group], slots, eligible, ...classified, buffer, status };
  });
}

export function recommendedCoverage(formation: string, rosterSize: number): Array<{ group: HealthGroup; label: string; range: string }> {
  const rows = formationPositionRows(formation);
  const buffer = Math.max(1, Math.floor((rosterSize - 11) / 3));
  return (['D', 'M', 'F'] as const).map((group) => {
    const slots = rows.find((row) => row.label === group)?.exactPositions.length ?? 0;
    const minimum = slots + buffer;
    return { group, label: labels[group], range: `${minimum}-${minimum + 1}` };
  });
}

export function positionHealthMessage(health: PositionHealth): string {
  if (health.status === 'red') return `You need at least ${health.slots} players who can play ${health.label.toLowerCase()} to use this formation.`;
  if (health.status === 'yellow') return `You can field ${health.label.toLowerCase()}, but one absence could cause problems. Consider adding backup ${health.label.toLowerCase()} players.`;
  return `Good ${health.label.toLowerCase()} coverage.`;
}