/**
 * R1 B1-12 (u2 F4 / P-11) — the export vocabulary feeds `flow add`.
 *
 * `env export` writes flow pins as NAMES (deviceName / assigneeAgentName);
 * `flow add` used to post them verbatim and the server rejected the unknown
 * fields with an anonymous additionalProperties 422. The CLI now translates
 * names→ids (the same mapping `world apply` always used), names an
 * unresolvable reference in the error, and dedupes repeated validation
 * lines.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-flowx-${stamp}`;
const EMAIL = `flowx-${stamp}@example.com`;
const PASSWORD = 'password-123';

const ID_FLOW_YAML = `name: Lamp pin
description: pinned by id
trigger:
  kind: event
  eventType: flowx-event
plan:
  goal: blink the lamp
  nodes:
    - id: n1
      capability: turn-on
      deviceId: DEVICE_ID
      assigneeAgentId: AGENT_ID
`;

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
  expect(
    (await eaf.cli('auth', 'register', '--email', EMAIL, '--password', PASSWORD, '--name', 'FlowX User')).code,
  ).toBe(0);
  writeFileSync(
    join(eaf.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: public
  map:
    type: grid
    zones:
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: Lamp
    zone: room-a
    spec:
      type: light
      capabilities: [turn-on, turn-off]
agents:
  - name: Lamp Agent
    capabilities: [turn-on, turn-off]
    bind: [Lamp]
    zones: [room-a]
`,
  );
  expect((await eaf.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('flow add eats the export vocabulary (B1-12)', () => {
  test('export → flow add round-trip: a name-pinned export file adds cleanly', async () => {
    // 1. Create a flow pinned by ids (the hand-written style).
    const devices = await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json');
    const lamp = devices.json().find((d: { name: string }) => d.name === 'Lamp');
    const agents = await eaf.cli('agent', 'list', '--env', WORLD_NAME, '--json');
    const agent = agents.json().find((a: { name: string }) => a.name === 'Lamp Agent');
    writeFileSync(
      join(eaf.home, 'id-flow.yaml'),
      ID_FLOW_YAML.replace('DEVICE_ID', lamp.id).replace('AGENT_ID', agent.id),
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'id-flow.yaml', '--json');
    expect(added.code, added.stderr).toBe(0);

    // 2. Export the environment — the flow rides the document with NAMES.
    const exported = await eaf.cli('env', 'export', WORLD_NAME, '-o', 'exported.json');
    expect(exported.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(eaf.home, 'exported.json'), 'utf8'));
    const exportedFlow = (doc.flows as Array<Record<string, unknown>>).find(f => f.name === 'Lamp pin');
    expect(exportedFlow).toBeDefined();
    const plan = JSON.stringify(exportedFlow!.plan);
    expect(plan).toContain('deviceName');
    expect(plan).toContain('assigneeAgentName');
    expect(plan).not.toContain(lamp.id);

    // 3. `flow add` the EXPORTED flow (renamed) — the CLI translates the
    // names back to ids and the server accepts it (was: additionalProperties 422).
    const roundTrip = { ...(exportedFlow as Record<string, unknown>), name: 'Lamp pin roundtrip' };
    writeFileSync(join(eaf.home, 'roundtrip-flow.json'), JSON.stringify(roundTrip));
    const reAdded = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'roundtrip-flow.json', '--json');
    expect(reAdded.code, reAdded.stderr).toBe(0);
    expect(reAdded.json().name).toBe('Lamp pin roundtrip');
    // The stored plan carries the RESOLVED ids, not the export names.
    expect(JSON.stringify(reAdded.json().plan)).toContain(lamp.id);
  }, 60_000);

  test('an unresolvable name is a teaching error echoing the exact string', async () => {
    writeFileSync(
      join(eaf.home, 'wrong-name-flow.yaml'),
      `name: Wrong pin
trigger:
  kind: event
  eventType: flowx-event
plan:
  goal: miss
  nodes:
    - id: n1
      capability: turn-on
      deviceName: No Such Device
      assigneeAgentName: Ghost Agent
`,
    );
    const res = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'wrong-name-flow.yaml');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('No Such Device');
    expect(res.stderr).toContain('Ghost Agent');
    expect(res.stderr).toContain('device list');
  }, 30_000);

  test('id-style files still work unchanged (no name pin, no translation)', async () => {
    writeFileSync(
      join(eaf.home, 'plain-flow.yaml'),
      `name: Plain flow
trigger:
  kind: event
  eventType: flowx-event
plan:
  goal: plain
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const res = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'plain-flow.yaml', '--json');
    expect(res.code, res.stderr).toBe(0);
  }, 30_000);
});

describe('T7 (R2 u2-F1/F3): export slice round-trip teaching', () => {
  test('a SINGLE-element list slice is accepted (the u2 hand-deprefixing friction is gone)', async () => {
    // `env export`'s flows section copied verbatim = a one-element list.
    writeFileSync(
      join(eaf.home, 'slice-flow.json'),
      JSON.stringify([
        {
          name: 'Slice flow',
          trigger: { kind: 'event', eventType: 'flowx-event' },
          plan: {
            goal: 'slice',
            nodes: [{ id: 'n1', capability: 'turn-on' }],
          },
        },
      ]),
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'slice-flow.json', '--json');
    expect(added.code, added.stderr).toBe(0);
    expect(added.json().name).toBe('Slice flow');
  }, 30_000);

  test('a MULTI-element list errors with the object skeleton to slice toward', async () => {
    const flow = {
      name: 'One of two',
      trigger: { kind: 'event', eventType: 'flowx-event' },
      plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    };
    writeFileSync(join(eaf.home, 'two-flows.json'), JSON.stringify([flow, { ...flow, name: 'Two of two' }]));
    const res = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'two-flows.json');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('list of 2 flow definitions');
    expect(res.stderr).toContain('Slice out a single element');
    expect(res.stderr).toContain('trigger');
  }, 30_000);

  test('a cross-tenant assignment refusal teaches the world-document import lane (u2-F1)', async () => {
    // u2's shape: a builder authors a flow whose assignee is ANOTHER user's
    // agent — FLOW_INVALID (another tenant). The error must now point at the
    // two legitimate routes instead of reading like a broken platform.
    const stamp2 = `${stamp}b`;
    const other = makeCli(server.baseUrl);
    expect(
      (await other.cli('auth', 'register', '--email', `flowx-${stamp2}@example.com`, '--password', PASSWORD, '--name', 'Other Builder')).code,
    ).toBe(0);
    expect((await other.cli('env', 'join', WORLD_NAME)).code).toBe(0);
    writeFileSync(
      join(other.home, 'foreign-flow.yaml'),
      `name: Foreign assignee
trigger:
  kind: event
  eventType: flowx-event
plan:
  goal: blink the lamp
  nodes:
    - id: n1
      capability: turn-on
      assigneeAgentName: Lamp Agent
      deviceId: no-such-device-pin
`,
    );
    // assigneeAgentName 'Lamp Agent' translates to the OWNER's agent id (the
    // device pin is intentionally bogus so the refusal is authorship, not
    // the name translation).
    const res = await other.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'foreign-flow.yaml');
    // 422 FLOW_INVALID rides the generic HTTP error exit (EXIT.ERROR).
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('another tenant');
    expect(res.stderr).toContain('env export slice');
    expect(res.stderr).toContain('eaf apply');
    expect(res.stderr).toContain('agreement invoke');
  }, 60_000);

  test('env export notes the flows-snapshot semantics (yaml comment header)', async () => {
    const exported = await eaf.cli('env', 'export', WORLD_NAME, '-o', 'noted-export.yaml');
    expect(exported.code).toBe(0);
    const text = readFileSync(join(eaf.home, 'noted-export.yaml'), 'utf8');
    expect(text).toContain('flows section = reference snapshot');
    expect(text).toContain('eaf apply -f world.yaml');
    // The comment is a YAML comment — the document still parses identically.
    const doc = parseYaml(text);
    expect(doc.environment.name).toBe(WORLD_NAME);
  }, 30_000);
});
