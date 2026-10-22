export type GamedaySetup = {
  teamId: string;
  unavailable: string[];
  firstHalfGk: string | null;
  secondHalfGk: string | null;
};

let rememberedSetup: GamedaySetup | null = null;

export function getRememberedGamedaySetup(teamId: string): GamedaySetup | null {
  if (!rememberedSetup || rememberedSetup.teamId !== teamId) return null;
  return {
    ...rememberedSetup,
    unavailable: [...rememberedSetup.unavailable],
  };
}

export function rememberGamedaySetup(setup: GamedaySetup): void {
  rememberedSetup = {
    ...setup,
    unavailable: [...setup.unavailable],
  };
}

export function clearRememberedGamedaySetup(teamId?: string): void {
  if (!teamId || rememberedSetup?.teamId === teamId) rememberedSetup = null;
}
