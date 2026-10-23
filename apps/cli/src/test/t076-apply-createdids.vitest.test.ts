/**
 * @vitest-environment node
 *
 * T-076 (DevLoop R22, CC-F07) — created-id echo through the governed path.
 *
 * The finding: a create that went through governance answered with the
 * PROPOSAL wrapper, and consumers recorded the wrapper's id where the
 * OBJECT's id belonged — later binds/flow nodes then addressed a proposal.
 * The Fix-10 createdIds echo (server) is consumed everywhere a create
 * answer lands:
 *
 * - UNIT: applyDocument's governed branch — a stub API client answering
 *   device/agent creates with proposal wrappers. Today `eaf apply` is
 *   owner-only (owners create directly), so the branch is exercised
 *   directly: an AUTO-APPLIED wrapper chains on createdIds (the summary and
 *   the in-run name→id map carry the REAL id); a PENDING wrapper is never
 *   recorded as an object (warning + loud bind error naming the proposal).
 * - E2E: the reachable governed surface — a zone-claim builder's
 *   `eaf device add` auto-applies and echoes createdIds (`proposal: true`
 *   in --json, the id GETs as the device); the decide response carries the
 *   same echo for script callers.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';
import { applyDocument, type GovernedCreate } from '../world/apply.js';
import type { Ctx, EnvDetail, EnvProposal } from '../ctx.js';

// ---------------------------------------------------------------------------
// UNIT — applyDocument's governed-create branch (stub client)
// ---------------------------------------------------------------------------

/** An EnvDetail with no devices/agents (the doc will add both). */
function emptyDetail(): EnvDetail {
  return {
    id: 'env-1',
    name: 'Governed Lab',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    visibility: 'private',
    owner: { id: 'u-owner', displayName: 'Owner' },
    zones: [{ id: 'zone-a' } as EnvDetail['zones'][number]],
    events: [],
    devices: [],
    agents: [],
    members: [],
    myRole: 'owner',
  };
}

/** Minimal Ctx stub: applyDocument touches authedClient/listEnvs/js only. */
function stubCtx(responses: {
  device?: EnvProposal | { id: string };
  agent?: EnvProposal | { id: string };
}): Ctx {
  const detail = emptyDetail();
  const client = {
    get: async (url: string) => {
      if (url.includes('/api/environments/env-1')) return detail;
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (url.endsWith('/devices')) return responses.device ?? { id: 'dev-direct' };
      if (url.endsWith('/agents')) return responses.agent ?? { id: 'ag-direct' };
      throw new Error(`unexpected POST ${url}`);
    },
  };
  return {
    authedClient: () => client as unknown as Ctx['authedClient'] extends () => infer R ? R : never,
    listEnvs: async () => [{ id: 'env-1', name: 'Governed Lab', myRole: 'owner' as const }],
    js: false,
  } as unknown as Ctx;
}

const GOVERNED_DOC = {
  version: '1.0' as const,
  environment: { name: 'Governed Lab' },
  devices: [{
    name: 'Claimed Floodlight',
    zone: 'zone-a',
    spec: { type: 'smart-light', capabilities: ['lighting-control'] },
  }],
  agents: [{
    name: 'Claim Steward',
    capabilities: ['lighting-control'],
    zones: ['zone-a'],
    bind: ['Claimed Floodlight'],
  }],
};

describe('T-076 unit: applyDocument chains on the createdIds echo', () => {
  test('an AUTO-APPLIED governed create records the REAL object id (binds chain on it)', async () => {
    const ctx = stubCtx({
      device: {
        id: 'prop-dev-1', kind: 'install-devices', status: 'applied',
        createdIds: { devices: ['dev-9'] },
      } as EnvProposal,
      agent: {
        id: 'prop-ag-1', kind: 'install-agents', status: 'applied',
        createdIds: { agents: ['ag-1'] },
      } as EnvProposal,
    });
    const summary = await applyDocument(ctx, GOVERNED_DOC as never, { prune: false });

    expect(summary.errors).toEqual([]);
    // The recorded device id is the OBJECT's (createdIds echo), with the
    // governance wrapper kept for transparency.
    const deviceEntry = summary.devices.created.find(e => e.proposal !== undefined) as GovernedCreate;
    expect(deviceEntry).toBeDefined();
    expect(deviceEntry.id).toBe('dev-9');
    expect(deviceEntry.proposal).toEqual({ id: 'prop-dev-1', status: 'applied' });
    // The agent bind resolved the device BY NAME to the real id (the POST
    // body carried dev-9 — pinned by the stub receiving it below would need
    // a spy; the summary is the contract here).
    const agentEntry = summary.agents.created.find(e => e.proposal !== undefined) as GovernedCreate;
    expect(agentEntry).toBeDefined();
    expect(agentEntry.id).toBe('ag-1');
    expect(agentEntry.proposal).toEqual({ id: 'prop-ag-1', status: 'applied' });
  });

  test('a PENDING proposal never masquerades as an object; binds to it fail naming the proposal', async () => {
    const ctx = stubCtx({
      device: { id: 'prop-pending', kind: 'install-devices', status: 'escalated' } as EnvProposal,
    });
    const summary = await applyDocument(ctx, GOVERNED_DOC as never, { prune: false });

    // Nothing recorded as created — the old bug recorded the PROPOSAL id.
    expect(summary.devices.created).toEqual([]);
    expect(summary.agents.created).toEqual([]);

    const warning = summary.warnings.find(text => text.includes('Claimed Floodlight'));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/install-devices proposal prop-pending/);
    expect(warning).toMatch(/does not exist until the proposal is applied/);

    const bindError = summary.errors.find(text => text.includes('cannot resolve bind "Claimed Floodlight"'));
    expect(bindError).toBeDefined();
    expect(bindError).toMatch(/install-devices proposal prop-pending is still escalated/);
  });
});

