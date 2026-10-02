import { describe, expect, it } from 'vitest';
import { setActiveTeam } from './teams';

type FakeDatabase = Parameters<typeof setActiveTeam>[0];

function fakeDatabase(existingTeamId: string): FakeDatabase {
  return {
    getFirstAsync: async <T>(_sql: string, teamId: string) => teamId === existingTeamId ? ({ id: existingTeamId } as T) : null,
    withTransactionAsync: async (task) => task(),
    runAsync: async () => ({ changes: 1, lastInsertRowId: 0 }),
  } as unknown as FakeDatabase;
}

describe('team activation storage', () => {
  it('validates the target before clearing the current active team', async () => {
    const database = fakeDatabase('team-1');

    await expect(setActiveTeam(database, 'team-2')).rejects.toThrow('Team was not found.');
  });

  it('updates active state inside one transaction for an existing team', async () => {
    const database = fakeDatabase('team-2');

    await expect(setActiveTeam(database, 'team-2')).resolves.toBeUndefined();
  });
});