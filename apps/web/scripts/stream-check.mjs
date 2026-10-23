/* Scripted end-to-end check of the WebSocket contract the web console
 * consumes (M3). Run against the live stack:
 *
 *   node scripts/stream-check.mjs                 # direct to the API server :8100
 *   node scripts/stream-check.mjs --port 5173     # through the Vite dev proxy
 *   node scripts/stream-check.mjs --skip-llm      # phase A only
 *
 * Phase A (rule-only, the console default): create with llmClient 'none' →
 * connect WS → start → inject temperature-spike → device command → assert:
 * immediate snapshot on connect, periodic snapshot messages, ≥1 event
 * message. NOTE: rule-only sims deliver injected events directly to agents
 * (not the bus) and never initiate ACs (engine: Layer 2 disabled), so bus
 * events come from device commands (device.operation_executed).
 *
 * Phase B (llm 'auto', requires OLLAMA_BASE_URL on the server): same flow,
 * then assert ≥1 collaboration-family event (the seed's sensor-only agent
 * initiates an AC via preCheck) — this is the event family the
 * collaboration graph consumes.
 *
 * Timing: the engine ticks every `tickMs` advancing `speed` sim-s per tick.
 * At the default 10ms/×5 the sim outruns wall clock 500:1 and AC formation
 * (async, wall-clock, LLM-latency-bound) never catches up, so this script
 * creates sims with tickMs=1000 and starts them at speed 1 (sim ≈ wall).
 *
 * Prints observed timings, event type histograms and sample payloads.
 * Exits non-zero on any failed assert.
 */
import WebSocket from 'ws';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 8100;
const SKIP_LLM = args.includes('--skip-llm');
const HTTP = `http://127.0.0.1:${PORT}/api`;
const WS_BASE = `ws://127.0.0.1:${PORT}/api`;

const PHASE_A_BUDGET_MS = 30_000;
const PHASE_B_BUDGET_MS = 240_000;
const failures = [];

async function req(method, path, body) {
  const res = await fetch(HTTP + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function assert(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

const COLLAB_PREFIXES = ['collaboration.', 'requirement.', 'service.'];
const isCollabFamily = e =>
  COLLAB_PREFIXES.some(p => e.type.startsWith(p)) ||
  (e.type === 'custom' && e.payload?.customType === 'AC_STATE_CHANGED');

function connectStream(simId, stats) {
  const ws = new WebSocket(`${WS_BASE}/simulations/${encodeURIComponent(simId)}/stream`);
  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.kind === 'snapshot') {
      stats.snapshotMsgs += 1;
      stats.simTimeSec = msg.data.simTimeSec;
      if (stats.firstSnapshotAtMs === null) {
        stats.firstSnapshotAtMs = Date.now() - stats.t0;
      }
      return;
    }
    if (msg.kind === 'event' && Array.isArray(msg.data)) {
      stats.eventMsgs += 1;
      if (stats.firstEventAtMs === null) stats.firstEventAtMs = Date.now() - stats.t0;
      for (const e of msg.data) {
        stats.events += 1;
        stats.types.set(e.type, (stats.types.get(e.type) ?? 0) + 1);
        if (isCollabFamily(e)) {
          if (stats.firstCollabAtMs === null) {
            stats.firstCollabAtMs = Date.now() - stats.t0;
            stats.firstCollabSimTimeSec = stats.simTimeSec;
          }
          stats.collabEvents.push(e);
        } else if (stats.samples.length < 2) {
          stats.samples.push({ type: e.type, payload: e.payload });
        }
      }
    }
  });
  ws.on('error', err => console.log(`  ws error: ${err.message}`));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('close', (code, reason) => {
      console.log(`  ws closed: code=${code} reason=${String(reason) || '(none)'}`);
    });
    ws.on('error', reject);
  });
}

function newStats() {
  return {
    t0: Date.now(),
    snapshotMsgs: 0,
    eventMsgs: 0,
    events: 0,
    types: new Map(),
    collabEvents: [],
    samples: [],
    firstSnapshotAtMs: null,
    firstEventAtMs: null,
    firstCollabAtMs: null,
    firstCollabSimTimeSec: null,
    simTimeSec: 0,
  };
}

function printStats(label, stats) {
  console.log(`\n--- ${label} observations ---`);
  console.log(`snapshot messages: ${stats.snapshotMsgs} (first at +${stats.firstSnapshotAtMs}ms)`);
  console.log(
    `event messages: ${stats.eventMsgs}, total events: ${stats.events} (first at +${stats.firstEventAtMs}ms)`,
  );
  console.log(`event type histogram: ${JSON.stringify(Object.fromEntries(stats.types))}`);
  console.log(
    `collaboration-family events: ${stats.collabEvents.length}` +
      (stats.firstCollabAtMs !== null
        ? ` (first at +${Math.round(stats.firstCollabAtMs / 1000)}s wall, sim t≈${stats.firstCollabSimTimeSec}s)`
        : ''),
  );
  for (const e of stats.collabEvents.slice(0, 3)) {
    console.log(`  collab sample: ${e.type} ${JSON.stringify(e.payload).slice(0, 280)}`);
  }
  for (const s of stats.samples) {
    console.log(`  event sample: ${s.type} ${JSON.stringify(s.payload).slice(0, 280)}`);
  }
}