// ---------------------------------------------------------------------------
// E2E — the reachable governed surface (zone-claim autonomy + decide echo)
// ---------------------------------------------------------------------------

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-t076-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `t076-owner-${stamp}@example.com`;
const BUILDER_EMAIL = `t076-builder-${stamp}@example.com`;

let ownerToken: string;
let builderToken: string;
let envId: string;

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.baseUrl}${path}`, init);
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json };
}
const authed = (token: string, body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  builder = makeCli(server.baseUrl);
  expect((await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code).toBe(0);
  expect((await builder.cli('auth', 'register', '--email', BUILDER_EMAIL, '--password', PASSWORD, '--name', 'Builder')).code).toBe(0);

  writeFileSync(
    join(owner.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: public
  map:
    type: grid
    zones:
      - id: zone-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
      - id: zone-b
        bounds: {minX: 5, maxX: 10, minY: 0, maxY: 5}
`,
  );
  const applied = await owner.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
  envId = applied.json().envId as string;
  expect((await builder.cli('env', 'join', WORLD_NAME)).code).toBe(0);

  const login = async (email: string): Promise<string> =>
    (await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })).json.token;
  ownerToken = await login(OWNER_EMAIL);
  builderToken = await login(BUILDER_EMAIL);

  // The builder claims zone-a (owner approves) — §5.3 zone-claim autonomy
  // then AUTO-APPLIES the builder's low-risk installs in that zone: the
  // path whose answer must echo createdIds.
  const claim = await api(`/api/environments/${envId}/proposals`, authed(builderToken, {
    kind: 'zone-claim', payload: { zoneId: 'zone-a' },
  }));
  expect(claim.status).toBe(201);
  const decided = await api(`/api/proposals/${claim.json.id}/decide`, authed(ownerToken, { decision: 'approved' }));
  expect(decided.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('T-076 e2e: governed creates echo the REAL object id', () => {
  test('device add in a claimed zone auto-applies; --json carries proposal: true + createdIds', async () => {
    const added = await builder.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'zone-a',
      '--type', 'smart-light', '--capabilities', 'lighting-control',
      '--name', 'Claimed Floodlight', '--json',
    );
    expect(added.code).toBe(0);
    const proposal = added.json();
    // T-048 honesty + the Fix-10 echo.
    expect(proposal.proposal).toBe(true);
    expect(proposal.status).toBe('applied');
    const deviceId = proposal.createdIds?.devices?.[0];
    expect(deviceId).toBeTruthy();
    // The echoed id IS the device (the proposal id would 404).
    const deviceRes = await api(`/api/devices/${deviceId}`, authed(ownerToken, undefined, 'GET'));
    expect(deviceRes.status).toBe(200);
    expect(deviceRes.json.name).toBe('Claimed Floodlight');
  }, 120_000);

  test('the decide response carries createdIds (the script-caller chain without a second lookup)', async () => {
    // An UNCLAIMED zone: the builder's install escalates to the owner.
    const added = await builder.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'zone-b',
      '--type', 'speaker', '--capabilities', 'turn-on',
      '--name', 'Unclaimed Speaker',
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/escalated/);

    const pending = await api(`/api/environments/${envId}/proposals`, authed(ownerToken, undefined, 'GET'));
    const rows = pending.json.proposals.filter(
      (row: { kind: string; status: string }) => row.kind === 'install-devices' && row.status === 'escalated',
    );
    expect(rows.length).toBeGreaterThan(0);
    const decided = await api(`/api/proposals/${rows[rows.length - 1].id}/decide`, authed(ownerToken, { decision: 'approved' }));
    expect(decided.status).toBe(200);
    expect(decided.json.status).toBe('applied');
    const deviceId = decided.json.createdIds?.devices?.[0];
    expect(deviceId).toBeTruthy();
    const deviceRes = await api(`/api/devices/${deviceId}`, authed(ownerToken, undefined, 'GET'));
    expect(deviceRes.status).toBe(200);
    expect(deviceRes.json.name).toBe('Unclaimed Speaker');
  }, 120_000);
});
