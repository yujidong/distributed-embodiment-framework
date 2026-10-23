/**
 * @vitest-environment node
 *
 * T-201 flow node invoker tests: deviceId pinning at RUN time (the
 * createFlowNodeInvoker seam) — pinned actuation, teaching errors, and the
 * deviceId landing in PlanNodeInvocation (which the executor copies into
 * node results / the run ledger).
 *
 * Agents are CognitiveAgent-shaped mocks: the invoker only touches
 * resourceManager.getAllResources() and executeDeviceCapability().
 */

import { describe, it, expect, vi } from 'vitest';

import type { CognitiveAgent } from '../../agent/CognitiveAgent.js';
import { createFlowNodeInvoker } from '../flow-invoker.js';

interface MockResource {
  id: string;
  getCapabilities: () => Array<{ name: string }>;
}

function makeResource(id: string, capabilities: string[]): MockResource {
  return { id, getCapabilities: () => capabilities.map(name => ({ name })) };
}

function makeAgent(resources: MockResource[]): CognitiveAgent {
  const exec = vi.fn(async () => ({ success: true, result: { ok: true } }));
  const agent = {
    resourceManager: { getAllResources: () => resources },
    executeDeviceCapability: exec,
  } as unknown as CognitiveAgent & { executeDeviceCapability: typeof exec };
  return agent;
}

function harness(zoneOf?: (deviceId: string) => string | undefined) {
  const resources = [
    makeResource('gate-1', ['turn-on', 'turn-off', 'gate-control']),
    makeResource('siren-1', ['turn-on', 'turn-off', 'alert']),
  ];
  const agent = makeAgent(resources);
  const agents = new Map<string, CognitiveAgent>([['sec-agent', agent]]);
  return {
    agent,
    invoker: createFlowNodeInvoker(agents, undefined, zoneOf),
  };
}

describe('createFlowNodeInvoker — T-201 deviceId pinning', () => {
  it('actuates exactly the pinned device and reports its id', async () => {
    const h = harness();
    const invocation = await h.invoker(
      { id: 'n1', capability: 'turn-off', deviceId: 'gate-1' },
      'sec-agent',
    );
    expect(invocation.success).toBe(true);
    expect(invocation.deviceId).toBe('gate-1');
    expect(h.agent.executeDeviceCapability).toHaveBeenCalledWith(
      'gate-1', 'turn-off', expect.objectContaining({ agentId: 'sec-agent' }),
    );
  });

  it('fails with a teaching error when the pin is not a bound device', async () => {
    const h = harness();
    const invocation = await h.invoker(
      { id: 'n1', capability: 'turn-off', deviceId: 'someone-elses-lock' },
      'sec-agent',
    );
    expect(invocation.success).toBe(false);
    expect(invocation.error).toContain("pinned deviceId 'someone-elses-lock' is not one of assignee");
    expect(h.agent.executeDeviceCapability).not.toHaveBeenCalled();
  });

  it('fails when the pinned device does not provide the capability', async () => {
    const h = harness();
    const invocation = await h.invoker(
      { id: 'n1', capability: 'cooling', deviceId: 'gate-1' },
      'sec-agent',
    );
    expect(invocation.success).toBe(false);
    expect(invocation.error).toContain("pinned device 'gate-1' does not provide capability 'cooling'");
  });

  it('refuses a pinned device outside the trigger zone', async () => {
    const h = harness(id => (id === 'siren-1' ? 'lobby' : 'gatehouse'));
    const invocation = await h.invoker(
      { id: 'n1', capability: 'turn-off', deviceId: 'siren-1' },
      'sec-agent',
      { zoneId: 'gatehouse' },
    );
    expect(invocation.success).toBe(false);
    expect(invocation.error).toContain('refusing to actuate a device in another zone');
  });

  it('unpinned nodes keep first-match semantics but now report the device id', async () => {
    const h = harness();
    const invocation = await h.invoker({ id: 'n1', capability: 'turn-off' }, 'sec-agent');
    expect(invocation.success).toBe(true);
    expect(invocation.deviceId).toBe('gate-1');
  });

  it('carries the deviceId on failure too (audit of the attempted device)', async () => {
    const resources = [makeResource('lamp-1', ['turn-on'])];
    const agent = {
      resourceManager: { getAllResources: () => resources },
      executeDeviceCapability: vi.fn(async () => ({ success: false, error: 'physics refused' })),
    } as unknown as CognitiveAgent;
    const invoker = createFlowNodeInvoker(
      new Map([['a', agent]]), undefined, () => 'zone-a',
    );
    const invocation = await invoker({ id: 'n1', capability: 'turn-on', deviceId: 'lamp-1' }, 'a');
    expect(invocation.success).toBe(false);
    expect(invocation.deviceId).toBe('lamp-1');
    expect(invocation.error).toContain('physics refused');
  });
});
