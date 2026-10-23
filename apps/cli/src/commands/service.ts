/**
 * `eaf service` — the service marketplace: discover what agents OFFER
 * across environments (list / get) and manage personal subscriptions
 * (subscribe / unsubscribe). R14 Wave-A adds `computation register/get` —
 * the provider-side registration of a data-service ComputationSpec.
 */

import { boolFlag, jsonFlag, parse, requirePositional, requireString, stringFlag } from '../args.js';
import { CANONICAL_UUID_RE, getWithIdPrefix, type Ctx, type IdRosterEntry } from '../ctx.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { declarationDriftWarning } from '../render.js';
import { t } from '../i18n/index.js';

const USAGE_LIST =
  'eaf service list (--env <id|name> | --all) [--provider <agentId>] [--type <semanticType>] [--origin derived|published|flow|aggregate] [--q <搜索词>]';
const USAGE_GET = 'eaf service get <serviceId>';
const USAGE_SUBSCRIBE = 'eaf service subscribe <serviceId>';
const USAGE_UNSUBSCRIBE = 'eaf service unsubscribe <serviceId>';
const USAGE_COMPUTATION_REGISTER =
  'eaf service computation register <serviceId> --spec \'<{"kind":"device-aggregate","refreshSec":30,"inputs":{"zones":"*","devices":["<deviceId>"],"metrics":[...]}}>\' [--interface \'<{"dataSchema":{...}}>\']  # inputs.devices scopes the computation to exact device ids (the per-bed form; must be provider-bound devices)';
const USAGE_COMPUTATION_GET = 'eaf service computation get <serviceId>';
const USAGE_COMPUTATION_REVOKE = 'eaf service computation revoke <serviceId>';
const USAGE_ACCESS_REQUEST = 'eaf service access request <serviceId> [--purpose <text>] [--days <n>]';
const USAGE_ACCESS_REQUESTS = 'eaf service access requests <serviceId>';
const USAGE_ACCESS_CLOSE = 'eaf service access close <serviceId> <requestId>';
const USAGE_ACCESS_REMIND = 'eaf service access remind <serviceId> <requestId>';
const USAGE_ACCESS_GRANT =
  'eaf service access grant <serviceId> (--request <requestId> | --user <userId>) --expires <iso> [--basis <text>] [--data-subject \'<{"ref":"resident-101-2"}>\']';
const USAGE_ACCESS_GRANTS = 'eaf service access grants <serviceId>';
const USAGE_ACCESS_REVOKE = 'eaf service access revoke <serviceId> <userId>';

const SERVICE_ORIGINS = ['derived', 'published', 'flow', 'aggregate'] as const;

/** Service offer (subset of the wire shape — GET list & get share it). */
export interface ServiceEntry {
  id: string;
  envId: string;
  name: string;
  semanticType: string;
  description: string;
  /** Callable surface (Fix-15, F-27): derived services carry device actions. */
  interface?: {
    /** MI-D: 'flow' marks the generated flow-service surface. */
    kind?: string;
    actions?: Array<{
      name: string;
      parameters?: Record<string, { type?: string; enum?: string[]; description?: string }>;
    }>;
    /** MI-D: delegate-node count inside the backing flow (Wave-A caution). */
    delegateNodeCount?: number;
    /** R14 Wave-A: data-service output schema (registered with the computation). */
    dataSchema?: { fields: Array<{ name: string; type?: string; unit?: string }> };
    /** R14 Wave-A: the provider's structured privacy declaration (informational). */
    excludes?: string[];
  };
  origin: 'derived' | 'published' | 'flow' | 'aggregate';
  /** MI-D: the backing flow of an origin='flow' row. */
  sourceFlowId?: string;
  visibility: 'public' | 'members' | 'hidden';
  unbacked: boolean;
  /** R14 Wave-A: present when the service has a registered computation. */
  consumable?: boolean;
  /** R14 Wave-A: the undeliverable-offer reason (teaching text, R102). */
  consumableNote?: string;
  /**
   * T31 (R3): the AGGREGATE offer's rule-lane backing view — the same
   * judgment as the signing gates (rule/actuates/devices/callableActions).
   */
  backing?: {
    kind: 'rule';
    rule: string;
    actuates: string[];
    devices: Array<{ id: string; name: string }>;
    callableActions: string[];
  };
  /** T31 (R3): what an unbacked AGGREGATE offer is missing + the remedy. */
  backingMissing?: {
    ruleResolved: boolean;
    actuates: string[];
    boundDevices: Array<{ id: string; name: string }>;
    remedy: string;
  };
  /** T28 (R3): present (false) when the provider does not declare the capability. */
  declaredByProvider?: false;
  /**
   * T62 (R6): the propose gate's backing verdict — visible before drafting.
   * T68a (R7, u2-F-5): aggregate rows carry it too (the rule lane:
   * backed/unbacked — the assertAggregateDeliverable judgment), and
   * `reason` rides the ambiguous AND unbacked verdicts.
   */
  signability?: {
    verdict: 'backed' | 'ambiguous' | 'unbacked';
    /** Present on 'ambiguous': the propose-time 409 names these devices. */
    candidateDevices?: string[];
    /** T68a (R7): the one-line reason (the 409/refusal's own wording). */
    reason?: string;
    /**
     * T84 (R10, u1-F3): present when the computation's device-state read
     * source was NEVER written in the probed world — propose is NOT refused
     * (the ambiguity is the caution marking), but reads from that world will
     * honestly 409 COMPUTATION_DEVICE_STATE_UNWRITTEN. The human face renders
     * the read-source copy (not the SERVICE_BACKING_AMBIGUOUS one) when this
     * rides along. T86 (R11, u1-F1): `probedLane` names WHICH read lane's
     * default world was judged — the ⚠ layers its promise by it (own-sim
     * verdict ≠ the sim-less world-session fallback, whose values come from
     * world initialization).
     */
    readSource?: {
      status: 'never-written';
      fields: string[];
      simulationId: string;
      /** Absent = a pre-T86 server (the old world-pick) — rendered as the world-session lane. */
      probedLane?: 'own-sim' | 'world-session';
    };
  };
  computation?: { kind: string; refreshSec: number; schemaVersion: number; registeredAt: string };
  provider: { id: string; name: string; owner: { id: string; displayName: string } };
  reputation: { score: number; attempts: number; successes: number };
  /** R101: 冷启动标记 — 'none' = 暂无履约记录（与有记录服务可区分）。 */
  trackRecord?: 'established' | 'none';
  /** T64 (R6): the口径 note when 'none' coexists with a real usage row. */
  trackRecordNote?: string;
  /** T121 (R10-u4): the reputation-vs-usage methodology note (same-card口径). */
  methodologyNote?: string;
  /** R101/R102: 近 30 天聚合履约（与当事方 usage 明细同源；差额类别有名有姓）。 */
  usageSummary?: {
    windowDays: number;
    invocations: number;
    succeeded: number;
    failed: number;
    partial: number;
    other: number;
    successRate: number | null;
  } | null;
  createdAt: string;
}

