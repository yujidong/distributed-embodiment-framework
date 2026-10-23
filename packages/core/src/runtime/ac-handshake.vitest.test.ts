/**
 * @vitest-environment node
 *
 * Fix-8 end-to-end: AC collaboration handshake closure in EngineRuntime.
 *
 * Scenario: ONE zone, two agents — a sensor-only agent (must ask for help)
 * and an HVAC actuator agent (can cool). A 39°C heat event is delivered to
 * both. Expected chain:
 *
 *   heat event → sensor-agent precheck `initiate_ac` (sensor-only rule)
 *   → proposal delivered to actuator-agent over the shared bus
 *   → actuator-agent's proposal handler evaluates (mock LLM → accept)
 *   → initiator's handshake resolves; session pending → in_progress
 *   → executor actuates the partner's HVAC THROUGH the partner agent
 *   → cooling with a comfort setpoint (24°C) → zone temperature falls
 *
 * Before Fix-8 the partner never saw the proposal (its handler was never
 * started), the session stayed pending forever, and the initiator actuated
 * the partner's device unilaterally — without a setpoint.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { EventPriority, EventType } from '../events/index.js';
import {
  CollaborationPriority,
  CollaborationStatus,
  type CollaborationManager,
} from '../management/CollaborationManager.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

// The AC execution + feedback-simulation path logs per physics step; at INFO
// level the captured output OOMs the vitest worker. Errors still surface.
configureLogger({ level: LoggerLevel.ERROR });

/** Structural LLMClient stub: every chat returns the same canned JSON. */
class MockLLMClient {
  static readonly CANNED = JSON.stringify({ decision: 'collaborate', reasoning: 'mock' });

  getProviderName(): string {
    return 'mock';
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Trajectory wiring hooks (EngineRuntime installs these). */
  setLoggingCallback(_callback: unknown): void {
    // No-op: this stub does not emit LLM-call log entries.
  }

  setContextProvider(_provider: unknown): void {
    // No-op.
  }

  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    void params;
    return {
      content: MockLLMClient.CANNED,
      model: 'mock-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

function oneZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'ac-handshake-test', name: 'AC Handshake Test Scenario' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-a',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
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
        capabilities: ['temperature-control', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-handshake-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('EngineRuntime — AC handshake closure (Fix-8)', () => {
  it('heat event → initiate_ac → partner accept → partner HVAC cools with a setpoint → temperature falls', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      trajectoryDir,
    });
    runtimes.push(runtime);

    const result = await runtime.injectEvent({
      type: 'heat-wave',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 39,
      severity: 'high',
    });

    // Both zone managers receive the event.
    expect([...result.targetAgentIds].sort()).toEqual(['actuator-agent', 'sensor-agent']);

    // Deterministic decisions: the sensor-only agent must initiate AC
    // (precheck rule); the fully-capable actuator agent handles its own
    // assessment independently. Both decisions carry an auditable reason.
    const decisions = runtime.getSnapshot().recentDecisions;
    expect(decisions).toHaveLength(2);
    const sensorDecision = decisions.find(d => d.agentId === 'sensor-agent');
    expect(sensorDecision).toMatchObject({ decision: 'initiate_ac', decisionSource: 'precheck' });
    const actuatorDecision = decisions.find(d => d.agentId === 'actuator-agent');
    expect(actuatorDecision).toMatchObject({ decision: 'handle_independently' });

    // The collaboration is visible from initiation time on the initiator's
    // side (pending until the handshake closes; the mock-LLM handshake is
    // fast, so it may already be in-progress by the time injectEvent
    // resolves — both are valid post-initiation states).
    const initRow = runtime.getCollaborations().find(c => c.agentId === 'sensor-agent');
    expect(initRow).toBeDefined();
    expect(initRow!.role).toBe('initiator');
    expect(['pending', 'in-progress']).toContain(initRow!.status);
    const collaborationId = initRow!.id;

    // The partner's proposal handler (started by the runtime) receives the
    // proposal, evaluates it (mock LLM → accept) and joins — the partner's
    // own view of the collaboration appears.
    await vi.waitFor(() => {
      const partnerRow = runtime.getCollaborations().find(
        c => c.id === collaborationId && c.agentId === 'actuator-agent',
      );
      expect(partnerRow).toBeDefined();
      expect(partnerRow!.role).toBe('participant');
    }, { timeout: 5000 });

    // The initiator's session left pending (handshake closed).
    await vi.waitFor(() => {
      const initiatorRow = runtime.getCollaborations().find(
        c => c.id === collaborationId && c.agentId === 'sensor-agent',
      );
      expect(initiatorRow?.status).not.toBe('pending');
    }, { timeout: 5000 });

    // Execution after acceptance actuated the partner's HVAC through the
    // partner agent — powered on WITH a comfort-band setpoint (Fix-8:
    // cooling without a setpoint was formally correct but physically inert).
    await vi.waitFor(() => {
      const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-a');
      expect(hvac?.state.power).toBe(true);
      const setpoint = hvac?.state.targetTemperature;
      expect(typeof setpoint).toBe('number');
      expect(setpoint as number).toBeGreaterThanOrEqual(24);
      expect(setpoint as number).toBeLessThanOrEqual(26);
    }, { timeout: 5000 });

    // Trajectory: BOTH sides recorded. The sensor-agent's assessment carries
    // the precheck reasoning (previously unauditable), and the partner's
    // accept is a collaboration-response record.
    await vi.waitFor(() => {
      const trajectoryPath = runtime.getTrajectoryFilePath()!;
      const lines = readFileSync(trajectoryPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));

      const assessment = lines.find(
        l => l.kind === undefined && l.agentId === 'sensor-agent' && l.eventId === result.eventId,
      );
      expect(assessment).toBeDefined();
      expect(assessment.decision).toBe('initiate_ac');
      expect(typeof assessment.reasoning).toBe('string');
      expect(assessment.reasoning.length).toBeGreaterThan(0);

      const accept = lines.find(
        l => l.kind === 'collaboration-response' && l.decision === 'accept',
      );
      expect(accept).toBeDefined();
      expect(accept.agentId).toBe('actuator-agent');
      expect(accept.collaborationId).toBe(collaborationId);
      // Fix-12: the accept was LLM-evaluated — the source says so.
      expect(accept.decisionSource).toBe('llm');
    }, { timeout: 5000 });

    // Physics: the registered cooling effect pulls the zone temperature back
    // down from the 39°C spike.
    await runtime.step(30);
    const temp = runtime.getSnapshot().zones.find(z => z.id === 'zone-a')?.parameters.temperature;
    expect(typeof temp).toBe('number');
    expect(temp as number).toBeLessThan(39);
  }, 30000);

  it('Fix-12: a fallback-labelled response lands in the trajectory as decisionSource fallback', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), { trajectoryDir });
    runtimes.push(runtime);

