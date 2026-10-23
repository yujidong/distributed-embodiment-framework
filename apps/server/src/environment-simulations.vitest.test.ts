/**
 * @vitest-environment node
 *
 * Environment → simulation bridge tests (rule-only, no LLM backend).
 *
 * `POST /api/simulations { environmentId }` converts the environment record
 * into a ScenarioDefinition (zones from map data, devices/agents from
 * instance rows) and builds a regular EngineRuntime: the registry record's
 * scenarioId IS the environment id, snapshots carry the environment's name,
 * and stepping works exactly like the legacy scenarioId path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('simulation from environmentId', () => {
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
      payload: { ...importableScenario('bridge-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('builds and steps a simulation from an environment (public env, anonymous allowed)', async () => {
    // Anonymous: public environments can be simulated without credentials.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const sim = created.json();
    expect(sim.environmentId).toBe(envId);
    expect(sim.scenarioId).toBe(envId); // bridge: env id becomes the scenario id
    expect(sim.state).toBe('created');
    expect(sim.llm).toBe('rule-only');

    const step = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.id}/step`,
      payload: { n: 3 },
    });
    expect(step.statusCode).toBe(200);
    expect(step.json().simTimeSec).toBeGreaterThanOrEqual(3);

    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${sim.id}/snapshot`,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().scenarioId).toBe(envId);
    expect(snapshot.json().zones.map((z: { id: string }) => z.id).sort()).toEqual(['zone-a', 'zone-b']);
    expect(snapshot.json().agents).toHaveLength(1);

    // Fix-47: the list is scoped to the caller — anonymous callers no longer
    // see env-backed sims; the env's members (here the owner) do.
    const anonList = await ctx.app.inject({ method: 'GET', url: '/api/simulations' });
    expect(
      anonList.json().simulations.some((s: { id: string }) => s.id === sim.id),
    ).toBe(false);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations',
      headers: auth(owner.token),
    });
    const entry = list.json().simulations.find((s: { id: string }) => s.id === sim.id);
    expect(entry.environmentId).toBe(envId);
    // R5-F02: agents declared no llm block — that now DEFAULTS to the shared
    // client (openapi semantics), so on an LLM-less test server the sim
    // degrades to rule-only WITH the never-silent degradation warning.
    expect(entry.llm).toBe('rule-only');
    expect(entry.llmWarning).toMatch(/LLM_BASE_URL/);

    // Capability → command contract: snapshot devices expose the executable
    // command list derived from capabilities ∩ registered handlers (P1-5).
    const hvac = snapshot.json().devices.find((d: { type: string }) => d.type === 'hvac');
    expect(hvac.commands).toContain('temperature-control');
    expect(hvac.commands).toContain('cooling');
    expect(hvac.commands).toContain('turn-on');
  });

  it('decision records carry zoneId + structured reasoning (R15-D3/D4)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const sim = created.json();
    // Inject a high temperature event into zone-a (the agent manages both
    // zones and has actuator coverage there → precheck decides).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.id}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature', zoneId: 'zone-a', parameter: 'temperature', value: 38, severity: 'high' },
    });
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${sim.id}/step`, payload: { n: 5 } });

    const snapshot = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${sim.id}/snapshot` });
    const decisions: Array<Record<string, unknown>> = snapshot.json().recentDecisions;
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      // D4: the triggering event's zone is server-side truth on the record.
      expect(decision.zoneId).toBe('zone-a');
      // D3: rule decisions carry the structured reasoning twin.
      expect(typeof decision.reasoningCode).toBe('string');
      expect(decision.reasoningCode).toMatch(/^(precheck|rule)\./);
      // The params match whichever code fired (precheck: zone; rule: caps).
      expect(decision.reasoningParams).toBeDefined();
      expect(typeof decision.reasoning).toBe('string'); // audit copy stays
    }
  });

  it('warns explicitly when agents requested an LLM that is not configured (P1-1)', async () => {
    // Imported devices get fresh instance ids — look up the hvac by type.
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(detail.statusCode).toBe(200);
    const hvac = detail.json().devices.find((d: { type: string }) => d.type === 'hvac');
    // Environment device detail also exposes the executable command list.
    expect(hvac.commands).toContain('temperature-control');

    // An agent that explicitly requests the LLM (no LLM_BASE_URL in tests).
    const agentRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'LLM Agent',
        capabilities: ['temperature-control'],
        boundDeviceIds: [hvac.id],
        managedZoneIds: ['zone-b'],
        llm: { provider: 'openai-compatible', model: 'test-model' },
      },
    });
    expect(agentRes.statusCode).toBe(201);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const sim = created.json();
    // Degradation still happens — but never silently.
    expect(sim.llm).toBe('rule-only');
    expect(sim.llmWarning).toMatch(/LLM_BASE_URL/);
    expect(sim.llmWarning).toMatch(/rule-only/);

    // Fix-47: the list is caller-scoped — authenticate as the creator.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations',
      headers: auth(owner.token),
    });
    const entry = list.json().simulations.find((s: { id: string }) => s.id === sim.id);
    expect(entry.llmWarning).toBe(sim.llmWarning);
  });

  it('requires exactly one of scenarioId / environmentId', async () => {
    const both = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'cross-brand-home', environmentId: envId },
    });
    expect(both.statusCode).toBe(400);

    const neither = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: {},
    });
    expect(neither.statusCode).toBe(400);
  });

  it('404s on an unknown environmentId', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: 'no-such-env' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ENVIRONMENT_NOT_FOUND');
  });

  it('private environments: anonymous/stranger 403, member (even viewer) can simulate', async () => {
    const priv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('bridge-private'), visibility: 'private' },
    });
    const privId = priv.json().id;

    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: privId },
    });
    expect(anon.statusCode).toBe(403);

    const stranger = await registerUser(ctx.app);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(stranger.token),
      payload: { environmentId: privId },
    });
    expect(denied.statusCode).toBe(403);

    // A viewer member may run the demo.
    const viewer = await registerUser(ctx.app);
    ctx.app.envStore.addMember(privId, viewer.id, 'viewer');
    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(viewer.token),
      payload: { environmentId: privId },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('deleting an environment stops and removes its simulations', async () => {
    const sim = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/simulations',
        payload: { environmentId: envId },
      })
    ).json();

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${sim.id}/snapshot`,
    });
    expect(snapshot.statusCode).toBe(404);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/simulations' });
    expect(list.json().simulations.some((s: { id: string }) => s.id === sim.id)).toBe(false);
  });

  it('legacy scenarioId path stays open and unauthenticated (regression)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'cross-brand-home' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scenarioId).toBe('cross-brand-home');
    expect(created.json().environmentId).toBeUndefined();
  });
});
