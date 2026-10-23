/**
 * @vitest-environment node
 *
 * P5: ServiceBroker.requestService() formal request flow.
 *
 * Pre-P5 the broker auto-accepted every request ("TODO: emit event for
 * provider to handle — for now, auto-accept for testing"). Now the default
 * (SERVICE_BROKER_AUTO_ACCEPT off) routes the request through the
 * provider's own evaluation path: a formal proposal on the environment
 * event bus (CollaborationProposalHandler's channel), awaiting the
 * provider's accept/reject answer correlated by requestId; silence past the
 * timeout rejects. The legacy auto-accept survives behind the flag for
 * tests/demos.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventPriority, EventType } from '@active-collaboration/shared';

import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { EventManager } from '../../events/EventManager.js';
import { ServiceBroker } from '../ServiceBroker.js';
import type { CollaborationServiceQuery, ServiceOffer } from '../ServiceRequest.js';

const PROVIDER = 'provider-1';
const REQUESTER = 'consumer-1';

function makeOffer(): ServiceOffer {
  return {
    providerId: PROVIDER,
    providerName: 'Provider One',
    serviceId: 'svc-cooling',
    serviceName: 'Cooling Service',
    serviceType: 'cooling',
    serviceDescription: 'Delivers zone cooling',
    actionType: 'control',
    capabilities: ['cooling'],
    capabilitiesDescriptions: [],
    deviceId: 'device-1',
    deviceType: 'hvac',
  };
}

function makeQuery(): CollaborationServiceQuery {
  return { serviceType: 'cooling', requiredCapabilities: ['cooling'] };
}

function makeEnvironment(eventManager: EventManager, agents: Array<{ id: string }>): EnvironmentCenter {
  return {
    id: 'env-broker-request',
    eventManager,
    listAgents: () => agents,
  } as unknown as EnvironmentCenter;
}

/**
 * A stand-in for the provider's CollaborationProposalHandler: answers the
 * formal proposal with the same join-response/reject shape the real
 * handler publishes (collaborationId = the proposal's metadata).
 */
function wireProviderAnswer(eventManager: EventManager, decision: 'accept' | 'reject'): void {
  eventManager.subscribe({
    subscriberId: 'fake-provider-handler',
    eventType: EventType.COLLABORATION_PROPOSAL,
    priority: EventPriority.NORMAL,
    handler: event => {
      const proposal = (event.payload as {
        proposal?: { proposedTo?: string; metadata?: { collaborationId?: string } };
      }).proposal;
      if (!proposal || proposal.proposedTo !== PROVIDER) return;
      setTimeout(() => {
        eventManager.publish({
          type: EventType.COLLABORATION_MESSAGE,
          source: PROVIDER,
          priority: EventPriority.NORMAL,
          payload: {
            type: decision === 'accept' ? 'join-response' : 'reject',
            acDecision: decision,
            agentId: PROVIDER,
            collaborationId: proposal.metadata?.collaborationId,
            reason: decision === 'accept' ? 'can deliver' : 'over capacity',
          },
          metadata: {},
        });
      }, 0);
    },
  });
}

