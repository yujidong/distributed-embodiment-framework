/**
 * Fix-22 CLI tests — `eaf env training-export`（owner-only 的 NDJSON 导出；
 * 非 owner 403 经 CliError 退出码 1）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let member: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-fix22-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `fix22-owner-${stamp}@example.com`;
const MEMBER_EMAIL = `fix22-member-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  member = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code,
  ).toBe(0);
  expect(
    (await member.cli('auth', 'register', '--email', MEMBER_EMAIL, '--password', PASSWORD, '--name', 'Member')).code,
  ).toBe(0);
  expect((await owner.cli('env', 'create', '--name', WORLD_NAME, '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', MEMBER_EMAIL, '--role', 'builder')).code,
  ).toBe(0);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe('eaf env training-export (Fix-22)', () => {
  test('the owner exports NDJSON to stdout; the first line is the manifest', async () => {
    const res = await owner.cli('env', 'training-export', WORLD_NAME);
    expect(res.code).toBe(0);
    const lines = res.ndjson();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].kind).toBe('manifest');
    expect(lines[0].payload.environment.name).toBe(WORLD_NAME);
    expect(lines[0].payload).toHaveProperty('counts');
    expect(lines[0].payload).toHaveProperty('snapshot');
  });

  test('-o writes the stream to a file', async () => {
    const res = await owner.cli('env', 'training-export', WORLD_NAME, '-o', 'export.jsonl', '--json');
    expect(res.code).toBe(0);
    expect(res.json().file).toBe('export.jsonl');
    const written = readFileSync(join(owner.home, 'export.jsonl'), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    expect(written[0].kind).toBe('manifest');
  });

  test('a non-owner member is rejected (403 → exit 1)', async () => {
    const res = await member.cli('env', 'training-export', WORLD_NAME);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('FORBIDDEN');
  });

  test('--format sft is passed through (manifest carries the format view); invalid value → exit 2', async () => {
    const res = await owner.cli('env', 'training-export', WORLD_NAME, '--format', 'sft');
    expect(res.code).toBe(0);
    const lines = res.ndjson();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].kind).toBe('manifest');
    expect(lines[0].payload.format).toBe('sft');
    expect(lines[0].payload).toHaveProperty('fields');
    // 无 trajectory 数据：0 样本，但计数结构在。
    expect(lines[0].payload.counts).toMatchObject({ samples: 0, skippedNoContext: 0, filteredNonLlm: 0 });

    const bad = await owner.cli('env', 'training-export', WORLD_NAME, '--format', 'rlhf');
    expect(bad.code).toBe(2);
  });
});
