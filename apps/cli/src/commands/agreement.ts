/**
 * `eaf agreement` — the service consumption chain (Fix-11,
 * service-consumption-design.md §3–§4): propose and decide bilateral
 * service agreements, invoke consumption against a running simulation, and
 * audit the append-only usage metering. (`subscribe` stays the lightweight
 * bookmark; an agreement is its heavyweight, contract-grade upgrade.)
 */

import {
  boolFlag,
  jsonFlag,
  parse,
  requirePositional,
  requireString,
  stringFlag,
} from '../args.js';
import { getWithIdPrefix, type Ctx, type IdRosterEntry } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';
import { declarationDriftWarning } from '../render.js';
import { resolveServiceRef, type ServiceEntry } from './service.js';

const USAGE_PROPOSE = 'eaf agreement propose <serviceId> [--consumer-agent <agentId>] [--terms \'{}\']';
const USAGE_LIST = 'eaf agreement list --env <id|name> [--role consumer|provider] [--status <status>] [--include terminated]';
const USAGE_GET = 'eaf agreement get <agreementId>';
const USAGE_DECIDE = 'eaf agreement decide <agreementId> accept|reject [--reason <text>]';
const USAGE_COUNTER = 'eaf agreement counter <agreementId> --terms \'{"quotaPerWindow":3, ...}\'';
const USAGE_REMIND = 'eaf agreement remind <agreementId>';
const USAGE_SUSPEND = 'eaf agreement suspend <agreementId> [--reason <text>]';
const USAGE_HOLD = 'eaf agreement hold <agreementId> [--duration <sec>]';
const USAGE_RESUME = 'eaf agreement resume <agreementId>';
const USAGE_TERMINATE = 'eaf agreement terminate <agreementId> [--reason <text>]';
const USAGE_INVOKE = "eaf agreement invoke <agreementId> --action <a> [--params '{}'] [--sim <simId>]";
const USAGE_USAGE = 'eaf agreement usage <agreementId>';
const USAGE_RECEIPTS = 'eaf agreement receipts <agreementId>';
const USAGE_STREAM = 'eaf agreement stream <agreementId> [--params temperature,co2]';
const USAGE_READ = 'eaf agreement read <agreementId> [--fields a,b] [--simulation <simId>] [--latest]';

const AGREEMENT_STATUSES = ['proposed', 'countered', 'active', 'held', 'rejected', 'suspended', 'terminated'] as const;

/**
 * T21 (R3, u2-F-01/u4-F1): the restricted terminated-view wire shape — the
 * CLI face of the server's `terminatedAgreementRestrictedJson`
 * (apps/server/src/agreements/view.ts). Participants ride the
 * `consumerAgentName`/`consumerAgentId`/`providerAgentName`/
 * `providerAgentId` fields; there is NO `consumer`/`provider`
 * owner object, no terms, no effectiveTerms. Reading this shape through the
 * full-view renderer crashed (`undefined.displayName`) — so the variant is
 * its own type and the compiler, not a runtime crash, guards the fields.
 */
export interface RestrictedAgreementEntry {
  id: string;
  envId: string;
  status: string;
  source: string;
  collaborationId: string | null;
  service: { id: string | null; name: string | null };
  consumerAgentId: string | null;
  consumerAgentName: string | null;
  providerAgentId: string | null;
  providerAgentName: string | null;
  outcome: string;
  terminatedAt: string;
  view: 'restricted';
}

/** Narrow the get/list payload to its restricted terminated-view variant. */
export function isRestrictedAgreement(
  entry: AgreementEntry | RestrictedAgreementEntry,
): entry is RestrictedAgreementEntry {
  return (entry as { view?: unknown }).view === 'restricted';
}

/** One party's HUMAN label per view: owner displayName (full) / agent name (restricted). */
function partyLabel(
  entry: AgreementEntry | RestrictedAgreementEntry,
  side: 'consumer' | 'provider',
): string {
  if (isRestrictedAgreement(entry)) {
    return entry[`${side}AgentName`] ?? entry[`${side}AgentId`] ?? '—';
  }
  return entry[side].displayName;
}

/** Service label per view (the restricted shape carries no top-level serviceId). */
function serviceLabel(entry: AgreementEntry | RestrictedAgreementEntry): string {
  if (isRestrictedAgreement(entry)) {
    return entry.service?.name ?? entry.service?.id ?? '—';
  }
  return entry.service?.name ?? entry.serviceId;
}

/** Recency label per view (the restricted shape carries terminatedAt only). */
function updatedAtLabel(entry: AgreementEntry | RestrictedAgreementEntry): string {
  return isRestrictedAgreement(entry) ? entry.terminatedAt : entry.updatedAt;
}

/**
 * T21/T30: one `agreement list` table row, view-aware — restricted
 * terminated rows render agent labels (never owner displayNames), full rows
 * render as before. T40c (R4, u4-P2-4): terminated rows carry the outcome
 * column (the ONE `terminatedAgreementOutcome` 口径) so a terminated row's
 * "delivered or not" is readable from the list — non-terminated rows render
 * `—` (no invented value). Pure for the render suite.
 *
 * T79 (R8): the walker caught the list face carrying the drift fact in --json
 * (service.declaredByProvider:false) with no human counterpart — the service
 * cell now carries the SAME ⚠ marker the service list column uses (T49 口径),
 * so the governance annotation survives the list scan.
 */
export function agreementListRow(entry: AgreementEntry | RestrictedAgreementEntry): Record<string, unknown> {
  // The drift fact rides the agreement ROW (flattened by the serializer,
  // next to declarationDrift) — the restricted shape strips it, so the flag
  // is read through the full-view shape only (absent → no marker).
  const drifted = (entry as { declaredByProvider?: boolean }).declaredByProvider === false;
  // UX-16: the contention summary rides FULL-view rows only (restricted
  // rows leak no automation topology) — a contending row is marked, never
  // silently listed (last-writer-wins is by design; the ⚠ is the warning).
  const contention = (entry as { contentionSummary?: { count: number; pairs: number } }).contentionSummary;
  return {
    id: entry.id,
    service: drifted ? `${serviceLabel(entry)} ⚠` : serviceLabel(entry),
    status: entry.status,
    outcome: entry.outcome ?? '—',
    consumer: partyLabel(entry, 'consumer'),
    provider: partyLabel(entry, 'provider'),
    contention: contention !== undefined ? `⚠×${contention.count}` : '',
    updatedAt: updatedAtLabel(entry),
  };
}

