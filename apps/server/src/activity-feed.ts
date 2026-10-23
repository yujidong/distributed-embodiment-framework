/**
 * Environment activity feed (Fix-19, roadmap) — the latecomer's "世界最近
 * 发生了什么": one human-readable, newest-first timeline aggregated
 * server-side from three sources:
 *
 * - command_log (executed world changes — direct edits, applied proposals,
 *   device commands);
 * - the proposal lifecycle (submitted / decided / applied rows);
 * - the agreement lifecycle (proposed / status transitions).
 *
 * Every entry carries `{time, actor, kind, action, summary, objectType,
 * objectId}`; actor resolves to `{id, displayName}` like the world stream's
 * actor refs (null when the user row is gone).
 *
 * Wave-1a (小林 R8 F-16): summaries name their objects (device / service
 * names next to the ids — resolved with per-call caches so one feed build
 * costs at most one extra indexed lookup per DISTINCT object), and
 * `?before=<iso>` pages the feed backwards (entries strictly older than the
 * cursor).
 */

import type { AgreementRow, AgreementStore } from './db/agreement-store.js';
import { parseJsonObject, type EnvironmentStore } from './db/environment-store.js';
import type {
  CommandLogRow,
  CommandLogStore,
  ProposalRow,
  ProposalStore,
} from './db/proposal-store.js';
import type { ServiceStore } from './db/service-store.js';
import type { UserStore } from './db/user-store.js';

export interface ActivityEntry {
  time: string;
  actor: { id: string; displayName: string } | null;
  // T74 (R8, u3-F3): 'flow' — flow lifecycle audit (create/update/delete of
  // the automation topology) is its own filterable feed kind.
  kind: 'command' | 'proposal' | 'agreement' | 'event' | 'flow';
  /** Lifecycle verb: 'executed' | 'submitted' | 'decided' | 'applied' | 'injected' | … */
  action: string;
  /** One-line human summary ("device-command · 设备 d-1"). */
  summary: string;
  objectType: 'environment' | 'device' | 'agent' | 'proposal' | 'agreement' | 'service' | 'zone' | 'flow';
  objectId: string;
}

export interface ActivityFeedStores {
  commandLogStore: CommandLogStore;
  proposalStore: ProposalStore;
  agreementStore: AgreementStore;
  userStore: UserStore;
  /** Wave-1a: object-name resolution for the summaries. */
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
}

/**
 * T-308 (DevLoop R12, FR-F12): the viewer the feed is built for. When
 * provided, entries referencing a visibility='hidden' service are REDACTED
 * for viewers who are neither the service's provider owner, the agreement
 * counterparty, nor the env owner — the service name/id/semantic type are
 * replaced with a placeholder while the action + actor remain (the
 * transition itself is env governance history). Omitted → legacy behavior
 * for callers without a viewer context.
 *
 * T-060 (R14, design-consent-semantics.md §6): agreement LIFECYCLE entries
 * are additionally BILATERAL — they only exist for the two parties and the
 * env owner (removed entirely for everyone else, no placeholder). The
 * hidden-service redaction remains for command entries that name hidden
 * services (publish/update events).
 */
export interface ActivityFeedViewer {
  userId: string | null;
  envOwnerId: string;
}

/** The placeholder replacing hidden-service references in redacted entries. */
export const HIDDEN_SERVICE_PLACEHOLDER = 'a hidden service';

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

/**
 * Merge the three sources into one newest-first feed. Each source is
 * over-fetched at `limit` rows so the merged result still fills `limit`
 * when one source dominates. `before` (ISO) is the Wave-1a pagination
 * cursor: only entries strictly older than it are returned.
 *
 * T60 (R6, u3-P2-1): `filter` (kind/actor) applies BEFORE the limit slice —
 * `?kind=proposal&limit=30` returns min(30, matches), never "3 proposals
 * because 27 command rows filled the page first". With a filter active the
 * sources are over-fetched at the hard cap so matches beyond `limit` rows
 * of a dominating source remain reachable; a short page under a filter is
 * the honest "no more matches" result (the contract documents the order).
 */
