import type { Game, Player, QuotaFeasibilityMetadata, RotationResult } from './models';
import { backupEligiblePlayers, eligiblePlayers } from './positional';
import { canCoverSlot, formationSlots, parseFormation } from './timeline';

export const CORE_TARGET = 0.7;
export const CORE_MIN = 0.7;
export const ROTATIONAL_MIN = 0.5;
export const ROTATIONAL_MAX = 0.7;
export const DEVELOPMENTAL_MIN = 0.4;
export const DEVELOPMENTAL_MAX = 0.5;
export const GK_TARGET = 0.8;
export const HARD_MAXIMUM = 0.8;
export const GK_FIELD_MINIMUM = 0.2;
export const GK_FIELD_MAXIMUM = 0.3;

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

type BlockCapacityCheck = {
  totalCapacity: number;
  requiredSlots: number;
  positionCapacity: Record<'D' | 'M' | 'F', number>;
  positionRequired: Record<'D' | 'M' | 'F', number>;
};

function isDedicatedGoalkeeper(player: Player): boolean {
  return player.general_positions.some((position) => position.toUpperCase() === 'GK');
}

export function positionCapacityWarnings(formationName: string, roster: Player[]): string[] {
  const formation = formationName.split('-').map(Number);
  const formationCounts: Record<'D' | 'M' | 'F', number> = formationName === '2-1-2-1'
    ? { D: 2, M: 3, F: 1 }
    : formationName === '4-2-3-1'
      ? { D: 4, M: 5, F: 1 }
      : formation.length === 2
        ? { D: formation[0] ?? 0, M: 0, F: formation[1] ?? 0 }
        : { D: formation[0] ?? 0, M: formation[1] ?? 0, F: formation[2] ?? 0 };
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

export function applyBlockLimits(player: Player, totalBlocks: number): void {
  player.hard_minimum_blocks = minimumBlocksForPercentage(totalBlocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  player.hard_maximum_blocks = maximumFieldBlocksForPlayer(player, totalBlocks);
  player.max_blocks_per_half = Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
  player.gk_field_minimum_blocks = minimumBlocksForPercentage(totalBlocks, GK_FIELD_MINIMUM);
  player.gk_field_maximum_blocks = Math.max(
    player.gk_field_minimum_blocks,
    intendedMaximumBlocksForPercentage(totalBlocks, GK_FIELD_MAXIMUM),
  );
}

function applyMaximumOverride(player: Player, totalBlocks: number): void {
  player.hard_maximum_blocks = totalBlocks;
  player.max_blocks_per_half = totalBlocks;
  player.gk_field_maximum_blocks = totalBlocks;
}

export function computeBlockTargets(game: Game, roster: Player[]): RotationResult {
  const result: RotationResult = { timeline: [], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, method: 'percentage-based quotas' } };
  const core = roster.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group));
  const rotationalHigh = rotatingHighNames(game, roster.filter((player) => player.group === 'rotational' && !isDedicatedGoalkeeper(player)), 'rotational');
  const developingHigh = rotatingHighNames(game, roster.filter((player) => ['developing', 'developmental'].includes(player.group)), 'developing');
  const formation = game.formation.split('-').map(Number);
  const fieldSlots = formation.every(Number.isFinite) ? game.total_blocks * formation.reduce((sum, value) => sum + value, 0) : 0;
  const formationCounts: Record<'D' | 'M' | 'F', number> = game.formation === '2-1-2-1'
    ? { D: 2, M: 3, F: 1 }
    : game.formation === '4-2-3-1'
      ? { D: 4, M: 5, F: 1 }
      : formation.length === 2
        ? { D: formation[0] ?? 0, M: 0, F: formation[1] ?? 0 }
        : { D: formation[0] ?? 0, M: formation[1] ?? 0, F: formation[2] ?? 0 };
  const minimumFor = (player: Player) => ['core', 'core_a', 'core_b'].includes(player.group)
    ? minimumBlocksForPercentage(game.total_blocks, CORE_MIN)
    : minimumBlocksForPercentage(game.total_blocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  const groupMinimums = (['D', 'M', 'F'] as const).map((position) => {
    const minimum = roster.filter((player) => !isDedicatedGoalkeeper(player)
      && player.general_positions.includes(position)
      && !player.general_positions.includes('ANY'))
      .reduce((total, player) => total + minimumFor(player), 0);
    return { position, minimum, capacity: formationCounts[position] * game.total_blocks };
  });
  const flexibleMinimum = roster.filter((player) => !isDedicatedGoalkeeper(player) && player.general_positions.includes('ANY'))
    .reduce((total, player) => total + minimumFor(player), 0);
  const remainingCapacity = groupMinimums.reduce((total, item) => total + Math.max(0, item.capacity - item.minimum), 0);
  const minimumsFeasible = groupMinimums.every(({ minimum, capacity }) => minimum <= capacity)
    && flexibleMinimum <= remainingCapacity
    && groupMinimums.reduce((total, item) => total + item.minimum, 0) + flexibleMinimum <= fieldSlots;
  const totalMinimumRequirement = groupMinimums.reduce((total, item) => total + item.minimum, 0) + flexibleMinimum;
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
    else if (player.group === 'rotational') { minimum = minimumBlocksForPercentage(game.total_blocks, ROTATIONAL_MIN); maximum = Math.max(minimum, intendedMaximumBlocksForPercentage(game.total_blocks, ROTATIONAL_MAX)); target = rotationalHigh.has(player.name) ? maximum : minimum; }
    else if (['developing', 'developmental'].includes(player.group)) { minimum = minimumBlocksForPercentage(game.total_blocks, DEVELOPMENTAL_MIN); maximum = Math.max(minimum, intendedMaximumBlocksForPercentage(game.total_blocks, DEVELOPMENTAL_MAX)); target = developingHigh.has(player.name) ? maximum : minimum; }
    else { result.errors.push(`Unknown group for player ${player.name}`); }
    if (game.quota_exempt_players.has(player.name)) { target = 0; minimum = 0; maximum = game.total_blocks; }
    player.target_blocks = target; player.minimum_blocks = minimum; player.maximum_blocks = game.quota_exempt_players.has(player.name) ? game.total_blocks : maximum + (game.replacement_bonuses[player.name] ?? 0);
    applyBlockLimits(player, game.total_blocks);
    if (game.disable_maximum_limits) applyMaximumOverride(player, game.total_blocks);
    if (game.quota_exempt_players.has(player.name)) { player.hard_minimum_blocks = 0; player.hard_maximum_blocks = game.total_blocks; player.gk_field_minimum_blocks = 0; player.gk_field_maximum_blocks = game.total_blocks; }
    else player.hard_maximum_blocks = Math.min(game.total_blocks, player.hard_maximum_blocks + (game.replacement_bonuses[player.name] ?? 0));
    player.max_blocks_per_half = game.disable_maximum_limits ? game.total_blocks : Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
    result.block_counts[player.name] = target;
    if (!isDedicatedGoalkeeper(player) && player.group !== 'rotational_gk') requestedFieldSlots += target;
  }
  const affectedGroups = groupMinimums.filter(({ minimum, capacity }) => minimum > capacity).map(({ position }) => position);
  const affectedPlayers = roster
    .filter((player) => {
      return player.general_positions.some((position) => affectedGroups.includes(position));
    })
    .map((player) => player.name)
    .sort((left, right) => left.localeCompare(right));
  const quotaFeasibility: QuotaFeasibilityMetadata = {
    minimumRequirement: totalMinimumRequirement,
    legalAvailableCapacity: fieldSlots,
    minimumsFeasible,
    affectedPlayers,
    affectedGroups: [...new Set(affectedGroups)],
  };
  result.metadata.quota_feasibility = quotaFeasibility;
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
