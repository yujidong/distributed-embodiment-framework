/**
 * Agent natural-language routes — Phase 3 of the agent cognitive
 * architecture (design §12 Phase 3, value layer L1), plus the Phase-4
 * predictive what-if lane (§4.4 — the simulation engine AS the world model).
 *
 * - `POST /api/agents/:id/command` — command a LIVE agent in plain
 *   language: parse → cognitive decision → validated device execution →
 *   natural-language response. Emergency text escalates immediately.
 *   Phase 4: the platform injects a VERIFY-BEFORE-ACT seam — the first
 *   validated device command is simulated on a private fork of the live
 *   world before it executes; a predicted degradation blocks the batch.
 * - `POST /api/agents/:id/ask` — ask a live agent a question (status,
 *   explanation). Read-only by construction: no device commands.
 * - `POST /api/agents/:id/what-if` — run a hypothetical intervention on a
 *   FORK of the live world (never the authoritative world — the no-reflow
 *   red line): baseline vs intervention arms, metric series, delta, verdict,
 *   confidence, and a template explanation. Accepts free text
 *   ("what if I turn off hvac-1 for 30 minutes?") or the structured
 *   { intervention, metrics?, durationSec? } form.
 *
 * Agent resolution: unlike PATCH/DELETE /api/agents/:id (world-object DB
 * rows), these routes target the agent RUNNING inside a live simulation —
 * they resolve the id across the registry's live runtimes. The same
 * environment can run in several sims (private forks + the authoritative
 * world session), so the body accepts an optional `simId` disambiguator;
 * ambiguity without it is a teaching 409, never a silent pick.
 *
 * Safety (task §6):
 * - the raw text is sanitized by the S1 prompt sanitizer before ANY LLM
 *   sees it (inside the core parser);
 * - device targets are validated against the agent's OWN bound devices
 *   (the recommendation bridge — same as the delegate lane);
 * - R46C-P0-A: the FINAL device targets additionally pass the device-
 *   command ownership gates (device-command-gates.ts) at the execution
 *   layer — the NL channel enforces the same org boundary as the direct
 *   command channel, denial = 403 with the sanctioned lanes in the message;
 * - emergency commands bypass the normal decision pipeline (immediate
 *   escalation; the env owner gets a notification when env-backed);
 * - what-if NEVER mutates the live world (read-only fork source: one
 *   exportWorldState snapshot; both arms run in private headless runtimes);
 * - every NL interaction is audit-logged: command_log (env-backed sims,
 *   kind 'agent-nl-command' / 'agent-nl-ask' / 'agent-what-if') + a server
 *   log line always.
 *
 * Access: two stacked gates. assertControl mirrors the simulation command
 * lane (the sim creator, an owner/builder of its environment, or an admin;
 * viewers read-only). R99: /command ADDITIONALLY gates the requester against
 * the TARGET AGENT before any decision runs — agent owner, env owner, admin,
 * or the consumer of an ACTIVE agreement whose provider is this agent (the
 * 显式授权 lane). /ask is read-only by construction and stays open to every
 * caller assertControl admits — the ask/command permission difference is
 * deliberate: asking costs no decision resources, commanding spends them.
 */

import type { FastifyInstance } from 'fastify';

import type { AuthUser } from '../auth/index.js';
import { environmentToScenario } from '../environment-bridge.js';
import type { NLDeviceView } from '@active-collaboration/core';

import { foreignDeviceRequesterTeaching, foreignMentionTeaching } from '../nl-foreign-mention.js';
import type { ServiceStore } from '../db/service-store.js';
import { ApiError } from '../errors.js';
import { assertDeviceCommandGates } from '../device-command-gates.js';
import type { AgreementStore } from '../db/agreement-store.js';
import type { UserStore } from '../db/user-store.js';
import type { CommandLogStore } from '../db/proposal-store.js';
import type { DeviceInstanceRow, EnvironmentRow, EnvironmentStore } from '../db/environment-store.js';
import { parseJsonArray } from '../db/environment-store.js';
import { notify, NOTIFICATION_KINDS } from '../notifications.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import type { SimulationRecord } from '../sim-registry/types.js';
import { worldSessionSimIdOf } from '../sandbox-service.js';
import { defaultSimNoteOf, judgeDefaultSimBinding } from '../agreements/targeting.js';
import { readWorldCheckpoint } from '../world-checkpoint.js';
import {
  WHAT_IF_DEFAULT_DURATION_SEC,
  WHAT_IF_MAX_DURATION_SEC,
  WhatIfValidationError,
  detectEmergency,
  parseWhatIfText,
  runWhatIf,
  unresolvedZoneMentionOf,
  whatIfMaxDurationSecOf,
  type NLAskResult,
  type NLCommandIntent,
  type NLCommandResult,
  type NLZoneView,
  type WhatIfIntervention,
  type WhatIfMetric,
  type WhatIfTextParse,
  type WhatIfWorldSource,
} from '@active-collaboration/core';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('agent-nl-routes');

/** command_log kinds for the NL audit trail. */
export const AGENT_NL_COMMAND_KIND = 'agent-nl-command';
export const AGENT_NL_ASK_KIND = 'agent-nl-ask';
export const AGENT_WHAT_IF_KIND = 'agent-what-if';

export interface AgentNLRoutesContext {
  registry: SimulationRegistry;
  envStore?: EnvironmentStore;
  commandLogStore?: CommandLogStore;
  notificationStore?: NotificationStore;
  /** Fix-47 parity: admins may command any agent. */
  adminEmails: string[];
  /**
   * R46C-P0-A: the device-command ownership gates' stores (owner display
   * names for the teaching 403s; the agreement carve-out oracle — absent
   * means fail closed, so the server wires both).
   */
  userStore?: UserStore;
  agreementStore?: AgreementStore;
  /**
   * R78 病灶 A：越权指名教学 pass 需要服务名录（指名他人设备时找到其
   * 暴露的服务，指路合约路径）。只读用途。
   */
  serviceStore?: ServiceStore;
  /**
   * T92 (R13, u1-F1): the restart-teaching judgment — did this agent's env
   * carry a world session (the sim surface that survives a restart)? Read-only
   * `statusOf` access; optional so degenerate harnesses omit it.
   */
  worldSessions?: {
    statusOf(envId: string): { state?: string } | undefined;
  };
  /**
   * T95 (R14, u1-F1): the DISK half of the same judgment — does a
   * world-session checkpoint for this env exist on disk? After a server
   * restart the FIRST arrival happens before the session service lazily
   * rebinds (its view builds on first touch), so the in-memory view alone
   * went blind exactly when the teaching mattered most (u1: bare
   * SIMULATION_NOT_FOUND, no teaching). Same path contract as the sandbox
   * fork's findSessionCheckpoint (P2F §10.1). Optional; absent keeps the
   * memory-only judgment.
   */
  worldSessionCheckpointProbe?: (envId: string) => boolean;
}

interface NLBody {
  text?: unknown;
  simId?: unknown;
}

function isAdmin(ctx: AgentNLRoutesContext, user: AuthUser | null): boolean {
  return user !== null && ctx.adminEmails.includes(user.email.toLowerCase());
}

/**
 * Control gate — mirrors the simulation command lane's semantics. The denial
 * verb follows the LANE (R13-u3 P2: an ask refusal that said "command agents"
 * contradicted ask's own help promise — the role list is identical, only the
 * verb differs).
 */