interface SubscribeResult {
  serviceId: string;
  userId: string;
  envId: string;
  createdAt: string;
  alreadySubscribed: boolean;
}

export async function serviceCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  if (sub === 'computation') {
    return computationCommand(ctx, argv);
  }
  if (sub === 'access') {
    return accessCommand(ctx, argv);
  }
  switch (sub) {
    case 'list':
      return listServices(ctx, argv);
    case 'get':
      return getService(ctx, argv);
    case 'publish':
      return publishService(ctx, argv);
    case 'subscribe':
      return subscribe(ctx, argv);
    case 'unsubscribe':
      return unsubscribe(ctx, argv);
    default:
      throw usageError(
        `unknown service subcommand "${sub ?? ''}" (expected list|get|publish|subscribe|unsubscribe|computation register|computation get|computation revoke|access request|access requests|access close|access remind|access grant|access grants|access revoke)`,
      );
  }
}

// ---------------------------------------------------------------------------
// `eaf service publish` (MI-D) — publish an explicit offer through a
// provider agent. --flow <flowId> selects the FLOW-SERVICE form: the
// interface is generated from the flow's inputs surface, execution happens
// in the provider's context (T-201 author scoping), invocation delivers one
// metered flow run (unit 'flow-run').
// ---------------------------------------------------------------------------

const USAGE_PUBLISH =
  "eaf service publish --env <id|name> --agent <agentId> --name <text> --type <semanticType> " +
  "[--flow <flowId>] [--description <text>] [--visibility public|members|hidden]  " +
  "# --flow publishes a flow-service (its inputs surface becomes the contract; omit for a device/published offer)";

async function publishService(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags } = parse(
    argv,
    {
      env: { type: 'string' },
      agent: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      flow: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string' },
    },
    USAGE_PUBLISH,
  );
  const envId = await resolveEnvId(ctx, requireString(flags, 'env', USAGE_PUBLISH));
  const agentId = requireString(flags, 'agent', USAGE_PUBLISH);
  const visibility = stringFlag(flags, 'visibility');
  if (visibility !== undefined && !['public', 'members', 'hidden'].includes(visibility)) {
    throw usageError(`--visibility must be public|members|hidden\nusage: ${USAGE_PUBLISH}`);
  }
  const flowId = stringFlag(flags, 'flow');
  const body = {
    name: requireString(flags, 'name', USAGE_PUBLISH),
    semanticType: requireString(flags, 'type', USAGE_PUBLISH),
    ...(stringFlag(flags, 'description') !== undefined
      ? { description: stringFlag(flags, 'description') }
      : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(flowId !== undefined ? { backing: { kind: 'flow' as const, flowId } } : {}),
  };
  const created = (await ctx.authedClient().post(
    `/api/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(agentId)}/services`,
    body,
  )) as ServiceEntry;
  if (ctx.json) {
    ctx.out.data(created);
    return;
  }
  if (flowId !== undefined) {
    ctx.out.line(
      `flow-service published: ${created.name} (${created.id}) backed by flow ${flowId} — ` +
        `invoke: eaf agreement invoke <agreementId> --action run --params '<json>'`,
    );
  } else {
    ctx.out.line(`service published: ${created.name} (${created.id})`);
  }
}

/** Resolve --env (id or name) to an environment id via the list endpoint. */
async function resolveEnvId(ctx: Ctx, ref: string): Promise<string> {
  const body = (await ctx.authedClient().get('/api/environments')) as {
    environments: Array<{ id: string; name: string }>;
  };
  const hit = body.environments.find(env => env.id === ref || env.name === ref);
  if (hit === undefined) {
    throw usageError(`environment "${ref}" not found (visible to you) — pass the id or exact name`);
  }
  return hit.id;
}

// ---------------------------------------------------------------------------
// `eaf service access …` (R14 Wave-B, T-058b) — the hidden-service
// authorization lane: request → grant (person × period) → the door opens.
// ---------------------------------------------------------------------------

interface AccessRequestEntry {
  id: string;
  serviceId: string;
  requesterName: string;
  purpose: string;
  durationDays: number | null;
  status: string;
  createdAt: string;
}

interface AccessGrantEntry {
  id: string;
  serviceId: string;
  granteeUserId: string;
  granteeName: string;
  expiresAt: string;
  basis: string | null;
  dataSubject: { ref: string; consentBasis?: string } | null;
  requestId: string | null;
}

async function accessCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'request':
      return accessRequest(ctx, rest);
    case 'requests':
      return accessRequests(ctx, rest);
    case 'close':
      return accessClose(ctx, rest);
    case 'remind':
      return accessRemind(ctx, rest);
    case 'grant':
      return accessGrant(ctx, rest);
    case 'grants':
      return accessGrants(ctx, rest);
    case 'revoke':
      return accessRevoke(ctx, rest);
    default:
      throw usageError(
        `unknown access subcommand "${sub ?? ''}" (expected request|requests|close|remind|grant|grants|revoke)\n` +
        `usage: ${USAGE_ACCESS_REQUEST}`,
      );
  }
}

