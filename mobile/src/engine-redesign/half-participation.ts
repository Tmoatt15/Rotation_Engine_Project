import type { PlacementBlock } from './stage3';

export function missingHalfParticipation(
  blocks: PlacementBlock[],
  players: { name: string; available: boolean }[],
  totalBlocks: number,
  firstHalfKeeper: string | null,
  secondHalfKeeper: string | null,
  arrival?: { player: string; arrivalBlock: number },
): string | undefined {
  const halfLength = totalBlocks / 2;
  for (const player of players.filter((candidate) => candidate.available)) {
    const eligibleHalves = [
      { start: 1, end: halfLength, keeper: firstHalfKeeper },
      { start: halfLength + 1, end: totalBlocks, keeper: secondHalfKeeper },
    ].filter(({ end }) => !arrival || end >= arrival.arrivalBlock);
    for (const half of eligibleHalves) {
      const participated = blocks
        .filter((block) => block.block >= half.start && block.block <= half.end)
        .some((block) => [...block.assignments.values()].includes(player.name)
          || half.keeper === player.name);
      if (!participated) return player.name;
    }
  }
  return undefined;
}
