/**
 * T3 / T11 (R2) — `sim status` + `sim snapshot --zones` human-mode rendering
 * regressions. Pure rendering fixtures — no server boot — so the file lives
 * in the CLI fast lane (same discipline as sim-eval.render.vitest.test.ts).
 *
 * T3 (R2, B1-11): the status face must carry the real-advancement fields
 * (tickMs / lastTickWallMs / autoThrottled / effectiveSpeedPerSec) in BOTH
 * modes — nominal speed alone let operators schedule drills against a rate
 * the world never achieved (u1: nominal ×300 measured ×34–×222).
 *
 * T11 (R2, u4-F3): the --zones human table labels units, shows the sampling
 * sim-time, and rounds to 2 decimals — while --json keeps full precision.
 */

import { describe, expect, test } from 'vitest';

import { renderStatusHumanLines } from '../commands/sim.js';

describe('renderStatusHumanLines (T3, R2 B1-11; T83, R8 speed calibers)', () => {
  test('a throttled running sim renders the full cadence face + the honest no-window dash (T83: instant figure left the human face)', () => {
    const lines = renderStatusHumanLines({
      state: 'running',
      simTimeSec: 3720,
      tickCount: 100,
      speed: 300,
      scenarioName: 'Campus',
      tickMs: 10,
      tickWallMs: 100,
      autoThrottled: true,
      effectiveSpeedPerSec: 247.9338842975207,
    });
    expect(lines[0]).toContain('state=running');
    expect(lines[0]).toContain('speed=300');
    // T61 (R6, u4-F12): the speed figure names its unit — nominal
    // simSecPerTick, never readable as a wall-clock multiplier.
    expect(lines[0]).toContain('nominal simSecPerTick — not a wall-clock multiplier');
    expect(lines[1]).toContain('tickMs=10ms');
    expect(lines[1]).toContain('lastTickWallMs=100ms');
    expect(lines[1]).toContain('autoThrottled=yes');
    // T83 (R8, u4-P2-4): the instant estimate no longer prints as a
    // schedulable figure — the human face shows an honest dash naming the
    // --json instant figure as non-reproducible.
    expect(lines[2]).toContain('effectiveSpeed: —');
    expect(lines[2]).toContain('non-reproducible');
    expect(lines[2]).toContain('window caliber');
    expect(lines[2]).toContain('nominal speed=300');
    for (const line of lines) {
      expect(line.includes('247.9'), 'the raw instant figure must not appear on the human face').toBe(false);
    }
  });

  test('absent values (paused / not yet ticked) render "—", never a fake 0', () => {
    const lines = renderStatusHumanLines({
      state: 'paused',
      simTimeSec: 0,
      tickCount: 0,
      speed: 60,
      scenarioName: 'Campus',
    });
    expect(lines[1]).toContain('tickMs=—ms');
    expect(lines[1]).toContain('lastTickWallMs=—ms');
    expect(lines[1]).toContain('autoThrottled=—');
    // T83: the dash line explains the missing rate instead of vanishing —
    // but never fabricates a number.
    expect(lines[2]).toContain('effectiveSpeed: —');
    // T111 (R18, u3-F-3): the honesty note closes the face (line 3 of 4).
    expect(lines).toHaveLength(4);
  });

  // T111 (R18, u3-F-3) rewritten by T123 (D1, option A): the honesty note
  // states the NEW semantics — the handshake window is a wall clock with a
  // real-time FLOOR at high world rates (rate ≥ gate → ≥ floor ms), below
  // the gate unchanged — and the eval funnel stays the attribution surface.
  // Bilingual, one line, on every status face.
  test('T123: the rate-gated real-time floor note rides the face (bilingual, attribution pointer)', () => {
    const lines = renderStatusHumanLines({
      state: 'running',
      simTimeSec: 3720,
      tickCount: 100,
      speed: 300,
      scenarioName: 'Campus',
      tickMs: 10,
      tickWallMs: 100,
      effectiveSpeedWindowPerSec: 28.4,
      effectiveSpeedWindowSec: 60,
    });
    const note = lines[lines.length - 1]!;
    expect(note).toContain('real-time floor');
    expect(note).toContain('EAF_AC_RESPONSE_MIN_WALL_MS');
    expect(note).toContain('EAF_AC_RESPONSE_FLOOR_MIN_RATE');
    expect(note).toContain('handshakes.failures.byCause');
    expect(note).toContain('伙伴握手窗有真实时间下限保底');
    expect(note).toContain('低于该倍率行为不变');
    // The distorted old wording must NOT come back (T123 honesty rule).
    expect(note).not.toContain('SIMULATED time');
    expect(note).not.toContain('按仿真时间计');
    // One line only — a footnote, not a paragraph.
    expect(lines.filter(l => l.includes('handshakes.failures.byCause'))).toHaveLength(1);
  });
});