export interface ActivityFeedFilter {
  kind?: string;
  /** id or display-name substring, case-insensitive (already lowercased). */
  actor?: string;
}

function matchesActivityFilter(entry: ActivityEntry, filter: ActivityFeedFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
  if (filter.actor !== undefined) {
    const haystack = `${entry.actor?.id ?? ''} ${entry.actor?.displayName ?? ''}`.toLowerCase();
    if (!haystack.includes(filter.actor)) return false;
  }
  return true;
}

export function buildActivityFeed(
  stores: ActivityFeedStores,
  envId: string,
  limit: number = ACTIVITY_DEFAULT_LIMIT,
  before?: string,
  viewer?: ActivityFeedViewer,
  filter?: ActivityFeedFilter,
): ActivityEntry[] {
  const names = makeNameCache(stores);
  const redaction = makeRedaction(stores, viewer);
  const entries: ActivityEntry[] = [];
  // T60: a filter moves the matching population, not the page size —
  // over-fetch at the hard cap so `min(limit, matches)` is actually
  // reachable.
  const sourceLimit = filter !== undefined ? ACTIVITY_MAX_LIMIT : limit;
  // T75 (R8, u3-F4): the transition audit rows KNOW who acted (T-025 wrote
  // the acting user at the transition moment). Harvest them before the skip
  // so the agreement face renders the REAL closing actor; the row-shape
  // inference below becomes the legacy fallback only (rows beyond the fetch
  // window / system lanes that never logged a transition).
  const transitionActors = new Map<string, { actorId: string; time: string }>();
  for (const row of stores.commandLogStore.listForEnv(envId, { limit: sourceLimit, before })) {
    // T-025: agreement lifecycle audit rows are the RAW audit trail (owner +
    // actor via the command-log endpoint). The FEED must not render them:
    // the agreement lifecycle is already reconstructed below with the T-060
    // bilateral-privacy filter — rendering the raw rows would both
    // double-count every transition and leak it to non-parties.
    if (row.kind === 'agreement-transition') {
      const payload = parseJsonObject(row.payload_json) ?? {};
      const agreementId = typeof payload.agreementId === 'string' ? payload.agreementId : null;
      const to = typeof payload.to === 'string' ? payload.to : null;
      if (agreementId !== null && to !== null) {
        const key = `${agreementId}::${to}`;
        const existing = transitionActors.get(key);
        // Latest transition wins (a held→active resume legitimately re-enters
        // 'active' — the resume actor is who LAST made the status true).
        if (existing === undefined || row.wall_time >= existing.time) {
          transitionActors.set(key, { actorId: row.actor_id, time: row.wall_time });
        }
      }
      continue;
    }
    entries.push(commandEntry(stores, names, row, redaction));
  }
  // T75: the lookup the agreement face uses — the latest audit row that set
  // `to` on this agreement. No wall-clock comparison: wall_time (ISO-Z) and
  // the agreement row's updated_at (SQL timestamp) are different formats,
  // and "who LAST made this status true" is the map's own invariant.
  const transitionActorOf = (agreementId: string, to: string): string | undefined =>
    transitionActors.get(`${agreementId}::${to}`)?.actorId;
  for (const row of stores.proposalStore.listForEnv(envId)) {
    entries.push(...proposalEntries(stores, row));
  }
  for (const row of stores.agreementStore.agreementsOfEnv(envId)) {
    entries.push(...agreementEntries(stores, names, row, redaction, transitionActorOf));
  }
  // ISO timestamps compare lexicographically; the sort is stable, so ties
  // keep source order (commands → proposals → agreements).
  entries.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const windowed = before !== undefined ? entries.filter(entry => entry.time < before) : entries;
  // T60: filter BEFORE the slice.
  return windowed.filter(entry => matchesActivityFilter(entry, filter)).slice(0, limit);
}

/**
 * T-308: hidden-service redaction verdicts for one viewer. `undefined`
 * verdicts (no viewer context) keep the legacy unredacted behavior.
 */
