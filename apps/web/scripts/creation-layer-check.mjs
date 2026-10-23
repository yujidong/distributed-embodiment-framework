/* Scripted creation-layer check (W6-2) against the real stack.
 *
 * Boots apps/server with a fresh temp SQLite DB on a scratch port, then
 * exercises the exact API calls the W6-2 web flows make:
 *
 *   1. register + login the env owner
 *   2. create a BLANK grid environment (no mapData → no zones)
 *   3. PATCH mapData adding a grid zone (the 区域管理 save flow)
 *   4. PATCH mapData again appending a second zone (append preserves zone 1)
 *   5. POST an ad-hoc device into the zone (the 新建设备 form flow)
 *   6. POST a device into a bogus zone → 400 UNKNOWN_ZONE
 *   7. POST an agent bound to the device → derived services appear
 *   8. PATCH the device's capabilities → derived-service resync (W3)
 *   9. PATCH the device's zoneId (edit form zone change)
 *  10. cleanup: delete the environment
 *
 * Prints PASS/FAIL per step and exits non-zero on failure. Usage:
 *
 *   node scripts/creation-layer-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..', '..', 'server');
const TSX = join(SERVER_DIR, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 8141;
const HTTP = `http://127.0.0.1:${PORT}/api`;

const failures = [];
function assert(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

// --- Tiny cookie-aware client ----------------------------------------------
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

// --- Boot the server --------------------------------------------------------
const tempDir = mkdtempSync(join(tmpdir(), 'eaf-w62-'));
console.log(`booting server on :${PORT} (DB ${join(tempDir, 'eaf.db')})…`);
const server = spawn(process.execPath, [TSX, 'src/index.ts'], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    EAF_DB_PATH: join(tempDir, 'eaf.db'),
    JWT_SECRET: 'w62-smoke-secret',
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

  // 1. register + login the owner -------------------------------------------
  const A = jar();
  const reg = await req(A, 'POST', '/auth/register', {
    email: 'owner@example.com',
    password: 'password-w62',
    displayName: '所有者',
  });
  assert(reg.status === 201, `register owner → 201 (got ${reg.status})`);
  const login = await req(A, 'POST', '/auth/login', {
    email: 'owner@example.com',
    password: 'password-w62',
  });
  assert(login.status === 200 && A.cookie.includes('eaf_token'), 'login owner → 200 + cookie');

  // 2. blank grid environment (no mapData → no zones) ------------------------
  const envRes = await req(A, 'POST', '/environments', {
    name: 'W6-2 空白环境',
    description: 'creation-layer smoke',
    mapType: 'grid',
    visibility: 'private',
  });
  assert(
    envRes.status === 201 && Array.isArray(envRes.json?.zones) && envRes.json.zones.length === 0,
    `blank env created with 0 zones → 201 (got ${envRes.status})`,
  );
  const envId = envRes.json.id;

  // 3. PATCH mapData adding a grid zone (区域管理 save) ----------------------
  const zone1 = {
    id: 'yard',
    name: '院子',
    type: 'outdoor',
    bounds: { minX: 0, maxX: 8, minY: 0, maxY: 5 },
    baseline: { temperature: 26 },
  };
  const patch1 = await req(A, 'PATCH', `/environments/${envId}`, {
    mapData: { zones: [zone1] },
  });
  assert(
    patch1.status === 200 && patch1.json?.zones?.[0]?.id === 'yard',
    `PATCH mapData +zone → 200, zone present (got ${patch1.status}: ${JSON.stringify(patch1.json)?.slice(0, 200)})`,
  );
  assert(
    patch1.json?.zones?.[0]?.baseline?.temperature === 26,
    'zone baseline round-trips through map_data',
  );

  // 4. append a second zone — the first must survive --------------------------
  const zone2 = { id: 'garage', name: '车库', bounds: { minX: 8, maxX: 14, minY: 0, maxY: 5 } };
  const patch2 = await req(A, 'PATCH', `/environments/${envId}`, {
    mapData: { zones: [zone1, zone2] },
  });
  assert(
    patch2.status === 200 &&
      patch2.json?.zones?.length === 2 &&
      patch2.json.zones.some(z => z.id === 'yard') &&
      patch2.json.zones.some(z => z.id === 'garage'),
    'appending zone 2 preserves zone 1',
  );

  // 4b. duplicate zone ids are rejected ---------------------------------------
  const dupPatch = await req(A, 'PATCH', `/environments/${envId}`, {
    mapData: { zones: [zone1, zone1] },
  });
  assert(dupPatch.status === 400, `duplicate zone id → 400 (got ${dupPatch.status})`);

  // 5. ad-hoc device into the zone (新建设备 form) ----------------------------
  const dev = await req(A, 'POST', `/environments/${envId}/devices`, {
    name: '院子温湿度计',
    type: 'sensor-climate',
    brand: '杂牌',
    capabilities: ['temperature'],
    zoneId: 'yard',
    position: { x: 2, y: 2 },
    initialState: { battery: 97 },
  });
  assert(
    dev.status === 201 && dev.json?.zoneId === 'yard' && dev.json?.owner?.displayName === '所有者',
    `ad-hoc device created → 201 (got ${dev.status}: ${JSON.stringify(dev.json)?.slice(0, 200)})`,
  );
  const deviceId = dev.json?.id;

  // 6. device into a bogus zone → 400 UNKNOWN_ZONE ----------------------------
  const badDev = await req(A, 'POST', `/environments/${envId}/devices`, {
    name: '迷路设备',
    type: 'sensor',
    capabilities: ['x'],
    zoneId: 'nowhere',
  });
  assert(
    badDev.status === 400 && badDev.json?.error?.code === 'UNKNOWN_ZONE',
    `bogus zone → 400 UNKNOWN_ZONE (got ${badDev.status} ${badDev.json?.error?.code})`,
  );

  // 7. agent bound to the device → derived services appear --------------------
  const agent = await req(A, 'POST', `/environments/${envId}/agents`, {
    name: '院子管家',
    capabilities: ['climate'],
    boundDeviceIds: [deviceId],
    managedZoneIds: ['yard'],
  });
  assert(agent.status === 201, `agent bound to device → 201 (got ${agent.status})`);
  const detail1 = await req(A, 'GET', `/environments/${envId}`);
  const derived1 = (detail1.json?.services ?? []).filter(s => s.origin === 'derived');
  assert(
    derived1.some(s => s.semanticType === 'temperature' && s.sourceDeviceId === deviceId),
    `derived service for "temperature" exists (${derived1.map(s => s.semanticType).join(', ')})`,
  );

  // 8. PATCH device capabilities → derived-service resync (W3) ----------------
  const capPatch = await req(A, 'PATCH', `/devices/${deviceId}`, {
    capabilities: ['temperature', 'humidity'],
  });
  assert(capPatch.status === 200, `PATCH device capabilities → 200 (got ${capPatch.status})`);
  const detail2 = await req(A, 'GET', `/environments/${envId}`);
  const derivedTypes = (detail2.json?.services ?? [])
    .filter(s => s.origin === 'derived' && s.sourceDeviceId === deviceId)
    .map(s => s.semanticType)
    .sort();
  assert(
    derivedTypes.includes('humidity') && derivedTypes.includes('temperature'),
    `derived resync added "humidity" (now: ${derivedTypes.join(', ')})`,
  );

  // 9. edit form zone change ---------------------------------------------------
  const movePatch = await req(A, 'PATCH', `/devices/${deviceId}`, { zoneId: 'garage' });
  assert(
    movePatch.status === 200 && movePatch.json?.zoneId === 'garage',
    `PATCH device zoneId → garage (got ${movePatch.status})`,
  );

  // 10. cleanup: delete the environment ---------------------------------------
  const del = await req(A, 'DELETE', `/environments/${envId}`);
  assert(del.status === 204, `cleanup: delete env → 204 (got ${del.status})`);
} catch (error) {
  console.error('smoke error:', error);
  failures.push(String(error));
}

console.log(
  failures.length === 0
    ? '\nCREATION_LAYER_CHECK_OK'
    : `\nCREATION_LAYER_CHECK_FAILED: ${failures.join('; ')}`,
);
await cleanup(failures.length === 0 ? 0 : 1);
