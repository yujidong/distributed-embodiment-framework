/**
 * @vitest-environment node
 *
 * T-074 (DevLoop R22, NW-F05) — device-detail executability surface.
 *
 * GET /api/devices/:id (and the env device listings) used to derive
 * `commands` as declared capabilities ∩ registered handlers — which
 * answered `[]` for a lighting-control smart-light the flow oracle happily
 * executes (no handler is registered for the literal 'lighting-control';
 * dispatch expands it to turn-on + set-brightness). A misleading
 * pre-flight surface. The field now mirrors the ONE shared oracle
 * (executableCommandPath + isCapabilityExecutable — the same contract flow
 * validation and agreement-invoke gates use); these tests pin that parity.
 */

import { executableCommandPath, type ScenarioDevice } from '@active-collaboration/core';
import { isCapabilityExecutable } from '@active-collaboration/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

describe('device-detail executability surface (T-074)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Executability Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createDevice(
    name: string,
    type: string,
    capabilities: string[],
  ): Promise<{ id: string; commands: string[] }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name, type, capabilities, zoneId: 'zone-a' },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; commands: string[] };
  }

  /** The flow-validation oracle's answer for one device, computed independently. */
  function oracleCommands(
    capabilities: string[],
    type: string,
    binding = 'sim://x',
  ): string[] {
    const device: ScenarioDevice = {
      id: 'oracle',
      name: 'oracle',
      type,
      role: 'hybrid',
      capabilities,
      zoneId: 'zone-a',
      binding,
    };
    const names = new Set<string>();
    for (const capability of capabilities) {
      const path = executableCommandPath(device, capability, isCapabilityExecutable);
      if (path !== null) for (const command of path) names.add(command);
    }
    return [...names];
  }

  it('the finding: a lighting-control smart-light no longer answers commands: []', async () => {
    const device = await createDevice('Floodlight', 'smart-light', ['lighting-control']);
    // The oracle's own answer: the semantic route maps lighting-control →
    // turn-on on light types (that route wins before the multi-command
    // expansion in executableCommandPath — mirrored exactly, not invented).
    expect(device.commands).toContain('turn-on');
    expect(device.commands.length).toBeGreaterThan(0);
  });

  it('oracle parity: commands === the flow-validation oracle over the declared capabilities', async () => {
    const cases: Array<{ type: string; capabilities: string[] }> = [
      { type: 'smart-light', capabilities: ['lighting-control'] },
      { type: 'hvac', capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
      // Semantic mapping: 'environment' → turn-on on an actuator type.
      { type: 'dehumidifier', capabilities: ['environment'] },
      // Lock family expansion: access-control → the audited 'lock' command.
      { type: 'smart-lock', capabilities: ['access-control'] },
      // Sensor: read-only capability is executable as a query.
      { type: 'temperature-sensor', capabilities: ['temperature-reading'] },
      // A capability with no dispatch route contributes NOTHING (dead
      // declarations stay honest — the #1 new-user trap, TASK-002).
      { type: 'smart-light', capabilities: ['emergency-broadcast'] },
    ];
    for (const { type, capabilities } of cases) {
      const device = await createDevice(`${type}-${capabilities.join('-')}`, type, capabilities);
      const expected = oracleCommands(capabilities, type, `sim://${device.id}`);
      expect(new Set(device.commands)).toEqual(new Set(expected));
    }
  });

  it('the single-device GET agrees with the create response (same serializer)', async () => {
    const created = await createDevice('Pa', 'pa-column', ['emergency-broadcast', 'turn-on']);
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${created.id}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().commands).toEqual(created.commands);
  });
});
