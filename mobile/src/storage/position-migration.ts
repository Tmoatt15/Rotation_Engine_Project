const positionRenames: Record<string, string> = { LAM: 'LM', RAM: 'RM' };

export function migrateExactPositions(positions: readonly string[]): string[] {
  return [...new Set(positions.map((position) => {
    const normalized = position.toUpperCase();
    return positionRenames[normalized] ?? normalized;
  }))];
}

export function migrateGeneralPositions(positions: readonly string[]): string[] {
  return [...new Set(positions.map((position) => {
    const normalized = position.toUpperCase();
    return normalized === 'ANY' ? 'NONE' : normalized;
  }))];
}
