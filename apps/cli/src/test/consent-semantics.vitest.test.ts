/**
 * `eaf service access …` + `eaf agreement counter/remind` (R14 Wave-B) — the
 * CLI surface of consent semantics, end to end against the real server: the
 * provider hides a vitals offer; the family requests + receives an access
 * grant; the provider counters the family's proposal with tighter terms; the
 * family accepts and the CLI's status filter reflects 'countered'.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let provider: CliRunner;
let family: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-consent-${stamp}`;

let providerToken: string;
let serviceId: string;
let requestId: string;
let agreementId: string;

beforeAll(async () => {
  server = await bootServer();
  provider = makeCli(server.baseUrl);
  family = makeCli(server.baseUrl);
  expect(
    (await provider.cli('auth', 'register', '--email', `prov-${stamp}@example.com`, '--password', 'password-123', '--name', 'ElderCare')).code,
  ).toBe(0);
  expect(
    (await family.cli('auth', 'register', '--email', `fam-${stamp}@example.com`, '--password', 'password-123', '--name', 'Family')).code,
  ).toBe(0);

  writeFileSync(
    join(provider.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: public
  map:
    type: grid
    zones:
      - id: ward-102
        consentClass: supervised
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
      - id: hall
        bounds: {minX: 5, maxX: 10, minY: 0, maxY: 5}
agents:
  - name: Care Bot
    capabilities: []
    zones: [ward-102]
`,
  );
  const applied = await provider.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
  const envId = applied.json().envId as string;
  expect((await family.cli('env', 'join', WORLD_NAME)).code).toBe(0);

  // No `service publish` on the CLI yet — publish + hide + register the
  // computation over raw HTTP with the provider's session.
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `prov-${stamp}@example.com`, password: 'password-123' }),
  });
  providerToken = ((await login.json()) as { token: string }).token;
  const detail = await (await fetch(`${server.baseUrl}/api/environments/${envId}`, {
    headers: { authorization: `Bearer ${providerToken}` },
  })).json() as { agents: Array<{ id: string; name: string }> };
  const careBot = detail.agents.find(agent => agent.name === 'Care Bot')!;
  const published = await fetch(
    `${server.baseUrl}/api/environments/${envId}/agents/${careBot.id}/services`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '跌倒检测手表（101-2床）', semanticType: 'fall-watch-101-2' }),
    },
  );
  serviceId = ((await published.json()) as { id: string }).id;
  const hidden = await fetch(`${server.baseUrl}/api/services/${serviceId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'hidden' }),
  });
  expect(hidden.status).toBe(200);
  const registered = await fetch(`${server.baseUrl}/api/services/${serviceId}/computation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'zone-query',
      refreshSec: 60,
      inputs: { zones: ['ward-102'], metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }] },
      interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
    }),
  });
  expect(registered.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('consent semantics over the CLI', () => {
  test('supervised zone is visible BEFORE proposing (env get + --full zone table)', async () => {
    const summary = await family.cli('env', 'get', WORLD_NAME);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain('supervised zones: ward-102');

    const full = await family.cli('env', 'get', WORLD_NAME, '--full', '--json');
    expect(full.code).toBe(0);
    const ward = (full.json().zones as Array<{ id: string; consentClass?: string }>)
      .find(zone => zone.id === 'ward-102');
    expect(ward?.consentClass).toBe('supervised');
    expect(full.json().governance.supervisedZones.map((z: { zoneId: string }) => z.zoneId)).toContain('ward-102');
  });

  test('hidden offer: request → grant → visible (the door)', async () => {
    // Hidden: the family's get is a 404 (exit 4 = NOT_FOUND, teaching error —
    // R102: the teaching names the cause + remedy instead of the bare code).
    const invisible = await family.cli('service', 'get', serviceId, '--json');
    expect(invisible.code).toBe(4);
    expect(invisible.stderr).toContain('not found');

    // T131 regression (consent door): the request below targets a HIDDEN
    // service the family cannot see — the CLI's T124 probe-GET used to turn
    // the invisible-service 404 into a CLI-side "not found" rewrite before
    // the server ever saw the request (3 reds: request/propose/revoke). The
    // fix passes CANONICAL FULL-LENGTH UUIDs straight through to the server
    // (resolveServiceRef), so the server stays the authority. The honest-404
    // half of that contract, pinned here: a BOGUS full UUID reaches the
    // server and answers the server's own SERVICE_NOT_FOUND (verbatim — not
    // the CLI roster teaching, which stays for SHORT refs, see json-error).
    const bogus = await family.cli(
      'service', 'access', 'request', '00000000-0000-4000-8000-000000000000',
      '--purpose', 'probe the passthrough 404', '--json',
    );
    expect(bogus.code).toBe(4);
    expect(bogus.stderr).toContain('SERVICE_NOT_FOUND');
    expect(bogus.stderr + bogus.stdout).not.toContain('none of the');

    const requested = await family.cli(
      'service', 'access', 'request', serviceId,
      '--purpose', '家属了解 101-2 床父亲跌倒情况', '--days', '90',
      '--json',
    );
    expect(requested.code).toBe(0);
    expect(requested.json().status).toBe('pending');
    requestId = requested.json().id as string;

    // The remind nudge is rate-limited from request creation.
    const early = await family.cli('service', 'access', 'remind', serviceId, requestId, '--json');
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('REMIND_RATE_LIMITED');

    const queue = await provider.cli('service', 'access', 'requests', serviceId, '--json');
    expect(queue.code).toBe(0);
    expect(queue.json().map((r: { id: string }) => r.id)).toContain(requestId);

    const granted = await provider.cli(
      'service', 'access', 'grant', serviceId,
      '--request', requestId,
      '--expires', new Date(Date.now() + 90 * 86400_000).toISOString(),
      '--basis', 'family of resident 101-2',
      '--data-subject', JSON.stringify({ ref: 'resident-101-2', consentBasis: 'care-contract §7' }),
      '--json',
    );
    expect(granted.code).toBe(0);
    expect(granted.json().dataSubject.ref).toBe('resident-101-2');

    const visible = await family.cli('service', 'get', serviceId, '--json');
    expect(visible.code).toBe(0);
    expect(visible.json().visibility).toBe('hidden');

    const ledger = await provider.cli('service', 'access', 'grants', serviceId);
    expect(ledger.code).toBe(0);
    expect(ledger.stdout).toContain('resident-101-2');
  });

  test('counter-offer: provider counters, consumer decides, status filter follows', async () => {
    const proposed = await family.cli(
      'agreement', 'propose', serviceId,
      '--terms', JSON.stringify({ read: { fields: ['avgTemperature'] }, notes: '了解情况' }),
      '--json',
    );
    expect(proposed.code).toBe(0);
    agreementId = proposed.json().id as string;
    expect(proposed.json().termsEnforced).toBe(true);

    // The consumer cannot counter (provider-only).
    const wrongSide = await family.cli(
      'agreement', 'counter', agreementId,
      '--terms', JSON.stringify({ notes: 'family revision' }),
      '--json',
    );
    expect(wrongSide.code).toBe(1);
    expect(wrongSide.stderr).toContain('provider');

    const countered = await provider.cli(
      'agreement', 'counter', agreementId,
      '--terms', JSON.stringify({
        read: { fields: ['avgTemperature'], quotaPerWindow: 3, windowSec: 86400 },
        notes: '每日最多 3 次读取',
      }),
      '--json',
    );
    expect(countered.code).toBe(0);
    expect(countered.json().status).toBe('countered');
    expect(countered.json().effectiveTerms.read.quotaPerWindow).toBe(3);

    // The list filter knows 'countered'.
    const listed = await family.cli(
      'agreement', 'list', '--env', WORLD_NAME, '--status', 'countered', '--json',
    );
    expect(listed.code).toBe(0);
    expect(listed.json().map((a: { id: string }) => a.id)).toContain(agreementId);

    // The counter notification tells the consumer it is their move (T-059
    // replyHint — rendered as the inline marker in human mode).
    const inbox = await family.cli('notifications', 'list', '--json');
    expect(inbox.code).toBe(0);
    const counteredNotif = inbox.json().notifications.find(
      (n: { kind: string; body?: { replyHint?: { yourMove?: boolean } } }) =>
        n.kind === 'agreement.countered' && n.body?.replyHint?.yourMove === true,
    );
    expect(counteredNotif).toBeDefined();
    const inboxHuman = await family.cli('notifications', 'list');
    expect(inboxHuman.code).toBe(0);
    expect(inboxHuman.stdout).toContain('your move');

    // Remind follows the decide right: the PROVIDER may nudge now.
    const providerNudge = await provider.cli('agreement', 'remind', agreementId, '--json');
    expect(providerNudge.code).toBe(1); // rate window anchored at proposal creation
    expect(providerNudge.stderr).toContain('REMIND_RATE_LIMITED');

    const accepted = await family.cli('agreement', 'decide', agreementId, 'accept', '--json');
    expect(accepted.code).toBe(0);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().terms.read.quotaPerWindow).toBe(3);
  });

  test('revoke closes the door again (reads 409 ACCESS_GRANT_REVOKED)', async () => {
    const familyId = (await family.cli('me', '--json')).json().user.id as string;
    const revoked = await provider.cli('service', 'access', 'revoke', serviceId, familyId, '--json');
    expect(revoked.code).toBe(0);
    const invisible = await family.cli('service', 'get', serviceId, '--json');
    expect(invisible.code).toBe(4);
    expect(invisible.stderr).toContain('not found');

    const read = await family.cli('agreement', 'read', agreementId, '--json');
    expect(read.code).toBe(1);
    expect(read.stderr).toContain('ACCESS_GRANT_REVOKED');
  });
});
