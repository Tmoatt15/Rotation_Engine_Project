import { describe, expect, it } from 'vitest';

import { assertCompleteSchedule } from './schedule-validation';

describe('schedule generation boundary', () => {
  it('allows complete schedules through', () => {
    expect(() => assertCompleteSchedule([])).not.toThrow();
  });

  it('blocks schedules with structural errors', () => {
    expect(() => assertCompleteSchedule(['Block 5: one or more required slots are unassigned.']))
      .toThrow('Unable to generate a complete schedule.');
  });
});