function assertControl(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  lane: 'command' | 'query' = 'command',
): void {
  const verb = lane === 'command'
    ? { commanding: 'commanding', mayVerb: 'command agents' }
    : { commanding: 'querying', mayVerb: 'query agents (ask / what-if)' };
  if (isAdmin(ctx, user)) return;
  if (record.envSession === true) {
    if (record.environmentId !== undefined && ctx.envStore) {
      const role = ctx.envStore.roleOf(record.environmentId, user.id);
      if (role === 'owner' || role === 'builder') return;
    }
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Simulation "${record.id}" is the environment's authoritative world session — ${verb.commanding} its agents requires role "builder" | "owner" in the environment`,
    );
  }
  if (record.createdBy === user.id) return;
  if (record.environmentId !== undefined && ctx.envStore) {
    const role = ctx.envStore.roleOf(record.environmentId, user.id);
    if (role === 'owner' || role === 'builder') return;
    if (role === 'viewer') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Viewers are read-only end to end — natural-language agent interactions require role "builder" | "owner" (or being the simulation creator)',
      );
    }
  }
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Only the simulation creator, an owner/builder of its environment, or an admin may ${verb.mayVerb} in simulation "${record.id}"`,
  );
}

/** 顺带① (R13, u3-P2): can this caller pass the control gate on this sim? */
function mayControlSim(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
): boolean {
  try {
    assertControl(ctx, record, user);
    return true;
  } catch {
    return false;
  }
}

/**
 * R99 (simtest-r1 zhao-10, P1): the /command ENTRY identity gate — runs
 * BEFORE any decision. assertControl gates the SIM, but a command also
 * spends the TARGET AGENT's resources (the full LLM decision pipeline) and
 * stirs its decision context, so the requester must be: the agent's owner,
 * the environment owner, an admin, or the CONSUMER of an ACTIVE agreement
 * whose provider is this agent (the sanctioned 显式授权 lane — the same
 * contract that opens the execution-layer org gate in
 * device-command-gates.ts). ask stays read-open for every member; this gate
 * is /command-only. Scenario sims without an environment keep assertControl
 * as the whole boundary (the sim creator owns the world). The denial is
 * localized (F0-3 双语红线).
 */
const COMMAND_IDENTITY_STRINGS = {
  'zh-CN': (agentName: string, ownerName: string) =>
    `你不是 Agent "${agentName}" 的所有者（属于 ${ownerName}）——command 会驱动该 Agent 的完整决策流程` +
    '（消耗其推理资源并写入其决策上下文），只有它的所有者、环境所有者、管理员，或持有以它为提供方的 ' +
    'active 合约的消费者可以发起。' +
    '只读提问请用 ask（POST /api/agents/:id/ask，对成员开放）；需要它行动，请在「服务」市场对它的服务' +
    '发起合约（POST /api/services/{id}/agreements）——合约 active 后你即获得 command 授权。',
  'en-US': (agentName: string, ownerName: string) =>
    `You are not the owner of agent "${agentName}" (it belongs to ${ownerName}) — a command drives the ` +
    'agent\'s full decision pipeline (spending its inference and writing its decision context); only its ' +
    'owner, the environment owner, an admin, or the consumer of an ACTIVE agreement whose provider is ' +
    'this agent may command it. Read-only questions use ask (POST /api/agents/:id/ask, open to members); ' +
    'to make it act, propose an agreement on its service in the marketplace ' +
    '(POST /api/services/{id}/agreements) — once active you are authorized to command it.',
} as const;

function assertAgentCommandIdentity(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  agentId: string,
  locale?: string,
): void {
  if (isAdmin(ctx, user)) return;
  if (record.environmentId === undefined || ctx.envStore === undefined) return;
  const agent = ctx.envStore.getAgent(agentId);
  if (agent === undefined || agent.env_id !== record.environmentId) return;
  if (agent.owner_id === user.id) return;
  if (ctx.envStore.getEnvironment(record.environmentId)?.owner_id === user.id) return;
  const agreementAuthorized =
    ctx.agreementStore?.agreementsOfEnv(record.environmentId).some(
      agreement =>
        agreement.status === 'active' &&
        agreement.consumer_owner_id === user.id &&
        agreement.provider_agent_id === agentId,
    ) === true;
  if (agreementAuthorized) return;
  const ownerName = ctx.userStore?.findById(agent.owner_id)?.display_name ?? agent.owner_id;
  const format =
    locale === 'en-US' || locale === 'en'
      ? COMMAND_IDENTITY_STRINGS['en-US']
      : COMMAND_IDENTITY_STRINGS['zh-CN'];
  throw new ApiError(403, 'FORBIDDEN', format(agent.name, ownerName));
}

/**
 * R46C-P0-A: the device-ownership gate for the NL command lane. The same
 * three boundaries as the direct command channel (device-command-gates.ts —
 * hass:// real hardware, the authoritative world session, the R46 org
 * boundary with its agreement/governance carve-outs), applied per FINAL
 * device target at the execution layer (the NL pipeline injects this via the
 * seam — the target device is only known once the decision's deviceActions /
 * the prose bridge resolved). The 403 is prefixed with the channel context:
 * phrasing an order as an agent conversation must not read as a narrower
 * boundary than typing the command by hand.
 */
function assertNLDeviceCommand(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  deviceId: string,
  locale?: string,
): void {
  try {
    assertDeviceCommandGates(ctx, record, user, deviceId, isAdmin(ctx, user));
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 403) {
      // R49: same denial audit as the direct command lane — NL must not be
      // the unaudited side door to another org's devices.
      if (record.environmentId !== undefined && ctx.commandLogStore !== undefined) {
        try {
          ctx.commandLogStore.append({
            envId: record.environmentId,
            actorId: user.id,
            kind: 'device-command-denied',
            payload: {
              simId: record.id,
              simTimeSec: record.runtime.getSimTimeSec(),
              deviceId,
              lane: 'agent-nl-command',
              reason: error.message,
            },
            simTime: record.runtime.getSimTimeSec(),
          });
        } catch {
          // best-effort — the 403 below is the guarantee that matters
        }
      }
      // R76-F5: the cross-org denial speaks the SAME localized teaching as
      // the foreign-mention pass (owner + services + agreement path) — the
      // raw English gate message stays in the audit log above, never in the
      // user-facing response. Only the org-boundary shape localizes: hass://
      // real-hardware denials and unresolvable devices keep the gate's own
      // message (different boundary, different sanctioned lane).
      // R99: the denial speaks the REQUESTER-accurate cause (the gate keys
      // on who asked, not on the agent's binding surface) — never the
      // agent-voice "我只能操作自己绑定的设备" for a requester-ownership
      // denial (zhao-10).
      const teaching = nlDenialTeaching(ctx, record, user, deviceId, locale);
      if (teaching !== null) {
        throw new ApiError(403, 'FORBIDDEN', teaching);
      }
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Natural-language agent commands carry the SAME device ownership boundaries as direct simulation commands — ' +
        'operating another organization\'s device through an agent instruction also needs the agreement lane ' +
        '(POST /api/services/{id}/agreements) or a governance ownership-transfer proposal. ' +
        error.message,
      );
    }
    throw error;
  }
}

/**
 * R76-F5: build the localized denial teaching for a 403'd NL device command,
 * or null when the denial is NOT the cross-org ownership shape (hass:// real
 * hardware, unknown device) — those keep the gate's original message.
 */
function nlDenialTeaching(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  deviceId: string,
  locale: string | undefined,
): string | null {
  if (record.environmentId === undefined || ctx.envStore === undefined) return null;
  let device: DeviceInstanceRow | undefined;
  try {
    device = ctx.envStore.getDevice(deviceId);
  } catch {
    return null;
  }
  if (
    device === undefined ||
    device.env_id !== record.environmentId ||
    device.owner_id == null ||
    device.owner_id === user.id ||
    (device.binding !== null && device.binding.startsWith('hass://'))
  ) {
    return null;
  }
  const ownerName = ctx.userStore?.findById(device.owner_id)?.display_name ?? device.owner_id;
  let itsServices: Array<{ id: string; name: string; semanticType: string; sourceDeviceId: string | null; visibility: string }> = [];
  try {
    itsServices = (ctx.serviceStore?.servicesOf(record.environmentId) ?? [])
      .filter(s => s.source_device_id === deviceId)
      .slice(0, 3)
      .map(s => ({
        id: s.id,
        name: s.name,
        semanticType: s.semantic_type,
        sourceDeviceId: s.source_device_id,
        visibility: s.visibility,
      }));
  } catch {
    itsServices = []; // best-effort — the owner + path lines still teach
  }
  return foreignDeviceRequesterTeaching({ name: device.name, ownerName }, itsServices, locale);
}

/**
 * T92 (R13, u1-F1) + T95 (R14, u1-F1): the restart teaching suffix. Sims do
 * not survive a server restart — only the authoritative world session does
 * (checkpoint restore on next touch) — but a caller holding a pre-restart
 * sim id reads the bare NOT_FOUND as "my data is gone".
 *
 * The JUDGMENT is "this env's collaborative world survived", proven by
 * EITHER half:
 * - an in-memory world-session view (live or hibernated — T92's original
 *   signal), OR
 * - the env's world-session CHECKPOINT on disk (T95): after a restart the
 *   first arrival precedes the session's lazy rebind, so the memory-only
 *   judgment was blind on exactly the "restart then first ask" shape u1
 *   hit (three error variants, no teaching).
 * Both probes are best-effort: no envStore / unknown agent / probe fault →
 * the plain error stands. Pure copy, no new fields.
 */
export function restartTeachingSuffix(ctx: AgentNLRoutesContext, agentId: string): string {
  if (ctx.envStore === undefined) return '';
  let envId: string | undefined;
  try {
    envId = ctx.envStore.getAgent(agentId)?.env_id;
  } catch {
    return '';
  }
  if (envId === undefined) return '';
  let survived = false;
  try {
    survived = ctx.worldSessions?.statusOf(envId) !== undefined;
  } catch {
    survived = false; // view fault — fall through to the disk half
  }
  if (!survived) {
    try {
      survived = ctx.worldSessionCheckpointProbe?.(envId) === true;
    } catch {
      survived = false; // probe fault — the plain error stands
    }
  }
  if (!survived) return '';
  return ' — 服务器曾重启：旧的普通仿真不跨重启存活，请用 sim list 查看当前可用仿真并重建' +
    '（世界会话已从检查点恢复）。(The server was restarted: plain simulations do not survive a ' +
    'restart — `eaf sim list` shows the simulations that exist now, recreate what you need; ' +
    'the authoritative world session was restored from its checkpoint.)';
}

/**
 * T93 (R14, u3-F1): the frozen-world honesty face. A sim that resolved but
 * is NOT running still answers ask/command out of its FROZEN runtime (the
 * registry keeps stopped runtimes; only the implicit search skips them) —
 * u3 asked a stopped sim about "current" humidity and got present-tense
 * readings with no disclosure (command-log proved simTimeSec frozen at the
 * stop moment). Not allowed: any frozen-state answer must say so FIRST.
 * The state word is the runtime vocabulary (`sim list`'s word); stopped is
 * terminal, paused/created are the caller's own frozen worlds.
 */
const FROZEN_STATE_ZH: Record<string, string> = {
  stopped: '已停止（stop 为终态）',
  paused: '已暂停',
  created: '已创建但从未启动',
};

/** The T93 disclosure line for a non-running sim, undefined when running. */
export function frozenWorldDisclosureOf(record: SimulationRecord): string | undefined {
  let state: string;
  try {
    state = record.runtime.getState();
  } catch {
    return undefined; // state unreadable — no claim, no disclosure to fake
  }
  if (state === 'running') return undefined;
  let simTimeSec = 0;
  try {
    simTimeSec = record.runtime.getSimTimeSec();
  } catch {
    simTimeSec = 0; // frozen clock unreadable — the line still says FROZEN
  }
  const zh = FROZEN_STATE_ZH[state] ?? `处于 ${state}（非运行态）`;
  return (
    `⚠ 该仿真${zh}：以下内容基于它在 simTimeSec=${simTimeSec} 时刻的冻结状态，` +
    '不是世界的当前读数。' +
    ` (This simulation is ${state} — the answer below is based on its frozen state at ` +
    `simTimeSec=${simTimeSec}, not on the current world.)`
  );
}

/** Resolve the live record for an agent id, with the body's simId hint. */

/**
 * T98 (R15, u4-F1): a unique short id resolves to the full agent id. Rosters
 * and habit hand users 8-char prefixes (`dcf6142c`); the runtime map is
 * exact-keyed, so every such ask/what-if/command 404'd in ~1ms with a
 * "create or resume first" teaching — while the same window's FULL-id asks
 * answered in seconds (demo-log proven: u4's short-id probes all 404'd, her
 * full-id probes all 200'd — the agents had hatched all along). Minimum
 * length guards against 1-3 char nonsense prefixes matching half a world.
 */
const MIN_AGENT_PREFIX_LEN = 4;

/**
 * T98: the runtime's running agent ids, read off its OWN snapshot surface —
 * the scan runs ONLY on the exact-miss fallback (a snapshot here is fine;
 * the hot path stays the exact map lookup). A snapshot fault yields nothing:
 * the scan finds no candidate and the honest teaching stands.
 */
function agentIdsOf(record: SimulationRecord): string[] {
  try {
    return record.runtime.getSnapshot().agents.map(agent => agent.id);
  } catch {
    return [];
  }
}

/**
 * T102 (R16, u1-F16-1 / u2-#1 / u4-F1): the runtime agents carrying this
 * exact DISPLAY NAME — the roster's user-facing identifier, half of the T98
 * promise the id lanes shipped without. Exact match only (deterministic;
 * the roster prints the exact spelling) and full ids out.
 */
function agentIdsByNameOf(record: SimulationRecord, name: string): string[] {
  try {
    return record.runtime.getSnapshot().agents
      .filter(agent => agent.name === name)
      .map(agent => agent.id);
  } catch {
    return [];
  }
}

/**
 * T98: resolve `ref` against ONE runtime — exact hit first, then a unique
 * prefix, then (T102) a unique display NAME. Returns the resolved id or all
 * matching full ids (empty when nothing matches, >1 when ambiguous).
 */
function resolveAgentRefInRuntime(
  record: SimulationRecord,
  ref: string,
): { id?: string; matches: string[] } {
  if (record.runtime.getAgent(ref) !== undefined) return { id: ref, matches: [ref] };
  if (ref.length < MIN_AGENT_PREFIX_LEN) return { matches: [] };
  const matches = agentIdsOf(record).filter(id => id.startsWith(ref));
  if (matches.length === 1) return { id: matches[0], matches };
  if (matches.length > 1) return { matches };
  const byName = agentIdsByNameOf(record, ref);
  return { id: byName.length === 1 ? byName[0] : undefined, matches: byName };
}

/**
 * T98: the honest no-match teaching. Two genuinely different states live
 * behind "AGENT_NOT_FOUND" and the old one-size message pointed both at
 * "create or resume" — sending u4 into a create/start/wait loop that could
 * never fix a short-id typo. When the id EXISTS in an env DB row, the world
 * simply is not running (the create/resume pointer is the truth); when it
 * does not, the id itself is the suspect (the roster/full-id pointer).
 *
 * T102 (R16, u4-F1): the ref may be a DISPLAY NAME, and the old copy
 * asserted falsehoods in that case ("a short id copied from a roster" about
 * an obviously-Chinese name; "the agent may not be running" while it ran in
 * two live sims under that very name). The teaching now splits on id-likeness:
 * an id-shaped ref keeps the id lanes; a name-shaped ref (anything that is
 * not hex/dash, as agent ids are) says what a name mismatch means and where
 * the roster is — no false "it may not be running" claim.
 * Exported pure for the suite (the env-session makes the registered branch
 * near-unreachable over HTTP — it spins up with the env's agents).
 */
export function agentNotFoundTeaching(ctx: AgentNLRoutesContext, agentRef: string): string {
  const row = ctx.envStore !== undefined ? ctx.envStore.getAgent(agentRef) : undefined;
  if (row !== undefined) {
    return (
      `The agent exists (environment "${row.env_id}") but no live simulation is running it — ` +
      'natural-language commands reach RUNNING agents only: create or resume a simulation of its ' +
      'environment first (POST /api/simulations { environmentId }, then /start). ' +
      'World-object management uses PATCH /api/agents/:id.'
    );
  }
  if (!/^[0-9a-f][0-9a-f-]*$/i.test(agentRef)) {
    // Name-shaped: agent ids are hex+dashes, so this ref was likely a
    // display name — state the name-match outcome honestly.
    return (
      `No running agent carries the display name "${agentRef}" — names match exactly and must be ` +
      'unique on this channel; several agents sharing one name are refused with AGENT_AMBIGUOUS. ' +
      'Check the spelling against the roster (`eaf agent list --env <id|name>` prints every agent ' +
      'with its full id); if you meant an id instead, pass the FULL agent id — a unique short prefix ' +
      'also works. World-object management uses PATCH /api/agents/:id.'
    );
  }
  return (
    `No running agent matches this exact id — if "${agentRef}" is a short id copied from a roster, ` +
    'pass the FULL agent id (`eaf agent get <prefix>` or `eaf agent list --env <id|name>` prints it; ' +
    'a unique short prefix is also accepted here). If the id is complete, the agent may not be running: ' +
    'create or resume a simulation of its environment first. ' +
    'World-object management uses PATCH /api/agents/:id.'
  );
}

function resolveAgentRecord(
  ctx: AgentNLRoutesContext,
  agentRef: string,
  simId: unknown,
  viewer?: AuthUser,
): { record: SimulationRecord; agentId: string; defaultSimNote?: string } {
  if (typeof simId === 'string' && simId.length > 0) {
    let record: SimulationRecord;
    try {
      record = ctx.registry.getLiveOrThrow(simId);
    } catch (error) {
      // T92 (R13, u1-F1): the caller named a sim that is NOT in the live
      // registry — the pre-restart ghost shape. When this agent's environment
      // carries a world session (the thing that DID survive), append the
      // restart teaching so "not found" cannot read as data loss. The
      // hibernated 409 already teaches its own resume path — untouched.
      if (error instanceof ApiError && error.statusCode === 404) {
        const teaching = restartTeachingSuffix(ctx, agentRef);
        if (teaching !== '') {
          throw new ApiError(404, 'SIMULATION_NOT_FOUND', `${error.message}${teaching}`);
        }
      }
      throw error;
    }
    const resolved = resolveAgentRefInRuntime(record, agentRef);
    if (resolved.id !== undefined) return { record, agentId: resolved.id };
    if (resolved.matches.length > 1) {
      throw new ApiError(
        409,
        'AGENT_AMBIGUOUS',
        `Agent reference "${agentRef}" is ambiguous in simulation "${simId}" — ` +
          `${resolved.matches.length} running agents match this reference (id prefix or display name): ` +
          `${resolved.matches.join(', ')} — pass the full agent id`,
      );
    }
    throw new ApiError(
      404,
      'AGENT_NOT_FOUND',
      `Agent "${agentRef}" is not running in simulation "${simId}" — ${agentNotFoundTeaching(ctx, agentRef)}`,
    );
  }
  const matches = ctx.registry.findLiveRecordsByAgent(agentRef);
  if (matches.length === 0) {
    // T98: the prefix scan — one pass over every live runtime's agent ids.
    // Exactly one full id anywhere → proceed as if that id was given (it may
    // still be ambiguous ACROSS sims → the AGENT_AMBIGUOUS roster below, now
    // with the correct full id). Several full ids → the honest ambiguity
    // teaching. None → the honest no-match teaching above.
    const byFullId = new Map<string, number>();
    if (agentRef.length >= MIN_AGENT_PREFIX_LEN) {
      for (const record of ctx.registry.liveRecords()) {
        for (const id of agentIdsOf(record)) {
          if (id.startsWith(agentRef)) byFullId.set(id, (byFullId.get(id) ?? 0) + 1);
        }
      }
    }
    if (byFullId.size === 1) {
      const [fullId] = [...byFullId.keys()];
      return resolveAgentRecord(ctx, fullId!, simId, viewer);
    }
    if (byFullId.size > 1) {
      throw new ApiError(
        409,
        'AGENT_AMBIGUOUS',
        `Agent reference "${agentRef}" is ambiguous — ${byFullId.size} running agents match this prefix: ` +
          `${[...byFullId.keys()].join(', ')} — pass the full agent id`,
      );
    }
    // T102 (R16, u1/u2/u4): the display-NAME scan — the roster's user-facing
    // identifier, the half of T98 the id lanes shipped without. Exactly one
    // named agent live anywhere → resolve as if that id was given (multi-sim
    // ambiguity, if any, is thrown one frame later with the sim roster);
    // several carriers → the honest naming; none → the name-aware teaching.
    const byName = new Map<string, number>();
    for (const record of ctx.registry.liveRecords()) {
      for (const id of agentIdsByNameOf(record, agentRef)) {
        byName.set(id, (byName.get(id) ?? 0) + 1);
      }
    }
    if (byName.size === 1) {
      const [fullId] = [...byName.keys()];
      return resolveAgentRecord(ctx, fullId!, simId, viewer);
    }
    if (byName.size > 1) {
      throw new ApiError(
        409,
        'AGENT_AMBIGUOUS',
        `"${agentRef}" is the display name of ${byName.size} running agents — ` +
          `${[...byName.keys()].join(', ')} — pass the full agent id (\`eaf agent list --env <id|name>\` prints them)`,
      );
    }
    throw new ApiError(
      404,
      'AGENT_NOT_FOUND',
      `No live simulation is running agent "${agentRef}". ${agentNotFoundTeaching(ctx, agentRef)}` +
        // T92: u1 held pre-restart sim ids and read the bare NOT_FOUND as
        // "everything is gone". When the env carries a world session (the
        // thing that survives), say so.
        restartTeachingSuffix(ctx, agentRef),
    );
  }
  if (matches.length > 1) {
    // T122 (R17-u3/R19-u4): the environment owner's default-simulation
    // binding disambiguates BEFORE the roster 409 — a shared multi-sim env
    // with a declared default world answers instead of teaching every time.
    // The binding must be LIVE and must name one of the CANDIDATES (the
    // agent must actually run there); exactly one candidate env's binding
    // qualifies → resolve to it with the disclosure. A stale binding (bound
    // sim stopped/deleted) annotates the honest ambiguity below instead of
    // silently choosing.
    let boundNote: string | undefined;
    const bound = defaultBoundMatchOf(ctx, matches);
    if (bound === 'unavailable') {
      // registry/envStore missing (degenerate harness) — no binding judgment.
    } else if (bound !== undefined) {
      if ('record' in bound) {
        return { record: bound.record, agentId: agentRef, defaultSimNote: bound.note };
      }
      boundNote = bound.note;
    }
    // T52 (R6, u1-F6): the candidates carry state + creator, not bare ids —
    // a bare-id list forced one blind `sim status` probe per candidate. The
    // message teaches the roster command (`eaf sim list --env`).
    const candidates = matches.map(record => {
      const state = record.runtime.getState();
      // T82 (R9, u3-F1): the env's authoritative world session has NO creator
      // — "created by unknown" read as a mystery actor when the row IS the
      // platform's living world (the same row `sim list` marks
      // [world-session]). Name it for what it is; the state word is the SAME
      // runtime vocabulary the roster and `env session status`'s `state`
      // field speak — one caliber across the three faces.
      let detail: string;
      if (record.envSession === true) {
        detail = 'platform world-session';
      } else {
        const creator = record.createdBy !== undefined
          ? ctx.userStore?.findById(record.createdBy)?.display_name ?? record.createdBy
          : 'unknown';
        detail = `created by ${creator}`;
      }
      // 顺带① (R13, u3-P2): mark candidates the CALLER cannot control —
      // another member's sandbox shows in neither `sim list --env` nor any
      // roster the teaching names, so an unmarked candidate read as a bug
      // ("错误给的候选不可见、不可用"). The marker keeps the full roster
      // honest while pointing the caller at their own rows.
      if (viewer !== undefined && !mayControlSim(ctx, record, viewer)) {
        detail += ', restricted for you';
      }
      return `${record.id} (${state}, ${detail})`;
    });
    throw new ApiError(
      409,
      'AGENT_AMBIGUOUS',
      `Agent "${agentRef}" is running in ${matches.length} live simulations: ${candidates.join(', ')} — ` +
        'disambiguate with the body field "simId", or run `eaf sim list --env <id|name>` to see the roster' +
        (boundNote !== undefined ? ` — ${boundNote}` : ''),
    );
  }
  // T130 (R21-F2): the single candidate used to bypass the binding
  // adjudication entirely — an inert binding (the bound sim stopped or
  // deleted) + the agent running in exactly ONE live world answered 200
  // with zero disclosure (R21 leg B: a silent world switch, breaching the
  // help contract's "fall back … disclose it" promise). Run the SAME
  // judgment the multi-candidate path speaks, in its degenerate form:
  // - live binding naming this candidate → the default-binding disclosure
  //   (symmetric with the multi-candidate hit — the answer really did ride
  //   the owner's bound world);
  // - stale binding → the answer rides the actual fall-back world with the
  //   ⚠ inert-binding disclosure + `eaf env set-default-sim <env> --clear`
  //   guidance, worded by the REAL fall-back kind (world-session vs the
  //   caller's own single sim);
  // - no binding (or no stores) → bit-identical to the old behavior
  //   (zero disclosure, zero noise).
  const single = matches[0]!;
  const bound = defaultBoundMatchOf(
    ctx,
    [single],
    single.envSession === true ? { kind: 'world-session' } : { kind: 'own-sim', record: single },
  );
  if (bound !== undefined && bound !== 'unavailable') {
    return { record: single, agentId: agentRef, defaultSimNote: bound.note };
  }
  return { record: single, agentId: agentRef };
}

