/**
 * T-048 tests — channel honesty for `eaf agent rm` / `eaf agent update`:
 * a builder's governed lifecycle call must report the PROPOSAL outcome
 * (proposal: true in --json, proposal id/status in human mode), never
 * fabricate a direct deletion/patch. The env-owner paths keep their direct
 * output; the builder update falls back to a modify-object proposal.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
let ownerToken: string;
let builderToken: string;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-t048-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `t048-owner-${stamp}@example.com`;
const BUILDER_EMAIL = `t048-builder-${stamp}@example.com`;

/** Raw API call with a held token (for governance decisions the CLI lacks). */
async function api(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) };
}

beforeAll(async () => {
  server = await bootServer();
  // Register through the raw API so the suite also holds tokens for the
  // owner-decide governance calls; the CLI sessions log into the same users.
  const registerFor = async (email: string, displayName: string): Promise<string> => {
    const registered = await api(undefined, 'POST', '/api/auth/register', {
      email,
      password: PASSWORD,
      displayName,
    });
    expect(registered.status).toBe(201);
    const login = await api(undefined, 'POST', '/api/auth/login', {
      email,
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    return login.json.token as string;
  };
  ownerToken = await registerFor(OWNER_EMAIL, 'Owner');
  builderToken = await registerFor(BUILDER_EMAIL, 'Builder');

  owner = makeCli(server.baseUrl);
  builder = makeCli(server.baseUrl);
  expect((await owner.cli('auth', 'login', '--email', OWNER_EMAIL, '--password', PASSWORD)).code).toBe(0);
  expect((await builder.cli('auth', 'login', '--email', BUILDER_EMAIL, '--password', PASSWORD)).code).toBe(0);

  writeFileSync(
    join(owner.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: private
  map:
    type: grid
    zones:
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
        baseline: {temperature: 25}
devices:
  - name: Sensor A
    zone: room-a
    spec:
      type: temperature-sensor
      capabilities: [temperature-reading]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', BUILDER_EMAIL, '--role', 'builder')).code,
  ).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

/**
 * The builder's OWN device (agent binds must reference author-owned devices,
 * 设备私有) — installed once via a governed device-add proposal.
 */
let builderDeviceName = '';

async function installBuilderDevice(): Promise<void> {
  if (builderDeviceName !== '') return;
  builderDeviceName = `T048 Device ${stamp}`;
  const added = await builder.cli(
    'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
    '--type', 'temperature-sensor', '--capabilities', 'temperature-reading',
    '--name', builderDeviceName, '--json',
  );
  expect(added.code).toBe(0);
  if (added.json().status !== 'applied') {
    const decided = await api(ownerToken, 'POST', `/api/proposals/${added.json().id}/decide`, {
      decision: 'approved',
    });
    expect(decided.status).toBe(200);
    expect(decided.json.status).toBe('applied');
  }
}

/** Install a builder-owned agent (proposal → owner approves); returns its id. */
async function installBuilderAgent(name: string): Promise<string> {
  await installBuilderDevice();
  writeFileSync(
    join(builder.home, 'agent.yaml'),
    `name: ${name}\ncapabilities: [temperature-monitoring]\nbind: [${builderDeviceName}]\n`,
  );
  const added = await builder.cli('agent', 'add', '--env', WORLD_NAME, '--file', 'agent.yaml', '--json');
  expect(added.code).toBe(0);
  expect(added.json().status, `install-agents proposal outcome: ${JSON.stringify(added.json().ruleCheck)}`).not.toBe('rejected');
  if (added.json().status !== 'applied') {
    const decided = await api(ownerToken, 'POST', `/api/proposals/${added.json().id}/decide`, {
      decision: 'approved',
    });
    expect(decided.status).toBe(200);
    expect(decided.json.status).toBe('applied');
  }
  const listed = await builder.cli('agent', 'list', '--env', WORLD_NAME, '--json');
  const agent = listed.json().find((row: any) => row.name === name);
  expect(agent).toBeDefined();
  return agent.id as string;
}

async function agentRow(id: string): Promise<any> {
  const listed = await builder.cli('agent', 'list', '--env', WORLD_NAME, '--json');
  return listed.json().find((row: any) => row.id === id) ?? null;
}

describe('agent rm (T-048 honesty)', () => {
  test("builder rm reports the remove-agents proposal, the agent stays until approval", async () => {
    const agentId = await installBuilderAgent('T048 Doomed');

    const human = await builder.cli('agent', 'rm', agentId);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`proposal \\S+ submitted \\(remove-agents → \\S+\\)`));
    expect(human.stdout).toContain('leaves the world when the pipeline approves it');
    // Honesty: nothing was deleted yet.
    expect(await agentRow(agentId)).not.toBeNull();

    const proposalId = human.stdout.match(/proposal (\S+) submitted/)![1];
    const decided = await api(ownerToken, 'POST', `/api/proposals/${proposalId}/decide`, {
      decision: 'approved',
    });
    expect(decided.json.status).toBe('applied');
    expect(await agentRow(agentId)).toBeNull();
  });

  test('builder rm --json flags proposal: true with the full proposal body', async () => {
    const agentId = await installBuilderAgent('T048 Json');

    const removed = await builder.cli('agent', 'rm', agentId, '--json');
    expect(removed.code).toBe(0);
    const body = removed.json();
    expect(body.proposal).toBe(true);
    expect(body.kind).toBe('remove-agents');
    expect(body.id).toBeTruthy();
    expect(typeof body.status).toBe('string');
    expect(body.deleted).toBeUndefined(); // the old fabricated shape is gone
    expect(await agentRow(agentId)).not.toBeNull();

    await api(ownerToken, 'POST', `/api/proposals/${body.id}/decide`, { decision: 'approved' });
    expect(await agentRow(agentId)).toBeNull();
  });

  test('env owner rm keeps the direct deleted output (204 path)', async () => {
    // The owner's own agent deletes directly through the owner path.
    writeFileSync(
      join(owner.home, 'owner-agent.yaml'),
      'name: T048 Owner Agent\ncapabilities: [temperature-monitoring]\nbind: [Sensor A]\n',
    );
    const added = await owner.cli('agent', 'add', '--env', WORLD_NAME, '--file', 'owner-agent.yaml', '--json');
    expect(added.code).toBe(0);
    const listed = await owner.cli('agent', 'list', '--env', WORLD_NAME, '--json');
    const agent = listed.json().find((row: any) => row.name === 'T048 Owner Agent');
    expect(agent).toBeDefined();

    const removed = await owner.cli('agent', 'rm', agent.id, '--json');
    expect(removed.code).toBe(0);
    expect(removed.json()).toEqual({ deleted: agent.id });
    expect(await agentRow(agent.id)).toBeNull();
  });
});

describe('agent update (T-048 builder fallback)', () => {
  test("builder update falls back to a modify-object proposal (structural field); enabled lands directly (R5-F03)", async () => {
    const agentId = await installBuilderAgent('T048 Toggle');

    // R5-F03: the agent's OWNER may directly patch pure decision config
    // (llm / decisionPolicy / enabled) — an enabled toggle is a DIRECT PATCH
    // now, no proposal detour (channel honesty: --json carries the agent).
    const disabled = await builder.cli('agent', 'update', agentId, '--disable', '--json');
    expect(disabled.code).toBe(0);
    expect(disabled.json().enabled).toBe(false);
    expect(disabled.json().proposal).toBeUndefined();
    expect(await agentRow(agentId)).toMatchObject({ enabled: false });

    // Structural changes (name/capabilities/bindings/zones) stay governed:
    // the direct PATCH route is 403 → the CLI converts to a governed
    // modify-object proposal instead of failing the builder.
    const renamed = await builder.cli('agent', 'update', agentId, '--name', 'T048 Toggle Renamed', '--json');
    expect(renamed.code).toBe(0);
    const body = renamed.json();
    expect(body.proposal).toBe(true);
    expect(body.kind).toBe('modify-object');
    expect(body.payload.patch.name).toBe('T048 Toggle Renamed');

    await api(ownerToken, 'POST', `/api/proposals/${body.id}/decide`, { decision: 'approved' });
    const row = await agentRow(agentId);
    expect(row.name).toBe('T048 Toggle Renamed');
  });

  test('env owner update keeps the direct PATCH output', async () => {
    writeFileSync(
      join(owner.home, 'owner-agent2.yaml'),
      'name: T048 Owner Toggle\ncapabilities: [temperature-monitoring]\nbind: [Sensor A]\n',
    );
    await owner.cli('agent', 'add', '--env', WORLD_NAME, '--file', 'owner-agent2.yaml', '--json');
    const listed = await owner.cli('agent', 'list', '--env', WORLD_NAME, '--json');
    const agent = listed.json().find((row: any) => row.name === 'T048 Owner Toggle');

    const updated = await owner.cli('agent', 'update', agent.id, '--enable', '--json');
    expect(updated.code).toBe(0);
    expect(updated.json().proposal).toBeUndefined();
    expect(updated.json().enabled).toBe(true);
  });
});
