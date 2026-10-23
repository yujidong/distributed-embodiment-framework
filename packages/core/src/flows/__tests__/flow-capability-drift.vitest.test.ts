/**
 * @vitest-environment node
 *
 * T1 (R2, u3-F1): flow capability-drift signals — the P0 audit gap where
 * revoking an assignee's capability DECLARATION left the flow executing
 * silently ("succeeding on borrowed authority"). The execution truth is the
 * assignee's DEVICE capability surface (the own-devices-only invoker never
 * consults declarations), so execution semantics are UNCHANGED by design;
 * what must never happen again is silence:
 *
 *   1. run records carry `capabilityDrift` (node id, capability, assignee,
 *      current declared set) exactly when the declaration no longer covers a
 *      node's capability — and never when it does;
 *   2. the flow.executed bus payload rides the same annotation;
 *   3. the late-settable declaration probe (setDeclaredAgentCapabilities)
 *      sees LIVE declarations, so a revocation made AFTER the sim froze its
 *      scenario still annotates the next run;
 *   4. authoring (resolveFlowAssignments) emits a WARNING-level issue for the
 *      same condition — receipt, never a 422 (the device truth stays the
 *      executable contract).
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvoker, PlanNodeInvocation } from '../../workflow/plan-executor.js';
import {
  computeCapabilityDrift,
  FlowEngine,
  resolveFlowAssignments,
  type FlowDefinition,
  type FlowRunRecord,
} from '../index.js';

/** Guard agent whose DECLARED capability set is parameterized per test. */
function scenario(declared: string[]): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'drift-lab', name: 'Drift Lab' },
    zones: [{ id: 'zone-b', adjacentZoneIds: [] }],
    devices: [
      // The DEVICE keeps set-mode: revoking the agent DECLARATION does not
      // touch the device surface — the execution truth survives the revoke.
      { id: 'fan-b1', type: 'fan', capabilities: ['set-mode', 'turn-on'], zoneId: 'zone-b' },
    ],
    agents: [
      {
        id: 'guard-b',
        name: 'WD-值守-B栋',
        capabilities: declared,
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['fan-b1'],
      },
    ],
    events: [],
  });
}

const smokeFlow = (): FlowDefinition => ({
  id: 'flow-smoke',
  name: 'B栋排烟',
  enabled: true,
  trigger: { kind: 'event', eventType: 'fire-alarm', zoneId: 'zone-b' },
  plan: {
    goal: 'clear the smoke',
    nodes: [{ id: 'n1', capability: 'set-mode', assigneeAgentId: 'guard-b' }],
  },
});

const okInvoker: PlanNodeInvoker = async (): Promise<PlanNodeInvocation> => ({
  success: true,
  deviceId: 'fan-b1',
  result: { ok: true },
});

interface HarnessOptions {
  frozenDeclared: string[];
  liveDeclared?: readonly string[] | undefined;
  liveAgentPresent?: boolean;
}

async function runOnce(options: HarnessOptions): Promise<{
  runs: FlowRunRecord[];
  published: Array<{ type: string; payload: Record<string, unknown> }>;
}> {
  const runs: FlowRunRecord[] = [];
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const engine = new FlowEngine({
    scenario: scenario(options.frozenDeclared),
    flowsProvider: () => [smokeFlow()],
    agents: new Map(),
    invoker: okInvoker,
    envStateReader: () => ({ 'zone-b': { smoke: 0 } }),
    publish: (type, payload) => published.push({ type, payload }),
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    ...(options.liveDeclared !== undefined || options.liveAgentPresent === false
      ? {
          declaredAgentCapabilities: () =>
            options.liveAgentPresent === false ? undefined : options.liveDeclared,
        }
      : {}),
  });
  await engine.triggerManually('flow-smoke');
  return { runs, published };
}