/**
 * T122 (R17-u3/R19-u4): among AMBIGUOUS agent candidates, the environment
 * owners' default-simulation bindings pick the world. For each candidate's
 * environment (deduped), judge its binding via the SAME shared table the
 * read lanes speak (`judgeDefaultSimBinding`):
 * - the bound sim IS this candidate and RUNNING → a resolving hit, carried
 *   with its zh/en disclosure;
 * - the binding is STALE → carried so the 409 can point at
 *   `eaf env set-default-sim <env> --clear` (honest fall-back, no silent
 *   world switch);
 * - exactly one resolving hit across all candidate envs wins; several (two
 *   envs each binding their candidate) stay ambiguous — the bindings
 *   disagree, so no single owner's answer outranks the other's.
 * Returns undefined when no env carries a binding; 'unavailable' when the
 * harness lacks the stores to judge (no claim made).
 *
 * T130 (R21-F2): the SINGLE-candidate path is the degenerate form of the
 * same judgment — one candidate, one env — so the ask/what-if/command
 * lanes call it there too: a live binding naming the candidate discloses
 * the default-binding world; a stale binding rides the 200 answer with the
 * ⚠ fall-back + `--clear` disclosure (the help contract's promise — never
 * a silent world switch); no binding stays bit-identical silence.
 */
function defaultBoundMatchOf(
  ctx: AgentNLRoutesContext,
  matches: SimulationRecord[],
  /**
   * T130 (R21-F2): how the STALE disclosure words the world that actually
   * answers. The multi-candidate path (the 409 annotation) keeps its
   * original 'world-session' wording when omitted — bit-identical; the
   * single-candidate caller passes the ACTUAL fall-back record so the ⚠
   * line names the world that really served the ask (the session, or the
   * caller's own single sim) instead of a hardcoded guess.
   */
  staleFallback?: { kind: 'world-session' } | { kind: 'own-sim'; record: SimulationRecord },
): { record: SimulationRecord; note: string } | { note: string } | 'unavailable' | undefined {
  if (ctx.envStore === undefined) return 'unavailable';
  const envIds = [...new Set(matches.map(record => record.environmentId).filter((id): id is string => id !== undefined))];
  if (envIds.length === 0) return undefined;
  const hits: SimulationRecord[] = [];
  const stale: string[] = [];
  for (const envId of envIds) {
    const binding = judgeDefaultSimBinding(
      { envStore: ctx.envStore, registry: ctx.registry },
      envId,
    );
    if (binding === undefined) continue;
    if ('reason' in binding) {
      stale.push(
        (staleFallback !== undefined && staleFallback.kind === 'own-sim'
          ? defaultSimNoteOf({ kind: 'own-sim', staleBinding: binding, record: staleFallback.record })
          : defaultSimNoteOf({ kind: 'world-session', staleBinding: binding })) ?? '',
      );
      continue;
    }
    const hit = matches.find(record => record.id === binding.simulationId);
    if (hit !== undefined) hits.push(hit);
    // The binding names a live sim that is NOT among the candidates: the
    // agent does not run in the bound world — the binding cannot answer
    // this reference, the roster stays the honest face. No note (the
    // disclosure would name a world that cannot serve the ask).
  }
  if (hits.length === 1) {
    const record = hits[0]!;
    const note = defaultSimNoteOf({ kind: 'default-binding', record })!;
    return { record, note };
  }
  if (hits.length > 1 || stale.length === 0) return undefined;
  return { note: stale.join(' ') };
}

