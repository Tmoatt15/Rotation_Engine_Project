let enabled = false;

export function isRedesignEngineEnabled(): boolean {
  return enabled;
}

export function setRedesignEngineEnabled(value: boolean): void {
  enabled = value;
}