import { formatWatchValue, humanZoneTable, renderEvalReportHuman, renderStatusHumanLines } from '../commands/sim.js';

// ============================================================================
// T32 (R3) → T83 (R8, u4-P2-4): the speed caliber face — window average only
// on the human panel (the instant figure was withdrawn: 4 samples in one
// session differed 4.4×, it is not a schedulable "有效倍速")
// ============================================================================

describe('renderStatusHumanLines speed caliber face (T32 → T83)', () => {
  test('window figure present: the window average is THE scheduling estimate; the instant figure is gone', () => {
    const lines = renderStatusHumanLines({
      state: 'running',
      simTimeSec: 3720,
      tickCount: 100,
      speed: 300,
      scenarioName: 'Campus',
      tickMs: 10,
      tickWallMs: 100,
      autoThrottled: true,
      effectiveSpeedPerSec: 397.4,
      effectiveSpeedWindowPerSec: 28.4,
      effectiveSpeedWindowSec: 60,
    });
    const speedLine = lines.find(l => l.startsWith('effectiveSpeed'));
    expect(speedLine).toBeDefined();
    expect(speedLine).toContain('28.4 sim-s/s (60s avg — schedule with this one');
    expect(speedLine).toContain('nominal speed=300');
    // T83: neither the instant VALUE nor the "(instant)" label may appear.
    expect(speedLine).not.toContain('(instant)');
    expect(speedLine).not.toContain('397.4');
  });

  test('window length unannotated (pre-annotation server) renders a "window avg" label, not a fake number', () => {
    const lines = renderStatusHumanLines({
      state: 'running',
      simTimeSec: 10,
      tickCount: 2,
      speed: 60,
      scenarioName: 'Campus',
      effectiveSpeedPerSec: 100.1,
      effectiveSpeedWindowPerSec: 31.2,
    });
    expect(lines.find(l => l.startsWith('effectiveSpeed'))).toContain('(window avg — schedule with this one');
  });

  test('no window figure (pre-T32 server): honest dash, never the misleading instant figure', () => {
    const lines = renderStatusHumanLines({
      state: 'running',
      simTimeSec: 3720,
      tickCount: 100,
      speed: 300,
      scenarioName: 'Campus',
      tickMs: 10,
      tickWallMs: 100,
      autoThrottled: true,
      effectiveSpeedPerSec: 247.9338842975207,
    });
    expect(lines[2]).toBe(
      'effectiveSpeed: — (no window average this tick; the instant figure on --json is a non-reproducible ' +
      'estimate — schedule only on the window caliber; nominal speed=300)',
    );
  });
});

// ============================================================================
// T38.2 (R3, u4-F6): watch zone diffs carry units and 1-2 decimals
// ============================================================================

describe('formatWatchValue (T38.2, R3 u4-F6)', () => {
  test('known parameters get their unit, numbers round to ≤2 decimals', () => {
    expect(formatWatchValue(24.503, 'temperature')).toBe('24.5 °C');
    expect(formatWatchValue(587.913, 'co2')).toBe('587.91 ppm');
    expect(formatWatchValue(1200, 'power')).toBe('1200 W');
  });

  test('unknown parameters stay bare; non-numbers keep their JSON face', () => {
    expect(formatWatchValue(1, 'motion')).toBe('1');
    expect(formatWatchValue(true, 'smoke')).toBe('true');
    expect(formatWatchValue(undefined, 'temperature')).toBe('undefined');
  });
});

// ============================================================================
// T11 (R2, u4-F3): --zones human table — units, simTime, 2-decimal rounding
// ============================================================================

