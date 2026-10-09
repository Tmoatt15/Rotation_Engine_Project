import type { Game, Player, QuotaFeasibilityMetadata, RotationResult } from './models';
import { backupEligiblePlayers, eligiblePlayers } from './positional';
import { canCoverSlot, formationSlots, parseFormation } from './timeline';

export const CORE_TARGET = 0.7;
export const CORE_MIN = 0.7;
export const ROTATIONAL_MIN = 0.5;
export const ROTATIONAL_TARGET_HIGH = 0.6;
export const ROTATIONAL_MAX = 0.7;
export const DEVELOPMENTAL_MIN = 0.4;
export const DEVELOPMENTAL_MAX = 0.5;
export const GK_TARGET = 0.8;
export const HARD_MAXIMUM = 0.8;
export const GK_FIELD_MINIMUM = 0.2;
export const GK_FIELD_MAXIMUM = 0.3;
export const LATE_ARRIVAL_GK_FIELD_MINIMUM = 0.3;
export const LATE_ARRIVAL_GK_FIELD_MAXIMUM = 0.4;

const GROUP_HARD_MINIMUM: Record<string, number> = { core: CORE_MIN, core_a: CORE_MIN, core_b: CORE_MIN, rotational: ROTATIONAL_MIN, developing: DEVELOPMENTAL_MIN, developmental: DEVELOPMENTAL_MIN };

const GROUP_HARD_MAXIMUM: Record<string, number> = {
  core: HARD_MAXIMUM,
  core_a: HARD_MAXIMUM,
  core_b: HARD_MAXIMUM,
  rotational: ROTATIONAL_MAX,
  developing: DEVELOPMENTAL_MAX,
  developmental: DEVELOPMENTAL_MAX,
  rotational_gk: HARD_MAXIMUM,
};

export function maximumFieldBlocksForPlayer(player: Player, totalBlocks: number): number {
  return Math.max(
    1,
    intendedMaximumBlocksForPercentage(totalBlocks, GROUP_HARD_MAXIMUM[player.group] ?? HARD_MAXIMUM),
  );
}

export type GoalkeeperAssignments = { firstHalfGk?: string | null; secondHalfGk?: string | null };

export function fieldCapacityByHalf(player: Player, totalBlocks: number, assignments: GoalkeeperAssignments = {}): [number, number] {
  if (isDedicatedGoalkeeper(player)) return [0, 0];
  const gkFieldMaximum = Math.max(1, intendedMaximumBlocksForPercentage(totalBlocks, GK_FIELD_MAXIMUM));
  if (player.name === assignments.firstHalfGk) return [0, gkFieldMaximum];
  if (player.name === assignments.secondHalfGk) return [gkFieldMaximum, 0];
  const perHalfMaximum = Math.max(1, Math.ceil(maximumFieldBlocksForPlayer(player, totalBlocks) / 2));
  return [perHalfMaximum, perHalfMaximum];
}

type BlockCapacityCheck = {
  totalCapacity: number;
  requiredSlots: number;
  positionCapacity: Record<'D' | 'M' | 'F', number>;
  positionRequired: Record<'D' | 'M' | 'F', number>;
};

type FormationCounts = Record<'D' | 'M' | 'F', number>;

function isDedicatedGoalkeeper(player: Player): boolean {
  return player.general_positions.length > 0 && player.general_positions.every((position) => position.toUpperCase() === 'GK');
}

function formationCountsForName(formationName: string): FormationCounts {
  const formation = formationName.split('-').map(Number);
  return formationName === '2-1-2-1'
    ? { D: 2, M: 3, F: 1 }
    : formationName === '4-2-3-1'
      ? { D: 4, M: 5, F: 1 }
      : formation.length === 2
        ? { D: formation[0] ?? 0, M: 0, F: formation[1] ?? 0 }
        : { D: formation[0] ?? 0, M: formation[1] ?? 0, F: formation[2] ?? 0 };
}

export interface PositionCapacityDeficit {
  position: 'D' | 'M' | 'F';
  candidates: string[];
}

