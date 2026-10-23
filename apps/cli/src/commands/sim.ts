/**
 * `eaf sim` — simulation lifecycle, event injection, device commands, and
 * the WS-free `watch` follower (polls the snapshot and prints one-line
 * diffs; NDJSON under --json).
 */

import {
  boolFlag,
  jsonFlag,
  numberFlag,
  parse,
  requirePositional,
  requireString,
  stringFlag,
} from '../args.js';
import type { Ctx, FlowRun } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';

const USAGE_CREATE =
  'eaf sim create --env <id|name> [--llm auto|llm|none] [--tick-ms <ms>] [--no-auto-actuate] [--scheduling tick|lazy]';
const USAGE_LIST = 'eaf sim list --env <id|name>';
const USAGE_INJECT =
  'eaf sim inject <simId> --type <t> --zone <z> [--parameter <p>] [--value <v>] [--severity low|medium|high|critical] [--duration <simSeconds>]';
const USAGE_COMMAND = 'eaf sim command <simId> --device <deviceId> --cmd <name> [--params \'{}\']';
const USAGE_WATCH =
  'eaf sim watch <simId> [--interval <ms>] [--min-delta <n>] [--all-changes]';

interface Snapshot {
  runtimeId: string;
  scenarioId: string;
  scenarioName: string;
  state: string;
  simTimeSec: number;
  simTime: string;
  speed: number;
  tickCount: number;
  /** T3 (R2): wall cost of the last tick (ms); absent until the loop ticked. */
  tickWallMs?: number;
  /** T3 (R2): configured tick interval (ms) — the nominal rate base. */
  tickMs?: number;
  /** T3 (R2): true when the tick loop stretched its interval (degraded cadence). */
  autoThrottled?: boolean;
  /** T3 (R2): instantaneous real-advancement estimate (sim-s per real second). */
  effectiveSpeedPerSec?: number;
  /** T32 (R3): sliding-window real-advancement average (sim-s per real
   *  second) — the schedulable figure (the instant estimate swings 2-4×
   *  with LLM decision gaps). Absent on pre-T32 servers: the CLI renders
   *  the instant figure alone. */
  effectiveSpeedWindowPerSec?: number;
  /** T32 (R3): the window's length in wall seconds (label face; absent =
   *  the server did not annotate it — renders "window avg"). */
  effectiveSpeedWindowSec?: number;
  /** T79 (R8): the server's honest warning when agents want LLM decisions
   *  but none is configured — explains why the decisions look rule-based. */
  llmWarning?: string;
  zones: Array<{ id: string; name?: string; type?: string; parameters: Record<string, number | boolean> }>;
  devices: Array<{ id: string; name: string; type: string; role: string; zoneId: string; state: Record<string, unknown>; commands?: string[] }>;
  agents: Array<{ id: string; name: string; eventsProcessed: number }>;
  recentDecisions: Array<{ agentId: string; eventId: string; eventType: string; decision: string; decisionSource: string; at: string }>;
  scheduledEvents: Array<{ id: string; type: string; zoneId: string; atSimTimeSec?: number; fired: boolean }>;
}

export async function simCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'create':
      return createSim(ctx, argv);
    case 'list':
      return listSims(ctx, argv);
    case 'start':
      return simpleAction(ctx, argv, 'start', true);
    case 'pause':
    case 'stop':
      return simpleAction(ctx, argv, sub, false);
    // T38.1 (R3, u1-F7): the server accepts speed on resume ("can also be
    // changed on pause/resume") — the CLI just never exposed it.
    case 'resume':
      return simpleAction(ctx, argv, 'resume', true);
    case 'hibernate':
      return hibernateSim(ctx, argv);
    case 'step':
      return stepSim(ctx, argv);
    case 'status':
      return statusSim(ctx, argv);
    case 'snapshot':
      return snapshotSim(ctx, argv);
    case 'inject':
      return injectEvent(ctx, argv);
    case 'command':
      return deviceCommand(ctx, argv);
    case 'run-flow':
      return runFlow(ctx, argv);
    case 'watch':
      return watchSim(ctx, argv);
    case 'eval':
      return evalSim(ctx, argv);
    default:
      throw usageError(
        `unknown sim subcommand "${sub ?? ''}" (expected create|list|start|pause|resume|hibernate|step|stop|status|snapshot|inject|command|run-flow|watch|eval)`,
      );
  }
}

async function snapshot(ctx: Ctx, id: string): Promise<Snapshot> {
  return (await ctx.openClient().get(`/api/simulations/${encodeURIComponent(id)}/snapshot`)) as Snapshot;
}

/** One roster row — the server's SimulationSummary plus T52's creatorName. */
export interface SimListRow {
  id: string;
  state: string;
  simTimeSec: number;
  llm: string;
  environmentId?: string;
  createdBy?: string;
  /** T52: the creator's display name (absent for legacy anonymous creations). */
  creatorName?: string;
  platformOwned?: boolean;
  /** T82 (R9, u3-F1): present ONLY on the env's authoritative world session. */
  kind?: 'world-session';
}

/**
 * T52 (R6, u1-F6): `eaf sim list --env <id|name>` — the roster that used not
 * to exist. Every sim of the environment (creator-or-member visibility,
 * server-side) with state / sim-time / creator / llm, INCLUDING stopped and
 * hibernated rows — a roster that hides the dead sims cannot explain the
 * live ones. AGENT_AMBIGUOUS 409s now point here.
 */
async function listSims(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_LIST);
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  const envRef = requireString(flags, 'env', USAGE_LIST);
  const detail = await ctx.resolveEnv(envRef);
  const response = (await ctx.openClient().get(
    `/api/simulations?environmentId=${encodeURIComponent(detail.id)}`,
  )) as { simulations: SimListRow[] };
  if (ctx.json) {
    ctx.out.data(response);
    return;
  }
  for (const text of renderSimListHumanLines(response.simulations)) {
    ctx.out.line(text);
  }
}

/** T52: the human roster face — one line per sim, dead sims included. */
export function renderSimListHumanLines(rows: SimListRow[]): string[] {
  if (rows.length === 0) {
    return ['no simulations for this environment — create one: eaf sim create --env <id|name>'];
  }
  // T79 hygiene (walker v1): a just-started run carries a FRACTIONAL
  // sim-time (simTime=2.179s) — the roster renders at the 2-decimal display
  // convention; --json keeps full precision. Integers render unchanged.
  const simTime = (value: number): string => `${Number(value.toFixed(2))}s`;
  const lines = [`${rows.length} simulation(s) for this environment (stopped/hibernated included):`];
  for (const row of rows) {
    // T82 (R9, u3-F1): the authoritative world session is labeled by TYPE —
    // `creator=unknown [platform]` read as a mystery actor when the row is
    // the env's own living world (the same row an AGENT_AMBIGUOUS error
    // names "platform world-session"). Its state word is the runtime's
    // (same caliber as every other row and as `env session status`'s state).
    const isSession = row.kind === 'world-session';
    const creator = isSession ? 'platform' : (row.creatorName ?? row.createdBy ?? 'unknown');
    const ownership = isSession ? ' [world-session]' : (row.platformOwned === true ? ' [platform]' : '');
    lines.push(
      `  ${row.id}  state=${row.state}  simTime=${simTime(row.simTimeSec)}  creator=${creator}${ownership}  llm=${row.llm}`,
    );
  }
  return lines;
}

