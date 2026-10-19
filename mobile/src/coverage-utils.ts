import { isDedicatedKeeper as isDedicatedKeeperHelper, NONE_POSITION } from './position-groups';
import { formationPositionRows } from './position-validation';

export type CoveragePositionGroup = 'F' | 'M' | 'D' | 'GK';

export type CoveragePlayer = {
  general_positions?: string[];
  primary_positions?: string[];
  backup_positions?: string[];
  excluded_positions?: string[];
};

export type GroupCoverage = {
  group: CoveragePositionGroup;
  recommended: number;
  assigned: number;
  backups: number;
  backupNeeded: number;
};

export type RosterHelperPlayer = CoveragePlayer & {
  name: string;
  group?: string;
  keeper_eligible?: boolean;
};

export type RosterCheckGroup = {
  group: CoveragePositionGroup;
  label: string;
  count: number;
  minimum: number;
  maximum: number;
  status: 'in-range' | 'over' | 'under';
};

export type BackupNeed = { group: 'D' | 'M' | 'F'; slots: number; range: string };

const groupLabels: Record<CoveragePositionGroup, string> = {
  D: 'Defenders',
  M: 'Midfielders',
  F: 'Forwards',
  GK: 'Goalies',
};

function isDedicatedKeeper(player: RosterHelperPlayer): boolean {
  return isDedicatedKeeperHelper(player.keeper_eligible === true, player.general_positions ?? []);
}

export function isMissingGeneralGroup(player: RosterHelperPlayer): boolean {
  if (isDedicatedKeeper(player)) return false;
  const general = (player.general_positions ?? []).map((position) => position.trim().toUpperCase());
  return general.includes(NONE_POSITION)
    || !general.some((position) => ['D', 'M', 'F', 'ANY'].includes(position));
}

export function calculateRosterCheck(
  formation: string,
  players: RosterHelperPlayer[],
  showGoalkeepers: boolean,
): RosterCheckGroup[] {
  const rows = formationPositionRows(formation);
  const slots = Object.fromEntries(
    (['D', 'M', 'F'] as const).map((group) => [
      group,
      rows.find((row) => row.label === group)?.exactPositions.length ?? 0,
    ]),
  ) as Record<'D' | 'M' | 'F', number>;
  const totalSlots = slots.D + slots.M + slots.F;
  const fieldPlayers = players.filter((player) =>
    !isDedicatedKeeper(player) && !isMissingGeneralGroup(player),
  );
  const fieldPlayerCount = fieldPlayers.length;
  const coverage = calculateGroupCoverage(formation, fieldPlayers);
  const groups: RosterCheckGroup[] = (['D', 'M', 'F'] as const).map((group) => {
    const center = totalSlots ? Math.round(fieldPlayerCount * slots[group] / totalSlots) : 0;
    const count = coverage.find((item) => item.group === group);
    const minimum = Math.max(0, center - 1);
    const maximum = center + 1;
    const assigned = (count?.assigned ?? 0) + (count?.backups ?? 0);
    return {
      group,
      label: groupLabels[group],
      count: assigned,
      minimum,
      maximum,
      status: assigned < minimum ? 'under' : assigned > maximum ? 'over' : 'in-range',
    };
  });
  if (showGoalkeepers) {
    const goalieCount = players.filter((player) => player.keeper_eligible === true).length;
    groups.push({
      group: 'GK',
      label: groupLabels.GK,
      count: goalieCount,
      minimum: 2,
      maximum: 3,
      status: goalieCount < 2 ? 'under' : goalieCount > 3 ? 'over' : 'in-range',
    });
  }
  return groups;
}

export function calculateBackupNeeds(formation: string, rosterSize: number): { total: number; groups: BackupNeed[] } {
  const rows = formationPositionRows(formation);
  const groups = (['D', 'M', 'F'] as const).map((group) => ({
    group,
    slots: rows.find((row) => row.label === group)?.exactPositions.length ?? 0,
  }));
  const totalSlots = groups.reduce((total, group) => total + group.slots, 0);
  const total = Math.ceil(rosterSize / 2);
  return {
    total,
    groups: groups.filter(({ slots }) => slots > 0).map(({ group, slots }) => {
      const value = totalSlots ? total * slots / totalSlots : 0;
      return { group, slots, range: Number.isInteger(value) ? `${value}` : `${Math.floor(value)}-${Math.ceil(value)}` };
    }),
  };
}

function generalPositionAllowsGroup(positions: string[], group: CoveragePositionGroup): boolean {
  if (group === 'GK') return false;
  return positions.some((position) => {
    const normalized = position.toUpperCase();
    return normalized === 'ANY' || normalized === group;
  });
}

export function belongsToCoverageGroup(position: string, group: CoveragePositionGroup): boolean {
  const normalized = position.toUpperCase();
  if (normalized === 'ANY') return group !== 'GK';
  if (group === 'GK') return normalized === 'GK';
  if (group === 'F') return normalized === 'F' || normalized.startsWith('F') || ['CF', 'LF', 'LW', 'LS', 'RF', 'RS', 'RW', 'ST'].includes(normalized);
  if (group === 'M') return normalized === 'M' || normalized.startsWith('M') || ['CM', 'CDM', 'CAM', 'LDM', 'RDM'].includes(normalized);
  return normalized === 'D' || ['CB', 'LB', 'RB', 'LCB', 'RCB', 'LWB', 'RWB'].includes(normalized);
}

