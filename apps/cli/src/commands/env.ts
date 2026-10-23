/**
 * `eaf env` — environment CRUD, membership, world-document export, and the
 * deployment manifest.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { boolFlag, numberFlag, parse, rejectExtraPositionals, requirePositional, requireString, stringFlag } from '../args.js';
import type { Ctx, EnvDelegation, EnvDetail, EnvGuide, EnvSummary , EnvFlowSummary } from '../ctx.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { t } from '../i18n/index.js';
import { envDetailToDocument } from '../world/export.js';
import { asksCommand } from './asks.js';
import type { ServiceEntry } from './service.js';

const USAGE_LIST = 'eaf env list [--all|--mine|--public]';
const USAGE_GET = 'eaf env get <id|name> [--full]';
const USAGE_CREATE =
  'eaf env create --name <n> [--desc <d>] [--map-type grid|geo] [--visibility public|private]\n' +
  '  eaf env create --from-template <id> --name <n> [--visibility public|private]';
const USAGE_EXPORT = 'eaf env export <id|name> [-o file] [--format yaml|json]';
const USAGE_MEMBERS = 'eaf env members <id|name>';
const USAGE_MEMBERS_ADD = 'eaf env members add <id|name> (--email <e>|--user-id <u>) --role builder|viewer';
const USAGE_MEMBERS_INVITE = 'eaf env members invite <id|name> --email <e>[,<e2>…] [--role builder|viewer]';
const USAGE_MEMBERS_SET_ROLE = 'eaf env members set-role <id|name> <userId> --role builder|viewer';
const USAGE_MEMBERS_REMOVE = 'eaf env members remove <id|name> <userId>';
const USAGE_DELEGATES = 'eaf env delegates <id|name>';
const USAGE_DELEGATES_GRANT =
  'eaf env delegates grant <id|name> (--email <e>|--user-id <u>) [--zones z1,z2|--all-zones]';
const USAGE_DELEGATES_REVOKE = 'eaf env delegates revoke <id|name> <userId>';
const USAGE_PROPOSALS = 'eaf env proposals <id|name> [--status <status>]';
const USAGE_PROPOSAL_DECIDE =
  'eaf env proposals decide <proposalId> (--approve|--reject) [--reason <text>]';
const USAGE_PROPOSAL_REMIND = 'eaf env proposals remind <proposalId>';
const USAGE_PROPOSAL_REVERT = 'eaf env proposals revert <proposalId>';
const USAGE_DEPLOYMENT = 'eaf env deployment <id|name>';
const USAGE_GUIDE = 'eaf env guide <id|name>';
const USAGE_SET_GUIDE =
  'eaf env set-guide <id|name> [--purpose <t>] [--zone-guide <t>] [--service-map <t>] ' +
  '[--role-builder <t>] [--role-viewer <t>] | -f <guide.json> | --clear';
const USAGE_ACTIVITY =
  'eaf env activity <id|name> [--limit <n>] [--before <iso>] [--kind <command|proposal|agreement|event|flow>] [--actor <substr>]';
const USAGE_TRAINING_EXPORT =
  'eaf env training-export <id|name> [--sim <id>] [--from <iso>] [--to <iso>] [--format sft|dpo|structured] [-o out.jsonl]';
const USAGE_EVAL_RUN = 'eaf env eval-run <id|name> -f runs.yaml [--no-wait] [--interval <ms>]';
const USAGE_EVAL_RUN_STATUS = 'eaf env eval-run status <jobId>';
const USAGE_SESSION_STATUS = 'eaf env session status <id|name>';
const USAGE_SET_DEFAULT_SIM = 'eaf env set-default-sim <id|name> <simId|--clear>';
const USAGE_SET_OCCUPANT_SCHEDULE =
  'eaf env set-occupant-schedule <id|name> <zoneId> --count <n> --start <sec> --end <sec> [--one-shot]\n' +
  '  eaf env set-occupant-schedule <id|name> <zoneId> --clear\n' +
  '  eaf env set-occupant-schedule <id|name> <zoneId> --overlay \'{"schedule":{"count":40,"startSimTimeSec":21600,"endSimTimeSec":86400},"startsAtSimSec":86400,"endsAtSimSec":691200}\'\n' +
  '  eaf env set-occupant-schedule <id|name> <zoneId> --clear-overlay';

export async function envCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listEnvs(ctx, argv);
    case 'get':
      return getEnv(ctx, argv);
    case 'create':
      return createEnv(ctx, argv);
    case 'delete':
      return deleteEnv(ctx, argv);
    case 'join':
    case 'leave':
      return joinLeave(ctx, sub, argv);
    case 'members':
      return membersCommand(ctx, argv);
    case 'delegates':
      return delegatesCommand(ctx, argv);
    case 'proposals':
      return proposalsCommand(ctx, argv);
    case 'session':
      return sessionCommand(ctx, argv);
    case 'export':
      return exportEnv(ctx, argv);
    case 'deployment':
      return deployment(ctx, argv);
    case 'guide':
      return showGuide(ctx, argv);
    case 'set-guide':
      return setGuide(ctx, argv);
    case 'set-default-sim':
      return setDefaultSim(ctx, argv);
    case 'set-occupant-schedule':
      return setOccupantSchedule(ctx, argv);
    case 'activity':
      return activity(ctx, argv);
    case 'training-export':
      return trainingExport(ctx, argv);
    case 'eval-run':
      return evalRun(ctx, argv);
    case 'asks':
      return asksCommand(ctx, argv[0], argv.slice(1));
    default:
      throw usageError(`unknown env subcommand "${sub ?? ''}" (expected list|get|create|delete|join|leave|members|delegates|proposals|session|export|deployment|guide|set-guide|set-default-sim|set-occupant-schedule|activity|training-export|eval-run|asks)`);
  }
}

/**
 * T122 (R17-u3 / R19-u4): `eaf env set-default-sim <id|name> <simId|--clear>`
 * — the owner binds one simulation of the env as the DEFAULT world for the
 * ask/what-if/read default lanes (shared multi-sim environments stop hitting
 * AMBIGUOUS on every call). `--clear` removes the binding. Honesty: the
 * binding is honored only while the bound sim is RUNNING — a stopped/deleted
 * sim makes it inert and the lanes disclose the fall-back.
 */
async function setDefaultSim(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { clear: { type: 'boolean' } }, USAGE_SET_DEFAULT_SIM);
  // T126 (R20-u1 F1): the documented shape carries TWO positionals —
  // `<id|name> <simId>` — but `requirePositional` enforces exactly ONE, so
  // every binding write was rejected as "unexpected extra arguments:
  // <simId>" and only `--clear` parsed (the write lane was dead on arrival;
  // REST PATCH was fine). Validate the 1-or-2 positional shape here.
  if (positionals.length < 1) {
    throw usageError(`missing <id|name> argument\nusage: ${USAGE_SET_DEFAULT_SIM}`);
  }
  if (positionals.length > 2) {
    throw usageError(
      `unexpected extra arguments: ${positionals.slice(2).join(' ')}\nusage: ${USAGE_SET_DEFAULT_SIM}`,
    );
  }
  const ref = positionals[0]!;
  const simId = positionals[1];
  const clear = boolFlag(flags, 'clear');
  if (!clear && (simId === undefined || simId.length === 0)) {
    throw usageError(`expected a simulation id or --clear\nusage: ${USAGE_SET_DEFAULT_SIM}`);
  }
  if (!clear && simId !== undefined && simId.startsWith('--')) {
    throw usageError(`unknown flag: ${simId}\nusage: ${USAGE_SET_DEFAULT_SIM}`);
  }
  const detail = await ctx.resolveEnv(ref);
  const updated = (await ctx.authedClient().patch(
    `/api/environments/${encodeURIComponent(detail.id)}`,
    { defaultSimulationId: clear ? null : simId },
  )) as EnvDetail;
  if (ctx.json) {
    ctx.out.data({ defaultSimulationId: updated.defaultSimulationId ?? null });
    return;
  }
  if (clear) {
    ctx.out.line(t(ctx.lang, 'env.defaultSim.cleared', { name: detail.name, envId: detail.id }));
  } else {
    ctx.out.line(
      t(ctx.lang, 'env.defaultSim.set', {
        name: detail.name,
        envId: detail.id,
        simId: updated.defaultSimulationId ?? simId ?? '',
      }),
    );
  }
}

/**
 * FEAT-07: `eaf env set-occupant-schedule` — the owner installs/replaces a
 * zone's occupantSchedule at runtime (no environment rebuild), or `--clear`
 * drops the timetable (the standing headcount is untouched). The server
 * response's `appliedRuntimes` is surfaced verbatim — 0 is an honest "no
 * live session, stored for the next materialize", not a failure.
 *
 * FEAT-07 phase-2 (calendar overlay): `--overlay '<json>'` installs a
 * TEMPORARY timetable `{schedule, startsAtSimSec, endsAtSimSec}` replacing
 * the base schedule inside that absolute sim-time window (the base governs
 * again at the window end); `--clear-overlay` drops it (the base timetable
 * takes over immediately). Combinable with the base-schedule flags.
 */