async function createSim(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      env: { type: 'string' },
      llm: { type: 'string' },
      'tick-ms': { type: 'string' },
      'no-auto-actuate': { type: 'boolean' },
      scheduling: { type: 'string' },
    },
    USAGE_CREATE,
  );
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_CREATE}`);
  const envRef = requireString(flags, 'env', USAGE_CREATE);
  const llm = stringFlag(flags, 'llm');
  if (llm !== undefined && !['auto', 'llm', 'none'].includes(llm)) {
    throw usageError(`--llm must be auto|llm|none\nusage: ${USAGE_CREATE}`);
  }
  const tickMs = numberFlag(flags, 'tick-ms', USAGE_CREATE);
  // T-051: decision-only runs — agents decide/record but never actuate
  // their own devices (options.autoActuateIndependent: false wins over
  // every agent's decisionPolicy; default true keeps current behavior).
  const noAutoActuate = boolFlag(flags, 'no-auto-actuate');
  // Living-worlds P1: due-driven advancement (default tick = unchanged).
  const scheduling = stringFlag(flags, 'scheduling');
  if (scheduling !== undefined && !['tick', 'lazy'].includes(scheduling)) {
    throw usageError(`--scheduling must be tick|lazy (lazy = due-moment driven advancement)\nusage: ${USAGE_CREATE}`);
  }
  const detail = await ctx.resolveEnv(envRef);
  const created = (await ctx.openClient().post('/api/simulations', {
    environmentId: detail.id,
    options: {
      ...(llm ? { llmClient: llm } : {}),
      ...(tickMs !== undefined ? { tickMs } : {}),
      ...(noAutoActuate ? { autoActuateIndependent: false } : {}),
      ...(scheduling !== undefined ? { scheduling } : {}),
    },
  })) as { id: string; state: string; llm: string; scheduling?: string; llmWarning?: string };
  if (ctx.json) {
    ctx.out.data(created);
  } else {
    ctx.out.line(
      `simulation ${created.id} created (state=${created.state}, llm=${created.llm}` +
      `${scheduling === 'lazy' ? ', scheduling=lazy (due-driven)' : ''}` +
      `${noAutoActuate ? ', auto-actuate=off' : ''})`,
    );
  }
  // Never degrade to rule-only silently: the server warns when agents
  // requested an LLM that isn't configured — T72: this explains the just-
  // created payload, so it belongs to the human face (stdout); under --json
  // it stays off the pipeable stdout.
  if (created.llmWarning) {
    ctx.out.explain(`warning: ${created.llmWarning}`);
  }
}

/**
 * DOC-02 (speed semantics): the start/resume payload echoes the pace in
 * force — `speed` sim-s/tick and `nominalSpeedPerSec` (sim-s per wall-s,
 * the classic tick loop's nominal rate; honestly absent on lazy sims).
 * Exported pure so the render lane can fixture-test it (R3 discipline).
 */
export interface SimActionResult {
  id: string;
  state: string;
  speed?: number;
  nominalSpeedPerSec?: number;
  speedRetargeted?: boolean;
  /** R2-BUG-04: world-session /start answers the real caught-up clock. */
  simTimeSec?: number;
}

export function renderSimActionLine(result: SimActionResult, action: string): string {
  const pace = result.nominalSpeedPerSec !== undefined
    ? ` — speed=${result.speed} sim-s/tick ≈ ${Math.round(result.nominalSpeedPerSec * 10) / 10} sim-s/wall-s (nominal ×${Math.round(result.nominalSpeedPerSec * 10) / 10} wall)`
    : '';
  const clock = result.simTimeSec !== undefined ? ` — simTime=${result.simTimeSec}s` : '';
  return `${result.state} ${result.id} (${action})${pace}${clock}`;
}

async function simpleAction(ctx: Ctx, argv: string[], action: 'start' | 'pause' | 'resume' | 'stop', speed: boolean): Promise<void> {
  const usage = `eaf sim ${action} <simId>${speed ? ' [--speed <n>]' : ''}`;
  const { flags, positionals } = parse(argv, speed ? { speed: { type: 'string' } } : {}, usage);
  const id = requirePositional(positionals, 'simId', usage);
  const speedValue = speed ? numberFlag(flags, 'speed', usage) : undefined;
  const result = (await ctx.openClient().post(
    `/api/simulations/${encodeURIComponent(id)}/${action}`,
    speedValue !== undefined ? { speed: speedValue } : {},
  )) as SimActionResult;
  if (ctx.json) ctx.out.data(result);
  else ctx.out.line(renderSimActionLine(result, action));
}

/**
 * `eaf sim hibernate <simId>` — freeze the world into a checkpoint and
 * release the runtime (living-worlds P0). The response carries the frozen
 * sim-time boundary and the checkpoint metadata (path/bytes); resume with
 * `eaf sim resume <simId>` (same id, history continues).
 */
async function hibernateSim(ctx: Ctx, argv: string[]): Promise<void> {
  const usage = 'eaf sim hibernate <simId>';
  const { positionals } = parse(argv, {}, usage);
  const id = requirePositional(positionals, 'simId', usage);
  const result = (await ctx.openClient().post(
    `/api/simulations/${encodeURIComponent(id)}/hibernate`,
    {},
  )) as {
    id: string;
    state: string;
    simTimeSec: number;
    hibernatedAt: string;
    checkpoint: { path: string; simTimeSec: number; bytes: number; writtenAt: string };
  };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    `hibernated ${result.id} at simTime ${result.simTimeSec}s — checkpoint ` +
    `${result.checkpoint.bytes} bytes (${result.checkpoint.path}); resume with \`eaf sim resume ${result.id}\``,
  );
}

async function stepSim(ctx: Ctx, argv: string[]): Promise<void> {
  const usage = 'eaf sim step <simId> [--n <ticks> | --to <sec>]';
  const { flags, positionals } = parse(argv, { n: { type: 'string' }, to: { type: 'string' } }, usage);
  const id = requirePositional(positionals, 'simId', usage);
  const n = numberFlag(flags, 'n', usage);
  const to = numberFlag(flags, 'to', usage);
  if (n !== undefined && to !== undefined) {
    throw usageError(`--n and --to are mutually exclusive\nusage: ${usage}`);
  }
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    throw usageError(`--n must be a positive integer\nusage: ${usage}`);
  }
  if (to !== undefined && to <= 0) {
    throw usageError(`--to must be a positive number of seconds\nusage: ${usage}`);
  }
  const result = (await ctx.openClient().post(
    `/api/simulations/${encodeURIComponent(id)}/step`,
    to !== undefined ? { toSimTimeSec: to } : n !== undefined ? { n } : {},
  )) as { id: string; state: string; simTimeSec: number };
  if (ctx.json) ctx.out.data(result);
  else ctx.out.line(`stepped ${to !== undefined ? `to ${to}s` : (n ?? 1)} → simTime ${result.simTimeSec}s (${result.state})`);
}

