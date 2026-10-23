/**
 * @vitest-environment node
 *
 * P5: AC ephemeral agreement bridge — provider offer selection.
 *
 * Pre-P5 the metered offer was "semantic type ∈ requested capabilities,
 * else the agent's first offer", which metered consumptions against
 * services the collaboration never asked for. Now the responder's whole
 * face (derived + published + aggregate rows) is scored by
 * |requiredCapabilities ∩ the offer's executable surface| (semantic type +
 * interface action names), ties break by semanticType lexicographic order,
 * and no intersection skips the agreement with a log clue.
 *
 * Also pins the providerAgentId/consumerAgentId attribution (R44-extreme-F3
 * family): provider = the accepting responder, consumer = the initiator —
 * never the same agent on a normal handshake.
 */

import { describe, expect, it, vi } from 'vitest';

import { EventType, type EngineRuntime } from '@active-collaboration/core';

import { AcAgreementBridge, selectMeteredService } from './ac-agreement-bridge.js';
import type { ServiceInstanceRow } from './db/service-store.js';

/** Minimal service row (selectMeteredService only reads these fields). */
function service(
  id: string,
  semanticType: string,
  origin: string,
  actionNames?: string[],
): ServiceInstanceRow {
  return {
    id,
    semantic_type: semanticType,
    origin,
    interface_json: actionNames === undefined
      ? '{}'
      : JSON.stringify({ actions: actionNames.map(name => ({ name, parameters: {} })) }),
  } as ServiceInstanceRow;
}

describe('selectMeteredService (P5 offer matching)', () => {
  it('picks the offer with the largest requiredCapabilities ∩ surface intersection', () => {
    const offers = [
      service('svc-derived-cooling', 'cooling', 'derived', ['cooling']),
      service('svc-aggregate-comfort', 'campus-air-comfort', 'aggregate', ['temperature-control', 'cooling']),
    ];
    const picked = selectMeteredService(offers, ['cooling', 'temperature-control']);
    expect(picked?.id).toBe('svc-aggregate-comfort'); // 2 matches vs 1
  });

  it('hits an aggregate offer through its interface actions (actuation backing)', () => {
    // 'valve-control' shares no substring with 'drainage-control' — only the
    // aggregate interface's action surface carries it.
    const offers = [
      service('svc-aggregate-drainage', 'drainage-control', 'aggregate', ['valve-control', 'open']),
    ];
    const picked = selectMeteredService(offers, ['valve-control']);
    expect(picked?.id).toBe('svc-aggregate-drainage');
  });

  it('breaks score ties by semanticType lexicographic order (deterministic)', () => {
    const offers = [
      service('svc-b', 'b-type', 'published', ['cooling']),
      service('svc-a', 'a-type', 'derived', ['cooling']),
    ];
    const picked = selectMeteredService(offers, ['cooling']);
    expect(picked?.id).toBe('svc-a');
  });

  it('matches on the semantic type alone when interface_json is empty/malformed', () => {
    const malformed = { ...service('svc-raw', 'cooling', 'derived'), interface_json: '{oops' };
    const picked = selectMeteredService([malformed], ['cooling']);
    expect(picked?.id).toBe('svc-raw');
  });

  it('returns undefined when nothing intersects — the caller skips the agreement', () => {
    const offers = [service('svc-cooling', 'cooling', 'derived', ['cooling'])];
    expect(selectMeteredService(offers, ['welding'])).toBeUndefined();
    expect(selectMeteredService([], ['cooling'])).toBeUndefined();
    expect(selectMeteredService(offers, [])).toBeUndefined();
  });

  it('BUG-02: a capability-tied offer backed in the event zone wins over a cross-zone twin', () => {
    // Identical semantic type + surface: pre-fix the lexicographic tiebreak
    // picked 'svc-a-cross' — the building-6 fan metering a building-3 event.
    const offers = [
      service('svc-a-cross', 'ventilation', 'derived', ['ventilation']),
      service('svc-z-local', 'ventilation', 'derived', ['ventilation']),
    ];
    const picked = selectMeteredService(offers, ['ventilation'], {
      zoneId: 'dorm-3-f1',
      inZone: row => row.id === 'svc-z-local',
    });
    expect(picked?.id).toBe('svc-z-local');
    // Without the preference the old deterministic tiebreak is untouched.
    expect(selectMeteredService(offers, ['ventilation'])?.id).toBe('svc-a-cross');
  });

  it('BUG-02: capability relevance still outranks locality', () => {
    // The in-zone offer matches ONE requested capability; the cross-zone
    // offer matches BOTH — relevance wins, the zone preference only breaks
    // remaining ties.
    const offers = [
      service('svc-local-narrow', 'air-comfort', 'aggregate', ['cooling']),
      service('svc-remote-full', 'hvac-full', 'aggregate', ['cooling', 'temperature-control']),
    ];
    const picked = selectMeteredService(offers, ['cooling', 'temperature-control'], {
      zoneId: 'dorm-3-f1',
      inZone: row => row.id === 'svc-local-narrow',
    });
    expect(picked?.id).toBe('svc-remote-full');
  });
});