export interface OccupantSchedulePatchResult {
  envId: string;
  zoneId: string;
  occupantSchedule: {
    count: number;
    startSimTimeSec: number;
    endSimTimeSec: number;
    repeatDaily?: boolean;
  } | null;
  /** FEAT-07 phase-2: the zone's resulting calendar overlay (null = none). */
  occupantScheduleOverlay?: {
    schedule: {
      count: number;
      startSimTimeSec: number;
      endSimTimeSec: number;
      repeatDaily?: boolean;
    };
    startsAtSimSec: number;
    endsAtSimSec: number;
  } | null;
  cleared: boolean;
  /** FEAT-07 phase-2: true when this call cleared the overlay. */
  overlayCleared?: boolean;
  appliedRuntimes: number;
}

/** The human face (pure — the render-contract walk drives it with fixtures). */
export function renderOccupantScheduleLines(payload: OccupantSchedulePatchResult): string[] {
  const liveNote = payload.appliedRuntimes > 0
    ? `applied to ${payload.appliedRuntimes} live runtime(s) — no environment rebuild`
    : 'no live world session — stored; takes effect when the world next materializes';
  const lines: string[] = [];
  if (payload.cleared || (payload.occupantSchedule === null && payload.occupantScheduleOverlay === undefined)) {
    // Phase-1 face: a cleared (or entirely absent) base timetable.
    lines.push(`zone ${payload.zoneId}: occupant schedule cleared (current headcount untouched)`);
  } else if (payload.occupantSchedule !== null) {
    const schedule = payload.occupantSchedule;
    lines.push(
      `zone ${payload.zoneId}: occupant schedule set — ${schedule.count} people ` +
        `${schedule.startSimTimeSec}s → ${schedule.endSimTimeSec}s` +
        `${schedule.repeatDaily === false ? ' (one-shot)' : ' (daily)'}`,
    );
  } else {
    // Overlay-only patch on a zone without a base timetable.
    lines.push(`zone ${payload.zoneId}: no base occupant schedule (unchanged)`);
  }
  // FEAT-07 phase-2: the overlay line carries exactly what --json carries.
  if (payload.overlayCleared === true) {
    lines.push('  overlay cleared — the base schedule governs again immediately');
  } else if (payload.occupantScheduleOverlay !== undefined && payload.occupantScheduleOverlay !== null) {
    const overlay = payload.occupantScheduleOverlay;
    lines.push(
      `  overlay — ${overlay.schedule.count} people ` +
        `${overlay.schedule.startSimTimeSec}s → ${overlay.schedule.endSimTimeSec}s` +
        `${overlay.schedule.repeatDaily === false ? ' (one-shot)' : ' (daily)'}` +
        `, window [${overlay.startsAtSimSec}s, ${overlay.endsAtSimSec}s)`,
    );
  }
  lines.push(`  ${liveNote}`);
  return lines;
}