/** ServiceAgreement wire shape (subset — GET list / lifecycle responses). */
export interface AgreementEntry {
  id: string;
  envId: string;
  serviceId: string;
  service: { id: string; name: string; semanticType: string } | null;
  /** Fix-20: resolveBackingDevice result — null when the offer is unbacked. */
  backingDeviceId: string | null;
  /** R98: the backing device's real executable commands (null = unbacked) —
   *  the callable action surface visible at signing time. */
  callableActions: string[] | null;
  /** T8 (R2): aggregate offers carry the RULE-lane backing view — the same
   *  judgment as the signing gates and the invoke lane (null = genuinely
   *  unbacked; absent on non-aggregate rows). */
  backing?: {
    kind: 'rule';
    rule: string;
    actuates: string[];
    devices: Array<{ id: string; name: string }>;
    callableActions: string[];
  } | null;
  consumerAgentId: string | null;
  consumer: { id: string; displayName: string };
  providerAgentId: string;
  provider: { id: string; displayName: string };
  terms: Record<string, unknown>;
  /** T-059: the provider's counter-offer (present while countered / accepted via one; the original terms are never touched during negotiation). */
  counteredTerms: Record<string, unknown> | null;
  /** T-059: the terms that would take effect NOW (countered → counteredTerms; else terms) — never re-derive from status. */
  effectiveTerms: Record<string, unknown>;
  /** T-052/T-059: a BINDING structured clause (terms.action.command / terms.read) exists in the effective terms. */
  termsEnforced: boolean;
  status: string;
  /** D3 (T-080): present while status='held' — the hold's wall-clock expiry. */
  holdExpiresAt?: string;
  /** T6 (R2): present on the restricted terminated-view lanes — the caller
   *  is a member/stranger reading world history, not a party. */
  view?: 'restricted';
  /** T9 (R2): the remind trace — absent = never reminded. */
  lastRemindedAt?: string;
  remindCount?: number;
  /** R102: present when status='terminated' — when it ended + the shared
   *  outcome 口径 (metered outcome / cancelled / completed). */
  terminatedAt?: string;
  outcome?: string;
  /** v60/R102: WHY the row reached its current status — a platform reason
   *  ('provider-unavailable' / 'service-unavailable' / 'ac-completed' /
   *  'ac-cancelled') or a party-provided free-text decision reason. Absent
   *  when no reason was recorded. */
  statusReason?: string;
  /** T28/T40a: present (false) when the provider agent does not declare
   *  the contracted service's capability (the bound device still executes
   *  it — invocable, governance face drifted). */
  declaredByProvider?: false;
  /** T28/T40a: the drift detail (capability + the server's note); absent
   *  while the declaration covers the capability. */
  declarationDrift?: { capability: string; note: string };
  /** UX-16: the list-face contention summary — present only on FULL-view
   *  rows whose trigger automation shares a (deviceId, param) pair with ≥1
   *  other ACTIVE agreement (count = distinct contenders, pairs = shared
   *  pairs). Last-writer-wins is by design; the summary is the warning. */
  contentionSummary?: { count: number; pairs: number };
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecordEntry {
  id: string;
  agreementId: string;
  kind: string;
  action: string | null;
  quantity: number;
  unit: string;
  outcome: string;
  /** C3/R102: WHY a failure failed (teaching text; only on failure rows). */
  failureReason?: string;
  /** v58: the metered service's origin (derived/published/flow/aggregate). */
  origin?: string;
  /** FEAT-08 (v66): the simulation that metered the row. */
  simulationId?: string;
  /** UX-04 (v67): the invoke lane's entry kind (manual/autoTrigger/autoReset). */
  source?: string;
  effectRef: string | null;
  startedAt: string;
  endedAt: string;
}

interface InvocationResult {
  agreementId: string;
  simulationId: string;
  /** Device lanes: the commanded device. Flow-service lanes: null. */
  deviceId: string | null;
  action: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** MI-D: flow-service invokes echo the delivered run (applied.flow). */
  applied?: {
    flow?: {
      flowId: string;
      runId: string;
      status: string;
      triggerKind: string;
      inputs?: Record<string, unknown>;
    };
  };
  usage: UsageRecordEntry;
  receiptId: string;
}

/**
 * T88 (R12, u2-F1): the visible agreement roster for short-prefix resolution
 * — every environment the caller can read, terminated rows included
 * (restricted rows carry their id too). Best-effort: an environment that
 * fails to answer is skipped, and a fully failed scan rethrows the get
 * face's original 404 (the resolver's contract).
 */
function agreementRoster(ctx: Ctx): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        const body = (await ctx.authedClient().get(
          `/api/agreements?envId=${encodeURIComponent(env.id)}&include=terminated`,
        )) as { agreements: Array<AgreementEntry | RestrictedAgreementEntry> };
        for (const row of body.agreements) {
          entries.push({
            id: row.id,
            name: isRestrictedAgreement(row)
              ? (row.service?.name ?? row.service?.id ?? undefined)
              : (row.service?.name ?? row.serviceId),
          });
        }
      } catch {
        // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}

/** T88: run one agreement-keyed GET with short-prefix fallback (get/usage/receipts). */
function agreementRefGet<T>(ctx: Ctx, ref: string, get: (fullId: string) => Promise<T>): Promise<T> {
  return getWithIdPrefix(ctx, {
    kind: 'agreement',
    ref,
    get,
    roster: agreementRoster(ctx),
    listHint: 'eaf agreement list --env <id|name> [--include terminated]',
  });
}

/**
 * T124: resolve an agreement ref to its FULL id without performing the face's
 * own (mutating or streaming) call — a probe-GET stands in for the primary
 * call so a 404 engages the roster resolver. stream uses this before opening
 * the socket (a WebSocket handshake cannot ride the 404-then-retry pattern).
 */
export async function resolveAgreementRef(ctx: Ctx, ref: string): Promise<string> {
  return agreementRefGet(ctx, ref, async candidate => {
    await ctx.authedClient().get(`/api/agreements/${encodeURIComponent(candidate)}`);
    return candidate;
  });
}

export async function agreementCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'propose':
      return propose(ctx, argv);
    case 'list':
      return listAgreements(ctx, argv);
    case 'get':
      return getAgreement(ctx, argv);
    case 'decide':
      return decide(ctx, argv);
    case 'counter':
      return counter(ctx, argv);
    case 'remind':
      return remind(ctx, argv);
    case 'suspend':
    case 'terminate':
      return lifecycleAction(ctx, argv, sub);
    case 'hold':
      return hold(ctx, argv);
    case 'resume':
      return resume(ctx, argv);
    case 'invoke':
      return invoke(ctx, argv);
    case 'usage':
      return usage(ctx, argv);
    case 'receipts':
      return receipts(ctx, argv);
    case 'read':
      return read(ctx, argv);
    case 'stream':
      return stream(ctx, argv);
    default:
      throw usageError(
        `unknown agreement subcommand "${sub ?? ''}" (expected propose|list|get|decide|counter|remind|suspend|hold|resume|terminate|invoke|read|usage|receipts|stream)`,
      );
  }
}