function parseBody(body: unknown, usage: string): { text: string; simId?: string } {
  const record = (body ?? {}) as NLBody;
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    // Rename trap check before the generic error (platform lesson: name the
    // dropped intent's real home).
    if (typeof (record as Record<string, unknown>).command === 'string') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "command" is not recognized — did you mean "text"?');
    }
    if (typeof (record as Record<string, unknown>).question === 'string') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "question" is not recognized — did you mean "text"?');
    }
    throw new ApiError(400, 'BAD_REQUEST', `Body field "text" must be a non-empty string (${usage})`);
  }
  if (record.text.length > 2000) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "text" is capped at 2000 characters');
  }
  if (record.simId !== undefined && (typeof record.simId !== 'string' || record.simId.length === 0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "simId" must be a non-empty string when provided');
  }
  return {
    text: record.text,
    ...(typeof record.simId === 'string' && record.simId.length > 0 ? { simId: record.simId } : {}),
  };
}

/**
 * Zone views for the NL seam, from the live world snapshot.
 *
 * T10 (R2, u3-F2):「辖区优先窗口」— the window used to be the snapshot's
 * FIRST 32 zones, so on a 93-zone campus (XJTU-R2) an A/B-栋 guard agent's
 * own district fell outside it, the CognitiveAgent backfill injected the
 * managed zones WITHOUT parameters, and the guard honestly answered
 * 「暂无读数」 about its own jurisdiction — unexplored presented as
 * no-finding. Now the asked agent's managed zones are PINNED into the view
 * with their live parameters (explicitly fetched from the full snapshot by
 * id), then the window fills in original order up to the same cap.
 */
function zoneViewsOf(record: SimulationRecord, managedZoneIds: readonly string[] = []): NLZoneView[] {
  try {
    const snapshot = record.runtime.getSnapshot();
    const toView = (zone: { id: string; name?: string; parameters: Record<string, number | boolean> }): NLZoneView => ({
      zoneId: zone.id,
      ...(zone.name !== undefined && zone.name.length > 0 ? { name: zone.name } : {}),
      parameters: zone.parameters,
    });
    const all = snapshot.zones;
    if (managedZoneIds.length === 0 || all.length <= ZONE_VIEW_WINDOW) {
      return all.slice(0, ZONE_VIEW_WINDOW).map(toView);
    }
    const managed = new Set(managedZoneIds);
    const pinned = all.filter(zone => managed.has(zone.id)).map(toView);
    const rest = all.filter(zone => !managed.has(zone.id)).map(toView);
    return [...pinned, ...rest].slice(0, ZONE_VIEW_WINDOW);
  } catch {
    return []; // honest empty view — the pipeline degrades to device zones
  }
}

/**
 * T101 (R16, u3-F-16-1 / u4-F2): the ASK lane's zone view — the agent's
 * JURISDICTION, not the pinned window. The old view pinned the managed
 * zones first but then filled the remaining window slots with foreign
 * zones, so a question naming a foreign zone ("D栋图书馆现在温度多少?") hit
 * the foreign zones in the view and the answer body dumped THEIR live
 * readings — directly contradicting the T100 disclosure on the same reply
 * ("下面是它自己辖区的读数"). u4 read three buildings in one sentence; the
 * warning promised bldg-m-f1 and the body delivered D/E/F. The ask answer
 * now reads ONLY what the agent manages (the unmanaged campus stays with
 * the disclosure's manager pointer); agents with no jurisdiction keep the
 * full window (a global agent's jurisdiction IS the campus).
 */
function askZoneViewsOf(record: SimulationRecord, managedZoneIds: readonly string[] = []): NLZoneView[] {
  if (managedZoneIds.length === 0) return zoneViewsOf(record, managedZoneIds);
  try {
    const snapshot = record.runtime.getSnapshot();
    const managed = new Set(managedZoneIds);
    const own = snapshot.zones
      .filter(zone => managed.has(zone.id))
      .map(zone => ({
        zoneId: zone.id,
        ...(zone.name !== undefined && zone.name.length > 0 ? { name: zone.name } : {}),
        parameters: zone.parameters,
      }));
    // Paranoid: an agent whose managed rows reference zones the runtime does
    // not know degrades to the pinned window (an empty honest view would
    // teach nothing) — the disclosure logic owns the honesty claim there.
    return own.length > 0 ? own : zoneViewsOf(record, managedZoneIds);
  } catch {
    return []; // honest empty view — the pipeline degrades to device zones
  }
}

/** T10: how many zones the NL seam's zone view carries (unchanged cap). */
const ZONE_VIEW_WINDOW = 32;

/**
 * T10: the asked agent's managed zones — the LIVE env row when the sim is
 * env-backed (a post-sim re-zoning is the current truth), the frozen
 * scenario otherwise.
 */
function managedZonesOfAgent(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  agentId: string,
): string[] {
  if (ctx.envStore !== undefined) {
    const row = ctx.envStore.getAgent(agentId);
    if (row !== undefined) {
      const parsed = parseJsonArray<string>(row.managed_zone_ids_json ?? '[]');
      if (parsed.length > 0) return parsed;
    }
  }
  return record.runtime.scenario.agents.find(a => a.id === agentId)?.managesZoneIds ?? [];
}

/**
 * T105 (R17): the FULL world zone list — the ask lane's zone-MENTION
 * resolution surface. The answer view stays jurisdiction-pinned
 * (`askZoneViewsOf`), while the parse resolves mentions against the whole
 * world so a foreign building mention lands in `intent.targetZones` (the one
 * judgment input the disclosure consumes). Undefined on a snapshot fault —
 * the ask then parses against its own view and the disclosure stays silent
 * (no snapshot, no claim).
 */
function worldZoneViewsOf(record: SimulationRecord): NLZoneView[] | undefined {
  try {
    return record.runtime.getSnapshot().zones.map(zone => ({
      zoneId: zone.id,
      ...(zone.name !== undefined && zone.name.length > 0 ? { name: zone.name } : {}),
      parameters: zone.parameters,
    }));
  } catch {
    return undefined;
  }
}

/**
 * T100 (R15, u3-F2) + T105 (R17, u1-F1/F2 + u4-F1): the ask lane's zone
 * disclosure — reworked to the SINGLE-口径 judgment.
 *
 * T100's original pass re-matched the RAW text against the full world zone
 * list with its own unconstrained `matchZones` call — a SECOND mention layer
 * that disagreed with the parsed intent: an own-zone exact ask (「A栋1层」,
 * targetZones=[bldg-a-f1]) warned about the sibling floors the building
 * prefix dragged in ("按原文展开" — the user never named them); a loose alias
 * on the agent's OWN zone (「M栋一层/1F」 → bldg-m-f1) fabricated a 「2F」
 * call-out; and an EN question ("building B") matched nothing and bypassed
 * the protection entirely.
 *
 * The disclosure now consumes ONLY the parsed `intent.targetZones` — the
 * world-surface mention resolution the ask pipeline itself ran (one matcher,
 * runNLAsk writes it back onto the intent; EN folds through the same scorer)
 * — intersected with the agent's jurisdiction. Wording cites the REAL parsed
 * zone names; nothing is ever named the user's words did not resolve to.
 *
 * T106 (R17, u3-N2 / u1-F3): when the question DOES carry a zone noun but the
 * resolution found nothing (「Z栋…」), the silent substitution onto the
 * agent's own jurisdiction is disclosed too — the same honesty the
 * cross-district warning already speaks.
 */
function jurisdictionNoteOf(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  agentId: string,
  intent: NLCommandIntent,
  allZones: NLZoneView[],
): { note: string; outsideZones?: Array<{ zoneId: string; name?: string }> } | undefined {
  const managed = managedZonesOfAgent(ctx, record, agentId);
  if (managed.length === 0) return undefined; // no jurisdiction — nothing to be outside of
  const managedSet = new Set(managed);
  // The world-surface resolution outcome rides the intent (`worldMentions`,
  // possibly EMPTY); an older core without it falls back to targetZones.
  const resolved = intent.worldMentions ?? intent.targetZones ?? [];
  const zoneById = new Map(allZones.map(z => [z.zoneId, z] as const));
  if (resolved.length > 0) {
    const outside = resolved
      .filter(zoneId => !managedSet.has(zoneId))
      .map(zoneId => {
        const zone = zoneById.get(zoneId);
        return { zoneId, ...(zone?.name !== undefined ? { name: zone.name } : {}) };
      });
    if (outside.length === 0) return undefined; // every resolved zone is in-jurisdiction — zero打扰
    const namedLabel = outside
      .map(zone => zone.name ?? zone.zoneId)
      .join('、');
    // The pointer half: who DOES manage the named zones (env rows when the
    // sim is env-backed; the frozen scenario otherwise) — one helper shared
    // with the what-if lane's disclosure (T109).
    const managerText = managerPointerOf(ctx, record, outside);
    const note =
      `⚠ 你点名的分区「${namedLabel}」不在该 agent 的辖区——下面是它自己辖区（${managed.join(', ')}）的读数，` +
      `不是你点名分区的数据。${managerText} ` +
      `(The named zone(s) are outside this agent's jurisdiction — the answer below reads its OWN zones, ` +
      'not the one you named.)';
    return { note, outsideZones: outside };
  }
  // T106: the question names a zone that resolved to NOTHING — the answer
  // below is the agent's own jurisdiction, and it says so (never a silent
  // substitution; same bilingual disclosure form as the out-of-jurisdiction
  // note above — the ask lane's copy point). Gated on the world-surface
  // resolution outcome (worldMentions === []), NOT on the parse guess: the
  // LLM lane fills targetZones with jurisdiction zones for ANY question, and
  // that guess must not mask the failed resolution.
  const named = unresolvedZoneMentionOf(intent.rawText);
  if (named === undefined) return undefined; // the question names no zone at all
  const note =
    `⚠ 你点名的「${named}」未能定位到任何真实分区——下面是它自己辖区（${managed.join(', ')}）的读数，` +
    `不是你点名分区的数据；请核对分区名后再问（\`eaf env get --full\` 的 zones 表有全部分区）。` +
    ` (The named zone "${named}" did not match any real zone — the answer below reads this agent's OWN ` +
    'jurisdiction, not the zone you named.)';
  return { note };
}

/**
 * The manager pointer shared by the ask lane's jurisdiction disclosure
 * (T105) and the what-if lane's (T109): who DOES manage the named zones —
 * env rows when the sim is env-backed, the frozen scenario otherwise.
 */