async function setOccupantSchedule(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, {
    count: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    'one-shot': { type: 'boolean' },
    clear: { type: 'boolean' },
    overlay: { type: 'string' },
    'clear-overlay': { type: 'boolean' },
  }, USAGE_SET_OCCUPANT_SCHEDULE);
  // Same 1-or-2 positional shape as set-default-sim (<id|name> <zoneId>).
  if (positionals.length < 2) {
    throw usageError(`missing <id|name> and/or <zoneId> arguments\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`);
  }
  if (positionals.length > 2) {
    throw usageError(
      `unexpected extra arguments: ${positionals.slice(2).join(' ')}\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`,
    );
  }
  const ref = positionals[0]!;
  const zoneId = positionals[1]!;
  const clear = boolFlag(flags, 'clear');
  const clearOverlay = boolFlag(flags, 'clear-overlay');
  const overlayRaw = flags.overlay as string | undefined;
  if (clearOverlay && overlayRaw !== undefined) {
    throw usageError(`--clear-overlay cannot be combined with --overlay\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`);
  }
  let schedule: OccupantSchedulePatchResult['occupantSchedule'] | undefined;
  if (clear) {
    if (flags.count !== undefined || flags.start !== undefined || flags.end !== undefined || boolFlag(flags, 'one-shot')) {
      throw usageError(`--clear cannot be combined with --count/--start/--end/--one-shot\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`);
    }
    schedule = null;
  } else if (flags.count !== undefined || flags.start !== undefined || flags.end !== undefined) {
    const count = numberFlag(flags, 'count', USAGE_SET_OCCUPANT_SCHEDULE);
    const startSimTimeSec = numberFlag(flags, 'start', USAGE_SET_OCCUPANT_SCHEDULE);
    const endSimTimeSec = numberFlag(flags, 'end', USAGE_SET_OCCUPANT_SCHEDULE);
    if (count === undefined || startSimTimeSec === undefined || endSimTimeSec === undefined) {
      throw usageError(
        `--count, --start and --end are required together (or use --clear)\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`,
      );
    }
    schedule = {
      count,
      startSimTimeSec,
      endSimTimeSec,
      ...(boolFlag(flags, 'one-shot') ? { repeatDaily: false } : {}),
    };
  }
  // FEAT-07 phase-2: the calendar overlay — a JSON literal (the server
  // validates the ranges authoritatively; the CLI teaches the shape).
  let overlay: OccupantSchedulePatchResult['occupantScheduleOverlay'] | undefined;
  if (clearOverlay) {
    overlay = null;
  } else if (overlayRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(overlayRaw);
    } catch {
      throw usageError(
        `--overlay must be a JSON object {"schedule":{"count":<n>,"startSimTimeSec":<sec>,"endSimTimeSec":<sec>,"repeatDaily"?},` +
          `"startsAtSimSec":<sec>,"endsAtSimSec":<sec>} — startsAt/endsAt are ABSOLUTE sim seconds ` +
          `(day N 08:00 = N*86400 + 28800)\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw usageError(
        `--overlay must be a JSON object {"schedule":{...},"startsAtSimSec":<sec>,"endsAtSimSec":<sec>}\n` +
          `usage: ${USAGE_SET_OCCUPANT_SCHEDULE}`,
      );
    }
    overlay = parsed as NonNullable<OccupantSchedulePatchResult['occupantScheduleOverlay']>;
  }
  if (schedule === undefined && overlay === undefined) {
    throw usageError(
      `nothing to do — give --count/--start/--end, --clear, --overlay or --clear-overlay\nusage: ${USAGE_SET_OCCUPANT_SCHEDULE}`,
    );
  }
  const detail = await ctx.resolveEnv(ref);
  const result = (await ctx.authedClient().patch(
    `/api/environments/${encodeURIComponent(detail.id)}/zones/${encodeURIComponent(zoneId)}/occupant-schedule`,
    {
      ...(schedule !== undefined ? { schedule } : {}),
      ...(overlay !== undefined ? { overlay } : {}),
    },
  )) as OccupantSchedulePatchResult;
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  for (const line of renderOccupantScheduleLines(result)) ctx.out.line(line);
}

/**
 * Living-worlds P1W: `eaf env session status` — the env's authoritative
 * world session, READ-ONLY (sessions are created on demand by the
 * world-needing lanes; this command never materializes one).
 */
async function sessionCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, {}, USAGE_SESSION_STATUS);
  if (Object.keys(flags).length > 0) {
    throw usageError(`unknown flag(s): ${Object.keys(flags).join(', ')}\nusage: ${USAGE_SESSION_STATUS}`);
  }
  const sub = positionals[0];
  if (sub !== 'status') {
    throw usageError(`unknown session subcommand "${sub ?? ''}" (expected status)\nusage: ${USAGE_SESSION_STATUS}`);
  }
  const ref = requirePositional(positionals.slice(1), 'id|name', USAGE_SESSION_STATUS);
  const detail = await ctx.resolveEnv(ref);
  if (ctx.json) {
    ctx.out.data(detail.worldSession ?? null);
    return;
  }
  const session = detail.worldSession;
  if (session === undefined) {
    ctx.out.line(
      'no world session yet — one materializes on demand (a data read/stream without an explicit ' +
      'simulationId, an agreement activation carrying terms.read.minFreshnessSec, or a world-changing proposal apply)',
    );
    return;
  }
  ctx.out.table(
    [{
      status: session.status,
      // T82 (R9, u3-F1): the RUNTIME state — the same word `sim list` and the
      // AGENT_AMBIGUOUS candidates speak. The session's `status` is the
      // attention lifecycle (idle = running but unobserved), which read as
      // "not running" next to the roster's running row.
      ...(session.state !== undefined ? { state: session.state } : {}),
      simTimeSec: Math.round(session.simTimeSec),
      simulationId: session.simulationId,
      // T-410 (R19): the WALL anchor — the epoch ms sim-time 0 maps to.
      // Wall-aligned scheduling ("3AM sweep") is now direct arithmetic
      // instead of a now−simTime sample with ±s error.
      ...(session.simStartEpochMs !== undefined
        ? {
            simStartEpochMs: session.simStartEpochMs,
            simStartWall: new Date(session.simStartEpochMs).toISOString(),
          }
        : {}),
      ...(session.observers !== undefined ? { observers: session.observers } : {}),
      ...(session.checkpointAtSec !== undefined
        ? { checkpointAtSec: Math.round(session.checkpointAtSec) }
        : {}),
      ...(session.hibernatedAt !== undefined ? { hibernatedAt: session.hibernatedAt } : {}),
    }],
    [
      'status',
      ...(session.state !== undefined ? ['state'] : []),
      'simTimeSec', 'simulationId',
      ...(session.simStartEpochMs !== undefined ? ['simStartEpochMs', 'simStartWall'] : []),
      ...(session.observers !== undefined ? ['observers'] : []),
      ...(session.hibernatedAt !== undefined || session.checkpointAtSec !== undefined
        ? ['checkpointAtSec', 'hibernatedAt']
        : []),
    ],
  );
  // T82 (R9, u3-F1): the two status words, explained once — without this the
  // `idle` attention word reads as a "not running" verdict that contradicts
  // the roster's running row for the same session.
  if (session.state !== undefined && session.state !== 'hibernated') {
    ctx.out.line('');
    ctx.out.line(
      `  state=${session.state} 是运行时状态（与 sim list / 消歧错误同一词表）；status=${session.status} 是会话的关注生命周期：` +
      (session.status === 'idle'
        ? 'idle = 世界在推进但当前没有观测者（打开 sim watch / 数据读取会转为 active）'
        : 'active = 有观测者钉住'),
    );
  }
  if (session.driftWarning !== undefined && session.driftWarning.length > 0) {
    ctx.out.line('');
    ctx.out.line('schema drift across the last hibernate window (resolved to current env topology):');
    for (const note of session.driftWarning) ctx.out.line(`  - ${note}`);
  }
  // T38.5 (R3, u1-F8): the dual-clock explanation — the session is the env's
  // authoritative world; private sims run their own id + clock. Without this
  // a "sim-time 270" session beside a "sim-time 110,520" private sim read as
  // a broken clock instead of two clocks.
  let runningOthers: Array<{ id: string }> = [];
  try {
    const sims = (await ctx.authedClient().get(
      `/api/simulations?environmentId=${encodeURIComponent(detail.id)}`,
    )) as { simulations: Array<{ id: string; state: string }> };
    runningOthers = sims.simulations.filter(sim => sim.state === 'running' && sim.id !== session.simulationId);
  } catch {
    // Listing unavailable — the note degrades to the session-only face.
    runningOthers = [];
  }
  ctx.out.line('');
  ctx.out.line(dualClockNote(session.simulationId, runningOthers));
}

/**
 * T38.5 (R3, u1-F8): the dual-clock note, pure for the render suite — names
 * the authoritative world, counts the OTHER running sims (the user's own
 * private copies included), and says the clocks are independent.
 */
export function dualClockNote(sessionSimulationId: string, runningOthers: ReadonlyArray<{ id: string }>): string {
  return runningOthers.length > 0
    ? `本会话是环境权威世界；另有 ${runningOthers.length} 个 sim 正在运行（含你自己启动的私有副本）——` +
      `id 与时钟各自独立（${runningOthers.map(sim => sim.id).join(', ')}）`
    : '本会话是环境权威世界——私有 sim（如有）的 id 与时钟各自独立';
}

async function listEnvs(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { mine: { type: 'boolean' }, public: { type: 'boolean' }, all: { type: 'boolean' } },
    USAGE_LIST,
  );
  rejectExtraPositionals(positionals, USAGE_LIST);
  // R15-D2: default = my environments (server default); --all adds the
  // public catalog; --public = all then filtered; --mine is a no-op alias.
  let envs = await ctx.listEnvs(boolFlag(flags, 'all') || boolFlag(flags, 'public') ? 'all' : 'mine');
  if (boolFlag(flags, 'mine')) envs = envs.filter(env => env.myRole !== null);
  if (boolFlag(flags, 'public')) envs = envs.filter(env => env.visibility === 'public');
  if (ctx.json) {
    ctx.out.data(envs);
    return;
  }
  ctx.out.table(
    envs.map(env => ({
      id: env.id,
      name: env.name,
      map: env.mapType,
      vis: env.visibility,
      role: env.myRole ?? '-',
      zn: env.counts.zones,
      dev: env.counts.devices,
      agt: env.counts.agents,
      svc: env.counts.services,
      owner: env.owner.displayName,
    })),
    ['id', 'name', 'map', 'vis', 'role', 'zn', 'dev', 'agt', 'svc', 'owner'],
  );
}

async function getEnv(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { full: { type: 'boolean' } }, USAGE_GET);
  const ref = requirePositional(positionals, 'id|name', USAGE_GET);
  const detail = await ctx.resolveEnv(ref);
  if (ctx.json) {
    ctx.out.data(detail);
    return;
  }
  printEnvSummary(ctx, detail);
  if (boolFlag(flags, 'full')) {
    ctx.out.line('');
    ctx.out.line(`zones (${detail.zones.length}):`);
    ctx.out.table(
      detail.zones.map(zone => ({
        id: zone.id,
        name: zone.name ?? '-',
        type: zone.type ?? '-',
        consent: zone.consentClass ?? 'standard',
        shape: zone.bounds
          ? `${zone.bounds.minX},${zone.bounds.minY} → ${zone.bounds.maxX},${zone.bounds.maxY}`
          : zone.polygon
            ? `polygon(${zone.polygon.length} pts)`
            : '-',
      })),
      ['id', 'name', 'type', 'consent', 'shape'],
    );
    ctx.out.line('');
    ctx.out.line(`devices (${detail.devices.length}):`);
    ctx.out.table(
      detail.devices.map(device => ({
        id: device.id,
        name: device.name,
        type: device.type,
        brand: device.brand ?? '-',
        zone: device.zoneId,
        commands: device.commands?.join(',') ?? '-',
      })),
      ['id', 'name', 'type', 'brand', 'zone', 'commands'],
    );
    ctx.out.line('');
    ctx.out.line(`agents (${detail.agents.length}):`);
    ctx.out.table(
      detail.agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        zones: agent.managedZoneIds.length,
        devices: agent.boundDeviceIds.length,
        llm: agent.llm ? String(agent.llm.provider ?? 'set') : '-',
      })),
      ['id', 'name', 'zones', 'devices', 'llm'],
    );
    ctx.out.line('');
    ctx.out.line(`members (${detail.members.length}):`);
    ctx.out.table(
      detail.members.map(member => ({ user: member.displayName, role: member.role, id: member.userId ?? '-' })),
      ['user', 'role', 'id'],
    );
    if (detail.events.length > 0) {
      ctx.out.line('');
      ctx.out.line(`events (${detail.events.length}):`);
      ctx.out.table(
        detail.events.map(event => ({
          id: event.id,
          type: event.type,
          zone: event.zoneId,
          at: event.atSimTimeSec !== undefined ? `${event.atSimTimeSec}s` : '-',
          severity: event.severity ?? '-',
        })),
        ['id', 'type', 'zone', 'at', 'severity'],
      );
    }
  }
}

function printEnvSummary(ctx: Ctx, detail: EnvDetail): void {
  ctx.out.line(`${detail.name} (${detail.id})`);
  ctx.out.line(
    `  map=${detail.mapType} visibility=${detail.visibility} owner=${detail.owner.displayName} role=${detail.myRole ?? '-'}`,
  );
  if (detail.description) ctx.out.line(`  ${detail.description}`);
  if (detail.viewerNotice) ctx.out.line(`  ${detail.viewerNotice}`);
  if (detail.guide) ctx.out.line(`  ${t(ctx.lang, 'env.guide.set')}`);
  // T122 (R17-u3/R19-u4): the default-simulation binding — visible on the
  // face that owns it, with its honest boundary (running-only).
  if (detail.defaultSimulationId) {
    ctx.out.line(`  ${t(ctx.lang, 'env.defaultSim.face', { simId: detail.defaultSimulationId })}`);
  }
  ctx.out.line(
    `  zones=${detail.zones.length} devices=${detail.devices.length} agents=${detail.agents.length} members=${detail.members.length} events=${detail.events.length} (use --full to list them)`,
  );
  // T-058a (design-consent-semantics.md §3.3): the gated mechanism is
  // visible BEFORE anyone relies on it — supervised zones always escalate
  // to the owner; AI review advises there but never auto-applies.
  const supervised = detail.governance?.supervisedZones ?? [];
  if (supervised.length > 0) {
    ctx.out.line(
      `  supervised zones: ${supervised.map(zone => zone.zoneId).join(', ')} — proposals touching them require the owner's explicit consent (AI review advises only)`,
    );
  }
  // T-072 (D-1 decide half): who besides the owner may decide zone-claims.
  const delegations = detail.governance?.decisionDelegations ?? [];
  if (delegations.length > 0) {
    for (const delegation of delegations) {
      ctx.out.line(
        `  zone-claim decisions delegated to: ${delegation.delegate.displayName} (${zonesWord(delegation.zones)}) — eaf env delegates`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// guide / activity — Fix-19 latecomer onboarding
// ---------------------------------------------------------------------------

/** Print the guide fields that are set, one per line. */
function printGuide(ctx: Ctx, guide: EnvGuide): void {
  if (guide.purpose) ctx.out.line(`purpose: ${guide.purpose}`);
  if (guide.zoneGuide) ctx.out.line(`zoneGuide: ${guide.zoneGuide}`);
  if (guide.roleGuide?.builder) ctx.out.line(`roleGuide.builder: ${guide.roleGuide.builder}`);
  if (guide.roleGuide?.viewer) ctx.out.line(`roleGuide.viewer: ${guide.roleGuide.viewer}`);
  if (guide.serviceMap) ctx.out.line(`serviceMap: ${guide.serviceMap}`);
}

async function showGuide(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GUIDE);
  const ref = requirePositional(positionals, 'id|name', USAGE_GUIDE);
  const detail = await ctx.resolveEnv(ref);
  if (ctx.json) {
    ctx.out.data(detail.guide ?? null);
    return;
  }
  if (!detail.guide) {
    ctx.out.line(t(ctx.lang, 'env.guide.unset', { name: detail.name }));
  } else {
    printGuide(ctx, detail.guide);
  }
  await printServiceCheatsheet(ctx, detail.id);
}

/**
 * Wave-1a (小新 R8 "serviceMap 不给服务 id"): the guide's serviceMap stays
 * free text — the 速查段 is GENERATED from the live service list, so the
 * names/ids it prints never drift from the world. Signable offers only (the
 * ones `agreement propose` takes), with the id it needs.
 *
 * T-208 honesty: derived offers default to members visibility, so filtering
 * to `public` alone would hide every derived row from the very members the
 * quick-look serves. The server list already applies the CALLER's visibility
 * boundary — anything it returns is visible to this user — so the client
 * keeps only the signable tiers (public + members) and leaves `hidden`
 * (the owner's own non-offers) out.
 */
async function printServiceCheatsheet(ctx: Ctx, envId: string): Promise<void> {
  const body = (await ctx
    .openClient()
    .get(`/api/environments/${encodeURIComponent(envId)}/services`)) as { services: ServiceEntry[] };
  const signableServices = body.services.filter(service => service.visibility !== 'hidden');
  if (signableServices.length === 0) return;
  ctx.out.line('');
  ctx.out.line(t(ctx.lang, 'env.serviceMap.header'));
  ctx.out.table(
    signableServices.map(service => ({
      name: service.name,
      id: service.id,
      provider: service.provider.name,
    })),
    ['name', 'id', 'provider'],
  );
}

async function setGuide(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      purpose: { type: 'string' },
      'zone-guide': { type: 'string' },
      'service-map': { type: 'string' },
      'role-builder': { type: 'string' },
      'role-viewer': { type: 'string' },
      file: { type: 'string', short: 'f' },
      clear: { type: 'boolean' },
    },
    USAGE_SET_GUIDE,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_SET_GUIDE);
  const detail = await ctx.resolveEnv(ref);

  let guide: EnvGuide | null;
  if (boolFlag(flags, 'clear')) {
    guide = null;
  } else {
    const file = stringFlag(flags, 'file');
    if (file !== undefined) {
      guide = JSON.parse(readFileSync(resolve(ctx.io.cwd, file), 'utf8')) as EnvGuide;
    } else {
      const built: EnvGuide = {};
      const purpose = stringFlag(flags, 'purpose');
      const zoneGuide = stringFlag(flags, 'zone-guide');
      const serviceMap = stringFlag(flags, 'service-map');
      const roleBuilder = stringFlag(flags, 'role-builder');
      const roleViewer = stringFlag(flags, 'role-viewer');
      if (purpose !== undefined) built.purpose = purpose;
      if (zoneGuide !== undefined) built.zoneGuide = zoneGuide;
      if (serviceMap !== undefined) built.serviceMap = serviceMap;
      if (roleBuilder !== undefined || roleViewer !== undefined) {
        built.roleGuide = {
          ...(roleBuilder !== undefined ? { builder: roleBuilder } : {}),
          ...(roleViewer !== undefined ? { viewer: roleViewer } : {}),
        };
      }
      if (Object.keys(built).length === 0) {
        throw usageError(`nothing to set — pass at least one flag, -f <file>, or --clear\nusage: ${USAGE_SET_GUIDE}`);
      }
      guide = built;
    }
  }

  const updated = (await ctx.authedClient().patch(
    `/api/environments/${encodeURIComponent(detail.id)}`,
    { guide },
  )) as EnvDetail;
  if (ctx.json) {
    ctx.out.data(updated.guide ?? null);
  } else if (guide === null) {
    ctx.out.line(`cleared the guide of "${detail.name}" (${detail.id})`);
  } else {
    ctx.out.line(`updated the guide of "${detail.name}" (${detail.id})`);
  }
}

