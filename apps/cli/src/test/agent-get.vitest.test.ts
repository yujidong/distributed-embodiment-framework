/**
 * R101 (trust-visibility ④) — `eaf agent get`: one agent's detail +
 * 履约档案 (reputation rows + services with trackRecord/usageSummary),
 * --json and human modes, and the cold-start marker for a record-less agent.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-r101-agentget-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `r101get-owner-${stamp}@example.com`;

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
agents:
  - name: Watcher
    capabilities: [temperature-monitoring]
    bind: [Sensor A]
    zones: [room-a]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf agent get (R101 trust-visibility)', () => {
  test('--json carries agent + reputation + services; cold start is explicit', async () => {
    const listed = (await owner.cli('agent', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    const agentId = listed[0]!.id;

    const got = await owner.cli('agent', 'get', agentId, '--env', WORLD_NAME, '--json');
    expect(got.code).toBe(0);
    const body = got.json();
    expect(body.agent.id).toBe(agentId);
    expect(body.agent.name).toBe('Watcher');
    expect(body.reputation.totalAttempts).toBe(0);
    expect(Array.isArray(body.reputation.capabilities)).toBe(true);
    expect(Array.isArray(body.services)).toBe(true);
    // The derived service exists and is marked cold-start (暂无履约记录).
    const derived = (body.services as Array<{ trackRecord?: string }>)[0];
    expect(derived?.trackRecord).toBe('none');

    const human = await owner.cli('agent', 'get', agentId, '--env', WORLD_NAME);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('履约档案');
    expect(human.stdout).toContain('暂无履约记录');
  });

  test('unknown agent id is an honest error', async () => {
    const res = await owner.cli('agent', 'get', 'no-such-agent', '--env', WORLD_NAME);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('not found');
  });
});