function managerPointerOf(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  outside: ReadonlyArray<{ zoneId: string }>,
): string {
  const managers = new Set<string>();
  if (ctx.envStore !== undefined && record.environmentId !== undefined) {
    for (const row of ctx.envStore.agentsOf(record.environmentId)) {
      const zones = parseJsonArray<string>(row.managed_zone_ids_json ?? '[]');
      if (outside.some(zone => zones.includes(zone.zoneId))) managers.add(row.name);
    }
  } else {
    for (const agent of record.runtime.scenario.agents) {
      if (agent.managesZoneIds.some(zoneId => outside.some(zone => zone.zoneId === zoneId))) {
        managers.add(record.runtime.scenario.agents.find(a => a.id === agent.id)?.name ?? agent.id);
      }
    }
  }
  return managers.size > 0
    ? `该分区由 ${[...managers].join('、')} 管理（\`eaf agent list --env\` 查看花名册）。`
    : `用 \`eaf agent list --env\` 找到管理该分区的 agent 再问。`;
}

/**
 * T109 (R18, u1-F1): the intervention's target zone(s) — the judgment input
 * for the what-if jurisdiction disclosure below. Device lanes resolve the
 * target device's zone through the parse views (the runtime+env union the
 * parse itself used); parameter/event lanes target a zoneId directly. A
 * zoneless device (or an unreadable snapshot) yields NOTHING — no zone, no
 * jurisdiction claim.
 */
function interventionTargetZoneIdsOf(
  intervention: WhatIfIntervention,
  views: ReadonlyArray<{ deviceId: string; zoneId?: string | null }>,
  record: SimulationRecord,
): string[] {
  const target = intervention.target;
  if (target === undefined) return [];
  if (intervention.type === 'parameter_change' || intervention.type === 'event_injection') {
    return [target];
  }
  const fromView = views.find(view => view.deviceId === target)?.zoneId;
  if (fromView !== undefined && fromView !== null) return [fromView];
  try {
    const device = record.runtime.getSnapshot().devices.find(d => d.id === target);
    if (device !== undefined) return [device.zoneId];
  } catch {
    // snapshot fault — no zone claim, the disclosure stays silent
  }
  return [];
}

/**
 * T109 (R18, u1-F1): the WHAT-IF lane's jurisdiction disclosure — the same
 * single-口径 judgment as the ask lane's `jurisdictionNoteOf` (T105), wired
 * at the what-if assembly point. A cross-district intervention (u1 asked the
 * A栋 butler to preview a B栋 device and got a delta table with zero
 * disclosure — it read like the agent could operate B栋) is never previewed
 * silently: the response names the real target zone(s), states the authority
 * boundary (a fork simulation grants no operating right — executing it for
 * real needs the district's manager), and points at the roster. In-jurisdiction
 * targets and jurisdiction-less agents stay untouched (zero打扰, same as ask).
 */
function whatIfJurisdictionNoteOf(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  agentId: string,
  targetZoneIds: ReadonlyArray<string>,
  allZones: NLZoneView[],
): { note: string } | undefined {
  const managed = managedZonesOfAgent(ctx, record, agentId);
  if (managed.length === 0) return undefined; // no jurisdiction — nothing to be outside of
  const managedSet = new Set(managed);
  const zoneById = new Map(allZones.map(z => [z.zoneId, z] as const));
  const outside = [...new Set(targetZoneIds)]
    .filter(zoneId => !managedSet.has(zoneId))
    .map(zoneId => {
      const zone = zoneById.get(zoneId);
      return { zoneId, ...(zone?.name !== undefined ? { name: zone.name } : {}) };
    });
  if (outside.length === 0) return undefined; // in-jurisdiction intervention — zero打扰
  const namedLabel = outside.map(zone => zone.name ?? zone.zoneId).join('、');
  const note =
    `⚠ 你点名的干预目标分区「${namedLabel}」不在该 agent 的辖区——下面的预演是对他人辖区设备的 fork 演练，` +
    '不代表该 agent 有操作权；真正执行需经辖区管理方（合约或提案）。' +
    `${managerPointerOf(ctx, record, outside)} ` +
    "(The intervention target zone(s) are outside this agent's jurisdiction — the prediction below is a " +
    "fork simulation of another district's device, not an authority to act; executing it for real requires " +
    'the district\'s manager (an agreement or a proposal).)';
  return { note };
}