export interface EnvActivityEntry {
  time: string;
  actor: { id: string; displayName: string } | null;
  kind: 'command' | 'proposal' | 'agreement' | 'event' | 'flow';
  action: string;
  summary: string;
  objectType: string;
  objectId: string;
}

/**
 * T94 (R14, u4-P1): the env activity human face as a PURE function
 * (fixture-testable — the walker face ran with empty anchors, so a
 * header-only human render could not go red). ONE row per feed entry, feed
 * order preserved (newest first); the columns double as the header row.
 */
export const ENV_ACTIVITY_COLUMNS = ['time', 'actor', 'kind', 'action', 'summary'] as const;

export function envActivityRowsOf(
  entries: ReadonlyArray<EnvActivityEntry>,
): Array<{ time: string; actor: string; kind: string; action: string; summary: string }> {
  return entries.map(entry => ({
    time: entry.time,
    actor: entry.actor?.displayName ?? '-',
    kind: entry.kind,
    action: entry.action,
    summary: entry.summary,
  }));
}

async function activity(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { limit: { type: 'string' }, before: { type: 'string' }, kind: { type: 'string' }, actor: { type: 'string' } },
    USAGE_ACTIVITY,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_ACTIVITY);
  const detail = await ctx.resolveEnv(ref);
  const params = new URLSearchParams();
  const limit = stringFlag(flags, 'limit');
  const before = stringFlag(flags, 'before');
  const kind = stringFlag(flags, 'kind');
  const actor = stringFlag(flags, 'actor');
  if (limit !== undefined) params.set('limit', limit);
  if (before !== undefined) params.set('before', before);
  // T33 (R3 u4-F10): signal filters — cut the engine noise, find a person.
  if (kind !== undefined) params.set('kind', kind);
  if (actor !== undefined) params.set('actor', actor);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const body = (await ctx.openClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/activity${query}`,
  )) as { entries: EnvActivityEntry[] };
  if (ctx.json) {
    ctx.out.data(body.entries);
    return;
  }
  if (body.entries.length === 0) {
    ctx.out.line(t(ctx.lang, 'env.activity.empty', { name: detail.name }));
    return;
  }
  ctx.out.table(envActivityRowsOf(body.entries), [...ENV_ACTIVITY_COLUMNS]);
  // T94 (R14, u4-P1): the count line makes the row payload self-evidencing —
  // an audit reader sees HOW MUCH was rendered, not a bare header (and a
  // future render regression cannot silently swallow rows unnoticed).
  ctx.out.explain(
    t(ctx.lang, 'env.activity.count', { name: detail.name, count: String(body.entries.length) }),
  );
}

async function createEnv(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      name: { type: 'string' },
      desc: { type: 'string' },
      'map-type': { type: 'string' },
      visibility: { type: 'string' },
      'from-template': { type: 'string' },
    },
    USAGE_CREATE,
  );
  rejectExtraPositionals(positionals, USAGE_CREATE);
  const name = requireString(flags, 'name', USAGE_CREATE);
  const visibility = stringFlag(flags, 'visibility');
  if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
    throw usageError(`--visibility must be public|private\nusage: ${USAGE_CREATE}`);
  }
  // R1 (B1-5 / P-07): create from a built-in scenario template in ONE
  // command — fetch the template, override the name, POST the import. The
  // `meta.name → environment name` contract detail is digested here so the
  // operator never downloads/edits JSON or curls by hand.
  const fromTemplate = stringFlag(flags, 'from-template');
  if (fromTemplate !== undefined) {
    return createEnvFromTemplate(ctx, fromTemplate, name, visibility, flags);
  }
  const mapType = stringFlag(flags, 'map-type');
  if (mapType !== undefined && mapType !== 'grid' && mapType !== 'geo') {
    throw usageError(`--map-type must be grid|geo\nusage: ${USAGE_CREATE}`);
  }
  const detail = (await ctx.authedClient().post('/api/environments', {
    name,
    ...(stringFlag(flags, 'desc') !== undefined ? { description: stringFlag(flags, 'desc') } : {}),
    ...(mapType !== undefined ? { mapType } : {}),
    ...(visibility ? { visibility } : {}),
  })) as EnvDetail;
  if (ctx.json) {
    ctx.out.data(detail);
  } else {
    ctx.out.line(`created environment ${detail.id} "${detail.name}" (${detail.mapType}, ${detail.visibility})`);
  }
}

/**
 * B1-5: the template path. `--desc/--map-type` are rejected honestly (the
 * template carries its own map; the import body has no description field)
 * instead of being silently dropped.
 */
async function createEnvFromTemplate(
  ctx: Ctx,
  templateId: string,
  name: string,
  visibility: string | undefined,
  flags: Record<string, unknown>,
): Promise<void> {
  if (stringFlag(flags, 'desc') !== undefined || stringFlag(flags, 'map-type') !== undefined) {
    throw usageError(
      '--desc/--map-type do not combine with --from-template: the template carries its own map\n' +
      `usage: eaf env create --from-template <id> --name <n> [--visibility public|private]`,
    );
  }
  let scenario: Record<string, unknown>;
  try {
    scenario = (await ctx.authedClient().get(
      `/api/scenario-templates/${encodeURIComponent(templateId)}`,
    )) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.NOT_FOUND) {
      // Teaching 404: name the templates that DO exist.
      const catalog = (await ctx.authedClient().get('/api/scenario-templates')) as {
        templates?: Array<{ id: string; name?: string }>;
      };
      const available = (catalog.templates ?? []).map(t => `${t.id}${t.name ? ` — ${t.name}` : ''}`);
      throw new CliError(
        `scenario template "${templateId}" not found`,
        EXIT.NOT_FOUND,
        ['Available templates:', ...available.map(entry => `  ${entry}`)],
      );
    }
    throw error;
  }
  const meta = (scenario.meta ?? {}) as Record<string, unknown>;
  scenario.meta = { ...meta, name };
  if (visibility !== undefined) scenario.visibility = visibility;
  const count = (key: string): number => (Array.isArray(scenario[key]) ? (scenario[key] as unknown[]).length : 0);
  const detail = (await ctx.authedClient().post('/api/environments', scenario)) as EnvDetail;
  if (ctx.json) {
    ctx.out.data(detail);
  } else {
    ctx.out.line(
      `created environment ${detail.id} "${detail.name}" from template ${templateId} ` +
      `(${count('zones')} zones, ${count('devices')} devices, ${count('agents')} agents, ${count('events')} events)`,
    );
  }
}

async function deleteEnv(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, 'eaf env delete <id|name>');
  const ref = requirePositional(positionals, 'id|name', 'eaf env delete <id|name>');
  const detail = await ctx.resolveEnv(ref);
  await ctx.authedClient().delete(`/api/environments/${encodeURIComponent(detail.id)}`);
  if (ctx.json) ctx.out.data({ deleted: detail.id, name: detail.name });
  else ctx.out.line(`deleted environment ${detail.id} "${detail.name}"`);
}

async function joinLeave(ctx: Ctx, sub: 'join' | 'leave', argv: string[]): Promise<void> {
  const usage = `eaf env ${sub} <id|name>`;
  const { positionals } = parse(argv, {}, usage);
  const ref = requirePositional(positionals, 'id|name', usage);
  const detail = await ctx.resolveEnv(ref);
  const result = await ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/${sub}`);
  if (ctx.json) {
    ctx.out.data(result ?? { envId: detail.id, [sub === 'join' ? 'joined' : 'left']: true });
  } else if (sub === 'join') {
    ctx.out.line(`joined "${detail.name}" (${detail.id})`);
    // Wave-1a (小新 R8 F-04): the newcomer stands at the door — point at the
    // guide and the (now env-scoped) marketplace instead of going silent.
    ctx.out.line(t(ctx.lang, 'env.nextStep', { envId: detail.id }));
  } else {
    ctx.out.line(`left "${detail.name}" (${detail.id})`);
  }
}

