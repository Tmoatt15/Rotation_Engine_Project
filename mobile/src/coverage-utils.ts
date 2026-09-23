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
  if (group === 'F') return normalized === 'F' || normalized.startsWith('F') || ['CF', 'LW', 'RW'].includes(normalized);
  if (group === 'M') return normalized === 'M' || normalized.startsWith('M') || ['CM', 'CDM', 'CAM', 'LAM', 'RAM', 'LDM', 'RDM'].includes(normalized);
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