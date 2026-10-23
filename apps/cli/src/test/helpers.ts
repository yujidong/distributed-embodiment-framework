/**
 * E2E test harness — boots the real apps/server (tsx subprocess, temp
 * SQLite DB, random port) exactly like apps/web/scripts/multiuser-check.mjs,
 * and drives the CLI in-process through run() with captured streams and an
 * isolated EAF_HOME per suite.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// src/test → src → cli → apps → repo root
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface TestServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function bootServer(): Promise<TestServer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'eaf-cli-server-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(process.execPath, [TSX, 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      EAF_DB_PATH: join(tempDir, 'eaf.db'),
      SCENARIO_USER_DIR: join(tempDir, 'scenarios'),
      JWT_SECRET: 'eaf-cli-test-secret',
      // CLI e2e drives many auth calls in a burst — the server test harness
      // disables the limiter the same way.
      RATE_LIMIT_ENABLED: 'false',
      // Fix-45d: production auto-approves low-risk proposals when no reviewer
      // is available; the CLI notification suites test the ESCALATION path,
      // so boot with the same policy-off default the server harness uses.
      PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE: 'false',
      // R44-B: the boot-time backend auto-probe (and its opt-out knob) was
      // removed with the old local backend. The e2e server boots without
      // LLM_BASE_URL, so it stays deterministic rule-only regardless of the
      // host.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', chunk => (log += chunk));
  child.stderr?.on('data', chunk => (log += chunk));
  child.on('error', error => (log += `\nspawn error: ${error.message}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  // 60s covered a developer box; on the oversubscribed CI runner the real
  // server process (template registry, migrations, dist check) can still be
  // booting at the mark (2026-09-29 push CI: data-services suite died with
  // "server did not come up" while the log showed normal mid-boot progress).
  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/catalog`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!up) {
    child.kill('SIGTERM');
    throw new Error(`server did not come up on :${port}; log tail:\n${log.slice(-2000)}`);
  }

  return {
    baseUrl,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 700));
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Parse stdout as JSON (fails the test with a useful message otherwise). */
  json: () => any;
  /** Parse stdout as NDJSON lines. */
  ndjson: () => any[];
}

export interface CliRunner {
  home: string;
  cli: (...args: string[]) => Promise<CliResult>;
}

export interface CliRunnerOptions {
  /** Extra environment variables merged into the injected IO env (e.g. EAF_PROFILE). */
  env?: Record<string, string>;
  /** Reuse an existing EAF_HOME (e.g. a second runner on the same profiles). */
  home?: string;
}

/** CLI runner bound to a server URL and an isolated EAF_HOME. */
export function makeCli(baseUrl: string, options: CliRunnerOptions = {}): CliRunner {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'eaf-cli-home-'));
  return {
    home,
    cli: async (...args: string[]): Promise<CliResult> => {
      let stdout = '';
      let stderr = '';
      const code = await run(args, {
        env: { EAF_HOME: home, EAF_SERVER: baseUrl, ...options.env },
        cwd: home,
        homeDir: home,
        isTTY: false,
        stdout: chunk => (stdout += chunk),
        stderr: chunk => (stderr += chunk),
      });
      return {
        code,
        stdout,
        stderr,
        json: () => JSON.parse(stdout),
        ndjson: () =>
          stdout
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => JSON.parse(line)),
      };
    },
  };
}

export const TSX_CLI = TSX;
export const CLI_SRC_DIR = resolve(REPO_ROOT, 'apps', 'cli');
