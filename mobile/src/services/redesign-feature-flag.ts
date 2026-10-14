// TEMPORARY (2026-10-14): Shipping engine hidden per Tim's request.
// To restore: change the default back to false and re-enable the engine selector.
let enabled = true;

export function isRedesignEngineEnabled(): boolean {
  return enabled;
}

export function setRedesignEngineEnabled(value: boolean): void {
  enabled = value;
}