// ---------------------------------------------------------------------------
// members — owner-driven membership management (Fix-4)
// ---------------------------------------------------------------------------

interface EnvMemberEntry {
  userId?: string;
  role: string;
  displayName: string;
  email?: string | null;
}

async function membersCommand(ctx: Ctx, argv: string[]): Promise<void> {
  // First positional decides the action: add|invite|set-role|remove,
  // otherwise the whole positional list is the plain list form
  // `env members <id|name>`.
  const action = argv[0];
  if (action === 'add') return membersAdd(ctx, argv.slice(1));
  if (action === 'invite') return membersInvite(ctx, argv.slice(1));
  if (action === 'set-role') return membersSetRole(ctx, argv.slice(1));
  if (action === 'remove') return membersRemove(ctx, argv.slice(1));

  const { positionals } = parse(argv, {}, USAGE_MEMBERS);
  const ref = requirePositional(positionals, 'id|name', USAGE_MEMBERS);
  const detail = await ctx.resolveEnv(ref);
  const members = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/members`,
  )) as { members: EnvMemberEntry[] };
  // T14 (R2 u1-F7): pending invites become visible beside the roster — the
  // invite receipt used to be the LAST the owner saw of them ("无法确认
  // 3 条 pending 还在、没被吞掉"). Owner-facing only (the invites endpoint
  // is owner-scoped); absent field = nothing pending or not the owner.
  let pendingInvites: Array<{ id: string; email: string; role: string; createdAt: string }> = [];
  if (detail.myRole === 'owner') {
    try {
      pendingInvites = ((await ctx.authedClient().get(
        `/api/environments/${encodeURIComponent(detail.id)}/invites`,
      )) as { invites: typeof pendingInvites }).invites;
    } catch {
      // Older server / revoked view — the section just doesn't render.
    }
  }
  if (ctx.json) {
    // The legacy --json contract stays the bare members array (existing
    // consumers); the pending-invite rows ride the human output below and
    // the owner-scoped GET /invites endpoint.
    ctx.out.data(members.members);
    return;
  }
  ctx.out.table(
    members.members.map(member => ({
      user: member.displayName,
      role: member.role,
      email: member.email ?? '-',
      id: member.userId ?? '-',
    })),
    ['user', 'role', 'email', 'id'],
  );
  if (pendingInvites.length > 0) {
    ctx.out.line(
      `pending invites: ${pendingInvites.length} (join on registration)`,
    );
    for (const invite of pendingInvites) {
      ctx.out.line(`  ${invite.email} — ${invite.role}, invited at ${invite.createdAt}`);
    }
  }
}

function requireRole(flags: Record<string, unknown>, usage: string): 'builder' | 'viewer' {
  const role = requireString(flags, 'role', usage);
  if (role !== 'builder' && role !== 'viewer') {
    throw usageError(`--role must be builder|viewer (the owner role is not assignable)\nusage: ${usage}`);
  }
  return role;
}

/** Require exactly two positionals (`<id|name> <userId>`). */
function requireTwoPositionals(
  positionals: string[],
  first: string,
  second: string,
  usage: string,
): [string, string] {
  if (positionals.length < 1) throw usageError(`missing <${first}> argument\nusage: ${usage}`);
  if (positionals.length < 2) throw usageError(`missing <${second}> argument\nusage: ${usage}`);
  if (positionals.length > 2) {
    throw usageError(`unexpected extra arguments: ${positionals.slice(2).join(' ')}\nusage: ${usage}`);
  }
  return [positionals[0], positionals[1]];
}

async function membersAdd(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { email: { type: 'string' }, 'user-id': { type: 'string' }, role: { type: 'string' } },
    USAGE_MEMBERS_ADD,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_MEMBERS_ADD);
  const email = stringFlag(flags, 'email');
  const userId = stringFlag(flags, 'user-id');
  if ((email === undefined) === (userId === undefined)) {
    throw usageError(`exactly one of --email / --user-id is required\nusage: ${USAGE_MEMBERS_ADD}`);
  }
  const role = requireRole(flags, USAGE_MEMBERS_ADD);
  const detail = await ctx.resolveEnv(ref);
  let member: EnvMemberEntry;
  try {
    member = (await ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/members`, {
      ...(email !== undefined ? { email } : { userId }),
      role,
    })) as EnvMemberEntry;
  } catch (error) {
    // R1 (B1-6 / P-01b): USER_NOT_FOUND used to dead-end ("三连败") — the
    // most common owner journey (invite a not-yet-registered colleague) now
    // points at the pending-invite lane in the same breath.
    if (error instanceof CliError && error.message.includes('USER_NOT_FOUND')) {
      throw new CliError(error.message, error.exitCode, [
        ...((error.issues ?? []) as string[]),
        t(ctx.lang, 'env.members.userNotFoundHint'),
      ]);
    }
    throw error;
  }
  if (ctx.json) {
    ctx.out.data(member);
  } else {
    ctx.out.line(`added ${member.displayName} as ${member.role} to "${detail.name}" (${detail.id})`);
  }
}

/**
 * R1 (B1-6 / P-01a): pending email invites — the CLI face of the Fix-37
 * batch endpoint (`POST /api/environments/:id/members:batch`). An email
 * that is not registered yet lands as a PENDING invite and is accepted
 * automatically at registration (R15-D10); a registered email is added
 * immediately. Registered and pending, one command — the invitee's late
 * registration is no longer a dead end for the owner.
 */
async function membersInvite(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { email: { type: 'string', multiple: true }, role: { type: 'string' } },
    USAGE_MEMBERS_INVITE,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_MEMBERS_INVITE);
  // `--email a@x --email b@x` (repeat) and `--email a@x,b@x` (csv) both work.
  const rawEmails = flags.email;
  const emails = (Array.isArray(rawEmails) ? rawEmails : rawEmails !== undefined ? [rawEmails] : [])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0);
  if (emails.length === 0) {
    throw usageError(`at least one --email is required\nusage: ${USAGE_MEMBERS_INVITE}`);
  }
  const role = flags.role === undefined ? 'builder' : requireRole(flags, USAGE_MEMBERS_INVITE);
  const detail = await ctx.resolveEnv(ref);
  const result = (await ctx.authedClient().post(
    `/api/environments/${encodeURIComponent(detail.id)}/members:batch`,
    { emails, role },
  )) as {
    envId: string;
    role: string;
    summary: { total: number; added: number; skipped: number; failed: number; invited: number };
    results: Array<{ email: string; status: string; userId?: string }>;
  };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    `invited ${result.summary.total} email(s) to "${detail.name}" (${detail.id}) as ${result.role}: ` +
    `${result.summary.added} added, ${result.summary.invited} pending (join on registration), ` +
    `${result.summary.skipped} already members, ${result.summary.failed} failed`,
  );
  for (const entry of result.results) {
    ctx.out.line(`  ${entry.email}: ${entry.status}`);
  }
  if (result.summary.invited > 0) {
    ctx.out.line('pending invites are accepted automatically when the person registers (same email).');
  }
}

