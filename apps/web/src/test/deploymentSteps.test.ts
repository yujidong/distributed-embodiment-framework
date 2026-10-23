import { describe, expect, it } from 'vitest';

import type { DeploymentStepInput } from '../lib/deploymentSteps';
import { DEPLOYMENT_STEPS, isStepComplete, suggestStep } from '../lib/deploymentSteps';

const base: DeploymentStepInput = {
  hassStatus: null,
  boundCount: 0,
  pendingCount: null,
  estopKnown: false,
};

describe('DEPLOYMENT_STEPS', () => {
  it('declares the four wizard steps in order', () => {
    expect(DEPLOYMENT_STEPS.map(s => s.id)).toEqual(['connect', 'bind', 'safety', 'test']);
  });
});

describe('isStepComplete', () => {
  it('connect requires configured AND ready', () => {
    expect(isStepComplete('connect', base)).toBe(false);
    expect(
      isStepComplete('connect', { ...base, hassStatus: { configured: false, state: 'unconfigured' } }),
    ).toBe(false);
    expect(
      isStepComplete('connect', { ...base, hassStatus: { configured: true, state: 'connecting' } }),
    ).toBe(false);
    expect(
      isStepComplete('connect', { ...base, hassStatus: { configured: true, state: 'disconnected' } }),
    ).toBe(false);
    expect(
      isStepComplete('connect', { ...base, hassStatus: { configured: true, state: 'ready' } }),
    ).toBe(true);
  });

  it('bind requires at least one hass-bound device', () => {
    expect(isStepComplete('bind', base)).toBe(false);
    expect(isStepComplete('bind', { ...base, boundCount: 1 })).toBe(true);
  });

  it('safety requires zero pending commands and a known estop state', () => {
    expect(isStepComplete('safety', base)).toBe(false);
    expect(isStepComplete('safety', { ...base, pendingCount: 0, estopKnown: false })).toBe(false);
    expect(isStepComplete('safety', { ...base, pendingCount: null, estopKnown: true })).toBe(false);
    expect(isStepComplete('safety', { ...base, pendingCount: 2, estopKnown: true })).toBe(false);
    expect(isStepComplete('safety', { ...base, pendingCount: 0, estopKnown: true })).toBe(true);
  });

  it('test never completes (a tool, not a gate)', () => {
    const allReady: DeploymentStepInput = {
      hassStatus: { configured: true, state: 'ready' },
      boundCount: 3,
      pendingCount: 0,
      estopKnown: true,
    };
    expect(isStepComplete('test', allReady)).toBe(false);
  });
});

describe('suggestStep', () => {
  it('walks to the first incomplete gate', () => {
    expect(suggestStep(base)).toBe('connect');
    expect(
      suggestStep({ ...base, hassStatus: { configured: true, state: 'ready' } }),
    ).toBe('bind');
    expect(
      suggestStep({ ...base, hassStatus: { configured: true, state: 'ready' }, boundCount: 2 }),
    ).toBe('safety');
  });

  it('lands on test once every gate is satisfied', () => {
    expect(
      suggestStep({
        hassStatus: { configured: true, state: 'ready' },
        boundCount: 1,
        pendingCount: 0,
        estopKnown: true,
      }),
    ).toBe('test');
  });
});