describe('ac-agreement-bridge provider selection (P5)', () => {
  function setup(services: ServiceInstanceRow[]) {
    const created: Array<Record<string, unknown>> = [];
    const bridge = new AcAgreementBridge({
      envStore: {
        getAgent: (id: string) =>
          id === 'initiator-agent' || id === 'responder-agent'
            ? { id, env_id: 'env-1', owner_id: `owner-of-${id}` }
            : undefined,
      } as never,
      serviceStore: {
        servicesOfAgent: () => services,
      } as never,
      agreementStore: {
        activeAgreementsOfCollaboration: () => [],
        createAgreement: vi.fn((input: Record<string, unknown>) => created.push(input)),
      } as never,
    });

    const handlers: Array<{ handler: (event: unknown) => void; eventType: string }> = [];
    const runtime = {
      subscribe: (handler: (event: unknown) => void, eventType: string) => {
        handlers.push({ handler, eventType });
      },
    } as unknown as EngineRuntime;
    bridge.attach('env-1', runtime);

    const emit = (payload: Record<string, unknown>): void => {
      for (const { handler, eventType } of handlers) {
        if (eventType === EventType.COLLABORATION_MESSAGE) {
          handler({ payload, source: payload.agentId ?? 'responder-agent' });
        }
      }
    };
    const handshake = (collaborationId: string, requiredCapabilities: string[]): void => {
      emit({
        type: 'ac-proposal',
        collaborationId,
        initiatorId: 'initiator-agent',
        targetAgentId: 'responder-agent',
        requiredCapabilities,
      });
      emit({
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'responder-agent',
        collaborationId,
      });
    };
    return { created, handshake };
  }

  it('meters the accept against the best-matching offer, not the first one', () => {
    const { created, handshake } = setup([
      service('svc-first-unrelated', 'lighting-control', 'derived', ['lighting-control']),
      service('svc-aggregate-comfort', 'campus-air-comfort', 'aggregate', ['temperature-control', 'cooling']),
    ]);
    handshake('ac-match', ['cooling', 'temperature-control']);

    expect(created).toHaveLength(1);
    expect(created[0].serviceId).toBe('svc-aggregate-comfort');
  });

  it('skips the agreement when no offer intersects the requested capabilities', () => {
    const { created, handshake } = setup([
      service('svc-cooling', 'cooling', 'derived', ['cooling']),
    ]);
    handshake('ac-nomatch', ['welding']);

    expect(created).toHaveLength(0);
  });

  it('8087 落账率路径：空请求面被跳过；同一握手带上确定性 gap needs 即落账', () => {
    // The initiator-side gap-fill (ACNecessityAssessor: an initiate_ac
    // answer that named no requiredCapabilities carries the event's
    // deterministic gap needs) is what turns the pre-fix skip into a
    // metered ephemeral agreement — pin both ends of that path here.
    const { created, handshake } = setup([
      service('svc-cooling', 'cooling', 'derived', ['cooling']),
    ]);

    // Pre-fix shape: the model omitted requiredCapabilities → nothing
    // honest to meter → skipped.
    handshake('ac-empty-face', []);
    expect(created).toHaveLength(0);

    // Fixed shape: the SAME handshake with the deterministic gap needs
    // riding the proposal → lands against the matching offer.
    handshake('ac-filled-face', ['cooling']);
    expect(created).toHaveLength(1);
    expect(created[0].serviceId).toBe('svc-cooling');
    expect(created[0].status).toBe('active');
    expect(created[0].source).toBe('ac');
  });

  it('attributes provider = responder and consumer = initiator (R44-extreme-F3 self-reference regression)', () => {
    const { created, handshake } = setup([
      service('svc-cooling', 'cooling', 'derived', ['cooling']),
    ]);
    handshake('ac-attribution', ['cooling']);

    expect(created).toHaveLength(1);
    expect(created[0].providerAgentId).toBe('responder-agent');
    expect(created[0].consumerAgentId).toBe('initiator-agent');
    expect(created[0].providerAgentId).not.toBe(created[0].consumerAgentId);
  });
});

