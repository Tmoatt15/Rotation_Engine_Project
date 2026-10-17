export type PositionGroup = 'D' | 'M' | 'F';

export interface PositionGapPlayer {
  name: string;
  primary_positions?: string[];
  general_positions?: string[];
  backup_positions?: string[];
  available?: boolean;
  keeper?: boolean;
}

export interface PositionGapSuggestion {
  player: string;
  position: PositionGroup;
  proximity: PositionGroup[];
  hasBackup: boolean;
}

export interface PositionGap {
  position: PositionGroup;
  required: number;
  eligible: number;
  kind: 'hard' | 'soft';
  suggestions: PositionGapSuggestion[];
}

const formationCounts = (formation: string): Record<PositionGroup, number> => {
  const parts = formation.split('-').map(Number);
  if (formation === '4-2-3-1') return { D: 4, M: 5, F: 1 };
  if (formation === '2-1-2-1') return { D: 2, M: 3, F: 1 };
  return { D: parts[0] ?? 0, M: parts[1] ?? 0, F: parts[2] ?? 0 };
};

const groupsFor = (player: PositionGapPlayer): Set<PositionGroup> => {
  const general = (player.general_positions ?? []).map((position) => position.toUpperCase());
  const primary = (player.primary_positions ?? []).map((position) => position.toUpperCase());
  const backup = (player.backup_positions ?? []).map((position) => position.toUpperCase());
  return new Set((['D', 'M', 'F'] as const).filter((group) => (
    general.includes(group)
    || primary.includes(group)
    || backup.includes(group)
  )));
};

const proximityFor = (position: PositionGroup): PositionGroup[] => {
  if (position === 'D') return ['M', 'F'];
  if (position === 'F') return ['M', 'D'];
  return ['D', 'F'];
};

export function findPositionGaps(
  formation: string,
  players: PositionGapPlayer[],
): PositionGap[] {
  const required = formationCounts(formation);
  return (['D', 'M', 'F'] as const).flatMap((position) => {
    if (!required[position]) return [];
    const eligiblePlayers = players.filter((player) => player.available !== false && !player.keeper && groupsFor(player).has(position));
    if (eligiblePlayers.length > required[position]) return [];
    const proximity = proximityFor(position);
    const suggestions = players
      .filter((player) => player.available !== false && !player.keeper && !groupsFor(player).has(position))
      .map((player) => {
        const groups = groupsFor(player);
        return {
          player: player.name,
          position,
          proximity,
          hasBackup: (player.backup_positions ?? []).length > 0,
          proximityRank: proximity.findIndex((group) => groups.has(group)),
        };
      })
      .filter((candidate) => candidate.proximityRank >= 0)
      .sort((left, right) => Number(left.hasBackup) - Number(right.hasBackup)
        || left.proximityRank - right.proximityRank
        || left.player.localeCompare(right.player))
      .map(({ player, position: candidatePosition, proximity: candidateProximity, hasBackup }) => ({
        player,
        position: candidatePosition,
        proximity: candidateProximity,
        hasBackup,
      }));
    return [{
      position,
      required: required[position],
      eligible: eligiblePlayers.length,
      kind: eligiblePlayers.length < required[position] ? 'hard' : 'soft',
      suggestions,
    }];
  });
}
