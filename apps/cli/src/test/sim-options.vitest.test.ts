/**
 * T-051 — `eaf sim create --no-auto-actuate`: the sim-level actuation switch
 * must be expressible from the CLI (decision-only runs). The server REJECTS
 * unknown options fields (TASK-004), so a successful create with the flag is
 * itself the contract proof: the option name reached options verbatim.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-t051-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli(
      'auth', 'register', '--email', `t051-${stamp}@example.com`,
      '--password', 'password-123', '--name', 'Owner',
    )).code,
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
  - name: Lamp
    zone: room-a
    spec:
      type: light
      capabilities: [turn-on, turn-off]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('sim create --no-auto-actuate (T-051)', () => {
  test('with the flag: the server accepts the option and the output names it', async () => {
    const created = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--no-auto-actuate');
    expect(created.code).toBe(0);
    // The server 400s unknown options fields — success means the option
    // name/value the CLI sent is part of the accepted vocabulary.
    expect(created.stdout).toContain('auto-actuate=off');
  });

  test('without the flag: nothing is sent, output unchanged', async () => {
    const created = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--json');
    expect(created.code).toBe(0);
    expect(created.json().id).toBeTruthy();
    const human = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none');
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('auto-actuate');
  });
});

describe('sim create --scheduling (living-worlds P1: due-driven lazy sims)', () => {
  test('--scheduling lazy: accepted, echoed by the server, named in output', async () => {
    const created = await owner.cli(
      'sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--scheduling', 'lazy', '--json',
    );
    expect(created.code).toBe(0);
    expect(created.json().scheduling).toBe('lazy');
    const human = await owner.cli(
      'sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--scheduling', 'lazy',
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('scheduling=lazy (due-driven)');
  });

  test('--scheduling <invalid>: usage error before any request', async () => {
    const bad = await owner.cli(
      'sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--scheduling', 'deferred',
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--scheduling must be tick|lazy');
  });
});
