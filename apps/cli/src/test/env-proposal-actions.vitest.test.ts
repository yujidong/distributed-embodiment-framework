/**
 * `eaf env proposals decide|remind|revert` (R40-A1) — the CLI half of the
 * governance loop: the owner decides an escalated proposal (--approve/--reject,
 * --reason), the author nudges a stalled one (remind, 10-min rate window), and
 * the author/owner reverts an applied one. Human mode and --json both covered;
 * the list's footer now teaches the COMMAND instead of the raw endpoint.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-proposal-actions-${stamp}`;
let envId = '';
let builderToken = '';

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function submitProposal(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${server.baseUrl}/api/environments/${envId}/proposals`, {
    method: 'POST',
    headers: { authorization: `Bearer ${builderToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind, payload }),
  });
  return (await res.json()) as { id: string; status: string };
}

function acProposal(name: string, zoneId: string): Record<string, unknown> {
  return {
    devices: [{
      name,
      type: 'hvac',
      capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
      zoneId,
      initialState: { power: false },
    }],
  };
}

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  builder = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', `own-${stamp}@example.com`, '--password', 'password-123', '--name', 'Proposal Owner')).code,
  ).toBe(0);
  expect(
    (await builder.cli('auth', 'register', '--email', `bld-${stamp}@example.com`, '--password', 'password-123', '--name', 'Builder XiaoLi')).code,
  ).toBe(0);
  builderToken = await login(`bld-${stamp}@example.com`, 'password-123');
  const ownerToken = await login(`own-${stamp}@example.com`, 'password-123');
  const headers = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };

  const created = (await (await fetch(`${server.baseUrl}/api/environments`, {
    method: 'POST', headers,
    body: JSON.stringify({
      name: WORLD_NAME,
      visibility: 'public',
      mapData: { zones: [{ id: 'classroom-301' }, { id: 'classroom-302' }] },
    }),
  })).json()) as { id: string };
  envId = created.id;
  const added = await fetch(`${server.baseUrl}/api/environments/${envId}/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ email: `bld-${stamp}@example.com`, role: 'builder' }),
  });
  expect(added.status).toBe(201);
});

afterAll(async () => {
  await server.stop();
});

describe('eaf env proposals decide/remind/revert (R40-A1)', () => {
  test('decide --approve applies, revert undoes; --json carries the full proposal', async () => {
    const submitted = await submitProposal('install-devices', acProposal('301 空调', 'classroom-301'));
    expect(submitted.status).toBe('escalated');

    // The list footer teaches the COMMAND now, not the raw endpoint.
    const list = await owner.cli('env', 'proposals', envId);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('eaf env proposals decide');
    expect(list.stdout).not.toContain('POST /api/proposals');

    // Owner approves with a reason (human mode).
    const approved = await owner.cli(
      'env', 'proposals', 'decide', submitted.id, '--approve', '--reason', '301 确实缺空调',
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain(submitted.id);
    expect(approved.stdout).toContain('approved');
    expect(approved.stdout).toContain('applied');
    expect(approved.stdout).toContain('created:');

    // JSON mode: the raw proposal row.
    const second = await submitProposal('install-devices', acProposal('302 空调', 'classroom-302'));
    const approvedJson = await owner.cli('env', 'proposals', 'decide', second.id, '--approve', '--json');
    expect(approvedJson.code).toBe(0);
    const row = approvedJson.json() as { id: string; status: string; createdIds?: { devices?: string[] } };
    expect(row.id).toBe(second.id);
    expect(row.status).toBe('applied');
    expect(row.createdIds?.devices?.length).toBe(1);

    // Revert (owner, JSON): install-devices → the device is removed again.
    const reverted = await owner.cli('env', 'proposals', 'revert', second.id, '--json');
    expect(reverted.code).toBe(0);
    expect((reverted.json() as { status: string }).status).toBe('reverted');

    // Revert (author, human) for the first one.
    const revertedHuman = await builder.cli('env', 'proposals', 'revert', submitted.id);
    expect(revertedHuman.code).toBe(0);
    expect(revertedHuman.stdout).toContain('reverted');

    // Reverting again fails teachably (not applied anymore).
    const doubleRevert = await owner.cli('env', 'proposals', 'revert', submitted.id);
    expect(doubleRevert.code).not.toBe(0);
    expect(doubleRevert.stderr).toContain('PROPOSAL_NOT_APPLIED');
  });

  test('decide --reject; decide rights and flag validation teach', async () => {
    const rejected = await submitProposal('install-devices', acProposal('302 风扇', 'classroom-302'));
    const denied = await builder.cli('env', 'proposals', 'decide', rejected.id, '--approve');
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('owner');

    const outcome = await owner.cli('env', 'proposals', 'decide', rejected.id, '--reject', '--json');
    expect(outcome.code).toBe(0);
    expect((outcome.json() as { status: string }).status).toBe('rejected');

    // Deciding an already-decided proposal fails with the state teaching 409.
    const again = await owner.cli('env', 'proposals', 'decide', rejected.id, '--approve');
    expect(again.code).not.toBe(0);

    // Flag validation: neither/both decision flags are usage errors.
    expect((await owner.cli('env', 'proposals', 'decide', rejected.id)).code).not.toBe(0);
    const both = await owner.cli('env', 'proposals', 'decide', rejected.id, '--approve', '--reject');
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('exactly one');
  });

  test('remind: the 10-min window (anchored at creation) and the author-only gate teach', async () => {
    const stalled = await submitProposal('install-devices', acProposal('301 除湿机', 'classroom-301'));
    expect(stalled.status).toBe('escalated');

    // The AUTHOR's first nudge on a fresh proposal already sits inside the
    // rate window — the 429 names the anchor (CREATION) and the earliest
    // retry time (human mode; exit 1, teaching on stderr).
    const nudged = await builder.cli('env', 'proposals', 'remind', stalled.id);
    expect(nudged.code).not.toBe(0);
    expect(nudged.stderr).toContain('REMIND_RATE_LIMITED');
    expect(nudged.stderr).toContain('earliest you may remind');

    // Only the author may remind — the owner gets the teaching 403.
    const stranger = await owner.cli('env', 'proposals', 'remind', stalled.id);
    expect(stranger.code).not.toBe(0);
    expect(stranger.stderr).toContain('author');

    // Decided proposals refuse reminders with the state teaching 409.
    expect(
      (await owner.cli('env', 'proposals', 'decide', stalled.id, '--reject')).code,
    ).toBe(0);
    const decided = await builder.cli('env', 'proposals', 'remind', stalled.id, '--json');
    expect(decided.code).not.toBe(0);
    expect(decided.stderr).toContain('PROPOSAL_NOT_ESCALATED');
  });
});