async function statusSim(ctx: Ctx, argv: string[]): Promise<void> {
  const usage = 'eaf sim status <simId>';
  const { positionals } = parse(argv, {}, usage);
  const id = requirePositional(positionals, 'simId', usage);
  const snap = await snapshot(ctx, id);
  if (ctx.json) {
    ctx.out.data({
      id: snap.runtimeId,
      scenarioId: snap.scenarioId,
      state: snap.state,
      simTimeSec: snap.simTimeSec,
      simTime: snap.simTime,
      tickCount: snap.tickCount,
      speed: snap.speed,
      // T3 (R2, B1-11): the real-advancement face — nominal speed alone let
      // operators schedule drills against a rate the world never achieved.
      ...(snap.tickMs !== undefined ? { tickMs: snap.tickMs } : {}),
      ...(snap.tickWallMs !== undefined ? { lastTickWallMs: snap.tickWallMs } : {}),
      ...(snap.autoThrottled !== undefined ? { autoThrottled: snap.autoThrottled } : {}),
      ...(snap.effectiveSpeedPerSec !== undefined
        ? { effectiveSpeedPerSec: snap.effectiveSpeedPerSec }
        : {}),
      // T32 (R3): the window-average face rides --json too (human ≥ json).
      ...(snap.effectiveSpeedWindowPerSec !== undefined
        ? {
            effectiveSpeedWindowPerSec: snap.effectiveSpeedWindowPerSec,
            ...(snap.effectiveSpeedWindowSec !== undefined
              ? { effectiveSpeedWindowSec: snap.effectiveSpeedWindowSec }
              : {}),
          }
        : {}),
    });
    return;
  }
  for (const text of renderStatusHumanLines(snap)) {
    ctx.out.line(text);
  }
  if (snap.autoThrottled === true) {
    // T72 (R8): the throttle cause explains THIS status payload — human face
    // (stdout); --json keeps it on stderr so stdout stays pure.
    ctx.out.explain(
    // T66f (R6, u1-F11): the cause list is NEUTRAL — rule-only worlds were
    // blamed on "LLM decisions" they never make. The full candidate set:
    // LLM decisions (when present), event loops / physics load, flows.
      'actual advancement is BELOW the nominal speed (ticks are being throttled — ' +
        'the tick body outgrew its budget: LLM decisions (if any), event loops / load, or flow steps stretch the interval)',
    );
  }
}

/**
 * T3 (R2, B1-11) + T32 (R3) + T83 (R8, u4-P2-4): the human status face —
 * never thinner than --json (R102) for REPRODUCIBLE figures: nominal speed,
 * cadence, and the sliding-window average. The INSTANT estimate left the
 * human panel (T83 ruling: one session sampled it at 77.6 → 340.1 → 272.0 —
 * a 4.4× swing is not a schedulable "有效倍速", and printing it invited
 * scheduling against noise). Window absent → an honest dash that names the
 * --json instant figure as non-reproducible, never a fabricated 0.
 */
export function renderStatusHumanLines(snap: {
  state: string;
  simTimeSec: number;
  tickCount: number;
  speed: number;
  scenarioName: string;
  tickMs?: number;
  tickWallMs?: number;
  autoThrottled?: boolean;
  effectiveSpeedPerSec?: number;
  effectiveSpeedWindowPerSec?: number;
  effectiveSpeedWindowSec?: number;
}): string[] {
  const dash = '—';
  // T43: the window's label face — the covered span rounded to whole
  // seconds, with an honest "<1s" for a window that just opened (never a
  // misleading "0s").
  const windowLabelOf = (): string => {
    if (snap.effectiveSpeedWindowSec === undefined) return 'window';
    return snap.effectiveSpeedWindowSec >= 1
      ? `${Math.round(snap.effectiveSpeedWindowSec)}s`
      : '<1s';
  };
  const lines = [
    // T61 (R6, u4-F12): `speed` is the NOMINAL simSecPerTick — a bare number
    // read as "1× wall-clock multiplier" (u4). The qualifier names the unit
    // and points at the real rates below.
    `state=${snap.state} simTime=${snap.simTimeSec}s tick=${snap.tickCount} speed=${snap.speed} (nominal simSecPerTick — not a wall-clock multiplier; effective rate below) scenario=${snap.scenarioName}`,
    `cadence: tickMs=${snap.tickMs ?? dash}ms ` +
      `lastTickWallMs=${snap.tickWallMs ?? dash}ms ` +
      `autoThrottled=${snap.autoThrottled === undefined ? dash : snap.autoThrottled ? 'yes' : 'no'}`,
  ];
  if (snap.effectiveSpeedWindowPerSec !== undefined) {
    lines.push(
      `effectiveSpeed≈${snap.effectiveSpeedWindowPerSec.toFixed(1)} sim-s/s (${windowLabelOf()} avg — ` +
        `schedule with this one; nominal speed=${snap.speed})`,
    );
  } else {
    // T83 (R8): the instant estimate no longer prints on the human face.
    // The dash names where the (non-reproducible) figure lives instead.
    lines.push(
      'effectiveSpeed: — (no window average this tick; the instant figure on --json is a non-reproducible ' +
        `estimate — schedule only on the window caliber; nominal speed=${snap.speed})`,
    );
  }
  // T111 (R18, u3-F-3 honesty close-out) rewritten by T123 (D1, option A):
  // the windows were always WALL-CLOCK constants (the old "SIMULATED time"
  // wording was a documentation-side distortion). Since T123 the handshake
  // window carries a real-time FLOOR at high world speeds: at a nominal
  // rate ≥ EAF_AC_RESPONSE_FLOOR_MIN_RATE (default ×60 sim-sec per
  // wall-sec) the window is guaranteed at least EAF_AC_RESPONSE_MIN_WALL_MS
  // (default 5 real minutes); below that rate behavior is unchanged. The
  // eval report's per-cause funnel is the attribution surface.
  lines.push(
    'note: at high world speeds (rate >= EAF_AC_RESPONSE_FLOOR_MIN_RATE, default x60 sim-sec/wall-sec) partner ' +
      'response windows carry a real-time floor — the handshake window is guaranteed at least ' +
      'EAF_AC_RESPONSE_MIN_WALL_MS (default 5 real minutes); below that rate behavior is unchanged (120s wall ' +
      'window). Attribution: handshakes.failures.byCause (sim eval). EAF_AC_HANDSHAKE_FAST_LANE=1 (default off) ' +
      'puts handshake evaluations on the fast-lane LLM queue to relieve peak-hour backlog; off = baseline. ' +
      '注：高倍速世界（名义倍率 ≥ EAF_AC_RESPONSE_FLOOR_MIN_RATE，默认 ×60 仿真秒/真实秒）下伙伴握手窗有真实时间' +
      '下限保底——至少 EAF_AC_RESPONSE_MIN_WALL_MS（默认 5 真实分钟）；低于该倍率行为不变（120 秒墙钟窗）' +
      '（归因见 sim eval 的 handshakes.failures.byCause）。EAF_AC_HANDSHAKE_FAST_LANE=1（默认关）把握手评估' +
      '切到快车道 LLM 队列缓释洪峰积压；关闭即基线行为。',
  );
  return lines;
}

