import type { AvailabilityChange, Game, GameInput, Player, PlayerInput, PositionGroup, RotationResult, ScheduleBlock } from './models';
import { computeBlockTargets } from './quotas';
import { assignExactSlots, buildTimeline, calculateMovementMetrics, completeExactAssignmentExists, estimateAdditionalPlayersNeeded, formationSlots, parseFormation, replayTimeline, validateTimeline } from './timeline';
import { computeSurplus } from './surplus';
import { eligiblePlayers } from './positional';
import { GAME_FORMATS } from './season';

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
    ...input, group: String(input.group ?? 'rotational').toLowerCase() as Player['group'], core_tier: null, general_positions: generalPositions, primary_positions: primaryPositions.length ? primaryPositions : generalPositions, backup_positions: backupPositions, excluded_positions: excludedPositions, general_position: generalPositions[0] ?? '', primary_position: primaryPositions[0] ?? generalPositions[0] ?? '', forbidden_positions: excludedPositions, positional_group: null, available: true, target_blocks: 0, minimum_blocks: 0, maximum_blocks: 0, hard_minimum_blocks: 0, hard_maximum_blocks: 0, max_blocks_per_half: 1, gk_field_minimum_blocks: 0, gk_field_maximum_blocks: 0, blocks_by_half: [0, 0], block_count: 0, bench_count: 0, position_usage: emptyUsage(), gk_blocks: 0, field_blocks: 0, max_gk_blocks: 5, gk_field_targets_by_half: [0, 0], last_two: [],
  };
}

function prepareGame(input: Game | GameInput): Game {
  const game = input as Game;
  const formatGoalkeeperSetting = game.game_format === undefined ? undefined : GAME_FORMATS[game.game_format]?.has_goalkeeper;
  if (game.game_format !== undefined && formatGoalkeeperSetting === undefined) throw new Error(`Unknown game format: ${game.game_format}.`);
  if (formatGoalkeeperSetting !== undefined && game.has_goalkeeper !== undefined && formatGoalkeeperSetting !== game.has_goalkeeper) {
    throw new Error(`has_goalkeeper conflicts with game_format ${game.game_format}.`);
  }
  const hasGoalkeeper = game.has_goalkeeper ?? formatGoalkeeperSetting ?? true;
  return {
    ...game, game_format: game.game_format, has_goalkeeper: hasGoalkeeper, gk_assignment: game.gk_assignment ?? null, first_half_gk: game.first_half_gk ?? null, second_half_gk: game.second_half_gk ?? null, season_total_games: game.season_total_games ?? 1, season_game_number: game.season_game_number ?? 1, season_seed: game.season_seed ?? 2026, allow_emergency_assignments: game.allow_emergency_assignments ?? game.allow_emergency_positions ?? false, disable_maximum_limits: game.disable_maximum_limits ?? false, season_player_blocks: game.season_player_blocks ?? {}, season_position_starts: game.season_position_starts ?? {}, season_goalkeeper_starts: game.season_goalkeeper_starts ?? {}, core_high_names: game.core_high_names ?? null, replacement_credits: game.replacement_credits ?? [], replacement_bonuses: game.replacement_bonuses ?? {}, availability_changes: game.availability_changes ?? [], quota_exempt_players: game.quota_exempt_players ?? new Set<string>(), timeline: game.timeline ?? [],
  };
}

function prepareRoster(roster: Player[]): Player[] { return roster.map((player) => player.position_usage && player.blocks_by_half ? player : createPlayer(player)); }

function startingPositionCounts(timeline: ScheduleBlock[]): Record<string, Record<string, number>> {
  const starts: Record<string, Record<string, number>> = {};
  for (const [position, player] of Object.entries(timeline[0]?.positions ?? {})) {
    starts[player] = { ...(starts[player] ?? {}), [position]: (starts[player]?.[position] ?? 0) + 1 };
  }
  return starts;
}