async function propose(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { 'consumer-agent': { type: 'string' }, terms: { type: 'string' } },
    USAGE_PROPOSE,
  );
  const serviceRef = requirePositional(positionals, 'serviceId', USAGE_PROPOSE);
  const consumerAgentId = stringFlag(flags, 'consumer-agent');
  const terms = jsonFlag<Record<string, unknown>>(flags, 'terms', USAGE_PROPOSE);
  if (terms !== undefined && (typeof terms !== 'object' || terms === null || Array.isArray(terms))) {
    throw usageError(`--terms must be a JSON object\nusage: ${USAGE_PROPOSE}`);
  }
  // T124 (R19-u1 F4): the propose face joins the prefix family — the
  // serviceId slot resolves against the visible service roster, and
  // --consumer-agent resolves against the TARGET service's env agents
  // (both used to 404 with the misleading NOT_FOUND on a copied prefix).
  const serviceId = await resolveServiceRef(ctx, serviceRef);
  let consumerAgentFullId: string | undefined;
  if (consumerAgentId !== undefined) {
    const service = (await ctx.openClient().get(
      `/api/services/${encodeURIComponent(serviceId)}`,
    )) as ServiceEntry;
    const agentId = await getWithIdPrefix(ctx, {
      kind: 'agent',
      ref: consumerAgentId,
      get: async candidate => {
        // Probe: the agent must be an env-row member of the service's env
        // (no single-agent GET exists — the env roster is the authority).
        const envDetail = await ctx.resolveEnv(service.envId);
        if (!envDetail.agents.some(agent => agent.id === candidate)) {
          throw new CliError(
            `agent "${candidate}" not found in environment "${service.envId}"`,
            EXIT.NOT_FOUND,
          );
        }
        return candidate;
      },
      roster: async () => {
        const detail = await ctx.resolveEnv(service.envId);
        return detail.agents.map(agent => ({ id: agent.id, name: agent.name }));
      },
      listHint: `eaf agent list --env ${service.envId}`,
    });
    consumerAgentFullId = agentId;
  }
  const agreement = (await ctx.authedClient().post(
    `/api/services/${encodeURIComponent(serviceId)}/agreements`,
    {
      ...(consumerAgentFullId !== undefined ? { consumerAgentId: consumerAgentFullId } : {}),
      ...(terms !== undefined ? { terms } : {}),
    },
  )) as AgreementEntry;
  if (ctx.json) {
    ctx.out.data(agreement);
  } else {
    ctx.out.line(
      `agreement ${agreement.id} proposed (${agreement.status}) — ` +
      `${agreement.service?.name ?? agreement.serviceId}, awaiting the provider's decision`,
    );
  }
}

async function listAgreements(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { env: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' }, include: { type: 'string' } },
    USAGE_LIST,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const role = stringFlag(flags, 'role');
  if (role !== undefined && role !== 'consumer' && role !== 'provider') {
    throw usageError(`--role must be consumer|provider\nusage: ${USAGE_LIST}`);
  }
  const status = stringFlag(flags, 'status');
  if (status !== undefined && !(AGREEMENT_STATUSES as readonly string[]).includes(status)) {
    throw usageError(`--status must be ${AGREEMENT_STATUSES.join('|')}\nusage: ${USAGE_LIST}`);
  }
  // R5-F06: --include terminated opens the env's terminated agreements to
  // members (completed collaborations as world history). R5-F08: on a
  // public environment a stranger's token gets the restricted view of the
  // same rows (server-side; the CLI just passes the parameter through).
  const include = stringFlag(flags, 'include');
  if (include !== undefined && include !== 'terminated') {
    throw usageError(`--include must be terminated\nusage: ${USAGE_LIST}`);
  }
  const detail = await ctx.resolveEnv(requireString(flags, 'env', USAGE_LIST));
  const params = new URLSearchParams({ envId: detail.id });
  if (role !== undefined) params.set('role', role);
  if (status !== undefined) params.set('status', status);
  if (include !== undefined) params.set('include', include);
  const body = (await ctx.authedClient().get(`/api/agreements?${params}`)) as {
    // T21/T30: terminated rows may arrive as the restricted variant (strangers
    // today; members once the server converges list to the same view) — the
    // table renders agent names for those, never owner displayNames.
    agreements: Array<AgreementEntry | RestrictedAgreementEntry>;
    /** R99: the caller's own newest terminated agreements (auto-terminated
     *  AC ephemerals stay discoverable between list runs). */
    recentlyTerminated?: AgreementEntry[];
  };
  if (ctx.json) {
    // Legacy --json contract stays the bare array (existing consumers); the
    // discoverability signal rides the human output below and the API's
    // recentlyTerminated field.
    ctx.out.data(body.agreements);
    return;
  }
  ctx.out.table(
    body.agreements.map(agreementListRow),
    // T40c (R4): the outcome column joins the list — terminated rows show
    // the shared outcome 口径, everything else `—`.
    // UX-16: the contention column — ⚠×N marks rows whose trigger
    // automation races other active agreements (last-writer-wins by design).
    ['id', 'service', 'status', 'outcome', 'consumer', 'provider', 'contention', 'updatedAt'],
  );
  // R99 (wang-07): a platform-auto-terminated agreement must never look
  // "vanished" — name the fresh terminal state and where the full view is.
  if ((body.recentlyTerminated ?? []).length > 0) {
    const lines = (body.recentlyTerminated ?? []).map(
      agreement =>
        `${agreement.id} (${agreement.service?.name ?? agreement.serviceId}, ` +
        `terminated at ${agreement.terminatedAt ?? agreement.updatedAt}, outcome: ${agreement.outcome ?? 'unknown'})`,
    );
    ctx.out.line(
      `recently terminated (yours): ${lines.join('; ')} — ` +
      'terminated agreements stay queryable (agreement get/usage/receipts); ' +
      'the full env view is --include terminated',
    );
  }
}

/**
 * `eaf agreement get <id>` — one agreement's detail (GET /api/agreements/:id):
 * status, parties, effective terms, hold expiry, plus the server's pre-flight
 * hints. Parties + env owner get the full view; members/strangers reading a
 * TERMINATED agreement get the restricted view (T21 — rendered by its own
 * branch, never by dereferencing full-view fields).
 */
async function getAgreement(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GET);
  const id = requirePositional(positionals, 'agreementId', USAGE_GET);
  // T88: <agreementId> accepts a short prefix — resolved against the visible
  // roster when the full-id GET 404s (unique match resolves, else teaching).
  const agreement = (await agreementRefGet(ctx, id, full =>
    ctx.authedClient().get(`/api/agreements/${encodeURIComponent(full)}`),
  )) as AgreementGetDetail;
  // T40h (R4, u4-P2-2): the delivery companion reads the usage ledger — one
  // best-effort GET (parties/env owner AND world-history readers may both;
  // a refusal just means the note honestly stays absent, never a failure —
  // the get itself still succeeds).
  let usage: UsageRecordEntry[] | undefined;
  if (agreement.status === 'terminated') {
    try {
      const body = (await ctx.authedClient().get(
        `/api/agreements/${encodeURIComponent(agreement.id)}/usage`,
      )) as { usage: UsageRecordEntry[] };
      usage = body.usage;
    } catch {
      // no ledger access — the delivery note stays absent (honest absence)
    }
  }
  const deliveryNote = terminatedDeliveryNote(agreement, usage);
  if (ctx.json) {
    // T40h: the --json face carries the same companion as a CLI-side field
    // (server semantics untouched — `terminatedAgreementOutcome` remains the
    // one outcome 口径).
    ctx.out.data(deliveryNote !== undefined ? { ...agreement, deliveryNote } : agreement);
    return;
  }
  for (const text of renderAgreementGetLines(agreement, deliveryNote)) ctx.out.line(text);
}

