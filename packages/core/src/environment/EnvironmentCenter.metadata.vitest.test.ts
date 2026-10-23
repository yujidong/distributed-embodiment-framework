/**
 * EnvironmentCenter service-registration metadata tests (P1)
 *
 * Covers:
 * - registerService with provenance/semantics meta (origin/semanticType/summary/visibility)
 * - backward compatibility of the pre-meta signature (2/3 args)
 * - registrationsForAgent listing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { EnvironmentCenter } from './EnvironmentCenter.js';
import type { EnvironmentCenterData } from './types.js';
import type { Service } from '@active-collaboration/shared';

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

describe('EnvironmentCenter - service registration metadata', () => {
  let environment: EnvironmentCenter;

  beforeEach(() => {
    const now = new Date();
    const envData: EnvironmentCenterData = {
      id: uuidv4(),
      name: 'Metadata Test Environment',
      environmentType: 'shared',
      visibility: 'platform',
      createdBy: 'user-creator',
      createdAt: now,
      updatedAt: now,
    };
    environment = new EnvironmentCenter(envData);
  });

  it('stores registration metadata when provided', () => {
    environment.registerService(makeService('Temperature Service'), 'agent-1', 'device-1', {
      origin: 'derived',
      semanticType: 'sensor',
      summary: 'temperature readings',
      visibility: 'members',
    });

    const registration = environment.getServiceRegistration('Temperature Service', 'device-1');
    expect(registration).toBeDefined();
    expect(registration!.origin).toBe('derived');
    expect(registration!.semanticType).toBe('sensor');
    expect(registration!.summary).toBe('temperature readings');
    expect(registration!.visibility).toBe('members');
    expect(registration!.agentId).toBe('agent-1');
    expect(registration!.deviceId).toBe('device-1');
  });

  it('keeps the pre-meta signature working (no metadata fields set)', () => {
    // 3-arg form (deviceId, no meta) — the legacy call shape
    environment.registerService(makeService('Legacy Service'), 'agent-1', 'device-1');
    // 2-arg form (global scope)
    environment.registerService(makeService('Global Service'), 'agent-2');

    const legacy = environment.getServiceRegistration('Legacy Service', 'device-1');
    expect(legacy).toBeDefined();
    expect(legacy!.origin).toBeUndefined();
    expect(legacy!.semanticType).toBeUndefined();
    expect(legacy!.summary).toBeUndefined();
    expect(legacy!.visibility).toBeUndefined();

    const global = environment.getServiceRegistration('Global Service');
    expect(global).toBeDefined();
    expect(global!.origin).toBeUndefined();
  });

  it('omits unset metadata fields instead of writing undefined values', () => {
    environment.registerService(makeService('Partial Service'), 'agent-1', 'device-1', {
      origin: 'published',
    });

    const registration = environment.getServiceRegistration('Partial Service', 'device-1');
    expect(registration!.origin).toBe('published');
    expect('semanticType' in registration!).toBe(false);
    expect('summary' in registration!).toBe(false);
    expect('visibility' in registration!).toBe(false);
  });

  it('registrationsForAgent lists all registrations of one agent across scopes', () => {
    environment.registerService(makeService('A Service'), 'agent-1', 'device-1', { origin: 'derived' });
    environment.registerService(makeService('B Service'), 'agent-1', 'device-2', { origin: 'derived' });
    environment.registerService(makeService('C Service'), 'agent-2', 'device-1');

    const registrations = environment.registrationsForAgent('agent-1');
    expect(registrations).toHaveLength(2);
    expect(registrations.map(r => r.service.name).sort()).toEqual(['A Service', 'B Service']);
    expect(registrations.every(r => r.origin === 'derived')).toBe(true);

    expect(environment.registrationsForAgent('agent-2')).toHaveLength(1);
    expect(environment.registrationsForAgent('agent-unknown')).toEqual([]);
  });
});
