import type { Player, PositionGroup } from './models';

export const PRIMARY_POSITIONS: Record<PositionGroup, string[]> = { GK: ['GK'], D: ['D'], M: ['M'], F: ['F'] };
export const EMERGENCY_POSITIONS: Record<PositionGroup, string[]> = { GK: [], D: ['F'], M: [], F: ['D'] };
export const DEVELOPMENTAL_MAX_BLOCKS = 4;
export const GK_MAX_BLOCKS = 5;
export const ROTATIONAL_GK_FIELD_BLOCKS = 3;
export const GK_CAN_PLAY_FIELD = false;
export const ANY_POSITION = 'ANY';

export function positionalTiersFor(position: PositionGroup): [string[], string[], string[]] {
  return [PRIMARY_POSITIONS[position] ?? [], [], EMERGENCY_POSITIONS[position] ?? []];
}

export function isEmergencyAllowed(player: Player): boolean {
  return !['developing', 'developmental'].includes(player.group);
}

export const POSITION_GROUP_BY_SLOT: Record<string, PositionGroup> = {
  LF: 'F', CF: 'F', RF: 'F', LW: 'F', LS: 'F', RS: 'F', RW: 'F', ST: 'F',
  LM: 'M', LCM: 'M', CM: 'M', RCM: 'M', RM: 'M', LAM: 'M', CAM: 'M', RAM: 'M', LDM: 'M', CDM: 'M', RDM: 'M',
  LB: 'D', LCB: 'D', CB: 'D', RCB: 'D', RB: 'D', LWB: 'D', RWB: 'D',
};

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
  return player.backup_positions.some((backup) => {
    const value = backup.trim().toUpperCase();
    return value === requested || value === ANY_POSITION || (['D', 'M', 'F'].includes(value) && value === group);
  });
}

export function positionalPriority(player: Player, position: PositionGroup, allowEmergency = false): number {
  const requested = position.toUpperCase();
  if (player.forbidden_positions.map((value) => value.toUpperCase()).includes(requested)) return 3;
  if (player.general_positions.some((value) => value.toUpperCase() === requested || (value.toUpperCase() === ANY_POSITION && requested !== 'GK'))) return 0;
  if (backupCoversPosition(player, requested)) return 2;
  if (allowEmergency && player.primary_positions.some((value) => EMERGENCY_POSITIONS[position]?.includes(value.toUpperCase())) && isEmergencyAllowed(player)) return 3;
  return 3;
}

export function eligiblePlayers(roster: Player[], position: PositionGroup, allowEmergency = false): Player[] {
  return roster.filter((player) => {
    if (!player.available || player.forbidden_positions.map((value) => value.toUpperCase()).includes(position)) return false;
    if (player.backup_positions.some((value) => value.toUpperCase() === position)) return false;
    if (player.general_positions.some((value) => value.toUpperCase() === position || (value.toUpperCase() === ANY_POSITION && position !== 'GK'))) return true;
    return allowEmergency && player.primary_positions.some((value) => EMERGENCY_POSITIONS[position]?.includes(value.toUpperCase())) && isEmergencyAllowed(player);
  });
}

export function backupEligiblePlayers(roster: Player[], position: string): Player[] {
  return roster.filter((player) => player.available && !player.forbidden_positions.includes(position) && backupCoversPosition(player, position));
}

export function emergencyEligiblePlayers(roster: Player[], position: PositionGroup): Player[] {
  return roster.filter((player) => {
    if (!player.available || player.forbidden_positions.includes(position) || backupCoversPosition(player, position)) return false;
    return player.general_positions.some((value) => EMERGENCY_POSITIONS[position]?.includes(value.toUpperCase())) && isEmergencyAllowed(player);
  });
}
