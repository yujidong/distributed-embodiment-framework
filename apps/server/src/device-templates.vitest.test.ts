/**
 * @vitest-environment node
 *
 * Device-template catalog API tests (UX wave-3): GET /api/device-templates
 * passes the simulation package's DeviceTemplateRegistry through, read-only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { DeviceTemplateRegistry } from '@active-collaboration/simulation';

import { buildServer } from './server.js';
import { auth, registerUser, type TestUser } from './test-utils.js';

describe('device-templates API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let user: TestUser;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'device-templates-test-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:' });
    user = await registerUser(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/device-templates' });
    expect(res.statusCode).toBe(401);
  });

  it('passes the whole registry through with the documented shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/device-templates', headers: auth(user.token) });
    expect(res.statusCode).toBe(200);
    const { templates } = res.json();
    const registered = DeviceTemplateRegistry.listTemplates();
    expect(templates).toHaveLength(registered.length);
    expect(templates.length).toBeGreaterThanOrEqual(70); // 73 built-ins today

    for (const entry of templates) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id).toBe(entry.name.toLowerCase());
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(Array.isArray(entry.capabilities)).toBe(true);
      expect(Array.isArray(entry.defaultBehaviors)).toBe(true);
    }
    // Sorted by id.
    const ids = templates.map((t: { id: string }) => t.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('carries environmentEffects and visualization where the registry declares them', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/device-templates', headers: auth(user.token) });
    const { templates } = res.json();
    const thermostat = templates.find((t: { id: string }) => t.id === 'thermostat');
    expect(thermostat).toBeDefined();
    expect(thermostat.capabilities).toContain('set-target-temperature');
    expect(Array.isArray(thermostat.environmentEffects)).toBe(true);
    expect(thermostat.environmentEffects.length).toBeGreaterThan(0);

    const streetLight = templates.find((t: { id: string }) => t.id === 'smart-street-light');
    expect(streetLight.visualization).toMatchObject({ icon: 'street-light', layer: 'safety' });
    expect(streetLight.category).toBe('smart-city');

    // Templates without optional faces omit the keys (no null spam).
    const motion = templates.find((t: { id: string }) => t.id === 'motion-sensor');
    expect(motion).toBeDefined();
    expect('visualization' in motion).toBe(false);
  });
});
