/* Scripted multi-user end-to-end check (P2c) against the real stack.
 *
 * Boots apps/server with a fresh temp SQLite DB on a scratch port, then:
 *
 *   1. register users A + B, log both in (cookie jars)
 *   2. A creates a public grid environment and adds a device
 *   3. B lists public environments, joins A's env (→ builder)
 *   4. B instantiates a catalog device into A's env
 *   5. A's world stream (WS) receives B's device-created message
 *   6. B creates a simulation from the environmentId (rule-only) and steps it
 *
 * Prints PASS/FAIL per step and exits non-zero on failure. Usage:
 *
 *   node scripts/multiuser-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..', '..', 'server');
const TSX = join(SERVER_DIR, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 8140;
const HTTP = `http://127.0.0.1:${PORT}/api`;
const WS_BASE = `ws://127.0.0.1:${PORT}/api`;

const failures = [];
function assert(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

// --- Tiny cookie-aware client (one jar per user) --------------------------
function jar() {
  return { cookie: '' };
}
async function req(j, method, path, body) {
  const res = await fetch(HTTP + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(j.cookie ? { cookie: j.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const pair = c.split(';')[0];
    if (pair.endsWith('=')) j.cookie = '';
    else j.cookie = pair;
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- Boot the server -------------------------------------------------------
const tempDir = mkdtempSync(join(tmpdir(), 'eaf-p2c-'));
console.log(`booting server on :${PORT} (DB ${join(tempDir, 'eaf.db')})…`);
const server = spawn(process.execPath, [TSX, 'src/index.ts'], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    EAF_DB_PATH: join(tempDir, 'eaf.db'),
    JWT_SECRET: 'p2c-e2e-secret',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => (serverLog += d));
server.stderr.on('data', d => (serverLog += d));

async function cleanup(code) {
  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

process.on('SIGINT', () => cleanup(1));

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HTTP}/catalog`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server did not come up; log tail:\n${serverLog.slice(-2000)}`);
}

try {
  await waitForServer();

  // 1. register + login A/B -------------------------------------------------
  const A = jar();
  const B = jar();
  const regA = await req(A, 'POST', '/auth/register', {
    email: 'a@example.com',
    password: 'password-a1',
    displayName: '小A',
  });
  assert(regA.status === 201, `register A → 201 (got ${regA.status})`);
  const regB = await req(B, 'POST', '/auth/register', {
    email: 'b@example.com',
    password: 'password-b1',
    displayName: '小B',
  });
  assert(regB.status === 201, `register B → 201 (got ${regB.status})`);
  const dup = await req(jar(), 'POST', '/auth/register', {
    email: 'a@example.com',
    password: 'password-xx',
    displayName: '克隆',
  });
  assert(dup.status === 409, `duplicate register → 409 (got ${dup.status})`);
  const loginA = await req(A, 'POST', '/auth/login', { email: 'a@example.com', password: 'password-a1' });
  assert(loginA.status === 200 && A.cookie.includes('eaf_token'), 'login A → 200 + cookie');
  const loginB = await req(B, 'POST', '/auth/login', { email: 'b@example.com', password: 'password-b1' });
  assert(loginB.status === 200 && B.cookie.includes('eaf_token'), 'login B → 200 + cookie');
  const badLogin = await req(jar(), 'POST', '/auth/login', { email: 'a@example.com', password: 'wrong-wrong' });
  assert(badLogin.status === 401, `bad login → 401 (got ${badLogin.status})`);
  const meA = await req(A, 'GET', '/auth/me');
  assert(meA.status === 200 && meA.json.displayName === '小A', 'GET /auth/me A → 小A');

  // 2. A creates env + device ----------------------------------------------
  const envRes = await req(A, 'POST', '/environments', {
    name: 'P2c 测试环境',
    description: 'e2e',
    mapType: 'grid',
    visibility: 'public',
    mapData: {
      zones: [
        { id: 'living', name: '客厅', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 } },
        { id: 'bed', name: '卧室', bounds: { minX: 6, maxX: 10, minY: 0, maxY: 4 } },
      ],
    },
  });
  assert(envRes.status === 201, `A creates env → 201 (got ${envRes.status}: ${JSON.stringify(envRes.json)?.slice(0, 200)})`);
  const envId = envRes.json.id;
  assert(envRes.json.myRole === 'owner', 'A is owner of the new env');

  const devA = await req(A, 'POST', `/environments/${envId}/devices`, {
    name: '客厅灯',
    type: 'lamp',
    capabilities: ['switch'],
    zoneId: 'living',
  });
  assert(devA.status === 201, `A adds device → 201 (got ${devA.status})`);

  // 3. B lists public envs + joins ------------------------------------------
  const listB = await req(B, 'GET', '/environments');
  const found = listB.json?.environments?.find(e => e.id === envId);
  assert(listB.status === 200 && !!found, 'B sees A\'s public env in the list');
  assert(found && found.myRole === null, 'B is not yet a member (myRole null)');
  const join = await req(B, 'POST', `/environments/${envId}/join`, {});
  assert(join.status === 200 && join.json.role === 'builder', 'B joins → builder');

  // 4+5. A opens the world stream; B instantiates a catalog device -----------
  const worldMessages = [];
  const ws = new WebSocket(`${WS_BASE}/environments/${envId}/stream`, {
    headers: { cookie: A.cookie },
  });
  ws.on('message', raw => {
    try {
      worldMessages.push(JSON.parse(String(raw)));
    } catch {}
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  assert(true, 'A connected to the world stream');

  const catalog = await req(B, 'GET', '/catalog');
  assert(catalog.status === 200 && Array.isArray(catalog.json) && catalog.json.length > 0,
    `catalog has ${catalog.json?.length ?? 0} models`);
  const model = catalog.json[0];
  const inst = await req(B, 'POST', `/environments/${envId}/devices:instantiate`, {
    modelId: model.id,
    zoneId: 'bed',
  });
  assert(inst.status === 201, `B instantiates catalog device → 201 (got ${inst.status}: ${JSON.stringify(inst.json)?.slice(0, 200)})`);
  assert(inst.json?.owner?.displayName === '小B', 'instantiated device is owned by 小B');

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !worldMessages.some(m => m.kind === 'world' && m.action === 'created' && m.objectType === 'device')) {
    await new Promise(r => setTimeout(r, 100));
  }
  const createdMsg = worldMessages.find(m => m.kind === 'world' && m.action === 'created' && m.objectType === 'device');
  assert(!!createdMsg, 'A\'s world stream received B\'s device-created message');
  if (createdMsg) {
    console.log(`  world message: ${JSON.stringify(createdMsg).slice(0, 240)}`);
  }

  // 6. B runs a rule-only simulation from the environmentId ------------------
  const sim = await req(B, 'POST', '/simulations', {
    environmentId: envId,
    options: { llmClient: 'none', tickMs: 50 },
  });
  assert(sim.status === 201, `B creates simulation from environmentId → 201 (got ${sim.status}: ${JSON.stringify(sim.json)?.slice(0, 200)})`);
  if (sim.status === 201) {
    const simId = sim.json.id;
    const started = await req(B, 'POST', `/simulations/${simId}/start`, { speed: 2 });
    assert(started.json?.state === 'running', 'sim starts (running)');
    const stepped = await req(B, 'POST', `/simulations/${simId}/step`, { n: 5 });
    assert(stepped.status === 200 && stepped.json.simTimeSec > 0, `sim steps (+${stepped.json?.simTimeSec}s sim time)`);
    const snap = await req(B, 'GET', `/simulations/${simId}/snapshot`);
    const names = (snap.json?.devices ?? []).map(d => d.name);
    assert(
      snap.status === 200 && names.includes('客厅灯') && names.length >= 2,
      `snapshot carries env devices (${names.join(', ')})`,
    );
    await req(B, 'POST', `/simulations/${simId}/stop`, {});
    console.log('  sim stopped');
  }

  ws.close();
} catch (error) {
  console.error('E2E error:', error);
  failures.push(String(error));
}

console.log(failures.length === 0 ? '\nMULTIUSER_CHECK_OK' : `\nMULTIUSER_CHECK_FAILED: ${failures.join('; ')}`);
await cleanup(failures.length === 0 ? 0 : 1);
