import type { Game, Player, RotationResult } from './models';

export const CORE_A_TARGET = 0.8;
export const CORE_B_TARGET = 0.7;
export const CORE_MIN = 0.7;
export const ROTATIONAL_MIN = 0.5;
export const ROTATIONAL_MAX = 0.6;
export const DEVELOPMENTAL_MIN = 0.4;
export const DEVELOPMENTAL_MAX = 0.5;
export const GK_TARGET = 0.8;
export const HARD_MAXIMUM = 0.8;
export const GK_FIELD_MINIMUM = 0.2;
export const GK_FIELD_MAXIMUM = 0.3;

const GROUP_HARD_MINIMUM: Record<string, number> = { core: CORE_MIN, core_a: CORE_MIN, core_b: CORE_B_TARGET, rotational: ROTATIONAL_MIN, developing: DEVELOPMENTAL_MIN, developmental: DEVELOPMENTAL_MIN };

function seededValue(seed: number, text: string): number {
  let hash = seed | 0;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function rotatingHighNames(game: Game, players: Player[], group: string): Set<string> {
  const names = players.map((player) => player.name).sort((a, b) => a.localeCompare(b));
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swap = seededValue(game.season_seed, `${group}:${index}`) % (index + 1);
    [names[index], names[swap]] = [names[swap], names[index]];
  }
  const count = Math.floor(names.length / 2);
  const offset = ((game.season_game_number - 1) * count) % (names.length || 1);
  return new Set(Array.from({ length: count }, (_, index) => names[(offset + index) % names.length]));
}

export function blocksForPercentage(totalBlocks: number, percentage: number, minimum = 1): number { return Math.max(minimum, Math.min(totalBlocks, Math.round(totalBlocks * percentage))); }

export function applyBlockLimits(player: Player, totalBlocks: number): void {
  player.hard_minimum_blocks = blocksForPercentage(totalBlocks, GROUP_HARD_MINIMUM[player.group] ?? DEVELOPMENTAL_MIN);
  player.hard_maximum_blocks = blocksForPercentage(totalBlocks, HARD_MAXIMUM);
  player.max_blocks_per_half = Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
  player.gk_field_minimum_blocks = blocksForPercentage(totalBlocks, GK_FIELD_MINIMUM);
  player.gk_field_maximum_blocks = blocksForPercentage(totalBlocks, GK_FIELD_MAXIMUM);
}

export function computeBlockTargets(game: Game, roster: Player[]): RotationResult {
  const result: RotationResult = { timeline: [], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, method: 'percentage-based quotas' } };
  const core = roster.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group));
  let highCore = new Set(game.core_high_names ?? []);
  if (core.length && !highCore.size) {
    highCore = rotatingHighNames({ ...game, season_seed: game.season_seed } as Game, core, 'core');
    game.core_high_names = [...highCore];
  }
  const rotationalHigh = rotatingHighNames(game, roster.filter((player) => player.group === 'rotational' && !player.primary_positions.includes('GK')), 'rotational');
  const developingHigh = rotatingHighNames(game, roster.filter((player) => ['developing', 'developmental'].includes(player.group)), 'developing');
  const formation = game.formation.split('-').map(Number);
  const fieldSlots = formation.every(Number.isFinite) ? game.total_blocks * formation.reduce((sum, value) => sum + value, 0) : 0;
  let requestedFieldSlots = 0;
  for (const player of roster) {
    let target = 0; let minimum = 0; let maximum = 0;
    if (['core', 'core_a', 'core_b'].includes(player.group)) { target = Math.round(game.total_blocks * (highCore.has(player.name) ? CORE_A_TARGET : CORE_B_TARGET)); minimum = Math.round(game.total_blocks * CORE_MIN); maximum = target; }
    else if (player.primary_positions.includes('GK')) { target = Math.round(game.total_blocks * GK_TARGET); minimum = maximum = target; }
    else if (player.group === 'rotational') { minimum = Math.round(game.total_blocks * ROTATIONAL_MIN); maximum = Math.round(game.total_blocks * ROTATIONAL_MAX); target = rotationalHigh.has(player.name) ? maximum : minimum; }
    else if (['developing', 'developmental'].includes(player.group)) { minimum = Math.round(game.total_blocks * DEVELOPMENTAL_MIN); maximum = Math.round(game.total_blocks * DEVELOPMENTAL_MAX); target = developingHigh.has(player.name) ? maximum : minimum; }
    else { result.errors.push(`Unknown group for player ${player.name}`); }
    if (game.quota_exempt_players.has(player.name)) { target = 0; minimum = 0; maximum = game.total_blocks; }
    player.target_blocks = target; player.minimum_blocks = minimum; player.maximum_blocks = game.quota_exempt_players.has(player.name) ? game.total_blocks : maximum + (game.replacement_bonuses[player.name] ?? 0);
    applyBlockLimits(player, game.total_blocks);
    if (game.quota_exempt_players.has(player.name)) { player.hard_minimum_blocks = 0; player.hard_maximum_blocks = game.total_blocks; player.gk_field_minimum_blocks = 0; player.gk_field_maximum_blocks = game.total_blocks; }
    else player.hard_maximum_blocks = Math.min(game.total_blocks, player.hard_maximum_blocks + (game.replacement_bonuses[player.name] ?? 0));
    player.max_blocks_per_half = Math.max(1, Math.ceil(player.hard_maximum_blocks / 2));
    result.block_counts[player.name] = target;
    if (!player.primary_positions.includes('GK') && player.group !== 'rotational_gk') requestedFieldSlots += target;
  }
  if (requestedFieldSlots > fieldSlots) result.warnings.push(`Requested field targets require ${requestedFieldSlots} slots, but the formation provides ${fieldSlots}; targets cannot all be met.`);
  return result;
}