// ---------------------------------------------------------------------------
// Phase A — rule-only contract
// ---------------------------------------------------------------------------
console.log('=== PHASE A: rule-only (llmClient: none) ===');
const createdA = await req('POST', '/simulations', {
  scenarioId: 'cross-brand-home',
  options: { llmClient: 'none', tickMs: 1000 },
});
assert(createdA.status === 201, `A: POST /simulations → 201 (got ${createdA.status})`);
const simA = createdA.json.id;
assert(createdA.json.llm === 'rule-only', `A: llm mode is rule-only (got ${createdA.json.llm})`);

const statsA = newStats();
const wsA = await connectStream(simA, statsA);
await new Promise(r => setTimeout(r, 300)); // immediate snapshot on connect

assert(
  (await req('POST', `/simulations/${simA}/start`, { speed: 1 })).json?.state === 'running',
  'A: POST start → running',
);
await new Promise(r => setTimeout(r, 2500));
const injectedA = await req('POST', `/simulations/${simA}/events`, {
  type: 'temperature-spike',
  zoneId: 'living-room',
  parameter: 'temperature',
  value: 34,
  severity: 'high',
});
assert(injectedA.status === 200, `A: POST /events → 200 (got ${injectedA.status})`);
console.log(`A: injected → targets ${JSON.stringify(injectedA.json.targetAgentIds)}`);
// Rule-only: bus events come from device commands (injected events are
// delivered straight to agents, never touching the bus).
const cmd = await req('POST', `/simulations/${simA}/commands`, {
  deviceId: 'gree-hvac',
  commandName: 'cooling',
  params: { targetTemperature: 23 },
});
assert(cmd.status === 200, `A: POST /commands → 200 (got ${cmd.status})`);

const deadlineA = Date.now() + PHASE_A_BUDGET_MS;
while (Date.now() < deadlineA && !(statsA.snapshotMsgs >= 2 && statsA.events >= 1)) {
  await new Promise(r => setTimeout(r, 250));
}
await req('POST', `/simulations/${simA}/stop`, {});
wsA.close();
printStats('phase A (rule-only)', statsA);
assert(statsA.snapshotMsgs >= 1 && statsA.firstSnapshotAtMs !== null && statsA.firstSnapshotAtMs < 2000,
  'A: immediate snapshot message on connect');
assert(statsA.events >= 1, 'A: ≥1 event message (device.operation_executed after command)');
console.log(`A: collaboration-family events: ${statsA.collabEvents.length} (expected 0 — engine disables Layer 2 rule-only)`);

// ---------------------------------------------------------------------------
// Phase B — LLM mode: collaboration events on the stream
// ---------------------------------------------------------------------------
if (!SKIP_LLM) {
  console.log('\n=== PHASE B: llm auto (requires Ollama on the server) ===');
  const createdB = await req('POST', '/simulations', {
    scenarioId: 'cross-brand-home',
    options: { llmClient: 'auto', tickMs: 1000 },
  });
  assert(createdB.status === 201, `B: POST /simulations → 201 (got ${createdB.status})`);
  const simB = createdB.json.id;
  console.log(`B: sim ${simB} llm=${createdB.json.llm}`);
  if (createdB.json.llm !== 'ollama') {
    console.log('B: server has no Ollama configured — skipping phase B asserts');
  } else {
    const statsB = newStats();
    const wsB = await connectStream(simB, statsB);
    assert(
      (await req('POST', `/simulations/${simB}/start`, { speed: 1 })).json?.state === 'running',
      'B: POST start → running',
    );
    await new Promise(r => setTimeout(r, 2500));
    const injectedB = await req('POST', `/simulations/${simB}/events`, {
      type: 'temperature-spike',
      zoneId: 'living-room',
      parameter: 'temperature',
      value: 34,
      severity: 'high',
    });
    assert(injectedB.status === 200, `B: POST /events → 200 (got ${injectedB.status})`);

    const deadlineB = Date.now() + PHASE_B_BUDGET_MS;
    while (Date.now() < deadlineB && statsB.collabEvents.length === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
    // Let the AC lifecycle progress a little further for richer samples.
    await new Promise(r => setTimeout(r, 8000));
    await req('POST', `/simulations/${simB}/stop`, {});
    wsB.close();
    printStats('phase B (llm auto)', statsB);
    assert(statsB.snapshotMsgs >= 1, 'B: snapshot messages on stream');
    assert(statsB.events >= 1, 'B: ≥1 event message');
    assert(
      statsB.collabEvents.length >= 1,
      `B: ≥1 collaboration-family event (sim t≈${statsB.firstCollabSimTimeSec}s at first, budget ~30 sim-s)`,
    );
  }
}

console.log(failures.length === 0 ? '\nSTREAM_CHECK_OK' : `\nSTREAM_CHECK_FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
