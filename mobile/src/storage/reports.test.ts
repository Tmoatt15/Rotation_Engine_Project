import { describe, expect, it } from 'vitest';

import { deleteReport, renameReport } from './reports';

type FakeDatabase = Parameters<typeof renameReport>[0];

function fakeDatabase(changes: number): FakeDatabase {
  return { runAsync: async () => ({ changes, lastInsertRowId: 0 }) } as unknown as FakeDatabase;
}

describe('saved report storage', () => {
  it('rejects rename and delete for missing reports', async () => {
    await expect(renameReport(fakeDatabase(0), 'missing', 'New name')).rejects.toThrow('After-game report was not found.');
    await expect(deleteReport(fakeDatabase(0), 'missing')).rejects.toThrow('After-game report was not found.');
  });

  it('allows rename and delete for existing reports', async () => {
    await expect(renameReport(fakeDatabase(1), 'report-1', 'New name')).resolves.toBeUndefined();
    await expect(deleteReport(fakeDatabase(1), 'report-1')).resolves.toBeUndefined();
  });
});