export function positionCapacityCandidates(position: 'D' | 'M' | 'F', roster: Player[], totalBlocks: number, formationName?: string): string[] {
  const alreadyEligible = new Set([
    ...eligiblePlayers(roster, position),
    ...backupEligiblePlayers(roster, position),
  ].map((player) => player.name));
  const formationCounts = formationName ? formationCountsForName(formationName) : null;
  const isLoadBearing = (player: Player): boolean => {
    if (!formationCounts || player.general_positions.length !== 1) return false;
    const primaryGroup = player.general_positions[0]?.toUpperCase();
    if (primaryGroup !== 'D' && primaryGroup !== 'M' && primaryGroup !== 'F') return false;
    if (player.primary_positions.some((candidate) => candidate.toUpperCase() === 'GK')) return false;
    const primaryPlayers = roster.filter((candidate) => candidate.available
      && candidate.general_positions.length === 1
      && candidate.general_positions[0]?.toUpperCase() === primaryGroup
      && !candidate.primary_positions.some((candidatePosition) => candidatePosition.toUpperCase() === 'GK')).length;
    return primaryPlayers <= formationCounts[primaryGroup] + 1;
  };
  return roster
    .filter((player) => player.available
      && !isDedicatedGoalkeeper(player)
      && !alreadyEligible.has(player.name)
      && !player.forbidden_positions.includes(position))
    .sort((left, right) => Number(isLoadBearing(left)) - Number(isLoadBearing(right))
      || maximumFieldBlocksForPlayer(right, totalBlocks) - maximumFieldBlocksForPlayer(left, totalBlocks)
      || left.name.localeCompare(right.name))
    .map((player) => player.name);
}

export function positionCapacityWarnings(formationName: string, roster: Player[]): string[] {
  const formationCounts = formationCountsForName(formationName);
  const warnings: string[] = [];
  for (const position of ['D', 'M', 'F'] as const) {
    if (!formationCounts[position]) continue;
    const eligible = [...new Map([
      ...eligiblePlayers(roster, position),
      ...backupEligiblePlayers(roster, position),
    ].map((player) => [player.name, player] as const)).values()];
    const available = eligible.filter((player) => player.available && !player.forbidden_positions.includes(position));
    if (available.length < formationCounts[position]) warnings.push(`Preflight: only ${available.length} available ${position} players can cover ${formationCounts[position]} ${position} slots.`);
    for (const slot of formationSlots(parseFormation(formationName))[position]) {
      if (!available.some((player) => canCoverSlot(player, slot, position))) warnings.push(`Preflight: no available ${position} player can cover exact slot ${slot}.`);
    }
  }
  return warnings;
}

export function positionCapacityDeficits(formationName: string, roster: Player[], totalBlocks: number, assignments: GoalkeeperAssignments = {}): PositionCapacityDeficit[] {
  const formationCounts = formationCountsForName(formationName);
  const halfBlocks = [Math.ceil(totalBlocks / 2), Math.floor(totalBlocks / 2)];
  const positionCapacity = (position: 'D' | 'M' | 'F', half: 0 | 1): number => {
    const candidates = new Map([
      ...eligiblePlayers(roster, position),
      ...backupEligiblePlayers(roster, position),
    ].map((player) => [player.name, player] as const));
    return [...candidates.values()]
      .filter((player) => player.available && !player.forbidden_positions.includes(position))
      .reduce((total, player) => total + fieldCapacityByHalf(player, totalBlocks, assignments)[half], 0);
  };
  return (['D', 'M', 'F'] as const)
    .filter((position) => formationCounts[position] > 0 && halfBlocks.some((blocks, half) => positionCapacity(position, half as 0 | 1) < formationCounts[position] * blocks))
    .map((position) => {
      return { position, candidates: positionCapacityCandidates(position, roster, totalBlocks, formationName) };
    });
}

function blockCapacityCheck(
  formationCounts: Record<'D' | 'M' | 'F', number>,
  roster: Player[],
  totalBlocks: number,
  quotaExemptPlayers = new Set<string>(),
): BlockCapacityCheck {
  const fieldPlayers = roster.filter((player) => player.available && !isDedicatedGoalkeeper(player));
  const capacityFor = (player: Player): number => {
    if (quotaExemptPlayers.has(player.name)) return totalBlocks;
    return maximumFieldBlocksForPlayer(player, totalBlocks);
  };
  const positionCapacity = (['D', 'M', 'F'] as const).reduce((result, position) => {
    const candidates = new Map([
      ...eligiblePlayers(roster, position),
      ...backupEligiblePlayers(roster, position),
    ].map((player) => [player.name, player] as const));
    result[position] = [...candidates.values()]
      .filter((player) => fieldPlayers.some((candidate) => candidate.name === player.name))
      .reduce((total, player) => total + capacityFor(player), 0);
    return result;
  }, {} as Record<'D' | 'M' | 'F', number>);
  const positionRequired = (['D', 'M', 'F'] as const).reduce((result, position) => {
    result[position] = formationCounts[position] * totalBlocks;
    return result;
  }, {} as Record<'D' | 'M' | 'F', number>);
  return {
    totalCapacity: fieldPlayers.reduce((total, player) => total + capacityFor(player), 0),
    requiredSlots: Object.values(positionRequired).reduce((total, value) => total + value, 0),
    positionCapacity,
    positionRequired,
  };
}

