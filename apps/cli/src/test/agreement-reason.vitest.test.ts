/**
 * R102 (collab-reason-channel, wang-18) — CLI 原因通道 e2e：
 * decide reject --reason 写入 statusReason 并对消费方可见（human 与
 * --json 一致）；无理由的终态显示"（未记录原因）"而非裸 null；human
 * usage 表带 failureReason 列（平台级输出纪律：human 不少于 --json）。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let provider: CliRunner;
let consumer: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-r102-reason-${stamp}`;
const PASSWORD = 'password-123';

beforeAll(async () => {
  server = await bootServer();
  provider = makeCli(server.baseUrl);
  consumer = makeCli(server.baseUrl);
  expect(
    (await provider.cli('auth', 'register', '--email', `r102p-${stamp}@example.com`, '--password', PASSWORD, '--name', 'Provider')).code,
  ).toBe(0);
  expect(
    (await consumer.cli('auth', 'register', '--email', `r102c-${stamp}@example.com`, '--password', PASSWORD, '--name', 'Consumer')).code,
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
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: HVAC A
    zone: room-a
    spec:
      type: hvac
      capabilities: [turn-on, turn-off]
agents:
  - name: Climate Bot
    capabilities: [turn-on, turn-off]
    bind: [HVAC A]
    zones: [room-a]
`,
  );
  expect((await provider.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect((await consumer.cli('env', 'join', WORLD_NAME)).code).toBe(0);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

let serviceId: string;

describe('R102 reason channel (CLI)', () => {
  test('decide reject --reason lands in statusReason and the consumer sees it (human == --json)', async () => {
    const services = (await consumer.cli('service', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string; origin: string }>;
    serviceId = services.find(s => s.origin === 'derived')!.id;
    const proposed = await consumer.cli('agreement', 'propose', serviceId, '--json');
    expect(proposed.code).toBe(0);
    const id = proposed.json().id as string;

    const decided = await provider.cli('agreement', 'decide', id, 'reject', '--reason', '条款窗口太短，改报 300s 再试', '--json');
    expect(decided.code).toBe(0);
    expect(decided.json().status).toBe('rejected');
    expect(decided.json().statusReason).toBe('条款窗口太短，改报 300s 再试');

    // --json channel
    const got = await consumer.cli('agreement', 'get', id, '--json');
    expect(got.json().statusReason).toBe('条款窗口太短，改报 300s 再试');
    // human channel shows the SAME reason (输出纪律：human 不少于 --json)
    const human = await consumer.cli('agreement', 'get', id);
    expect(human.stdout).toContain('reason: 条款窗口太短，改报 300s 再试');
    expect(human.stdout).not.toContain('（未记录原因）');

    // A reason-less rejection shows 未记录原因, never a bare null.
    const plain = await consumer.cli('agreement', 'propose', serviceId, '--json');
    const plainId = plain.json().id as string;
    expect((await provider.cli('agreement', 'decide', plainId, 'reject')).code).toBe(0);
    const plainHuman = await consumer.cli('agreement', 'get', plainId);
    expect(plainHuman.stdout).toContain('（未记录原因）');
  });

  test('suspend/terminate --reason ride statusReason; human usage shows failureReason', async () => {
    const proposed = await consumer.cli('agreement', 'propose', serviceId, '--json');
    const id = proposed.json().id as string;
    expect((await provider.cli('agreement', 'decide', id, 'accept')).code).toBe(0);

    const suspended = await provider.cli('agreement', 'suspend', id, '--reason', '设备周检，暂停两天', '--json');
    expect(suspended.code).toBe(0);
    expect(suspended.json().statusReason).toBe('设备周检，暂停两天');
    const terminated = await provider.cli('agreement', 'terminate', id, '--reason', '周检发现设备需更换，终止重签', '--json');
    expect(terminated.code).toBe(0);
    expect(terminated.json().statusReason).toBe('周检发现设备需更换，终止重签');
    const human = await consumer.cli('agreement', 'get', id);
    expect(human.stdout).toContain('reason: 周检发现设备需更换，终止重签');

    // R103 (zhao-23, landed in 45f0d919): a consumer-side vocabulary probe is
    // gate-refused (422) and NOT metered any more — a consumer error is never
    // a failure row and never scored against the provider. The usage table
    // for this agreement is therefore honestly EMPTY ('(none)').
    // (The old expectation here awaited a metered failure row with its
    // failureReason — the CLI test had not synced with the R103 semantic;
    // the failureReason RENDER face itself is guarded by the pure
    // usageTableRow fixtures in agreement-get.render + render-contract,
    // including the T40e （未记录） fallback.)
    const second = await consumer.cli('agreement', 'propose', serviceId, '--json');
    const secondId = second.json().id as string;
    expect((await provider.cli('agreement', 'decide', secondId, 'accept')).code).toBe(0);
    const sim = await consumer.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--json');
    expect(sim.code).toBe(0);
    const simId = sim.json().id as string;
    expect((await consumer.cli('sim', 'start', simId)).code).toBe(0);
    const refused = await consumer.cli('agreement', 'invoke', secondId, '--action', 'bogus-action', '--sim', simId);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('not executable');
    const usage = await consumer.cli('agreement', 'usage', secondId);
    expect(usage.code).toBe(0);
    expect(usage.stdout).toContain('(none)');
    await consumer.cli('sim', 'stop', simId);
  });
});
