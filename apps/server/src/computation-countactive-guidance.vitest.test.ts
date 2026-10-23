/**
 * @vitest-environment node
 *
 * T-075 (DevLoop R22, CC-F04) — countActive state-key guidance.
 *
 * `countActive` defaults its state path to 'active' — a key NO platform
 * command handler ever writes (turn-on/turn-off maintain power/on/powered),
 * so a plausible-looking spec silently counts zero forever. Chosen shape
 * (per the finding, following the T-406 warning precedent): non-blocking
 * REGISTRATION WARNINGS, not a 400 — device state keys are free-form, and a
 * device may legitimately track a custom key in initialState. Two layers:
 * the parse layer teaches on the bare default; the route layer checks the
 * bound devices' ACTUAL tracked keys (initialState ∪ the boolean spellings
 * the power commands maintain) and names what IS tracked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COUNT_ACTIVE_BOOLEAN_KEYS,
  parseComputationSpec,
} from './computation-evaluator.js';
import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

describe('countActive state-key guidance (T-075)', () => {
  describe('parse layer (pure)', () => {
    it('the bare countActive default warns that no handler writes "active"', () => {
      const { warnings } = parseComputationSpec({
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'device', capability: 'motion-detection', fn: 'countActive', as: 'activeMotion' },
          ],
        },
      });
      const warning = warnings.find(text => text.includes('DEFAULT state key "active"'));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/power.*on.*powered/);
    });

    it('an explicit path does not trigger the default warning', () => {
      const { warnings } = parseComputationSpec({
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'device', capability: 'motion-detection', fn: 'countActive', path: 'power', as: 'activeMotion' },
          ],
        },
      });
      expect(warnings.some(text => text.includes('DEFAULT state key'))).toBe(false);
    });

    it('the boolean spellings the power commands maintain are the documented set', () => {
      expect(COUNT_ACTIVE_BOOLEAN_KEYS).toEqual(['power', 'on', 'powered']);
    });
  });

  describe('registration route (world-aware)', () => {
    let ctx: TestAppContext;
    let owner: TestUser;
    let consumer: TestUser;
    let envId: string;
    let serviceId: string;

    beforeEach(async () => {
      ctx = await makeTestApp();
      owner = await registerUser(ctx.app, { displayName: 'Owner' });
      consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          version: '1.0',
          visibility: 'public',
          meta: { id: 'countactive-lab', name: 'CountActive Lab' },
          zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
          devices: [
            {
              // No initialState at all: nothing tracks 'active'.
              id: 'motion-1',
              name: 'Motion 1',
              type: 'motion-sensor',
              capabilities: ['motion-detection'],
              zoneId: 'zone-a',
            },
            {
              // This one DOES track a custom boolean key.
              id: 'motion-2',
              name: 'Motion 2',
              type: 'motion-sensor',
              capabilities: ['motion-detection'],
              zoneId: 'zone-a',
              initialState: { engaged: false },
            },
          ],
          agents: [
            {
              id: 'provider-bot',
              name: 'Provider Bot',
              capabilities: ['motion-monitoring'],
              managesZoneIds: ['zone-a'],
              boundDeviceIds: ['motion-1', 'motion-2'],
            },
          ],
          events: [],
        },
      });
      expect(created.statusCode).toBe(201);
      envId = created.json().id as string;

      const detail = (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}`,
        headers: auth(owner.token),
      })).json();
      const agentId = (detail.agents as Array<{ id: string; name: string }>)
        .find(agent => agent.name === 'Provider Bot')!.id;

      const published = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents/${agentId}/services`,
        headers: auth(owner.token),
        payload: { name: 'motion-aggregate', semanticType: 'motion-aggregate' },
      });
      expect(published.statusCode).toBe(201);
      serviceId = published.json().id as string;
      void consumer;
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    function register(metrics: Array<Record<string, unknown>>) {
      return ctx.app.inject({
        method: 'POST',
        url: `/api/services/${serviceId}/computation`,
        headers: auth(owner.token),
        payload: {
          kind: 'device-aggregate',
          refreshSec: 60,
          inputs: { zones: ['zone-a'], metrics },
          interface: {
            dataSchema: {
              fields: metrics.map(metric => ({ name: metric.as, type: 'integer' })),
            },
          },
        },
      });
    }

    it('a countActive key nobody tracks warns, naming what the devices DO track', async () => {
      const res = await register([
        { source: 'device', capability: 'motion-detection', fn: 'countActive', path: 'status', as: 'activeMotion' },
      ]);
      expect(res.statusCode).toBe(201);
      const warnings = res.json().warnings as string[];
      const world = warnings.find(text => text.includes('reads state key "status"'));
      expect(world).toBeDefined();
      // The tracked-key set the warning names includes the boolean spellings
      // AND the custom initialState key of motion-2.
      expect(world).toMatch(/"power"/);
      expect(world).toMatch(/"engaged"/);
      expect(world).toMatch(/"power" is the universal boolean/);
    });

    it('a countActive on the custom key a device tracks does not warn (world-aware pass)', async () => {
      const res = await register([
        { source: 'device', capability: 'motion-detection', fn: 'countActive', path: 'engaged', as: 'engagedMotion' },
      ]);
      expect(res.statusCode).toBe(201);
      const warnings = res.json().warnings as string[] | undefined;
      expect(warnings?.some(text => text.includes('reads state key "engaged"')) ?? false).toBe(false);
    });

    it('path "power" is accepted with no world-aware warning (the recommended key)', async () => {
      const res = await register([
        { source: 'device', capability: 'motion-detection', fn: 'countActive', path: 'power', as: 'poweredMotion' },
      ]);
      expect(res.statusCode).toBe(201);
      const warnings = res.json().warnings as string[] | undefined;
      expect(warnings === undefined || warnings.length === 0).toBe(true);
    });

    it('warnings are non-blocking: the spec still registers', async () => {
      const res = await register([
        { source: 'device', capability: 'motion-detection', fn: 'countActive', as: 'activeMotion' },
      ]);
      expect(res.statusCode).toBe(201);
      expect(res.json().computation).toBeDefined();
      const got = await ctx.app.inject({
        method: 'GET',
        url: `/api/services/${serviceId}/computation`,
        headers: auth(owner.token),
      });
      expect(got.statusCode).toBe(200);
      expect(got.json().computation.spec.metrics).toHaveLength(1);
    });
  });
});
