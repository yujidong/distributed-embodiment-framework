/**
 * Service liveness tests (heartbeat → environment-level stale marking)
 *
 * Covers:
 * - touchServiceHeartbeat arms/refreshes lastSeenAt on the registration
 * - isRegistrationStale: heartbeat-tracked registrations go stale past the
 *   env's serviceStaleTtlMs; registrations WITHOUT lastSeenAt (world-layer
 *   mirrored rows — no heartbeat semantics) NEVER go stale
 * - ServicePublisher: publish arms liveness, the 30s heartbeat keeps the
 *   EnvironmentCenter registration fresh, unpublish stops it
 * - ServiceBroker.discoverServices: stale services filtered by default,
 *   constraints.includeStale opts out
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_SERVICE_STALE_TTL_MS,
  EnvironmentCenter,
} from './EnvironmentCenter.js';
import type { EnvironmentCenterData } from './types.js';
import type { Service } from '@active-collaboration/shared';
import { ServicePublisher, DEFAULT_SERVICE_HEARTBEAT_INTERVAL_MS } from '../service/ServicePublisher.js';
import { ServiceBroker } from '../service/ServiceBroker.js';
import { AgentService } from '../service/Service.js';
import type { CollaborationServiceQuery, ServiceOffer } from '../service/ServiceRequest.js';

const STALE_TTL_MS = 100;

function makeEnv(data?: Partial<EnvironmentCenterData>): EnvironmentCenter {
  const now = new Date();
  return new EnvironmentCenter({
    id: uuidv4(),
    name: 'Liveness Test Environment',
    environmentType: 'shared',
    visibility: 'platform',
    createdBy: 'user-creator',
    createdAt: now,
    updatedAt: now,
    serviceStaleTtlMs: STALE_TTL_MS,
    ...data,
  });
}

function makeService(name: string): Service {
  return {
    id: `service-${name}`,
    name,
    description: `${name} description`,
    deviceId: 'device-1',
    uri: `device://device-1`,
    httpMethod: 'GET',
    parameters: [],
    location: 'zone-a',
    category: 'sensor',
    isConditional: false,
  };
}

describe('EnvironmentCenter — service liveness (stale marking)', () => {
  let environment: EnvironmentCenter;

  beforeEach(() => {
    environment = makeEnv();
  });

  it('a plain registration has no heartbeat semantics and never goes stale (mirror boundary)', () => {
    environment.registerService(makeService('Mirrored Service'), 'agent-1', 'device-1');
    const registration = environment.getServiceRegistration('Mirrored Service', 'device-1')!;
    expect(registration.lastSeenAt).toBeUndefined();
    // Far past the TTL — still not stale: the DB is the liveness authority
    // for world-layer mirrored rows (see ServiceRegistration.lastSeenAt).
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(environment.isRegistrationStale(registration, future)).toBe(false);
  });

  it('touchServiceHeartbeat arms liveness; silence past the TTL marks the service stale', () => {
    environment.registerService(makeService('Live Service'), 'agent-1', 'device-1');
    expect(environment.touchServiceHeartbeat('Live Service', 'device-1')).toBe(true);

    const registration = environment.getServiceRegistration('Live Service', 'device-1')!;
    expect(registration.lastSeenAt).toBeInstanceOf(Date);
    expect(environment.isRegistrationStale(registration)).toBe(false);

    const withinTtl = new Date(registration.lastSeenAt!.getTime() + STALE_TTL_MS - 1);
    expect(environment.isRegistrationStale(registration, withinTtl)).toBe(false);
    const pastTtl = new Date(registration.lastSeenAt!.getTime() + STALE_TTL_MS + 1);
    expect(environment.isRegistrationStale(registration, pastTtl)).toBe(true);
  });

  it('a fresh touch inside the window rescues a would-be-stale registration', () => {
    environment.registerService(makeService('Rescued Service'), 'agent-1', 'device-1');
    environment.touchServiceHeartbeat('Rescued Service', 'device-1');
    const registration = environment.getServiceRegistration('Rescued Service', 'device-1')!;
    registration.lastSeenAt = new Date(Date.now() - STALE_TTL_MS - 1);
    expect(environment.isRegistrationStale(registration)).toBe(true);

    environment.touchServiceHeartbeat('Rescued Service', 'device-1');
    expect(environment.isRegistrationStale(registration)).toBe(false);
  });

  it('touch on an unknown key is a harmless no-op', () => {
    expect(environment.touchServiceHeartbeat('Ghost Service', 'device-1')).toBe(false);
  });

  it('the default TTL is 90s (3× the 30s heartbeat)', () => {
    const now = new Date();
    const env = makeEnv({ serviceStaleTtlMs: undefined, createdAt: now, updatedAt: now });
    expect(DEFAULT_SERVICE_STALE_TTL_MS).toBe(90_000);
    env.registerService(makeService('Default TTL Service'), 'agent-1', 'device-1');
    env.touchServiceHeartbeat('Default TTL Service', 'device-1');
    const registration = env.getServiceRegistration('Default TTL Service', 'device-1')!;
    registration.lastSeenAt = new Date(Date.now() - 89_000);
    expect(env.isRegistrationStale(registration)).toBe(false);
    registration.lastSeenAt = new Date(Date.now() - 91_000);
    expect(env.isRegistrationStale(registration)).toBe(true);
  });
});

describe('ServicePublisher — heartbeat feeds environment-level liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publish arms liveness and the 30s heartbeat refreshes lastSeenAt', () => {
    const environment = makeEnv();
    const publisher = new ServicePublisher();
    const service = { ...makeService('Heartbeat Service') } as unknown as AgentService;

    expect(publisher.publishService(service, 'agent-1', environment)).toBe(true);
    const registration = environment.getServiceRegistration('Heartbeat Service', 'device-1')!;
    const armedAt = registration.lastSeenAt!.getTime();

    // No heartbeat yet → unchanged; 30s later the beat refreshes the stamp.
    vi.advanceTimersByTime(29_999);
    expect(registration.lastSeenAt!.getTime()).toBe(armedAt);
    vi.advanceTimersByTime(2);
    expect(registration.lastSeenAt!.getTime()).toBeGreaterThan(armedAt);
    expect(environment.isRegistrationStale(registration)).toBe(false);

    publisher.unpublishService(service.id);
    expect(environment.getServiceRegistration('Heartbeat Service', 'device-1')).toBeUndefined();
    publisher.clear();
  });

  it('the heartbeat cadence is configurable per-instance and via SERVICE_HEARTBEAT_INTERVAL_MS', () => {
    expect(DEFAULT_SERVICE_HEARTBEAT_INTERVAL_MS).toBe(30_000);

    // Constructor override: a 50ms beat refreshes lastSeenAt at 50ms, not 30s.
    const environment = makeEnv();
    const publisher = new ServicePublisher(50);
    const service = { ...makeService('Fast Heartbeat Service') } as unknown as AgentService;
    expect(publisher.publishService(service, 'agent-1', environment)).toBe(true);
    const registration = environment.getServiceRegistration('Fast Heartbeat Service', 'device-1')!;
    const armedAt = registration.lastSeenAt!.getTime();
    vi.advanceTimersByTime(49);
    expect(registration.lastSeenAt!.getTime()).toBe(armedAt);
    vi.advanceTimersByTime(2);
    expect(registration.lastSeenAt!.getTime()).toBeGreaterThan(armedAt);
    publisher.clear();

    // Deployment-wide override: the env var sets the default cadence.
    process.env.SERVICE_HEARTBEAT_INTERVAL_MS = '70';
    try {
      const envPublisher = new ServicePublisher();
      const envService = { ...makeService('Env Heartbeat Service') } as unknown as AgentService;
      expect(envPublisher.publishService(envService, 'agent-1', environment)).toBe(true);
      const envRegistration = environment.getServiceRegistration('Env Heartbeat Service', 'device-1')!;
      const envArmedAt = envRegistration.lastSeenAt!.getTime();
      vi.advanceTimersByTime(69);
      expect(envRegistration.lastSeenAt!.getTime()).toBe(envArmedAt);
      vi.advanceTimersByTime(2);
      expect(envRegistration.lastSeenAt!.getTime()).toBeGreaterThan(envArmedAt);
      envPublisher.clear();
    } finally {
      delete process.env.SERVICE_HEARTBEAT_INTERVAL_MS;
    }
  });
});

describe('ServiceBroker — requestService stale hard gate', () => {
  afterEach(() => {
    delete process.env.SERVICE_BROKER_AUTO_ACCEPT;
  });

  function brokerEnv(): { environment: EnvironmentCenter; broker: ServiceBroker } {
    const environment = makeEnv();
    environment.registerAgent(
      { id: 'provider-agent', name: 'Provider Agent' },
      'user-creator',
    );
    const service = {
      ...makeService('Gated Service'),
      providerAgentId: 'provider-agent',
    } as Service;
    environment.registerService(service, 'provider-agent', 'device-1');
    return { environment, broker: new ServiceBroker(environment) };
  }

  function makeOffer(): ServiceOffer {
    return {
      providerId: 'provider-agent',
      providerName: 'Provider Agent',
      serviceId: 'service-Gated Service',
      serviceName: 'Gated Service',
      serviceType: 'sensor',
      serviceDescription: 'Gated service',
      actionType: 'control',
      capabilities: ['sensor'],
      capabilitiesDescriptions: [],
      deviceId: 'device-1',
      deviceType: 'sensor',
    };
  }

  const query: CollaborationServiceQuery = { serviceType: 'sensor', requiredCapabilities: ['sensor'] };

  it('an explicitly requested stale service is rejected on BOTH lanes (formal + auto-accept)', async () => {
    const { environment, broker } = brokerEnv();
    environment.touchServiceHeartbeat('Gated Service', 'device-1');
    const registration = environment.getServiceRegistration('Gated Service', 'device-1')!;
    registration.lastSeenAt = new Date(Date.now() - STALE_TTL_MS - 1);

    // Formal lane (flag off): the stale gate fires before any proposal is published.
    const formal = await broker.requestService(makeOffer(), query, 'consumer-1');
    expect(formal.success).toBe(false);
    expect(formal.request.state).toBe('rejected');
    expect(formal.contract).toBeUndefined();
    expect(formal.error).toContain('stale');
    expect(formal.error).toContain(registration.lastSeenAt!.toISOString());

    // Auto-accept lane (flag on): same verdict — no contract against a dead provider.
    process.env.SERVICE_BROKER_AUTO_ACCEPT = '1';
    const autoAccepted = await broker.requestService(makeOffer(), query, 'consumer-1');
    expect(autoAccepted.success).toBe(false);
    expect(autoAccepted.request.state).toBe('rejected');
    expect(autoAccepted.contract).toBeUndefined();
    expect(autoAccepted.error).toContain('stale');
  });

  it('mirror-style rows (no heartbeat semantics) never trip the gate; fresh rows pass it', async () => {
    process.env.SERVICE_BROKER_AUTO_ACCEPT = '1';
    const { environment, broker } = brokerEnv();
    // No touchServiceHeartbeat: the registration has no lastSeenAt — the
    // world-mirror boundary (DB is the liveness authority), never stale.
    const mirrored = await broker.requestService(makeOffer(), query, 'consumer-1');
    expect(mirrored.success).toBe(true);
    expect(mirrored.contract).toBeDefined();

    // A heartbeating (fresh) service passes the gate too.
    environment.touchServiceHeartbeat('Gated Service', 'device-1');
    const fresh = await broker.requestService(makeOffer(), query, 'consumer-1');
    expect(fresh.success).toBe(true);
    expect(fresh.contract).toBeDefined();
  });
});

describe('ServiceBroker — stale services are filtered by default', () => {
  function brokerEnv(): { environment: EnvironmentCenter; broker: ServiceBroker } {
    const environment = makeEnv();
    environment.registerAgent(
      { id: 'provider-agent', name: 'Provider Agent' },
      'user-creator',
    );
    const service = {
      ...makeService('Offered Service'),
      providerAgentId: 'provider-agent',
    } as Service;
    environment.registerService(service, 'provider-agent', 'device-1');
    return { environment, broker: new ServiceBroker(environment) };
  }

  it('a heartbeat-stale service is skipped; includeStale opts out', async () => {
    const { environment, broker } = brokerEnv();
    environment.touchServiceHeartbeat('Offered Service', 'device-1');
    const registration = environment.getServiceRegistration('Offered Service', 'device-1')!;
    registration.lastSeenAt = new Date(Date.now() - STALE_TTL_MS - 1);

    const query = { serviceType: 'all', requiredCapabilities: [] };
    const filtered = await broker.discoverServices(query);
    expect(filtered.offers).toHaveLength(0);

    const optedOut = await broker.discoverServices({
      ...query,
      constraints: { includeStale: true },
    });
    expect(optedOut.offers).toHaveLength(1);
    expect(optedOut.offers[0]!.providerId).toBe('provider-agent');
  });

  it('a fresh (heartbeating) service stays discoverable; un-touched rows are unaffected', async () => {
    const { environment, broker } = brokerEnv();
    environment.touchServiceHeartbeat('Offered Service', 'device-1');
    const live = await broker.discoverServices({ serviceType: 'all', requiredCapabilities: [] });
    expect(live.offers).toHaveLength(1);
  });
});