/**
 * T40h (R4, u4-P2-2): the delivery-companion note for a TERMINATED agreement
 * whose metered rows are collaboration-only (kind 'ac') — outcome 'success'
 * then means "the collaboration completed", NOT "a service call was
 * delivered" (u4's 6cf76c68: one collaboration row → success, zero
 * invocations). Derived from the usage ledger the reader can audit;
 * `terminatedAgreementOutcome` stays the ONE outcome 口径 (AGENTS.md) and is
 * never rewritten here. Undefined when the status isn't terminated, the
 * ledger is unreadable, it is empty (outcome already says
 * cancelled/ended-without-delivery), or any service-lane row exists. Pure
 * for the render suite.
 */
export function terminatedDeliveryNote(
  agreement: Pick<AgreementEntry, 'status'>,
  usage: ReadonlyArray<Pick<UsageRecordEntry, 'kind'>> | undefined,
): string | undefined {
  if (agreement.status !== 'terminated' || usage === undefined || usage.length === 0) {
    return undefined;
  }
  return usage.every(row => row.kind === 'ac') ? '（协作完成、未见服务调用）' : undefined;
}

/** The get payload: either wire view plus the server's pre-flight hint fields. */
export type AgreementGetDetail = (AgreementEntry | RestrictedAgreementEntry) & {
  backingDeviceDrift?: unknown;
  contentions?: unknown;
};

/**
 * T21 (R3, u2-F-01/u4-F1): the human get face as a PURE function (fixture
 * testable, humanZoneTable pattern). The restricted variant short-circuits
 * BEFORE any full-view field is touched — the Batch 2 regression read
 * `agreement.consumer.displayName` unconditionally and crashed with a
 * TypeError on the restricted payload (which carries only the
 * consumerAgent/providerAgent fields).
 *
 * T40h (R4, u4-P2-2): `deliveryNote` — the delivery-companion note derived
 * from the usage ledger (see terminatedDeliveryNote). Optional; absent when
 * the ledger was unreadable (honest absence, never a guessed note).
 */
export function renderAgreementGetLines(agreement: AgreementGetDetail, deliveryNote?: string): string[] {
  if (isRestrictedAgreement(agreement)) {
    return [
      `agreement ${agreement.id} — ${serviceLabel(agreement)} (${agreement.status})` +
        ` — terminated at ${agreement.terminatedAt}, outcome: ${agreement.outcome ?? 'unknown'}` +
        (deliveryNote !== undefined ? deliveryNote : ''),
      `  consumer: agent ${agreement.consumerAgentName ?? agreement.consumerAgentId ?? '—'}` +
        ` · provider: agent ${agreement.providerAgentName ?? agreement.providerAgentId ?? '—'}`,
      '  (restricted view — world history: participants as agents, outcome, time; ' +
        'full detail is for the parties and the env owner)',
    ];
  }
  const lines = [
    `agreement ${agreement.id} — ${agreement.service?.name ?? agreement.serviceId} (${agreement.status})` +
    (agreement.status === 'held' && agreement.holdExpiresAt !== undefined
      ? ` until ${agreement.holdExpiresAt}`
      : '') +
    // R99: terminated is a visible terminal state — when + why, not "gone".
    // T40h: a collaboration-only ledger appends the delivery companion so
    // "success" is never misread as "a service call was delivered".
    (agreement.status === 'terminated'
      ? ` — terminated at ${agreement.terminatedAt ?? agreement.updatedAt}, outcome: ${agreement.outcome ?? 'unknown'}` +
        (deliveryNote !== undefined ? deliveryNote : '')
      : ''),
    `  consumer: ${agreement.consumer.displayName}${agreement.consumerAgentId !== null ? ` (agent ${agreement.consumerAgentId})` : ''}` +
    ` · provider: ${agreement.provider.displayName} (agent ${agreement.providerAgentId})`,
  ];
  // T9 (R2): the remind trace — "reminded and waiting" must be readable.
  if (agreement.remindCount !== undefined && agreement.remindCount > 0) {
    lines.push(
      `  reminders: ${agreement.remindCount} (last at ${agreement.lastRemindedAt ?? '?'})`,
    );
  }
  // R102 (wang-18) + T40b (R4, u1-F4): the reason channel in human mode for
  // EVERY status — an accept reason on an active agreement is as much a
  // decision record as a rejection. A recorded reason is shown verbatim;
  // none shows 未记录原因 (never a bare null, R102 空值口径).
  lines.push(`  reason: ${agreement.statusReason ?? '（未记录原因）'}`);
  lines.push(
    `  effective terms: ${JSON.stringify(agreement.effectiveTerms)}` +
    (agreement.termsEnforced ? '' : ' (no structured clause — invoke scope unrestricted)'),
  );
  // T8 (R2): the aggregate rule-lane backing view replaces the false
  // "unbacked offer" warning — the detail face now speaks the SAME judgment
  // as the signing gates (propose/counter/accept 409) and the invoke lane.
  if (agreement.backing) {
    lines.push(
      `  backing: rule "${agreement.backing.rule}" actuates [${agreement.backing.actuates.join(', ')}] ` +
      `via ${agreement.backing.devices.length} device(s) (${agreement.backing.devices.map(d => d.name).join(', ')})`,
    );
  }
  if (agreement.callableActions !== undefined) {
    lines.push(
      agreement.callableActions === null && agreement.backing === null
        ? '  callable actions: (unbacked aggregate offer — no semantic offer rule or no bound device holding its ' +
          'actuation capabilities; propose/invoke refuse SERVICE_NOT_BACKED — bind a device or re-declare the rule)'
        : agreement.callableActions === null
          ? '  callable actions: (unbacked offer — no backing device, invokes refuse SERVICE_NOT_BACKED)'
          : `  callable actions: ${agreement.callableActions.join(', ') || '(none — the backing device has no executable commands)'}`,
    );
  }
  if (agreement.counteredTerms !== null && agreement.status === 'countered') {
    lines.push(`  counter-offer on the table: ${JSON.stringify(agreement.counteredTerms)} — the consumer decides`);
  }
  // T40a (R4, u3-F2/u2#2): declaration drift on the CONTRACTED service —
  // the same shared warning the service face renders (one wording, one
  // helper; render.ts). Disappears again once the provider re-declares.
  if (agreement.declaredByProvider === false) {
    lines.push(
      `  ${declarationDriftWarning(agreement.declarationDrift?.capability ?? agreement.service?.semanticType ?? '?')}`,
    );
  }
  if (agreement.backingDeviceDrift !== undefined) {
    lines.push(`  ⚠ backing-device drift: ${JSON.stringify(agreement.backingDeviceDrift)}`);
  }
  if (agreement.contentions !== undefined) {
    lines.push(`  ⚠ contended device params: ${JSON.stringify(agreement.contentions)}`);
  }
  return lines;
}

