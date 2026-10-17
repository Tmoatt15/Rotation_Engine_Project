import { describe, expect, it } from 'vitest';

import { migrateExactPositions, migrateGeneralPositions } from './position-migration';

describe('roster position migration', () => {
  it('renames exact positions and deduplicates the migrated values', () => {
    expect(migrateExactPositions(['LAM', 'LM', 'RAM', 'CB', 'lam'])).toEqual(['LM', 'RM', 'CB']);
  });

  it('converts general Any to None and remains idempotent', () => {
    const migrated = migrateGeneralPositions(['ANY', 'D', 'NONE', 'any']);
    expect(migrated).toEqual(['NONE', 'D']);
    expect(migrateGeneralPositions(migrated)).toEqual(migrated);
  });
});
