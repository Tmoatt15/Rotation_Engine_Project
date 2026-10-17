export const NONE_POSITION = 'NONE';
const FIELD_GROUPS = new Set(['D', 'M', 'F']);

export type GeneralGroupOffender = {
  player: string;
  reason: 'needs-group' | 'multiple-groups';
};

type GeneralGroupInput = {
  name: string;
  general_positions?: readonly string[];
  primary_positions?: readonly string[];
  keeper_eligible?: boolean;
  keeper?: boolean;
};

export function isDedicatedKeeper(keeperEligible: boolean, generalPositions: readonly string[]): boolean {
  return keeperEligible
    && generalPositions.every((position) => position.toUpperCase() === NONE_POSITION || position.toUpperCase() === 'GK');
}

export function validateGeneralGroups(players: readonly GeneralGroupInput[]): GeneralGroupOffender[] {
  const offenders: GeneralGroupOffender[] = [];
  for (const player of players) {
    const generalPositions = (player.general_positions ?? []).map((position) => position.trim().toUpperCase()).filter(Boolean);
    const groups = new Set(generalPositions.filter((position) => FIELD_GROUPS.has(position)));
    const keeperEligible = player.keeper_eligible === true
      || player.keeper === true
      || generalPositions.includes('GK')
      || (player.primary_positions ?? []).some((position) => position.toUpperCase() === 'GK');
    if (isDedicatedKeeper(keeperEligible, generalPositions)) continue;
    if (groups.size > 1 || (groups.size > 0 && generalPositions.includes(NONE_POSITION))) {
      offenders.push({ player: player.name, reason: 'multiple-groups' });
    } else if (groups.size === 0) {
      offenders.push({ player: player.name, reason: 'needs-group' });
    }
  }
  return offenders;
}

export class GeneralGroupValidationError extends Error {
  constructor(public readonly offenders: GeneralGroupOffender[]) {
    super(`Invalid general position groups: ${offenders.map(({ player, reason }) =>
      `${player} ${reason === 'needs-group' ? 'needs a group' : 'has multiple groups'}`).join('; ')}.`);
    this.name = 'GeneralGroupValidationError';
  }
}
