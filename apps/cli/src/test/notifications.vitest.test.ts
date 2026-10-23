/**
 * Fix-16 CLI tests — `eaf me`（工作台 + 待办门铃）与 `eaf notifications`
 *（list / read / read-all）。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-fix16-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `fix16-owner-${stamp}@example.com`;
const BUILDER_EMAIL = `fix16-builder-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  builder = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code,
  ).toBe(0);
  expect(
    (await builder.cli('auth', 'register', '--email', BUILDER_EMAIL, '--password', PASSWORD, '--name', 'Builder')).code,
  ).toBe(0);
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
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', BUILDER_EMAIL, '--role', 'builder')).code,
  ).toBe(0);

  // The builder's device add auto-submits a proposal; the default reviewer
  // escalates it — one doorbell for the owner.
  const added = await builder.cli(
    'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
    '--type', 'smart-light', '--capabilities', 'lighting-control', '--name', 'Lamp',
  );
  expect(added.code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf notifications (Fix-16)', () => {
  test('list shows the escalation to the owner, not to the author', async () => {
    const res = await owner.cli('notifications', 'list', '--json');
    expect(res.code).toBe(0);
    const body = res.json();
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].kind).toBe('proposal.escalated');
    expect(body.notifications[0].readAt).toBeNull();

    const builderBox = await builder.cli('notifications', 'list', '--json');
    expect(builderBox.code).toBe(0);
    // The author gets no escalation copy — but they MAY have unrelated
    // notifications (e.g. member.added from being added to the env).
    expect(
      builderBox.json().notifications.filter((n: { kind: string }) => n.kind === 'proposal.escalated'),
    ).toHaveLength(0);
  });

  test('read marks one; read-all clears the rest', async () => {
    const listed = (await owner.cli('notifications', 'list', '--json')).json();
    const id = listed.notifications[0].id as string;

    const read = await owner.cli('notifications', 'read', id);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(id);

    const readAll = await owner.cli('notifications', 'read-all', '--json');
    expect(readAll.code).toBe(0);
    expect(readAll.json().marked).toBe(0); // the single row was already read

    const after = (await owner.cli('notifications', 'list', '--json')).json();
    expect(after.unreadCount).toBe(0);
  });

  test('unknown subcommand is a usage error (exit 2)', async () => {
    const res = await owner.cli('notifications', 'nope');
    expect(res.code).toBe(2);
  });

  // T-030: the backwards cursor — same contract as the activity feed.
  test('list --before pages to strictly older rows; garbage is a usage error', async () => {
    // The escalation exists; a future cursor keeps it, a past one empties
    // the page (strictly-older semantics, 200 — not an error).
    const future = await owner.cli(
      'notifications', 'list', '--json', '--before', '2999-01-01T00:00:00.000Z',
    );
    expect(future.code).toBe(0);
    expect(future.json().notifications).toHaveLength(1);

    const past = await owner.cli(
      'notifications', 'list', '--json', '--before', '2000-01-01T00:00:00.000Z',
    );
    expect(past.code).toBe(0);
    expect(past.json().notifications).toHaveLength(0);

    const garbage = await owner.cli('notifications', 'list', '--before', 'not-a-date');
    expect(garbage.code).toBe(2);
    expect(garbage.stderr).toContain('--before must be an ISO timestamp');
  });
});

describe('eaf me (Fix-16)', () => {
  test('--json carries the overview with todos', async () => {
    const res = await owner.cli('me', '--json');
    expect(res.code).toBe(0);
    const overview = res.json();
    expect(overview.user.email).toBe(OWNER_EMAIL);
    expect(overview.totals.environments).toBe(1);
    // The proposal is still escalated → the owner's approval todo.
    expect(overview.todos.pendingProposals).toBe(1);
    expect(overview.todos.pendingAgreements).toBe(0);
    expect(typeof overview.todos.unreadNotifications).toBe('number');
  });

  test('human mode prints the summary lines incl. 待办', async () => {
    const res = await owner.cli('me');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Owner');
    expect(res.stdout).toContain('Todo:');
    expect(res.stdout).toContain('1 pending proposal(s)');
  });
});

describe('eaf me webhook (Wave-4b)', () => {
  test('set → show → clear roundtrip', async () => {
    const unset = await owner.cli('me', 'webhook', 'show', '--json');
    expect(unset.code).toBe(0);
    expect(unset.json().url).toBeNull();

    const set = await owner.cli('me', 'webhook', 'set', 'http://127.0.0.1:9999/hook');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('http://127.0.0.1:9999/hook');

    const shown = await owner.cli('me', 'webhook', 'show');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('http://127.0.0.1:9999/hook');

    const cleared = await owner.cli('me', 'webhook', 'clear', '--json');
    expect(cleared.code).toBe(0);
    expect(cleared.json().url).toBeNull();
    expect((await owner.cli('me', 'webhook', 'show', '--json')).json().url).toBeNull();
  });

  test('set rejects non-http(s) urls (server 400 surfaces as exit 1)', async () => {
    const res = await owner.cli('me', 'webhook', 'set', 'ftp://example.com/hook');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('INVALID_WEBHOOK_URL');
  });

  test('unknown webhook action is a usage error (exit 2)', async () => {
    const res = await owner.cli('me', 'webhook', 'nope');
    expect(res.code).toBe(2);
  });
});