describe('FEAT-04: unmetered skip is observable (accepted-unmetered notification)', () => {
  function setup(services: ServiceInstanceRow[]) {
    const created: Array<Record<string, unknown>> = [];
    const notifications: Array<Record<string, unknown>> = [];
    const bridge = new AcAgreementBridge({
      envStore: {
        getAgent: (id: string) =>
          id === 'initiator-agent' || id === 'responder-agent'
            ? { id, env_id: 'env-1', owner_id: `owner-of-${id}` }
            : undefined,
      } as never,
      serviceStore: {
        servicesOfAgent: () => services,
      } as never,
      agreementStore: {
        activeAgreementsOfCollaboration: () => [],
        createAgreement: vi.fn((input: Record<string, unknown>) => created.push(input)),
      } as never,
      notificationStore: {
        create: vi.fn((input: Record<string, unknown>) => {
          notifications.push(input);
          return input;
        }),
        hasUnread: () => false,
      } as never,
    });

    const handlers: Array<{ handler: (event: unknown) => void; eventType: string }> = [];
    const runtime = {
      subscribe: (handler: (event: unknown) => void, eventType: string) => {
        handlers.push({ handler, eventType });
      },
    } as unknown as EngineRuntime;
    bridge.attach('env-1', runtime);

    const emit = (payload: Record<string, unknown>): void => {
      for (const { handler, eventType } of handlers) {
        if (eventType === EventType.COLLABORATION_MESSAGE) {
          handler({ payload, source: payload.agentId ?? 'responder-agent' });
        }
      }
    };
    const handshake = (collaborationId: string, requiredCapabilities: string[]): void => {
      emit({
        type: 'ac-proposal',
        collaborationId,
        initiatorId: 'initiator-agent',
        targetAgentId: 'responder-agent',
        requiredCapabilities,
      });
      emit({
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'responder-agent',
        collaborationId,
      });
    };
    return { created, notifications, handshake };
  }

  it('accept with NO matching offer: no agreement lands, the initiator owner hears accepted-unmetered', () => {
    const { created, notifications, handshake } = setup([
      service('svc-cooling', 'cooling', 'derived', ['cooling']),
    ]);
    handshake('ac-unmetered', ['welding']);

    expect(created).toHaveLength(0); // the honest skip — nothing to meter
    expect(notifications).toHaveLength(1);
    const body = notifications[0].body as { decision?: string; note?: string };
    expect(body.decision).toBe('accepted-unmetered');
    expect(body.note).toContain('无匹配服务报价');
    expect(String(notifications[0].title)).toContain('未落合约');
    expect(notifications[0].userId).toBe('owner-of-initiator-agent');
  });

  it('accept WITH a matching offer: the agreement lands and the notification stays plain accept', () => {
    const { created, notifications, handshake } = setup([
      service('svc-cooling', 'cooling', 'derived', ['cooling']),
    ]);
    handshake('ac-metered', ['cooling']);

    expect(created).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    const body = notifications[0].body as { decision?: string; note?: string };
    expect(body.decision).toBe('accept');
    expect(body.note).toBeUndefined();
    expect(String(notifications[0].title)).not.toContain('未落合约');
  });
});

