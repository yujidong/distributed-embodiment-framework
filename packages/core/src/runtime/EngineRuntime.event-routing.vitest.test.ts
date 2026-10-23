import { describe, it, expect, afterEach } from 'vitest';
import { EngineRuntime } from './EngineRuntime.js';
import { loadScenarioFile } from '../scenario/scenario-loader.js';
import { EventType } from '../events/index.js';
import type { InjectedEventRecord } from './contract.js';
import type { LLMClient, ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

/**
 * R102-injected-event-routing (chen-18/chen-19): an injected smoke event in
 * lab-102 reached only the lab-101 stewards (double defer, zero AC) while
 * the scheduled same-zone same-type event also engaged the lab-102 smoke
 * agent. The lanes are ONE implementation (fireDueEvents → injectEvent →
 * resolveManagingAgentIds; the /events route calls the same function), so
 * this suite pins the invariants rather than a new router:
 *
 * 1. CONSISTENCY: scheduled and runtime-injected events of the same
 *    zone+type reach the SAME audience, for every event type.
 * 2. AUDIT: the injected-event record carries the routing answer
 *    (targetAgentIds) — "who was this delivered to" is inspectable without
 *    reverse-engineering decision records.
 * 3. E2E story line (the assignment's top bar): injected smoke → the
 *    zone's sensor agent initiates AC → the partner accepts via the REAL
 *    handshake lane → ventilation executes through the R101 handler → the
 *    smoke clears with a materially shorter half-life than natural.
 *
 * Root-cause note (evidence, not code): the live "divergence" was a WORLD
 * change between the two events — the smoke agent was removed from the
 * environment (world-session rebuilt without it) while the lab-101
 * stewards legitimately declared lab-102 management. The routing never
 * diverged; these tests pin that it stays consistent.
 *
 * R103 (chen-20, PM-ruled fallback chain): the audience is resolved by
 * device-presence → capability-match → managed-zone → adjacent-zone,
 * first non-empty wins; the answering level rides the record's
 * routingLevel (route audit).
 */
describe('EngineRuntime — R102 event routing consistency + smoke e2e (chen-18)', () => {
  const runtimes: EngineRuntime[] = [];
  afterEach(() => {
    while (runtimes.length > 0) runtimes.pop()!.stop();
  });

  function routingWorld() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'routing-world', name: 'Routing World' },
      zones: [
        { id: 'lab-101', baseline: { temperature: 25, co2: 550 }, adjacentZoneIds: ['corridor-f1'] },
        { id: 'lab-102', baseline: { temperature: 25, co2: 550 }, adjacentZoneIds: ['corridor-f1'] },
        { id: 'corridor-f1', baseline: { temperature: 26 }, adjacentZoneIds: ['lab-101', 'lab-102'] },
      ],
      devices: [
        { id: 'ac-101', name: '101新风空调', type: 'hvac', capabilities: ['ventilation', 'cooling'], zoneId: 'lab-101' },
        { id: 'smoke-sensor-102', name: '烟雾传感器', type: 'smoke-sensor', capabilities: ['smoke-monitoring'], zoneId: 'lab-102' },
      ],
      agents: [
        {
          id: 'steward',
          name: '环境管家',
          capabilities: ['ventilation', 'cooling', 'temperature-control'],
          managesZoneIds: ['lab-101', 'lab-102'],
          boundDeviceIds: ['ac-101'],
        },
        {
          id: 'smoke-watcher',
          name: '烟感管家',
          capabilities: ['smoke-monitoring'],
          managesZoneIds: ['lab-102'],
          boundDeviceIds: ['smoke-sensor-102'],
        },
      ],
      events: [
        { id: 'ev-smoke', type: 'smoke', zoneId: 'lab-102', atSimTimeSec: 10, severity: 'high' },
      ],
    });
  }

  it('scheduled and runtime-injected events of the same zone+type reach the SAME audience (every type)', async () => {    const runtime = new EngineRuntime(routingWorld());
    runtimes.push(runtime);
    const records: InjectedEventRecord[] = [];
    runtime.onInjectedEvent(record => records.push(record));

    // Scheduled smoke fires at t=10.
    await runtime.step(15);
    const scheduled = records.find(r => r.type === 'smoke');
    expect(scheduled).toBeDefined();
    // R103 chain: the smoke specialist has a BOUND DEVICE in lab-102 →
    // device-presence answers with it alone (the lab-101 steward's bare
    // management declaration no longer pulls it in — it could not act
    // there). The record SAYS the level (route audit).
    expect(scheduled!.targetAgentIds).toEqual(['smoke-watcher']);
    expect(scheduled!.routingLevel).toBe('device-presence');

    // A runtime injection of the same zone+type resolves the identical list.
    const manual = await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102', severity: 'high' });
    expect([...manual.targetAgentIds].sort()).toEqual([...scheduled!.targetAgentIds].sort());

    // Cross-type: a temperature event in lab-101 — same answer both lanes.
    const manualTemp = await runtime.injectEvent({ type: 'temperature', zoneId: 'lab-101', value: 35 });
    expect([...manualTemp.targetAgentIds].sort()).toEqual(['steward']);
  });

  it('R103 fallback chain: with the zone sensor agent GONE, capability-match answers (ventilation + smoke-monitoring specialists)', async () => {
    // The chen-20 world shape: no agent has a device in lab-102, the
    // steward only DECLARES lab-102 management, the security specialist
    // manages the adjacent corridor.
    const world = loadScenarioFile({
      version: '1.0',
      meta: { id: 'fallback-world', name: 'Fallback World' },
      zones: [
        { id: 'lab-101', baseline: { temperature: 25 }, adjacentZoneIds: ['corridor-f1'] },
        { id: 'lab-102', baseline: { temperature: 25 }, adjacentZoneIds: ['corridor-f1'] },
        { id: 'corridor-f1', baseline: { temperature: 26 }, adjacentZoneIds: ['lab-101', 'lab-102'] },
      ],
      devices: [
        { id: 'ac-101', name: '101新风空调', type: 'hvac', capabilities: ['ventilation', 'cooling'], zoneId: 'lab-101' },
        { id: 'cam-c1', name: '走廊摄像头', type: 'camera', capabilities: ['smoke-monitoring'], zoneId: 'corridor-f1' },
      ],
      agents: [
        { id: 'steward', name: '环境管家', capabilities: ['ventilation', 'cooling'], managesZoneIds: ['lab-101', 'lab-102'], boundDeviceIds: ['ac-101'] },
        { id: 'security-officer', name: '安防专员', capabilities: ['smoke-monitoring', 'emergency-broadcast'], managesZoneIds: ['corridor-f1'], boundDeviceIds: ['cam-c1'] },
      ],
      events: [],
    });
    const runtime = new EngineRuntime(world);
    runtimes.push(runtime);

    const manual = await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102', severity: 'high' });
    // Level 1 empty (no bound device in lab-102) → level 2: smoke dispatch
    // needs (smoke-monitoring/ventilation/…) match BOTH the steward
    // (ventilation) and the security specialist (smoke-monitoring +
    // emergency-broadcast). Declaration/adjacency never reached.
    expect([...manual.targetAgentIds].sort()).toEqual(['security-officer', 'steward'].sort());
    expect(manual.routingLevel).toBe('capability-match');
  });

  // ---------------------------------------------------------------------
  // The acceptance's top bar — the story line end to end (vision ⑤⑥).
  // ---------------------------------------------------------------------

  const EVAL_ACCEPT = JSON.stringify({
    benefitScore: 0.9, costScore: 0.1, benefits: ['can help'], costs: [],
    recommendedDecision: 'accept', reasoning: 'cheap to help',
  });
  const CANNED_DECISION = JSON.stringify({ decision: 'collaborate', reasoning: 'mock' });

  /** Schema-aware mock: the proposal EVALUATION gets an accept, anything else the canned decision. */
  function acceptAllMock(): LLMClient {
    return {
      getProviderName: () => 'mock',
      getModel: () => 'mock-model',
      chat: async (params: ChatParams): Promise<ChatResponse> => ({
        content: JSON.stringify(params.format ?? {}).includes('recommendedDecision')
          ? EVAL_ACCEPT
          : CANNED_DECISION,
        model: 'mock-model',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      quickChat: async () => ({
        content: CANNED_DECISION,
        model: 'mock-model',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    } as unknown as LLMClient;
  }

  function smokeChainWorld() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'smoke-chain', name: 'Smoke Chain' },
      zones: [{ id: 'lab-102', baseline: { temperature: 25 } }],
      devices: [
        // The fresh-air unit sits IN the smoke zone — extraction must be
        // physically possible (cross-zone airflow does not clear smoke).
        { id: 'ac-102', name: '新风空调', type: 'hvac', capabilities: ['ventilation', 'cooling'], zoneId: 'lab-102' },
        { id: 'smoke-sensor-102', name: '烟雾传感器', type: 'smoke-sensor', capabilities: ['smoke-monitoring'], zoneId: 'lab-102' },
      ],
      agents: [
        { id: 'vent-ops', name: '新风管家', capabilities: ['ventilation', 'cooling'], managesZoneIds: ['lab-102'], boundDeviceIds: ['ac-102'] },
        { id: 'smoke-watcher', name: '烟感管家', capabilities: ['smoke-monitoring'], managesZoneIds: ['lab-102'], boundDeviceIds: ['smoke-sensor-102'] },
      ],
      events: [],
    });
  }

  const smokeOf = (rt: EngineRuntime) =>
    rt.getSnapshot().zones.find(z => z.id === 'lab-102')!.parameters.smoke as number;

  it('E2E: injected smoke → specialist initiates AC → partner accepts via the real handshake → ventilation executes → smoke half-life ≪ natural', async () => {
    const active = new EngineRuntime(smokeChainWorld(), { autoInitiateAC: true, llmClient: acceptAllMock() });
    runtimes.push(active);
    const control = new EngineRuntime(smokeChainWorld());
    runtimes.push(control);

    const bus: Array<{ type: string; kind: unknown }> = [];
    active.subscribe(event => {
      bus.push({ type: event.type, kind: (event.payload as Record<string, unknown>)?.type });
    }, [EventType.COLLABORATION_MESSAGE, EventType.DEVICE_OPERATION_EXECUTED, EventType.COLLABORATION_COMPLETED]);

    // The chen-18 replay: same runtime injection on both arms.
    await active.injectEvent({ type: 'smoke', zoneId: 'lab-102', severity: 'high' });
    await control.injectEvent({ type: 'smoke', zoneId: 'lab-102', severity: 'high' });

    // ① the zone's sensor specialist initiated the collaboration
    //    (deterministic sensor_notify precheck — no LLM needed);
    const initiation = active.getSnapshot().recentDecisions
      .find(d => d.agentId === 'smoke-watcher' && d.decision === 'initiate_ac');
    expect(initiation).toBeDefined();

    // Let the handshake converge and the executor work; run the natural
    // control for the same sim time.
    for (let i = 0; i < 4; i++) await active.step(100);
    for (let i = 0; i < 4; i++) await control.step(100);

    // ② the REAL handshake happened on the bus: proposal → accept →
    //    integration → device operations → completion;
    const kinds = bus.map(b => b.kind ?? b.type);
    expect(kinds).toContain('ac-proposal');
    expect(kinds).toContain('join-response');
    // ③ ventilation really executed on the partner's fresh-air unit
    //    (the R101 handler — pre-fix this was "no handler / no effect");
    const ventOps = bus.filter(b => b.type === EventType.DEVICE_OPERATION_EXECUTED);
    expect(ventOps.length).toBeGreaterThan(0);
    const ac102 = active.getSnapshot().devices.find(d => d.id === 'ac-102')!.state;
    expect(ac102.mode).toBe('ventilation');
    expect(ac102.cumulativeEnergyWh as number).toBeGreaterThan(0);

    // ④ the smoke cleared MATERIALLY faster than the natural half-life
    //    (~69 sim-s at the field's 0.01/s relaxation): natural is only
    //    ~5% down at t+400 while the active arm is essentially clean.
    expect(smokeOf(control)).toBeGreaterThan(0.01);
    expect(smokeOf(active)).toBeLessThan(smokeOf(control) / 100);
  }, 30_000);

  // ---------------------------------------------------------------------
  // R102-runtime-event-traceability (chen-19): unique ids, one query face,
  // decision records carry the event's provenance + key payload.
  // ---------------------------------------------------------------------

  it('runtime event ids are sim-time-anchored + sequenced + instance-nonces — no reuse, ever', async () => {
    const runtime = new EngineRuntime(routingWorld());
    runtimes.push(runtime);

    const first = await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102' });
    const second = await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102' });
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.eventId).toMatch(/^evt-runtime-s\d+-\d+-[a-z0-9]{4}$/);
    await runtime.step(100);
    const third = await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102' });
    expect(third.eventId).not.toBe(first.eventId);
    expect(third.eventId).not.toBe(second.eventId);
    expect(third.eventId).toContain('s100-'); // the sim-time anchor moved

    // A world rebuild (fresh runtime at the same sim time) can never
    // re-issue an existing id — the instance nonce differs (chen-19's
    // actual collision was two sessions both answering 'evt-runtime-1').
    const rebuilt = new EngineRuntime(routingWorld());
    runtimes.push(rebuilt);
    const other = await rebuilt.injectEvent({ type: 'smoke', zoneId: 'lab-102' });
    expect(other.eventId).not.toBe(first.eventId);
  });

  it('the snapshot exposes runtime injections on the SAME face as scheduled events (type/zone/value/severity/actor/audience/time)', async () => {
    const runtime = new EngineRuntime(routingWorld());
    runtimes.push(runtime);

    const manual = await runtime.injectEvent({
      type: 'smoke', zoneId: 'lab-102', severity: 'high',
    }, );
    const snap = runtime.getSnapshot();
    const entry = snap.injectedEvents.find(e => e.eventId === manual.eventId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      type: 'smoke',
      zoneId: 'lab-102',
      parameter: 'smoke',
      value: true,
      severity: 'high',
      simTimeSec: 0,
    });
    expect(entry!.targetAgentIds).toEqual(['smoke-watcher']);
    expect(entry!.routingLevel).toBe('device-presence');

    // The scheduled firing does NOT duplicate into injectedEvents (its face
    // is scheduledEvents with the fired trace).
    await runtime.step(15);
    const after = runtime.getSnapshot();
    expect(after.injectedEvents.filter(e => e.type === 'smoke')).toHaveLength(1);
    expect(after.scheduledEvents.find(e => e.id === 'ev-smoke')?.fired).toBe(true);
  });

  it('decision records carry event provenance + key payload — no id-naming reverse engineering', async () => {
    const runtime = new EngineRuntime(routingWorld());
    runtimes.push(runtime);

    await runtime.injectEvent({ type: 'smoke', zoneId: 'lab-102', value: true, severity: 'high' });
    // R103 chain: device-presence routes the smoke to the zone's sensor
    // specialist (the lab-101 steward is no longer in the audience).
    const runtimeDecision = runtime.getSnapshot().recentDecisions
      .find(d => d.agentId === 'smoke-watcher');
    expect(runtimeDecision).toMatchObject({
      eventSource: 'runtime',
      eventType: 'smoke',
      eventValue: true,
      eventSeverity: 'high',
    });

    // A fresh runtime stepping past the scheduled event → 'scheduled'.
    const scheduled = new EngineRuntime(routingWorld());
    runtimes.push(scheduled);
    await scheduled.step(15);
    const scheduledDecision = scheduled.getSnapshot().recentDecisions
      .find(d => d.agentId === 'smoke-watcher');
    expect(scheduledDecision?.eventSource).toBe('scheduled');
    expect(scheduledDecision?.eventSeverity).toBe('high');
  });
});
