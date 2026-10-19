import { blockStartMinutes, SeasonSetup } from '@/engine/season';
import { formationSlots, parseFormation } from '@/engine/timeline';
import type { LiveSchedule, ScheduleBlock, SeasonRosterPlayer } from '@/engine/models';
import { assignQuotas, buildDemandModel, checkRosterFeasibility, normalizeGame, positionTier, runStages3And4 } from '@/engine-redesign';
import type { RedesignPlayerInput } from '@/engine-redesign/model';
import { replanLateArrival } from '@/engine-redesign/stage5';
import { offerForFailure, offerForRelaxedMinimums } from '@/engine-redesign/stage6';
import type { Stage6Offer } from '@/engine-redesign/stage6';
import type { FrozenBlock } from '@/engine-redesign/stage3';
import { getLocalTeam, getRoster, getSeasonSettings } from './team-service';
import { getSavedReports } from './report-service';
import { getDatabase } from '@/storage/database';
import { getWaterfillRotationState, saveWaterfillRotationState } from '@/storage/waterfill-rotation';
import { isDedicatedKeeper } from '@/position-groups';

export class RedesignOfferError extends Error {
  constructor(public readonly offer: ReturnType<typeof offerForFailure>) {
    super(offer.message);
    this.name = 'RedesignOfferError';
  }
}

type FieldGroup = 'D' | 'M' | 'F';

function fieldGroupName(group: FieldGroup): string {
  return group === 'D' ? 'Defender' : group === 'M' ? 'Midfield' : 'Forward';
}

function backupSuggestionOffer(
  groups: { group: FieldGroup; count: number }[],
  context: Record<string, unknown>,
): Stage6Offer {
  const suggestions = groups.map(({ group, count }) =>
    `Warning: ${fieldGroupName(group)} group (${group}) is short ${count} ${count === 1 ? 'player' : 'players'}. Add ${group === 'D' ? 'a' : 'an'} ${group} backup to a player.`,
  );
  return {
    kind: 'position-shortage',
    message: suggestions.join('\n\n'),
    buttons: [{ label: 'SUGGEST', action: 'suggest-backup' }, { label: 'Cancel', action: 'cancel' }],
    context: { ...context, positionGroup: groups[0]?.group },
  };
}

function throwForQuotaAuditErrors(quotas: ReturnType<typeof assignQuotas>, totalBlocks: number): void {
  if (!quotas.audit.errors?.length) return;
  const rosterTooLarge = quotas.audit.rosterTooLarge;
  const auditErrors = quotas.audit.errors ?? [];
  if (!rosterTooLarge && quotas.audit.underfill.length) {
    const underfill = quotas.audit.underfill.map(({ group, blocks }) => ({
      group,
      count: Math.max(1, Math.ceil(blocks / totalBlocks)),
    }));
    throw new RedesignOfferError(backupSuggestionOffer(underfill, {
      failureType: 'waterfill-underfill',
      errors: quotas.audit.errors,
      underfill: quotas.audit.underfill,
    }));
  }
  if (!rosterTooLarge && quotas.audit.overage.length) {
    const suggestions = quotas.audit.overage.map(({ group, blocks }) => {
      const error = auditErrors.find((entry) => entry.includes(`group (${group}) is over by`));
      const destination = error?.match(/Add ([DMF]) backup/)?.[1] as FieldGroup | undefined;
      return {
        group: destination ?? group,
        count: Math.max(1, Math.ceil(blocks / totalBlocks)),
      };
    });
    throw new RedesignOfferError(backupSuggestionOffer(suggestions, {
      failureType: 'waterfill-overage',
      errors: quotas.audit.errors,
      overage: quotas.audit.overage,
    }));
  }
  if (rosterTooLarge) {
    throw new RedesignOfferError({
      kind: 'position-shortage',
      message: `Too many field players for this roster. The current formation supports a maximum of ${rosterTooLarge.maxPlayers} field players at the minimum playing-time floor.`,
      buttons: [{ label: 'Cancel', action: 'cancel' }],
      context: {
        failureType: 'roster-too-large',
        maxPlayers: rosterTooLarge.maxPlayers,
        errors: quotas.audit.errors,
        underfill: quotas.audit.underfill,
        overage: quotas.audit.overage,
      },
    });
  }
  throw new RedesignOfferError({
    kind: 'position-shortage',
    message: 'The roster groups need more flexibility before a schedule can be generated.',
    buttons: [{ label: 'Cancel', action: 'cancel' }],
    context: {
      failureType: 'waterfill-audit',
      errors: quotas.audit.errors,
      underfill: quotas.audit.underfill,
      overage: quotas.audit.overage,
    },
  });
}

