/**
 * `eaf env asks` (T-069, R23) — the CLI surface of the standing-ask 需求板:
 * create / list / withdraw against a live server, plus the match round-trip
 * (night posts the ask over the CLI; the facility publishes a matching
 * service over raw HTTP; night's ask flips matched on the next list).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let night: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-asks-${stamp}`;

interface AskJson {
  id: string;
  semanticType: string;
  status: string;
  zoneId?: string;
  autoPropose: boolean;
}

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  night = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', `own-${stamp}@example.com`, '--password', 'password-123', '--name', 'Ask Owner')).code,
  ).toBe(0);
  expect(
    (await night.cli('auth', 'register', '--email', `night-${stamp}@example.com`, '--password', 'password-123', '--name', 'NightWatch')).code,
  ).toBe(0);

  const created = await owner.cli(
    'env', 'create', '--name', WORLD_NAME, '--visibility', 'public', '--json',
  );
  expect(created.code).toBe(0);
  const envId = created.json().id as string;
  const patch = await fetch(`${server.baseUrl}/api/environments/${envId}`, {
    method: 'PATCH',
    headers: await authHeaders(owner, stamp),
    body: JSON.stringify({
      mapData: {
        zones: [
          { id: 'atrium', name: 'Atrium' },
          { id: 'dock', name: 'Dock' },
        ],
      },
    }),
  });
  expect(patch.status).toBe(200);
  const joined = await night.cli('env', 'join', WORLD_NAME);
  expect(joined.code).toBe(0);
});

async function authHeaders(user: CliRunner, s: string): Promise<Record<string, string>> {
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: user === owner ? `own-${s}@example.com` : `night-${s}@example.com`,
      password: 'password-123',
    }),
  });
  const token = ((await login.json()) as { token: string }).token;
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function envId(): Promise<string> {
  const detail = await owner.cli('env', 'get', WORLD_NAME, '--json');
  return detail.json().id as string;
}

afterAll(async () => {
  await server.stop();
});

describe('eaf env asks (T-069 demand board)', () => {
  test('create → list → match → single-match list, with --json parity', async () => {
    const id = await envId();

    // Bad flag usage teaches (house contract).
    const noType = await night.cli('env', 'asks', 'create', WORLD_NAME);
    expect(noType.code).not.toBe(0);
    expect(noType.stderr).toContain('--type');

    // 'switching' is the honest derived semantic type a floodlight carries
    // (lighting-control's executable surface on a light collapses to it).
    const created = await night.cli(
      'env', 'asks', 'create', WORLD_NAME,
      '--type', 'switching',
      '--zone', 'atrium',
      '--note', 'night shift wants emergency lighting',
      '--terms', '{"quotaPerWindow":20,"windowSec":86400}',
      '--json',
    );
    expect(created.code).toBe(0);
    const ask = created.json() as AskJson;
    expect(ask.status).toBe('open');
    expect(ask.semanticType).toBe('switching');
    expect(ask.zoneId).toBe('atrium');

    // Unknown zone is a teaching 400 through the CLI too.
    const badZone = await night.cli(
      'env', 'asks', 'create', WORLD_NAME, '--type', 'x', '--zone', 'nope', '--json',
    );
    expect(badZone.code).not.toBe(0);
    expect(badZone.stderr).toContain('nope');

    // The board lists it (human table + --json).
    const listed = await night.cli('env', 'asks', 'list', WORLD_NAME, '--json');
    expect(listed.code).toBe(0);
    expect((listed.json() as AskJson[]).some(row => row.id === ask.id)).toBe(true);
    const human = await night.cli('env', 'asks', 'list', WORLD_NAME);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('switching');
    expect(human.stdout).toContain('atrium');

    // The facility (owner here) publishes a MATCHING derived service over
    // raw HTTP: device + agent → derivation sync → match.
    const headers = await authHeaders(owner, stamp);
    const device = (await (await fetch(`${server.baseUrl}/api/environments/${id}/devices`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Atrium Light', type: 'light', capabilities: ['lighting-control'], zoneId: 'atrium' }),
    })).json()) as { id: string };
    const agent = (await (await fetch(`${server.baseUrl}/api/environments/${id}/agents`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Atrium Agent', capabilities: [], boundDeviceIds: [device.id], managedZoneIds: ['atrium'] }),
    })).json()) as { id: string };

    // CLI mine slice shows the consumed ask; the open board is empty.
    const mine = await night.cli('env', 'asks', 'list', WORLD_NAME, '--status', 'mine', '--json');
    expect(mine.code).toBe(0);
    const mineRows = mine.json() as AskJson[];
    expect(mineRows.find(row => row.id === ask.id)!.status).toBe('matched');
    const open = await night.cli('env', 'asks', 'list', WORLD_NAME, '--json');
    expect((open.json() as AskJson[]).some(row => row.id === ask.id)).toBe(false);

    // Withdraw the MATCHED ask teaches 409 (single-match consumed).
    const afterMatch = await night.cli('env', 'asks', 'withdraw', WORLD_NAME, ask.id);
    expect(afterMatch.code).not.toBe(0);
    expect(afterMatch.stderr).toContain('ASK_NOT_OPEN');

    // A fresh open ask withdraws cleanly.
    const second = await night.cli('env', 'asks', 'create', WORLD_NAME, '--type', 'pv-status', '--json');
    expect(second.code).toBe(0);
    const withdrawn = await night.cli('env', 'asks', 'withdraw', WORLD_NAME, (second.json() as AskJson).id);
    expect(withdrawn.code).toBe(0);
    expect(withdrawn.stdout).toContain('withdrawn');

    // The agent id keeps the lint quiet if assertions move; assert it existed.
    expect(agent.id).toBeDefined();
  });
});