/**
 * T11 (R2, u4-F3) + T76 (R8, u4-P1-1): human-facing parameter units. The
 * physics layer owns the semantics but carries no machine-readable unit
 * metadata (its units live in comments — packages/simulation/src/physics/
 * PhysicsLayer.ts for the base six; the full unit vocabulary is mirrored
 * from the `PhysicalParameter` enum comments in
 * packages/simulation/src/devices/types.ts: wind_speed m/s, pressure hPa,
 * occupancy % …). This table mirrors THOSE, it is not a second authority.
 * Parameters without an entry render bare (no invented unit). --json stays
 * unit-free full-precision. ONE table — watch and snapshot both consume it.
 */
const PARAM_UNITS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  light: 'lx',
  co2: 'ppm',
  pm2_5: 'µg·m⁻³',
  power: 'W',
  // T76: the common enum parameters beyond the base six (same comment sources).
  pressure: 'hPa',
  wind_speed: 'm/s',
  wind_direction: '°',
  uv_index: '',
  rainfall: 'mm',
  visibility: 'km',
  occupancy: '%',
  people_count: '',
  co2_indoor: 'ppm',
  pm10: 'µg·m⁻³',
  voc: 'ppb',
  noise_level: 'dB',
  sound_level: 'dB',
  smoke: 'ppm',
  battery_level: '%',
  water_level: 'm',
  soil_moisture: '%',
  soil_temperature: '°C',
  energy_consumption: 'kWh',
  voltage: 'V',
  current: 'A',
};

/**
 * T76 (R8, u4-P1-1): the STABLE column order for the zones table — known
 * physical quantities first in sensor-convention order, unknown numeric
 * parameters after (alphabetical, so a new scenario param cannot reshuffle
 * the columns mid-run), boolean flag columns grouped last. Fixes the
 * 9→13-column drift u1-F8 sampled on consecutive snapshots.
 */
const PARAM_ORDER = [
  'temperature', 'humidity', 'co2', 'co2_indoor', 'pm2_5', 'pm2_5_indoor', 'pm10', 'voc',
  'light', 'noise_level', 'sound_level', 'pressure', 'wind_speed', 'wind_direction',
  'occupancy', 'people_count', 'power', 'energy_consumption', 'smoke', 'water_level',
  'soil_moisture', 'soil_temperature',
];

/** Parameters that are boolean flags by vocabulary (u1-F8: true/0 混写 fix). */
const FLAG_PARAMS = new Set(['motion', 'presence', 'door_state', 'window_state', 'alarm_status']);

/** Column sort key: declared order first, unknown params after (alphabetical tiebreak). */
function paramRank(key: string): number {
  const index = PARAM_ORDER.indexOf(key);
  return index === -1 ? PARAM_ORDER.length : index;
}

/** A parameter renders as a flag column when its vocabulary says so, or when every observed value is boolean. */
function isFlagColumn(key: string, values: unknown[]): boolean {
  if (FLAG_PARAMS.has(key)) return true;
  return values.length > 0 && values.every(value => typeof value === 'boolean');
}

/**
 * T11 (R2, u4-F3) + T23 (R3, u1-F5/u4-F3) + T76 (R8): the human --zones /
 * snapshot face — unit-labelled headers (PARAM_UNITS), a STABLE column
 * order (PARAM_ORDER, unknown params alphabetical after, flags last with a
 * "(flag)" header), 2-decimal values, booleans uniformly true/false, and
 * the sampling sim-time. T23 regression: the row KEY must BE the
 * unit-labelled column label — `out.table` looks a cell up by `row[col]`,
 * so bare row keys under labelled columns rendered `-` for every reading
 * (93 zones of empty table). Exported for the pure render tests; --json
 * keeps full precision (same numbers, per-face precision policy).
 */