function relaxedMinimumWarnings(quotas: ReturnType<typeof assignQuotas>): string[] {
  if (!quotas.audit.relaxedPlayers?.length) return [];
  return [`Minimums relaxed for: ${quotas.audit.relaxedPlayers.map((entry) => `${entry.player} (${entry.before} -> ${entry.after} blocks)`).join(', ')}.`];
}

function waterfillPlacementFailureOffer(placement: ReturnType<typeof runStages3And4>): Stage6Offer {
  const slotError = placement.audit.errors.find((error) => /unfilled slot/i.test(error));
  const diagnostic = slotError ?? placement.audit.errors.find((error) => error.trim())
    ?? placement.audit.failureReason
    ?? 'No placement diagnostic was reported.';
  const group = slotError?.match(/slot\s+([DMF])/i)?.[1]?.toUpperCase() ?? 'unknown';
  const stage = placement.audit.failureReason ? 'Stage 3' : 'Stage 3/4';
  return {
    kind: 'impossible',
    message: `Water-fill placement failed in ${stage} for group ${group}: ${diagnostic}`,
    buttons: [{ label: 'Cancel', action: 'cancel' }],
    context: { failureType: 'waterfill-placement-failed', stage, group, diagnostic },
  };
}

function placementFailureOffer(
  game: ReturnType<typeof normalizeGame>,
  demand: ReturnType<typeof buildDemandModel>,
  placement: ReturnType<typeof runStages3And4>,
): Stage6Offer {
  if (!placement.audit.errors.some((error) => error.trim())) {
    const guidance = generationFailureOffer(game, demand, true);
    if (guidance.kind !== 'impossible') return guidance;
  }
  return waterfillPlacementFailureOffer(placement);
}

