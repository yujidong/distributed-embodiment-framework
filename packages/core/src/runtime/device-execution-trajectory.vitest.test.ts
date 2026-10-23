/**
 * @vitest-environment node
 *
 * R6-E-F10: device-command execution receipts land in the trajectory.
 *
 * Before this, the trajectory carried only the decision's PLAN face
 * (actionPlan.deviceActions) — execution and its result were the largest
 * observability blind spot (the live path's goalAchieved was structurally
 * absent). EngineRuntime subscribes DEVICE_OPERATION_EXECUTED and writes one
 * 'device-execution' record per command:
 *   - the REAL command path (executeDeviceCommand → coordinator → device)
 *     records exactly once (T-102: the device's own emission + the
 *     coordinator echo dedupe first-wins);
 *   - failures record too (success:false + error);
 *   - the invocation-context actor distinguishes flow-triggered
 *     ('engine:flow:<flowId>') from agent/user-triggered commands;
 *   - a command executed while an injection event is in flight carries that
 *     eventId (decision attribution); outside an event it is 'unattributed'.
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of the
 * contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventPriority, EventType } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

// ---------------------------------------------------------------------------
// Scenario + helpers (mirrors reputation.vitest.test.ts)
// ---------------------------------------------------------------------------

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'device-exec-trajectory-test', name: 'Device Execution Trajectory Test' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function makeRuntime(): EngineRuntime {
  const dir = mkdtempSync(join(tmpdir(), 'device-exec-trajectory-'));
  tempDirs.push(dir);
  const runtime = new EngineRuntime(twoZoneScenario(), { trajectoryDir: dir });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** Publish directly on the runtime's bus (in-package test seam). */
function publish(runtime: EngineRuntime, type: EventType, payload: Record<string, unknown>): void {
  const envCenter = (runtime as unknown as {
    envCenter: { eventManager: { publish: (event: unknown) => void } };
  }).envCenter;
  envCenter.eventManager.publish({
    type,
    source: 'device-exec-trajectory-test',
    payload,
    priority: EventPriority.NORMAL,
    metadata: {},
  });
}

function readRecords(runtime: EngineRuntime): Array<Record<string, any>> {
  const filePath = runtime.getTrajectoryFilePath();
  if (filePath === null) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function deviceExecutionRecords(runtime: EngineRuntime): Array<Record<string, any>> {
  return readRecords(runtime).filter(r => r.kind === 'device-execution');
}

// ---------------------------------------------------------------------------

describe('R6-E-F10 — device-execution trajectory receipts', () => {
  it('the REAL command path records exactly one receipt (T-102: device emission + coordinator echo deduped)', async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeDeviceCommand(
      'hvac-b',
      'temperature-control',
      { target: 22 },
      { actor: 'user:test-operator' },
    );
    expect(result.success).toBe(true);
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r.deviceExecution.deviceId).toBe('hvac-b');
    expect(r.deviceExecution.command).toBe('temperature-control');
    expect(r.deviceExecution.success).toBe(true);
    expect(r.deviceExecution.params).toBe(JSON.stringify({ target: 22 }));
    expect(typeof r.deviceExecution.executionTime).toBe('number');
    // Attribution: the managing agent (the echo's agentId agrees); the actor
    // distinguishes WHO drove the command.
    expect(r.agentId).toBe('actuator-agent');
    expect(r.deviceExecution.actor).toBe('user:test-operator');
    // No injection event in flight — the honest 'unattributed' marker.
    expect(r.eventId).toBe('unattributed');
    expect(r.decision).toBe('executed');
  });

  it('a command executed while an event is in flight carries that eventId (decision correlation)', () => {
    const runtime = makeRuntime();
    (runtime as unknown as { inflightEventId?: string }).inflightEventId = 'evt-inject-7';
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      commandName: 'temperature-control',
      params: { target: 20 },
      result: { success: true, result: { targetTemperature: 20 }, executionTime: 2 },
      executionTime: 2,
      actor: 'engine:agent:actuator-agent',
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    expect(records[0].eventId).toBe('evt-inject-7');
    expect(records[0].agentId).toBe('actuator-agent');
    expect(records[0].deviceExecution.actor).toBe('engine:agent:actuator-agent');
  });

  it('R102: an eventId stamped from the invocation context wins over the inflight fallback (AC-lane threading)', () => {
    const runtime = makeRuntime();
    (runtime as unknown as { inflightEventId?: string }).inflightEventId = 'evt-inject-7';
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      commandName: 'ventilation',
      params: {},
      result: { success: true, result: {}, executionTime: 1 },
      executionTime: 1,
      actor: 'engine:agent:actuator-agent',
      // The AC executor threads the collaboration's triggerEventId into the
      // command context — it wins over the (stale/closed) inflight window.
      eventId: 'evt-smoke-42',
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    expect(records[0].eventId).toBe('evt-smoke-42');
  });

  it('R102: a payload eventId also lands when no event is in flight (no more unattributed for threaded lanes)', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      commandName: 'ventilation',
      params: {},
      result: { success: true, result: {}, executionTime: 1 },
      executionTime: 1,
      actor: 'engine:agent:actuator-agent',
      eventId: 'evt-co2-9',
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    expect(records[0].eventId).toBe('evt-co2-9');
  });

  it('a FAILED command records success:false + error (coordinator error shape)', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'temperature-control',
      error: 'Command execution timed out after 5000ms',
      executionTime: 5000,
      success: false,
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r.agentId).toBe('actuator-agent'); // the echo carries the commanding agent
    expect(r.deviceExecution.success).toBe(false);
    expect(r.deviceExecution.error).toContain('timed out');
    expect(r.decision).toBe('failed');
  });

  it('flow-triggered commands record with the flow actor (actor distinguishes the trigger source)', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      commandName: 'turn-off',
      result: { success: true, result: { power: 'off' }, executionTime: 1 },
      executionTime: 1,
      actor: 'engine:flow:post-class-shutdown',
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    expect(records[0].deviceExecution.actor).toBe('engine:flow:post-class-shutdown');
    expect(records[0].deviceExecution.success).toBe(true);
  });

  it('T-102: the same command landing on both bus seams records once (first wins)', () => {
    const runtime = makeRuntime();
    const params = { target: 23 };
    // The device's own emission (richest: deviceName + result wrapper).
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      deviceName: 'HVAC B',
      commandName: 'temperature-control',
      params,
      result: { success: true, result: { targetTemperature: 23 }, executionTime: 2 },
      executionTime: 2,
    });
    // The coordinator echo ~2ms later (carries agentId) — same dedupe key.
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'temperature-control',
      params,
      result: { success: true, result: { targetTemperature: 23 }, executionTime: 2 },
      executionTime: 2,
    });
    const records = deviceExecutionRecords(runtime);
    expect(records).toHaveLength(1);
    // First-wins keeps the device's own emission — agentId falls back to the
    // managing agent (the reputation attribution rule).
    expect(records[0].agentId).toBe('actuator-agent');
    expect(records[0].deviceExecution.deviceName).toBe('HVAC B');
    // A DIFFERENT command right after is NOT deduped.
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-b',
      commandName: 'turn-off',
      result: { success: true, result: { power: 'off' }, executionTime: 1 },
      executionTime: 1,
    });
    expect(deviceExecutionRecords(runtime)).toHaveLength(2);
  });
});
