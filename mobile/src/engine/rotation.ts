import type { AvailabilityChange, Game, GameInput, Player, PlayerInput, RotationResult, ScheduleBlock } from './models';
import { computeBlockTargets } from './quotas';
import { buildTimeline, replayTimeline } from './timeline';
import { computeSurplus } from './surplus';
import { eligiblePlayers } from './positional';

const emptyUsage = () => ({ GK: 0, D: 0, M: 0, F: 0 });

function positionList(value: string | string[] | undefined): string[] {
  return value == null ? [] : (Array.isArray(value) ? value : [value]);
}

export function createPlayer(input: PlayerInput): Player {
  const generalPositions = positionList(input.general_positions ?? input.general_position ?? input.primary_position).map((position) => position.toUpperCase());
  const primaryPositions = positionList(input.primary_positions ?? input.primary_position).map((position) => position.toUpperCase());
  const backupPositions = positionList(input.backup_positions).map((position) => position.toUpperCase());
  const excludedPositions = positionList(input.excluded_positions ?? input.forbidden_positions).map((position) => position.toUpperCase());
  return {
    ...input, group: input.group.toLowerCase() as Player['group'], core_tier: null, general_positions: generalPositions, primary_positions: primaryPositions.length ? primaryPositions : generalPositions, backup_positions: backupPositions, excluded_positions: excludedPositions, general_position: generalPositions[0] ?? '', primary_position: primaryPositions[0] ?? generalPositions[0] ?? '', forbidden_positions: excludedPositions, positional_group: null, available: true, target_blocks: 0, minimum_blocks: 0, maximum_blocks: 0, hard_minimum_blocks: 0, hard_maximum_blocks: 0, max_blocks_per_half: 1, gk_field_minimum_blocks: 0, gk_field_maximum_blocks: 0, blocks_by_half: [0, 0], block_count: 0, bench_count: 0, position_usage: emptyUsage(), gk_blocks: 0, field_blocks: 0, max_gk_blocks: 5, gk_field_targets_by_half: [0, 0], last_two: [],
  };
}

function prepareGame(input: Game | GameInput): Game {
  const game = input as Game;
  return {
    ...game, gk_assignment: game.gk_assignment ?? null, first_half_gk: game.first_half_gk ?? game.gk_assignment ?? null, second_half_gk: game.second_half_gk ?? null, season_total_games: game.season_total_games ?? 1, season_game_number: game.season_game_number ?? 1, season_seed: game.season_seed ?? 2026, allow_emergency_positions: game.allow_emergency_positions ?? false, core_high_names: game.core_high_names ?? null, replacement_credits: game.replacement_credits ?? [], replacement_bonuses: game.replacement_bonuses ?? {}, availability_changes: game.availability_changes ?? [], quota_exempt_players: game.quota_exempt_players ?? new Set<string>(), timeline: game.timeline ?? [],
  };
}

function prepareRoster(roster: Player[]): Player[] { return roster.map((player) => player.position_usage && player.blocks_by_half ? player : createPlayer(player)); }

export function runRotationEngine(gameInput: Game | GameInput, rosterInput: Player[]): RotationResult {
  const game = prepareGame(gameInput); const roster = prepareRoster(rosterInput);
  roster.forEach((player) => { if (!player.position_usage) player.position_usage = emptyUsage(); });
  const quota = computeBlockTargets(game, roster);
  const timeline = buildTimeline(game, roster);
  const surplus = computeSurplus(game, roster);
  return { timeline: timeline.timeline, block_counts: surplus.block_counts, gk_summary: surplus.gk_summary, position_summary: surplus.position_summary, warnings: [...quota.warnings, ...timeline.warnings, ...surplus.warnings], errors: [...quota.errors, ...timeline.errors, ...surplus.errors], metadata: surplus.metadata };
}

export const generateSchedule = runRotationEngine;

export function regenerateSchedule(gameInput: Game, rosterInput: Player[], previousTimeline: ScheduleBlock[], changes: AvailabilityChange[]): RotationResult {
  const game = prepareGame(gameInput); const roster = prepareRoster(rosterInput); const byName = new Map(roster.map((player) => [player.name, player]));
  const updatedTimeline = previousTimeline.map((block) => ({ ...block, D: [...block.D], M: [...block.M], F: [...block.F], bench: [...block.bench], positions: { ...block.positions } }));
  let earliest = game.total_blocks + 1;
  for (const change of changes) {
    const player = byName.get(change.player); if (!player) continue;
    if (change.action === 'unavailable') {
      if (change.block < 1 || change.block > updatedTimeline.length) throw new Error('Unavailable block must already exist in the timeline.');
      const block = updatedTimeline[change.block - 1];
      const position = block.GK === player.name ? 'GK' : (['D', 'M', 'F'] as const).find((group) => block[group].includes(player.name));
      if (!position) throw new Error(`${player.name} is not playing in block ${change.block}.`);
      player.available = false; game.quota_exempt_players.add(player.name); game.availability_changes.push(change);
      replayTimeline(roster, updatedTimeline.slice(0, change.block - 1), game);
      computeBlockTargets(game, roster);
      const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]); const bench = new Set(block.bench);
      const candidates = roster.filter((candidate) => candidate.available && !assigned.has(candidate.name) && (position === 'GK' ? candidate.primary_positions.includes('GK') : eligiblePlayers(roster, position, game.allow_emergency_positions).some((item) => item.name === candidate.name)));
      candidates.sort((left, right) => (bench.has(left.name) ? 0 : 1) - (bench.has(right.name) ? 0 : 1) || left.block_count - right.block_count || Math.max(0, left.target_blocks - left.block_count) - Math.max(0, right.target_blocks - right.block_count) || left.name.localeCompare(right.name));
      const replacement = candidates[0];
      if (!replacement) { player.available = true; throw new Error(`No available replacement can cover ${position} in block ${change.block}.`); }
      if (position === 'GK') block.GK = replacement.name;
      else { block[position] = block[position].filter((name) => name !== player.name); block[position].push(replacement.name); }
      block.bench = block.bench.filter((name) => name !== replacement.name); if (!block.bench.includes(player.name)) block.bench.push(player.name);
      if (!game.replacement_credits.some((credit) => credit.player === player.name && credit.block === change.block)) { game.replacement_credits.push({ player: player.name, block: change.block, position, replacement: replacement.name }); game.replacement_bonuses[replacement.name] = (game.replacement_bonuses[replacement.name] ?? 0) + 1; }
      earliest = Math.min(earliest, change.block + 1);
    } else {
      player.available = true; game.quota_exempt_players.add(player.name); game.availability_changes.push(change); earliest = Math.min(earliest, change.block + 1);
    }
  }
  const frozen = updatedTimeline.slice(0, Math.max(0, earliest - 1)); replayTimeline(roster, frozen, game); computeBlockTargets(game, roster);
  const timeline = buildTimeline(game, roster, Math.max(1, earliest), frozen);
  const surplus = computeSurplus(game, roster);
  return { timeline: timeline.timeline, block_counts: surplus.block_counts, gk_summary: surplus.gk_summary, position_summary: surplus.position_summary, warnings: [...timeline.warnings, ...surplus.warnings], errors: [...timeline.errors, ...surplus.errors], metadata: surplus.metadata };
}