function generationFailureOffer(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>, allowRelaxedMinimums = false): Stage6Offer {
  const firstHalfAssigned = Boolean(game.firstHalfKeeper);
  const secondHalfAssigned = Boolean(game.secondHalfKeeper);
  const keepers = game.players.filter((player) => player.available && player.keeperEligible);
  if (!firstHalfAssigned || !secondHalfAssigned) {
    if (keepers.length === 0) {
      return {
        kind: 'keeper-issue',
        message: 'No keeper is available for this game.',
        buttons: [{ label: 'Pick Keeper', action: 'pick-keeper' }, { label: 'Cancel', action: 'cancel' }],
        context: { failureType: 'keeper-issue', keeperNames: [] },
      };
    }
    return {
      kind: 'keeper-issue',
      message: `Only 1 keeper is available (${keepers[0].name}).`,
      buttons: [
        { label: `${keepers[0].name} plays full game`, action: 'full-game-keeper' },
        { label: 'Pick backup keeper', action: 'pick-keeper' },
        { label: 'Cancel', action: 'cancel' },
      ],
      context: { failureType: 'keeper-issue', keeperNames: keepers.map((player) => player.name) },
    };
  }
  const groups = ['D', 'M', 'F'] as const;
  const feasibilityIssue = checkRosterFeasibility(game, demand);
  const quotas = assignQuotas(game, demand).quotas;
  const groupSlots = (group: FieldGroup) => demand.fieldSlots.filter((slot) => slot.group === group).length;
  const minimumForPlayer = (player: typeof game.players[number]): number => {
    const percentage = player.group === 'core' ? 0.7 : player.group === 'rotational' ? 0.6 : 0.5;
    return Math.max(0, Math.min(game.totalBlocks, Math.round(game.totalBlocks * percentage)));
  };
  const playersForGroup = (group: typeof groups[number]) => game.players.filter((player) => player.available && !player.keeper
    && demand.fieldSlots.filter((slot) => slot.group === group).some((slot) => positionTier(player, slot.slot) > 0));
  const eligibleCounts = Object.fromEntries(groups.map((group) => [group, playersForGroup(group).length])) as Record<typeof groups[number], number>;
  const fieldPlayers = game.players.filter((player) => player.available && !player.keeper);
  const totalMinimum = fieldPlayers.reduce((total, player) => total + minimumForPlayer(player), 0);
  if (totalMinimum > demand.fieldSlots.length * game.totalBlocks && !allowRelaxedMinimums) {
    const targetGroup = groups.filter((group) => groupSlots(group) > 0)
      .sort((left, right) => (eligibleCounts[left] - groupSlots(left)) - (eligibleCounts[right] - groupSlots(right))
        || groups.indexOf(left) - groups.indexOf(right))[0] ?? 'M';
    const shortPlayers = Math.max(1, Math.ceil((totalMinimum - demand.fieldSlots.length * game.totalBlocks) / game.totalBlocks));
    return backupSuggestionOffer([{ group: targetGroup, count: shortPlayers }], {
      failureType: 'total-minimums',
      totalMinimum,
      totalCapacity: demand.fieldSlots.length * game.totalBlocks,
    });
  }
  const endpointPinned = (player: typeof game.players[number]): number => {
    if (player.group !== 'core' || !player.available) return 0;
    const hasBlockOnePin = game.pins.some((pin) => pin.block === 1 && pin.player === player.name);
    return game.lateArrival?.player === player.name || (!hasBlockOnePin && game.pins.length > 0) ? 1 : 2;
  };
  const diagnoses: { group: typeof groups[number]; names: string[]; target: FieldGroup }[] = [];
  for (const group of groups) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const singleGroupPlayers = playersForGroup(group).filter((player) => groups.filter((candidate) => playersForGroup(candidate).some((eligible) => eligible.name === player.name)).length === 1);
    const minimums = singleGroupPlayers
      .map((player) => ({ name: player.name, minimum: minimumForPlayer(player) }))
      .filter((player) => player.minimum > 0)
      .sort((left, right) => right.minimum - left.minimum || left.name.localeCompare(right.name));
    const pinnedSlots = playersForGroup(group).reduce((total, player) => total + endpointPinned(player), 0);
    const minimumExcess = minimums.reduce((total, player) => total + player.minimum, 0) - Math.max(0, slots.length * game.totalBlocks - pinnedSlots);
    if (minimumExcess <= 0 || !minimums.length) continue;
    const crossTraining = [...minimums].sort((left, right) => {
      const leftPlayer = game.players.find((player) => player.name === left.name);
      const rightPlayer = game.players.find((player) => player.name === right.name);
      const tier = (player: typeof game.players[number] | undefined): number => player?.group === 'rotational' ? 0 : player?.group === 'developing' ? 1 : 2;
      return tier(leftPlayer) - tier(rightPlayer) || right.minimum - left.minimum || left.name.localeCompare(right.name);
    }).slice(0, Math.max(1, minimums.findIndex((_, index) => minimums.slice(0, index + 1).reduce((total, player) => total + player.minimum, 0) >= minimumExcess * 1.5) + 1));
    const targetGroup = groups
      .filter((candidate) => candidate !== group)
      .sort((left, right) => (eligibleCounts[right] - demand.fieldSlots.filter((slot) => slot.group === right).length)
        - (eligibleCounts[left] - demand.fieldSlots.filter((slot) => slot.group === left).length))[0];
    diagnoses.push({ group, names: crossTraining.map((player) => player.name), target: targetGroup });
  }
  if (diagnoses.length) {
    const namesByTarget = new Map<FieldGroup, Set<string>>();
    diagnoses.forEach(({ names, target }) => {
      const targetNames = namesByTarget.get(target) ?? new Set<string>();
      names.forEach((name) => targetNames.add(name));
      namesByTarget.set(target, targetNames);
    });
    const suggestions = [...namesByTarget].map(([group, names]) => ({ group, count: names.size }));
    return backupSuggestionOffer(suggestions, {
      failureType: 'position-shortage',
      suggestions: diagnoses.flatMap(({ names }) => names),
    });
  }
  const shortages = groups.map((group) => {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const eligible = game.players.filter((player) => player.available && !player.keeper
      && slots.some((slot) => positionTier(player, slot.slot) > 0)).length;
    return { group, have: eligible, need: slots.length };
  }).filter((entry) => entry.have < entry.need).sort((left, right) => left.have - left.need - (right.have - right.need));
  const shortage = shortages[0];
  if (shortage) {
    return backupSuggestionOffer([{
      group: shortage.group,
      count: Math.max(1, shortage.need - shortage.have),
    }], {
      failureType: 'position-shortage',
      have: shortage.have,
      need: shortage.need,
    });
  }
  for (const group of groups) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const eligible = game.players.filter((player) => player.available && !player.keeper
      && slots.some((slot) => positionTier(player, slot.slot) > 0));
    const capacityHave = eligible.reduce((total, player) => total + (quotas.find((quota) => quota.player === player.name)?.fieldMax ?? 0), 0);
    const capacityNeed = slots.length * game.totalBlocks;
    if (capacityHave >= capacityNeed) continue;
    return backupSuggestionOffer([{
      group,
      count: Math.max(1, Math.ceil((capacityNeed - capacityHave) / game.totalBlocks)),
    }], {
      failureType: 'position-shortage',
      have: eligible.length,
      need: slots.length,
      capacityHave,
      capacityNeed,
    });
  }
  return {
    kind: 'impossible',
    message: feasibilityIssue?.message ?? 'Can\'t generate a schedule with the current roster setup. Review position assignments and try again.',
    buttons: [{ label: 'Cancel', action: 'cancel' }],
    context: { failureType: 'impossible', feasibility: feasibilityIssue },
  };
}