export function calculateQuotaFeasibility(
  formation: Record<'D' | 'M' | 'F', number>,
  roster: Player[],
  totalBlocks: number,
): QuotaFeasibilityMetadata {
  const fieldSlots = totalBlocks * (formation.D + formation.M + formation.F);
  const minimumFor = (player: Player) => ['core', 'core_a', 'core_b'].includes(player.group)
    ? minimumBlocksForPercentage(totalBlocks, CORE_MIN)
    : minimumBlocksForPercentage(totalBlocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  const groupMinimums = (['D', 'M', 'F'] as const).map((position) => {
    const minimum = roster.filter((player) => !isDedicatedGoalkeeper(player)
      && player.general_positions.includes(position)
      && !player.general_positions.includes('ANY'))
      .reduce((total, player) => total + minimumFor(player), 0);
    return { position, minimum, capacity: formation[position] * totalBlocks };
  });
  const flexibleMinimum = roster.filter((player) => !isDedicatedGoalkeeper(player) && player.general_positions.includes('ANY'))
    .reduce((total, player) => total + minimumFor(player), 0);
  const remainingCapacity = groupMinimums.reduce((total, item) => total + Math.max(0, item.capacity - item.minimum), 0);
  const minimumsFeasible = groupMinimums.every(({ minimum, capacity }) => minimum <= capacity)
    && flexibleMinimum <= remainingCapacity
    && groupMinimums.reduce((total, item) => total + item.minimum, 0) + flexibleMinimum <= fieldSlots;
  const totalMinimumRequirement = groupMinimums.reduce((total, item) => total + item.minimum, 0) + flexibleMinimum;
  const affectedGroups = groupMinimums.filter(({ minimum, capacity }) => minimum > capacity).map(({ position }) => position);
  return {
    minimumRequirement: totalMinimumRequirement,
    legalAvailableCapacity: fieldSlots,
    minimumsFeasible,
    affectedPlayers: roster.filter((player) => player.general_positions.some((position) => affectedGroups.includes(position as 'D' | 'M' | 'F'))).map((player) => player.name).sort((left, right) => left.localeCompare(right)),
    affectedGroups: [...new Set(affectedGroups)],
  };
}

function addCapacityRecommendations(
  result: RotationResult,
  game: Game,
  roster: Player[],
  formationCounts: Record<'D' | 'M' | 'F', number>,
): void {
  const requested = blockCapacityCheck(formationCounts, roster, game.total_blocks, game.quota_exempt_players);
  const supports = (check: BlockCapacityCheck): boolean => check.totalCapacity >= check.requiredSlots
    && (['D', 'M', 'F'] as const).every((position) => check.positionCapacity[position] >= check.positionRequired[position]);
  const lowerBlockCount = Array.from({ length: Math.max(0, game.total_blocks - 1) }, (_, index) => game.total_blocks - index - 1)
    .filter((blocks) => blocks % 2 === 0)
    .find((blocks) => {
      const check = blockCapacityCheck(formationCounts, roster, blocks, game.quota_exempt_players);
      return check.totalCapacity >= check.requiredSlots;
    });
  const describePositionDeficits = (check: BlockCapacityCheck): void => {
    for (const position of ['D', 'M', 'F'] as const) {
      if (!formationCounts[position] || check.positionCapacity[position] >= check.positionRequired[position]) continue;
      const candidates = new Map([
        ...eligiblePlayers(roster, position),
        ...backupEligiblePlayers(roster, position),
      ].map((player) => [player.name, player] as const));
      const additionalCandidates = roster.filter((player) => player.available
        && !isDedicatedGoalkeeper(player)
        && !candidates.has(player.name)
        && player.general_positions.some((value) => ['D', 'M', 'F'].includes(value)));
      if (additionalCandidates.length) {
        result.warnings.push(`Preflight: assign backup ${position} eligibility to existing field players to cover the ${position} capacity shortfall.`);
      } else {
        result.errors.push(`Preflight: the roster cannot legally cover ${position} for ${check.positionRequired[position]} player-blocks at ${check.positionRequired[position] / formationCounts[position]} blocks.`);
      }
    }
  };

  if (supports(requested)) return;
  if (lowerBlockCount !== undefined) {
    result.warnings.push(`Preflight: this roster cannot legally support ${game.total_blocks} blocks; reduce the game to ${lowerBlockCount} blocks.`);
    describePositionDeficits(blockCapacityCheck(formationCounts, roster, lowerBlockCount, game.quota_exempt_players));
    return;
  }
  result.errors.push(`Preflight: this roster cannot legally support any even block count for the requested ${game.formation} formation.`);
}

export function rotatingHighNames(game: Game, players: Player[], group: string): Set<string> {
  const names = players.map((player) => player.name).sort((a, b) => a.localeCompare(b));
  const count = Math.floor(names.length / 2);
  const offset = ((game.season_game_number - 1) * count) % (names.length || 1);
  return new Set(Array.from({ length: count }, (_, index) => names[(offset + index) % names.length]));
}

function boundedBlocks(value: number, totalBlocks: number): number {
  return Math.max(0, Math.min(totalBlocks, value));
}

/** Round a minimum up so a player never receives less than the percentage floor. */
export function minimumBlocksForPercentage(totalBlocks: number, percentage: number): number {
  return boundedBlocks(Math.ceil(totalBlocks * percentage), totalBlocks);
}

/** Round an intended maximum down; hard limits apply this after minimum guards. */
export function intendedMaximumBlocksForPercentage(totalBlocks: number, percentage: number): number {
  return boundedBlocks(Math.floor(totalBlocks * percentage), totalBlocks);
}

/** Round targets to the nearest integer, with exact halves rounded up. */
export function targetBlocksForPercentage(totalBlocks: number, percentage: number): number {
  return boundedBlocks(Math.floor(totalBlocks * percentage + 0.5), totalBlocks);
}

/** Backward-compatible alias for callers that previously requested rounded targets. */
export function blocksForPercentage(totalBlocks: number, percentage: number, minimum = 1): number {
  return Math.max(minimum, targetBlocksForPercentage(totalBlocks, percentage));
}

export function applyBlockLimits(player: Player, totalBlocks: number, lateArrivalRegen = false): void {
  player.hard_minimum_blocks = minimumBlocksForPercentage(totalBlocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  player.hard_maximum_blocks = maximumFieldBlocksForPlayer(player, totalBlocks);
  player.max_blocks_per_half = isDedicatedGoalkeeper(player)
    ? Math.max(1, Math.ceil(totalBlocks / 2))
    : Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
  player.gk_field_minimum_blocks = minimumBlocksForPercentage(totalBlocks, lateArrivalRegen ? LATE_ARRIVAL_GK_FIELD_MINIMUM : GK_FIELD_MINIMUM);
  player.gk_field_maximum_blocks = Math.max(
    player.gk_field_minimum_blocks,
    intendedMaximumBlocksForPercentage(totalBlocks, lateArrivalRegen ? LATE_ARRIVAL_GK_FIELD_MAXIMUM : GK_FIELD_MAXIMUM),
  );
}

function applyMaximumOverride(player: Player, totalBlocks: number): void {
  player.hard_maximum_blocks = totalBlocks;
  player.max_blocks_per_half = totalBlocks;
  player.gk_field_maximum_blocks = totalBlocks;
}

export function computeBlockTargets(game: Game, roster: Player[]): RotationResult {
  const result: RotationResult = { timeline: [], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, method: 'percentage-based quotas' } };
  const rotationalHigh = rotatingHighNames(game, roster.filter((player) => player.group === 'rotational' && !isDedicatedGoalkeeper(player)), 'rotational');
  const developingHigh = rotatingHighNames(game, roster.filter((player) => ['developing', 'developmental'].includes(player.group)), 'developing');
  const formationCounts = formationCountsForName(game.formation);
  const quotaFeasibility = calculateQuotaFeasibility(formationCounts, roster, game.total_blocks);
  const minimumFor = (player: Player) => ['core', 'core_a', 'core_b'].includes(player.group)
    ? minimumBlocksForPercentage(game.total_blocks, CORE_MIN)
    : minimumBlocksForPercentage(game.total_blocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  const warningMinimums = (['D', 'M', 'F'] as const).map((position) => {
    const minimum = roster
      .filter((player) => !isDedicatedGoalkeeper(player) && !game.quota_exempt_players.has(player.name))
      .filter((player) => {
        const positions = (['D', 'M', 'F'] as const).filter((candidatePosition) => new Map([
          ...eligiblePlayers(roster, candidatePosition),
          ...backupEligiblePlayers(roster, candidatePosition),
        ].map((candidate) => [candidate.name, candidate] as const)).has(player.name));
        return positions.length === 1 && positions[0] === position;
      })
      .reduce((total, player) => total + minimumFor(player), 0);
    return { position, minimum, capacity: formationCounts[position] * game.total_blocks };
  });
  game.core_high_names = [];
  let requestedFieldSlots = 0;
  for (const player of roster) {
    let target = 0; let minimum = 0; let maximum = 0;
    if (['core', 'core_a', 'core_b'].includes(player.group)) { minimum = minimumBlocksForPercentage(game.total_blocks, CORE_MIN); target = Math.max(minimum, targetBlocksForPercentage(game.total_blocks, CORE_TARGET)); maximum = target; }
    else if (isDedicatedGoalkeeper(player)) { target = targetBlocksForPercentage(game.total_blocks, GK_TARGET); minimum = maximum = target; }
    else if (player.group === 'rotational') { minimum = minimumBlocksForPercentage(game.total_blocks, ROTATIONAL_MIN); maximum = Math.max(minimum, intendedMaximumBlocksForPercentage(game.total_blocks, ROTATIONAL_MAX)); target = rotationalHigh.has(player.name) ? targetBlocksForPercentage(game.total_blocks, ROTATIONAL_TARGET_HIGH) : minimum; }
    else if (['developing', 'developmental'].includes(player.group)) { minimum = minimumBlocksForPercentage(game.total_blocks, DEVELOPMENTAL_MIN); maximum = Math.max(minimum, intendedMaximumBlocksForPercentage(game.total_blocks, DEVELOPMENTAL_MAX)); target = developingHigh.has(player.name) ? maximum : minimum; }
    else { result.errors.push(`Unknown group for player ${player.name}`); }
    if (game.quota_exempt_players.has(player.name)) { target = 0; minimum = 0; maximum = game.total_blocks; }
    player.target_blocks = target; player.minimum_blocks = minimum; player.maximum_blocks = game.quota_exempt_players.has(player.name) ? game.total_blocks : maximum + (game.replacement_bonuses[player.name] ?? 0);
    applyBlockLimits(player, game.total_blocks, game.is_late_arrival_regen);
    if (game.disable_maximum_limits) applyMaximumOverride(player, game.total_blocks);
    if (game.quota_exempt_players.has(player.name)) { player.hard_minimum_blocks = 0; player.hard_maximum_blocks = game.total_blocks; player.gk_field_minimum_blocks = 0; player.gk_field_maximum_blocks = game.total_blocks; }
    else player.hard_maximum_blocks = Math.min(game.total_blocks, player.hard_maximum_blocks + (game.replacement_bonuses[player.name] ?? 0));
    player.max_blocks_per_half = game.disable_maximum_limits
      ? game.total_blocks
      : isDedicatedGoalkeeper(player)
        ? Math.max(1, Math.ceil(game.total_blocks / 2))
        : Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
    result.block_counts[player.name] = target;
    if (!isDedicatedGoalkeeper(player) && player.group !== 'rotational_gk') requestedFieldSlots += target;
  }
  result.metadata.quota_feasibility = quotaFeasibility;
  const rosterMinimumRequirement = roster
    .filter((player) => !isDedicatedGoalkeeper(player) && !game.quota_exempt_players.has(player.name))
    .reduce((total, player) => total + minimumFor(player), 0);
  if (rosterMinimumRequirement > quotaFeasibility.legalAvailableCapacity) {
    result.warnings.push(`Below minimum (capacity): minimums require ${rosterMinimumRequirement} player-blocks, but only ${quotaFeasibility.legalAvailableCapacity} are available; shortfall will be distributed fairly.`);
  }
  const fieldSlots = quotaFeasibility.legalAvailableCapacity;
  if (requestedFieldSlots > fieldSlots) result.warnings.push(`Requested field targets require ${requestedFieldSlots} slots, but the formation provides ${fieldSlots}; targets cannot all be met.`);
  for (const position of ['D', 'M', 'F'] as const) {
    const slots = formationCounts[position] * game.total_blocks;
    if (!slots) continue;
    const minimumBlocks = warningMinimums.find((item) => item.position === position)?.minimum ?? 0;
    if (minimumBlocks > slots) result.warnings.push(`${position} minimums require ${minimumBlocks} player-blocks, but the formation provides ${slots}; some ${position} players must finish below minimum.`);

  }
  result.warnings.push(...positionCapacityWarnings(game.formation, roster));
  if (!game.disable_maximum_limits) addCapacityRecommendations(result, game, roster, formationCounts);
  return result;
}
