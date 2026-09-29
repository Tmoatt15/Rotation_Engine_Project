export function assertCompleteSchedule(errors: string[]): void {
  if (errors.length) throw new Error(`Unable to generate a complete schedule. ${errors.join(' ')}`);
}