function rosterInput(player: SeasonRosterPlayer): RedesignPlayerInput {
  return {
    name: player.name,
    group: player.group,
    general_positions: player.general_positions ?? [],
    primary_positions: player.primary_positions ?? [],
    backup_positions: player.backup_positions ?? [],
    excluded_positions: player.excluded_positions ?? [],
    keeper_eligible: player.keeper_eligible === true,
    keeper: isDedicatedKeeper(player.keeper_eligible === true, player.general_positions ?? []),
  };
}

function formatFor(format: string): '4v4' | '7v7' | '9v9' | '11v11' {
  if (format === '4v4' || format === '7v7' || format === '9v9' || format === '11v11') return format;
  throw new Error(`Unsupported redesign game format: ${format}.`);
}

function positionRows(formation: string) {
  const slots = formationSlots(parseFormation(formation));
  return [
    { label: 'FORWARDS', positions: slots.F },
    { label: 'MIDFIELDERS', positions: slots.M },
    { label: 'DEFENDERS', positions: slots.D },
    { label: 'GOALKEEPER', positions: ['GK'] },
  ].filter((row) => row.positions.length);
}

function scheduleBlocks(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>, placement: ReturnType<typeof runStages3And4>): ScheduleBlock[] {
  return placement.blocks.map((block) => {
    const positions: Record<string, string> = {};
    if (game.firstHalfKeeper && block.block <= game.totalBlocks / 2) positions.GK = game.firstHalfKeeper;
    if (game.secondHalfKeeper && block.block > game.totalBlocks / 2) positions.GK = game.secondHalfKeeper;
    for (const [slot, player] of block.assignments) {
      if (player === positions.GK) continue;
      positions[slot] = player;
    }
    const playing = new Set(Object.values(positions));
    const grouped: Record<'D' | 'M' | 'F', string[]> = { D: [], M: [], F: [] };
    for (const slot of demand.fieldSlots) {
      const player = positions[slot.slot];
      if (player) grouped[slot.group].push(player);
    }
    return {
      GK: positions.GK ?? '',
      D: grouped.D,
      M: grouped.M,
      F: grouped.F,
      bench: game.players.filter((player) => player.available && !playing.has(player.name)).map((player) => player.name),
      positions,
    };
  });
}

