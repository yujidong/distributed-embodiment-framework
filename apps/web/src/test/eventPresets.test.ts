import { describe, expect, it } from 'vitest';

import { QUICK_EVENT_PRESETS } from '../lib/eventPresets';

describe('QUICK_EVENT_PRESETS', () => {
  it('offers the four W5 quick presets in order', () => {
    expect(QUICK_EVENT_PRESETS.map(p => p.labelKey)).toEqual([
      'personEnter',
      'temperatureHigh',
      'temperatureRecover',
      'smokeAlarm',
    ]);
  });

  it('person-enter drives occupancy with a numeric headcount', () => {
    const preset = QUICK_EVENT_PRESETS.find(p => p.labelKey === 'personEnter');
    expect(preset).toMatchObject({ parameter: 'occupancy', value: 20, severity: 'low' });
  });

  it('temperature presets bracket the comfort band', () => {
    const high = QUICK_EVENT_PRESETS.find(p => p.labelKey === 'temperatureHigh');
    const recover = QUICK_EVENT_PRESETS.find(p => p.labelKey === 'temperatureRecover');
    expect(high).toMatchObject({ parameter: 'temperature', value: 34, severity: 'high' });
    expect(recover).toMatchObject({ parameter: 'temperature', value: 24, severity: 'medium' });
  });

  it('smoke uses a numeric value matching the PhysicalEnvironment registration', () => {
    const preset = QUICK_EVENT_PRESETS.find(p => p.labelKey === 'smokeAlarm');
    // PhysicalParameter.SMOKE is registered as a numeric SimpleFunctionModel;
    // the engine also accepts boolean true, numeric 1 keeps one value shape.
    expect(preset).toMatchObject({ parameter: 'smoke', severity: 'critical' });
    expect(typeof preset?.value).toBe('number');
  });

  it('types and label keys are unique', () => {
    expect(new Set(QUICK_EVENT_PRESETS.map(p => p.type)).size).toBe(QUICK_EVENT_PRESETS.length);
    expect(new Set(QUICK_EVENT_PRESETS.map(p => p.labelKey)).size).toBe(QUICK_EVENT_PRESETS.length);
  });
});