async function decide(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { reason: { type: 'string' } }, USAGE_DECIDE);
  if (positionals.length !== 2) {
    throw usageError(`expected <agreementId> and accept|reject\nusage: ${USAGE_DECIDE}`);
  }
  const [id, decision] = positionals;
  if (decision !== 'accept' && decision !== 'reject') {
    throw usageError(`decision must be accept|reject\nusage: ${USAGE_DECIDE}`);
  }
  const reason = stringFlag(flags, 'reason');
  // 顺带② (R13, u1-F2 / u2-P3, T88 leftover): decide joins the prefix family
  // — `agreement decide <short-id>` used to 404 while `agreement get <same
  // short-id>` resolved one second earlier (u1's "自相矛盾").
  const agreement = await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/decide`,
    { decision, ...(reason !== undefined ? { reason } : {}) },
  )) as AgreementEntry;
  if (ctx.json) ctx.out.data(agreement);
  else ctx.out.line(`agreement ${agreement.id} → ${agreement.status} (${decision})`);
}

/**
 * `eaf agreement counter <id> --terms` (T-059, design-consent-semantics.md
 * §5): the provider's counter-offer with FULL new terms — the decide right
 * passes to the consumer. Depth 1; renegotiation = terminate + re-propose.
 */
async function counter(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { terms: { type: 'string' } }, USAGE_COUNTER);
  const id = requirePositional(positionals, 'agreementId', USAGE_COUNTER);
  const terms = jsonFlag<Record<string, unknown>>(flags, 'terms', USAGE_COUNTER);
  if (terms === undefined || typeof terms !== 'object' || terms === null || Array.isArray(terms)) {
    throw usageError(`--terms must be a JSON object (the FULL new terms)\nusage: ${USAGE_COUNTER}`);
  }
  const agreement = (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/counter`,
    { terms },
  ))) as AgreementEntry;
  if (ctx.json) {
    ctx.out.data(agreement);
    return;
  }
  ctx.out.line(
    `agreement ${agreement.id} countered — the consumer decides (accept applies the countered terms; reject ends the proposal)`,
  );
}

/**
 * `eaf agreement remind <id>` (T-309 + T-059 symmetric): nudge the CURRENT
 * decider — the consumer while proposed, the provider while countered.
 */
async function remind(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_REMIND);
  const id = requirePositional(positionals, 'agreementId', USAGE_REMIND);
  const result = (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/remind`,
  ))) as {
    agreementId: string;
    status: string;
    reminded: boolean;
    /** T9 (R2): the remind trace + the agent-provider auto decision, if one fired. */
    remindCount?: number;
    lastRemindedAt?: string;
    autoDecision?: { decision: 'accept' | 'reject'; reason?: string };
    note?: string;
  };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    result.reminded
      ? `reminded the decider of agreement ${result.agreementId} (status ${result.status})` +
        ` — reminder #${result.remindCount ?? '?'}, recorded at ${result.lastRemindedAt ?? '?'}`
      : `no reminder sent for agreement ${result.agreementId}: ${result.note ?? 'dropped'}`,
  );
  if (result.autoDecision !== undefined) {
    ctx.out.line(
      `  auto decision (agent provider, deterministic): ${result.autoDecision.decision.toUpperCase()}` +
      (result.autoDecision.reason !== undefined ? ` — ${result.autoDecision.reason}` : ''),
    );
  }
}

async function lifecycleAction(ctx: Ctx, argv: string[], action: 'suspend' | 'terminate'): Promise<void> {
  const usage = action === 'suspend' ? USAGE_SUSPEND : USAGE_TERMINATE;
  const { flags, positionals } = parse(argv, { reason: { type: 'string' } }, usage);
  const id = requirePositional(positionals, 'agreementId', usage);
  const reason = stringFlag(flags, 'reason');
  const agreement = (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/${action}`,
    reason !== undefined ? { reason } : {},
  ))) as AgreementEntry & { irreversible?: boolean; note?: string };
  if (ctx.json) {
    // R99: the suspend response carries the server's irreversible marker +
    // note (terminate stays the plain agreement JSON).
    ctx.out.data(agreement);
  } else {
    ctx.out.line(
      `agreement ${agreement.id} → ${agreement.status}` +
      (agreement.statusReason !== undefined ? ` (reason: ${agreement.statusReason})` : ''),
    );
    // R99 (zhao-09): say the irreversibility AFTER the fact, plainly — the
    // suspend/resume pairing reads as reversible and is not.
    if (action === 'suspend') {
      ctx.out.line(
        '⚠ suspend 不可恢复：该合约将保持 suspended 直到 terminate（之后可重新签约）；' +
        '需要"暂停-恢复"语义时请使用 consumer 的 hold（hold 过期自动恢复 active）。',
      );
    }
  }
}

/**
 * D3 (R28, T-080): the consumer's bounded circuit breaker — hold suspends
 * auto-trigger execution + manual invokes for THIS agreement only (quota
 * untouched, provider notified, auto-expires at holdExpiresAt).
 */
async function hold(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { duration: { type: 'string' } },
    USAGE_HOLD,
  );
  const id = requirePositional(positionals, 'agreementId', USAGE_HOLD);
  const rawDuration = stringFlag(flags, 'duration');
  let durationSec = 600; // a sane default pause; the server caps at 3600
  if (rawDuration !== undefined) {
    const parsed = Number(rawDuration);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw usageError(`--duration must be an integer number of seconds (1..3600)
usage: ${USAGE_HOLD}`);
    }
    durationSec = parsed;
  }
  const agreement = (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/hold`,
    { durationSec },
  ))) as AgreementEntry;
  if (ctx.json) ctx.out.data(agreement);
  else {
    ctx.out.line(`agreement ${agreement.id} → ${agreement.status} (until ${agreement.holdExpiresAt ?? '?'})`);
  }
}

/** D3: resume ends the consumer's hold (DELETE …/hold → active). */
async function resume(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RESUME);
  const id = requirePositional(positionals, 'agreementId', USAGE_RESUME);
  const agreement = (await agreementRefGet(ctx, id, full => ctx.authedClient().delete(
    `/api/agreements/${encodeURIComponent(full)}/hold`,
  ))) as AgreementEntry;
  if (ctx.json) ctx.out.data(agreement);
  else ctx.out.line(`agreement ${agreement.id} → ${agreement.status}`);
}

