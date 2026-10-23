/**
 * E2E check for the geo map tier + Suzhou smart-city template (P2d).
 *
 * Boots the API server on a throwaway SQLite database (no Ollama — the
 * simulation runs rule-only), then walks the exact API the web console uses:
 *
 * 1. register + login, find the seeded 苏州智慧城市 environment;
 * 2. GET the environment detail — geo map shape + world counts;
 * 3. create a simulation from the environment (rule-only) and step it past
 *    the first scheduled events;
 * 4. snapshot: zones carry live parameters, events fired on schedule.
 *
 * Usage: node apps/web/scripts/geo-city-check.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}/api`;
const CITY_NAME = '苏州智慧城市（金鸡湖-姑苏示范）';

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function req(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (e.g. 204) */
  }
  return { status: res.status, json };
}

// --- boot the server on a throwaway database --------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'eaf-geo-e2e-'));
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(REPO_ROOT, 'apps/server/src/index.ts')],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      EAF_DB_PATH: join(workDir, 'e2e.db'),
      SCENARIO_USER_DIR: join(workDir, 'scenarios'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
server.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

const shutdown = async code => {
  server.kill();
  await new Promise(resolve => server.once('exit', resolve));
  // Windows: the SQLite file stays locked briefly after the child exits.
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  process.exit(code);
};
process.on('SIGINT', () => void shutdown(2));

// Wait for readiness (the seed runs on boot).
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    const res = await fetch(`${BASE}/scenarios`);
    ready = res.ok;
  } catch {
    await new Promise(r => setTimeout(r, 300));
  }
}
if (!ready) {
  console.error('server did not become ready in time');
  await shutdown(1);
}

try {
  // 1. auth + find the seeded city environment ------------------------------
  const email = `geo-e2e-${Date.now()}@example.com`;
  const password = 'password-123';
  const registered = await req('POST', '/auth/register', {
    body: { email, password, displayName: 'Geo E2E' },
  });
  check('register user', registered.status === 201);
  const login = await req('POST', '/auth/login', { body: { email, password } });
  check('login', login.status === 200);
  const token = login.json.token;

  const list = await req('GET', '/environments', { token });
  const city = list.json.environments.find(env => env.name === CITY_NAME);
  check('city environment seeded + listed', city !== undefined);
  check('city env is public + geo', city?.visibility === 'public' && city?.mapType === 'geo');

  // 2. environment detail ----------------------------------------------------
  const detailRes = await req('GET', `/environments/${city.id}`, { token });
  check('detail fetch', detailRes.status === 200);
  const detail = detailRes.json;
  check('detail: 9 zones with polygons', detail.zones.length === 9 &&
    detail.zones.every(z => Array.isArray(z.polygon) && z.polygon.length >= 3));
  check('detail: map center/zoom', detail.mapCenter?.lat > 31 && detail.mapCenter?.lng > 120 &&
    typeof detail.mapZoom === 'number');
  check('detail: 33 devices with {lat,lng} positions', detail.devices.length === 33 &&
    detail.devices.every(d => typeof d.position?.lat === 'number' && typeof d.position?.lng === 'number'));
  check('detail: 12 stakeholder agents', detail.agents.length === 12);
  check('detail: 7 scheduled events baked in', detail.events.length === 7);

  // 3. create + step a rule-only simulation ----------------------------------
  const simRes = await req('POST', '/simulations', {
    body: { environmentId: city.id, options: { llmClient: 'none' } },
    token,
  });
  check('simulation created (rule-only)', simRes.status === 201 && simRes.json?.llm === 'rule-only',
    simRes.status !== 201 ? JSON.stringify(simRes.json) : '');
  const sim = simRes.json;

  const stepped = await req('POST', `/simulations/${sim.id}/step`, { body: { n: 65 }, token });
  check('stepped 65 sim-seconds', stepped.status === 200 && stepped.json.simTimeSec >= 65);

  // 4. snapshot ---------------------------------------------------------------
  const snapshot = (await req('GET', `/simulations/${sim.id}/snapshot`, { token })).json;
  check('snapshot: 9 zones with live parameters', snapshot.zones.length === 9 &&
    snapshot.zones.every(z => typeof z.parameters === 'object'));
  const snd = snapshot.zones.find(z => z.id === 'snd-industrial');
  check('snapshot: PM2.5 event landed (snd-industrial pm2_5 > 52 baseline)',
    typeof snd?.parameters?.pm2_5 === 'number' && snd.parameters.pm2_5 > 52,
    `pm2_5=${snd?.parameters?.pm2_5}`);
  const fired = snapshot.scheduledEvents.filter(e => e.fired).map(e => e.id);
  check('snapshot: rush-hour + pm25 events fired on schedule',
    fired.includes('evt-rush-hour') && fired.includes('evt-pm25-exceed'),
    fired.join(','));
  check('snapshot: 33 devices + 12 agents', snapshot.devices.length === 33 && snapshot.agents.length === 12);

  console.log('\n=== geo-city E2E summary ===');
  console.log(`environment: ${detail.name} (${city.id})`);
  console.log(`zones=${detail.zones.length} devices=${detail.devices.length} agents=${detail.agents.length} events=${detail.events.length}`);
  console.log(`sim ${sim.id} @ ${stepped.json.simTimeSec}s — fired: ${fired.join(', ') || '(none)'}`);
} catch (error) {
  // Any unexpected failure must fail the run, not skip to the summary.
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  check(
    'unexpected error',
    false,
    `${error instanceof Error ? error.message : String(error)}${cause}`,
  );
} finally {
  const failed = checks.filter(c => !c.ok).length;
  console.log(failed === 0 ? '\nGEO_CITY_E2E_OK' : `\nGEO_CITY_E2E_FAILED (${failed} checks)`);
  await shutdown(failed === 0 ? 0 : 1);
}
