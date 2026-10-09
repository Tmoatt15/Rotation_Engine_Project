import type { Game, Player, RotationResult, ScheduleBlock } from './models';
import { CORE_MIN, DEVELOPMENTAL_MIN, ROTATIONAL_MIN, minimumBlocksForPercentage } from './quotas';

export function filterStaleQuotaWarnings(warnings: string[], blocks: ScheduleBlock[], roster: Player[]): string[] {
  const counts = new Map<string, number>();
  blocks.forEach((block) => [block.GK, ...block.D, ...block.M, ...block.F].forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1)));
  return warnings.filter((warning) => {
    const match = warning.match(/^(.+?) \((core|rotational|developmental)\) is under (?:target|minimum) by \d+ blocks\.$/);
    if (!match) return true;
    const player = roster.find((candidate) => candidate.name === match[1]);
    if (!player) return true;
    const minimum = player.group.startsWith('core')
      ? minimumBlocksForPercentage(blocks.length, CORE_MIN)
      : player.group === 'rotational'
        ? minimumBlocksForPercentage(blocks.length, ROTATIONAL_MIN)
        : minimumBlocksForPercentage(blocks.length, DEVELOPMENTAL_MIN);
    return (counts.get(player.name) ?? 0) < minimum;
  });
}

export function computeSurplus(game: Game, roster: Player[]): RotationResult {
  const result: RotationResult = { timeline: [], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, formation: game.formation, gk_assignment: game.gk_assignment } };
  const lateArrivalNames = new Set((game.availability_changes ?? [])
    .filter((change) => change.action === 'available' && change.target_blocks !== undefined)
    .map((change) => change.player));
  for (const player of roster) {
    result.block_counts[player.name] = player.block_count;
    result.position_summary[player.name] = { ...player.position_usage };
    if (!player.available) continue;
    if (player.primary_positions.includes('GK')) result.gk_summary[player.name] = { gk: player.gk_blocks, field: player.field_blocks, bench: player.bench_count };
    const warningMinimum = player.group.startsWith('core')
      ? minimumBlocksForPercentage(game.total_blocks, CORE_MIN)
      : player.group === 'rotational'
        ? minimumBlocksForPercentage(game.total_blocks, ROTATIONAL_MIN)
        : minimumBlocksForPercentage(game.total_blocks, DEVELOPMENTAL_MIN);
    if (!lateArrivalNames.has(player.name) && player.group.startsWith('core') && player.block_count < warningMinimum) result.warnings.push(`${player.name} (core) is under target by ${warningMinimum - player.block_count} blocks.`);
    if (!lateArrivalNames.has(player.name) && player.group === 'rotational' && player.block_count < warningMinimum) result.warnings.push(`${player.name} (rotational) is under minimum by ${warningMinimum - player.block_count} blocks.`);
    if (!lateArrivalNames.has(player.name) && ['developing', 'developmental'].includes(player.group) && player.block_count < warningMinimum) result.warnings.push(`${player.name} (developmental) is under minimum by ${warningMinimum - player.block_count} blocks.`);
    if (['developing', 'developmental'].includes(player.group) && player.block_count > player.maximum_blocks) result.warnings.push(`${player.name} (developmental) exceeded target by ${player.block_count - player.maximum_blocks} blocks.`);
    if (player.group === 'rotational_gk' && player.gk_blocks === 0) result.warnings.push(`${player.name} is rotational_gk but received no GK blocks.`);
  }
  return result;
}