async function membersSetRole(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { role: { type: 'string' } }, USAGE_MEMBERS_SET_ROLE);
  const [ref, userId] = requireTwoPositionals(positionals, 'id|name', 'userId', USAGE_MEMBERS_SET_ROLE);
  const role = requireRole(flags, USAGE_MEMBERS_SET_ROLE);
  const detail = await ctx.resolveEnv(ref);
  const member = (await ctx.authedClient().patch(
    `/api/environments/${encodeURIComponent(detail.id)}/members/${encodeURIComponent(userId)}`,
    { role },
  )) as EnvMemberEntry;
  if (ctx.json) {
    ctx.out.data(member);
  } else {
    ctx.out.line(`${member.displayName} is now ${member.role} in "${detail.name}" (${detail.id})`);
  }
}

async function membersRemove(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_MEMBERS_REMOVE);
  const [ref, userId] = requireTwoPositionals(positionals, 'id|name', 'userId', USAGE_MEMBERS_REMOVE);
  const detail = await ctx.resolveEnv(ref);
  await ctx.authedClient().delete(
    `/api/environments/${encodeURIComponent(detail.id)}/members/${encodeURIComponent(userId)}`,
  );
  if (ctx.json) ctx.out.data({ envId: detail.id, removed: userId });
  else ctx.out.line(`removed member ${userId} from "${detail.name}" (${detail.id})`);
}

// ---------------------------------------------------------------------------
// T-072 (D-1 decide half): decision delegations + the member's proposal list
// ---------------------------------------------------------------------------

interface DelegationListBody { delegations: EnvDelegation[] }

function zonesWord(zones: string[] | 'all'): string {
  return zones === 'all' ? 'all zones' : zones.join(',');
}

async function delegatesCommand(ctx: Ctx, argv: string[]): Promise<void> {
  // First positional decides the action: grant|revoke, otherwise the plain
  // list form `env delegates <id|name>`.
  const action = argv[0];
  if (action === 'grant') return delegatesGrant(ctx, argv.slice(1));
  if (action === 'revoke') return delegatesRevoke(ctx, argv.slice(1));

  const { positionals } = parse(argv, {}, USAGE_DELEGATES);
  const ref = requirePositional(positionals, 'id|name', USAGE_DELEGATES);
  const detail = await ctx.resolveEnv(ref);
  const body = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/delegations`,
  )) as DelegationListBody;
  if (ctx.json) {
    ctx.out.data(body.delegations);
    return;
  }
  if (body.delegations.length === 0) {
    ctx.out.line(
      'no active decision delegations — deciding stays owner-only ' +
      '(the owner may delegate zone-claim decisions: eaf env delegates grant)',
    );
    return;
  }
  ctx.out.table(
    body.delegations.map(row => ({
      delegate: row.delegate.displayName,
      id: row.delegate.id,
      scope: row.scope,
      zones: zonesWord(row.zones),
      grantedBy: row.grantedBy.displayName,
      grantedAt: row.grantedAt,
    })),
    ['delegate', 'id', 'scope', 'zones', 'grantedBy', 'grantedAt'],
  );
}

async function delegatesGrant(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { email: { type: 'string' }, 'user-id': { type: 'string' }, zones: { type: 'string' }, 'all-zones': { type: 'boolean' } },
    USAGE_DELEGATES_GRANT,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_DELEGATES_GRANT);
  const email = stringFlag(flags, 'email');
  const userId = stringFlag(flags, 'user-id');
  if ((email === undefined) === (userId === undefined)) {
    throw usageError(`exactly one of --email / --user-id is required\nusage: ${USAGE_DELEGATES_GRANT}`);
  }
  const zonesFlag = stringFlag(flags, 'zones');
  const allZones = boolFlag(flags, 'all-zones');
  if (zonesFlag !== undefined && allZones) {
    throw usageError(`--zones and --all-zones are mutually exclusive\nusage: ${USAGE_DELEGATES_GRANT}`);
  }
  const zones = zonesFlag !== undefined
    ? zonesFlag.split(',').map(z => z.trim()).filter(z => z.length > 0)
    : undefined;
  if (zones !== undefined && zones.length === 0) {
    throw usageError(`--zones must list at least one zone id (or use --all-zones)\nusage: ${USAGE_DELEGATES_GRANT}`);
  }
  const detail = await ctx.resolveEnv(ref);
  const delegation = (await ctx.authedClient().post(
    `/api/environments/${encodeURIComponent(detail.id)}/delegations`,
    {
      ...(email !== undefined ? { email } : { userId }),
      ...(zones !== undefined ? { zones } : { zones: 'all' }),
    },
  )) as EnvDelegation;
  if (ctx.json) {
    ctx.out.data(delegation);
  } else {
    ctx.out.line(
      `delegated ${delegation.scope} decisions for "${detail.name}" (${detail.id}) to ` +
      `${delegation.delegate.displayName} — zones: ${zonesWord(delegation.zones)}`,
    );
    ctx.out.line('the delegate can now decide escalated zone-claim proposals in scope (eaf env proposals)');
  }
}

async function delegatesRevoke(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_DELEGATES_REVOKE);
  const [ref, userId] = requireTwoPositionals(positionals, 'id|name', 'userId', USAGE_DELEGATES_REVOKE);
  const detail = await ctx.resolveEnv(ref);
  await ctx.authedClient().delete(
    `/api/environments/${encodeURIComponent(detail.id)}/delegations/${encodeURIComponent(userId)}`,
  );
  if (ctx.json) ctx.out.data({ envId: detail.id, revoked: userId, scope: 'zone-claims' });
  else ctx.out.line(`revoked zone-claims delegation to ${userId} in "${detail.name}" (${detail.id})`);
}

interface ProposalListEntry {
  id: string;
  kind: string;
  status: string;
  riskLevel: string;
  author: { displayName: string };
  youCanDecide?: boolean;
  createdAt: string;
}

/** Decide/revert response (proposalToJson subset the CLI prints). */
interface ProposalEntry extends ProposalListEntry {
  envId: string;
  /** Present (and non-empty) only when the proposal applied. */
  createdIds?: { devices?: string[]; agents?: string[]; zones?: string[]; flows?: string[] };
}

/** POST /api/proposals/:id/remind response (R40-A1). */
interface ProposalRemindBody {
  proposalId: string;
  status: string;
  /** False when a noise-control rule dropped the notification. */
  reminded: boolean;
  note?: string;
  delegateReminded?: boolean;
}

const PROPOSAL_STATUSES = [
  'submitted', 'rule_check', 'ai_review', 'approved', 'rejected', 'escalated', 'applied', 'reverted',
] as const;

/**
 * T-404 read half + T-072 decide half: the member's proposal list, each row
 * marked with `decide` when the CALLER may decide it right now (owner:
 * every escalated proposal; the active zone-claims delegate: escalated
 * zone-claims inside their delegated zones).
 *
 * R40-A1: the decide/remind/revert actions live here too — the governance
 * loop no longer teaches curl.
 */
async function proposalsCommand(ctx: Ctx, argv: string[]): Promise<void> {
  // First positional decides the action: decide|remind|revert, otherwise the
  // plain list form `env proposals <id|name>` (same style as members/delegates).
  const action = argv[0];
  if (action === 'decide') return proposalDecide(ctx, argv.slice(1));
  if (action === 'remind') return proposalRemind(ctx, argv.slice(1));
  if (action === 'revert') return proposalRevert(ctx, argv.slice(1));

  const { flags, positionals } = parse(argv, { status: { type: 'string' } }, USAGE_PROPOSALS);
  const status = stringFlag(flags, 'status');
  if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    throw usageError(`--status must be one of ${PROPOSAL_STATUSES.join('|')}\nusage: ${USAGE_PROPOSALS}`);
  }
  const ref = requirePositional(positionals, 'id|name', USAGE_PROPOSALS);
  const detail = await ctx.resolveEnv(ref);
  const query = status !== undefined ? `?status=${encodeURIComponent(status)}` : '';
  const body = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/proposals${query}`,
  )) as { proposals: ProposalListEntry[] };
  if (ctx.json) {
    ctx.out.data(body.proposals);
    return;
  }
  if (body.proposals.length === 0) {
    ctx.out.line(status !== undefined ? `no ${status} proposals` : 'no proposals');
    return;
  }
  ctx.out.table(
    body.proposals.map(proposal => ({
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      risk: proposal.riskLevel,
      author: proposal.author.displayName,
      decide: proposal.youCanDecide === true ? '*' : '-',
      createdAt: proposal.createdAt,
    })),
    ['id', 'kind', 'status', 'risk', 'author', 'decide', 'createdAt'],
  );
  ctx.out.line('decide = * : you may decide this proposal now (eaf env proposals decide <id> --approve|--reject)');
}