async function accessRequest(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { purpose: { type: 'string' }, days: { type: 'string' } },
    USAGE_ACCESS_REQUEST,
  );
  const id = await resolveServiceRef(ctx, requirePositional(positionals, 'serviceId', USAGE_ACCESS_REQUEST));
  const purpose = stringFlag(flags, 'purpose');
  const daysRaw = stringFlag(flags, 'days');
  let durationDays: number | undefined;
  if (daysRaw !== undefined) {
    durationDays = Number(daysRaw);
    if (!Number.isInteger(durationDays) || durationDays <= 0) {
      throw usageError(`--days must be a positive integer (days)\nusage: ${USAGE_ACCESS_REQUEST}`);
    }
  }
  const request = (await ctx.authedClient().post(
    `/api/services/${encodeURIComponent(id)}/access-requests`,
    {
      ...(purpose !== undefined ? { purpose } : {}),
      ...(durationDays !== undefined ? { durationDays } : {}),
    },
  )) as AccessRequestEntry;
  if (ctx.json) {
    ctx.out.data(request);
    return;
  }
  ctx.out.line(
    `access request ${request.id} pending on service ${id} — the provider decides (no SLA; ` +
    'remind: eaf service access remind <serviceId> <requestId>)',
  );
}

async function accessRequests(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_ACCESS_REQUESTS);
  const id = await resolveServiceRef(ctx, requirePositional(positionals, 'serviceId', USAGE_ACCESS_REQUESTS));
  const body = (await ctx.authedClient().get(
    `/api/services/${encodeURIComponent(id)}/access-requests`,
  )) as { requests: AccessRequestEntry[] };
  if (ctx.json) {
    ctx.out.data(body.requests);
    return;
  }
  ctx.out.table(
    body.requests.map(request => ({
      id: request.id,
      requester: request.requesterName,
      status: request.status,
      days: request.durationDays ?? '',
      purpose: request.purpose,
      createdAt: request.createdAt,
    })),
    ['id', 'requester', 'status', 'days', 'purpose', 'createdAt'],
  );
}

/**
 * Parse exactly two positional arguments `<a> <b>` (requirePositional is
 * strictly one-only — two-positional commands would trip its extra-args check).
 */
function requireTwoPositionals(
  argv: string[],
  a: string,
  b: string,
  usage: string,
): { first: string; second: string } {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length !== 2) {
    throw usageError(`expected <${a}> and <${b}>\nusage: ${usage}`);
  }
  return { first: positionals[0], second: positionals[1] };
}

async function accessClose(ctx: Ctx, argv: string[]): Promise<void> {
  const { first: serviceId, second: requestId } = requireTwoPositionals(argv, 'serviceId', 'requestId', USAGE_ACCESS_CLOSE);
  // T124: the serviceId slot joins the prefix family (requestId stays a full
  // id — it is copied from the same face's requests roster output).
  const fullServiceId = await resolveServiceRef(ctx, serviceId);
  const request = (await ctx.authedClient().request(
    'DELETE',
    `/api/services/${encodeURIComponent(fullServiceId)}/access-requests/${encodeURIComponent(requestId)}`,
  )) as AccessRequestEntry;
  if (ctx.json) {
    ctx.out.data(request);
    return;
  }
  ctx.out.line(`access request ${requestId} ${request.status}`);
}

async function accessRemind(ctx: Ctx, argv: string[]): Promise<void> {
  const { first: serviceId, second: requestId } = requireTwoPositionals(argv, 'serviceId', 'requestId', USAGE_ACCESS_REMIND);
  const fullServiceId = await resolveServiceRef(ctx, serviceId); // T124 prefix family
  const result = (await ctx.authedClient().post(
    `/api/services/${encodeURIComponent(fullServiceId)}/access-requests/${encodeURIComponent(requestId)}/remind`,
  )) as { requestId: string; reminded: boolean; note?: string };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    result.reminded
      ? 'reminder delivered'
      : `no reminder sent: ${result.note ?? 'dropped by a noise-control rule'}`,
  );
}

async function accessGrant(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { request: { type: 'string' }, user: { type: 'string' }, expires: { type: 'string' }, basis: { type: 'string' }, 'data-subject': { type: 'string' } },
    USAGE_ACCESS_GRANT,
  );
  const id = await resolveServiceRef(ctx, requirePositional(positionals, 'serviceId', USAGE_ACCESS_GRANT));
  const requestId = stringFlag(flags, 'request');
  const userId = stringFlag(flags, 'user');
  if (requestId === undefined && userId === undefined) {
    throw usageError(`either --request <requestId> or --user <userId> is required\nusage: ${USAGE_ACCESS_GRANT}`);
  }
  const expiresAt = requireString(flags, 'expires', USAGE_ACCESS_GRANT);
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw usageError(`--expires must be an ISO timestamp in the FUTURE\nusage: ${USAGE_ACCESS_GRANT}`);
  }
  const basis = stringFlag(flags, 'basis');
  const dataSubject = jsonFlag<Record<string, unknown>>(flags, 'data-subject', USAGE_ACCESS_GRANT);
  const grant = (await ctx.authedClient().post(
    `/api/services/${encodeURIComponent(id)}/access-grants`,
    {
      ...(requestId !== undefined ? { requestId } : { userId }),
      expiresAt,
      ...(basis !== undefined ? { basis } : {}),
      ...(dataSubject !== undefined ? { dataSubject } : {}),
    },
  )) as AccessGrantEntry;
  if (ctx.json) {
    ctx.out.data(grant);
    return;
  }
  ctx.out.line(
    `access granted to ${grant.granteeName} on service ${id} until ${grant.expiresAt}` +
    (grant.basis !== null ? ` (basis: ${grant.basis})` : ''),
  );
  if (grant.dataSubject !== null) {
    ctx.out.line(`  dataSubject: ${grant.dataSubject.ref}${grant.dataSubject.consentBasis !== undefined ? ` (${grant.dataSubject.consentBasis})` : ''}`);
  }
}