export function humanZoneTable(
  zones: Array<{ id: string; parameters: Record<string, number | boolean> }>,
  simTimeSec: number,
): { simTime: string; rows: Array<Record<string, unknown>>; columns: string[] } {
  const labelOf = (key: string): string =>
    PARAM_UNITS[key] !== undefined && PARAM_UNITS[key] !== '' ? `${key} (${PARAM_UNITS[key]})` : key;
  const keys = [...new Set(zones.flatMap(zone => Object.keys(zone.parameters)))];
  const flagOf = new Map<string, boolean>();
  for (const key of keys) {
    const values = zones.map(zone => zone.parameters[key]).filter(value => value !== undefined);
    flagOf.set(key, isFlagColumn(key, values));
  }
  const ordered = keys.sort((a, b) => {
    const [fa, fb] = [flagOf.get(a) ?? false, flagOf.get(b) ?? false];
    if (fa !== fb) return fa ? 1 : -1; // flags last
    const [ra, rb] = [paramRank(a), paramRank(b)];
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const columnLabel = (key: string): string => (flagOf.get(key) ? `${labelOf(key)} (flag)` : labelOf(key));
  const rows = zones.map(zone => {
    const out: Record<string, unknown> = { zone: zone.id };
    for (const key of ordered) {
      const value = zone.parameters[key];
      if (value === undefined) continue;
      // T76: flag columns unify every encoding (true/1 → 'true', false/0 →
      // 'false') BEFORE the numeric branch can render a bare 1/0 — u1-F8's
      // "true 与 0 混写" column was exactly this collision.
      if (flagOf.get(key) === true) {
        out[columnLabel(key)] = value === true || value === 1 ? 'true' : 'false';
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        out[columnLabel(key)] = Number(value.toFixed(2));
      } else {
        out[columnLabel(key)] = value;
      }
    }
    return out;
  });
  const columns = ['zone', ...ordered.map(columnLabel)];
  return { simTime: `simTime=${simTimeSec}s`, rows, columns };
}

/**
 * T76 (R8, u4-P1-1 + u1-F8): `sim snapshot` — the human face is a SUMMARY +
 * the unit-labelled zones table (the help had always promised per-zone
 * params); the 263KB bare JSON dump is `--json`'s job, or `--full` for an
 * explicit human-mode dump. `--zones` keeps the table-only face. The JSON
 * face is byte-identical to the old payload (same object, full precision).
 */
async function snapshotSim(ctx: Ctx, argv: string[]): Promise<void> {
  const usage = 'eaf sim snapshot <simId> [--zones] [--full]';
  const { flags, positionals } = parse(argv, { zones: { type: 'boolean' }, full: { type: 'boolean' } }, usage);
  if (flags.zones === true && flags.full === true) {
    throw usageError(`--zones and --full are mutually exclusive\nusage: ${usage}`);
  }
  const id = requirePositional(positionals, 'simId', usage);
  const snap = await snapshot(ctx, id);
  if (ctx.json) {
    // Same payload as before T76 in every --json shape (bare dump / --zones rows).
    ctx.out.data(flags.zones === true ? snap.zones.map(zone => ({ zone: zone.id, ...zone.parameters })) : snap);
    return;
  }
  if (flags.full === true) {
    ctx.io.stdout(JSON.stringify(snap, null, 2) + '\n');
    return;
  }
  if (flags.zones === true) {
    const table = humanZoneTable(snap.zones, snap.simTimeSec);
    ctx.out.line(table.simTime);
    ctx.out.table(table.rows, table.columns);
    return;
  }
  for (const text of renderSnapshotHumanLines(snap)) {
    ctx.out.line(text);
  }
  const table = humanZoneTable(snap.zones, snap.simTimeSec);
  ctx.out.line(`zones @ ${table.simTime} (2-decimal display precision; flags grouped last — full precision via --json):`);
  ctx.out.table(table.rows, table.columns);
  ctx.out.line(`full payload (devices, decisions, scheduled events): --json or --full — ${JSON.stringify(snap).length} bytes`);
}

/**
 * T76 (R8): the snapshot summary — the speed face follows the T83 ruling:
 * ONLY reproducible calibers on the human face (nominal + window average);
 * the instant estimate is a non-reproducible figure and is named as such
 * instead of being shown (u4: four samples differed 4.4×). Pure for the
 * render suite; shares the status face's wording family.
 */
export function renderSnapshotHumanLines(snap: Snapshot): string[] {
  const lines = [
    `snapshot ${snap.runtimeId} "${snap.scenarioName}" (scenario ${snap.scenarioId})`,
    `state=${snap.state} simTime=${snap.simTimeSec}s tick=${snap.tickCount} ` +
      `zones=${snap.zones.length} devices=${snap.devices.length} agents=${snap.agents.length} ` +
      `speed=${snap.speed} (nominal simSecPerTick — not a wall-clock multiplier)`,
  ];
  if (snap.effectiveSpeedWindowPerSec !== undefined) {
    const windowLabel =
      snap.effectiveSpeedWindowSec !== undefined
        ? snap.effectiveSpeedWindowSec >= 1
          ? `${Math.round(snap.effectiveSpeedWindowSec)}s`
          : '<1s'
        : 'window';
    lines.push(
      `effectiveSpeed≈${snap.effectiveSpeedWindowPerSec.toFixed(1)} sim-s/s (${windowLabel} avg — schedule with this one)`,
    );
  } else {
    lines.push(
      'effectiveSpeed: — (no window average on this snapshot; the --json instant figure is a non-reproducible estimate — schedule only on the window caliber)',
    );
  }
  // T79 (R8): the rule-only warning explains WHY every decision below reads
  // deterministic — payload explanation belongs on the human face (R102).
  if (typeof snap.llmWarning === 'string' && snap.llmWarning.length > 0) {
    lines.push(`⚠ ${snap.llmWarning}`);
  }
  return lines;
}

/** Coerce --value: number, then boolean, else keep the raw string. */
function coerceValue(raw: string): number | boolean | string {
  const asNumber = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(asNumber)) return asNumber;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

async function injectEvent(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { type: { type: 'string' }, zone: { type: 'string' }, parameter: { type: 'string' }, value: { type: 'string' }, severity: { type: 'string' }, duration: { type: 'string' } },
    USAGE_INJECT,
  );
  const id = requirePositional(positionals, 'simId', USAGE_INJECT);
  const severity = stringFlag(flags, 'severity');
  if (severity !== undefined && !['low', 'medium', 'high', 'critical'].includes(severity)) {
    throw usageError(`--severity must be low|medium|high|critical\nusage: ${USAGE_INJECT}`);
  }
  const result = (await ctx.openClient().post(`/api/simulations/${encodeURIComponent(id)}/events`, {
    type: requireString(flags, 'type', USAGE_INJECT),
    zoneId: requireString(flags, 'zone', USAGE_INJECT),
    ...(stringFlag(flags, 'parameter') !== undefined ? { parameter: stringFlag(flags, 'parameter') } : {}),
    ...(stringFlag(flags, 'value') !== undefined ? { value: coerceValue(stringFlag(flags, 'value')!) } : {}),
    ...(severity ? { severity } : {}),
    // T-103: --duration feeds durationSec (sim seconds; power-outage events).
    ...(numberFlag(flags, 'duration', USAGE_INJECT) !== undefined
      ? { durationSec: numberFlag(flags, 'duration', USAGE_INJECT) }
      : {}),
  })) as Record<string, unknown> & { warning?: string };
  // T66i (R6, u3-P3-5): the server's honest echo of an unrecognized event
  // type surfaces on the human face too (R102: human ≥ --json).
  // T72 (R8): via explain() — stdout in human mode, stderr under --json.
  if (!ctx.json && typeof result.warning === 'string' && result.warning.length > 0) {
    ctx.out.explain(`warning: ${result.warning}`);
  }
  ctx.out.data(result);
}

async function deviceCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { device: { type: 'string' }, cmd: { type: 'string' }, params: { type: 'string' } },
    USAGE_COMMAND,
  );
  const id = requirePositional(positionals, 'simId', USAGE_COMMAND);
  const params = jsonFlag<Record<string, unknown>>(flags, 'params', USAGE_COMMAND);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw usageError(`--params must be a JSON object\nusage: ${USAGE_COMMAND}`);
  }
  // Device commands require authentication (Fix-1) — use the authed client
  // so an anonymous invocation fails with a clear "login first" message.
  const result = (await ctx.authedClient().post(`/api/simulations/${encodeURIComponent(id)}/commands`, {
    deviceId: requireString(flags, 'device', USAGE_COMMAND),
    commandName: requireString(flags, 'cmd', USAGE_COMMAND),
    ...(params !== undefined ? { params } : {}),
  })) as Record<string, unknown> & { success?: boolean; error?: string; result?: unknown };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  // S3: the success body is SINGLE-layer — the engine's old double wrap
  // `{success:true, result:{…}}` is flattened server-side into
  // `{success:true, …}`. Failures stay `{success:false, error}`. For
  // display, unwrap the legacy wrapper when one is still around.
  if (result.success === false) {
    ctx.out.line(`command failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  const payload =
    typeof result.result === 'object' && result.result !== null
      ? result.result // legacy double wrap
      : Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'success'));
  ctx.out.line(
    `command ok: ${stringFlag(flags, 'cmd') ?? ''} on ${stringFlag(flags, 'device') ?? ''}` +
    (Object.keys(payload as object).length > 0 ? ` → ${JSON.stringify(payload)}` : ''),
  );
}

/**
 * `eaf sim run-flow <simId> <flowId> [--params '<json>']` — operator-triggered
 * flow run inside a RUNNING env-backed simulation (trigger bypassed,
 * triggerKind 'manual'). --params (MI-D) is validated against the flow's
 * declared inputs surface (422 FLOW_PARAMS_INVALID on unknown keys / type
 * mismatches / bounds violations / missing required inputs). Disabled flow →
 * 409 FLOW_NOT_RUNNABLE; stopped sim → 409 SIMULATION_STOPPED; a flow of
 * another environment → 404 FLOW_NOT_FOUND.
 */
async function runFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const usage = "eaf sim run-flow <simId> <flowId> [--params '<json>']";
  const { flags, positionals } = parse(argv, { params: { type: 'string' } }, usage);
  if (positionals.length < 2) {
    throw usageError(`missing <${positionals.length === 0 ? 'simId' : 'flowId'}> argument\nusage: ${usage}`);
  }
  if (positionals.length > 2) {
    throw usageError(`unexpected extra arguments: ${positionals.slice(2).join(' ')}\nusage: ${usage}`);
  }
  const [simId, flowId] = positionals;
  const params = jsonFlag<Record<string, unknown>>(flags, 'params', usage);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw usageError(`--params must be a JSON object\nusage: ${usage}`);
  }
  const result = (await ctx
    .authedClient()
    .post(`/api/simulations/${encodeURIComponent(simId)}/flows/${encodeURIComponent(flowId)}/run`, {
      ...(params !== undefined ? { params } : {}),
    })) as {
    flowId: string;
    run: FlowRun | null;
  };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  const run = result.run;
  if (!run) {
    ctx.out.line(`flow ${result.flowId} triggered (no run recorded)`);
    return;
  }
  ctx.out.line(`run ${run.id}: ${run.status} — ${run.summary}`);
  if (run.inputs !== undefined && Object.keys(run.inputs).length > 0) {
    ctx.out.line(`  inputs: ${JSON.stringify(run.inputs)}`);
  }
  for (const [nodeId, nodeResult] of Object.entries(run.nodeResults ?? {})) {
    ctx.out.line(`  ${nodeId}: ${JSON.stringify(nodeResult)}`);
  }
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  // resolves false when aborted
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function watchSim(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { interval: { type: 'string' }, 'min-delta': { type: 'string' }, 'all-changes': { type: 'boolean' } },
    USAGE_WATCH,
  );
  const id = requirePositional(positionals, 'simId', USAGE_WATCH);
  const interval = numberFlag(flags, 'interval', USAGE_WATCH) ?? 2000;
  if (interval < 100) throw usageError(`--interval must be >= 100 ms\nusage: ${USAGE_WATCH}`);
  const minDelta = numberFlag(flags, 'min-delta', USAGE_WATCH);
  if (minDelta !== undefined && minDelta < 0) {
    throw usageError(`--min-delta must be >= 0\nusage: ${USAGE_WATCH}`);
  }
  const allChanges = flags['all-changes'] === true;

  let previous = await snapshot(ctx, id); // 404 → exit 4 via client mapping
  ctx.out.info(
    `watching ${id} (${previous.scenarioName}) every ${interval}ms — Ctrl+C to stop` +
      // T73 (R8, u3-F2): name the noise policy where the stream starts —
      // float dust below the display precision is suppressed by default.
      (allChanges
        ? ' (all raw changes shown — jitter suppression OFF)'
        : ' — same-value jitter is suppressed (changes that render as the SAME 2-decimal value do not emit; --all-changes to disable)') +
      // T125 (R17-u3): surface the volume knob at startup — the watch help
      // documents --min-delta, but a user staring at a chatty stream needs
      // the remedy named WHERE the noise is, not back in --help.
      (minDelta === undefined && !allChanges
        ? '. 提示：输出过密时可加 --min-delta <n> 只看更大变化 (tip: pass --min-delta <n> to show only larger changes)'
        : ''),
  );
  emitWatch(ctx, { kind: 'state', simTimeSec: previous.simTimeSec, state: previous.state });
  let seenDecisions = previous.recentDecisions.length;

  for (;;) {
    const ok = await sleep(interval, ctx.signal);
    if (!ok) break;
    let current: Snapshot;
    try {
      current = await snapshot(ctx, id);
    } catch (error) {
      // A deleted simulation ends the stream; transient errors are reported.
      if (error instanceof CliError && error.exitCode === EXIT.NOT_FOUND) throw error;
      ctx.out.warn(`watch: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (current.state !== previous.state) {
      emitWatch(ctx, { kind: 'state', simTimeSec: current.simTimeSec, state: current.state, was: previous.state });
    }
    const prevZones = new Map(previous.zones.map(zone => [zone.id, zone.parameters]));
    for (const zone of current.zones) {
      const before = prevZones.get(zone.id) ?? {};
      for (const [param, value] of Object.entries(zone.parameters)) {
        const old = before[param];
        // T73 (R8, u3-F2): change detection at the RENDERED precision with a
        // hysteresis band — raw float inequality fired on 1e-65 dust and
        // drowned real events (47-81% of zone rows rendered as equal values).
        const verdict = judgeZoneChange(old, value, param, { allChanges, minDelta });
        if (verdict.emit) {
          emitWatch(ctx, {
            kind: 'zone',
            simTimeSec: current.simTimeSec,
            zone: zone.id,
            parameter: param,
            from: old,
            to: value,
            ...(verdict.delta !== undefined ? { delta: verdict.delta } : {}),
          });
        }
      }
    }
    const fresh = current.recentDecisions.slice(seenDecisions);
    for (const decision of fresh) {
      emitWatch(ctx, {
        kind: 'decision',
        simTimeSec: current.simTimeSec,
        agent: decision.agentId,
        event: decision.eventType,
        decision: decision.decision,
        source: decision.decisionSource,
      });
    }
    seenDecisions = current.recentDecisions.length;
    previous = current;
  }
  ctx.out.info('watch stopped');
}

