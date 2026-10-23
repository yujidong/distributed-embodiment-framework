/**
 * Shared command context: server resolution, client construction, and the
 * id-or-name environment reference resolver used by every command that
 * takes an <env> argument.
 */

import type { UiLocale } from '@active-collaboration/shared';

import { ApiClient, requireToken } from './client.js';
import { loadConfig, resolveLang, resolveServer } from './config.js';
import { EXIT, CliError } from './errors.js';
import type { IO } from './io.js';
import type { Output } from './output.js';

export interface EnvSummary {
  id: string;
  name: string;
  description: string;
  mapType: string;
  visibility: 'public' | 'private';
  owner: { id: string; displayName: string };
  counts: { devices: number; agents: number; members: number; services: number; zones: number };
  myRole: 'owner' | 'builder' | 'viewer' | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvZone {
  id: string;
  name?: string;
  type?: string;
  /** T-058a (R14): the owner-authored zone consent class — 'supervised' zones force-escalate every proposal touching them (AI review advises, the owner decides). */
  consentClass?: 'standard' | 'supervised' | 'restricted';
  /** Building tier: owning building id. */
  buildingId?: string;
  /** Building tier: storey number (0 = ground). */
  floor?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  polygon?: [number, number][];
  /** Building tier: current headcount (occupancy effect sources). */
  occupancy?: number;
  /** Building tier: per-zone envelope flux multiplier (indoor↔outdoor). */
  envelopeU?: number;
  adjacentZoneIds?: string[];
  baseline?: Record<string, number | boolean>;
}

export interface EnvMapEvent {
  id: string;
  type: string;
  zoneId: string;
  parameter?: string;
  value?: number | boolean | string;
  atSimTimeSec?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  requiredCapabilities?: string[];
}

export interface EnvDevice {
  id: string;
  envId: string;
  name: string;
  type: string;
  brand: string | null;
  capabilities: string[];
  /** Commands the device accepts (declared capabilities ∩ registered handlers). */
  commands?: string[];
  zoneId: string;
  position: Record<string, unknown> | null;
  initialState: Record<string, unknown> | null;
  owner: { id: string; displayName: string };
  createdAt: string;
}

export interface EnvAgent {
  id: string;
  envId: string;
  name: string;
  capabilities: string[];
  boundDeviceIds: string[];
  managedZoneIds: string[];
  llm: Record<string, unknown> | null;
  /** 启停（migration v21）：false = 停用，不接收注入事件。 */
  enabled?: boolean;
  /** R15：该 Agent 未来派生服务的缺省可见性（缺省不出现 = members）。 */
  derivedServiceVisibility?: 'members' | 'hidden';
  owner: { id: string; displayName: string };
  createdAt: string;
}

/**
 * Governance proposal (subset of the wire shape). A builder's structural
 * call (device/agent create, device delete) is converted into one of these
 * by the server (Fix-1/Fix-7) — the object lands only if the pipeline
 * approves it. When the pipeline auto-applies, the server attaches
 * `createdIds` (Fix-10) so the CLI can name the new objects directly.
 */
export interface EnvProposal {
  id: string;
  envId: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  /** Present (and non-empty) only when status === 'applied'. */
  createdIds?: { devices?: string[]; agents?: string[]; zones?: string[]; flows?: string[] };
  /** T-048: the rule-check verdict (issues teach the fix on 'rejected'). */
  ruleCheck?: { ok: boolean; issues?: string[]; warnings?: string[] } | null;
}

/** True when a create/delete response is the auto-submitted proposal, not the object. */
export function isEnvProposal(value: unknown): value is EnvProposal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EnvProposal).kind === 'string' &&
    typeof (value as EnvProposal).status === 'string'
  );
}

/**
 * Human one-liner for a proposal the pipeline has already applied, naming
 * the objects it created (`proposal p-1 applied — device d-9 created`).
 * Undefined when the proposal is still awaiting approval or created nothing.
 */
export function proposalAppliedSummary(proposal: EnvProposal): string | undefined {
  if (proposal.status !== 'applied') return undefined;
  const created = [
    ...(proposal.createdIds?.devices ?? []).map(id => `device ${id}`),
    ...(proposal.createdIds?.agents ?? []).map(id => `agent ${id}`),
  ];
  if (created.length === 0) return undefined;
  return `proposal ${proposal.id} applied — ${created.join(', ')} created`;
}