async function accessGrants(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_ACCESS_GRANTS);
  const id = await resolveServiceRef(ctx, requirePositional(positionals, 'serviceId', USAGE_ACCESS_GRANTS));
  const body = (await ctx.authedClient().get(
    `/api/services/${encodeURIComponent(id)}/access-grants`,
  )) as { grants: AccessGrantEntry[] };
  if (ctx.json) {
    ctx.out.data(body.grants);
    return;
  }
  ctx.out.table(
    body.grants.map(grant => ({
      grantee: grant.granteeName,
      userId: grant.granteeUserId,
      expiresAt: grant.expiresAt,
      basis: grant.basis ?? '',
      dataSubject: grant.dataSubject?.ref ?? '',
    })),
    ['grantee', 'userId', 'expiresAt', 'basis', 'dataSubject'],
  );
}

async function accessRevoke(ctx: Ctx, argv: string[]): Promise<void> {
  const { first: serviceId, second: userId } = requireTwoPositionals(argv, 'serviceId', 'userId', USAGE_ACCESS_REVOKE);
  const fullServiceId = await resolveServiceRef(ctx, serviceId); // T124 prefix family
  await ctx.authedClient().request(
    'DELETE',
    `/api/services/${encodeURIComponent(fullServiceId)}/access-grants/${encodeURIComponent(userId)}`,
  );
  if (ctx.json) {
    ctx.out.data({ serviceId: fullServiceId, userId, revoked: true });
    return;
  }
  ctx.out.line(
    `access revoked for user ${userId} on service ${fullServiceId} — the service answers 404 for them again ` +
    '(active agreements keep their status; reads answer 409 ACCESS_GRANT_REVOKED)',
  );
}

/** `eaf service computation …` (R14 Wave-A) — provider-side computation spec management. */
async function computationCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'register':
      return registerComputation(ctx, rest);
    case 'get':
      return getComputation(ctx, rest);
    case 'revoke':
      return revokeComputation(ctx, rest);
    default:
      throw usageError(
        `unknown computation subcommand "${sub ?? ''}" (expected register|get|revoke)\n` +
        `usage: ${USAGE_COMPUTATION_REGISTER}`,
      );
  }
}

async function registerComputation(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { spec: { type: 'string' }, interface: { type: 'string' } },
    USAGE_COMPUTATION_REGISTER,
  );
  const id = await resolveServiceRef(ctx, requirePositional(positionals, 'serviceId', USAGE_COMPUTATION_REGISTER)); // T124 prefix family
  const spec = jsonFlag<Record<string, unknown>>(flags, 'spec', USAGE_COMPUTATION_REGISTER);
  if (spec === undefined || typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw usageError(`--spec must be a JSON object (the computation spec)\nusage: ${USAGE_COMPUTATION_REGISTER}`);
  }
  const iface = jsonFlag<Record<string, unknown>>(flags, 'interface', USAGE_COMPUTATION_REGISTER);
  if (iface !== undefined && (typeof iface !== 'object' || iface === null || Array.isArray(iface))) {
    throw usageError(`--interface must be a JSON object\nusage: ${USAGE_COMPUTATION_REGISTER}`);
  }
  // T81 (R9, u2-F2): the registration warnings ride the 201 body (`warnings`)
  // — the json face carried them, the human face printed nothing (R102).
  const service = (await ctx.authedClient().post(
    `/api/services/${encodeURIComponent(id)}/computation`,
    { ...spec, ...(iface !== undefined ? { interface: iface } : {}) },
  )) as ServiceEntry & { warnings?: string[] };
  if (ctx.json) {
    ctx.out.data(service);
    return;
  }
  ctx.out.line(
    `computation registered on service ${service.id} "${service.name}" ` +
    `(${service.computation!.kind}, refresh ${service.computation!.refreshSec}s, schema v${service.computation!.schemaVersion}) — ` +
    `consumable=${service.consumable}`,
  );
  const fields = service.interface?.dataSchema?.fields ?? [];
  if (fields.length > 0) {
    ctx.out.line(`  dataSchema: ${fields.map(field => field.name).join(', ')}`);
  }
  const excludes = service.interface?.excludes ?? [];
  if (excludes.length > 0) {
    ctx.out.line(`  excludes: ${excludes.join('; ')}`);
  }
  // T81 (R9, u2-F2) + T72: the warnings are part of THIS face — stdout in
  // human mode (never stderr-only), one line per warning, verbatim text.
  for (const warning of service.warnings ?? []) {
    ctx.out.explain(`  ⚠ warning: ${warning}`);
  }
}

async function getComputation(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_COMPUTATION_GET);
  const id = requirePositional(positionals, 'serviceId', USAGE_COMPUTATION_GET);
  // 顺带② (R13, u2-P3, T88 leftover): the adjacency face joins the prefix
  // family — `computation get <short-id>` used to 404 while `service get
  // <same short-id>` resolved.
  const body = await getWithIdPrefix(ctx, {
    kind: 'service',
    ref: id,
    get: full =>
      ctx.openClient().get(`/api/services/${encodeURIComponent(full)}/computation`) as Promise<{ computation: Record<string, unknown> | null }>,
    roster: serviceRoster(ctx),
    listHint: 'eaf service list --all (or --env <id|name>)',
  });
  if (ctx.json) {
    ctx.out.data(body.computation);
    return;
  }
  if (body.computation === null) {
    ctx.out.line(`service ${id} has no registered computation`);
    return;
  }
  ctx.out.line(`computation on service ${id}:`);
  ctx.out.line(`  ${JSON.stringify(body.computation, null, 2)}`);
}

async function revokeComputation(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_COMPUTATION_REVOKE);
  const id = requirePositional(positionals, 'serviceId', USAGE_COMPUTATION_REVOKE);
  // 顺带② (R13, u2-P3, T88 leftover): same prefix family as computation get.
  const service = await getWithIdPrefix(ctx, {
    kind: 'service',
    ref: id,
    get: full => ctx.authedClient().request('DELETE', `/api/services/${encodeURIComponent(full)}/computation`) as Promise<ServiceEntry>,
    roster: serviceRoster(ctx),
    listHint: 'eaf service list --all (or --env <id|name>)',
  });
  if (ctx.json) {
    ctx.out.data(service);
    return;
  }
  ctx.out.line(
    `computation revoked on service ${service.id} "${service.name}" — consumable=${service.consumable}` +
    (service.consumable ? '' : ' (back to bookmark-only; active data agreements keep their reads 409 COMPUTATION_UNREGISTERED and were notified)'),
  );
}

