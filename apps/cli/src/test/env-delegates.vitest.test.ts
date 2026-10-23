/**
 * `eaf env delegates` + `eaf env proposals` (T-072, D-1 decide half) — the
 * CLI surface of zone-claim decision delegation: grant/revoke/list, the
 * governance summary line, and the member's proposal list marking what the
 * CALLER may decide (decide=*).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let steward: CliRunner;
let delegate: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-delegates-${stamp}`;
let envId = '';

async function rawEnvId(): Promise<string> {
  const list = await owner.cli('env', 'list', '--all', '--json');
  expect(list.code).toBe(0);
  const found = (list.json().environments as Array<{ id: string; name: string }>)
    .find(env => env.name === WORLD_NAME);
  if (!found) throw new Error(`world ${WORLD_NAME} not found`);
  return found.id;
}

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  steward = makeCli(server.baseUrl);
  delegate = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', `own-${stamp}@example.com`, '--password', 'password-123', '--name', 'Delegate Owner')).code,
  ).toBe(0);
  expect(
    (await steward.cli('auth', 'register', '--email', `stw-${stamp}@example.com`, '--password', 'password-123', '--name', 'Night Steward')).code,
  ).toBe(0);

  // Register the delegate over raw HTTP so the test holds its user id.
  const registered = (await (await fetch(`${server.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `dlg-${stamp}@example.com`, password: 'password-123', displayName: 'Facility Manager' }),
  })).json()) as { id: string };
  const delegateId = registered.id;
  expect(
    (await delegate.cli('auth', 'login', '--email', `dlg-${stamp}@example.com`, '--password', 'password-123')).code,
  ).toBe(0);

  // A two-zone world + membership via the API surface the CLI exposes.
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `own-${stamp}@example.com`, password: 'password-123' }),
  });
  const token = ((await login.json()) as { token: string }).token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const created = (await (await fetch(`${server.baseUrl}/api/environments`, {
    method: 'POST', headers,
    body: JSON.stringify({
      name: WORLD_NAME,
      visibility: 'public',
      mapData: { zones: [{ id: 'ward-101' }, { id: 'ward-102' }] },
    }),
  })).json()) as { id: string };
  envId = created.id;

  for (const email of [`stw-${stamp}@example.com`, `dlg-${stamp}@example.com`]) {
    const res = await fetch(`${server.baseUrl}/api/environments/${envId}/members`, {
      method: 'POST', headers,
      body: JSON.stringify({ email, role: 'builder' }),
    });
    expect(res.status).toBe(201);
  }
  (globalThis as { __delegateId?: string }).__delegateId = delegateId;
});

afterAll(async () => {
  await server.stop();
});

describe('eaf env delegates + proposals (T-072)', () => {
  test('grant → proposals list marks decide=* for the delegate → decide → revoke', async () => {
    const delegateId = (globalThis as { __delegateId?: string }).__delegateId!;

    // No delegation yet: the delegate's list shows nothing decidable, and
    // `eaf env delegates` says deciding stays owner-only.
    const beforeGrant = await delegate.cli('env', 'proposals', envId, '--json');
    expect(beforeGrant.code).toBe(0);
    expect(
      (beforeGrant.json() as Array<{ youCanDecide: boolean }>).every(p => p.youCanDecide !== true),
    ).toBe(true);
    const empty = await delegate.cli('env', 'delegates', envId);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('owner-only');

    // The steward's claim (submitted over raw HTTP — the CLI surface for
    // submitting zone-claims is the proposal endpoint).
    const stewardLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `stw-${stamp}@example.com`, password: 'password-123' }),
    });
    const stewardToken = ((await stewardLogin.json()) as { token: string }).token;
    const claimRes = (await (await fetch(`${server.baseUrl}/api/environments/${envId}/proposals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stewardToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'zone-claim', payload: { zoneId: 'ward-101', rationale: 'night HVAC' } }),
    })).json()) as { id: string; status: string };
    expect(claimRes.status).toBe('escalated');

    // Owner grants (ward-101 only) via the CLI.
    const grant = await owner.cli(
      'env', 'delegates', 'grant', envId, '--user-id', delegateId, '--zones', 'ward-101',
    );
    expect(grant.code).toBe(0);
    expect(grant.stdout).toContain('Facility Manager');
    expect(grant.stdout).toContain('ward-101');

    // The list command shows the active delegation.
    const list = await owner.cli('env', 'delegates', envId);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Facility Manager');
    expect(list.stdout).toContain('zone-claims');

    // `eaf env get` summarizes it.
    const get = await owner.cli('env', 'get', envId);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain('delegated to: Facility Manager');

    // The delegate's proposal list now marks the in-scope claim decide=*.
    const afterGrant = await delegate.cli('env', 'proposals', envId, '--json');
    expect(afterGrant.code).toBe(0);
    const rows = afterGrant.json() as Array<{ id: string; youCanDecide: boolean }>;
    expect(rows.find(row => row.id === claimRes.id)?.youCanDecide).toBe(true);

    // The human table carries the mark.
    const table = await delegate.cli('env', 'proposals', envId);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('zone-claim');

    // The delegate decides (raw HTTP — the CLI's governance surface for
    // deciding is the endpoint the table names).
    const dlgLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `dlg-${stamp}@example.com`, password: 'password-123' }),
    });
    const dlgToken = ((await dlgLogin.json()) as { token: string }).token;
    const decided = (await (await fetch(`${server.baseUrl}/api/proposals/${claimRes.id}/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dlgToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    })).json()) as { status: string; aiReview: { source: string } };
    expect(decided.status).toBe('applied');
    expect(decided.aiReview.source).toBe('delegate');

    // Owner revokes via the CLI; the list is empty again.
    const revoke = await owner.cli('env', 'delegates', 'revoke', envId, delegateId);
    expect(revoke.code).toBe(0);
    const afterRevoke = await owner.cli('env', 'delegates', envId);
    expect(afterRevoke.stdout).toContain('owner-only');
  });

  test('grant validation errors teach', async () => {
    const delegateId = (globalThis as { __delegateId?: string }).__delegateId!;
    const both = await owner.cli('env', 'delegates', 'grant', envId, '--email', `dlg-${stamp}@example.com`, '--user-id', delegateId);
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('exactly one');

    const mixed = await owner.cli('env', 'delegates', 'grant', envId, '--user-id', delegateId, '--zones', 'ward-101', '--all-zones');
    expect(mixed.code).not.toBe(0);
    expect(mixed.stderr).toContain('mutually exclusive');

    // Unauthenticated/foreign caller cannot grant: a non-member runner
    // gets the teachable 403 through the CLI error surface.
    const foreign = makeCli(server.baseUrl);
    expect(
      (await foreign.cli('auth', 'register', '--email', `frn-${stamp}@example.com`, '--password', 'password-123', '--name', 'Foreign')).code,
    ).toBe(0);
    const denied = await foreign.cli('env', 'delegates', 'grant', envId, '--user-id', delegateId);
    expect(denied.code).not.toBe(0);
  });
});
