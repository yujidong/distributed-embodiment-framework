/**
 * flowWarnings tests (UX-12): the save-time "target device is off" advisory.
 *
 * Trigger rule: an ACTION node pinned (deviceId) to a currently-OFF device
 * warns when the flow's command surface for that device has no turn-on.
 * Device on / present / unknown, an explicit turn-on, an unpinned target or
 * a non-action node never warn.
 */

import { describe, expect, it } from 'vitest';

import type { FlowPlanAnyNode } from '../api/types';
import {
  devicePowerFaceOf,
  isTurnOnCapability,
  offDeviceWarnings,
  type DevicePowerFace,
} from '../lib/flowWarnings';

/** Face lookup from a plain id → face record (absent id = 'unknown'). */
function faceOf(faces: Record<string, DevicePowerFace>) {
  return (deviceId: string): DevicePowerFace => faces[deviceId] ?? 'unknown';
}

describe('devicePowerFaceOf', () => {
  it('mirrors the server coarseDeviceStatus predicate on full-tier state', () => {
    expect(devicePowerFaceOf({ state: { power: true } })).toBe('on');
    expect(devicePowerFaceOf({ state: { status: 'on' } })).toBe('on');
    expect(devicePowerFaceOf({ state: { status: 'active' } })).toBe('on');
    expect(devicePowerFaceOf({ state: { power: false } })).toBe('off');
    expect(devicePowerFaceOf({ state: { temperature: 36.6 } })).toBe('present');
    expect(devicePowerFaceOf({ state: {} })).toBe('present');
  });

  it('prefers the pre-derived coarse status on S2-redacted entries', () => {
    expect(devicePowerFaceOf({ state: {}, status: 'off' })).toBe('off');
    expect(devicePowerFaceOf({ state: {}, status: 'on' })).toBe('on');
    expect(devicePowerFaceOf({ state: {}, status: 'present' })).toBe('present');
  });
});

describe('isTurnOnCapability', () => {
  it('accepts the canonical name and the simulation command aliases', () => {
    expect(isTurnOnCapability('turn-on')).toBe(true);
    expect(isTurnOnCapability('turn_on')).toBe(true);
    expect(isTurnOnCapability('Turn-On')).toBe(true);
    expect(isTurnOnCapability('poweron')).toBe(true);
    expect(isTurnOnCapability('light-on')).toBe(true);
    expect(isTurnOnCapability('set-brightness')).toBe(false);
    expect(isTurnOnCapability('turn-off')).toBe(false);
  });
});

describe('offDeviceWarnings', () => {
  it('warns on an off-device action node with no turn-on in the flow', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'dim', capability: 'set-brightness', deviceId: 'lamp-1', params: { level: 60 } },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'off' }))).toEqual([
      { nodeId: 'dim', deviceId: 'lamp-1', capability: 'set-brightness' },
    ]);
  });

  it('stays silent when a turn-on is pinned to the same device', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'on', capability: 'turn-on', deviceId: 'lamp-1' },
      { id: 'dim', capability: 'set-brightness', deviceId: 'lamp-1', dependsOn: ['on'] },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'off' }))).toEqual([]);
  });

  it('stays silent when an UNPINNED turn-on may land on the device', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'on', capability: 'turn-on' },
      { id: 'dim', capability: 'set-brightness', deviceId: 'lamp-1', dependsOn: ['on'] },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'off' }))).toEqual([]);
  });

  it('a turn-on pinned to a DIFFERENT device does not suppress the warning', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'on', capability: 'turn-on', deviceId: 'lamp-2' },
      { id: 'dim', capability: 'set-brightness', deviceId: 'lamp-1' },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'off', 'lamp-2': 'off' }))).toEqual([
      { nodeId: 'dim', deviceId: 'lamp-1', capability: 'set-brightness' },
    ]);
  });

  it('stays silent when the device is on, present or unknown', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'dim', capability: 'set-brightness', deviceId: 'lamp-1' },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'on' }))).toEqual([]);
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'present' }))).toEqual([]);
    expect(offDeviceWarnings(nodes, faceOf({}))).toEqual([]);
  });

  it('stays silent for turn-on nodes themselves and unpinned action nodes', () => {
    const nodes: FlowPlanAnyNode[] = [
      { id: 'on', capability: 'turn-on', deviceId: 'lamp-2' },
      { id: 'dim', capability: 'set-brightness' },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-2': 'off' }))).toEqual([]);
  });

  it('ignores delegate nodes (no static command surface)', () => {
    const nodes: FlowPlanAnyNode[] = [
      {
        id: 'judge',
        delegate: { question: 'dim the lamp?', mode: 'actuating' },
      },
    ];
    expect(offDeviceWarnings(nodes, faceOf({ 'lamp-1': 'off' }))).toEqual([]);
  });
});