type WatchEvent =
  | { kind: 'state'; simTimeSec: number; state: string; was?: string }
  | { kind: 'zone'; simTimeSec: number; zone: string; parameter: string; from: unknown; to: unknown; delta?: number }
  | { kind: 'decision'; simTimeSec: number; agent: string; event: string; decision: string; source: string };

/**
 * T73 (R8, u3-F2) watch change-judgment — CHANGE DETECTION AT THE RENDERED
 * PRECISION. The human face renders 2 decimals (`formatWatchValue`);
 * detection used to compare raw floats, so 1e-65 dust emitted
 * "24.71 °C → 24.71 °C" rows and real events drowned in noise.
 *
 * Rules (numbers only; non-numeric changes always emit when different):
 * - `--all-changes`: raw inequality (the old behavior, explicit opt-in);
 * - `--min-delta <n>`: emit iff |to−from| ≥ n (script-side filtering);
 * - default (T88, R11 u3-F1): suppress iff the value is UNCHANGED AT THE
 *   RENDERED precision — formatted-equal movement NEVER emits, whatever its
 *   raw delta. The old half-grid hysteresis still leaked raw deltas in
 *   0.005–0.01 as same-value rows (u3: 22 of them in 100s); a row the face
 *   renders as "x → x" is noise by definition. Boundary crossings still
 *   emit — the FROM side then renders the old grid value, so the row reads
 *   "24.71 → 24.72".
 * Pure for the render suite; `delta` rides the --json NDJSON event so
 * scripts can filter without re-parsing values.
 */
export function judgeZoneChange(
  from: unknown,
  to: unknown,
  parameter: string,
  options: { allChanges?: boolean; minDelta?: number },
): { emit: boolean; delta?: number } {
  if (from === to) return { emit: false };
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to)) {
    return { emit: true };
  }
  const delta = to - from;
  if (options.allChanges) return { emit: true, delta };
  if (options.minDelta !== undefined) {
    return Math.abs(delta) >= options.minDelta ? { emit: true, delta } : { emit: false, delta };
  }
  const formattedEqual = formatWatchValue(from, parameter) === formatWatchValue(to, parameter);
  if (formattedEqual) return { emit: false, delta };
  return { emit: true, delta };
}

/**
 * T38.2 (R3, u4-F6): human watch values carry the parameter's unit and
 * keep 1-2 decimals (PARAM_UNITS is the single unit table; --json keeps
 * raw values — NDJSON stays machine-parseable). Exported for the render
 * suite.
 */
