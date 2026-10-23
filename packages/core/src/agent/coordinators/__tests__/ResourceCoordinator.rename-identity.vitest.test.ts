/**
 * @vitest-environment node
 *
 * Rename-stable derived service identity (runtime face).
 *
 * The EnvironmentCenter registration key was `${deviceId}:${service.name}`
 * and the derived service name is built FROM THE DEVICE NAME
 * (`<device name> Service`), so re-publishing after a device rename created a
 * new key and orphaned the old registration. The derived lane now registers
 * under the name-independent DERIVED_DEVICE_SERVICE_IDENTITY slot: a rename
 * is an in-place display-name update on the SAME identity — no orphan.
 */

import { describe, it, expect, vi } from 'vitest';

import type { Device } from '@active-collaboration/shared';

import { EnvironmentCenter } from '../../../environment/EnvironmentCenter.js';
import type { ResourceManager } from '../../../resource/ResourceManager.js';
import type { ServicePublisher } from '../../../service/ServicePublisher.js';
import type { ServiceRegistry } from '../../../service/ServiceRegistry.js';
import { DERIVED_DEVICE_SERVICE_IDENTITY } from '../../../service/device-service-derivation.js';
import { ResourceCoordinator } from '../ResourceCoordinator.js';

function makeCoordinator(center: EnvironmentCenter): ResourceCoordinator {
  const resourceManager = {
    registerDevice: vi.fn(),
    getCount: vi.fn().mockReturnValue(1),
    getAllResources: vi.fn().mockReturnValue([]),
  } as unknown as ResourceManager;
  const servicePublisher = { publishService: vi.fn() } as unknown as ServicePublisher;
  const serviceRegistry = { register: vi.fn() } as unknown as ServiceRegistry;
  return new ResourceCoordinator(
    resourceManager,
    servicePublisher,
    serviceRegistry,
    center,
    'agent-1',
    ['monitoring'],
  );
}

function makeCenter(): EnvironmentCenter {
  return new EnvironmentCenter({ id: 'env-1', name: 'Env 1', createdBy: 'user-1' });
}

function makeDevice(name: string): Device {
  return {
    id: 'device-1',
    name,
    type: 'light',
    status: 'online',
    location: { x: 0, y: 0, z: 0 },
    capabilities: [{ name: 'turn-on', type: 'execute' }],
  } as unknown as Device;
}

describe('derived service identity — rename stability (runtime face)', () => {
  it('a device rename re-publishes onto the SAME registry slot: name updated, no orphan', () => {
    const center = makeCenter();
    const coordinator = makeCoordinator(center);

    coordinator.assignDevices([makeDevice('Lobby Light')], 'user-1');
    const identityKey = `device-1:${DERIVED_DEVICE_SERVICE_IDENTITY}`;
    expect(center.getServices().has(identityKey)).toBe(true);
    expect(center.getServices().get(identityKey)!.service.name).toBe('Lobby Light Service');
    expect(center.getServices().get(identityKey)!.identityKey).toBe(DERIVED_DEVICE_SERVICE_IDENTITY);
    expect(center.getStats().serviceCount).toBe(1);

    // Rename + re-publish (the refresh lane every rename/capability sync takes).
    coordinator.assignDevices([makeDevice('Lobby Lamp')], 'user-1');

    // Same identity slot, display name updated in place, exactly one registration.
    expect(center.getStats().serviceCount).toBe(1);
    expect(center.getServices().get(identityKey)!.service.name).toBe('Lobby Lamp Service');
    expect(center.getServices().has('device-1:Lobby Light Service')).toBe(false);
    expect(center.getServices().has('device-1:Lobby Lamp Service')).toBe(false);
  });

  it('device-scoped discovery still finds identity-keyed derived services', () => {
    const center = makeCenter();
    const coordinator = makeCoordinator(center);

    coordinator.assignDevices([makeDevice('Lobby Light')], 'user-1');

    // The deviceId filter compares registration slots, not reconstructed keys —
    // an identity-keyed registration must not fall out of scoped discovery.
    const found = center.discoverServices({ deviceId: 'device-1' });
    expect(found.map(service => service.name)).toEqual(['Lobby Light Service']);
    expect(center.discoverServices({ deviceId: 'device-2' })).toEqual([]);
    // Name filtering composes with the device scope.
    expect(center.discoverServices({ deviceId: 'device-1', name: 'Lobby' })).toHaveLength(1);
    expect(center.discoverServices({ deviceId: 'device-1', name: 'Nope' })).toEqual([]);
  });

  it('registrations without an identityKey keep the legacy name-based slot', () => {
    const center = makeCenter();
    const service = {
      id: 'svc-legacy',
      name: 'Legacy Service',
      description: '',
      deviceId: 'device-9',
      uri: 'device://device-9',
      httpMethod: 'GET',
      parameters: [],
      location: '',
      category: 'sensor',
      isConditional: false,
    } as unknown as Parameters<EnvironmentCenter['registerService']>[0];

    center.registerService(service, 'agent-1', 'device-9');
    expect(center.getServices().has('device-9:Legacy Service')).toBe(true);
    expect(center.getServiceRegistration('Legacy Service', 'device-9')).toBeDefined();
  });
});