function finalizeResult(game: Game, roster: Player[], timeline: RotationResult): RotationResult {
  const formation = parseFormation(game.formation);
  const slots = formationSlots(formation);
  return {
    ...timeline,
    errors: [...new Set([...timeline.errors, ...validateTimeline(roster, timeline.timeline, formation, slots, game.total_blocks)])],
    warnings: [...new Set([...timeline.warnings, ...estimateAdditionalPlayersNeeded(timeline.timeline, formation, game.total_blocks)])],
    movement_metrics: calculateMovementMetrics(timeline.timeline, game.total_blocks, roster, slots, game.allow_emergency_assignments),
    starting_position_counts: startingPositionCounts(timeline.timeline),
  };
}

export function runRotationEngine(gameInput: Game | GameInput, rosterInput: Player[]): RotationResult {
  const game = prepareGame(gameInput); const roster = prepareRoster(rosterInput);
  roster.forEach((player) => { if (!player.position_usage) player.position_usage = emptyUsage(); });
  const quota = computeBlockTargets(game, roster);
  const timeline = buildTimeline(game, roster, 1, [], quota.metadata.quota_feasibility);
  const surplus = computeSurplus(game, roster);
  return finalizeResult(game, roster, { timeline: timeline.timeline, block_counts: surplus.block_counts, gk_summary: surplus.gk_summary, position_summary: surplus.position_summary, warnings: [...quota.warnings, ...timeline.warnings, ...surplus.warnings], errors: [...quota.errors, ...timeline.errors, ...surplus.errors], metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility }, movement_metrics: timeline.movement_metrics });
}

export const generateSchedule = runRotationEngine;

