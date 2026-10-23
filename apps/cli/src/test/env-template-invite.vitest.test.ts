/**
 * R1 Batch 1 (B1-5 + B1-6) — the two owner-journey gaps the R1 multi-user
 * round exposed:
 *
 * - B1-5: `eaf env create --from-template <id> --name <n>` — one command
 *   template import (the meta.name→env-name detail digested CLI-side);
 *   unknown template names the available ones.
 * - B1-6: `eaf env members invite` — pending email invites through the
 *   Fix-37 batch endpoint (unregistered email joins automatically at
 *   registration), and `members add` on an unregistered email now POINTS
 *   at the invite lane instead of dead-ending.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;

const stamp = Date.now().toString(36);
const PASSWORD = 'password-123';
const OWNER_EMAIL = `r1-owner-${stamp}@example.com`;
const LATE_EMAIL = `r1-late-colleague-${stamp}@example.com`;
const KNOWN_EMAIL = `r1-known-colleague-${stamp}@example.com`;
const INVITE_ENV = `r1-invite-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code,
  ).toBe(0);
  writeFileSync(
    join(owner.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${INVITE_ENV}
  visibility: private
  map:
    type: grid
    zones:
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
`,
  );
  const applied = await owner.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code, applied.stdout + applied.stderr).toBe(0);
  const listed = await owner.cli('env', 'list', '--json');
  expect(listed.code, listed.stdout + listed.stderr).toBe(0);
  expect(JSON.stringify(listed.json())).toContain(INVITE_ENV);
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf env create --from-template (B1-5)', () => {
  test('one command imports the starter-home template with the given name', async () => {
    const envName = `r1-template-${stamp}`;
    const human = await owner.cli(
      'env', 'create', '--from-template', 'starter-home', '--name', envName, '--visibility', 'private',
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`"${envName}"`);
    expect(human.stdout).toContain('from template starter-home');
    expect(human.stdout).toMatch(/zones, \d+ devices/);

    // The meta.name override really became the environment name, and the
    // template scale really landed (env get by NAME works).
    const got = await owner.cli('env', 'get', envName, '--json');
    expect(got.code).toBe(0);
    expect(got.json().name).toBe(envName);

    // The --json channel returns the same environment detail face.
    const created = await owner.cli(
      'env', 'create', '--from-template', 'starter-home', '--name', `r1-template-json-${stamp}`, '--json',
    );
    expect(created.code).toBe(0);
    expect(created.json().name).toBe(`r1-template-json-${stamp}`);
    expect(typeof created.json().id).toBe('string');
  }, 60_000);

  test('an unknown template 404s naming the templates that DO exist', async () => {
    const res = await owner.cli(
      'env', 'create', '--from-template', 'no-such-template', '--name', `r1-nope-${stamp}`,
    );
    expect(res.code).toBe(4);
    expect(res.stderr).toContain('no-such-template');
    expect(res.stderr).toContain('starter-home');
  }, 30_000);

  test('--desc/--map-type with --from-template is a usage error (not silently dropped)', async () => {
    const res = await owner.cli(
      'env', 'create', '--from-template', 'starter-home', '--name', `r1-x-${stamp}`, '--map-type', 'grid',
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--from-template');
  });

  test('the taicang-campus template imports end-to-end (u1 acceptance replay)', async () => {
    // u1's exact journey (R1 P-07): one command instead of download→edit
    // meta.name→curl. 93 zones / 115 devices / 16 agents must really land.
    const envName = `r1-taicang-${stamp}`;
    const human = await owner.cli(
      'env', 'create', '--from-template', 'taicang-campus', '--name', envName, '--visibility', 'private',
    );
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('from template taicang-campus');
    expect(human.stdout).toMatch(/93 zones, 115 devices, 16 agents/);
    const got = await owner.cli('env', 'get', envName, '--json');
    expect(got.code).toBe(0);
    expect(got.json().name).toBe(envName);
  }, 120_000);
});

describe('eaf env members invite (B1-6)', () => {
  test('unregistered email → pending invite → auto-join at registration', async () => {
    // A registered colleague is added immediately; an unregistered one is
    // HELD as pending — both in ONE command. (The colleague registers on
    // their OWN runner — registering through the owner's runner would
    // replace the owner's stored session token.)
    const known = makeCli(server.baseUrl);
    expect(
      (await known.cli('auth', 'register', '--email', KNOWN_EMAIL, '--password', PASSWORD, '--name', 'Known Colleague')).code,
    ).toBe(0);
    const invited = await owner.cli(
      'env', 'members', 'invite', INVITE_ENV, '--email', `${KNOWN_EMAIL},${LATE_EMAIL}`, '--role', 'builder',
    );
    expect(invited.code, `stdout: ${invited.stdout}\nstderr: ${invited.stderr}`).toBe(0);
    expect(invited.stdout).toContain(`${KNOWN_EMAIL}: added`);
    expect(invited.stdout).toContain(`${LATE_EMAIL}: invited`);

    const json = await owner.cli(
      'env', 'members', 'invite', INVITE_ENV, '--email', `second-late-${stamp}@example.com`, '--json',
    );
    expect(json.code).toBe(0);
    expect(json.json().summary.invited).toBe(1);

    // The pending invitee registers LATER — and lands in the env as a
    // builder with no manual step (R15-D10 acceptance, now via CLI).
    const late = makeCli(server.baseUrl);
    expect(
      (await late.cli('auth', 'register', '--email', LATE_EMAIL, '--password', PASSWORD, '--name', 'Late Colleague')).code,
    ).toBe(0);
    const envs = await late.cli('env', 'list', '--json');
    expect(envs.code).toBe(0);
    const mine = envs.json().environments ?? envs.json();
    const list = Array.isArray(mine) ? mine : mine.environments;
    expect(list.some((env: { id?: string; name?: string }) => env.name === INVITE_ENV || env.id !== undefined)).toBe(true);

    // ...and their role really is builder.
    const members = await owner.cli('env', 'members', INVITE_ENV, '--json');
    const rows = members.json().members ?? members.json();
    const memberList = Array.isArray(rows) ? rows : rows.members;
    const lateRow = memberList.find((m: { email?: string }) => m.email === LATE_EMAIL);
    expect(lateRow?.role).toBe('builder');
  }, 60_000);

  test('members add on an unregistered email teaches the invite lane', async () => {
    const res = await owner.cli(
      'env', 'members', 'add', INVITE_ENV, '--email', `never-registered-${stamp}@example.com`, '--role', 'viewer',
    );
    expect(res.code).toBe(4);
    expect(res.stderr).toContain('USER_NOT_FOUND');
    expect(res.stderr).toContain('members invite');
  }, 30_000);
});

describe('T14/T15 (R2): pending invites visible; registration auto-join rings both sides', () => {
  const PENDING_EMAIL = `r2-t15-joiner-${stamp}@example.com`;

  test('T14: owner sees pending invites in `env members`; a builder does not', async () => {
    const invited = await owner.cli(
      'env', 'members', 'invite', INVITE_ENV, '--email', PENDING_EMAIL, '--role', 'builder',
    );
    expect(invited.code, invited.stderr).toBe(0);

    // Owner: the pending section rides the roster (earlier tests in this
    // suite may have left their own pending rows — the exact count is not
    // pinned, the SECTION and the new row are).
    const asOwner = await owner.cli('env', 'members', INVITE_ENV);
    expect(asOwner.code).toBe(0);
    expect(asOwner.stdout).toContain('pending invites:');
    expect(asOwner.stdout).toContain(PENDING_EMAIL);
    expect(asOwner.stdout).toContain('join on registration');

    // Non-owner (a builder) never sees the section — the invites endpoint is
    // owner-scoped and the CLI skips it entirely. INVITE_ENV is PRIVATE, so
    // the builder enters via members add (not the public join).
    const builder = makeCli(server.baseUrl);
    const builderEmail = `r2-t14-builder-${stamp}@example.com`;
    expect(
      (await builder.cli('auth', 'register', '--email', builderEmail, '--password', PASSWORD, '--name', 'T14 Builder')).code,
    ).toBe(0);
    expect(
      (await owner.cli('env', 'members', 'add', INVITE_ENV, '--email', builderEmail, '--role', 'builder')).code,
      owner.stderr,
    ).toBe(0);
    const asBuilder = await builder.cli('env', 'members', INVITE_ENV);
    expect(asBuilder.code).toBe(0);
    expect(asBuilder.stdout).not.toContain('pending invites');
  }, 60_000);

  test('T15: registering the invited email notifies the JOINER and the OWNER, and audits the row', async () => {
    const joiner = makeCli(server.baseUrl);
    expect(
      (await joiner.cli('auth', 'register', '--email', PENDING_EMAIL, '--password', PASSWORD, '--name', 'T15 Joiner')).code,
    ).toBe(0);

    // The joiner's FIRST notifications list is non-empty and names the env
    // (u3-F4: it used to read 0 unread while the env had silently appeared).
    const inbox = await joiner.cli('notifications', 'list', '--json');
    expect(inbox.code).toBe(0);
    const rows = inbox.json().notifications ?? inbox.json();
    const added = (Array.isArray(rows) ? rows : []).find((n: { kind?: string }) => n.kind === 'member.added');
    expect(added).toBeDefined();
    expect(JSON.stringify(added)).toContain(INVITE_ENV);

    // The owner hears the mirror (member.joined names the email).
    const ownerInbox = await owner.cli('notifications', 'list', '--json');
    expect(ownerInbox.code).toBe(0);
    const ownerRows = ownerInbox.json().notifications ?? ownerInbox.json();
    const joined = (Array.isArray(ownerRows) ? ownerRows : []).find(
      (n: { kind?: string }) => n.kind === 'member.joined' && JSON.stringify(n).includes(PENDING_EMAIL),
    );
    expect(joined).toBeDefined();
  }, 60_000);
});