function formationGroupCounts(formation: string): Record<Exclude<CoveragePositionGroup, 'GK'>, number> {
  if (formation === '2-1-2-1') return { D: 2, M: 3, F: 1 };
  if (formation === '4-2-3-1') return { D: 4, M: 5, F: 1 };
  const parts = formation.split('-').map(Number);
  if (parts.length === 2) return { D: parts[0] || 0, M: 0, F: parts[1] || 0 };
  return { D: parts[0] || 0, M: parts[1] || 0, F: parts[2] || 0 };
}

function recommendedDepth(formation: string, group: CoveragePositionGroup): number {
  if (group === 'GK') return 3;
  const count = formationGroupCounts(formation)[group];
  return count + (count <= 2 ? 1 : 2);
}

function hasGroupPosition(positions: string[], group: CoveragePositionGroup, excluded: Set<string>): boolean {
  return positions.some((position) => {
    const normalized = position.toUpperCase();
    return normalized && !excluded.has(normalized) && belongsToCoverageGroup(normalized, group);
  });
}

export function calculateGroupCoverage(formation: string, players: CoveragePlayer[]): GroupCoverage[] {
  const groups: CoveragePositionGroup[] = ['F', 'M', 'D', 'GK'];
  return groups.map((group) => {
    let assigned = 0;
    let backups = 0;
    players.forEach((player) => {
      const excluded = new Set((player.excluded_positions ?? []).map((position) => position.toUpperCase()));
      const excludedGroup = [...excluded].some((position) => position === group);
      const primary = (player.primary_positions ?? []).filter((position) => position.toUpperCase() !== 'ANY');
      const primaryAny = (player.primary_positions ?? []).some((position) => position.toUpperCase() === 'ANY');
      const normal = !excludedGroup && (
        hasGroupPosition(primary, group, excluded) ||
        hasGroupPosition(player.general_positions ?? [], group, excluded) ||
        (primaryAny && generalPositionAllowsGroup(player.general_positions ?? [], group))
      );
      if (normal) {
        assigned += 1;
      } else if (!excludedGroup && hasGroupPosition(player.backup_positions ?? [], group, excluded)) {
        backups += 1;
      }
    });
    const recommended = recommendedDepth(formation, group);
    return {
      group,
      recommended,
      assigned,
      backups,
      backupNeeded: Math.max(0, recommended - assigned - backups),
    };
  });
}

export function backupSuggestions(
  players: RosterHelperPlayer[],
  target: 'D' | 'M' | 'F',
): RosterHelperPlayer[] {
  const preferredSources: Record<'D' | 'M' | 'F', readonly string[]> = {
    D: ['M'],
    M: ['D', 'F'],
    F: ['M'],
  };
  const preferred = new Set(preferredSources[target]);
  return players.filter((player) => {
    const general = (player.general_positions ?? []).map((position) => position.trim().toUpperCase());
    const excluded = (player.excluded_positions ?? []).map((position) => position.trim().toUpperCase());
    if (general.includes(NONE_POSITION) || !general.some((position) => ['D', 'M', 'F', 'ANY'].includes(position))) return false;
    if (excluded.some((position) => belongsToCoverageGroup(position, target))) return false;
    const alreadyAssigned = general.includes(target)
      || (player.primary_positions ?? []).some((position) => {
        const normalized = position.trim().toUpperCase();
        if (normalized === 'ANY') return general.includes('ANY') || general.includes(target);
        return belongsToCoverageGroup(normalized, target);
      })
      || (player.backup_positions ?? []).some((position) => belongsToCoverageGroup(position, target));
    return !alreadyAssigned;
  }).sort((left, right) => {
    const sourceRank = (player: RosterHelperPlayer) => {
      const general = (player.general_positions ?? []).map((position) => position.trim().toUpperCase());
      return general.some((position) => preferred.has(position)) ? 0 : 1;
    };
    const tierRank = (player: RosterHelperPlayer) => {
      if (player.group === 'rotational' || player.group === 'rotational_gk') return 0;
      if (player.group === 'developing' || player.group === 'developmental') return 1;
      return 2;
    };
    const backupRank = (player: RosterHelperPlayer) => (player.backup_positions ?? []).length ? 1 : 0;
    return sourceRank(left) - sourceRank(right)
      || tierRank(left) - tierRank(right)
      || backupRank(left) - backupRank(right)
      || left.name.localeCompare(right.name);
  });
}

export function appendBackupPosition<T extends RosterHelperPlayer>(player: T, target: 'D' | 'M' | 'F'): T {
  const backupPositions = player.backup_positions ?? [];
  return backupPositions.some((position) => position.toUpperCase() === target)
    ? player
    : { ...player, backup_positions: [...backupPositions, target] };
}