// ---------------------------------------------------------------------------
// Flows (user-orchestrated business flows — core flows module, wire shapes
// aligned with apps/server/openapi.yaml Flow* schemas)
// ---------------------------------------------------------------------------

export interface FlowCondition {
  /** Dotted path, e.g. 'zone-a.temperature'. */
  path: string;
  op: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value: number | boolean | string;
}

export type FlowTrigger =
  | {
      kind: 'event';
      eventType?: string;
      zoneId?: string;
      parameter?: string;
      conditions?: FlowCondition[];
    }
  | {
      kind: 'condition';
      zoneId: string;
      conditions: FlowCondition[];
      cooldownSimSec?: number;
      /** FEAT-01: time-of-day active window [start, end); start > end crosses midnight. */
      activeWindowSimSec?: [number, number];
    }
  | {
      kind: 'schedule';
      atSimTimeSec?: number;
      everySimSec?: number;
      startAtSimTimeSec?: number;
      endAtSimTimeSec?: number;
      /** FEAT-01: daily time-of-day anchor (sim seconds-of-day). */
      atTimeOfDaySec?: number;
      /** FEAT-01: occupancy-relative daily anchor (fires offsetSec before the boundary). */
      relativeToOccupancy?: {
        zoneId?: string;
        before: 'arrive' | 'depart';
        offsetSec: number;
      };
    };

export interface FlowPlanNode {
  id: string;
  capability: string;
  /** Absent = the core auto-assigns by capability. */
  assigneeAgentId?: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  condition?: string;
  onFail?: {
    policy: 'abort' | 'retry' | 'compensate';
    retries?: number;
    compensateNodeId?: string;
  };
}

export interface FlowPlan {
  goal: string;
  nodes: FlowPlanNode[];
}

export interface Flow {
  id: string;
  envId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: FlowTrigger;
  /** MI-D: the declared input-parameter surface (absent = none). */
  inputs?: Array<Record<string, unknown>>;
  /** MI-C: the per-flow policy envelope (absent = none). */
  policy?: Record<string, unknown>;
  /** MI-B: the agent-invocation opt-in (absent = off, the default). */
  agentInvocable?: boolean;
  /**
   * T1 (R2): current capability-drift annotations (absent = none) — nodes
   * whose capability the assignee does not declare; computed against the
   * env's live world on list/get.
   */
  capabilityDrift?: FlowCapabilityDrift[];
  /**
   * Non-blocking authoring warnings (T-606; T1 declaration drift) that rode
   * the create/PATCH response.
   */
  validationWarnings?: string[];
  plan: FlowPlan;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** T1 (R2): one capability-drift annotation (core FlowCapabilityDrift). */
export interface FlowCapabilityDrift {
  nodeId: string;
  capability: string;
  assigneeAgentId: string;
  declaredCapabilities: string[];
}

export interface FlowRun {
  id: string;
  flowId: string;
  simulationId: string | null;
  triggerKind: 'event' | 'condition' | 'schedule' | 'manual' | 'service' | 'agent';
  /**
   * UX-14: the trigger's sim time (seconds), hoisted to the top level.
   * schedule/condition evaluations always carry it; event triggers may not
   * know it; manual/service/agent runs and pre-v30 ledger rows are null
   * (never absent).
   */
  triggerSimTimeSec: number | null;
  /** MI-D: the run's effective params (caller values after defaults). */
  inputs?: Record<string, unknown>;
  /** MI-C: exhaustion escalations ('escalate' mode only). */
  policyEscalations?: Array<{ kind: string; nodeId: string; message: string }>;
  /**
   * T1 (R2): capability-drift annotations (absent = none) — nodes that
   * executed on a capability the assignee does not declare.
   */
  capabilityDrift?: FlowCapabilityDrift[];
  status: 'success' | 'partial' | 'failed' | 'waiting';
  /**
   * FEAT-06: present only on the manual-run immediate answer when the run
   * parked on a wait node (never persisted — the ledger row is terminal).
   */
  waiting?: { resumeAtSimSec: number; pendingNodeIds: string[] };
  summary: string;
  /** nodeId → core PlanNodeResult. */
  nodeResults: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
}

/** Server 422 FLOW_INVALID issue (core PlanIssue, carried in error.issues). */
export interface FlowIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export interface EnvGuide {
  purpose?: string;
  zoneGuide?: string;
  roleGuide?: { builder?: string; viewer?: string };
  serviceMap?: string;
}

/** T-309 → T-058a: the read-only governance policy block on the env detail. */
export interface EnvGovernancePolicy {
  proposalReview: string;
  notes: string;
  supervisedZones: Array<{ zoneId: string; consentClass: 'supervised' }>;
  supervisedZoneNote: string;
  /**
   * T-072 (D-1 decide half): the owner's active zone-claim decide
   * delegations (server always emits; typed optional for older fixtures).
   */
  decisionDelegations?: EnvDelegation[];
  decisionDelegationNote?: string;
}

/** T-072: one active decision delegation (wire shape). */
export interface EnvDelegation {
  scope: 'zone-claims';
  delegate: { id: string; displayName: string };
  zones: string[] | 'all';
  grantedBy: { id: string; displayName: string };
  grantedAt: string;
}

/** T-060 (D-4): the non-attributed aggregate agreement signal (count only). */
export interface EnvAgreementTransparency {
  activeCount: number;
  note: string;
}

/** GET /api/environments/:id/flows row (R40-B4 export). */
export interface EnvFlowSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: unknown;
  plan: unknown;
  inputs?: unknown[] | null;
}

