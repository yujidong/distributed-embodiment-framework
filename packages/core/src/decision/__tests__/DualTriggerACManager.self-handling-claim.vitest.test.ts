/**
 * @vitest-environment node
 *
 * FEAT-10 (dorm-life D11): AC delivery coordination.
 *
 *  ① self-handling counts as "handled": a handle_independently decision that
 *    actually DISPATCHES device commands registers the event claim in the
 *    InitiatorCoordinator (later would-be initiators for the same event
 *    defer) and records the shared event id locally (hasSelfHandledEvent —
 *    the responder lane rejects proposals for it). The incident: the duty
 *    officer's spontaneous ventilation was followed by an AC turn-on of the
 *    SAME fan — the system had no "event already handled" record because
 *    only the initiate_ac branch ever consulted the coordinator. A decision
 *    that dispatches ZERO commands claims nothing.
 *
 *  ② deny accounting: a coordinator-DENIED initiation used to be recorded
 *    as initiate_ac (the tally/callback ran before tryClaim — a handshake
 *    that never happened, which eval-report then attributed to
 *    no-partner/abandoned). The deny now converts the decision to defer
 *    with the deny named on the record BEFORE any accounting.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import { InitiatorCoordinator } from '../InitiatorCoordinator.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';

const ZONE = 'zone-a';

function createManager(
  agentId: string,
  capabilities: string[],
  configOverrides: Record<string, unknown> = {},
): { manager: DualTriggerACManager; commandExecutor: Mock; onACInitiation: Mock } {
  const mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
  const mockEnvironment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    services: new Map(),
  } as unknown as EnvironmentCenter;
  const commandExecutor = vi.fn().mockResolvedValue({ success: true });
  const onACInitiation = vi.fn();

  const manager = new DualTriggerACManager(
    agentId,
    `Agent-${agentId}`,
    capabilities,
    mockLLMClient,
    mockEnvironment,
    onACInitiation,
    {
      enableLayer1: true,
      enableLayer2: true,
      autoInitiateAC: true,
      disableSpatiotemporal: true,
      commandExecutor,
      ...configOverrides,
    },
  );
  return { manager, commandExecutor, onACInitiation };
}

/** A CO2 event in `zone` declaring the `ventilation` requirement. */
function co2Event(sharedEventId: string, zone: string): SystemEvent {
  return {
    id: `${sharedEventId}:${zone}`,
    type: 'environment.param_changed',
    source: 'sensor-1',
    timestamp: new Date(),
    payload: {
      severity: 'high',
      zoneId: zone,
      eventType: 'co2-breach',
      parameter: 'co2',
      newValue: 1400,
      requiredCapabilities: ['ventilation'],
    },
    metadata: { eventId: sharedEventId },
    priority: 'normal',
  };
}