/**
 * R40-A1: `eaf env proposals decide <id> --approve|--reject` — the escalated
 * proposal's decider (env owner; an in-scope zone-claims delegate for
 * zone-claims) closes the loop from the CLI.
 */
async function proposalDecide(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { approve: { type: 'boolean' }, reject: { type: 'boolean' }, reason: { type: 'string' } },
    USAGE_PROPOSAL_DECIDE,
  );
  const proposalId = requirePositional(positionals, 'proposalId', USAGE_PROPOSAL_DECIDE);
  const approve = boolFlag(flags, 'approve');
  const reject = boolFlag(flags, 'reject');
  if (approve === reject) {
    throw usageError(`exactly one of --approve / --reject is required\nusage: ${USAGE_PROPOSAL_DECIDE}`);
  }
  const reason = stringFlag(flags, 'reason');
  const proposal = (await ctx.authedClient().post(
    `/api/proposals/${encodeURIComponent(proposalId)}/decide`,
    {
      decision: approve ? 'approved' : 'rejected',
      ...(reason !== undefined ? { reason } : {}),
    },
  )) as ProposalEntry;
  if (ctx.json) {
    ctx.out.data(proposal);
    return;
  }
  ctx.out.line(
    `proposal ${proposal.id} (${proposal.kind}) ${approve ? 'approved' : 'rejected'} — status: ${proposal.status}`,
  );
  if (proposal.status === 'applied') {
    const created = [
      ...(proposal.createdIds?.devices ?? []),
      ...(proposal.createdIds?.agents ?? []),
      ...(proposal.createdIds?.zones ?? []),
      ...(proposal.createdIds?.flows ?? []),
    ];
    if (created.length > 0) ctx.out.line(`  created: ${created.join(', ')}`);
    ctx.out.line(`  change of mind? eaf env proposals revert ${proposal.id}`);
  }
}

/**
 * R40-A1: `eaf env proposals remind <id>` — the AUTHOR's rate-limited nudge
 * (one per 10 min, anchored at proposal creation) on a still-escalated
 * proposal; the decider (owner + covering delegate) is notified.
 */
async function proposalRemind(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_PROPOSAL_REMIND);
  const proposalId = requirePositional(positionals, 'proposalId', USAGE_PROPOSAL_REMIND);
  const result = (await ctx.authedClient().post(
    `/api/proposals/${encodeURIComponent(proposalId)}/remind`,
  )) as ProposalRemindBody;
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  if (result.reminded) {
    ctx.out.line(`proposal ${result.proposalId} is still escalated — the decider was reminded`);
    if (result.delegateReminded) ctx.out.line('  the zone-claims delegate was notified too');
  } else {
    ctx.out.line(`proposal ${result.proposalId}: ${result.note ?? 'the reminder was not delivered'}`);
  }
}

/**
 * R40-A1: `eaf env proposals revert <id>` — the proposal author or env owner
 * undoes an APPLIED proposal (the inverse is logged in the command log).
 */
async function proposalRevert(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_PROPOSAL_REVERT);
  const proposalId = requirePositional(positionals, 'proposalId', USAGE_PROPOSAL_REVERT);
  const proposal = (await ctx.authedClient().post(
    `/api/proposals/${encodeURIComponent(proposalId)}/revert`,
  )) as ProposalEntry;
  if (ctx.json) {
    ctx.out.data(proposal);
    return;
  }
  ctx.out.line(`proposal ${proposal.id} (${proposal.kind}) reverted — status: ${proposal.status}`);
  ctx.out.line('  the inverse change was applied to the world (command log carries the revert entry)');
}

// ---------------------------------------------------------------------------
// deployment — the caller's deployment manifest (W5; Fix-13, R5 F-05 entry)
// ---------------------------------------------------------------------------

interface DeploymentManifest {
  environment: { id: string; name: string };
  myAgents: Array<{ id: string; name: string; capabilities: string[]; llm: unknown }>;
  devicesToDeploy: Array<{
    instanceId: string;
    name: string;
    type: string;
    zoneId: string;
    /** Fix-18 (R7 F-05): sim://… default or hass://<entity> when bridged. */
    binding: string;
    /** Fix-18 (R7 F-05): 'bridged' | 'simulation-only'. */
    deploymentStatus: string;
    catalogModelId?: string;
    vendor?: string;
    model?: string;
    priceCny?: number;
    purchaseUrl?: string;
  }>;
  /** Fix-18 (R7 F-05): twin-sync bindings wired to the caller's devices. */
  syncBindings: Array<{
    deviceInstanceId: string;
    attributeKey: string;
    source: string;
    status: string;
  }>;
  servicesToOffer: Array<{
    id: string;
    name: string;
    semanticType: string;
    origin: string;
    backedByDeviceIds: string[];
  }>;
  servicesConsumed: Array<{
    id: string;
    name: string;
    semanticType: string;
    provider: { agentId: string; agentName: string; ownerId: string; ownerName: string };
  }>;
  notes: string[];
}

/** Print the manifest as a procurement summary: devices/prices/links first. */
async function deployment(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_DEPLOYMENT);
  const ref = requirePositional(positionals, 'id|name', USAGE_DEPLOYMENT);
  const detail = await ctx.resolveEnv(ref);
  const manifest = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/deployment`,
  )) as DeploymentManifest;
  if (ctx.json) {
    ctx.out.data(manifest);
    return;
  }
  ctx.out.line(`deployment manifest — ${manifest.environment.name} (${manifest.environment.id})`);
  ctx.out.line('');
  ctx.out.line(`agents to run (${manifest.myAgents.length}):`);
  if (manifest.myAgents.length > 0) {
    ctx.out.table(
      manifest.myAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities.join(','),
      })),
      ['id', 'name', 'capabilities'],
    );
  }
  ctx.out.line('');
  ctx.out.line(`devices to procure (${manifest.devicesToDeploy.length}):`);
  if (manifest.devicesToDeploy.length > 0) {
    ctx.out.table(
      manifest.devicesToDeploy.map(device => ({
        name: device.name,
        status: device.deploymentStatus,
        binding: device.binding,
        vendor: device.vendor ?? '-',
        model: device.model ?? '-',
        price: device.priceCny !== undefined ? `¥${device.priceCny}` : '-',
        url: device.purchaseUrl ?? '-',
      })),
      ['name', 'status', 'binding', 'vendor', 'model', 'price', 'url'],
    );
  }
  if (manifest.syncBindings.length > 0) {
    ctx.out.line('');
    ctx.out.line(`twin-sync bindings (${manifest.syncBindings.length}):`);
    ctx.out.table(
      manifest.syncBindings.map(binding => ({
        device: binding.deviceInstanceId,
        attribute: binding.attributeKey,
        source: binding.source,
        status: binding.status,
      })),
      ['device', 'attribute', 'source', 'status'],
    );
  }
  ctx.out.line('');
  ctx.out.line(`services to offer (${manifest.servicesToOffer.length}):`);
  if (manifest.servicesToOffer.length > 0) {
    ctx.out.table(
      manifest.servicesToOffer.map(service => ({
        name: service.name,
        type: service.semanticType,
        origin: service.origin,
        backedBy: service.backedByDeviceIds.join(',') || '-',
      })),
      ['name', 'type', 'origin', 'backedBy'],
    );
  }
  ctx.out.line('');
  ctx.out.line(`external services to sign (${manifest.servicesConsumed.length}):`);
  if (manifest.servicesConsumed.length > 0) {
    ctx.out.table(
      manifest.servicesConsumed.map(service => ({
        name: service.name,
        type: service.semanticType,
        provider: `${service.provider.agentName} (owner ${service.provider.ownerName})`,
      })),
      ['name', 'type', 'provider'],
    );
  }
  if (manifest.notes.length > 0) {
    ctx.out.line('');
    ctx.out.line('notes:');
    for (const note of manifest.notes) ctx.out.line(`  - ${note}`);
  }
}

/**
 * Fix-22: NDJSON training-data export (owner-only server side). The NDJSON
 * stream IS the payload — stdout unless `-o` writes it to a file.
 */
async function trainingExport(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      sim: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', short: 'o' },
    },
    USAGE_TRAINING_EXPORT,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_TRAINING_EXPORT);
  const detail = await ctx.resolveEnv(ref);

  const params = new URLSearchParams();
  const sim = stringFlag(flags, 'sim');
  const from = stringFlag(flags, 'from');
  const to = stringFlag(flags, 'to');
  const format = stringFlag(flags, 'format');
  if (sim !== undefined) params.set('simId', sim);
  if (from !== undefined) params.set('from', from);
  if (to !== undefined) params.set('to', to);
  if (format !== undefined) {
    if (format !== 'sft' && format !== 'dpo' && format !== 'structured') {
      throw usageError(`--format must be sft|dpo|structured\nusage: ${USAGE_TRAINING_EXPORT}`);
    }
    params.set('format', format);
  }
  const qs = params.size > 0 ? `?${params.toString()}` : '';

  // Owner-only endpoint — always go through the authed client.
  const text = await ctx
    .authedClient()
    .getText(`/api/environments/${encodeURIComponent(detail.id)}/training-export${qs}`);

  const output = stringFlag(flags, 'output');
  if (output) {
    writeFileSync(resolve(ctx.io.cwd, output), text, 'utf8');
    const lines = text.split('\n').filter(line => line.trim().length > 0).length;
    ctx.out.info(`wrote ${lines} NDJSON record(s) for "${detail.name}" to ${output}`);
    if (ctx.json) ctx.out.data({ file: output, envId: detail.id, name: detail.name, records: lines });
  } else {
    ctx.io.stdout(text);
  }
}

async function exportEnv(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { output: { type: 'string', short: 'o' }, format: { type: 'string' } },
    USAGE_EXPORT,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_EXPORT);
  const detail = await ctx.resolveEnv(ref);
  // R40-B4: flows + demo ride the document (the two-sided round-trip gap).
  const flowsBody = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/flows`,
  )) as { flows?: Array<Record<string, unknown>> };
  const document = envDetailToDocument(detail, (flowsBody.flows ?? []) as unknown as EnvFlowSummary[]);

  const output = stringFlag(flags, 'output');
  let format = stringFlag(flags, 'format');
  if (format === undefined && output) {
    format = output.endsWith('.json') ? 'json' : 'yaml';
  }
  format ??= ctx.json && !output ? 'json' : 'yaml';
  if (format !== 'yaml' && format !== 'json') {
    throw usageError(`--format must be yaml|json\nusage: ${USAGE_EXPORT}`);
  }

  const text = format === 'json' ? JSON.stringify(document, null, 2) + '\n' : stringifyYaml(document);
  // T7 (R2 u2-F1): the export is a WORLD DOCUMENT (kubectl-style), not
  // same-env flow re-add material. The flows section is a reference snapshot:
  // cross-environment rebuilding re-pins flows through the import lane
  // (`eaf apply -f world.yaml`), and re-adding a flow that actuates OTHER
  // users' assets into its original environment is refused by the ownership
  // rules (FLOW_INVALID, another tenant). YAML rides the note as a file
  // header comment (survives copy/share); JSON has no comments, so the human
  // info line carries it in every mode.
  const flowSnapshotNote =
    'flows section = reference snapshot for cross-environment rebuilding (re-pin by capability ' +
    'via `eaf apply -f world.yaml`); re-adding it to the ORIGINAL environment is refused when it ' +
    "actuates other users' agents/devices (FLOW_INVALID, another tenant) — orchestrate foreign " +
    'assets via agreement invoke / flow service nodes instead.';
  const textOut = format === 'yaml'
    ? `# env export — world document.\n# ${flowSnapshotNote}\n${text}`
    : text;
  if (output) {
    writeFileSync(resolve(ctx.io.cwd, output), textOut, 'utf8');
    ctx.out.info(`wrote ${format} world document for "${detail.name}" (${detail.zones.length} zones, ` +
      `${detail.devices.length} devices, ${detail.agents.length} agents) to ${output}`);
    ctx.out.info(flowSnapshotNote);
    if (ctx.json) ctx.out.data({ file: output, format, envId: detail.id, name: detail.name });
  } else {
    // The document IS the payload — stdout in every mode.
    ctx.io.stdout(textOut);
  }
}

