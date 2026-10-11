import type { QuotaAssignment, RedesignGroup } from './model';
import type { LateArrivalFailure } from './stage5';

export type Stage6OfferKind = 'below-minimum' | 'targeted-relaxation' | 'position-capacity' | 'entire-half' | 'turn-off-limits' | 'failure';
export type Stage6Action = 'cancel' | 'continue' | 'allow' | 'assign-backup-position' | 'turn-off-limits';

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
    return {
      kind: 'position-capacity',
      message: 'Consider making one of these players eligible for defense: review the available players.',
      buttons: [{ label: 'Assign backup position', action: 'assign-backup-position' }, { label: 'Turn Off Limits', action: 'turn-off-limits' }],
      context: { failure },
    };
  }
  if (failure.kind === 'late-arrival-exhausted') {
    return {
      kind: 'entire-half',
      message: 'The arriving player cannot be added without changing the rest of this half. Choose a player to cover the entire half.',
      buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Continue Anyway', action: 'continue' }],
      context: { failure },
    };
  }
  return {
    kind: 'turn-off-limits',
    message: 'The players cannot be scheduled within their current limits. Turn off limits to complete the lineup.',
    buttons: [{ label: 'Cancel', action: 'cancel' }, { label: 'Turn Off Limits', action: 'turn-off-limits' }],
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
    .filter((quota) => quota.totalMax < quota.totalMax + 1)
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
