import { getDatabase } from '@/storage/database';
import { getActiveTeam as getStoredActiveTeam } from '@/storage/teams';
const teamChangeListeners = new Set<() => void>();

export type ActiveTeam = { id: string; name: string };

export function subscribeToTeamChanges(listener: () => void): () => void {
  teamChangeListeners.add(listener);
  return () => teamChangeListeners.delete(listener);
}

export function notifyTeamChanged(): void {
  teamChangeListeners.forEach((listener) => listener());
}

export async function getActiveTeam(): Promise<ActiveTeam> {
  const activeTeam = await getStoredActiveTeam(await getDatabase());
  if (!activeTeam?.id) throw new Error('Select an active team first.');
  return { id: activeTeam.id, name: activeTeam.name };
}

export async function getActiveTeamId(): Promise<string> {
  return (await getActiveTeam()).id;
}

