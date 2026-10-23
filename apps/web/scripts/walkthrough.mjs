/* Scripted API walkthrough for apps/web verification (run against the live
 * server on :8100). Exercises the exact calls the UI makes. */
const BASE = 'http://localhost:8100/api';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const log = (step, data) => console.log(`\n=== ${step} ===\n` + JSON.stringify(data, null, 2).slice(0, 1200));

// 1. list scenarios
const list = await req('GET', '/scenarios');
log('GET /scenarios', list.json);

// 2. full scenario
const detail = await req('GET', '/scenarios/cross-brand-home');
log('GET /scenarios/cross-brand-home (devices[0], agents[0])', {
  version: detail.json.version,
  meta: detail.json.meta,
  device0: detail.json.devices[0],
  agent0: detail.json.agents[0],
  zone0: detail.json.zones[0],
});

// 3. create simulation
const created = await req('POST', '/simulations', {
  scenarioId: 'cross-brand-home',
  options: { llmClient: 'none' },
});
log('POST /simulations', created);
const simId = created.json.id;

// 4. initial snapshot
const snap0 = await req('GET', `/simulations/${simId}/snapshot`);
log('snapshot (created)', {
  state: snap0.json.state, simTimeSec: snap0.json.simTimeSec, tickCount: snap0.json.tickCount,
  zones: snap0.json.zones, device0: snap0.json.devices[0], agent0: snap0.json.agents[0],
  scheduledEvents: snap0.json.scheduledEvents,
});

// 5. start with speed 5
log('POST start {speed:5}', await req('POST', `/simulations/${simId}/start`, { speed: 5 }));

// 6. let it run ~1s (tick=10ms → ~100 ticks), snapshot: expect simTime advanced + event fired
await new Promise(r => setTimeout(r, 1000));
const snap1 = await req('GET', `/simulations/${simId}/snapshot`);
log('snapshot after ~1s running @5x', {
  state: snap1.json.state, simTimeSec: snap1.json.simTimeSec, tickCount: snap1.json.tickCount,
  zoneParams: snap1.json.zones[0].parameters,
  recentDecisions: snap1.json.recentDecisions,
  scheduledEvents: snap1.json.scheduledEvents,
});

// 7. pause + step +10
log('POST pause', await req('POST', `/simulations/${simId}/pause`, {}));
log('POST step {n:10}', await req('POST', `/simulations/${simId}/step`, { n: 10 }));
const snap2 = await req('GET', `/simulations/${simId}/snapshot`);
log('snapshot after step +10', {
  state: snap2.json.state, simTimeSec: snap2.json.simTimeSec, tickCount: snap2.json.tickCount,
  hvacState: snap2.json.devices.find(d => d.id === 'gree-hvac')?.state,
});

// 8. illegal transition: start after stop → expect 409
log('POST stop', await req('POST', `/simulations/${simId}/stop`, {}));
log('POST start after stop (expect 409)', await req('POST', `/simulations/${simId}/start`, {}));

// 9. final snapshot stays available after stop
const snap3 = await req('GET', `/simulations/${simId}/snapshot`);
log('final snapshot', { state: snap3.json.state, simTimeSec: snap3.json.simTimeSec, tickCount: snap3.json.tickCount });

console.log('\nWALKTHROUGH_DONE');