async function invoke(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { action: { type: 'string' }, params: { type: 'string' }, sim: { type: 'string' } },
    USAGE_INVOKE,
  );
  const id = requirePositional(positionals, 'agreementId', USAGE_INVOKE);
  const params = jsonFlag<Record<string, unknown>>(flags, 'params', USAGE_INVOKE);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw usageError(`--params must be a JSON object\nusage: ${USAGE_INVOKE}`);
  }
  // T-205 sim targeting: --sim names the simulation to invoke into. T-501:
  // omitted --sim targets the env's authoritative world session
  // (sim-{envId}-world-session, created on demand) — a private sim is an
  // explicit opt-in; the server's 409 SIMULATION_AMBIGUOUS only fires on
  // the legacy fallback (session unavailable).
  const simulationId = stringFlag(flags, 'sim');
  const action = requireString(flags, 'action', USAGE_INVOKE);
  // T110 (R18, u2-F-18-U2-1/u4-F2' + u1-F4): invoke joins the T88 prefix
  // family — `agreement invoke <short-id>` used to 404 bare while decide /
  // get / usage / receipts resolved the same input (u1's regression-walk
  // exception). A unique prefix resolves with the family's explain note;
  // zero/many keep the teaching faces.
  const result = (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
    `/api/agreements/${encodeURIComponent(full)}/invocations`,
    {
      action,
      ...(params !== undefined ? { params } : {}),
      ...(simulationId !== undefined ? { simulationId } : {}),
    },
  ))) as InvocationResult;
  if (ctx.json) {
    ctx.out.data(result);
  } else if (result.success) {
    // MI-D: a flow-service invoke delivers a FLOW RUN — the effectRef chains
    // to the run ledger; device invokes keep the device echo.
    const flow = result.applied?.flow;
    ctx.out.line(
      flow !== undefined
        ? `invoke ok: run ${flow.runId} (${flow.status}) of flow ${flow.flowId} ` +
          `(sim ${result.simulationId}, usage ${result.usage.id}, receipt ${result.receiptId})`
        : `invoke ok: ${result.action} on ${result.deviceId} (sim ${result.simulationId}, ` +
          `usage ${result.usage.id}, receipt ${result.receiptId})`,
    );
  } else {
    ctx.out.line(`invoke failed: ${result.error ?? 'command failed'} (usage ${result.usage.id} recorded as failure)`);
  }
}

async function usage(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_USAGE);
  const id = requirePositional(positionals, 'agreementId', USAGE_USAGE);
  // T88: short-prefix <agreementId> — same resolver as `agreement get`.
  const body = (await agreementRefGet(ctx, id, full =>
    ctx.authedClient().get(`/api/agreements/${encodeURIComponent(full)}/usage`),
  )) as { usage: UsageRecordEntry[]; view?: 'restricted' };
  if (ctx.json) {
    // T38.3 (R3, u4-F8): pass the REST envelope through — { usage, view } —
    // instead of the legacy bare array (three-channel consistency; the CLI
    // used to strip the envelope, so `eaf agreement usage --json` disagreed
    // with GET /api/agreements/:id/usage. BREAKING for bare-array consumers
    // — release note).
    ctx.out.data(body);
    return;
  }
  if (body.view === 'restricted') {
    ctx.out.line('(restricted view — world history metering; parties see the identical ledger)');
  }
  ctx.out.table(
    body.usage.map(usageTableRow),
    ['id', 'kind', 'action', 'quantity', 'unit', 'outcome', 'failureReason', 'origin', 'source', 'simulationId', 'startedAt'],
  );
}

/**
 * T40e (R4, u2#1): one usage table row. R102 空值口径: a failure/partial row
 * with NO recorded reason renders （未记录） — never a blank cell that reads
 * as "nothing to say" on a failure whose why the ledger owes the reader.
 * Success rows carry no failureReason by construction and render bare.
 * FEAT-08/UX-04: origin/source/simulationId join the human face (human ≥
 * --json); rows predating the columns (or lanes the vocabulary does not
 * cover) render （未记录）, never a blank cell. Pure for the render suite.
 */
export function usageTableRow(record: UsageRecordEntry): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    action: record.action ?? '',
    quantity: record.quantity,
    unit: record.unit,
    outcome: record.outcome,
    // R102 (wang-18): human 模式不得少于 --json —— 失败原因必须可见；
    // 历史失败行无原因时按空值口径兜底（T40e），不回写任何历史数据。
    failureReason:
      record.failureReason ?? (record.outcome === 'success' ? '' : '（未记录）'),
    origin: record.origin ?? '（未记录）',
    source: record.source ?? '（未记录）',
    simulationId: record.simulationId ?? '（未记录）',
    startedAt: record.startedAt,
  };
}

/** SettlementReceipt wire shape (§3.4; the Null provider archives quote=null). */
interface SettlementReceiptEntry {
  id: string;
  agreementId: string;
  provider: string;
  status: string;
  usageRecordIds: string[];
  quote: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * `eaf agreement receipts <id>` — the agreement's settlement receipts
 * (GET /api/agreements/:id/receipts; both parties + env owner).
 */
async function receipts(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RECEIPTS);
  const id = requirePositional(positionals, 'agreementId', USAGE_RECEIPTS);
  // T88: short-prefix <agreementId> — same resolver as `agreement get`
  // (a receipts face that still lied NOT_FOUND on a prefix would undo the
  // get face's teaching).
  const body = (await agreementRefGet(ctx, id, full =>
    ctx.authedClient().get(`/api/agreements/${encodeURIComponent(full)}/receipts`),
  )) as { receipts: SettlementReceiptEntry[]; view?: 'restricted' };
  if (ctx.json) {
    ctx.out.data(body.receipts);
    return;
  }
  if (body.view === 'restricted') {
    ctx.out.line('(restricted view — world history receipts; parties see the identical ledger)');
  }
  ctx.out.table(
    body.receipts.map(receipt => ({
      id: receipt.id,
      provider: receipt.provider,
      status: receipt.status,
      usageRecords: receipt.usageRecordIds.length,
      quote: receipt.quote !== null ? JSON.stringify(receipt.quote) : '-',
      createdAt: receipt.createdAt,
    })),
    ['id', 'provider', 'status', 'usageRecords', 'quote', 'createdAt'],
  );
}

/**
 * `eaf agreement read <id>` (R14 Wave-A, design-data-services.md §4): the
 * pull lane on data services — one frame, metered as kind=read. `--latest`
 * takes the cache-first cheap path; `--fields` narrows (never widens) the
 * terms.read.fields scope; `--simulation` targets a specific running sim.
 */
async function read(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { fields: { type: 'string' }, simulation: { type: 'string' }, latest: { type: 'boolean' } },
    USAGE_READ,
  );
  const id = requirePositional(positionals, 'agreementId', USAGE_READ);
  const fields = stringFlag(flags, 'fields');
  if (fields !== undefined && fields.trim().length === 0) {
    throw usageError(`--fields must be a comma-separated list of dataSchema field names\nusage: ${USAGE_READ}`);
  }
  const simulation = stringFlag(flags, 'simulation');
  const latest = boolFlag(flags, 'latest');

  // T110 (R18, u2-F-18-U2-1/u4-F2'): read joins the T88 prefix family — an
  // active agreement queried by its 8-char roster prefix used to answer a
  // bare AGREEMENT_NOT_FOUND that read as "the contract vanished" (u4 read
  // her OWN active agreement that way) while get/usage/receipts resolved the
  // same input. Same resolver, same teaching faces.
  const result = latest
    ? (await agreementRefGet(ctx, id, full =>
        ctx.authedClient().get(`/api/agreements/${encodeURIComponent(full)}/reads/latest`),
      )) as ReadResult
    : (await agreementRefGet(ctx, id, full => ctx.authedClient().post(
        `/api/agreements/${encodeURIComponent(full)}/reads`,
        {
          ...(fields !== undefined ? { fields: fields.split(',').map(f => f.trim()).filter(f => f.length > 0) } : {}),
          ...(simulation !== undefined ? { simulationId: simulation } : {}),
        },
      ))) as ReadResult;

  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  for (const line of readHumanLines(result)) {
    // T72/T77 (R8): the empty-window ⚠ (and the world-session ⚠ below it)
    // explain THIS reading — part of the human face, stdout in human mode
    // (they used to ride stderr and vanish from captured output, u4-P1-2).
    ctx.out.explain(line.text);
  }
}

