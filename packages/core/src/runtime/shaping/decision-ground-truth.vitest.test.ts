/**
 * @vitest-environment node
 *
 * BUG-01 — decision ground truth (deriveDecisionGroundTruth): declared
 * Type-A coverage is demoted to Type-E when the agent's OWN devices cannot
 * physically act on the event (the same structural backing check the
 * DualTriggerACManager honesty gate runs, so a gate-converted decision and
 * the recorded truth agree). Legacy callers (no device surface) keep the
 * pre-BUG-01 coverage × gap truth; propagation-coverage truth is untouched.
 */

import { describe, it, expect } from 'vitest';
import { deriveDecisionGroundTruth } from './collaboration.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { PlannerDeviceInfo } from '../../decision/rule-actuation-planner.js';

const ZONE = 'zone-a';

function makeEvent(payload: Record<string, unknown>): SystemEvent {
  return {
    id: 'evt-1',
    type: 'generic.event',
    source: 'device-1',
    timestamp: new Date(),
    payload: { zoneId: ZONE, ...payload },
    priority: 'normal',
  };
}

const contextWithCoverage = {
  capabilities: ['security-patrol', 'read-occupancy'],
  actuatorZoneIds: [ZONE],
  adjacentZoneIds: [],
};

const sensorOnlyDevices: PlannerDeviceInfo[] = [
  { deviceId: 'cam-1', type: 'camera', capabilities: ['read-occupancy', 'detect-smoke'], zoneId: ZONE },
];

describe('deriveDecisionGroundTruth — BUG-01 backing-aware Type-A', () => {
  it('legacy call (no device surface): coverage × no gap stays Type-A handle_independently', () => {
    const gt = deriveDecisionGroundTruth(
      contextWithCoverage,
      makeEvent({ requiredCapabilities: ['security-patrol'] }),
    );
    expect(gt).toEqual({ correctDecision: 'handle_independently', interactionType: 'A' });
  });

  it('direct coverage without any device backing demotes to Type-E initiate_ac', () => {
    const gt = deriveDecisionGroundTruth(
      contextWithCoverage,
      makeEvent({ requiredCapabilities: ['security-patrol'] }),
      sensorOnlyDevices,
    );
    expect(gt).toEqual({ correctDecision: 'initiate_ac', interactionType: 'E' });
  });

  it('direct coverage with a backed requirement (offer-rule lane) stays Type-A', () => {
    const pile: PlannerDeviceInfo[] = [
      { deviceId: 'pile-1', type: 'charging-pile', capabilities: ['turn-off', 'read-power'], zoneId: ZONE },
    ];
    const gt = deriveDecisionGroundTruth(
      { capabilities: ['load-management'], actuatorZoneIds: [ZONE], adjacentZoneIds: [] },
      makeEvent({ requiredCapabilities: ['load-management'] }),
      pile,
    );
    expect(gt).toEqual({ correctDecision: 'handle_independently', interactionType: 'A' });
  });

  it('temperature event: a read-temperature sensor does not back Type-A', () => {
    const sensor: PlannerDeviceInfo[] = [
      { deviceId: 'ts-1', type: 'temperature-sensor', capabilities: ['read-temperature'], zoneId: ZONE },
    ];
    const gt = deriveDecisionGroundTruth(
      { capabilities: ['temperature-control'], actuatorZoneIds: [ZONE], adjacentZoneIds: [] },
      makeEvent({ parameter: 'temperature', eventType: 'temperature-anomaly' }),
      sensor,
    );
    expect(gt).toEqual({ correctDecision: 'initiate_ac', interactionType: 'E' });
  });

  it('propagation coverage truth is untouched by the backing check', () => {
    const gt = deriveDecisionGroundTruth(
      { capabilities: ['security-patrol'], actuatorZoneIds: ['zone-b'], adjacentZoneIds: [ZONE] },
      makeEvent({ requiredCapabilities: ['security-patrol'] }),
      sensorOnlyDevices,
    );
    expect(gt).toEqual({ correctDecision: 'handle_independently', interactionType: 'A' });
  });
});