describe('humanZoneTable (T11, R2 u4-F3; T23, R3 u1-F5/u4-F3; T76, R8 stable columns)', () => {
  test('labels units, samples simTime, and rounds human values to 2 decimals', () => {
    const table = humanZoneTable(
      [
        {
          id: 'bldg-d-f1',
          parameters: { temperature: 24.503, humidity: 55.1, co2: 444.18037812619025, pm2_5: 12.3456, power: 1200.5 },
        },
      ],
      3720,
    );
    expect(table.simTime).toBe('simTime=3720s');
    // T76: STABLE column order — the declared physical-quantity order, not
    // alphabetical drift. Two consecutive samples must produce this exact
    // column list.
    expect(table.columns).toEqual([
      'zone',
      'temperature (°C)',
      'humidity (%)',
      'co2 (ppm)',
      'pm2_5 (µg·m⁻³)',
      'power (W)',
    ]);
    const row = table.rows[0];
    // T23: the row KEY is the unit-labelled column label — out.table looks
    // cells up by row[col], so bare keys rendered '-' for every reading.
    expect(row['co2 (ppm)']).toBe(444.18); // was 444.18037812619025 — human face rounds
    expect(row['temperature (°C)']).toBe(24.5);
    expect(row['pm2_5 (µg·m⁻³)']).toBe(12.35);
    expect(row['power (W)']).toBe(1200.5);
  });

  test('column order is STABLE across samples (T76, u1-F8: the 9→13-column drift)', () => {
    const zoneA = { id: 'z-a', parameters: { temperature: 21.5, humidity: 50, wind_speed: 3.2 } };
    const zoneB = { id: 'z-b', parameters: { temperature: 22.5, humidity: 51, co2: 620.5, wind_speed: 2.9, light: 300 } };
    const first = humanZoneTable([zoneA, zoneB], 100);
    // A later sample where a zone grew a NEW parameter must not reshuffle
    // the existing columns — unknown params slot in after the known order.
    const second = humanZoneTable(
      [
        { id: 'z-a', parameters: { temperature: 21.7, humidity: 50.2, wind_speed: 3.1, motion: true } },
        zoneB,
      ],
      120,
    );
    const base = first.columns.filter(c => c !== 'zone');
    const grown = second.columns.filter(c => c !== 'zone' && c !== 'motion (flag)');
    expect(grown).toEqual(base);
    // Flags render LAST regardless of name order.
    expect(second.columns[second.columns.length - 1]).toBe('motion (flag)');
  });

  test('boolean flag columns group last with a "(flag)" header and render true/false uniformly (u1-F8: true/0 混写 fix)', () => {
    const table = humanZoneTable(
      [
        { id: 'z-a', parameters: { temperature: 31.57, motion: true } },
        { id: 'z-b', parameters: { temperature: 24.4, motion: false } },
      ],
      40123,
    );
    expect(table.columns).toEqual(['zone', 'temperature (°C)', 'motion (flag)']);
    expect(table.rows[0]['motion (flag)']).toBe('true');
    expect(table.rows[1]['motion (flag)']).toBe('false');
  });

  test('numeric-encoded booleans (0/1) unify to false/true in flag columns', () => {
    const table = humanZoneTable(
      [
        { id: 'bldg-d-f1', parameters: { temperature: 31.57, co2: 587.9 } },
        { id: 'bldg-m-f1', parameters: { temperature: 24.4, motion: 1 } },
        { id: 'bldg-m-f2', parameters: { temperature: 25.1, motion: 0 } },
      ],
      40123,
    );
    expect(table.columns).toEqual(['zone', 'temperature (°C)', 'co2 (ppm)', 'motion (flag)']);
    expect(table.rows[0]['motion (flag)']).toBeUndefined(); // not carried — honest '-'
    expect(table.rows[1]['motion (flag)']).toBe('true'); // was raw 1 — never mixed with true again
    expect(table.rows[2]['motion (flag)']).toBe('false');
    // And nothing reads bare-keyed anymore (the old buggy shape).
    expect(table.rows[0]).not.toHaveProperty('temperature');
    expect(table.rows[0]).not.toHaveProperty('co2');
  });

  test('parameters without a unit entry render bare (no invented unit); unknown params sort after the known order', () => {
    const table = humanZoneTable([{ id: 'z', parameters: { water_level: 1.25, custom_metric: 3.267 } }], 5);
    // water_level is unit-known (m, from the PhysicalParameter vocabulary);
    // custom_metric is unknown → bare label, after the known order.
    expect(table.columns).toEqual(['zone', 'water_level (m)', 'custom_metric']);
    expect(table.rows[0]['water_level (m)']).toBe(1.25);
    expect(table.rows[0]['custom_metric']).toBe(3.27);
  });

  test('15-digit floats and scientific notation dust render at display precision (u4-P1-1: 28.72498000506343 / 6.6e-24)', () => {
    const table = humanZoneTable(
      [{ id: 'z', parameters: { temperature: 28.72498000506343, co2: 6.6e-24 } }],
      900,
    );
    expect(table.rows[0]['temperature (°C)']).toBe(28.72);
    expect(table.rows[0]['co2 (ppm)']).toBe(0); // dust rounds to an honest display 0 (--json keeps full precision)
    expect(JSON.stringify(table.rows[0])).not.toContain('e-24');
  });
});