/**
 * T66b (R6, u4-F9): the HUMAN reading face rounds to the display convention
 * (2 decimals) — `24.36322227` °C is full-precision machine data; the JSON
 * face keeps it verbatim. Pure for the render suite.
 */
export function formatReading(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * The `agreement read` HUMAN face (T22 contract): the value line, the
 * freshness/provenance line and the metering line — pure, rendered by
 * render-contract fixtures.
 *
 * T51 (R5, u4-P1-1) + u2 F3: the face carries the reading's UNITS (JSON had
 * them since T46; the human line silently showed bare numbers) and, when
 * the frame flags an empty event window, an explicit explanation that the 0
 * is "no events", not a real reading — a structurally-zero power count must
 * never masquerade as a measurement.
 */
export function readHumanLines(
  result: ReadResult,
): Array<{ level: 'line' | 'warn'; text: string }> {
  const frame = result.frame;
  const provenance = frame.provenance;
  const dataLine = Object.entries(frame.data)
    .map(([field, value]) => {
      const unit = frame.units?.[field];
      const rendered = value === null ? 'null' : formatReading(value);
      return unit ? `${field}=${rendered} ${unit}` : `${field}=${rendered}`;
    })
    .join(' ');
  const lines: Array<{ level: 'line' | 'warn'; text: string }> = [
    { level: 'line', text: `read ${result.agreementId}: ${dataLine}` },
  ];
  if (frame.emptyEventWindow === true) {
    // T57a (R6, u4-F2): the window is SIMULATED seconds — under speed
    // multipliers 600 sim-s can pass in a handful of real seconds, so the
    // ⚠ names the ≈real-seconds span instead of letting "无事件" imply a
    // long observation. No usable rate → no conversion line (honest dash).
    //
    // T85 (R10, u4-F1): per-field classification. The ghost copy speaks
    // ONLY for the delivered ghost fields (the server scopes
    // undeclaredEventTypes to the delivery); a MIXED delivery (ghost +
    // declared fields) renders the ghost copy AND the T57a plain-window
    // copy — the declared fields' emptiness keeps the widen-window advice
    // instead of being swallowed by the ghost mislabel.
    let windowNote: string;
    if ((frame.undeclaredEventTypes?.length ?? 0) > 0) {
      // T83 (R9, u4-F1) + T133 (R20-F, u4-F1): the delivered field's event
      // type is a GHOST — this world's SCENARIO never declares it, so the
      // regular lane cannot produce it. The copy asserts only the two
      // provable facts: THIS window observed none, and the scenario
      // declaration table lacks the type. It must NOT claim world history
      // (the old "never produced" wording was false — u4's runtime injection
      // proved undeclared types CAN occur from out-of-scenario sources) or
      // the future ("reads zero forever"): a window that has slid past can
      // only ever say "this window: none". R102/T133: the branch also
      // carries the same 仿真秒≈真实秒 conversion as the declared-empty
      // branch — equal information on both faces.
      const declared = frame.declaredEventTypes ?? [];
      windowNote =
        `  ⚠ 事件窗为空：本次窗口内未观测到该事件类型（${frame.undeclaredEventTypes!.join(', ')}）——` +
        '这里的 0 是「无事件」，不是真实读数。另注：本世界场景未声明该类型（词表: ' +
        `${declared.slice(0, 8).join(', ') || '（本世界未声明任何事件类型）'}），` +
        '请核对拼写、或改用已声明类型、或由服务提供方重新注册计算（POST /api/services/:id/computation）';
      if (frame.eventWindowSec !== undefined && (frame.effectiveSpeedPerSec ?? 0) > 0) {
        const realSec = Math.round(frame.eventWindowSec / frame.effectiveSpeedPerSec!);
        windowNote += `（窗口按仿真时钟计：${frame.eventWindowSec} 仿真秒 ≈ 当前倍速下 ${realSec} 真实秒）`;
      }
      lines.push({ level: 'warn', text: windowNote });
    }
    const declaredEmpty = frame.declaredEmptyEventFields ?? [];
    if ((frame.undeclaredEventTypes?.length ?? 0) === 0 || declaredEmpty.length > 0) {
      windowNote =
        '  ⚠ 事件窗为空：本次读取的模拟窗口内没有匹配事件——这里的 0 是「无事件」，' +
        '不是真实读数（可 --simulation 指向有事件的世界，或让提供方加宽 windowSec）';
      if (frame.eventWindowSec !== undefined && (frame.effectiveSpeedPerSec ?? 0) > 0) {
        const realSec = Math.round(frame.eventWindowSec / frame.effectiveSpeedPerSec!);
        windowNote += `（窗口按仿真时钟计：${frame.eventWindowSec} 仿真秒 ≈ 当前倍速下 ${realSec} 真实秒）`;
      }
      lines.push({ level: 'warn', text: windowNote });
    }
  }
  lines.push({
    level: 'line',
    text:
      `  ${frame.stale ? 'STALE' : 'fresh'} (age ${frame.freshnessSec}s, ` +
      // T57b (R6, u2-F-2-2): the cached face keeps the computation-time
      // provenance — "which world computed this frame" is a fact, not a
      // secret; the reader can tell targeted-fresh from cached-at-a-glance.
      (provenance.cached
        ? `cached, computed from sim ${provenance.simulationId ?? '?'} @ ${provenance.computedAtWall}`
        : `computed from sim ${provenance.simulationId ?? '?'}`) +
      `) — schema v${frame.schemaVersion}, delivered [${result.applied.fields.join(', ')}] (${result.applied.meteringUnit})` +
      ` — inputs zones=${provenance.inputsSummary.zones} devices=${provenance.inputsSummary.devices} events=${provenance.inputsSummary.eventsWindowed}`,
  });
  // T66g (R6, u4-F13): a default-targeted read that landed on the env world
  // session (typically: the reader's own sim is paused/stopped) says so —
  // the sim-id switch used to be silent and read as "my world froze".
  if (result.simulationId !== null && /-world-session$/.test(result.simulationId)) {
    lines.push({
      level: 'warn',
      text:
        '  ⚠ 本次读取来自 env 世界会话（你的 sim 可能已暂停或停止）——' +
        '需要你自己世界的实时读数请 --simulation 指向你的 sim（或先 resume）',
    });
  }
  // T122 (R17-u3/R19-u4): the default-binding disclosure — the read rode the
  // environment's default simulation (or fell off a stale binding). R102:
  // the human face never shows less than the JSON's explanatory fields.
  if (typeof result.defaultSimNote === 'string' && result.defaultSimNote.length > 0) {
    lines.push({ level: result.defaultSimNote.startsWith('⚠') ? 'warn' : 'line', text: `  ${result.defaultSimNote}` });
  }
  lines.push({
    level: 'line',
    text: `  usage ${result.usage.id} (${result.usage.outcome}), receipt ${result.receiptId}`,
  });
  return lines;
}