/** Query string for the list endpoint's filters (unset flags omitted). */
function listQuery(flags: Record<string, unknown>, usage: string, provider?: string): string {
  const params = new URLSearchParams();
  const type = stringFlag(flags, 'type');
  const origin = stringFlag(flags, 'origin');
  const q = stringFlag(flags, 'q');
  if (origin !== undefined && !(SERVICE_ORIGINS as readonly string[]).includes(origin)) {
    throw usageError(`--origin must be derived|published|flow|aggregate\nusage: ${usage}`);
  }
  if (type !== undefined) params.set('semanticType', type);
  if (provider !== undefined) params.set('provider', provider);
  if (origin !== undefined) params.set('origin', origin);
  if (q !== undefined) params.set('q', q);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/**
 * 顺带② (R13, u2-P3, T88 leftover): resolve `--provider <agentRef>` against
 * the scoped environments' visible agent rosters. A prefix matching NOTHING
 * used to flow into the server filter and silently return an EMPTY list —
 * the user could not tell "no services" from "id 打错了" (the face most
 * violating the never-guessed philosophy). Exact ids pass through at zero
 * cost; one prefix match resolves with an explain line; zero/many teach.
 */
async function resolveProviderRef(
  ctx: Ctx,
  providerRef: string,
  envIds: ReadonlyArray<string>,
): Promise<string> {
  const entries: IdRosterEntry[] = [];
  for (const envId of envIds) {
    try {
      const body = (await ctx.authedClient().get(
        `/api/environments/${encodeURIComponent(envId)}/agents`,
      )) as { agents: Array<{ id: string; name: string }> };
      for (const agent of body.agents) entries.push({ id: agent.id, name: agent.name });
    } catch {
      // unreadable env — skipped (best-effort roster)
    }
  }
  if (entries.some(entry => entry.id === providerRef)) return providerRef;
  const matches = entries.filter(entry => entry.id.startsWith(providerRef));
  if (matches.length === 1) {
    const resolved = matches[0]!;
    ctx.out.explain(
      `provider "${providerRef}" resolved to ${resolved.id}` +
      (resolved.name !== undefined ? ` (${resolved.name})` : '') +
      ' — unique prefix match',
    );
    return resolved.id;
  }
  if (matches.length === 0) {
    throw new CliError(
      `provider "${providerRef}" matches none of the ${entries.length} agent(s) in scope — ` +
      'copy the full id from eaf agent list --env <id|name>',
      EXIT.NOT_FOUND,
    );
  }
  throw new CliError(
    `provider "${providerRef}" matches ${matches.length} agents in scope — use one FULL id:`,
    EXIT.USAGE,
    matches.map(entry => `${entry.id}${entry.name !== undefined ? `  (${entry.name})` : ''}`),
  );
}

async function servicesOf(ctx: Ctx, envId: string, query: string): Promise<ServiceEntry[]> {
  const body = (await ctx
    .openClient()
    .get(`/api/environments/${encodeURIComponent(envId)}/services${query}`)) as { services: ServiceEntry[] };
  return body.services;
}

async function listServices(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      env: { type: 'string' },
      provider: { type: 'string' },
      type: { type: 'string' },
      origin: { type: 'string' },
      q: { type: 'string' },
      all: { type: 'boolean' },
    },
    USAGE_LIST,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const envRef = stringFlag(flags, 'env');
  const all = boolFlag(flags, 'all');

  // Wave-1a (R8 小新 F-03): the default scope is ONE environment — a bare
  // `service list` that aggregated every visible world buried the newcomer's
  // own env under 200+ foreign offers. Cross-env aggregation is still one
  // flag away, but it is now an explicit choice (--all).
  if (envRef !== undefined && all) {
    throw usageError(`--env and --all are mutually exclusive\nusage: ${USAGE_LIST}`);
  }
  if (envRef === undefined && !all) {
    throw usageError(
      t(ctx.lang, 'service.scopeRequired') + '\n' +
      `usage: ${USAGE_LIST}`,
    );
  }

  // 顺带② (R13, u2-P3): --provider accepts a short agent prefix, resolved
  // against the scoped environments' visible agent roster BEFORE the query
  // string is built — a typo'd prefix now teaches instead of silently
  // returning an empty list.
  const providerRef = stringFlag(flags, 'provider');
  let provider = providerRef;
  if (providerRef !== undefined) {
    const envIds = envRef !== undefined
      ? [(await ctx.resolveEnv(envRef)).id]
      : (await ctx.listEnvs()).map(env => env.id);
    provider = await resolveProviderRef(ctx, providerRef, envIds);
  }
  const query = listQuery(flags, USAGE_LIST, provider);

  let services: ServiceEntry[];
  // envId → display name for the human table (best effort).
  const envNames = new Map<string, string>();
  if (envRef !== undefined) {
    const detail = await ctx.resolveEnv(envRef);
    envNames.set(detail.id, detail.name);
    services = await servicesOf(ctx, detail.id, query);
  } else {
    // --all: aggregate every visible environment. A single env failing
    // (transient error, lost membership mid-flight) is not fatal — skip it.
    services = [];
    const envs = await ctx.listEnvs();
    for (const env of envs) {
      envNames.set(env.id, env.name);
      try {
        services.push(...(await servicesOf(ctx, env.id, query)));
      } catch (error) {
        ctx.out.warn(
          `warning: skipping environment ${env.name} (${env.id}): ` +
          (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  if (ctx.json) {
    ctx.out.data(services);
    return;
  }
  if (all) {
    ctx.out.info(t(ctx.lang, 'service.aggregate', {
      count: services.length,
      envs: envNames.size,
    }));
  }
  ctx.out.table(
    services.map(service => serviceListRow(service, envNames.get(service.envId))),
    // T40d (R4, u3-F1): the drift marker column joins the list — a drifted
    // offer is visible where the marketplace is browsed, not only on `get`.
    ['id', 'name', 'type', 'origin', 'provider', 'drift', 'signability', 'env'],
  );
}

/**
 * T40d (R4, u3-F1): one `service list` table row — a DECLARATION-drifted
 * offer (provider does not declare the capability; the device still
 * executes it) carries the `⚠` marker so the human list matches what
 * `service get` warns about (the shared render.ts wording's marker face).
 * Pure for the render suite.
 */
export function serviceListRow(
  service: ServiceEntry,
  envName: string | undefined,
): Record<string, unknown> {
  return {
    id: service.id,
    name: service.name,
    type: service.semanticType,
    origin: service.origin,
    provider: service.provider.name,
    drift: service.declaredByProvider === false ? '⚠' : '',
    // T62 (R6, u4-F5): the signing-gate's backing-ambiguity verdict joins the
    // list — "propose will 409" is visible where offers are browsed.
    signability:
      service.signability?.verdict === 'ambiguous'
        ? '⚠ ambiguous'
        : service.signability?.verdict === 'unbacked'
          ? 'unbacked'
          : '',
    env: envName ?? service.envId,
  };
}

/**
 * T88 (R12, u2-F1): the visible service roster for short-prefix resolution —
 * the same scope `service list --all` walks. Best-effort: an environment
 * that fails to answer is skipped. Exported for the agreement family
 * (`agreement propose` resolves its serviceId through the same roster,
 * T124).
 */
export function serviceRoster(ctx: Ctx): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        const body = (await ctx.openClient().get(
          `/api/environments/${encodeURIComponent(env.id)}/services`,
        )) as { services: Array<{ id: string; name: string }> };
        for (const row of body.services) entries.push({ id: row.id, name: row.name });
      } catch {
        // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}

/**
 * T124: resolve a service ref to its FULL id — probe-GETs the ref; a 404
 * engages the visible-roster prefix resolver. For faces whose primary call
 * is not a service-GET (access close's second positional lanes, computation
 * register, subscribe) so the whole service family speaks one resolution.
 *
 * T131 (consent door regression): a CANONICAL FULL-LENGTH UUID is returned
 * as-is WITHOUT the probe. The probe-GET cannot see HIDDEN services (the
 * server answers 404 exactly like an unknown id to keep the existence leak
 * shut), yet the consent flow legitimately targets a hidden offer the caller
 * cannot see yet — `service access request` IS the door (T-058b), and the
 * probe-then-rewrite turned that request into a CLI-side dead end before the
 * server ever saw it (consent-semantics + render-walk svcHidden evidence).
 * A full id cannot be a prefix or a display name, so skipping the probe adds
 * nothing; the face's primary call stays server-authoritative (a bogus full
 * UUID gets the server's own 404 verbatim).
 */
export async function resolveServiceRef(ctx: Ctx, ref: string): Promise<string> {
  if (CANONICAL_UUID_RE.test(ref)) return ref;
  return getWithIdPrefix(ctx, {
    kind: 'service',
    ref,
    get: async candidate => {
      // optionalAuth endpoint: the probe carries the token when present.
      await ctx.openClient().get(`/api/services/${encodeURIComponent(candidate)}`);
      return candidate;
    },
    roster: serviceRoster(ctx),
    listHint: 'eaf service list --all (or --env <id|name>)',
  });
}

async function getService(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GET);
  const id = requirePositional(positionals, 'serviceId', USAGE_GET);
  // T88: <serviceId> accepts a short prefix — resolved against the visible
  // roster when the full-id GET 404s (unique match resolves, else teaching).
  // optionalAuth endpoint: openClient still sends the token when present.
  const service = (await getWithIdPrefix(ctx, {
    kind: 'service',
    ref: id,
    get: full => ctx.openClient().get(`/api/services/${encodeURIComponent(full)}`),
    roster: serviceRoster(ctx),
    listHint: 'eaf service list --all (or --env <id|name>)',
  })) as ServiceEntry;
  if (ctx.json) {
    ctx.out.data(service);
    return;
  }
  for (const line of renderServiceGetLines(service)) {
    // T72 (R8): every line of the detail face — ⚠ drift, signability
    // verdicts and the gate reason included — is payload explanation, part
    // of the human output. explain() puts it on stdout in human mode (two
    // rounds of users captured stdout and saw these lines "missing" while
    // they rode stderr); --json mode never reaches this loop (data() only).
    ctx.out.explain(line.text);
  }
}

/**
 * The `service get` HUMAN face as pure lines (T22 contract): rendered by
 * render-contract fixtures so a payload-shape change cannot silently blank
 * a section. T49 (R5, u3-F1): the declaration-drift ⚠ line rides the SAME
 * shared helper as `agreement get` and the `service list` drift column —
 * one 口径 for the governance-face annotation (漂移≠失败), never a second
 * sentence; the JSON face carries the same fact as declaredByProvider:false.
 */
export function renderServiceGetLines(
  service: ServiceEntry,
): Array<{ level: 'line' | 'warn'; text: string }> {
  const lines: Array<{ level: 'line' | 'warn'; text: string }> = [];
  const line = (text: string): void => {
    lines.push({ level: 'line', text });
  };
  const warn = (text: string): void => {
    lines.push({ level: 'warn', text });
  };

  line(`service ${service.id} "${service.name}" (${service.semanticType})`);
  line(
    `  origin=${service.origin} visibility=${service.visibility}` +
    `${service.unbacked ? ' unbacked' : ''} env=${service.envId}` +
    ` consumable=${service.consumable ?? !service.unbacked}`,
  );
  // T31 (R3 u2-F-04): the aggregate rule-lane backing — the SAME verdict the
  // signing gate answers, so the detail page and propose tell one story.
  if (service.backing) {
    line(
      `  backing: rule "${service.backing.rule}" actuates [${service.backing.actuates.join(', ')}] via ` +
      `${service.backing.devices.map(device => device.name).join(', ')}` +
      (service.backing.callableActions.length > 0
        ? ` — callable: ${service.backing.callableActions.join(', ')}`
        : ''),
    );
  }
  // R102: the human face carries the remedy text, not just the json field.
  if (service.consumableNote) {
    line(`  ⚠ ${service.consumableNote}`);
  }
  // T28 (R3 u3-F1) + T40a (R4): declaration drift — the offer stays
  // consumable (the bound device still executes it) but the declared offer
  // face drifted. The wording is the SHARED helper (agreement get renders
  // the same sentence — one 口径, never two copies).
  if (service.declaredByProvider === false) {
    warn(`  ${declarationDriftWarning(service.semanticType)}`);
  }
  // T62 (R6, u4-F5) + T68a (R7, u2-R7-1/2): the signing gate's verdict on
  // the detail face — EVERY verdict renders (R102: the human face is never
  // less than the json face; u2 saw verdict/reason/candidates on --json with
  // no human counterpart):
  // - ambiguous → the propose-time 409 class (SERVICE_BACKING_AMBIGUOUS)
  //   naming the exact candidate devices;
  // - unbacked → nothing to execute (aggregate rows included, u2-R7-5);
  // - backed → the quiet positive line (the precheck ran and passed);
  // and the gate's own `reason` rides along verbatim when the server sends
  // one — the same sentence the 409 teaches, never a paraphrase.
  if (service.signability) {
    const signability = service.signability;
    if (signability.readSource?.status === 'never-written') {
      // T84 (R10, u1-F3): read-source ambiguity — the computation reads
      // device state the world never wrote. Signing proceeds (speculative
      // agreements are legitimate); the face sets the READ expectation (the
      // honest COMPUTATION_DEVICE_STATE_UNWRITTEN refusal) instead of the
      // backing-ambiguity copy, whose "propose 将拒绝" would be a lie here.
      // T86 (R11, u1-F1): the promise is LAYERED by the probed lane — the
      // own-sim verdict must not claim the sim-less fallback refuses too
      // (u1: her sim-less default read landed on the world session and
      // returned the world's frozen initialization value).
      const fields = (signability.readSource.fields ?? []).map(name => `"${name}"`).join(', ');
      const lane =
        signability.readSource.probedLane !== 'own-sim'
          ? `权威 world-session（${signability.readSource.simulationId}）从未被写——落到该会话的读将诚实拒绝 ` +
            '（COMPUTATION_DEVICE_STATE_UNWRITTEN；无自有 sim 时默认读即落到该会话）'
          : `你的自有 sim（${signability.readSource.simulationId}）从未被写——带自有 sim 的 read 将诚实拒绝 ` +
            '（COMPUTATION_DEVICE_STATE_UNWRITTEN）；无自有 sim 时默认读会落到权威 world-session，' +
            '那是另一个世界、本探测未判定——其读可能成功返回世界初始化值（占位、可能长期不变）';
      warn(
        `  ⚠ signability: ambiguous（读源从未被写）— 计算读取的设备态（${fields}）在 ${lane}；` +
          '签约照常可成；建议先让场景写设备态、把指标改指 zone 参数面，或改绑定',
      );
    } else if (signability.verdict === 'ambiguous') {
      const devices = (signability.candidateDevices ?? []).map(name => `"${name}"`).join(', ');
      warn(
        `  ⚠ signability: ambiguous — 该服务可解析到多个承载设备 (${devices}) —— propose 将拒绝 ` +
          '（SERVICE_BACKING_AMBIGUOUS）；请提供方按设备发布派生服务或收窄绑定',
      );
    } else if (signability.verdict === 'unbacked') {
      // T103 (R16, u2-#2): the promise must MATCH the gate. AGGREGATE
      // unbacked is the assertAggregateDeliverable class — propose really is
      // refused (SERVICE_NOT_BACKED, T31). A PUBLISHED unbacked offer (no
      // covering device; read-only semantic types included) is NOT refused at
      // signing — T84's ruling: speculative agreements are legitimate, the
      // consumer signs WITH the expectation — and the honest refusals land at
      // runtime (invoke SERVICE_NOT_BACKED; a computation-backed read,
      // COMPUTATION_METRIC_NO_READING family). The old copy promised a
      // signing rejection the gate never enforces (u2 proposed + accepted a
      // ghost probe all the way to active) — wording now says exactly what
      // each lane does.
      // T108 (R17, u2-F2): the read half branches by the service's READ
      // SOURCE — a zone-query computation reads the world's ZONE parameter
      // face, not device state, so its `agreement read` SUCCEEDS (and meters)
      // with no backing device at all; promising a read refusal there was a
      // half-broken promise. Device-state / non-computation offers keep the
      // read-refusal promise (unbacked = nothing to read from).
      warn(
        service.origin === 'aggregate'
          ? '  ⚠ signability: unbacked — 该 aggregate 报价无可履约背板（签约将被拒 SERVICE_NOT_BACKED）'
          : service.computation?.kind === 'zone-query'
            ? '  ⚠ signability: unbacked — 该服务当前没有可履约的承载设备：签约不拦（投机合约是合法的，' +
              '按此预期签约），但 invoke 将诚实拒绝 SERVICE_NOT_BACKED；read 走 zone 参数面' +
              '（zone-query 计算不依赖承载设备），世界参数在即成功返回并正常计量落账'
            : '  ⚠ signability: unbacked — 该服务当前没有可履约的承载设备：签约不拦（投机合约是合法的，' +
              '按此预期签约），但 invoke 将诚实拒绝 SERVICE_NOT_BACKED；只读数据服务的 read 同样诚实拒绝',
      );
    } else {
      line('  signability: backed（签约预检通过）');
    }
    if (signability.reason) {
      warn(`    signability reason: ${signability.reason}`);
    }
  }
  // MI-D: the flow-service contract — one 'run' action over the flow's
  // declared inputs surface, delegate count surfaced (Wave-A caution).
  if (service.origin === 'flow' && service.sourceFlowId !== undefined) {
    const run = service.interface?.actions?.find(action => action.name === 'run');
    const params = Object.entries(run?.parameters ?? {});
    line(`  flow: ${service.sourceFlowId}`);
    line(
      `  run params: ${params.length === 0 ? '(none)' : params.map(([name, spec]) => `${name}: ${JSON.stringify(spec)}`).join(', ')}`,
    );
    const delegateCount = service.interface?.delegateNodeCount;
    line(
      delegateCount !== undefined && delegateCount > 0
        ? `  delegate nodes: ${delegateCount} (agent judgment inside the run — timeout + fallback apply)`
        : '  delegate nodes: 0 (purely deterministic)',
    );
    line(`  invoke: eaf agreement invoke <agreementId> --action run --params '<json>'`);
  }
  // R14 Wave-A: a registered computation makes the offer a readable data
  // product — surface the delivery lane next to the callable surface.
  if (service.computation) {
    line(
      `  computation: ${service.computation.kind} (refresh ${service.computation.refreshSec}s, ` +
      `schema v${service.computation.schemaVersion}) — read via \`eaf agreement read\``,
    );
    const fields = service.interface?.dataSchema?.fields ?? [];
    if (fields.length > 0) {
      line(`  dataSchema: ${fields.map(field => field.name).join(', ')}`);
    }
    const excludes = service.interface?.excludes ?? [];
    if (excludes.length > 0) {
      line(`  excludes: ${excludes.join('; ')}`);
    }
  }
  line(`  provider: ${service.provider.name} (${service.provider.id})` +
    ` — owner ${service.provider.owner.displayName}`);
  line(`  reputation: ${reputationFace(service.reputation)}`);
  // R101/R102: the verifiable履约摘要 (30-day aggregate) + cold-start marker.
  const summary = service.usageSummary;
  if (summary !== undefined && summary !== null) {
    line(
      `  usage (last ${summary.windowDays}d): ${summary.invocations} invocations · ` +
      `${summary.succeeded} succeeded · ${summary.failed} failed` +
      (summary.partial > 0 ? ` · ${summary.partial} partial (AC 部分达成)` : '') +
      (summary.other > 0 ? ` · ${summary.other} other (历史/其他口径)` : '') +
      (summary.successRate !== null ? ` · success ${(summary.successRate * 100).toFixed(1)}%` : ''),
    );
  }
  // T121 (R10-u4): the two ledgers side by side carry their口径 inline —
  // reputation is all-history, usage is the rolling window; without the
  // note the smaller usage number reads as a contradiction (R102: the
  // human face renders every explanatory field the JSON carries).
  if (service.methodologyNote) {
    line(
      `  口径: reputation=全历史 invoke 账（分数带时间衰减） · ` +
        `usage=近 ${summary?.windowDays ?? '?'} 天滚动窗口 —— 两数分母不同，不可直接对账`,
    );
  }
  line(
    `  track record: ${service.trackRecord === 'established' ? 'established (有履约记录)' : 'none (暂无履约记录)'}`,
  );
  // T64 (R6, u2-F-2-4/u4-F14): the口径 note when "暂无履约记录" and a real
  // usage row sit on the same page — the human face renders the companion
  // sentence instead of leaving the two figures looking contradictory.
  if (service.trackRecordNote) {
    line(`  ⚠ ${service.trackRecordNote}`);
  }
  if (service.description) line(`  ${service.description}`);
  // Callable surface (F-27): derived services list their backing device's
  // actions with parameter schemas — what `agreement invoke --action` accepts.
  const actions = service.interface?.actions ?? [];
  if (actions.length > 0) {
    line('  actions:');
    for (const action of actions) {
      const params = Object.entries(action.parameters ?? {})
        .map(([key, hint]) =>
          `${key}: ${hint.type ?? 'unknown'}${hint.enum ? ` (${hint.enum.join('|')})` : ''}`,
        )
        .join(', ');
      line(`    - ${action.name}${params ? `(${params})` : ''}`);
    }
  }
  return lines;
}

/**
 * T37 (R3, u4-F4): the human reputation face — a ZERO-sample score is the
 * Bayesian PRIOR, not a measured 0.7, so it renders as `—（无履约样本，先验
 * x）` (never a bare `score 0.7`). With real attempts the score renders
 * plainly. Pure for the render suite. R102: counts are integer counts; a
 * fractional remainder is AC partial credit — named, never the cryptic
 * "0.5/1"混写 (zhao-20). T40j (R4, u2#3): the measured score rounds to two
 * decimals — a 16-digit float (`score 0.6818455374547898`) is machine data,
 * not a human face.
 */
export function reputationFace(reputation: {
  score: number;
  attempts: number;
  successes: number;
  prior?: number;
}): string {
  const successes =
    `succeeded ${Math.floor(reputation.successes)}` +
    (Number.isInteger(reputation.successes)
      ? ''
      : ` (+${(reputation.successes % 1).toFixed(1)} partial credit)`);
  if (Math.round(reputation.attempts) === 0) {
    const prior = reputation.prior ?? reputation.score;
    return `—（无履约样本，先验 ${prior}） · attempts 0 · succeeded 0`;
  }
  return `score ${reputation.score.toFixed(2)} · attempts ${Math.round(reputation.attempts)} · ${successes}`;
}

async function subscribe(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_SUBSCRIBE);
  const id = requirePositional(positionals, 'serviceId', USAGE_SUBSCRIBE);
  // T124 (R19-u2 F1): the subscribe face joins the prefix family — the
  // roster id is truncated and copied; a prefix 404 now resolves instead of
  // lying NOT_FOUND three times.
  const fullId = await resolveServiceRef(ctx, id);
  const result = (await ctx
    .authedClient()
    .request('PUT', `/api/services/${encodeURIComponent(fullId)}/subscribe`)) as SubscribeResult;
  if (ctx.json) {
    ctx.out.data(result);
  } else if (result.alreadySubscribed) {
    ctx.out.line(`already subscribed to service ${result.serviceId}`);
  } else {
    ctx.out.line(`subscribed to service ${result.serviceId}`);
  }
}

async function unsubscribe(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_UNSUBSCRIBE);
  const id = requirePositional(positionals, 'serviceId', USAGE_UNSUBSCRIBE);
  const fullId = await resolveServiceRef(ctx, id); // T124 prefix family
  await ctx.authedClient().request('DELETE', `/api/services/${encodeURIComponent(fullId)}/subscribe`);
  if (ctx.json) ctx.out.data({ unsubscribed: fullId });
  else ctx.out.line(`unsubscribed from service ${fullId}`);
}