// ---------------------------------------------------------------------------
// eval-run (Wave-3a batch evaluation)
// ---------------------------------------------------------------------------

interface EvalRunJobRun {
  label: string;
  status: 'done' | 'failed';
  simId?: string;
  llm?: string;
  llmModel?: string;
  llmPromptVariant?: string;
  durationMs: number;
  error?: string;
  metrics?: {
    decisions: { total: number; accuracy: number | null; bySource: Record<string, number> };
    handshakes: { successRate: number | null };
    effectChecks: { passRate: number | null };
    reputation: { totals: { attempts: number; successes: number } };
  };
}

interface EvalRunJob {
  id: string;
  envId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
  result?: { runs: EvalRunJobRun[] };
}

/** resolves false when aborted (Ctrl+C) */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
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

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;
}

async function evalRun(ctx: Ctx, argv: string[]): Promise<void> {
  // `eval-run status <jobId>` reads an existing batch job (any env member);
  // every other form is the submit-and-poll flow below.
  if (argv[0] === 'status') return evalRunStatus(ctx, argv.slice(1));
  const { flags, positionals } = parse(
    argv,
    {
      file: { type: 'string', short: 'f' },
      'no-wait': { type: 'boolean' },
      interval: { type: 'string' },
    },
    USAGE_EVAL_RUN,
  );
  const ref = requirePositional(positionals, 'id|name', USAGE_EVAL_RUN);
  const file = requireString(flags, 'file', USAGE_EVAL_RUN);
  const interval = numberFlag(flags, 'interval', USAGE_EVAL_RUN) ?? 2000;
  if (interval < 100) throw usageError(`--interval must be >= 100 ms\nusage: ${USAGE_EVAL_RUN}`);

  let spec: unknown;
  try {
    spec = parseYaml(readFileSync(resolve(ctx.io.cwd, file), 'utf8'));
  } catch (error) {
    throw new CliError(
      `cannot read/parse spec file "${file}": ${error instanceof Error ? error.message : String(error)}`,
      EXIT.USAGE,
    );
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw usageError(`spec file must contain an object ({ runs, events, promptVariants? })\nusage: ${USAGE_EVAL_RUN}`);
  }

  const detail = await ctx.resolveEnv(ref);
  const client = ctx.authedClient(); // member-only endpoint — login first
  const job = (await client.post(
    `/api/environments/${encodeURIComponent(detail.id)}/eval-runs`,
    spec,
  )) as EvalRunJob;

  if (boolFlag(flags, 'no-wait')) {
    if (ctx.json) ctx.out.data(job);
    else ctx.out.line(`eval run ${job.id} submitted (status=${job.status}) — check later with \`eaf env eval-run status ${job.id}\``);
    return;
  }

  ctx.out.info(`eval run ${job.id} submitted (${(spec as { runs?: unknown[] }).runs?.length ?? '?'} run(s)) — polling every ${interval}ms`);
  let current = job;
  for (;;) {
    if (current.status === 'done' || current.status === 'failed') break;
    const ok = await sleep(interval, ctx.signal);
    if (!ok) {
      ctx.out.info(`stopped polling — job ${job.id} keeps running server-side (\`eaf env eval-run status ${job.id}\`)`);
      return;
    }
    current = (await client.get(`/api/eval-runs/${encodeURIComponent(job.id)}`)) as EvalRunJob;
  }

  printEvalRunResult(ctx, current);
}

/**
 * `eaf env eval-run status <jobId>` (Wave-3a read half): one batch job's
 * current state (GET /api/eval-runs/:id) — status while pending/running,
 * the cross-run comparison table once done.
 */
async function evalRunStatus(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_EVAL_RUN_STATUS);
  const id = requirePositional(positionals, 'jobId', USAGE_EVAL_RUN_STATUS);
  const job = (await ctx.authedClient().get(`/api/eval-runs/${encodeURIComponent(id)}`)) as EvalRunJob;
  if (ctx.json) {
    ctx.out.data(job);
    return;
  }
  if (job.status === 'pending' || job.status === 'running') {
    ctx.out.line(`eval run ${job.id}: ${job.status} — check again with \`eaf env eval-run status ${job.id}\``);
    return;
  }
  printEvalRunResult(ctx, job);
}

/** Shared rendering: the finished (or failed) batch job's comparison table. */
function printEvalRunResult(ctx: Ctx, current: EvalRunJob): void {
  if (ctx.json) {
    ctx.out.data(current);
    return;
  }
  if (current.status === 'failed') {
    throw new CliError(`eval run ${current.id} failed: ${current.error ?? 'unknown error'}`, EXIT.ERROR);
  }
  const runs = current.result?.runs ?? [];
  ctx.out.table(
    runs.map(run => ({
      label: run.label,
      llm: run.llm ?? '-',
      decisions: run.metrics?.decisions.total ?? '-',
      'llm%': run.metrics ? pct(llmShareOf(run)) : '-',
      accuracy: pct(run.metrics?.decisions.accuracy),
      handshake: pct(run.metrics?.handshakes.successRate),
      effect: pct(run.metrics?.effectChecks.passRate),
      rep: run.metrics ? `${run.metrics.reputation.totals.successes}/${run.metrics.reputation.totals.attempts}` : '-',
      status: run.status === 'done' ? `done (${(run.durationMs / 1000).toFixed(1)}s)` : `failed: ${run.error ?? '?'}`,
    })),
    ['label', 'llm', 'decisions', 'llm%', 'accuracy', 'handshake', 'effect', 'rep', 'status'],
  );
  for (const run of runs) {
    if (run.simId) ctx.out.info(`run "${run.label}" → simulation ${run.simId} (eaf sim snapshot / GET eval-report)`);
  }
}

/** LLM 决策占比（bySource 中 llm+triage / total）。 */
function llmShareOf(run: EvalRunJobRun): number | null {
  const decisions = run.metrics?.decisions;
  if (!decisions || decisions.total === 0) return null;
  return ((decisions.bySource.llm ?? 0) + (decisions.bySource.triage ?? 0)) / decisions.total;
}