describe('flow capability drift (T1, R2 u3-F1)', () => {
  it('declared capability → clean run: no capabilityDrift, status success', async () => {
    const { runs, published } = await runOnce({ frozenDeclared: ['set-mode', 'turn-on'] });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].capabilityDrift).toBeUndefined();
    expect(runs[0].nodeResults.n1?.status).toBe('succeeded');
    expect(published.find(p => p.type === 'flow.executed')?.payload.capabilityDrift).toBeUndefined();
  });

  it('undeclared capability (new sim: frozen scenario lacks it) → drift annotated, run still succeeds', async () => {
    // The device still provides set-mode, so the node EXECUTES; only the
    // agent's declaration no longer covers it.
    const { runs, published } = await runOnce({ frozenDeclared: ['turn-on'] });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success'); // semantics unchanged — degraded, not failed
    expect(runs[0].capabilityDrift).toEqual([
      {
        nodeId: 'n1',
        capability: 'set-mode',
        assigneeAgentId: 'guard-b',
        declaredCapabilities: ['turn-on'],
      },
    ]);
    expect(runs[0].nodeResults.n1?.status).toBe('succeeded');
    const executed = published.find(p => p.type === 'flow.executed');
    expect(executed?.payload.capabilityDrift).toEqual(runs[0].capabilityDrift);
  });

  it('revoked AFTER sim creation (old sim: frozen grant, live probe without it) → drift annotated', async () => {
    // u3's exact shape: the sim froze at 16:26:51 with the declaration still
    // in the snapshot; the revoke landed at 16:29:22. The live declaration
    // probe is what makes the NEXT run honest.
    const { runs } = await runOnce({
      frozenDeclared: ['set-mode', 'turn-on'],
      liveDeclared: ['turn-on'],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].capabilityDrift).toHaveLength(1);
    expect(runs[0].capabilityDrift?.[0]).toMatchObject({
      nodeId: 'n1',
      capability: 'set-mode',
      assigneeAgentId: 'guard-b',
    });
  });

  it('live probe says the declaration is back (re-granted) → no drift despite the frozen gap', async () => {
    const { runs } = await runOnce({
      frozenDeclared: ['turn-on'],
      liveDeclared: ['set-mode', 'turn-on'],
    });
    expect(runs[0].status).toBe('success');
    expect(runs[0].capabilityDrift).toBeUndefined();
  });

  it('unknown agent from the live probe → honestly no annotation (not a guess)', async () => {
    const { runs } = await runOnce({
      frozenDeclared: ['turn-on'],
      liveAgentPresent: false,
    });
    expect(runs[0].status).toBe('success');
    expect(runs[0].capabilityDrift).toBeUndefined();
  });

  describe('computeCapabilityDrift (the one shared oracle)', () => {
    const flow: FlowDefinition = {
      id: 'f',
      name: 'f',
      enabled: true,
      trigger: { kind: 'schedule', everySimSec: 60 },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'a', capability: 'set-mode', assigneeAgentId: 'guard-b' },
          { id: 'b', capability: 'set-mode', assigneeAgentId: 'ghost' },
          { id: 'svc', capability: 'x', service: { serviceId: 's1' } },
        ],
      },
    };

    it('flags only resolvable action nodes whose declaration misses; skips unknown agents and service nodes', () => {
      const drift = computeCapabilityDrift(
        flow,
        new Map([
          ['a', 'guard-b'],
          ['b', 'ghost'],
          ['svc', ':service-agreement:'],
        ]),
        agentId => (agentId === 'guard-b' ? ['turn-on'] : undefined),
      );
      expect(drift).toEqual([
        {
          nodeId: 'a',
          capability: 'set-mode',
          assigneeAgentId: 'guard-b',
          declaredCapabilities: ['turn-on'],
        },
      ]);
    });

    it('no drift when the declaration covers the capability', () => {
      const drift = computeCapabilityDrift(
        flow,
        new Map([['a', 'guard-b']]),
        () => ['set-mode'],
      );
      expect(drift).toEqual([]);
    });
  });

  describe('authoring warning (resolveFlowAssignments)', () => {
    it('warns (not errors) when the assignee declaration misses the node capability', () => {
      const { assignments, issues } = resolveFlowAssignments(smokeFlow(), scenario(['turn-on']));
      expect(assignments.get('n1')).toBe('guard-b');
      const warnings = issues.filter(issue => issue.level === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].nodeId).toBe('n1');
      expect(warnings[0].message).toContain("does not declare capability 'set-mode'");
      expect(warnings[0].message).toContain('guard-b');
      expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    });

    it('no warning when the declaration covers the capability', () => {
      const { issues } = resolveFlowAssignments(smokeFlow(), scenario(['set-mode', 'turn-on']));
      expect(issues.filter(issue => issue.level === 'warning')).toEqual([]);
    });

    // T28 (R3 u3-F1) / T36 (R3 u2-F-06): the warning must tell the catalog
    // TRUTH (rows stay consumable, marked declaredByProvider:false) — the
    // old "peers and service discovery will not see …" promised a silence
    // the catalog never had — and must not make a temporal claim ("no
    // longer") about a capability that may never have been declared.
    it('the warning text states the declaredByProvider:false fact, not a false promise', () => {
      const { issues } = resolveFlowAssignments(smokeFlow(), scenario(['turn-on']));
      const warning = issues.find(issue => issue.level === 'warning')!;
      expect(warning.message).toContain('declaredByProvider:false');
      expect(warning.message).not.toContain('will not see');
      expect(warning.message).not.toContain('no longer');
    });
  });
});