function auditLog(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const row = {
    agentId: payload.agentId as string,
    kind,
    nlAction: payload.intentAction as string,
    decisionSource: payload.decisionSource,
    executed: payload.executedCommands as number,
    success: payload.success as boolean,
    preview: payload.textPreview as string,
  };
  logger.info(`[${kind}] sim=${record.id} user=${user.id} ${JSON.stringify(row)}`);
  // command_log is env-scoped: scenario sims without an environment have no
  // audit table row (the log line above is the durable trace for them).
  if (record.environmentId === undefined || ctx.commandLogStore === undefined) return;
  try {
    ctx.commandLogStore.append({
      envId: record.environmentId,
      actorId: user.id,
      kind,
      payload: {
        simId: record.id,
        simTimeSec: record.runtime.getSimTimeSec(),
        ...payload,
      },
      simTime: record.runtime.getSimTimeSec(),
    });
  } catch (error) {
    logger.warn(`[${kind}] command_log append failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Emergency escalation: env owner notification (task §6). */
function escalateToOwner(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  user: AuthUser,
  agentId: string,
  text: string,
): void {
  if (record.environmentId === undefined || ctx.notificationStore === undefined || ctx.envStore === undefined) {
    return;
  }
  try {
    const env = ctx.envStore.getEnvironment(record.environmentId);
    const ownerId = env?.owner_id;
    if (ownerId === undefined || ownerId === user.id) return; // commander IS the owner
    // R84 (R44-F2 teach-back): env-backed agent ids are UUIDs — the owner
    // notification names the agent, never the raw id (F0-3 红线同族）。
    const agentName = ctx.envStore.getAgent(agentId)?.name ?? agentId;
    notify(ctx.notificationStore, {
      recipientId: ownerId,
      actorId: user.id,
      envId: record.environmentId,
      kind: NOTIFICATION_KINDS.agentEscalated,
      title: `Emergency escalation from agent "${agentName}"`,
      body: {
        summary:
          `User ${user.email} sent an emergency command ("${text.slice(0, 120)}") to agent "${agentName}" in ` +
          `simulation "${record.id}". The agent escalated immediately without device actions.`,
        simId: record.id,
        agentId,
      },
    });
  } catch (error) {
    logger.warn(`emergency notification failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// Phase 4 — the what-if lane (predictive modeling, §4.4)
// ============================================================================

/** Rename hints for the what-if body (the standing trap: name the home). */
const WHAT_IF_RENAME_HINTS: Record<string, string> = {
  question: 'text',
  scenario: 'intervention',
  hypothesis: 'intervention',
  horizonSec: 'durationSec',
  duration: 'durationSec',
  lookaheadSec: 'durationSec',
  sim: 'simId',
  simulation: 'simId',
};

const WHAT_IF_BODY_FIELDS = ['text', 'intervention', 'metrics', 'durationSec', 'simId'] as const;

interface WhatIfRequestInput {
  text?: string;
  intervention?: WhatIfIntervention;
  metrics?: WhatIfMetric[];
  durationSec?: number;
  simId?: string;
}

/** Reject unknown fields (a dropped field here silently changes the test). */
function rejectUnknownWhatIfFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter(key => !(WHAT_IF_BODY_FIELDS as readonly string[]).includes(key));
  if (unknown.length === 0) return;
  const named = unknown
    .map(key => (WHAT_IF_RENAME_HINTS[key] !== undefined ? `"${key}" (did you mean "${WHAT_IF_RENAME_HINTS[key]}"?)` : `"${key}"`))
    .join(', ');
  throw new ApiError(
    400,
    'BAD_REQUEST',
    `Body has unknown field${unknown.length > 1 ? 's' : ''} ${named}. Accepted: ${WHAT_IF_BODY_FIELDS.map(f => `"${f}"`).join(', ')}. ` +
      'Unknown fields are rejected (not silently dropped) — a dropped field here would silently change what the prediction tests.',
  );
}

/** The zone an intervention acts on (device → its zone; zone target → itself). */
function zoneOfIntervention(record: SimulationRecord, intervention: WhatIfIntervention): string | undefined {
  if (intervention.type === 'parameter_change' || intervention.type === 'event_injection') {
    return intervention.target;
  }
  if (intervention.target === undefined) return undefined;
  return record.runtime.getSnapshot().devices.find(d => d.id === intervention.target)?.zoneId;
}

/**
 * Default metric set for a what-if: the intervention zone's comfort trio.
 * Zone-less (no zone resolvable) falls back to the averaged view.
 */
export function defaultWhatIfMetrics(record: SimulationRecord, intervention: WhatIfIntervention): WhatIfMetric[] {
  const zoneId = zoneOfIntervention(record, intervention);
  return [
    { name: 'temperature', ...(zoneId !== undefined ? { zoneId } : {}) },
    { name: 'energy', ...(zoneId !== undefined ? { zoneId } : {}) },
    { name: 'comfort', ...(zoneId !== undefined ? { zoneId } : {}) },
  ];
}

/**
 * The platform's VERIFY-BEFORE-ACT seam for the /command lane: run the
 * would-be command on a private fork of the CURRENT world. Read-only with
 * respect to the live runtime (one snapshot export per verification).
 *
 * R40-B1: the window honors the scenario's what-if quota when it is
 * tighter than the platform's default verification window (a 300s-budget
 * world must not fail its own safety seam over a 600s fork).
 */
function makeVerifyWhatIfSeam(
  record: SimulationRecord,
): (intervention: WhatIfIntervention) => Promise<import('@active-collaboration/core').WhatIfResult | null> {
  const durationSec = Math.min(
    WHAT_IF_DEFAULT_DURATION_SEC,
    whatIfMaxDurationSecOf(record.runtime.scenario),
  );
  return async intervention =>
    runWhatIf(
      { scenario: record.runtime.scenario, worldState: record.runtime.exportWorldState() },
      {
        intervention,
        metrics: defaultWhatIfMetrics(record, intervention),
        durationSec,
      },
    );
}

export function registerAgentNLRoutes(app: FastifyInstance, ctx: AgentNLRoutesContext): void {
  app.post('/api/agents/:id/what-if', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const startedAtMs = Date.now();

    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object ({ text } | { intervention, metrics?, durationSec? }, plus optional simId)');
    }
    const body = request.body as Record<string, unknown>;
    rejectUnknownWhatIfFields(body);

    const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
    const hasIntervention = body.intervention !== undefined;
    if (hasText && hasIntervention) {
      throw new ApiError(400, 'BAD_REQUEST', 'Provide EITHER "text" (parsed) OR "intervention" (structured) — not both');
    }
    if (!hasText && !hasIntervention) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Provide "text" (e.g. "what if I turn off hvac-1 for 30 minutes?") or the structured "intervention" ({ type, target, action, value? })',
      );
    }
    if (body.text !== undefined && !hasText) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "text" must be a non-empty string');
    }
    if (hasText && (body.text as string).length > 2000) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "text" is capped at 2000 characters');
    }
    let durationSec: number | undefined;
    if (body.durationSec !== undefined) {
      if (
        typeof body.durationSec !== 'number' ||
        !Number.isInteger(body.durationSec) ||
        body.durationSec < 1
      ) {
        throw new ApiError(400, 'BAD_REQUEST', `Body field "durationSec" must be an integer in [1, ${WHAT_IF_MAX_DURATION_SEC}] (simulated seconds of lookahead)`);
      }
      durationSec = body.durationSec;
    }

    // T98 (R15, u4-F1): resolution returns the RESOLVED agent id — a unique
    // short prefix (roster habit) now lands on the full id; the handlers
    // below address the agent ONLY through it.
    const { record, agentId: resolvedAgentId, defaultSimNote } = resolveAgentRecord(ctx, id, body.simId, user);
    assertControl(ctx, record, user);
    // T93 (R14, u3-F1): a STOPPED runtime has no world to fork — the raw
    // engine guard used to surface as a bare INTERNAL_ERROR ("我刚还问得动，
    // 怎么现在内部错误"). Teach the honest paths instead: stop is terminal
    // for plain sims (sim list → recreate), hibernated sims resume.
    if (record.runtime.getState() === 'stopped') {
      throw new ApiError(
        409,
        'SIMULATION_NOT_RUNNING',
        `Simulation "${record.id}" is stopped — a what-if prediction forks the world's LIVE state, and a ` +
          'stopped runtime has none. Stop is terminal for plain simulations: `eaf sim list` shows the worlds ' +
          'that exist now (recreate a sim of this environment); a HIBERNATED sim keeps its world and resumes ' +
          '(POST /api/simulations/:id/resume). ' +
          '该仿真已停止——what-if 预测基于活世界状态的 fork，停止的运行时没有可 fork 的世界。' +
          'stop 是普通仿真的终态：用 `eaf sim list` 查看当前可用世界并重建；休眠（hibernated）的仿真可 ' +
          'resume 后再问。',
      );
    }
    const agent = record.runtime.getAgent(resolvedAgentId)!;

    // R40-B1 quota: the world's own what-if budget (scenario
    // `meta.whatIfQuota.maxDurationSec`, default WHAT_IF_MAX_DURATION_SEC)
    // caps the lookahead — the SAME number the predictor enforces inside
    // runWhatIf, so the teaching error and the enforcement never diverge.
    // Minimal path by design: env-backed worlds build their scenario meta
    // through the environment bridge (no whatIfQuota there yet) and keep
    // the platform default; file/template scenarios carry the quota.
    const maxDurationSec = whatIfMaxDurationSecOf(record.runtime.scenario);
    if (durationSec !== undefined && durationSec > maxDurationSec) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "durationSec" must be an integer in [1, ${maxDurationSec}] (simulated seconds of lookahead)` +
          (maxDurationSec !== WHAT_IF_MAX_DURATION_SEC
            ? ` — this scenario's meta.whatIfQuota.maxDurationSec caps the lookahead at ${maxDurationSec}`
            : ''),
      );
    }

    // Resolve the intervention: structured body, or deterministic text parse
    // against the agent's OWN device surface (one truth with the NL lane).
    let intervention: WhatIfIntervention;
    let textPreview = '';
    // R98: the text parse's disambiguation notes (ambiguous candidates, the
    // chosen device) must reach the response — they were computed and then
    // silently dropped, so a wrong-device answer looked clean (zhao-05).
    let parseNotes: string[] = [];
    // T109 (R18, u1-F1): the jurisdiction-disclosure surfaces, hoisted so the
    // STRUCTURED intervention path resolves the target device's zone through
    // the same union the text parse uses. `worldZones` doubles as the parse's
    // zone-MENTION surface (the runNLAsk mentionZones role): zone clues and
    // zone-named prose resolve against the FULL world so a cross-district
    // intervention resolves honestly — and the disclosure below names it —
    // instead of the old jurisdiction-only surface that silently fell back to
    // the requester's own device with "zone clues [none]" (u1's EN probe).
    const worldZones = worldZoneViewsOf(record);
    const parseViews = mergeEnvDeviceViews(ctx, record, agent.getNLDeviceViews());
    if (hasIntervention) {
      intervention = body.intervention as WhatIfIntervention;
      textPreview = `structured:${intervention.type}:${intervention.target ?? ''}`;
    } else {
      // R42-C: the parse surface must see ENV devices too — the agent's
      // runtime views only cover its frozen-snapshot bindings, so naming a
      // catalog device added after the sim started used to 400 here.
      // T2 (R2, u1-F1): the parse views carry each device's CURRENT control
      // state (targetTemperature …) so a RELATIVE temperature ask ("raise the
      // setpoint by 2 degrees" / 「调高 2 度」) resolves against the real
      // setpoint instead of a teaching rejection — and the LITERAL dispatch
      // face (rawCommands) so a foreign command in the parse budget's
      // world-wide union is mapped ONTO the device's own face instead of
      // 400ing against the fork. Env-row-only devices (no live runtime
      // state) honestly carry neither.
      {
        const stateByDevice = new Map<string, { state: Record<string, unknown>; commands: string[] }>();
        try {
          for (const device of record.runtime.getSnapshot().devices) {
            stateByDevice.set(device.id, { state: device.state ?? {}, commands: [...device.commands] });
          }
        } catch {
          // Snapshot fault — stateless views stay honest (absolute asks only).
        }
        for (const view of parseViews) {
          const face = stateByDevice.get(view.deviceId);
          if (face === undefined) continue;
          view.state = face.state;
          view.rawCommands = face.commands;
        }
      }
      // R49: the agent's OWN surface breaks same-name ties — every district
      // owns a 「排涝智能阀 1」, and the bare substring filter picked an
      // arbitrary one (wrong device, wrong zone).
      // R51: COORDINATORS own no devices, so the own-surface scope is empty —
      // fall back to the devices inside their MANAGED ZONES (their district),
      // keeping "name a device in my jurisdiction" resolvable and correctly
      // district-scoped for the same-name tie-break.
      let ownScope = new Set(agent.getNLDeviceViews().map(view => view.deviceId));
      // R99 (zhao-07): union the environment's CURRENT binding truth — a
      // device bound to the agent AFTER its sim started is absent from the
      // frozen runtime views, so the own-device preference silently missed
      // it and the type-word tie fell to a colleague's device.
      if (record.environmentId !== undefined && ctx.envStore !== undefined) {
        for (const boundId of parseJsonArray<string>(ctx.envStore.getAgent(resolvedAgentId)?.bound_device_ids_json ?? '[]')) {
          ownScope.add(boundId);
        }
      }
      if (ownScope.size === 0 && record.environmentId !== undefined && ctx.envStore !== undefined) {
        const managedZoneIds = new Set(
          parseJsonArray<string>(ctx.envStore.getAgent(resolvedAgentId)?.managed_zone_ids_json ?? '[]'),
        );
        if (managedZoneIds.size > 0) {
          ownScope = new Set(parseViews.filter(v => v.zoneId !== undefined && managedZoneIds.has(v.zoneId)).map(v => v.deviceId));
        }
      }
      const parseOptions = {
        ...(durationSec !== undefined ? { durationSec } : {}),
        maxDurationSec,
        // R83: the unmapped-question teaching error speaks the request locale.
        locale: request.locale,
      };
      const parseScope = {
        deviceIds: ownScope,
        // R83: zone-NAMED prose (「把客厅温度调到 35 度」) resolves through
        // the world's zone names — the device-name bridge cannot see zones.
        // T109: the surface is the FULL world (the runNLAsk mentionZones
        // role) — a foreign-building mention resolves instead of silently
        // missing, and the jurisdiction disclosure owns the honesty.
        zones: worldZones ?? zoneViewsOf(record, managedZonesOfAgent(ctx, record, resolvedAgentId)),
      };
      let parsed = parseWhatIfText(body.text as string, parseViews, parseOptions, parseScope);
      if (parsed === null) {
        // T25 (R3, u1-F2): the teaching names EVERY accepted opener shape —
        // including the hyphen spelling and the zh tail question (which must
        // carry a mappable intervention) — in the request's locale (R102:
        // an error teaches the usable forms, in the reader's language).
        const zh = typeof request.locale === 'string' && request.locale.toLowerCase().startsWith('zh');
        throw new ApiError(
          400,
          'BAD_REQUEST',
          zh
            ? '这段文本不是 what-if 问题——可用句式："what if …" / "what-if …" / "suppose …" / "如果…" 开头，' +
              '或中文句尾问式「……会怎样 / 会怎么样」（需含可映射的干预线索：设备名或开关/调节动词），' +
              '或直接 POST 结构化的 { intervention } 形式'
            : 'The text is not a what-if question — expected an opener like "what if …" / "what-if …" / "suppose …" / "如果…", ' +
              'or a zh tail question like "……会怎样 / 会怎么样" (it must carry a mappable intervention: a device or an ' +
              'adjust/toggle verb), or POST the structured { intervention } form',
        );
      }
      if ('error' in parsed) {
        // T41 (R4, u1-F1): before teaching "reword your question", classify
        // the failure. A question that literally names a device the DB has
        // while the parse views lack it (or empty views on a non-empty DB) is
        // a CATALOG-CHANGE window (batch apply / rehydration) — a 503 with
        // "retry in a moment", never a wording lesson for a healthy sentence.
        // A one-shot re-read + re-parse absorbs the read race; it is NOT a
        // cached directory (the fresh read either answers or confirms 503).
        const catalogChanging = diagnoseCatalogChangingWindow(
          body.text as string,
          parseViews,
          envDeviceRowsOf(ctx, record),
        );
        let recovered: WhatIfTextParse | undefined;
        if (catalogChanging) {
          const freshViews = mergeEnvDeviceViews(ctx, record, agent.getNLDeviceViews());
          const reparsed = parseWhatIfText(body.text as string, freshViews, parseOptions, parseScope);
          if (reparsed !== null && !('error' in reparsed)) recovered = reparsed;
        }
        if (recovered !== undefined) {
          parsed = recovered;
        } else if (catalogChanging) {
          throw worldCatalogChangingError(request.locale);
        } else {
          throw new ApiError(400, 'BAD_REQUEST', parsed.error);
        }
      }
      intervention = parsed.intervention;
      durationSec ??= parsed.durationSec;
      parseNotes = parsed.notes;
      textPreview = (body.text as string).slice(0, 160);
    }

    // R81-D4 (D2-F4 root fix): resolve the fork's WORLD SOURCE — the
    // authoritative world session's current state when the env has one,
    // the agent's own (frozen) sim runtime otherwise. `forkSource` in the
    // response names the world the prediction tested.
    // T27 (R3, u1-F4): an EXPLICIT --sim overrides the session default —
    // the user pointed at a specific world (her own accelerated sim), and
    // "you pointed here, but I simulated the session" makes the fork
    // baseline unreadable (sim-time 270 vs her live 110,520). The session
    // stays the default when --sim is omitted (documented behavior).
    // T127 (R20-u3 N1): a RESOLVED default binding overrides it too —
    // `defaultSimNote !== undefined` here means resolution went THROUGH the
    // owner's binding story, so `record` IS the world the disclosure names:
    // the bound RUNNING sim on a live-binding hit, or — T130 (R21-F2) — the
    // disclosed FALL-BACK world on a stale binding (⚠ line). Forking the
    // session instead made the disclosure and the fork provenance disagree
    // in one output; either way the fork must be the named world.
    const fork = await whatIfForkSourceOf(ctx, record, {
      explicitSim: typeof body.simId === 'string' && body.simId.trim().length > 0,
      defaultBoundSim: defaultSimNote !== undefined,
    });
    const metrics = (body.metrics as WhatIfMetric[] | undefined) ?? defaultWhatIfMetrics(fork.metricsRecord, intervention);
    durationSec ??= WHAT_IF_DEFAULT_DURATION_SEC;

    let result;
    try {
      result = await runWhatIf(fork.source, { intervention, metrics, durationSec });
    } catch (error) {
      if (error instanceof WhatIfValidationError) {
        throw new ApiError(400, 'BAD_REQUEST', error.message);
      }
      throw error;
    }
    // R98: parse-time disambiguation (which device, what else matched) rides
    // the response's notes — the answer must declare its mapping basis.
    if (parseNotes.length > 0) {
      result.notes = [...parseNotes, ...result.notes];
    }
    // T109 (R18, u1-F1): the jurisdiction disclosure — a cross-district
    // intervention is never previewed silently (the same single-口径 judgment
    // as the ask lane's T105 disclosure, wired at the what-if assembly
    // point). The judgment consumes the RESOLVED intervention's target zone
    // (device lanes: the device's zone; parameter/event lanes: the zoneId)
    // — never a second raw-text matcher.
    const jurisdiction = worldZones !== undefined
      ? whatIfJurisdictionNoteOf(
          ctx,
          record,
          resolvedAgentId,
          interventionTargetZoneIdsOf(intervention, parseViews, record),
          worldZones,
        )
      : undefined;

    auditLog(ctx, record, user, AGENT_WHAT_IF_KIND, {
      agentId: resolvedAgentId,
      intentAction: `what-if:${result.scenario.intervention.type}:${result.scenario.intervention.target ?? ''}`,
      decisionSource: 'predictor',
      executedCommands: 0,
      success: true,
      preview: textPreview,
      textPreview,
      verdict: result.verdict,
      forkSource: fork.info.kind,
    });

    return {
      agentId: resolvedAgentId,
      simulationId: record.id,
      simTimeSec: result.forkedAtSimTimeSec,
      durationMs: Date.now() - startedAtMs,
      ...(jurisdiction !== undefined ? { jurisdictionNote: jurisdiction.note } : {}),
      // T122: the env default-binding disclosure — which world the resolved
      // agent came from when the owner's binding decided (R102: rendered on
      // the human face too).
      ...(defaultSimNote !== undefined ? { defaultSimNote } : {}),
      forkSource: fork.info,
      result,
    };
  });

  app.post('/api/agents/:id/command', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { text, simId } = parseBody(request.body, 'e.g. {"text": "make the lobby comfortable for the VIP visit"}');
    // T98 (R15, u4-F1): resolution returns the RESOLVED agent id — a unique
    // short prefix (roster habit) now lands on the full id.
    const { record, agentId: resolvedAgentId, defaultSimNote } = resolveAgentRecord(ctx, id, simId, user);
    assertControl(ctx, record, user, 'query');
    // R99 (zhao-10): the requester-identity gate — a command spends the
    // TARGET agent's decision resources, so it is refused HERE (before the
    // LLM pipeline and before any audit/decision row) unless the caller is
    // the agent owner / env owner / admin / active-agreement consumer.
    // Emergency text is EXEMPT: it bypasses the decision pipeline anyway
    // (no LLM spend — detectEmergency is the parser's own pre-LLM marker),
    // and a bystander's fire alarm must never 403.
    if (!detectEmergency(text)) {
      assertAgentCommandIdentity(ctx, record, user, resolvedAgentId, request.locale);
    }
    // T99 (R15, u3-F1): a STOPPED sim's frozen world is READ-ONLY on this
    // lane — the same caliber as `sim command`/`sim inject` (SIMULATION_STOPPED;
    // paused/created runtimes stay executable, the sim lane's own rule). The
    // T93a frozen disclosure used to prefix the answer while the execution
    // layer still WROTE device state underneath it (u3's snapshot diff:
    // on→off on a fire-drill-sealed sim, reply claimed ✓, verification said
    // "runtime is stopped") — "frozen" must mean frozen. The frozen state
    // stays READABLE: /ask on the same sim keeps answering with the disclosure.
    if (record.runtime.getState() === 'stopped') {
      throw new ApiError(
        409,
        'SIMULATION_STOPPED',
        `Simulation "${record.id}" is stopped — agent commands on a frozen world are refused ` +
          '(stop is terminal for plain simulations: the world can no longer execute or verify anything). ' +
          '`eaf sim list` shows the worlds that exist now (recreate a sim of this environment); ' +
          'the frozen state itself stays readable — /ask on this sim answers with the frozen disclosure. ' +
          '该仿真已停止——已冻结的世界拒绝写入（stop 是普通仿真的终态）。用 `eaf sim list` 查看当前可用世界并重建；' +
          '冻结状态仍可读：对同一仿真 /ask 会带冻结披露作答。',
      );
    }
    const agent = record.runtime.getAgent(resolvedAgentId)!;

    const result: NLCommandResult = await agent.processNaturalLanguageCommand(text, {
      zones: zoneViewsOf(record, managedZonesOfAgent(ctx, record, resolvedAgentId)),
      actor: `user:${user.id}`,
      // Phase 4 VERIFY-BEFORE-ACT: the platform owns the forks (§13.2) —
      // the seam is injected per call, the agent proposes and the
      // simulation verifies. Lane failures degrade to unverified inside
      // core (never a silent block).
      verifyWhatIf: makeVerifyWhatIfSeam(record),
      // R46C-P0-A: device-ownership gates at the execution layer — the NL
      // channel used to bypass the sim channel's org boundary (供电局通过
      // 水务 agent 的 NL 命令关掉水务的阀门, 200). A denial propagates out
      // of the pipeline as its original 403 (request-level failure).
      assertDeviceCommand: deviceId => assertNLDeviceCommand(ctx, record, user, deviceId, request.locale),
    });

    // Task §6: emergency commands escalate immediately (the pipeline already
    // bypassed decisions); surface the owner notification on the env lane.
    if (result.intent.action === 'emergency') {
      escalateToOwner(ctx, record, user, resolvedAgentId, text);
    }

    auditLog(ctx, record, user, AGENT_NL_COMMAND_KIND, {
      agentId: resolvedAgentId,
      intentAction: result.intent.action,
      decisionSource: result.decisionSource,
      executedCommands: result.executionResult.actions.length,
      success: result.executionResult.success,
      textPreview: text.slice(0, 160),
    });

    // R78 病灶 A — 越权指名教学 pass（路由层事后，Agent 面不动）：Agent
    // 无动作时，若文本指名了「环境内存在、不在该 Agent 面上」的设备，
    // 用 owner+服务+合约路径的教学替换泛泛回应（"我正在持续观察局势"）。
    // 只产出文案，不产出提案——所有权 gate 语义零变化。
    let teaching: string | null = null;
    if (
      record.environmentId !== undefined &&
      ctx.envStore !== undefined &&
      ctx.serviceStore !== undefined
    ) {
      try {
        const envDevices = ctx.envStore.devicesOf(record.environmentId);
        const devices = envDevices.map(d => ({
          deviceId: d.id,
          name: d.name,
          type: d.type,
          ...(d.zone_id !== undefined ? { zoneId: d.zone_id } : {}),
          ownerId: d.owner_id,
          ownerName: ctx.userStore?.findById(d.owner_id)?.display_name ?? '其他成员',
        }));
        const agentSurface = new Set(agent.getNLDeviceViews().map(v => v.deviceId));
        // R78-A 修订：混合意图也教学——只要被指名的非自有设备没有出现在
        // 实际执行的命令里（Agent 可能顺带操作了自己的设备），教学就该
        // 发生（原条件「无任何动作」会在混合场景漏教）。
        const actedDeviceIds = new Set(result.executionResult.actions.map(a => a.deviceId));
        const services = (ctx.serviceStore.servicesOf(record.environmentId) ?? []).map(s => ({
          id: s.id,
          name: s.name,
          semanticType: s.semantic_type,
          sourceDeviceId: s.source_device_id,
          visibility: s.visibility,
        }));
        teaching = foreignMentionTeaching(
          {
            text,
            devices,
            agentSurfaceDeviceIds: agentSurface,
            services,
            actedDeviceIds,
            // R76-F4：同名候选同等匹配度下优先解析为「当前用户自己的设备」。
            ownDeviceIds: new Set(devices.filter(d => d.ownerId === user.id).map(d => d.deviceId)),
          },
          request.locale,
        );
      } catch {
        // The teaching pass must never break the command response.
      }
    }

    // T93 (R14, u3-F1): the frozen-world disclosure (prefix) and the R78-A
    // foreign-mention teaching (suffix) compose around the agent's reply.
    const frozenDisclosure = frozenWorldDisclosureOf(record);
    let naturalLanguageResponse = result.naturalLanguageResponse;
    if (defaultSimNote !== undefined) naturalLanguageResponse = `${defaultSimNote}\n${naturalLanguageResponse}`;
    if (frozenDisclosure !== undefined) naturalLanguageResponse = `${frozenDisclosure}\n${naturalLanguageResponse}`;
    if (teaching !== null) naturalLanguageResponse = `${naturalLanguageResponse}\n\n${teaching}`;

    return {
      agentId: resolvedAgentId,
      simulationId: record.id,
      ...(defaultSimNote !== undefined ? { defaultSimNote } : {}),
      ...(frozenDisclosure !== undefined
        ? {
            simulationState: record.runtime.getState(),
            simulationStateDisclosure: frozenDisclosure,
          }
        : {}),
      intent: result.intent,
      cognitiveDecision: result.cognitiveDecision,
      decisionSource: result.decisionSource,
      executionResult: result.executionResult,
      naturalLanguageResponse,
    };
  });

  app.post('/api/agents/:id/ask', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { text, simId } = parseBody(request.body, 'e.g. {"text": "what is the temperature in zone A?"}');
    // T98 (R15, u4-F1): resolution returns the RESOLVED agent id — a unique
    // short prefix (roster habit) now lands on the full id.
    const { record, agentId: resolvedAgentId, defaultSimNote } = resolveAgentRecord(ctx, id, simId, user);
    assertControl(ctx, record, user, 'query');
    const agent = record.runtime.getAgent(resolvedAgentId)!;

    // T105 (R17): the mention-resolution surface — the FULL world zone list
    // — rides the parse; the answer view below stays jurisdiction-only.
    const worldZones = worldZoneViewsOf(record);
    const result: NLAskResult = await agent.answerNaturalLanguageQuestion(text, {
      // T101 (R16, u3/u4): the ask lane reads its JURISDICTION only — the
      // answer body can no longer dump foreign zones' live readings behind a
      // disclosure that promises the agent's own zones (see askZoneViewsOf).
      zones: askZoneViewsOf(record, managedZonesOfAgent(ctx, record, resolvedAgentId)),
      ...(worldZones !== undefined ? { mentionZones: worldZones } : {}),
    });

    auditLog(ctx, record, user, AGENT_NL_ASK_KIND, {
      agentId: resolvedAgentId,
      intentAction: result.intent.action,
      decisionSource: 'ask',
      executedCommands: 0,
      success: true,
      textPreview: text.slice(0, 160),
    });

    // T93 (R14, u3-F1): a resolved-but-not-running sim answers from its
    // frozen runtime — the answer MUST carry the disclosure (first line of
    // the human reply, structured field on the machine face).
    const frozenDisclosure = frozenWorldDisclosureOf(record);
    // T100/T105 (R15/R17): the zone disclosure — a question resolving to
    // zones OUTSIDE the agent's jurisdiction (or to nothing while naming one,
    // T106) is never answered silently from its own zones. The judgment
    // consumes the PARSED intent.targetZones only — never a second raw-text
    // matcher.
    const jurisdiction = worldZones !== undefined
      ? jurisdictionNoteOf(ctx, record, resolvedAgentId, result.intent, worldZones)
      : undefined;
    const naturalLanguageResponse = [
      frozenDisclosure,
      defaultSimNote, // T122: the env default-binding disclosure leads the world story
      jurisdiction?.note,
      result.naturalLanguageResponse,
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n');
    return {
      agentId: resolvedAgentId,
      simulationId: record.id,
      ...(defaultSimNote !== undefined ? { defaultSimNote } : {}),
      ...(frozenDisclosure !== undefined
        ? {
            simulationState: record.runtime.getState(),
            simulationStateDisclosure: frozenDisclosure,
          }
        : {}),
      ...(jurisdiction !== undefined ? { jurisdictionNote: jurisdiction.note } : {}),
      intent: result.intent,
      data: result.data,
      naturalLanguageResponse,
    };
  });
}