describe('ServiceBroker.requestService (P5 formal request flow)', () => {
  afterEach(() => {
    delete process.env.SERVICE_BROKER_AUTO_ACCEPT;
  });

  it('flag off: publishes a formal proposal and contracts on the provider accept', async () => {
    const eventManager = new EventManager();
    wireProviderAnswer(eventManager, 'accept');
    const broker = new ServiceBroker(makeEnvironment(eventManager, [{ id: PROVIDER }, { id: REQUESTER }]));

    const result = await broker.requestService(makeOffer(), makeQuery(), REQUESTER);

    expect(result.success).toBe(true);
    expect(result.request.state).toBe('accepted');
    expect(result.contract).toBeDefined();
    expect(result.contract!.providerId).toBe(PROVIDER);
    expect(result.contract!.consumerId).toBe(REQUESTER);
    expect(result.contract!.state).toBe('active');
  });

  it('flag off: the proposal carries the requested capabilities + service term to the provider', async () => {
    const eventManager = new EventManager();
    wireProviderAnswer(eventManager, 'accept');
    const broker = new ServiceBroker(makeEnvironment(eventManager, [{ id: PROVIDER }, { id: REQUESTER }]));

    const seen: Array<Record<string, unknown>> = [];
    eventManager.subscribe({
      subscriberId: 'proposal-spy',
      eventType: EventType.COLLABORATION_PROPOSAL,
      priority: EventPriority.NORMAL,
      handler: event => seen.push(event.payload as Record<string, unknown>),
    });

    await broker.requestService(makeOffer(), makeQuery(), REQUESTER);

    expect(seen).toHaveLength(1);
    const proposal = seen[0].proposal as {
      proposedBy: string;
      proposedTo: string;
      capabilities: string[];
      services: Array<{ name: string; semanticType?: string }>;
      metadata: { collaborationId: string };
    };
    expect(proposal.proposedBy).toBe(REQUESTER);
    expect(proposal.proposedTo).toBe(PROVIDER);
    expect(proposal.capabilities).toEqual(['cooling']);
    expect(proposal.services).toEqual([{ name: 'Cooling Service', semanticType: 'cooling' }]);
    // The answer correlates by requestId — no cross-talk between requests.
    expect(typeof proposal.metadata.collaborationId).toBe('string');
  });

  it('flag off: a provider reject fails the request with the provider reason', async () => {
    const eventManager = new EventManager();
    wireProviderAnswer(eventManager, 'reject');
    const broker = new ServiceBroker(makeEnvironment(eventManager, [{ id: PROVIDER }, { id: REQUESTER }]));

    const result = await broker.requestService(makeOffer(), makeQuery(), REQUESTER);

    expect(result.success).toBe(false);
    expect(result.request.state).toBe('rejected');
    expect(result.contract).toBeUndefined();
    expect(result.error).toBe('over capacity');
  });

  it('flag off: silence past the timeout rejects (no auto-accept)', async () => {
    const eventManager = new EventManager();
    const broker = new ServiceBroker(makeEnvironment(eventManager, [{ id: PROVIDER }, { id: REQUESTER }]));

    const result = await broker.requestService(makeOffer(), makeQuery(), REQUESTER, { timeout: 50 });

    expect(result.success).toBe(false);
    expect(result.request.state).toBe('rejected');
    expect(result.error).toContain('did not answer within 50ms');
  });

  it('flag off: an unreachable provider rejects immediately without publishing', async () => {
    const eventManager = new EventManager();
    const broker = new ServiceBroker(makeEnvironment(eventManager, [{ id: REQUESTER }]));

    const seen: unknown[] = [];
    eventManager.subscribe({
      subscriberId: 'proposal-spy',
      eventType: EventType.COLLABORATION_PROPOSAL,
      priority: EventPriority.NORMAL,
      handler: event => seen.push(event.payload),
    });

    const result = await broker.requestService(makeOffer(), makeQuery(), REQUESTER, { timeout: 50 });

    expect(result.success).toBe(false);
    expect(result.request.state).toBe('rejected');
    expect(result.error).toContain('not reachable');
    expect(seen).toHaveLength(0);
  });

  it('flag on: keeps the legacy auto-accept (tests/demos) without any provider round-trip', async () => {
    process.env.SERVICE_BROKER_AUTO_ACCEPT = '1';
    const eventManager = new EventManager();
    const broker = new ServiceBroker(makeEnvironment(eventManager, [])); // provider NOT online

    const seen: unknown[] = [];
    eventManager.subscribe({
      subscriberId: 'proposal-spy',
      eventType: EventType.COLLABORATION_PROPOSAL,
      priority: EventPriority.NORMAL,
      handler: event => seen.push(event.payload),
    });

    const result = await broker.requestService(makeOffer(), makeQuery(), REQUESTER);

    expect(result.success).toBe(true);
    expect(result.request.state).toBe('accepted');
    expect(result.contract).toBeDefined();
    expect(seen).toHaveLength(0);
  });
});
