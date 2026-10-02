import type { Player, PositionGroup } from './models';

export const PRIMARY_POSITIONS: Record<PositionGroup, string[]> = { GK: ['GK'], D: ['D'], M: ['M'], F: ['F'] };
export const DEVELOPMENTAL_MAX_BLOCKS = 4;
export const GK_MAX_BLOCKS = 5;
export const ROTATIONAL_GK_FIELD_BLOCKS = 3;
export const GK_CAN_PLAY_FIELD = false;
export const ANY_POSITION = 'ANY';

export const POSITION_GROUP_BY_SLOT: Record<string, PositionGroup> = {
  LF: 'F', CF: 'F', RF: 'F', LW: 'F', LS: 'F', RS: 'F', RW: 'F', ST: 'F',
  LM: 'M', LCM: 'M', CM: 'M', RCM: 'M', RM: 'M', LAM: 'M', CAM: 'M', RAM: 'M', LDM: 'M', CDM: 'M', RDM: 'M',
  LB: 'D', LCB: 'D', CB: 'D', RCB: 'D', RB: 'D', LWB: 'D', RWB: 'D',
};

export const CENTRAL_MIDFIELD_ZONE = new Set(['LCM', 'CM', 'RCM', 'CDM', 'CAM']);
export const CENTRAL_DEFENSE_ZONE = new Set(['LCB', 'CB', 'RCB']);
export const STRIKER_ZONE = new Set(['ST', 'CF']);

const blockedSlotsCache = new WeakMap<readonly string[], Set<string>>();

function blockedSlotsFor(forbiddenPositions: readonly string[]): Set<string> {
  const cached = blockedSlotsCache.get(forbiddenPositions);
  if (cached) return cached;
  const forbidden = new Set(forbiddenPositions.map((entry) => entry.trim().toUpperCase()));
  const blocked = new Set(forbidden);
  for (const [slot, group] of Object.entries(POSITION_GROUP_BY_SLOT)) {
    if (forbidden.has(group)) blocked.add(slot);
  }
  for (const zone of [CENTRAL_MIDFIELD_ZONE, CENTRAL_DEFENSE_ZONE, STRIKER_ZONE]) {
    if ([...zone].some((slot) => forbidden.has(slot))) zone.forEach((slot) => blocked.add(slot));
  }
  blockedSlotsCache.set(forbiddenPositions, blocked);
  return blocked;
}

export function exclusionBlocksSlot(forbiddenPositions: string[], slot: string): boolean {
  const target = slot.trim().toUpperCase();
  return blockedSlotsFor(forbiddenPositions).has(target);
}

export function generalPositionAllowsGroup(player: Pick<Player, 'general_positions'>, group: PositionGroup): boolean {
  if (group === 'GK') return false;
  return player.general_positions.some((position) => {
    const normalized = position.toUpperCase();
    return normalized === ANY_POSITION || normalized === group;
  });
}

export function backupCoversPosition(player: Player, position: string): boolean {
  const requested = position.trim().toUpperCase();
  const group = POSITION_GROUP_BY_SLOT[requested] ?? requested;
  const requestedIsGroup = ['D', 'M', 'F', 'GK'].includes(requested);
  return player.backup_positions.some((backup) => {
    const value = backup.trim().toUpperCase();
    return value === requested
      || value === ANY_POSITION
      || (requestedIsGroup
        ? POSITION_GROUP_BY_SLOT[value] === requested
        : ['D', 'M', 'F'].includes(value) && value === group);
  });
}

export function positionalPriority(player: Player, position: PositionGroup): number {
  const requested = position.toUpperCase();
  if (player.forbidden_positions.map((value) => value.toUpperCase()).includes(requested)) return 3;
  if (player.primary_positions.some((value) => {
    const normalized = value.trim().toUpperCase();
    return normalized === requested || POSITION_GROUP_BY_SLOT[normalized] === requested;
  })) return 0;
  if (player.general_positions.some((value) => value.toUpperCase() === requested || (value.toUpperCase() === ANY_POSITION && requested !== 'GK'))) return 1;
  if (backupCoversPosition(player, requested)) return 2;
  return 3;
}

export function eligiblePlayers(roster: Player[], position: PositionGroup): Player[] {
  return roster.filter((player) => {
    if (!player.available || player.forbidden_positions.map((value) => value.toUpperCase()).includes(position)) return false;
    if (player.backup_positions.some((value) => value.toUpperCase() === position)) return false;
    if (player.general_positions.some((value) => value.toUpperCase() === position || (value.toUpperCase() === ANY_POSITION && position !== 'GK'))) return true;
    return false;
  });
}

export function backupEligiblePlayers(roster: Player[], position: string): Player[] {
  const requested = position.trim().toUpperCase();
  return roster.filter((player) => player.available
    && !player.forbidden_positions.some((value) => value.trim().toUpperCase() === requested)
    && backupCoversPosition(player, requested));
}