interface Redaction {
  /** true when the service must NOT be named for this viewer. */
  hideService(serviceId: string): boolean;
  /** Party exemption for one agreement row (consumer or provider side). */
  isAgreementParty(row: AgreementRow): boolean;
  /**
   * T-060 (design-consent-semantics.md §6.2): may this viewer see ANY entry
   * of this agreement at all — party (consumer/provider) or env owner? For
   * everyone else the bilateral entries are REMOVED (not redacted): the
   * agreement is a bilateral commercial/privacy transaction, not world
   * governance history (that carrier is the proposal pipeline, which stays
   * member-visible). This aligns the feed with the REST 404 boundary —
   * what REST says does not exist, the feed must not rebuild.
   */
  maySeeAgreement(row: AgreementRow): boolean;
}

function makeRedaction(stores: ActivityFeedStores, viewer?: ActivityFeedViewer): Redaction | undefined {
  if (viewer === undefined) return undefined;
  const verdictCache = new Map<string, boolean>();
  const hideService = (serviceId: string): boolean => {
    const cached = verdictCache.get(serviceId);
    if (cached !== undefined) return cached;
    let verdict = false;
    if (
      viewer.userId === null ||
      viewer.userId !== viewer.envOwnerId
    ) {
      const service = stores.serviceStore.getService(serviceId);
      const providerOwnerId = service !== undefined
        ? stores.envStore.getAgent(service.provider_agent_id)?.owner_id
        : undefined;
      const isPrivileged =
        (viewer.userId !== null && service !== undefined && providerOwnerId === viewer.userId) ||
        viewer.userId === viewer.envOwnerId;
      // Hidden + not privileged → redact. Everything else (visible services,
      // gone rows, provider owner, env owner) reads the full label.
      verdict = service !== undefined && service.visibility === 'hidden' && !isPrivileged;
    }
    verdictCache.set(serviceId, verdict);
    return verdict;
  };
  return {
    hideService,
    isAgreementParty: row =>
      viewer.userId !== null &&
      (viewer.userId === row.consumer_owner_id || viewer.userId === row.provider_owner_id),
    maySeeAgreement: row =>
      viewer.userId !== null &&
      (viewer.userId === row.consumer_owner_id ||
        viewer.userId === row.provider_owner_id ||
        viewer.userId === viewer.envOwnerId),
  };
}

/**
 * Per-feed object-name cache (Wave-1a): at most one store lookup per
 * distinct object, null when the row is gone (the summary falls back to
 * the bare id).
 */
interface NameCache {
  device(id: string): string | null;
  agent(id: string): string | null;
  service(id: string): string | null;
}

function makeNameCache(stores: ActivityFeedStores): NameCache {
  const devices = new Map<string, string | null>();
  const agents = new Map<string, string | null>();
  const services = new Map<string, string | null>();
  const lookup = (
    cache: Map<string, string | null>,
    id: string,
    resolve: () => string | undefined,
  ): string | null => {
    if (!cache.has(id)) cache.set(id, resolve() ?? null);
    return cache.get(id)!;
  };
  return {
    device: id => lookup(devices, id, () => stores.envStore.getDevice(id)?.name),
    agent: id => lookup(agents, id, () => stores.envStore.getAgent(id)?.name),
    service: id => lookup(services, id, () => stores.serviceStore.getService(id)?.name),
  };
}

/** `"name" (id)` when the object still exists, else the bare id. */
function objectLabel(names: NameCache, objectType: string, objectId: string): string {
  const name =
    objectType === 'device'
      ? names.device(objectId)
      : objectType === 'agent'
        ? names.agent(objectId)
        : objectType === 'service'
          ? names.service(objectId)
          : null;
  return name !== null ? `${name} (${objectId})` : objectId;
}

/**
 * T33 (R3): synthetic engine actors get a HUMAN label, not a '-' (u1/u2:
 * 190 engine rows with actor "-" drowned the real actions). The id stays
 * the raw synthetic form for the JSON face; displayName speaks the engine
 * family with a short tail. Real users keep their display names.
 */