function placementAttempt(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>, allowRelaxedMinimums: boolean) {
  const quotas = assignQuotas(game, demand, allowRelaxedMinimums);
  return { placement: runStages3And4(game, demand, quotas), quotas };
}

async function context(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null }) {
  const settings = await getSeasonSettings(input.teamId);
  const team = await getLocalTeam(input.teamId);
  const roster = (await getRoster(input.teamId)).players.map(rosterInput);
  const reports = await getSavedReports(input.teamId);
  const history: Record<string, { historicalFieldBlocks: number; historicalGkBlocks: number; historicalStarts: number }> = {};
  reports.filter((report) => report.game_number < input.gameNumber).forEach((report) => report.players.forEach((player) => {
    history[player.player] = { historicalFieldBlocks: (history[player.player]?.historicalFieldBlocks ?? 0) + player.blocksPlayed, historicalGkBlocks: 0, historicalStarts: 0 };
  }));
  const seasonRotation = await getWaterfillRotationState(await getDatabase(), input.teamId, input.gameNumber);
  const game = normalizeGame({
    format: formatFor(settings.game_format),
    formation: settings.formation,
    totalBlocks: settings.total_blocks,
    availablePlayerNames: input.availablePlayerNames,
    firstHalfKeeper: input.firstHalfGk ?? null,
    secondHalfKeeper: input.secondHalfGk ?? null,
    seasonHistory: history,
    seasonRotation,
  }, roster);
  const demand = buildDemandModel(game);
  return { settings, team, game, demand };
}

type RedesignSchedule = LiveSchedule & { formation: string; warnings: string[]; errors: string[]; available_player_names: string[]; engine_source: 'redesign' };

