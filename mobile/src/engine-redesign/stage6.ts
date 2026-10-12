import type { QuotaAssignment, RedesignGroup } from './model';
import type { LateArrivalFailure } from './stage5';

export type Stage6OfferKind = 'below-minimum' | 'targeted-relaxation' | 'position-capacity' | 'position-shortage' | 'keeper-issue' | 'impossible' | 'entire-half' | 'never-five-violation' | 'turn-off-limits' | 'failure';
export type Stage6Action = 'cancel' | 'continue' | 'allow' | 'assign-backup-position' | 'choose-player' | 'go-to-roster' | 'pick-keeper' | 'full-game-keeper' | 'turn-off-limits';

export interface Stage6Offer {
  kind: Stage6OfferKind;
  message: string;
  buttons: Array<{ label: string; action: Stage6Action }>;
  context: Record<string, unknown>;
}

const groupOrder: Record<RedesignGroup, number> = { core: 0, rotational: 1, developing: 2 };

export function offerForFailure(failure: LateArrivalFailure): Stage6Offer {
  if (failure.kind === 'donor-below-minimum') {
    return {
      kind: 'below-minimum',
      message: `Adding ${failure.arrival ?? 'the arriving player'} would drop ${failure.player ?? 'a player'} below minimum (${failure.before ?? 0}→${failure.after ?? 0} blocks).`,
      buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Continue Anyway', action: 'continue' }],
      context: { failure },
    };
  }
  if (failure.kind === 'position-uncovered') {
    const position = failure.position ?? 'the open position';
    const candidates = failure.candidates ?? [];
    return {
      kind: 'position-capacity',
      message: `Consider making one of these players eligible for ${position}: ${candidates.join(', ') || 'review the available players'}.`,
      buttons: [{ label: 'Assign backup position', action: 'assign-backup-position' }, { label: 'Cancel', action: 'cancel' }],
      context: { failure, position, candidates },
    };
  }
  if (failure.kind === 'never-five-violation') {
    return {
      kind: 'never-five-violation',
      message: `${failure.player ?? 'A player'} would play 5 blocks in a row in the ${failure.half ?? 'current'} half. Is that OK?`,
      buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Allow', action: 'allow' }],
      context: { placement: failure.placement, player: failure.player, half: failure.half },
    };
  }
  if (failure.kind === 'late-arrival-exhausted') {
    const candidates = failure.candidates ?? [];
    const recommended = failure.recommended ?? candidates[0];
    return {
      kind: 'entire-half',
      message: `The arriving player cannot be added without changing the rest of this half. ${recommended ?? 'Choose a player'} could cover the half.`,
      buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Continue Anyway', action: 'continue' }],
      context: { failure, recommended, candidates },
    };
  }
  return {
    kind: 'impossible',
    message: 'The available roster cannot satisfy the formation and playing-time requirements.',
    buttons: [{ label: 'Cancel', action: 'cancel' }],
    context: { failure },
  };
}

export interface RelaxationEntry {
  player: string;
  group: RedesignGroup;
  before: number;
  after: number;
}

export interface TargetedRelaxation {
  entries: RelaxationEntry[];
  offer: Stage6Offer;
}

export function findTargetedRelaxation(
  quotas: QuotaAssignment,
  canPlace: (candidate: QuotaAssignment) => boolean,
): TargetedRelaxation | null {
  const candidates = quotas.quotas
    .sort((left, right) => groupOrder[left.group] - groupOrder[right.group] || (right.totalMax - right.totalMin) - (left.totalMax - left.totalMin) || left.player.localeCompare(right.player));
  for (const quota of candidates) {
    const candidate = cloneQuotaAssignment(quotas);
    const target = candidate.quotas.find((entry) => entry.player === quota.player)!;
    target.totalMax += 1;
    target.remainingMax += 1;
    if (canPlace(candidate)) return relaxationResult([target], quotas);
  }
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const candidate = cloneQuotaAssignment(quotas);
      const entries = [candidates[left], candidates[right]].map((quota) => candidate.quotas.find((entry) => entry.player === quota.player)!);
      for (const entry of entries) {
        entry.totalMax += 1;
        entry.remainingMax += 1;
      }
      if (canPlace(candidate)) return relaxationResult(entries, quotas);
    }
  }
  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      for (let third = second + 1; third < candidates.length; third += 1) {
        const candidate = cloneQuotaAssignment(quotas);
        const entries = [candidates[first], candidates[second], candidates[third]]
          .map((quota) => candidate.quotas.find((entry) => entry.player === quota.player)!);
        for (const entry of entries) {
          entry.totalMax += 1;
          entry.remainingMax += 1;
        }
        if (canPlace(candidate)) return relaxationResult(entries, quotas);
      }
    }
  }
  return null;
}

function cloneQuotaAssignment(quotas: QuotaAssignment): QuotaAssignment {
  return {
    ...quotas,
    quotas: quotas.quotas.map((quota) => ({ ...quota, pinnedBlocks: [...quota.pinnedBlocks], history: { ...quota.history } })),
    audit: {
      ...quotas.audit,
      relaxedGroups: quotas.audit.relaxedGroups.map((entry) => ({ ...entry })),
      surplusAssignments: quotas.audit.surplusAssignments.map((entry) => ({ ...entry })),
    },
  };
}

function relaxationResult(entries: Array<{ player: string; group: RedesignGroup; totalMax: number }>, original: QuotaAssignment): TargetedRelaxation {
  const changes = entries.map((entry) => {
    const before = original.quotas.find((quota) => quota.player === entry.player)!.totalMax;
    return { player: entry.player, group: entry.group, before, after: entry.totalMax };
  });
  const names = changes.map((entry) => entry.player).join(' and ');
  const amounts = changes.map((entry) => `one extra block (${entry.before}→${entry.after})`).join(' and ');
  return {
    entries: changes,
    offer: {
      kind: 'targeted-relaxation',
      message: `To fit everyone in, ${names} would each play ${amounts}. Is that OK?`,
      buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Allow', action: 'allow' }],
      context: { changes },
    },
  };
}