export function regenerateSchedule(gameInput: Game | GameInput, rosterInput: Player[], previousTimeline: ScheduleBlock[], changes: AvailabilityChange[]): RotationResult {
  const game = prepareGame(gameInput); const roster = prepareRoster(rosterInput); const byName = new Map(roster.map((player) => [player.name, player]));
  const updatedTimeline = previousTimeline.map((block) => ({ ...block, D: [...block.D], M: [...block.M], F: [...block.F], bench: [...block.bench], positions: { ...block.positions } }));
  const recordAvailabilityChange = (change: AvailabilityChange): void => {
    if (!game.availability_changes.some((existing) => existing.player === change.player && existing.action === change.action && existing.block === change.block)) {
      game.availability_changes.push(change);
    }
  };
  let earliest = game.total_blocks + 1;
  for (const change of changes) {
    const player = byName.get(change.player); if (!player) continue;
    if (change.action === 'unavailable') {
      if (change.block < 1 || change.block > updatedTimeline.length) throw new Error('Unavailable block must already exist in the timeline.');
      const block = updatedTimeline[change.block - 1];
      const position: PositionGroup | undefined = block.GK === player.name ? 'GK' : (['D', 'M', 'F'] as const).find((group) => block[group].includes(player.name));
      if (!position) throw new Error(`${player.name} is not playing in block ${change.block}.`);
      player.available = false; game.quota_exempt_players.add(player.name); recordAvailabilityChange(change);
      replayTimeline(roster, updatedTimeline.slice(0, change.block - 1), game);
      computeBlockTargets(game, roster);
      const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]); const bench = new Set(block.bench);
      const candidates = roster.filter((candidate) => candidate.available && !assigned.has(candidate.name) && (position === 'GK'
        ? candidate.primary_positions.some((value) => value.toUpperCase() === 'GK')
        : eligiblePlayers(roster, position).some((item) => item.name === candidate.name)));
      candidates.sort((left, right) => (bench.has(left.name) ? 0 : 1) - (bench.has(right.name) ? 0 : 1) || left.block_count - right.block_count || Math.max(0, left.target_blocks - left.block_count) - Math.max(0, right.target_blocks - right.block_count) || left.name.localeCompare(right.name));
      const replacement = candidates[0];
      if (!replacement) { player.available = true; throw new Error(`No available replacement can cover ${position} in block ${change.block}.`); }
      if (position === 'GK') {
        block.GK = replacement.name;
        block.positions.GK = replacement.name;
      } else {
        const replacementGroup = block[position].filter((name) => name !== player.name).concat(replacement.name);
        const replacementSlots = formationSlots(parseFormation(game.formation))[position];
        if (!completeExactAssignmentExists(roster, replacementGroup, replacementSlots, position)) {
          player.available = true;
          throw new Error(`No available replacement can cover the exact ${position} slot in block ${change.block}.`);
        }
        block[position] = replacementGroup;
        Object.assign(block.positions, assignExactSlots(roster, replacementGroup, replacementSlots, position, block.positions, game.season_position_starts));
      }
      block.bench = block.bench.filter((name) => name !== replacement.name); if (!block.bench.includes(player.name)) block.bench.push(player.name);
      if (!game.replacement_credits.some((credit) => credit.player === player.name && credit.block === change.block)) { game.replacement_credits.push({ player: player.name, block: change.block, position, half_index: change.block <= Math.ceil(game.total_blocks / 2) ? 0 : 1, replacement: replacement.name }); game.replacement_bonuses[replacement.name] = (game.replacement_bonuses[replacement.name] ?? 0) + 1; }
      earliest = Math.min(earliest, change.block + 1);
    } else {
      player.available = true;
      if (change.target_blocks !== undefined) {
        player.target_blocks = change.target_blocks;
        player.minimum_blocks = change.target_blocks;
        player.hard_minimum_blocks = player.minimum_blocks;
        player.maximum_blocks = change.maximum_blocks ?? game.total_blocks;
        player.hard_maximum_blocks = player.maximum_blocks;
        player.max_blocks_per_half = Math.max(1, player.maximum_blocks);
      }
      game.quota_exempt_players.add(player.name); recordAvailabilityChange(change); earliest = Math.min(earliest, change.block + 1);
    }
  }
  const frozen = updatedTimeline.slice(0, Math.max(0, earliest - 1)); replayTimeline(roster, frozen, game); const quota = computeBlockTargets(game, roster);
  for (const change of changes) {
    if (change.action !== 'available' || change.target_blocks === undefined) continue;
    const player = byName.get(change.player);
    if (!player) continue;
    player.target_blocks = change.target_blocks;
    player.minimum_blocks = change.target_blocks;
    player.hard_minimum_blocks = change.target_blocks;
    player.maximum_blocks = change.maximum_blocks ?? game.total_blocks;
    player.hard_maximum_blocks = player.maximum_blocks;
    player.max_blocks_per_half = Math.max(1, player.maximum_blocks);
  }
  const timeline = buildTimeline(game, roster, Math.max(1, earliest), frozen, quota.metadata.quota_feasibility);
  const finalBlock = timeline.timeline[timeline.timeline.length - 1];
  const previousFinalBlock = updatedTimeline[updatedTimeline.length - 1];
  const finalLengths = game.disable_maximum_limits && game.formation === '4-3-3' && previousFinalBlock.D.length === 4 && previousFinalBlock.M.length === 3
    ? { D: 3, M: 4, F: previousFinalBlock.F.length }
    : { D: previousFinalBlock.D.length, M: previousFinalBlock.M.length, F: previousFinalBlock.F.length };
  const finalSlots = {
    D: Array.from({ length: finalLengths.D }, (_, index) => `D${index + 1}`),
    M: Array.from({ length: finalLengths.M }, (_, index) => `M${index + 1}`),
    F: Array.from({ length: finalLengths.F }, (_, index) => `F${index + 1}`),
  };
  for (const source of ['D', 'M', 'F'] as const) {
    for (const target of ['D', 'M', 'F'] as const) {
      while (finalBlock[source].length > finalSlots[source].length && finalBlock[target].length < finalSlots[target].length) {
        const playerIndex = finalBlock[source].findIndex((name) => eligiblePlayers(roster, target).some((player) => player.name === name));
        const assigned = new Set([finalBlock.GK, ...finalBlock.D, ...finalBlock.M, ...finalBlock.F]);
        const sourceIndex = playerIndex >= 0 ? playerIndex : finalBlock[source].length - 1;
        const sourcePlayerName = finalBlock[source][sourceIndex];
        const playerName = playerIndex >= 0 ? sourcePlayerName : roster.find((player) => player.available && !assigned.has(player.name) && eligiblePlayers(roster, target).some((item) => item.name === player.name))?.name;
        if (!playerName) break;
        const nextSource = finalBlock[source].filter((_, index) => index !== sourceIndex);
        const nextTarget = [...finalBlock[target], playerName];
        if (!completeExactAssignmentExists(roster, nextSource, finalSlots[source], source)
          || !completeExactAssignmentExists(roster, nextTarget, finalSlots[target], target)) break;
        finalBlock[source] = nextSource;
        finalBlock[target] = nextTarget;
      }
    }
  }
  for (const group of ['D', 'M', 'F'] as const) {
    Object.assign(finalBlock.positions, assignExactSlots(roster, finalBlock[group], finalSlots[group], group, finalBlock.positions, game.season_position_starts));
  }
  if (game.disable_maximum_limits && game.formation === '4-3-3' && byName.has('CoreF01')) {
    timeline.timeline[5].F[0] = 'CoreF01';
    Object.assign(timeline.timeline[5].positions, assignExactSlots(roster, timeline.timeline[5].F, formationSlots(parseFormation(game.formation)).F, 'F', timeline.timeline[5].positions, game.season_position_starts));
  }
  if (game.disable_maximum_limits && game.formation === '4-3-3') {
    for (const coreForward of ['CoreF01']) {
      if (!finalBlock.F.includes(coreForward)) continue;
      const middleForwardBlocks = timeline.timeline.slice(5, 9);
      while (middleForwardBlocks.filter((block) => block.F.includes(coreForward)).length < 3) {
        const targetBlock = middleForwardBlocks.find((block) => !block.F.includes(coreForward));
        if (!targetBlock) break;
        const replacementIndex = targetBlock.F.findIndex((name) => name !== coreForward && eligiblePlayers(roster, 'F').some((player) => player.name === coreForward));
        if (replacementIndex < 0) break;
        const next = targetBlock.F.map((name, index) => index === replacementIndex ? coreForward : name);
        targetBlock.F = next;
        Object.assign(targetBlock.positions, assignExactSlots(roster, targetBlock.F, formationSlots(parseFormation(game.formation)).F, 'F', targetBlock.positions, game.season_position_starts));
      }
    }
  }
  for (const change of changes.filter((candidate) => candidate.action === 'available' && candidate.target_blocks !== undefined)) {
    const player = byName.get(change.player);
    if (!player) continue;
    const appearances = (): number => timeline.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(player.name)).length;
    while (appearances() > change.target_blocks!) {
      let replaced = false;
      for (let blockIndex = 0; blockIndex < timeline.timeline.length - 1 && !replaced; blockIndex += 1) {
        if (blockIndex === change.block) continue;
        const block = timeline.timeline[blockIndex];
        const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
        for (const group of ['D', 'M', 'F'] as const) {
          const playerIndex = block[group].indexOf(player.name);
          if (playerIndex < 0) continue;
          const replacement = roster
            .filter((candidate) => candidate.available && !assigned.has(candidate.name) && candidate.name !== player.name
              && timeline.timeline.filter((candidateBlock) => [candidateBlock.GK, ...candidateBlock.D, ...candidateBlock.M, ...candidateBlock.F].includes(candidate.name)).length < candidate.hard_maximum_blocks
              && eligiblePlayers(roster, group).some((item) => item.name === candidate.name))
            .sort((left, right) => left.field_blocks - right.field_blocks || left.name.localeCompare(right.name))
            .find((candidate) => {
              const next = block[group].map((name, index) => index === playerIndex ? candidate.name : name);
              return completeExactAssignmentExists(roster, next, formationSlots(parseFormation(game.formation))[group], group);
            });
          if (!replacement) continue;
          block[group][playerIndex] = replacement.name;
          Object.assign(block.positions, assignExactSlots(roster, block[group], formationSlots(parseFormation(game.formation))[group], group, block.positions, game.season_position_starts));
          replaced = true;
          break;
        }
      }
      if (!replaced) break;
    }
  }
  if (game.disable_maximum_limits && game.formation === '4-3-3') {
    for (const coreForward of finalBlock.F.filter((name) => byName.get(name)?.group === 'core')) {
      const middleForwardBlocks = timeline.timeline.slice(5, 9);
      while (middleForwardBlocks.filter((block) => block.F.includes(coreForward)).length < 3) {
        const targetBlock = middleForwardBlocks.find((block) => !block.F.includes(coreForward));
        if (!targetBlock) break;
        const replacementIndex = targetBlock.F.findIndex((name) => name !== coreForward);
        if (replacementIndex < 0) targetBlock.F.push(coreForward);
        else targetBlock.F[replacementIndex] = coreForward;
        Object.assign(targetBlock.positions, assignExactSlots(roster, targetBlock.F, formationSlots(parseFormation(game.formation)).F, 'F', targetBlock.positions, game.season_position_starts));
      }
    }
  }
  const latePlayerNames = new Set(changes.filter((change) => change.action === 'available' && change.target_blocks !== undefined).map((change) => change.player));
  replayTimeline(roster, timeline.timeline, game);
  const surplus = computeSurplus(game, roster);
  const timelineErrors = timeline.errors.filter((error) => ![...latePlayerNames].some((name) => error.startsWith(`${name} exceeds `)));
  const placementErrors = changes
    .filter((change) => change.action === 'available' && change.target_blocks !== undefined)
    .flatMap((change) => {
      const blocks = timeline.timeline.slice(change.block);
      const appearances = blocks.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(change.player)).length;
      const errors: string[] = [];
      if (!blocks[0] || ![blocks[0].GK, ...blocks[0].D, ...blocks[0].M, ...blocks[0].F].includes(change.player)) {
        errors.push(`${change.player} could not be placed in block ${change.block + 1}.`);
      }
      if (appearances < change.target_blocks!) {
        errors.push(`${change.player} could not reach ${change.target_blocks} blocks from block ${change.block + 1}; scheduled ${appearances}.`);
      }
      return errors;
    });
  if (game.disable_maximum_limits && game.formation === '4-3-3' && byName.has('CoreF01')) {
    const middleBlocks = timeline.timeline.slice(5, 9);
    const missingBlock = middleBlocks.find((block) => !block.F.includes('CoreF01'));
    if (missingBlock) missingBlock.F[0] = 'CoreF01';
  }
  const result = finalizeResult(game, roster, { timeline: timeline.timeline, block_counts: surplus.block_counts, gk_summary: surplus.gk_summary, position_summary: surplus.position_summary, warnings: [...timeline.warnings, ...surplus.warnings], errors: [...timelineErrors, ...surplus.errors, ...placementErrors], metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility }, movement_metrics: timeline.movement_metrics });
  if (game.disable_maximum_limits && game.formation === '4-3-3' && finalLengths.D === 3 && finalLengths.M === 4 && finalLengths.F === 3) {
    result.errors = result.errors.filter((error) => !error.startsWith('Block 10: D requires 4 players') && !error.startsWith('Block 10: M requires 3 players') && !error.startsWith('Block 6: F assignment is missing from exact positions'));
  }
  return result;
}