export async function generateRedesignSchedule(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null; allowRelaxedMinimums?: boolean }): Promise<RedesignSchedule> {
  const { settings, team, game, demand } = await context(input);
  let placement: ReturnType<typeof runStages3And4>;
  let quotas: ReturnType<typeof assignQuotas>;
  if (input.allowRelaxedMinimums) {
    ({ placement, quotas } = placementAttempt(game, demand, true));
    throwForQuotaAuditErrors(quotas, game.totalBlocks);
    if (!placement.complete) {
      throw new RedesignOfferError(placementFailureOffer(game, demand, placement));
    }
  } else {
    const strict = placementAttempt(game, demand, false);
    const relaxed = placementAttempt(game, demand, true);
    if (!strict.quotas.audit.errors?.length && strict.placement.complete) {
      ({ placement, quotas } = strict);
    } else if (!relaxed.quotas.audit.errors?.length && relaxed.placement.complete) {
      throw new RedesignOfferError(offerForRelaxedMinimums(relaxed.quotas));
    } else {
      throwForQuotaAuditErrors(relaxed.quotas, game.totalBlocks);
      throw new RedesignOfferError(placementFailureOffer(game, demand, relaxed.placement));
    }
  }
  throwForQuotaAuditErrors(quotas, game.totalBlocks);
  if (!placement.complete) {
    const placementErrors = placement.audit.errors ?? [];
    console.error('[redesign] placement failed:', placementErrors);
    throw new RedesignOfferError(placementFailureOffer(game, demand, placement));
  }
  const blockLengths = new SeasonSetup({ ...settings, block_length_minutes: undefined }).block_lengths_minutes;
  const relaxedWarnings = relaxedMinimumWarnings(quotas);
  if (placement.audit.relaxedLookaheadFallback) relaxedWarnings.push('Used relaxed placement look-ahead.');
  const result: RedesignSchedule = {
    team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null,
    available_player_names: input.availablePlayerNames, core_player_names: game.players.filter((player) => player.group === 'core').map((player) => player.name), formation: game.formation,
    block_start_minutes: blockStartMinutes(blockLengths), block_lengths_minutes: blockLengths, position_rows: positionRows(game.formation),
    blocks: scheduleBlocks(game, demand, placement), warnings: ['Engine: redesign (Stages 0–6)', ...relaxedWarnings], errors: [], structural_errors: [], review_status: 'generated', engine_source: 'redesign',
  };
  await saveWaterfillRotationState(await getDatabase(), input.teamId, input.gameNumber, quotas.rotationState ?? {});
  return result;
}

export async function regenerateRedesignLateArrival(input: { teamId: string; gameNumber: number; previousSchedule: LiveSchedule; availablePlayerNames: string[]; playerName: string; startBlock: number; targetBlocks: number; firstHalfGk?: string | null; secondHalfGk?: string | null }): Promise<RedesignSchedule> {
  const base = await context(input);
  const game = normalizeGame({
    format: base.game.format, formation: base.game.formation, totalBlocks: base.game.totalBlocks, availablePlayerNames: input.availablePlayerNames,
    firstHalfKeeper: input.firstHalfGk ?? null, secondHalfKeeper: input.secondHalfGk ?? null,
    lateArrival: { player: input.playerName, arrivalBlock: input.startBlock, targetBlocks: input.targetBlocks },
    seasonRotation: base.game.seasonRotation,
  }, base.game.players.map((player) => ({ name: player.name, group: player.group, general_positions: player.generalPositions, primary_positions: player.primaryPositions, backup_positions: player.backupPositions, excluded_positions: player.excludedPositions, keeper: player.keeper, keeper_eligible: player.keeperEligible })));
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  const frozen: FrozenBlock[] = input.previousSchedule.blocks.slice(0, input.startBlock - 1).map((block, index) => ({ block: index + 1, assignments: new Map(Object.entries(block.positions).filter(([slot]) => slot !== 'GK')) }));
  const result = replanLateArrival({ game, demand, quotas, frozen, arrivalTarget: input.targetBlocks });
  if (result.kind !== 'success') throw new RedesignOfferError(offerForFailure(result.failure));
  throwForQuotaAuditErrors(quotas, game.totalBlocks);
  await saveWaterfillRotationState(await getDatabase(), input.teamId, input.gameNumber, quotas.rotationState ?? {});
  const blockLengths = new SeasonSetup({ ...(base.settings), block_length_minutes: undefined }).block_lengths_minutes;
  return {
    team_id: input.teamId, team_name: base.team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null,
    available_player_names: input.availablePlayerNames, core_player_names: game.players.filter((player) => player.group === 'core').map((player) => player.name), formation: game.formation,
    block_start_minutes: blockStartMinutes(blockLengths), block_lengths_minutes: blockLengths, position_rows: positionRows(game.formation),
    blocks: scheduleBlocks(game, demand, result.placement), warnings: ['Engine: redesign (Stages 0–6)', ...relaxedMinimumWarnings(quotas)], errors: [], structural_errors: [], review_status: 'generated', engine_source: 'redesign',
  };
}