export function formatWatchValue(value: unknown, parameter: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const unit = PARAM_UNITS[parameter];
    return `${Number(value.toFixed(2))}${unit !== undefined ? ` ${unit}` : ''}`;
  }
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : json;
}

function emitWatch(ctx: Ctx, event: WatchEvent): void {
  if (ctx.json) {
    ctx.io.stdout(JSON.stringify(event) + '\n'); // NDJSON
    return;
  }
  const t = `t=${event.simTimeSec}s`;
  switch (event.kind) {
    case 'state':
      ctx.out.line(`[${t}] state: ${event.was !== undefined ? `${event.was} → ` : ''}${event.state}`);
      break;
    case 'zone':
      ctx.out.line(
        `[${t}] ${event.zone}.${event.parameter}: ` +
        `${formatWatchValue(event.from, event.parameter)} → ${formatWatchValue(event.to, event.parameter)}`,
      );
      break;
    case 'decision':
      ctx.out.line(`[${t}] decision ${event.agent} on ${event.event}: ${event.decision} (${event.source})`);
      break;
  }
}


const USAGE_EVAL = 'eaf sim eval <simId>';

/**
 * GET /api/simulations/:id/eval-report (R40-B2): the aggregate metrics +
 * the per-agent metacognition face (calibration / boundary / trust).
 */
