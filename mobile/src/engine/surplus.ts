import type { Game, Player, RotationResult } from './models';

export function computeSurplus(game: Game, roster: Player[]): RotationResult {
  const result: RotationResult = { timeline: [], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, formation: game.formation, gk_assignment: game.gk_assignment } };
  for (const player of roster) {
    result.block_counts[player.name] = player.block_count;
    result.position_summary[player.name] = { ...player.position_usage };
    if (player.primary_positions.includes('GK')) result.gk_summary[player.name] = { gk: player.gk_blocks, field: player.field_blocks, bench: player.bench_count };
    if (player.group.startsWith('core') && player.block_count < player.minimum_blocks) result.warnings.push(`${player.name} (core) is under target by ${player.minimum_blocks - player.block_count} blocks.`);
    if (['developing', 'developmental'].includes(player.group) && player.block_count > player.maximum_blocks) result.warnings.push(`${player.name} (developmental) exceeded target by ${player.block_count - player.maximum_blocks} blocks.`);
    if (player.group === 'rotational_gk' && player.gk_blocks === 0) result.warnings.push(`${player.name} is rotational_gk but received no GK blocks.`);
  }
  return result;
}