    // Publish a responder message shaped like the tightened capability
    // fallback's accept (LLM unavailable → evaluationSource 'fallback').
    const envCenter = (runtime as unknown as {
      envCenter: { eventManager: { publish: (event: unknown) => void } };
    }).envCenter;
    envCenter.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'actuator-agent',
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'actuator-agent',
        collaborationId: 'ac-fallback-1',
        reason: 'Capability-based acceptance: 1/1 required capabilities matched (cooling)',
        evaluationSource: 'fallback',
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    await vi.waitFor(() => {
      const trajectoryPath = runtime.getTrajectoryFilePath()!;
      const lines = readFileSync(trajectoryPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));
      const accept = lines.find(
        l => l.kind === 'collaboration-response' && l.collaborationId === 'ac-fallback-1',
      );
      expect(accept).toBeDefined();
      expect(accept.decision).toBe('accept');
      expect(accept.decisionSource).toBe('fallback');
      expect(accept.reasoning).toContain('1/1');
    }, { timeout: 5000 });
  });

  it('R81-D2 (R44-F4): an answer arriving after the inflight window attributes to the REAL event id', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), { trajectoryDir });
    runtimes.push(runtime);

    // Nothing is in flight (no injection) — the pre-fix code fell back to
    // the synthetic collaboration UUID here (extreme tier: 57% of answers).
    const envCenter = (runtime as unknown as {
      envCenter: { eventManager: { publish: (event: unknown) => void } };
    }).envCenter;
    const publish = (payload: Record<string, unknown>): void => {
      envCenter.eventManager.publish({
        type: EventType.COLLABORATION_MESSAGE,
        source: 'sensor-agent',
        payload,
        priority: EventPriority.NORMAL,
        metadata: {},
      });
    };

    // The proposal goes out carrying its source event id (the broadcast-
    // derived event's backfill)…
    publish({
      type: 'ac-proposal',
      collaborationId: 'ac-r81-real',
      initiatorId: 'sensor-agent',
      targetAgentId: 'actuator-agent',
      triggerEventId: 'evt-heat-42',
    });
    // …the answer arrives LATER (inflightEventId long cleared).
    publish({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'actuator-agent',
      collaborationId: 'ac-r81-real',
      reason: 'can deliver cooling',
      evaluationSource: 'llm',
    });
    // A proposal that genuinely never knew its source event stays honest:
    // the record falls back to the collaboration id, not a fabrication.
    publish({ type: 'ac-proposal', collaborationId: 'ac-r81-unknown', initiatorId: 'sensor-agent' });
    publish({
      type: 'reject',
      agentId: 'actuator-agent',
      collaborationId: 'ac-r81-unknown',
      reason: 'busy',
      evaluationSource: 'fallback',
    });

    await vi.waitFor(() => {
      const trajectoryPath = runtime.getTrajectoryFilePath()!;
      const lines = readFileSync(trajectoryPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));

      const accept = lines.find(
        l => l.kind === 'collaboration-response' && l.collaborationId === 'ac-r81-real',
      );
      expect(accept).toBeDefined();
      // THE fix: the real scenario event id, not the synthetic UUID.
      expect(accept.eventId).toBe('evt-heat-42');

      const unknown = lines.find(
        l => l.kind === 'collaboration-response' && l.collaborationId === 'ac-r81-unknown',
      );
      expect(unknown).toBeDefined();
      expect(unknown.eventId).toBe('ac-r81-unknown');
    }, { timeout: 5000 });
  });

  it('Wave-4a: counter/defer negotiation steps land in the trajectory', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), { trajectoryDir });
    runtimes.push(runtime);

    const envCenter = (runtime as unknown as {
      envCenter: { eventManager: { publish: (event: unknown) => void } };
    }).envCenter;
    const publish = (payload: Record<string, unknown>, source = 'actuator-agent'): void => {
      envCenter.eventManager.publish({
        type: EventType.COLLABORATION_MESSAGE,
        source,
        payload,
        priority: EventPriority.NORMAL,
        metadata: {},
      });
    };

    // The responder counters (LLM-evaluated)…
    publish({
      type: 'counter',
      acDecision: 'counter',
      agentId: 'actuator-agent',
      collaborationId: 'ac-neg-1',
      reason: 'acceptable with modifications',
      evaluationSource: 'llm',
    });
    // …the initiator rejects the counter by rule (no LLM on its side)…
    publish({
      type: 'counter-response',
      acDecision: 'reject',
      agentId: 'sensor-agent',
      targetAgentId: 'actuator-agent',
      collaborationId: 'ac-neg-1',
      reason: 'no LLM configured to evaluate the modified conditions',
      evaluationSource: 'rule',
    }, 'sensor-agent');
    // …and on another collaboration the responder defers (fallback-evaluated).
    publish({
      type: 'defer',
      acDecision: 'defer',
      agentId: 'actuator-agent',
      collaborationId: 'ac-neg-2',
      reason: 'need more information',
      evaluationSource: 'fallback',
      deferMs: 30_000,
    });

    await vi.waitFor(() => {
      const trajectoryPath = runtime.getTrajectoryFilePath()!;
      const lines = readFileSync(trajectoryPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));
      const rows = lines.filter(l => l.kind === 'collaboration-response');

      const counter = rows.find(l => l.decision === 'counter' && l.collaborationId === 'ac-neg-1');
      expect(counter).toBeDefined();
      expect(counter.agentId).toBe('actuator-agent');
      expect(counter.decisionSource).toBe('llm');

      // The initiator's counter rejection is attributed to the countering
      // partner as a 'reject' — the partner counts as declined.
      const counterReject = rows.find(
        l => l.decision === 'reject' && l.collaborationId === 'ac-neg-1',
      );
      expect(counterReject).toBeDefined();
      expect(counterReject.agentId).toBe('actuator-agent');
      expect(counterReject.decisionSource).toBe('rule');
      expect(counterReject.reasoning).toContain('counter-proposal rejected');

      const defer = rows.find(l => l.decision === 'defer' && l.collaborationId === 'ac-neg-2');
      expect(defer).toBeDefined();
      expect(defer.agentId).toBe('actuator-agent');
      expect(defer.decisionSource).toBe('fallback');
    }, { timeout: 5000 });
  });

  it('Fix-15 (F-23): completion / cancel events drive EVERY agent view to a terminal status', async () => {
    const runtime = new EngineRuntime(oneZoneScenario(), {});
    runtimes.push(runtime);

    // Seed a live AC session in BOTH agents' managers (the participant's
    // local session is the one that used to stay 'active' forever).
    const agents = (runtime as unknown as {
      agents: Map<string, { collaborationManager: CollaborationManager }>;
    }).agents;
    const seedSession = (agentId: string, collaborationId: string): void => {
      const manager = agents.get(agentId)!.collaborationManager;
      const session = manager.createSession(
        'service-composition',
        ['sensor-agent', 'actuator-agent'],
        'sensor-agent',
        CollaborationPriority.MEDIUM,
        'F-23 lifecycle test',
        [],
      );
      // createSession uuids the id; AC sessions are keyed by collaborationId.
      const active = (manager as unknown as { activeSessions: Map<string, typeof session> }).activeSessions;
      active.delete(session.id);
      session.id = collaborationId;
      session.status = CollaborationStatus.IN_PROGRESS;
      active.set(collaborationId, session);
    };
    seedSession('sensor-agent', 'ac-f23');
    seedSession('actuator-agent', 'ac-f23');

    // Before the end event: both views are live rows.
    for (const row of runtime.getCollaborations().filter(r => r.id === 'ac-f23')) {
      expect(row.history).toBe(false);
    }

    const envCenter = (runtime as unknown as {
      envCenter: { eventManager: { publish: (event: unknown) => void } };
    }).envCenter;
    envCenter.eventManager.publish({
      type: EventType.COLLABORATION_COMPLETED,
      source: 'sensor-agent',
      payload: { collaborationId: 'ac-f23', success: true },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    await vi.waitFor(() => {
      const rows = runtime.getCollaborations().filter(r => r.id === 'ac-f23');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.history).toBe(true);
        expect(row.status).toBe('completed');
      }
    }, { timeout: 5000 });

    // ac-cancelled likewise terminates every agent's session.
    seedSession('sensor-agent', 'ac-f23-cancel');
    seedSession('actuator-agent', 'ac-f23-cancel');
    envCenter.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'sensor-agent',
      payload: { type: 'ac-cancelled', collaborationId: 'ac-f23-cancel', outcome: 'timeout' },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    await vi.waitFor(() => {
      const rows = runtime.getCollaborations().filter(r => r.id === 'ac-f23-cancel');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.history).toBe(true);
        expect(row.status).toBe('cancelled');
      }
    }, { timeout: 5000 });
  });
});