async function evalSim(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_EVAL);
  const id = requirePositional(positionals, 'simId', USAGE_EVAL);
  const report = (await ctx.openClient().get(
    `/api/simulations/${encodeURIComponent(id)}/eval-report`,
  )) as Record<string, unknown>;

  if (ctx.json) {
    ctx.out.data(report);
    return;
  }

  renderEvalReportHuman(report, text => ctx.out.info(text));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * R1 fix (B1-1 / P-03): the human-readable eval rendering must survive ANY
 * report shape. Older builds crashed with `TypeError: reading 'join'` when a
 * metaAgents entry lacked `capabilityBoundary` (the entry shape is still
 * evolving server-side — 7138ade5's reconcileMetaAgents), and bare property
 * reads on decisions/handshakes would crash the same way on pre-R5 servers
 * or disk-rebuilt reports. Honest-missing policy: a section the report does
 * not carry prints `—` with a one-line reason — never fabricated numbers,
 * never a crash. The `--json` face stays the raw payload.
 */
export function renderEvalReportHuman(report: unknown, line: (text: string) => void): void {
  const r = isRecord(report) ? report : {};
  const pct = (v: unknown): string =>
    typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
  const num = (v: unknown): string =>
    typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
  const csv = (v: unknown): string =>
    Array.isArray(v) && v.length > 0 ? v.map(item => String(item)).join(',') : '';

  line(
    `eval: ${String(r.scenarioId ?? r.simId ?? '—')} | source=${String(r.source ?? '—')} state=${String(r.state ?? '—')}`,
  );

  // T40f (R4, u4-P1-1): the scope line — decisions and metacognition come
  // from DIFFERENT windows and must never be read as one pool of numbers.
  // The tokens are quoted from the report's own JSON methodology (the T29
  // ruling — the human face repeats it verbatim, never a third wording);
  // the full per-metric methodology stays on --json, summarized here.
  const methodology = Array.isArray(r.methodology) ? r.methodology.map(item => String(item)) : [];
  line(
    '口径: decisions=本报告窗口；metacognition=跨仿真全历史——不同源不可相加' +
      '；行标注: [全历史]=跨仿真累计，[本窗口]=仅本报告，样本量小=评估决策<3（百分比不作证据）' +
      (methodology.length > 0 ? `（完整口径见 --json 的 methodology，共 ${methodology.length} 条）` : ''),
  );

  // R5-F05: negotiationSuccessRate excludes initiator-dedup cancels from
  // the denominator (legacy successRate keeps them); absent on pre-R5
  // servers.
  const decisions = isRecord(r.decisions)
    ? (r.decisions as { total?: number; accuracy?: number | null })
    : undefined;
  const handshakes = isRecord(r.handshakes)
    ? (r.handshakes as {
        initiated?: number;
        succeeded?: number;
        /** FEAT-04: accepted-but-unmetered handshakes (the bridge found no matching offer). */
        succeededUnmetered?: number;
        successRate?: number | null;
        cancelledByCoordinator?: number;
        negotiationSuccessRate?: number | null;
        failures?: {
          total?: number;
          byCause?: Partial<Record<
            'no-partner' | 'abandoned-before-response' | 'all-rejected' | 'timeout' | 'superseded' | 'aborted' | 'pendingAtSampling',
            number
          >>;
        };
      })
    : undefined;
  if (decisions === undefined && handshakes === undefined) {
    line('decisions/handshakes: — (this report carries no metrics data)');
  } else {
    const d = decisions
      ? `decisions: ${num(decisions.total)} (accuracy ${pct(decisions.accuracy)})`
      : 'decisions: — (no decisions data in this report)';
    const h = handshakes
      ? `handshakes: ${num(handshakes.initiated)} (${pct(handshakes.successRate)})` +
        (handshakes.negotiationSuccessRate !== undefined
          ? ` | negotiation: ${pct(handshakes.negotiationSuccessRate)} (dedup-cancelled ${num(handshakes.cancelledByCoordinator)})`
          : '')
      : 'handshakes: — (no handshakes data in this report)';
    line(`${d} | ${h}`);
    // FEAT-04: accepted-but-unmetered handshakes are SPOKEN — the --json
    // face carries succeededUnmetered and the empty agreement ledger
    // otherwise contradicts the success count (R102).
    const unmetered = handshakes?.succeededUnmetered ?? 0;
    if (unmetered > 0) {
      line(
        `  接受未落账: succeededUnmetered ${unmetered} 次——握手被接受但应答方无匹配服务报价，` +
          'bridge 未落临时合约（agreements/台账为空属预期；发起方通知同形态标 accepted-unmetered）。',
      );
    }
    // T134 (R20-F, u1-F1): the abandoned-dominant attribution line — fires
    // only when abandoned-before-response is strictly the TOP failure cause.
    // The wording states the established load shape (partner answers landing
    // slower than the initiator's window under a shared, concurrency-capped
    // LLM request queue at high world rates) and never claims partners were
    // unwilling — the collaboration-response records prove they answered.
    // Same attribution the --json methodology line carries (R102).
    const byCause = handshakes?.failures?.byCause;
    const failuresTotal = handshakes?.failures?.total;
    if (byCause !== undefined && typeof failuresTotal === 'number' && failuresTotal > 0) {
      const abandoned = byCause['abandoned-before-response'] ?? 0;
      const maxOther = Math.max(
        byCause['no-partner'] ?? 0,
        byCause['all-rejected'] ?? 0,
        byCause['timeout'] ?? 0,
        byCause['superseded'] ?? 0,
        byCause['aborted'] ?? 0,
        byCause['pendingAtSampling'] ?? 0,
      );
      if (abandoned > 0 && abandoned > maxOther) {
        line(
          `  归因: abandoned-before-response 主导（${abandoned}/${failuresTotal} 次失败）= 伙伴应答落地慢于发起方窗口收口` +
            `（采样/收口时握手仍未结论——非伙伴无意愿，其应答落账可证）：高倍速（名义倍率 ≥ ` +
            'EAF_AC_RESPONSE_FLOOR_MIN_RATE，默认 ×60）下应答侧每事件握手评估与全 runtime 共用并发受限的 ' +
            'LLM 请求队列（LLM_MAX_CONCURRENT，默认 3），事件洪峰下排队积压是已知负载形态；' +
            '运维缓释可用 EAF_AC_HANDSHAKE_FAST_LANE=1（默认关，开启只改队列准入、基线语义不变）。',
        );
      }
      // BUG-07: the two explained buckets are SPOKEN when nonzero — a
      // window-open handshake is undecided (not a failure to act on), and a
      // runtime-teardown cancel is an explained death (not a silent one).
      const pending = byCause['pendingAtSampling'] ?? 0;
      if (pending > 0) {
        line(
          `  归因: pendingAtSampling ${pending} 次——采样时握手窗（基础 120s，高倍速下限只会延长）尚未闭合，` +
            '属未决而非消亡，下轮采样重判（判定口径见 --json methodology）。',
        );
      }
      const aborted = byCause['aborted'] ?? 0;
      if (aborted > 0) {
        line(
          `  归因: aborted ${aborted} 次——握手随 runtime 重建/停止被显式取消` +
            '（ac-cancelled outcome=aborted，reason 注明 runtime-rebuild / runtime-stopped），非协商失败。',
        );
      }
    }
  }

  // T19 (R2, u4-F6): the execution-face and coverage accounts — the --json
  // face carried effectChecks/recordKinds while human printed nothing about
  // them (an R102 output-discipline violation: human ≥ json).
  // T71 (R8, u1-F3): counts are integer events — the partial bucket rides
  // its own field and is SPOKEN, never a 0.5 leaking into ok/failed.
  const effectChecks = isRecord(r.effectChecks)
    ? (r.effectChecks as {
        attempts?: number;
        successes?: number;
        partial?: number;
        failures?: number;
        passRate?: number | null;
        /** UX-02: the failures drill-down (byKind/byCause + locatable traces). */
        failureBreakdown?: {
          byKind?: Record<string, number>;
          byCause?: Record<string, number>;
          records?: Array<Record<string, unknown>>;
        };
      })
    : undefined;
  if (effectChecks !== undefined) {
    const partial = typeof effectChecks.partial === 'number' ? effectChecks.partial : 0;
    line(
      `effectChecks: ${num(effectChecks.attempts)} attempts → ${num(effectChecks.successes)} ok, ` +
        `${num(effectChecks.failures)} failed` +
        (partial > 0 ? `, ${num(partial)} partial（单列，不计入 ok）` : '') +
        ` (pass ${pct(effectChecks.passRate)})`,
    );
    // UX-02: the failure drill-down — human ≥ --json (R102): the kind split,
    // the top causes, and the first locatable traces (the full list stays on
    // --json's failureBreakdown.records).
    const breakdown = effectChecks.failureBreakdown;
    if (breakdown !== undefined && typeof effectChecks.failures === 'number' && effectChecks.failures > 0) {
      const kindText = Object.entries(breakdown.byKind ?? {})
        .filter(([, count]) => typeof count === 'number' && count > 0)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(' · ');
      if (kindText !== '') line(`  失败下钻: ${kindText}`);
      const causes = Object.entries(breakdown.byCause ?? {})
        .filter(([, count]) => typeof count === 'number' && count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3);
      for (const [cause, count] of causes) {
        line(`    原因 ×${count}: ${cause}`);
      }
      for (const record of (breakdown.records ?? []).slice(0, 3)) {
        const tag = String(record.kind ?? '?');
        const where = `${String(record.eventId ?? '—')}/${String(record.agentId ?? '—')}`;
        const what = record.kind === 'device-execution'
          ? `${String(record.deviceId ?? '?')} ${String(record.command ?? '?')}`
          : String(record.decision ?? '?');
        line(`    · [${tag}] ${where} ${what}`);
      }
      const total = (breakdown.records ?? []).length;
      if (total > 3) line(`    … 共 ${total} 条失败痕迹（完整列表见 --json 的 effectChecks.failureBreakdown.records）`);
    }
  } else {
    line('effectChecks: — (no effect-check data in this report)');
  }
  const recordKinds = isRecord(r.recordKinds) ? (r.recordKinds as Record<string, number>) : undefined;
  if (recordKinds !== undefined) {
    const entries = Object.entries(recordKinds)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count))
      .sort((a, b) => (b[1] as number) - (a[1] as number) || a[0].localeCompare(b[0]));
    line(
      entries.length > 0
        ? `recordKinds: ${entries.map(([kind, count]) => `${kind} ${count}`).join(', ')}`
        : 'recordKinds: — (the trajectory carried no records)',
    );
  } else {
    line('recordKinds: — (no trajectory coverage data in this report)');
  }

  const metaAgents = Array.isArray(r.metaAgents) ? r.metaAgents : [];
  if (metaAgents.length > 0) {
    line('metacognition (per agent):');
    for (const entry of metaAgents) {
      const agent = isRecord(entry) ? entry : {};
      // Per-entry boundary/trust fields may be absent (reconciled registry
      // rows evolve) — print an honest '—' per side instead of crashing.
      const boundary = isRecord(agent.capabilityBoundary)
        ? (agent.capabilityBoundary as { strong?: unknown[]; weak?: unknown[]; mustEscalate?: unknown[] })
        : undefined;
      // T40f (R4, u4-P1-1): every row declares its window (T29's JSON face
      // has the same markers — one vocabulary), the report-window decision
      // count rides the evaluated parens, and a small-sample rate carries
      // its caveat where the percentage it qualifies sits. Absent fields
      // (pre-T29 servers) render byte-identically to the old line.
      const windowTag =
        agent.window === 'all-history' ? ' [全历史]'
        : agent.window === 'report-window' ? ' [本窗口]'
        : '';
      // T66e (R6, u4-F11): `success 39% (13/19 evaluated)` read like "13 of
      // 19 succeeded" — the counts are the EVALUATION denominator, not the
      // success split. The parens become an explicit 评估 label; the raw
      // success count is not derivable from a rounded rate (never invented).
      const evaluated =
        `· 评估 ${num(agent.evaluatedDecisions)}/${num(agent.decisionCount)}` +
        (typeof agent.windowDecisionCount === 'number' && Number.isFinite(agent.windowDecisionCount)
          ? ` · 本窗口决策 ${agent.windowDecisionCount} 条`
          : '') +
        (agent.smallSample === true ? '（样本量小）' : '');
      line(
        `  ${String(agent.agentName ?? '—')}${windowTag}: calibration ${pct(agent.calibrationScore)} | success ${pct(agent.successRate)}` +
        ` ${evaluated}` +
        ` | strong: ${csv(boundary?.strong) || '—'} | weak: ${csv(boundary?.weak) || '—'}` +
        ` | must-escalate: ${csv(boundary?.mustEscalate) || '—'} (boundary/trust missing when '—')`,
      );
    }
  } else {
    line('metacognition: — (no live agent state; disk-rebuilt reports omit it)');
  }
}