// ============================================================================
// T19 (R2, u4-F6): eval human report — effectChecks + recordKinds sections
// ============================================================================

function renderEval(report: unknown): string[] {
  const lines: string[] = [];
  renderEvalReportHuman(report, text => lines.push(text));
  return lines;
}

describe('renderEvalReportHuman effectChecks/recordKinds (T19, R2 u4-F6)', () => {
  test('u4 shape: 8 device executions at 87.5% — both sections render from the JSON data', () => {
    const lines = renderEval({
      simId: 'sim-u4',
      scenarioId: 'campus',
      source: 'live',
      state: 'running',
      decisions: { total: 2, accuracy: 0.5 },
      handshakes: { initiated: 1, successRate: 1 },
      effectChecks: {
        attempts: 8,
        successes: 7,
        failures: 1,
        passRate: 0.875,
        deviceExecutions: { attempts: 8, successes: 7, failures: 1 },
      },
      recordKinds: { 'device-execution': 8, decision: 2, 'nl-interaction': 1 },
      metaAgents: [],
    });
    const effect = lines.find(l => l.startsWith('effectChecks:'));
    expect(effect).toBeDefined();
    expect(effect).toContain('8 attempts');
    expect(effect).toContain('7 ok');
    expect(effect).toContain('1 failed');
    // Shares the report's pct formatter (integer rounding) — 0.875 → 88%,
    // consistent with every other percentage in the human table.
    expect(effect).toContain('pass 88%');
    const kinds = lines.find(l => l.startsWith('recordKinds:'));
    expect(kinds).toBeDefined();
    expect(kinds).toContain('device-execution 8');
    expect(kinds).toContain('decision 2');
    expect(kinds).toContain('nl-interaction 1');
  });

  test('missing sections print "—" with a reason — never fabricated numbers', () => {
    const lines = renderEval({
      simId: 'sim-x',
      scenarioId: 'campus',
      source: 'disk',
      state: 'stopped',
      decisions: { total: 0, accuracy: null },
      handshakes: { initiated: 0, successRate: null },
      metaAgents: [],
    });
    expect(lines.some(l => l.startsWith('effectChecks: — (no effect-check data'))).toBe(true);
    expect(lines.some(l => l.startsWith('recordKinds: — (no trajectory coverage data'))).toBe(true);
  });
});

// ============================================================================
// T43 (R4, u1-F3/u4-P2-1): END-TO-END — the PRODUCER (EngineRuntime's
// sliding-window sampler) feeds the RENDERER (renderStatusHumanLines) with
// the exact field names both sides agree on. Batch 3's lesson: the CLI
// rendered `effectiveSpeedWindowPerSec` while NO producer ever emitted it —
// a forever-false branch users could never see. This block fails the moment
// either side drifts: a renamed producer field starves the poll below; a
// renamed renderer field breaks the anchors.
// ============================================================================

import { loadScenarioFile } from '@active-collaboration/core';
import { EngineRuntime } from '@active-collaboration/core';

function tinyWorldScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'cli-speed-window-e2e', name: 'CLI Speed Window E2E' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: [],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('T43 end-to-end: EngineRuntime window sampler → status dual face', () => {
  test('a running runtime produces BOTH figures and the human face renders the window as the scheduling estimate', async () => {
    const runtime = new EngineRuntime(tinyWorldScenario(), { tickMs: 40 });
    try {
      runtime.start(5);
      // Poll (no fixed sleep): the producer must deliver the window face on
      // its own cadence — its absence after the bound is a REAL failure
      // (the T32 "renderer waits, data never comes" regression, inverted).
      let snap: ReturnType<EngineRuntime['getSnapshot']> | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        snap = runtime.getSnapshot();
        if (snap.effectiveSpeedWindowPerSec !== undefined) break;
        await sleep(40);
      }
      expect(
        snap?.effectiveSpeedWindowPerSec,
        "EngineRuntime never produced effectiveSpeedWindowPerSec — the renderer's window branch is starving again",
      ).toBeDefined();
      expect(snap!.effectiveSpeedWindowSec).toBeDefined();
      // T61 (R6, u4-F3): the sampler now aggregates into 1s WALL BUCKETS, so
      // the covered span tracks actual elapsed wall time (this short run:
      // a couple of seconds ⇒ windowSec ≥ 2). The ≥30s coverage bound under
      // 10ms tick floods is pinned by the injected-clock unit tests in
      // packages/core (speed-window.vitest.test.ts) — a wall-clock e2e
      // cannot run 30 real seconds.
      expect(
        snap!.effectiveSpeedWindowSec!,
        'the effective-speed window stopped tracking wall-clock buckets',
      ).toBeGreaterThanOrEqual(2);
      // NOTE: the instant figure is deliberately NOT asserted — the
      // producer keeps its own lastTickWallMs gate and honestly omits it
      // when a tick body costs 0ms (fast host, tiny world).

      // The CLI status mapping (statusSim's exact field projection) → human.
      // The instant face keeps its own lastTickWallMs gate — a 0ms tick on a
      // fast host honestly omits it, and the window figure then stands alone
      // (the T43 renderer branch). Either way the window face is the anchor.
      const lines = renderStatusHumanLines({
        state: snap!.state,
        simTimeSec: snap!.simTimeSec,
        tickCount: snap!.tickCount,
        speed: snap!.speed,
        scenarioName: snap!.scenarioName,
        tickMs: snap!.tickMs,
        tickWallMs: snap!.tickWallMs,
        autoThrottled: snap!.autoThrottled,
        effectiveSpeedPerSec: snap!.effectiveSpeedPerSec,
        effectiveSpeedWindowPerSec: snap!.effectiveSpeedWindowPerSec,
        effectiveSpeedWindowSec: snap!.effectiveSpeedWindowSec,
      });
      const speedLine = lines.find(l => l.startsWith('effectiveSpeed'))!;
      expect(speedLine).toContain('avg — schedule with this one');
      expect(speedLine).toContain(`nominal speed=${snap!.speed}`);
      // T83: the instant figure never rides the human speed line anymore
      // (window caliber only) — even when the producer emitted it this tick.
      expect(speedLine).not.toContain('(instant)');
      if (snap!.effectiveSpeedPerSec !== undefined) {
        expect(speedLine).not.toContain(String(Number(snap!.effectiveSpeedPerSec.toFixed(1))));
      }
    } finally {
      runtime.stop();
    }
  }, 15_000);

  test('a paused runtime renders the honest no-window dash (no fake 0 end-to-end either)', async () => {
    const runtime = new EngineRuntime(tinyWorldScenario(), { tickMs: 40 });
    try {
      runtime.start(5);
      await sleep(120); // a few ticks so the instant face exists, then freeze
      runtime.pause();
      const snap = runtime.getSnapshot();
      expect(snap.state).toBe('paused');
      expect(snap.effectiveSpeedWindowPerSec).toBeUndefined();
      const lines = renderStatusHumanLines({
        state: snap.state,
        simTimeSec: snap.simTimeSec,
        tickCount: snap.tickCount,
        speed: snap.speed,
        scenarioName: snap.scenarioName,
      });
      const speedLine = lines.find(l => l.startsWith('effectiveSpeed'))!;
      expect(speedLine).toContain('effectiveSpeed: —');
      // No fabricated rate: the paused dash carries no ≈ figure at all.
      expect(speedLine).not.toContain('≈');
      expect(speedLine).not.toContain('sim-s/s');
    } finally {
      runtime.stop();
    }
  }, 15_000);
});