describe('EngineRuntime — pending AC handshake teardown narration (BUG-07)', () => {
  /** Park a handshake on the sensor-agent (ghost partner → no answer ever). */
  async function parkHandshake(runtime: EngineRuntime, collaborationId: string): Promise<void> {
    const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
    const initiator = agents.get('sensor-agent') as {
      collaborationCoordinator: {
        handleAutonomousACInitiation: (config: unknown, result: unknown) => Promise<void>;
      };
    };
    await initiator.collaborationCoordinator.handleAutonomousACInitiation(
      {
        id: collaborationId,
        name: 'Teardown cancel probe',
        description: 'park a handshake across runtime teardown',
        priority: 'high',
        participantAgentIds: ['ghost-agent'],
        requiredResources: [],
        goals: [],
      },
      {},
    );
  }

  it('stop() narrates the parked handshake as ac-cancelled (aborted / runtime-stopped) BEFORE the recorder finalizes', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), { trajectoryDir });
    // Deliberately NOT pushed to `runtimes` — this test stops it itself.
    await parkHandshake(runtime, 'ac-teardown-stop');
    expect(
      runtime.getCollaborations().find(c => c.id === 'ac-teardown-stop' && c.agentId === 'sensor-agent')?.status,
    ).toBe('pending');

    runtime.stop();

    // Readable immediately after stop() returns — the narration landed
    // synchronously, before the subscriptions/recorder were released.
    const trajectoryPath = runtime.getTrajectoryFilePath()!;
    const lines = readFileSync(trajectoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const cancels = lines.filter(
      l => l.kind === 'collaboration-response' && l.decision === 'cancelled' && l.collaborationId === 'ac-teardown-stop',
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      agentId: 'sensor-agent',
      decisionSource: 'aborted',
      reasoning: 'runtime-stopped',
    });
    // The cancel also finalized the session view.
    expect(
      runtime.getCollaborations().find(c => c.id === 'ac-teardown-stop' && c.agentId === 'sensor-agent')?.status,
    ).toBe('cancelled');
  });

  it('an explicit cancelPendingACHandshakes(runtime-rebuild) wins; stop() adds nothing (idempotent)', async () => {
    const trajectoryDir = makeTempDir();
    const runtime = new EngineRuntime(oneZoneScenario(), { trajectoryDir });
    await parkHandshake(runtime, 'ac-teardown-rebuild');

    expect(runtime.cancelPendingACHandshakes('runtime-rebuild')).toBe(1);
    // The second sweep (what stop() runs) finds nothing pending.
    expect(runtime.cancelPendingACHandshakes('runtime-stopped')).toBe(0);
    runtime.stop();

    const trajectoryPath = runtime.getTrajectoryFilePath()!;
    const cancels = readFileSync(trajectoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(
        l => l.kind === 'collaboration-response' && l.decision === 'cancelled' && l.collaborationId === 'ac-teardown-rebuild',
      );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ decisionSource: 'aborted', reasoning: 'runtime-rebuild' });
  });
});
