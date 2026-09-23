import type { SeasonRosterPlayer } from '@/engine/models';

type FormationPositionRow = { label: string; groupPositions: string[]; exactPositions: string[] };

export function formationPositionRows(formation: string): FormationPositionRow[] {
  const specialFormations: Record<string, Record<string, string[]>> = {
    '2-1-2-1': { D: ['LB', 'RB'], M: ['CDM', 'LM', 'RM'], F: ['F'] },
    '4-2-3-1': { D: ['LB', 'LCB', 'RCB', 'RB'], M: ['LAM', 'CAM', 'RAM', 'LDM', 'RDM'], F: ['F'] },
  };
  const slots = specialFormations[formation] ?? (() => {
    const parts = formation.split('-').map(Number);
    const defenders = parts[0] ?? 0;
    const midfielders = parts.length === 2 ? 0 : parts[1] ?? 0;
    const forwards = parts.length === 2 ? parts[1] ?? 0 : parts[2] ?? 0;
    const slotNames: Record<string, Record<number, string[]>> = {
      D: { 1: ['CB'], 2: ['LB', 'RB'], 3: ['LB', 'CB', 'RB'], 4: ['LB', 'LCB', 'RCB', 'RB'], 5: ['LWB', 'LCB', 'CB', 'RCB', 'RWB'] },
      M: { 1: ['CM'], 2: ['LCM', 'RCM'], 3: ['LM', 'CM', 'RM'], 4: ['LM', 'LCM', 'RCM', 'RM'], 5: ['LM', 'LCM', 'CM', 'RCM', 'RM'] },
      F: { 1: ['ST'], 2: ['LF', 'RF'], 3: ['LF', 'CF', 'RF'], 4: ['LW', 'LS', 'RS', 'RW'] },
    };
    return {
      D: slotNames.D[defenders] ?? Array.from({ length: defenders }, (_, index) => `D${index + 1}`),
      M: slotNames.M[midfielders] ?? Array.from({ length: midfielders }, (_, index) => `M${index + 1}`),
      F: slotNames.F[forwards] ?? Array.from({ length: forwards }, (_, index) => `F${index + 1}`),
    };
  })();
  return [
    { label: 'F', groupPositions: ['F'], exactPositions: slots.F },
    { label: 'M', groupPositions: ['M'], exactPositions: slots.M },
    { label: 'D', groupPositions: ['D'], exactPositions: slots.D },
  ];
}

export function rosterMatchesFormation(formation: string, players: SeasonRosterPlayer[]): boolean {
  const rows = formationPositionRows(formation);
  const exactPositions = new Set(rows.flatMap((row) => row.exactPositions.map((position) => position.toUpperCase())));
  const groupPositions = new Set(rows.filter((row) => row.exactPositions.length > 0).flatMap((row) => row.groupPositions));
  const allowed = new Set(['ANY', 'GK', ...groupPositions, ...exactPositions]);

  return players.every((player) => {
    const generalPositions = player.general_positions ?? [];
    const primaryPositions = player.primary_positions ?? [];
    const generalAllowsPrimaryAny = generalPositions.some((position) => {
      const normalized = position.toUpperCase();
      return normalized === 'ANY' || groupPositions.has(normalized);
    });
    return [
      ...generalPositions,
      ...primaryPositions.filter((position) => position.toUpperCase() !== 'ANY'),
      ...(player.backup_positions ?? []),
      ...(player.excluded_positions ?? []),
    ].every((position) => allowed.has(position.toUpperCase()))
      && (!primaryPositions.some((position) => position.toUpperCase() === 'ANY') || generalAllowsPrimaryAny);
  });
}