function syntheticActorDisplayName(actorId: string): string | undefined {
  if (actorId === 'scenario') return '场景剧本';
  const engineMatch = /^engine:(sim|agent|flow):(.+)$/.exec(actorId);
  if (engineMatch === null) return undefined;
  const [, family, id] = engineMatch;
  return `引擎(${family} …${id.slice(-10)})`;
}

function commandEntry(
  stores: ActivityFeedStores,
  names: NameCache,
  row: CommandLogRow,
  redaction?: Redaction,
): ActivityEntry {
  const payload = parseJsonObject(row.payload_json) ?? {};
  // T33 (R3 u3-F3): scenario/manual event injections audit as their own
  // feed kind — "who pulled the fire alarm" is answerable (actor = the
  // injecting user, or 场景剧本 for script-scheduled fires).
  if (row.kind === 'event') {
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'unknown-event';
    const zoneId = typeof payload.zoneId === 'string' ? payload.zoneId : '?';
    const parameter = typeof payload.parameter === 'string' ? payload.parameter : null;
    const value = payload.value;
    const severity = typeof payload.severity === 'string' ? payload.severity : null;
    return {
      time: row.wall_time,
      actor: actorRef(stores, row.actor_id),
      kind: 'event',
      action: typeof payload.action === 'string' ? payload.action : 'injected',
      summary:
        `event ${eventType} @ ${zoneId}` +
        (parameter !== null ? ` (${parameter}=${String(value)})` : '') +
        (severity !== null ? ` [${severity}]` : ''),
      objectType: 'zone',
      objectId: zoneId,
    };
  }
  // T74 (R8, u3-F3): flow lifecycle rows — the summary names the flow, the
  // lifecycle action and the armed state ("who changed the linkage rules"
  // answered without opening the payload). Deleted flows read from the row's
  // own snapshot: no join, the flow row is physically gone.
  if (row.kind === 'flow') {
    const flowId = typeof payload.flowId === 'string' ? payload.flowId : String(row.id);
    const flowName = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : flowId;
    const enabled = payload.enabled === true ? 'enabled' : payload.enabled === false ? 'disabled' : '?';
    const changed = Array.isArray(payload.changed) ? payload.changed.filter(c => typeof c === 'string') : [];
    const flowAction = typeof payload.action === 'string' ? payload.action : 'mutated';
    return {
      time: row.wall_time,
      actor: actorRef(stores, row.actor_id),
      kind: 'flow',
      action: flowAction,
      summary: `flow ${flowAction}: "${flowName}" (${enabled})` +
        (changed.length > 0 ? ` [${changed.join(', ')}]` : ''),
      objectType: 'flow',
      objectId: flowId,
    };
  }
  const objectType = typeof payload.objectType === 'string' ? payload.objectType : undefined;
  const objectId =
    typeof payload.objectId === 'string'
      ? payload.objectId
      : typeof payload.deviceId === 'string'
        ? payload.deviceId
        : (row.proposal_id ?? String(row.id));
  const action = typeof payload.action === 'string' ? payload.action : 'executed';
  // T45 (R4 u4-P3-2): NL interaction rows (agent-nl-command / agent-nl-ask /
  // agent-what-if) used to summarize as a bare kind name — but the payload
  // has carried the question's text preview (≤160 chars, agent-nl.ts) and
  // the intent action all along, so the summary shows them (truncated).
  if (typeof payload.textPreview === 'string' && payload.textPreview.length > 0) {
    const preview = payload.textPreview.length > 80
      ? `${payload.textPreview.slice(0, 80)}…`
      : payload.textPreview;
    const intentAction = typeof payload.intentAction === 'string' ? payload.intentAction : null;
    return {
      time: row.wall_time,
      actor: actorRef(stores, row.actor_id),
      kind: 'command',
      action,
      summary: `${row.kind}: "${preview}"${intentAction !== null ? ` → ${intentAction}` : ''}`,
      objectType: 'environment',
      objectId,
    };
  }
  // T-308: a service-typed command entry (publish/update) referencing a
  // hidden service is redacted for unprivileged viewers — the service id
  // itself is the leak, so it never rides the entry.
  const serviceHidden = objectType === 'service' && redaction?.hideService(objectId) === true;
  const labelForObject = (type: string, id: string): string =>
    serviceHidden && type === 'service'
      ? HIDDEN_SERVICE_PLACEHOLDER
      : objectLabel(names, type, id);
  // T33 (R3 u1-F11/u2-F-09): engine-issued device commands name their
  // device + command (the payload always carries them — seams.ts), instead
  // of a bare kind name that made the feed unreadable.
  if (row.kind === 'engine-device-command') {
    const deviceName =
      typeof payload.deviceName === 'string'
        ? payload.deviceName
        : objectLabel(names, 'device', objectId);
    const commandName = typeof payload.commandName === 'string' ? payload.commandName : '?';
    return {
      time: row.wall_time,
      actor: actorRef(stores, row.actor_id),
      kind: 'command',
      action,
      summary: `engine-device-command: ${deviceName} ${commandName}`,
      objectType: 'device',
      objectId,
    };
  }
  return {
    time: row.wall_time,
    actor: actorRef(stores, row.actor_id),
    kind: 'command',
    action,
    summary:
      objectType !== undefined
        ? `${row.kind}: ${action} ${objectType} ${labelForObject(objectType, objectId)}`
        : row.kind === 'device-command'
          ? `device-command: ${String(payload.commandName ?? '?')} on device ${objectLabel(names, 'device', objectId)}`
          : row.kind === 'device-command-denied'
            // R49: denials read like their executed siblings — device label
            // included, so "who tried to touch my devices" is answerable
            // straight from the feed.
            ? `device-command-denied: ${String(payload.commandName ?? '?')} on device ${objectLabel(names, 'device', objectId)}`
            : action !== 'executed'
              // T-025 kinds without an object column (member-change): the
              // action alone ("member-change: role-changed") plus the actor.
              ? `${row.kind}: ${action}`
              : row.kind,
    objectType: (objectType as ActivityEntry['objectType']) ?? 'environment',
    objectId: serviceHidden ? HIDDEN_SERVICE_PLACEHOLDER : objectId,
  };
}