describe('BUG-02: zone-aware metering (event zone ↔ backing zone)', () => {
  /** Derived row pinned to a source device (the zone rides the device). */
  function derivedService(id: string, semanticType: string, sourceDeviceId: string): ServiceInstanceRow {
    return {
      ...service(id, semanticType, 'derived', [semanticType]),
      source_device_id: sourceDeviceId,
    } as ServiceInstanceRow;
  }

  function setup(opts: {
    services: ServiceInstanceRow[];
    /** deviceId → zone_id */
    deviceZones: Record<string, string>;
  }) {
    const created: Array<Record<string, unknown>> = [];
    const bridge = new AcAgreementBridge({
      envStore: {
        getAgent: (id: string) =>
          id === 'initiator-agent' || id === 'responder-agent'
            ? { id, env_id: 'env-1', owner_id: `owner-of-${id}`, bound_device_ids_json: '[]' }
            : undefined,
        getDevice: (id: string) =>
          opts.deviceZones[id] !== undefined ? { id, zone_id: opts.deviceZones[id] } : undefined,
      } as never,
      serviceStore: {
        servicesOfAgent: () => opts.services,
      } as never,
      agreementStore: {
        activeAgreementsOfCollaboration: () => [],
        createAgreement: vi.fn((input: Record<string, unknown>) => created.push(input)),
      } as never,
    });

    const handlers: Array<{ handler: (event: unknown) => void; eventType: string }> = [];
    const runtime = {
      subscribe: (handler: (event: unknown) => void, eventType: string) => {
        handlers.push({ handler, eventType });
      },
    } as unknown as EngineRuntime;
    bridge.attach('env-1', runtime);

    const emit = (payload: Record<string, unknown>): void => {
      for (const { handler, eventType } of handlers) {
        if (eventType === EventType.COLLABORATION_MESSAGE) {
          handler({ payload, source: payload.agentId ?? 'responder-agent' });
        }
      }
    };
    const handshake = (collaborationId: string, requiredCapabilities: string[]): void => {
      emit({
        type: 'ac-proposal',
        collaborationId,
        initiatorId: 'initiator-agent',
        targetAgentId: 'responder-agent',
        requiredCapabilities,
        triggerEventType: 'co2-high',
        triggerZoneId: 'dorm-3-f1',
      });
      emit({
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'responder-agent',
        collaborationId,
      });
    };
    return { created, handshake };
  }

  it('dorm-3 CO2 event: the dorm-3 fan offer wins over the building-6 twin, terms.trigger carries the zone', () => {
    const { created, handshake } = setup({
      services: [
        // Lexicographic order alone would pick the building-6 offer.
        derivedService('svc-a-fan-b6', 'ventilation', 'dev-fan-b6'),
        derivedService('svc-z-fan-b3', 'ventilation', 'dev-fan-b3'),
      ],
      deviceZones: { 'dev-fan-b6': 'dorm-6-f1', 'dev-fan-b3': 'dorm-3-f1' },
    });
    handshake('ac-zone-pref', ['ventilation']);

    expect(created).toHaveLength(1);
    expect(created[0].serviceId).toBe('svc-z-fan-b3');
    expect(created[0].terms).toEqual({
      trigger: { eventType: 'co2-high', parameter: 'ventilation', zoneId: 'dorm-3-f1' },
    });
  });

  it('only cross-zone candidates: the agreement still LANDS, annotated cross-zone in terms.notes', () => {
    const { created, handshake } = setup({
      services: [derivedService('svc-a-fan-b6', 'ventilation', 'dev-fan-b6')],
      deviceZones: { 'dev-fan-b6': 'dorm-6-f1' },
    });
    handshake('ac-cross-zone', ['ventilation']);

    // No hard gate on the ephemeral path — but the mismatch is visible on
    // the contract itself (notes) and names both zones.
    expect(created).toHaveLength(1);
    expect(created[0].serviceId).toBe('svc-a-fan-b6');
    const terms = created[0].terms as { trigger: Record<string, unknown>; notes?: string };
    expect(terms.trigger.zoneId).toBe('dorm-3-f1');
    expect(terms.notes).toContain('cross-zone');
    expect(terms.notes).toContain('dorm-3-f1');
    expect(terms.notes).toContain('dorm-6-f1');
  });
});
