import { describe, expect, it } from 'vitest';
import { deleteSchedule, renameSchedule } from './schedules';

type FakeDatabase = Parameters<typeof renameSchedule>[0];

function fakeDatabase(changes: number): FakeDatabase {
  return {
    runAsync: async () => ({ changes, lastInsertRowId: 0 }),
  } as unknown as FakeDatabase;
}

describe('saved schedule storage', () => {
  it('rejects renaming a missing schedule', async () => {
    await expect(renameSchedule(fakeDatabase(0), 'missing', 'New name')).rejects.toThrow('Saved schedule was not found.');
  });

  it('rejects deleting a missing schedule', async () => {
    await expect(deleteSchedule(fakeDatabase(0), 'missing')).rejects.toThrow('Saved schedule was not found.');
  });

  it('allows updates that affect an existing schedule', async () => {
    await expect(renameSchedule(fakeDatabase(1), 'schedule-1', 'New name')).resolves.toBeUndefined();
    await expect(deleteSchedule(fakeDatabase(1), 'schedule-1')).resolves.toBeUndefined();
  });
});