function proposalEntries(stores: ActivityFeedStores, row: ProposalRow): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    {
      time: row.created_at,
      actor: actorRef(stores, row.author_id),
      kind: 'proposal',
      action: 'submitted',
      summary: `proposal submitted: ${row.kind}`,
      objectType: 'proposal',
      objectId: row.id,
    },
  ];
  if (row.decided_at !== null) {
    entries.push({
      time: row.decided_at,
      actor: actorRef(stores, row.reviewer_id ?? row.author_id),
      kind: 'proposal',
      action: 'decided',
      // T66h (R6, u3-P3-3): for an applied proposal the decided row used to
      // read byte-identically to the applied row ("proposal applied: …"),
      // which looked like a double-write. The decision VERB names the
      // verdict; the apply keeps its own line.
      summary: `proposal decided: ${row.kind} → ${row.status}`,
      objectType: 'proposal',
      objectId: row.id,
    });
  }
  if (row.applied_at !== null) {
    entries.push({
      time: row.applied_at,
      actor: actorRef(stores, row.author_id),
      kind: 'proposal',
      action: 'applied',
      summary: `proposal applied: ${row.kind}`,
      objectType: 'proposal',
      objectId: row.id,
    });
  }
  return entries;
}

function agreementEntries(
  stores: ActivityFeedStores,
  names: NameCache,
  row: AgreementRow,
  redaction?: Redaction,
  /** T75: the REAL actor from the agreement-transition audit rows (undefined = legacy fallback). */
  transitionActorOf?: (agreementId: string, to: string) => string | undefined,
): ActivityEntry[] {
  // T-060 (§6.2): DEFAULT BILATERAL AUDIT — a viewer who is neither party
  // nor env owner sees NO agreement entries at all (not redaction: the
  // agreement is a bilateral transaction, not governance history — the
  // proposal pipeline remains the member-visible history carrier). This
  // mirrors the REST 404 boundary; T-308's placeholder stays relevant only
  // for COMMAND entries that name hidden services.
  if (redaction !== undefined && !redaction.maySeeAgreement(row)) {
    return [];
  }
  // T-308 (FR-F12): for entitled viewers the label is full (parties and the
  // env owner are exactly the privileged set of the old redaction rule) —
  // the redact branch below remains for viewer-less legacy callers only.
  // v60: retired rows carry a NULL service ref — nothing to redact or name,
  // the summary falls back to the bare agreement id label.
  const redact = row.service_id !== null &&
    redaction !== undefined &&
    redaction.hideService(row.service_id) &&
    !redaction.isAgreementParty(row);
  const serviceLabel = redact
    ? HIDDEN_SERVICE_PLACEHOLDER
    : row.service_id !== null
      ? objectLabel(names, 'service', row.service_id)
      : 'a removed service';
  const entries: ActivityEntry[] = [
    {
      time: row.created_at,
      actor: actorRef(stores, row.consumer_owner_id),
      kind: 'agreement',
      action: 'proposed',
      summary: `agreement proposed on service ${serviceLabel}`,
      objectType: 'agreement',
      objectId: row.id,
    },
  ];
  if (row.status === 'countered') {
    // T-059: the counter itself is a lifecycle event worth auditing (the
    // provider acted; decide right passes to the consumer).
    entries.push({
      time: row.updated_at,
      actor: actorRef(stores, row.provider_owner_id),
      kind: 'agreement',
      action: 'countered',
      summary: `agreement countered (service ${serviceLabel})`,
      objectType: 'agreement',
      objectId: row.id,
    });
    return entries;
  }
  if (row.status !== 'proposed') {
    // The discriminator is the STATUS, never `updated_at !== created_at` —
    // a closing transition landing in the same millisecond as the proposal
    // is still a transition (same-ms races made rejected agreements vanish
    // from the audit feed; caught by the governance-audit sweep flake).
    // DB-F03 (R15): attribution follows WHO ACTED on the closing transition.
    // T75 (R8, u3-F4): the SINGLE SOURCE is the agreement-transition audit
    // row written by the decide/terminate route (the acting user is known
    // there — an env-owner or consumer termination must never be re-attributed
    // to the provider by a shape guess; the R8 incident had the audit row and
    // the notification title contradicting each other about one event). The
    // row-shape inference below is the LEGACY fallback only (rows outside the
    // command-log fetch window, or system lanes that predate the audit rows).
    const closedByConsumer =
      row.countered_terms_json !== null && (row.status === 'active' || row.status === 'rejected');
    const auditedActorId = transitionActorOf?.(row.id, row.status);
    const actorId = auditedActorId ??
      (closedByConsumer ? row.consumer_owner_id : row.provider_owner_id);
    entries.push({
      time: row.updated_at,
      actor: actorRef(stores, actorId),
      kind: 'agreement',
      action: row.status,
      summary: `agreement ${row.status}${closedByConsumer ? ' (consumer accepted the counter)' : ''} (service ${serviceLabel})`,
      objectType: 'agreement',
      objectId: row.id,
    });
  }
  return entries;
}

/** `{id, displayName}` for the feed; engine/scenario synthetic actors get a
 * human label (T33) — null only when a REAL user row is gone. */
function actorRef(
  stores: ActivityFeedStores,
  userId: string,
): { id: string; displayName: string } | null {
  // T33: engine ('engine:sim:*' / 'engine:agent:*' / 'engine:flow:*') and
  // scenario audit actors are not user rows — they render as named engines,
  // never as '-'. Cache-free: the synthetic branch is a pure string op.
  const synthetic = syntheticActorDisplayName(userId);
  if (synthetic !== undefined) return { id: userId, displayName: synthetic };
  const user = stores.userStore.findById(userId);
  return user ? { id: userId, displayName: user.display_name } : null;
}