describe('DualTriggerACManager — FEAT-10① self-handling registers the event claim', () => {
  it('Type-A self-handling with real commands: fan commanded once, event claimed, hasSelfHandledEvent true', async () => {
    const coordinator = new InitiatorCoordinator();
    const { manager, commandExecutor } = createManager('duty-officer', ['ventilation'], {
      actuatorZoneIds: [ZONE],
    });
    manager.setInitiatorCoordinator(coordinator);
    manager.setAgentDevices([
      { deviceId: 'fan-1', type: 'actuator', capabilities: ['ventilation'], zoneId: ZONE },
    ]);

    const result = await manager.processEvent(co2Event('evt-co2-1', ZONE));

    expect(result.path).toBe('handled_independently');
    // The fan received exactly one ventilation command.
    expect(commandExecutor).toHaveBeenCalledTimes(1);
    expect(commandExecutor).toHaveBeenCalledWith('fan-1', 'ventilation', { value: 1400 });
    // The event is now claimed by the self-handling agent…
    expect(coordinator.getPrimaryInitiator('evt-co2-1')).toBe('duty-officer');
    // …and locally recorded for the responder lane.
    expect(manager.hasSelfHandledEvent('evt-co2-1')).toBe(true);
  });

  it('a handle_independently that dispatches ZERO commands claims nothing', async () => {
    const coordinator = new InitiatorCoordinator();
    const { manager, commandExecutor } = createManager('duty-officer', ['ventilation'], {
      actuatorZoneIds: [ZONE],
      // Actuation opted out → the rule lane is gated → 0 commands.
      autoActuateIndependent: false,
    });
    manager.setInitiatorCoordinator(coordinator);
    manager.setAgentDevices([
      { deviceId: 'fan-1', type: 'actuator', capabilities: ['ventilation'], zoneId: ZONE },
    ]);

    const result = await manager.processEvent(co2Event('evt-co2-2', ZONE));

    expect(result.path).toBe('handled_independently');
    expect(commandExecutor).not.toHaveBeenCalled();
    expect(coordinator.getPrimaryInitiator('evt-co2-2')).toBeUndefined();
    expect(manager.hasSelfHandledEvent('evt-co2-2')).toBe(false);
  });

  it('self-handling then a same-event initiate_ac: the later initiator defers — no duplicate command on the same device', async () => {
    const coordinator = new InitiatorCoordinator();
    // Agent A: covers the zone, self-handles (Type A) with real commands.
    const a = createManager('duty-officer', ['ventilation'], { actuatorZoneIds: [ZONE] });
    a.manager.setInitiatorCoordinator(coordinator);
    a.manager.setAgentDevices([
      { deviceId: 'fan-1', type: 'actuator', capabilities: ['ventilation'], zoneId: ZONE },
    ]);
    await a.manager.processEvent(co2Event('evt-co2-3', ZONE));
    expect(a.commandExecutor).toHaveBeenCalledTimes(1);

    // Agent B: no zone coverage but all required capabilities → Type-E
    // initiate_ac. The claim A registered must make B defer — and (②) the
    // recorded decision must be a defer, not a phantom initiate_ac.
    const b = createManager('backup-agent', ['ventilation'], {
      actuatorZoneIds: ['zone-b'],
      autoInitiateAC: false,
    });
    b.manager.setInitiatorCoordinator(coordinator);
    const recorded: ACNecessityAssessment[] = [];
    b.manager.setAssessmentCallback(assessment => { recorded.push(assessment); });

    const result = await b.manager.processEvent(co2Event('evt-co2-3', ZONE));

    expect(result.path).toBe('deferred');
    expect(b.onACInitiation).not.toHaveBeenCalled();
    // Still exactly ONE command on the fan — the same event was not re-actuated.
    expect(a.commandExecutor).toHaveBeenCalledTimes(1);
    expect(b.commandExecutor).not.toHaveBeenCalled();
    // ② the recorded form: a defer carrying the deny note, zero initiate_ac.
    expect(recorded).toHaveLength(1);
    expect(recorded[0].decision).toBe('defer');
    expect(recorded[0].llmAssessment.reasoning).toContain('initiator-coordinator deny');
    expect(recorded[0].llmAssessment.reasoning).toContain('duty-officer');
    const distribution = b.manager.getStats().layer2DecisionDistribution;
    expect(distribution.initiate_ac ?? 0).toBe(0);
    expect(distribution.defer).toBe(1);
  });
});

describe('DualTriggerACManager — FEAT-10② coordinator-deny accounting', () => {
  it('a decision denied by a third-party claim is recorded as defer (deny note), never as initiate_ac', async () => {
    const coordinator = new InitiatorCoordinator();
    // A third party holds the event claim (e.g. it initiated first).
    coordinator.tryClaim('evt-co2-9', 'agent-z');

    const { manager, onACInitiation } = createManager('late-agent', ['ventilation'], {
      actuatorZoneIds: ['zone-b'],
      autoInitiateAC: false,
    });
    manager.setInitiatorCoordinator(coordinator);
    const recorded: ACNecessityAssessment[] = [];
    manager.setAssessmentCallback(assessment => { recorded.push(assessment); });

    // Type-E precheck would otherwise record initiate_ac for this event.
    const result = await manager.processEvent(co2Event('evt-co2-9', ZONE));

    expect(result.path).toBe('deferred');
    expect(onACInitiation).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].decision).toBe('defer');
    expect(recorded[0].llmAssessment.reasoning).toContain('initiator-coordinator deny');
    expect(recorded[0].llmAssessment.reasoning).toContain('agent-z');
    const distribution = manager.getStats().layer2DecisionDistribution;
    expect(distribution.initiate_ac ?? 0).toBe(0);
    expect(distribution.defer).toBe(1);
    // The claim still belongs to the third party — a denied agent steals nothing.
    expect(coordinator.getPrimaryInitiator('evt-co2-9')).toBe('agent-z');
  });

  it('a GRANTED claim still records initiate_ac (regression: the happy path is unchanged)', async () => {
    const coordinator = new InitiatorCoordinator();
    const { manager } = createManager('first-agent', ['ventilation'], {
      actuatorZoneIds: ['zone-b'],
      autoInitiateAC: false,
    });
    manager.setInitiatorCoordinator(coordinator);
    const recorded: ACNecessityAssessment[] = [];
    manager.setAssessmentCallback(assessment => { recorded.push(assessment); });

    await manager.processEvent(co2Event('evt-co2-10', ZONE));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].decision).toBe('initiate_ac');
    expect(coordinator.getPrimaryInitiator('evt-co2-10')).toBe('first-agent');
  });
});
