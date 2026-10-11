import type { DemandModel, DemandSlot, NormalizedGame, RedesignZone } from './model';

export const ZONE_POSITIONS: Record<RedesignZone, ReadonlySet<string>> = {
  CM: new Set(['LCM', 'CM', 'RCM', 'CDM', 'CAM']),
  CB: new Set(['LCB', 'CB', 'RCB']),
  ST: new Set(['ST', 'CF']),
  WIDE: new Set(['LB', 'RB', 'LWB', 'RWB', 'LM', 'RM', 'LW', 'RW', 'LF', 'RF']),
};

function zoneFor(slot: string): RedesignZone {
  return (Object.entries(ZONE_POSITIONS).find(([, positions]) => positions.has(slot))?.[0] ?? 'WIDE') as RedesignZone;
}

function groupFor(slot: string): 'D' | 'M' | 'F' {
  if (['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(slot)) return 'D';
  if (['LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM'].includes(slot)) return 'M';
  return 'F';
}

function slotsForFormation(formation: string): string[] {
  if (formation === '2-1-2-1') return ['LB', 'RB', 'CM', 'LW', 'RW', 'ST'];
  if (formation === '4-2-3-1') return ['LB', 'LCB', 'RCB', 'RB', 'CDM', 'CM', 'LW', 'CAM', 'RW', 'ST'];
  const numbers = formation.split('-').map(Number);
  if (numbers.length === 2) return [...Array.from({ length: numbers[0] }, (_, index) => `D${index + 1}`), ...Array.from({ length: numbers[1] }, (_, index) => `F${index + 1}`)];
  const [defenders, midfielders, forwards] = numbers;
  const defense = defenders === 4 ? ['LB', 'LCB', 'RCB', 'RB'] : defenders === 3 ? ['LCB', 'CB', 'RCB'] : Array.from({ length: defenders }, (_, index) => `D${index + 1}`);
  const midfield = midfielders === 4 ? ['LM', 'LCM', 'RCM', 'RM'] : midfielders === 3 ? ['LM', 'CM', 'RM'] : Array.from({ length: midfielders }, (_, index) => `M${index + 1}`);
  const attack = forwards === 3 ? ['LF', 'CF', 'RF'] : forwards === 2 ? ['LF', 'RF'] : forwards === 1 ? ['ST'] : Array.from({ length: forwards }, (_, index) => `F${index + 1}`);
  return [...defense, ...midfield, ...attack];
}

export function buildDemandModel(game: NormalizedGame): DemandModel {
  const fieldSlots: DemandSlot[] = slotsForFormation(game.formation).map((slot) => ({ slot, group: groupFor(slot), zone: zoneFor(slot) }));
  return {
    fieldSlots,
    goalkeeperRequired: game.format !== '4v4',
    goalkeeperBlocks: game.format === '4v4' ? [0, 0] : [game.totalBlocks / 2, game.totalBlocks / 2],
    slotsPerBlock: fieldSlots.length,
  };
}