/** DataReadResult wire shape (R14 Wave-A §4; T46 units, T51 emptyEventWindow, T57a window clock). */
interface ReadResult {
  agreementId: string;
  simulationId: string | null;
  /** T122: the env default-simulation binding disclosure (bound+honored or stale+fallback). */
  defaultSimNote?: string;
  frame: {
    kind: 'data';
    agreementId: string;
    serviceId: string;
    schemaVersion: number;
    data: Record<string, number | null>;
    units?: Record<string, string | null>;
    emptyEventWindow?: boolean;
    /**
     * T83 (R9, u4-F1): present ONLY when the DELIVERED fields' event
     * metrics reference types this world's scenario never declares (T85:
     * scoped to the delivery — spec ghosts outside terms.read.fields no
     * longer leak here) — the ghost annotation the human face renders
     * instead of the widen-window advice.
     */
    undeclaredEventTypes?: string[];
    /** T83: this world's declared event vocabulary (rides with the ghosts). */
    declaredEventTypes?: string[];
    /**
     * T85 (R10, u4-F1): the delivered fields the ghost copy speaks for —
     * a mixed ghost+declared delivery renders the T57a plain-window advice
     * for the declared siblings (declaredEmptyEventFields) beside it.
     */
    ghostEventFields?: string[];
    /** T85: delivered event fields of DECLARED types on an empty window. */
    declaredEmptyEventFields?: string[];
    /** T57a: the event window's sim-seconds span + the source sim's rate. */
    eventWindowSec?: number;
    effectiveSpeedPerSec?: number;
    provenance: {
      computationKind: string;
      inputsSummary: { zones: number; devices: number; eventsWindowed: number };
      providerAgentId: string;
      registeredBy: string;
      computedAtWall: string;
      simTimeSec: number;
      /** T57b: kept on cached frames (computation-time provenance). */
      simulationId: string | null;
      cached: boolean;
    };
    freshnessSec: number;
    stale: boolean;
  };
  applied: { fields: string[]; meteringUnit: string; retentionSec?: number };
  termsEnforced: boolean;
  usage: UsageRecordEntry;
  receiptId: string | null;
}

/**
 * `eaf agreement stream <id>` (§3.2.2, Phase 2): follow the observation
 * stream of an active agreement over WebSocket. Frames print as NDJSON
 * under --json (aligned with `sim watch`), as one-liners otherwise.
 * `--params a,b` (Fix-20) narrows the push to frames where one of the
 * listed parameters changed (server-side filter). Runs until the server
 * closes the socket or Ctrl+C.
 */
async function stream(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { params: { type: 'string' } }, USAGE_STREAM);
  const id = requirePositional(positionals, 'agreementId', USAGE_STREAM);
  const params = stringFlag(flags, 'params');
  // T124: the socket handshake cannot ride the 404-then-retry pattern, so
  // the ref is resolved FIRST (probe-GET + roster) and the full id opens it.
  const fullId = await resolveAgreementRef(ctx, id);
  const query = params !== undefined ? `?params=${encodeURIComponent(params)}` : '';
  const socket = ctx.authedClient().openWebSocket(
    `/api/agreements/${encodeURIComponent(fullId)}/stream${query}`,
  );
  ctx.out.info(`streaming agreement ${fullId} — Ctrl+C to stop`);

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => socket.close();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn: () => void): void => {
      ctx.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    socket.on('message', data => {
      const text = data.toString();
      if (ctx.json) {
        ctx.io.stdout(text + '\n'); // NDJSON
        return;
      }
      try {
        emitStreamFrame(ctx, JSON.parse(text) as StreamFrame);
      } catch {
        ctx.out.line(text);
      }
    });
    // Pre-upgrade rejection (404/409): the HTTP status + error body tell why.
    socket.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => {
        let message = `stream rejected (HTTP ${response.statusCode})`;
        try {
          const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
          if (parsed.error?.message) message = `${parsed.error.message} [${parsed.error.code ?? `HTTP_${response.statusCode}`}]`;
        } catch { /* keep the generic message */ }
        settle(() => reject(new CliError(
          message,
          response.statusCode === 401 ? EXIT.AUTH
            : response.statusCode === 404 ? EXIT.NOT_FOUND
              : EXIT.ERROR,
        )));
      });
    });
    socket.on('error', error => {
      settle(() => reject(new CliError(`stream error: ${error.message}`, EXIT.ERROR)));
    });
    socket.on('close', () => settle(resolve));
  });
  ctx.out.info('stream closed');
}

interface StreamFrame {
  kind?: string;
  deviceId?: string;
  changedParameters?: unknown[];
  state?: unknown;
  simTimeSec?: number;
  /** R14 data frames (design-data-services.md §3.2). */
  schemaVersion?: number;
  data?: Record<string, unknown>;
  provenance?: { cached?: boolean; simulationId?: string | null; computedAtWall?: string };
  freshnessSec?: number;
  stale?: boolean;
  reason?: string;
}

function emitStreamFrame(ctx: Ctx, frame: StreamFrame): void {
  if (frame.kind === 'subscribed') {
    ctx.out.line(`subscribed: device ${frame.deviceId ?? '?'}`);
    return;
  }
  if (frame.kind === 'observation') {
    const t = frame.simTimeSec !== undefined ? `t=${frame.simTimeSec}s ` : '';
    const params = Array.isArray(frame.changedParameters) ? frame.changedParameters.join(', ') : '';
    ctx.out.line(`[${t}] ${frame.deviceId ?? '?'} changed: ${params} → ${JSON.stringify(frame.state)}`);
    return;
  }
  if (frame.kind === 'data') {
    const t = frame.simTimeSec !== undefined ? `t=${frame.simTimeSec}s ` : '';
    const data = Object.entries(frame.data ?? {})
      .map(([field, value]) => `${field}=${value === null ? 'null' : String(value)}`)
      .join(' ');
    const flag = frame.stale ? ' STALE' : '';
    const cached = frame.provenance?.cached ? ' (cached)' : '';
    ctx.out.line(`[${t}] data v${frame.schemaVersion ?? '?'}${flag}${cached}: ${data}`);
    return;
  }
  if (frame.kind === 'closed') {
    ctx.out.line(`closed: ${frame.reason ?? 'unknown reason'}`);
    return;
  }
  ctx.out.line(JSON.stringify(frame));
}