export interface EnvDetail {
  id: string;
  name: string;
  description: string;
  mapType: string;
  mapCenter: { lat: number; lng: number } | null;
  mapZoom: number | null;
  /** Building tier map metadata (null when the world does not carry it). */
  storeyHeight?: number | null;
  slabAttenuation?: number | null;
  envelopeU?: number | null;
  occupancyHeatW?: number | null;
  occupancyCo2Rate?: number | null;
  visibility: 'public' | 'private';
  owner: { id: string; displayName: string };
  /** R40-B4: demo-playback metadata (mapData.demo), null when none. */
  demo?: {
    tagline?: { zh: string; en: string };
    heroEventId?: string;
    recommendedPlaybackRate?: number;
    vendorDisclaimer?: string | { zh: string; en: string };
  } | null;
  /** Fix-19: the owner's structured world guide (null = none). */
  guide?: EnvGuide | null;
  /**
   * T122 (R17-u3/R19-u4): the owner's default-simulation binding (null =
   * none). Honored by the ask/what-if/read default lanes while the bound
   * sim is RUNNING; a stale binding is disclosed + falls back.
   */
  defaultSimulationId?: string | null;
  /** Fix-19: role-boundary notice, present only in the viewer's perspective. */
  viewerNotice?: string;
  governance?: EnvGovernancePolicy;
  agreementTransparency?: EnvAgreementTransparency;
  zones: EnvZone[];
  events: EnvMapEvent[];
  devices: EnvDevice[];
  agents: EnvAgent[];
  members: Array<{ userId?: string; role: string; displayName: string; email?: string | null }>;
  myRole: 'owner' | 'builder' | 'viewer' | null;
  /** Living-worlds P1W: the env's authoritative world session (absent = none). */
  worldSession?: {
    status: 'active' | 'idle' | 'hibernated';
    /** T82 (R9, u3-F1): the session RUNTIME state — the sim list vocabulary. */
    state?: string;
    simTimeSec: number;
    simulationId: string;
    /** T-410 (R19): the wall anchor — epoch ms sim-time 0 maps to. */
    simStartEpochMs?: number;
    observers?: number;
    checkpointAtSec?: number;
    hibernatedAt?: string;
    driftWarning?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface Ctx {
  io: IO;
  out: Output;
  json: boolean;
  server: string;
  /** Active session profile (--profile / $EAF_PROFILE); undefined = default. */
  profile?: string;
  /** Resolved UI locale for human-mode output (`--lang` / EAF_LANG, default en-US).
   *  JSON output (`--json`) is NEVER localized — see Output.data. */
  lang: UiLocale;
  /** Ctrl+C signal from the entrypoint (watch loop). */
  signal?: AbortSignal;
  /** Authed client; throws exit-3 when no token is stored. */
  authedClient(): ApiClient;
  /** Client that sends the token when present but works anonymously. */
  openClient(): ApiClient;
  /** Resolve an env id OR exact name to its full detail (404 → exit 4). */
  resolveEnv(ref: string): Promise<EnvDetail>;
  listEnvs(filter?: 'mine' | 'all'): Promise<EnvSummary[]>;
}

export function makeCtx(
  io: IO,
  out: Output,
  serverFlag: string | undefined,
  signal?: AbortSignal,
  profile?: string,
  langFlag?: string,
): Ctx {
  const server = resolveServer(io, serverFlag, profile);
  const lang = resolveLang(io, langFlag);
  const token = (): string | undefined => loadConfig(io, profile).token;

  // T125 (R19-u1 F3): every request declares the caller's UI locale — the
  // server answers localized teachings in --lang instead of always zh-CN.
  const openClient = (): ApiClient => new ApiClient(server, token(), lang);
  const authedClient = (): ApiClient => new ApiClient(server, requireToken(token()), lang);

  /** R15-D2: 'mine' (server default) or 'all' (mine + public catalog). */
  const listEnvs = async (filter: 'mine' | 'all' = 'mine'): Promise<EnvSummary[]> => {
    const query = filter === 'all' ? '?filter=all' : '';
    const body = (await authedClient().get(`/api/environments${query}`)) as { environments: EnvSummary[] };
    return body.environments;
  };

  const resolveEnv = async (ref: string): Promise<EnvDetail> => {
    // Fast path: it IS an id. Public envs are readable anonymously; private
    // ones need membership — either way the detail GET is the authority.
    try {
      return (await openClient().get(`/api/environments/${encodeURIComponent(ref)}`)) as EnvDetail;
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode !== EXIT.NOT_FOUND) throw error;
    }
    // Fall back to an exact-name match across the FULL visible set — a
    // public environment must resolve by name even under the mine-default.
    const matches = (await listEnvs('all')).filter(env => env.name === ref);
    if (matches.length === 0) {
      throw new CliError(`environment "${ref}" not found (tried id and exact name)`, EXIT.NOT_FOUND);
    }
    if (matches.length > 1) {
      throw new CliError(
        `environment name "${ref}" is ambiguous — use an id instead`,
        EXIT.ERROR,
        matches.map(env => `${env.id}  (owner ${env.owner.displayName}, ${env.visibility})`),
      );
    }
    return (await openClient().get(`/api/environments/${encodeURIComponent(matches[0].id)}`)) as EnvDetail;
  };

  return { io, out, json: out.json, server, profile, lang, signal, authedClient, openClient, resolveEnv, listEnvs };
}

// ---------------------------------------------------------------------------
// T88 (R12, u2-F1): short-prefix id resolution for the GET faces
// (`agreement get/usage/receipts`, `service get`, `device get`, `agent get`).
// REST keeps FULL ids — this is a CLI-side convenience only, resolved through
// the same list rosters the user can already see (list-permission scoped).
// ---------------------------------------------------------------------------

/** One roster row the prefix resolver matches against (full id + display name). */
export interface IdRosterEntry {
  id: string;
  name?: string;
}

/**
 * T131: the CANONICAL FULL-LENGTH UUID form (36 chars, hyphenated — ids are
 * minted by `randomUUID()`, e.g. agreement-store.ts). A ref in this shape is
 * the whole id: it cannot EXTEND to another id (no prefix lane) and cannot be
 * a display name (no T102 lane), so the roster resolver has nothing to add.
 */
export const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE shared prefix resolver behind every get face: run `get(fullId)`; when
 * the API answers 404, treat `ref` as a PREFIX and look it up in the roster
 * the caller can see — exactly one extension resolves (with an explain note
 * naming the mapping, so scripts/humans can verify); zero or several
 * extensions throw the teaching error listing candidates (full id + name),
 * never a silent guess. A failed roster scan rethrows the ORIGINAL 404 —
 * resolution is best-effort and must not mask the get face's own answer.
 *
 * Why resolve on 404 only: a full id keeps its zero-extra-roundtrip path and
 * the server's exact permission semantics; prefixes engage precisely where
 * the misleading NOT_FOUND used to be (u2: a short prefix read as "data
 * lost" after an env rebuild — the error now teaches, it no longer lies).
 *
 * T102 (R16, u1/u2/u4): a ref that is NO id prefix may be the agent's exact
 * DISPLAY NAME (the roster's user-facing identifier) — one carrier resolves
 * with the same explain discipline; several carriers are the honest
 * ambiguity face; none names both hypotheses in the teaching.
 */
export async function getWithIdPrefix<T>(
  ctx: Ctx,
  options: {
    /** Message noun: 'agreement' | 'service' | 'device' | 'agent'. */
    kind: string;
    ref: string;
    /** The get face itself, keyed by the (possibly resolved) full id. */
    get: (fullId: string) => Promise<T>;
    /** The visible roster to match against (list-permission scoped). */
    roster: () => Promise<ReadonlyArray<IdRosterEntry>>;
    /** Where the user copies full ids from, e.g. `eaf device list --env <id|name>`. */
    listHint: string;
  },
): Promise<T> {
  try {
    return await options.get(options.ref);
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== EXIT.NOT_FOUND) throw error;
    // T131: a CANONICAL FULL-LENGTH UUID rethrows the server's own 404 —
    // T58's verbatim passthrough contract (json-error.vitest pins it). The
    // roster lane below is for refs that could EXTEND to a full id or BE a
    // display name; a full id can do neither, so rewriting the server's
    // answer here only degraded the error (CLI_NOT_FOUND instead of the
    // REST face's code). Short refs keep the zero-match teaching unchanged
    // (prefix-get's R19-u2 acceptance inputs).
    if (CANONICAL_UUID_RE.test(options.ref)) throw error;
    let roster: ReadonlyArray<IdRosterEntry>;
    try {
      roster = await options.roster();
    } catch {
      throw error; // best-effort resolution — the original 404 stands
    }
    // Exact ids retrying here would just 404 again; the prefix lane is for
    // refs that EXTEND to a full id.
    const matches = roster.filter(entry => entry.id.startsWith(options.ref) && entry.id !== options.ref);
    if (matches.length === 1) {
      const resolved = matches[0]!;
      if (ctx.json) {
        ctx.out.explain(`id "${options.ref}" resolved to ${resolved.id} (unique prefix match)`);
      } else {
        ctx.out.explain(
          `id "${options.ref}" resolved to ${resolved.id}` +
          (resolved.name !== undefined ? ` (${resolved.name})` : '') +
          ' — unique prefix match',
        );
      }
      return options.get(resolved.id);
    }
    if (matches.length > 1) {
      throw new CliError(
        `"${options.ref}" matches ${matches.length} ${options.kind}s you can see — use one FULL id:`,
        EXIT.USAGE,
        matches.map(entry => `${entry.id}${entry.name !== undefined ? `  (${entry.name})` : ''}`),
      );
    }
    // T102: the display-NAME lane — exact match, same explain discipline.
    const byName = roster.filter(entry => entry.name !== undefined && entry.name === options.ref);
    if (byName.length === 1) {
      const resolved = byName[0]!;
      if (ctx.json) {
        ctx.out.explain(`"${options.ref}" resolved to ${resolved.id} (unique display-name match)`);
      } else {
        ctx.out.explain(`"${options.ref}" resolved to ${resolved.id} — unique display-name match`);
      }
      return options.get(resolved.id);
    }
    if (byName.length > 1) {
      throw new CliError(
        `"${options.ref}" is the display name of ${byName.length} ${options.kind}s you can see — use one FULL id:`,
        EXIT.USAGE,
        byName.map(entry => entry.id),
      );
    }
    throw new CliError(
      `${options.kind} "${options.ref}" not found — none of the ${roster.length} ` +
      `${options.kind}(s) you can see has an id with this prefix or this exact display name; ` +
      `copy the full id from ${options.listHint}`,
      EXIT.NOT_FOUND,
    );
  }
}