/**
 * R81-D4 (D2-F4 root fix): the what-if fork's WORLD SOURCE. Plain sims are
 * frozen scenario snapshots by design — an env-level world edit (catalog
 * device add, governance apply) lands on the AUTHORITATIVE WORLD SESSION
 * (the R82 mutation rebuild), never on a caller-created sim, so a what-if
 * forked from the agent's own sim stayed blind to the runtime-new world
 * (R42-C patched only the scenario TOPOLOGY; the fork's dynamics still came
 * from the frozen sim). The session is the evolving world: fork from its
 * CURRENT state whenever the env has one — a live pause+export while it
 * runs, its checkpoint while hibernated — and name the source in the
 * response (`forkSource`), because a prediction must say which world it
 * tests.
 *
 * Fallbacks keep the legacy source (the agent's own sim runtime) and say
 * so: envs whose world never ran (no session, no checkpoint), non-env
 * scenario sims, and any session-read fault (honest degradation, R82
 * style — a session vanishing mid-request must not fail the what-if).
 * Sandbox forks (sourceEnvId, no environmentId) are untouched: a fork's
 * what-if tests the fork's world.
 *
 * Cost: one snapshot export per what-if — the same order the legacy path
 * already paid on the agent's sim. Live export pauses the session at a
 * quiescent boundary and resumes it (lazy scheduling stays sticky), so a
 * large world pays O(world size) per call, bounded by the what-if quota's
 * own frequency (user-driven lane, no polling loop).
 */
