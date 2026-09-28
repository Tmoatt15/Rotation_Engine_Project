const ROLE_LABELS: Record<string, string> = { D: 'Defender', M: 'Midfield', F: 'Forward', GK: 'Goalkeeper' };

type DiagnosticGroup = { label: string; blocks: Set<number> };

function blockNumber(error: string): number | null {
  const match = error.match(/^Block (\d+):/);
  return match ? Number(match[1]) : null;
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function summarizeStructuralErrors(gameNumber: number, errors: string[]): string[] {
  const groups = new Map<string, DiagnosticGroup>();
  const ungrouped = new Set<string>();
  for (const error of errors) {
    const block = blockNumber(error);
    const roleMatch = error.match(/^Block \d+: (D|M|F) /);
    const role = roleMatch?.[1];
    if (!block || !role) {
      if (error.startsWith(`Game ${gameNumber}:`)) ungrouped.add(error);
      else ungrouped.add(`Game ${gameNumber}: ${error.replace(/^Block \d+:\s*/, '')}`);
      continue;
    }
    const exact = error.includes('complete legal exact-slot assignment') || error.includes('exact slot');
    const key = `${role}:${exact ? 'exact' : 'coverage'}`;
    const label = `${roleLabel(role)}${exact ? ' exact-slot' : ''} coverage unavailable`;
    const group = groups.get(key) ?? { label, blocks: new Set<number>() };
    group.blocks.add(block);
    groups.set(key, group);
  }
  return [
    ...[...groups.values()].map(({ label, blocks }) => `Game ${gameNumber}: ${label} in ${blocks.size} ${blocks.size === 1 ? 'block' : 'blocks'}`),
    ...ungrouped,
  ];
}
