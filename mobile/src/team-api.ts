export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
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
  const response = await fetch(`${API_URL}/teams`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail ?? 'Unable to load teams.');
  const activeTeam = Array.isArray(payload.teams)
    ? payload.teams.find((team: { id?: string; name?: string; active?: boolean }) => team.active && team.id && team.name)
    : null;
  if (!activeTeam?.id) throw new Error('Select an active team first.');
  return { id: activeTeam.id, name: activeTeam.name };
}

export async function getActiveTeamId(): Promise<string> {
  return (await getActiveTeam()).id;
}

export function teamQuery(teamId: string): string {
  return `team_id=${encodeURIComponent(teamId)}`;
}