interface WhatIfForkPlan {
  source: WhatIfWorldSource;
  /** Record whose device surface resolves the intervention-zone metric defaults. */
  metricsRecord: SimulationRecord;
  info: { kind: 'world-session' | 'simulation'; simulationId: string };
}

async function whatIfForkSourceOf(
  ctx: AgentNLRoutesContext,
  record: SimulationRecord,
  /** T27 (R3, u1-F4): the caller passed an explicit simId — fork THAT sim
   *  (the legacy source), never the session behind its back.
   *  T127 (R20-u3 N1): the env default binding RESOLVED this call (the
   *  disclosure names the bound sim) — fork THAT world, so the two
   *  disclosure lines agree. T130 (R21-F2): the flag also rides a STALE
   *  binding's fall-back — the ⚠ disclosure names `record` (the session or
   *  the caller's own single sim) as the answering world, so the fork must
   *  be `record` too, or the provenance would contradict the disclosure. */
  options: { explicitSim?: boolean; defaultBoundSim?: boolean } = {},
): Promise<WhatIfForkPlan> {
  const legacy = (): WhatIfForkPlan => ({
    source: { scenario: whatIfScenarioOf(ctx, record), worldState: record.runtime.exportWorldState() },
    metricsRecord: record,
    // The agent's own sim IS the session — its export is the current world.
    info: { kind: record.envSession === true ? 'world-session' : 'simulation', simulationId: record.id },
  });
  if (options.explicitSim === true) return legacy();
  // T127 (R20-u3 N1): the owner's default binding decided this call's world
  // (resolveAgentRecord resolved THROUGH it — the disclosure line names the
  // bound sim). Forking the authoritative session instead made the same
  // output contradict itself (u3: "使用环境默认仿真 …-mu96biat-4" alongside
  // "fork 来源: world-session @ another clock") and predicted on a world the
  // disclosure disavowed. The bound sim is a frozen-snapshot fork BY THE
  // SAME TRADE an explicit --sim makes — an explicit owner decision
  // outranks the session freshness heuristic here exactly as it does on the
  // read/ask lanes. T130 (R21-F2): a STALE binding lands here too — the ⚠
  // disclosure names `record` as the FALL-BACK world the answer rides, so
  // legacy() keeps the provenance on that same world (the session leg below
  // would contradict the note when the fall-back is the caller's own sim).
  // No binding at all → this flag is false and the R81-D4 session
  // preference below stands unchanged.
  if (options.defaultBoundSim === true) return legacy();
  if (record.environmentId === undefined || record.envSession === true) return legacy();
  const envId = record.environmentId;
  const sessionSimId = worldSessionSimIdOf(envId);
  try {
    const live = ctx.registry.get(sessionSimId);
    if (live !== undefined) {
      const exported = await ctx.registry.exportLiveSessionWorld(sessionSimId);
      return {
        // The session's scenario rebuilds from the current env rows on
        // every world mutation; whatIfScenarioOf merges any device the
        // rebuild has not picked up yet (idempotent when current).
        source: { scenario: whatIfScenarioOf(ctx, live), worldState: exported.world },
        metricsRecord: live,
        info: { kind: 'world-session', simulationId: sessionSimId },
      };
    }
    const hibernated = ctx.registry.getHibernated(sessionSimId);
    if (hibernated !== undefined && ctx.envStore !== undefined) {
      const env = ctx.envStore.getEnvironment(envId);
      if (env !== undefined) {
        const checkpoint = readWorldCheckpoint(hibernated.checkpoint.path);
        return {
          source: {
            // Topology from the env's CURRENT rows (the wakeHibernated
            // rule, design-living-worlds §9) over the checkpoint dynamics.
            scenario: environmentToScenario(env, ctx.envStore.devicesOf(envId), ctx.envStore.agentsOf(envId)),
            worldState: checkpoint.world,
          },
          metricsRecord: record,
          info: { kind: 'world-session', simulationId: sessionSimId },
        };
      }
    }
  } catch (error) {
    logger.warn(
      `what-if fork: world session ${sessionSimId} unusable (${error instanceof Error ? error.message : String(error)}) ` +
        `— falling back to simulation ${record.id}`,
    );
  }
  return legacy();
}

/**
 * R42-C (D2-F4, scenario-topology layer — superseded as the ROOT fix by
 * R81-D4's whatIfForkSourceOf above): plain sims are FROZEN scenario
 * snapshots by design, so an env-level device addition (catalog one-click,
 * governance apply) never reaches a live sim — the what-if fork then could
 * not even see the device the operator named (zero-delta confident neutral,
 * or "unknown device"). The env rows are the durable world: enrich the fork
 * scenario with env devices the runtime's frozen snapshot lacks. Fresh
 * definitions carry catalog physics (coolingPowerW etc. via the seed);
 * overlapping devices keep the runtime's (state rides the world-state).
 */
function whatIfScenarioOf(ctx: AgentNLRoutesContext, record: { runtime: { scenario: import('@active-collaboration/core').ScenarioDefinition }; environmentId?: string }): import('@active-collaboration/core').ScenarioDefinition {
  const runtimeScenario = record.runtime.scenario;
  if (record.environmentId === undefined || ctx.envStore === undefined) return runtimeScenario;
  let env: EnvironmentRow;
  let devices: DeviceInstanceRow[];
  try {
    const envRow = ctx.envStore.getEnvironment(record.environmentId);
    if (envRow === undefined) return runtimeScenario;
    env = envRow;
    devices = ctx.envStore.devicesOf(record.environmentId);
  } catch {
    return runtimeScenario; // env rows unreadable — the frozen snapshot stands
  }
  const known = new Set(runtimeScenario.devices.map(d => d.id));
  const missing = devices.filter(d => !known.has(d.id));
  if (missing.length === 0) return runtimeScenario;
  const agents = ctx.envStore.agentsOf(record.environmentId);
  let current: import('@active-collaboration/core').ScenarioDefinition;
  try {
    current = environmentToScenario(env, devices, agents);
  } catch {
    return runtimeScenario; // bridge failure — teach nothing, degrade to frozen
  }
  const byId = new Map(current.devices.map(d => [d.id, d] as const));
  const additions = missing
    .map(d => byId.get(d.id))
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  if (additions.length === 0) return runtimeScenario;
  return { ...runtimeScenario, devices: [...runtimeScenario.devices, ...additions] };
}


/**
 * R42-C companion: extend the agent's NL device views with env-row devices
 * the runtime snapshot lacks (fresh rows carry their catalog command
 * surface; state primitives omitted — the fork starts them at seed state).
 */
function mergeEnvDeviceViews(
  ctx: AgentNLRoutesContext,
  record: { environmentId?: string },
  runtimeViews: readonly NLDeviceView[],
): NLDeviceView[] {
  const base = [...runtimeViews];
  if (record.environmentId === undefined || ctx.envStore === undefined) return base;
  let devices: DeviceInstanceRow[];
  try {
    devices = ctx.envStore.devicesOf(record.environmentId);
  } catch {
    return base;
  }
  const known = new Set(base.map(v => v.deviceId));
  for (const d of devices) {
    if (known.has(d.id)) continue;
    let commands: string[] = [];
    try {
      const caps = JSON.parse(d.capabilities_json ?? '[]') as unknown;
      if (Array.isArray(caps)) commands = caps.filter((c): c is string => typeof c === 'string');
    } catch { /* unreadable caps — an empty command surface is honest */
    }
    base.push({
      deviceId: d.id,
      name: d.name,
      type: d.type,
      ...(d.zone_id !== undefined && d.zone_id !== null ? { zoneId: d.zone_id } : {}),
      online: true,
      commands,
    });
  }
  return base;
}

// ---------------------------------------------------------------------------
// T41 (R4, u1-F1): catalog-change-window classification for the what-if text
// lane. During a device/service churn window (batch apply auto-applies, a
// world rehydration after restart) the merged parse views can lag the DB:
// a perfectly worded question then dies in the unmapped teaching 400 and the
// user is told to "reword" a sentence that was never wrong — five times in a
// row during u1's demo. The classifier below is DETERMINISTIC and only fires
// on shapes a healthy window cannot produce (mergeEnvDeviceViews unions the
// DB rows in, so the views are a superset of the DB when the store is calm).
// ---------------------------------------------------------------------------

/** Fold a token for catalog matching — the SAME normalization shape as the
 *  predictor's foldToken (case/punctuation-insensitive, CJK preserved). The
 *  predictor keeps its matcher private; this mirror is for the classifier
 *  only, never for parsing (parseWhatIfText stays the one oracle). */
function foldForCatalogMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/** The env's DB device rows ([] when the record is file-scenario-backed or
 *  the store is unavailable — nothing to be mid-change about). */
function envDeviceRowsOf(
  ctx: AgentNLRoutesContext,
  record: { environmentId?: string },
): DeviceInstanceRow[] {
  if (record.environmentId === undefined || ctx.envStore === undefined) return [];
  try {
    return ctx.envStore.devicesOf(record.environmentId);
  } catch {
    return []; // unreadable store reads AS a calm world here; mergeEnvDeviceViews' own catch keeps the honest view face
  }
}

/**
 * T41 (R4, u1-F1): is this unmapped parse a CATALOG-CHANGE window?
 *
 * True when the question literally names (folded name or id substring) a
 * device the DB still has while the parse views lack it — or when the views
 * are EMPTY while the DB is not (the rehydration shape). In a calm window
 * the views carry every DB row, so a miss is genuinely the user's wording
 * and the teaching 400 stays. Pure — unit-tested in agent-what-if tests.
 */
export function diagnoseCatalogChangingWindow(
  text: string,
  parseViews: ReadonlyArray<{ deviceId: string; name: string; type: string }>,
  dbDevices: ReadonlyArray<Pick<DeviceInstanceRow, 'id' | 'name' | 'type'>>,
): boolean {
  if (dbDevices.length === 0) return false;
  if (parseViews.length === 0) return true;
  const viewIds = new Set(parseViews.map(view => view.deviceId));
  const haystack = foldForCatalogMatch(text);
  if (haystack.length === 0) return false;
  return dbDevices.some(device => {
    // A device the views DO carry was seen by the parser — its absence from
    // the intervention is a mapping question, taught honestly (never 503).
    if (viewIds.has(device.id)) return false;
    const foldedName = foldForCatalogMatch(device.name);
    const foldedId = foldForCatalogMatch(device.id);
    return (
      (foldedName.length > 1 && haystack.includes(foldedName)) ||
      (foldedId.length > 1 && haystack.includes(foldedId))
    );
  });
}

/**
 * T41 (R4, u1-F1): the honest 503 — "the directory is mid-change, retry in
 * a moment", in the request's locale. The 503 (temporary, platform-side)
 * vs the 400 (fixable input) is the whole point: an intermittent platform
 * window must never masquerade as a deterministic wording error.
 */
export function worldCatalogChangingError(locale: unknown): ApiError {
  const zh = typeof locale === 'string' && locale.toLowerCase().startsWith('zh');
  return new ApiError(
    503,
    'WORLD_CATALOG_CHANGING',
    zh
      ? '设备/服务目录正在变更（最近有增删或世界在重建），请稍后重试；也可用 device list 确认当前可见设备'
      : 'The device/service catalog is changing (recent additions/removals or a world rebuild in progress) — ' +
        'retry in a moment; `device list` shows the currently visible devices',
  );
}
