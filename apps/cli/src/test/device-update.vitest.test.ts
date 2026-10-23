/**
 * R98 tests (simtest-r1 li-01/li-03, P0) — `eaf device update`:
 * rename / re-zone a device through the SAME governed lane as add/rm.
 * A builder updating THEIR OWN device is converted server-side into a
 * modify-object proposal (proposal: true in --json, id/status in human
 * mode); the env owner keeps the direct edit; updating someone else's
 * device stays a teaching 403 (Chinese, no manual-API guidance).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
let ownerToken: string;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-r98-update-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `r98upd-owner-${stamp}@example.com`;
const BUILDER_EMAIL = `r98upd-builder-${stamp}@example.com`;
const DEVICE_NAME = `R98 Meter ${stamp}`;

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

async function deviceIdByName(token: string, name: string): Promise<string> {
  const detail = await api(token, 'GET', `/api/environments/${await worldId()}`);
  const device = (detail.json.devices as Array<{ id: string; name: string }>)
    .find(row => row.name === name);
  expect(device, `device "${name}" in world`).toBeDefined();
  return device!.id;
}

let cachedWorldId = '';
async function worldId(): Promise<string> {
  if (cachedWorldId === '') {
    const list = await api(ownerToken, 'GET', '/api/environments');
    cachedWorldId = (list.json.environments as Array<{ id: string; name: string }>)
      .find(env => env.name === WORLD_NAME)!.id;
  }
  return cachedWorldId;
}

beforeAll(async () => {
  server = await bootServer();
  const registerFor = async (email: string, displayName: string): Promise<string> => {
    const registered = await api(undefined, 'POST', '/api/auth/register', {
      email,
      password: PASSWORD,
      displayName,
    });
    expect(registered.status).toBe(201);
    const login = await api(undefined, 'POST', '/api/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(200);
    return login.json.token as string;
  };
  ownerToken = await registerFor(OWNER_EMAIL, 'Owner');
  await registerFor(BUILDER_EMAIL, 'Builder');

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
      - id: room-b
        bounds: {minX: 5, maxX: 10, minY: 0, maxY: 5}
        baseline: {temperature: 26}
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', BUILDER_EMAIL, '--role', 'builder')).code,
  ).toBe(0);

  // The builder's OWN device, installed via the governed add lane.
  const added = await builder.cli(
    'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
    '--type', 'temperature-sensor', '--capabilities', 'temperature-reading',
    '--name', DEVICE_NAME, '--json',
  );
  expect(added.code).toBe(0);
  if (added.json().status !== 'applied') {
    const decided = await api(ownerToken, 'POST', `/api/proposals/${added.json().id}/decide`, {
      decision: 'approved',
    });
    expect(decided.status).toBe(200);
    expect(decided.json.status).toBe('applied');
  }
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf device update (R98)', () => {
  test('builder update of their OWN device converts to a modify-object proposal; approval lands it', async () => {
    const deviceId = await deviceIdByName(ownerToken, DEVICE_NAME);
    const updated = await builder.cli(
      'device', 'update', deviceId, '--name', 'R98 Renamed', '--zone', 'room-b', '--json',
    );
    expect(updated.code).toBe(0);
    const body = updated.json();
    expect(body.proposal).toBe(true);
    expect(body.kind).toBe('modify-object');
    expect(body.payload).toMatchObject({
      targetId: deviceId,
      patch: { name: 'R98 Renamed', zoneId: 'room-b' },
    });

    if (body.status !== 'applied') {
      const decided = await api(ownerToken, 'POST', `/api/proposals/${body.id}/decide`, {
        decision: 'approved',
      });
      expect(decided.status).toBe(200);
      expect(decided.json.status).toBe('applied');
    }
    const detail = await api(ownerToken, 'GET', `/api/devices/${deviceId}`);
    expect(detail.json.name).toBe('R98 Renamed');
    expect(detail.json.zoneId).toBe('room-b');
  });

  test('builder update of SOMEONE ELSE\'S device stays a teaching 403 (Chinese, no POST /api guidance)', async () => {
    // The owner's world.yaml device is "Sensor A"... this world has none, so
    // owner adds one directly.
    const added = await owner.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
      '--type', 'light', '--capabilities', 'lighting-control',
      '--name', `Owner Lamp ${stamp}`, '--json',
    );
    expect(added.code).toBe(0);
    const denied = await builder.cli('device', 'update', added.json().id, '--name', 'Hijack');
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('FORBIDDEN');
    expect(denied.stderr).toContain('仅限环境所有者');
    expect(denied.stderr).not.toContain('POST /api');
  });

  test('env owner update keeps the direct-edit output', async () => {
    const added = await owner.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
      '--type', 'temperature-sensor', '--capabilities', 'temperature-reading',
      '--name', `Owner Meter ${stamp}`, '--json',
    );
    expect(added.code).toBe(0);
    const updated = await owner.cli('device', 'update', added.json().id, '--name', 'Owner Renamed', '--json');
    expect(updated.code).toBe(0);
    expect(updated.json().proposal).toBeUndefined();
    expect(updated.json().name).toBe('Owner Renamed');
  });

  test('no change flags is a usage error', async () => {
    const deviceId = await deviceIdByName(ownerToken, 'Owner Renamed');
    const res = await builder.cli('device', 'update', deviceId);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('nothing to update');
  });
});
