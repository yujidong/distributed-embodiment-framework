/**
 * Standing asks — the 需求板 matching engine + ask validation
 * (T-069, DevLoop R23 — R19 NW-F04; design-data-services.md §11).
 *
 * A standing ask persists a member's demand for a FUTURE counterpart asset.
 * The matching hook rides the two service-'created' seams (explicit publish
 * in routes/services.ts + the derivation-sync broadcast in
 * service-derivation-sync.ts): when a new service appears, open asks of the
 * same semantic type (zone-scoped when the ask declares one) are claimed
 * single-match and the asker receives an ask.matched notification; asks with
 * `autoPropose` additionally land a pre-filled PROPOSED agreement built from
 * the ask's desired terms — the provider decides exactly as with a manual
 * proposal (governance unchanged; the provenance note travels in
 * terms.notes + the notification body).
 *
 * Lives in a service module (not under routes/) so the derivation-sync
 * module can depend on it — the import-direction guard (arch-guards) holds
 * that line. Matching is a BEST-EFFORT side lane: a publish that succeeded
 * must never 500 because matching threw — the entry points swallow + log.
 */

import type { UiLocale } from '@active-collaboration/shared';

import {
  assertBackingUnambiguous,
  assertDeliverableAtSigning,
  assertFlowServiceTerms,
  assertReadClauseWithinSchema,
  parseTermsBody,
  summarizeTerms,
  type AgreementRoutesContext,
} from './agreements/index.js';
import type { AgreementTerms } from './db/agreement-store.js';
import { parseTerms } from './db/agreement-store.js';
import {
  parseMapData,
  type EnvironmentRow,
  type EnvironmentStore,
} from './db/environment-store.js';
import type { AgreementStore } from './db/agreement-store.js';
import type { NotificationStore } from './db/notification-store.js';
import type { ServiceStore, ServiceInstanceRow } from './db/service-store.js';
import { unbackedFlagsForEnv } from './db/service-store.js';
import {
  MAX_OPEN_ASKS_PER_MEMBER,
  type StandingAskRow,
  type StandingAskStore,
} from './db/standing-ask-store.js';
import type { UserStore } from './db/user-store.js';
import type { ChangePipeline } from './change-pipeline.js';
import { ApiError } from './errors.js';
import { t } from './i18n/index.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';

// ---------------------------------------------------------------------------
// Validation (the create route's closed schema)
// ---------------------------------------------------------------------------

/** design §11.2(1): default 30d expiry. */
export const ASK_DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** design §11.2(4): expiry ceiling 365d. */
export const ASK_MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
/** design §11.2(1): note ceiling. */
export const ASK_MAX_NOTE_LENGTH = 500;

export interface ParsedAskInput {
  semanticType: string;
  zoneId: string | null;
  desiredTerms: AgreementTerms;
  note: string;
  autoPropose: boolean;
  expiresAt: string;
}

/**
 * T-503 (EC24-F01, R24) — RETIRED by D2 (T-079, DevLoop R28): the
 * zone-provable vocabulary ask creation taught against. Pre-amendment, a
 * zone-pinned ask could ONLY ever match a DERIVED service, so a free-named
 * type no derivation could mint was structurally unmatchable and creation
 * refused with the honest options. §11.2(6) is AMENDED: published/flow
 * services may DECLARE a zoneId at publish, so any semantic type is now
 * matchable by future supply — the refusal would block exactly the asks
 * the declaration exists to serve. The board's honesty now rides on
 * matching alone (strict type equality + zone provable-and-equal).
 */

/**
 * Closed-schema ask validation. Everything the ask carries is validated at
 * the EARLIEST boundary (the standing trap): unknown fields are named, the
 * zone must exist in the env, desiredTerms run the SAME parseTermsBody the
 * propose route uses (a match-time 422 the asker cannot act on would be a
 * broken promise), and the expiry is bounded.
 */
export function parseAskBody(
  env: EnvironmentRow,
  raw: unknown,
  now: Date,
): ParsedAskInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Request body must be an object');
  }
  const body = raw as Record<string, unknown>;
  const known = ['semanticType', 'zoneId', 'desiredTerms', 'note', 'autoPropose', 'expiresAt'];
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "${key}" is not recognized (allowed: ${known.join(', ')})`,
      );
    }
  }
  if (typeof body.semanticType !== 'string' || body.semanticType.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "semanticType" must be a non-empty string — the capability vocabulary services ' +
        'and reputation are keyed on (the same string a published/derived service would carry)',
    );
  }
  let zoneId: string | null = null;
  if (body.zoneId !== undefined) {
    if (typeof body.zoneId !== 'string' || body.zoneId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "zoneId" must be a non-empty string when provided');
    }
    const zones = parseMapData(env).zones;
    if (!zones.some(zone => zone.id === body.zoneId)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "zoneId" names no zone of this environment: "${body.zoneId}" — ` +
          `zones are: ${zones.map(zone => `"${zone.id}"`).join(', ') || '(none — drop zoneId to ask env-wide)'}`,
      );
    }
    zoneId = body.zoneId;
    // D2 (T-079, DevLoop R28) — §11.2(6) AMENDED: a zone-pinned ask matches
    // derived services (source-device zone) AND published/flow services that
    // DECLARE the same zoneId at publish. The pre-amendment T-503 refusal
    // (free-named types can never match) is retired — any type is now
    // matchable by future declared supply; strict type equality + zone
    // provable-and-equal keep the board honest.
  }
  // The SAME closed terms schema the propose route enforces — validated at
  // ask creation so a later match can never discover an unactionable ask.
  const desiredTerms = parseTermsBody(body.desiredTerms);
  let note = '';
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "note" must be a string when provided');
    }
    if (body.note.length > ASK_MAX_NOTE_LENGTH) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "note" is too long (${body.note.length} chars) — the limit is ${ASK_MAX_NOTE_LENGTH}`,
      );
    }
    note = body.note;
  }
  let autoPropose = false;
  if (body.autoPropose !== undefined) {
    if (typeof body.autoPropose !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "autoPropose" must be a boolean when provided');
    }
    autoPropose = body.autoPropose;
  }
  // T-603 (R26, GO26-F01): earliest-boundary teaching. The terms SCHEMA alone
  // does not know what will match: a FLOW-service contract requires
  // terms.action {command:'run'} (assertFlowServiceTerms at match time), and
  // an autoPropose ask without an action clause burns its single match on
  // every flow-service it meets (claimed, then skipped-invalid-terms, and the
  // asker keeps only the manual-propose replyHint). The §11.2 single-match
  // and claim rulings stand — teach BEFORE the ask exists instead.
  if (autoPropose && desiredTerms.action === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'autoPropose pre-fills an agreement from desiredTerms, and a flow-service contract ' +
        'REQUIRES terms.action {command: "run"} — without an action clause every flow-service match ' +
        'will skip auto-propose while still consuming the ask\'s single match. ' +
        'Add terms.action (a flow-service action is {command: "run", params?}; a derived-service ' +
        'action names the capability: {command: "<capability>", params?}), ' +
        'or set autoPropose: false and propose manually after the match notification',
    );
  }
  let expiresAt = new Date(now.getTime() + ASK_DEFAULT_EXPIRY_MS).toISOString();
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "expiresAt" must be an ISO-8601 timestamp when provided',
      );
    }
    const expiresMs = Date.parse(body.expiresAt);
    if (expiresMs <= now.getTime()) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "expiresAt" is already in the past — an ask must be open for at least a moment ' +
          '(drop it for the default 30 days)',
      );
    }
    if (expiresMs > now.getTime() + ASK_MAX_EXPIRY_MS) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "expiresAt" is too far out (${body.expiresAt}) — the ceiling is ` +
          `${ASK_MAX_EXPIRY_MS / (24 * 60 * 60 * 1000)} days (default ${ASK_DEFAULT_EXPIRY_MS / (24 * 60 * 60 * 1000)})`,
      );
    }
    expiresAt = new Date(expiresMs).toISOString();
  }
  return { semanticType: body.semanticType, zoneId, desiredTerms, note, autoPropose, expiresAt };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function standingAskToJson(
  row: StandingAskRow,
  asker: { id: string; displayName: string },
): Record<string, unknown> {
  let desiredTerms: unknown = {};
  try {
    desiredTerms = JSON.parse(row.desired_terms_json);
  } catch {
    // Corruption must never break the board.
  }
  return {
    id: row.id,
    envId: row.env_id,
    asker: { id: row.asker_id, displayName: asker.displayName },
    semanticType: row.semantic_type,
    ...(row.zone_id !== null ? { zoneId: row.zone_id } : {}),
    desiredTerms,
    note: row.note,
    autoPropose: row.auto_propose === 1,
    status: row.status,
    ...(row.matched_service_id !== null ? { matchedServiceId: row.matched_service_id } : {}),
    ...(row.matched_at !== null ? { matchedAt: row.matched_at } : {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

/**
 * Duck-typed matching deps — the real route/service contexts satisfy this
 * structurally; agreementStore/notificationStore are optional so minimal
 * test contexts degrade (no auto-propose / no notification) instead of
 * crashing the publish lane.
 */
export interface StandingAskMatchDeps {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  standingAskStore: StandingAskStore;
  userStore: UserStore;
  agreementStore?: AgreementStore;
  notificationStore?: NotificationStore;
  /** Agreement broadcast + audit parity with the manual propose path. */
  pipeline?: ChangePipeline;
  /** Mechanism D: flow-service terms validation needs the flow lookup. */
  flowStore?: { getById(id: string): { inputs_json: string | null; name: string } | undefined };
  /** Where swallowed matching errors are reported (tests pass a spy). */
  onMatchError?: (error: unknown) => void;
}

/** The honest provenance marker design §11.2(8) mandates. */
export const STANDING_ASK_PROVENANCE_NOTE = 'pre-filled from standing ask';

/**
 * The zone a service can prove it lives in: derived services carry their
 * source device's zone; published/flow offers carry their DECLARED zone
 * (D2, T-079 — §11.2(6) amended: providers may declare `zoneId` at publish,
 * honored exactly like the derived lane). Undeclared offers have none —
 * when the ask declares a zone, an unprovable service does NOT match.
 */
function serviceZoneId(
  deps: Pick<StandingAskMatchDeps, 'envStore'>,
  service: ServiceInstanceRow,
): string | null {
  if (service.source_device_id !== null) {
    return deps.envStore.getDevice(service.source_device_id)?.zone_id ?? null;
  }
  return service.zone_id ?? null;
}

export interface AskMatchOutcome {
  ask: StandingAskRow;
  notified: boolean;
  autoPropose: 'proposed' | 'skipped-unbacked' | 'skipped-invalid-terms' | 'off' | 'skipped';
  agreementId?: string;
}

// ---------------------------------------------------------------------------
// Creation-time match preview (R25-NF2, C1 — DevLoop R28)
// ---------------------------------------------------------------------------

/** One already-existing service that satisfies a freshly created ask. */
export interface AskExistingMatchView {
  id: string;
  name: string;
  semanticType: string;
  origin: string;
  zoneId: string | null;
  providerAgentId: string;
  providerAgentName: string;
  providerName: string;
}

/**
 * R25-NF2 (C1, DevLoop R28): the ask-creation 201 teaches what the board
 * cannot — matching fires ONLY when a NEW service appears, so an ask that
 * already has satisfiers would otherwise sit open beside them until a
 * SECOND service happens to be minted (the R25 acceptance repro). This runs
 * the SAME matching logic `matchStandingAsksForNewService` applies per new
 * service (visibility, strict semanticType equality, asker ≠ provider
 * owner, zone provable + equal when the ask pins one) against the env's
 * CURRENT services — a read-only preview, never a claim: the ask stays
 * open and single-match semantics are untouched.
 */
export function existingMatchesForAsk(
  deps: Pick<StandingAskMatchDeps, 'envStore' | 'serviceStore' | 'userStore'>,
  envId: string,
  askerId: string,
  ask: { semanticType: string; zoneId: string | null },
): AskExistingMatchView[] {
  const matches: AskExistingMatchView[] = [];
  for (const service of deps.serviceStore.servicesOf(envId)) {
    if (service.visibility === 'hidden') continue; // provider's visibility wins
    if (service.semantic_type !== ask.semanticType) continue; // strict equality
    const providerAgent = deps.envStore.getAgent(service.provider_agent_id);
    if (providerAgent === undefined) continue;
    if (providerAgent.owner_id === askerId) continue; // own asset, no self-match
    const serviceZone = serviceZoneId(deps, service);
    if (ask.zoneId !== null && serviceZone !== ask.zoneId) continue; // zone unproven or different
    matches.push({
      id: service.id,
      name: service.name,
      semanticType: service.semantic_type,
      origin: service.origin,
      zoneId: serviceZone,
      providerAgentId: service.provider_agent_id,
      providerAgentName: providerAgent.name,
      providerName: deps.userStore.findById(providerAgent.owner_id)?.display_name ?? providerAgent.owner_id,
    });
  }
  return matches;
}

/**
 * The zone-matchability note a zone-pinned ask's 201 carries (C1a; D2
 * wording — declared zones join the derived lane as provable presence).
 */
export const ZONE_MATCHABILITY_NOTE =
  'this ask is zone-pinned: while "zoneId" is set it matches only services that can PROVE they ' +
  'operate there — derived services (their source device\'s zone) and published/flow services ' +
  'that declared the same zoneId at publish (undeclared offers stay zone-less and never match a ' +
  'zone-pinned ask); matching is strict type equality either way';

/** The note the 201 carries when satisfiers already exist (C1b). */
export function existingMatchesNote(count: number): string {
  return `${count} existing service${count === 1 ? '' : 's'} already match${count === 1 ? 'es' : ''} this ask — ` +
    'board matching fires only when a NEW service appears (this ask stays open, single-match intact); ' +
    'you can propose directly now with POST /api/services/{serviceId}/agreements';
}

/**
 * Match a NEWLY CREATED service against the env's open asks. Best-effort:
 * never throws (callers ride the publish lane) — internal failures are
 * swallowed into `onMatchError`. Returns the match outcomes (empty when the
 * service matched nothing).
 *
 * design §11.2(6) conditions: open + unexpired, asker ≠ provider owner,
 * semanticType equality, and (ask.zoneId ⇒ service zone provable + equal).
 * Hidden services never match (the provider's visibility choice wins —
 * notifying a member about an offer they cannot even see would leak it).
 */
export function matchStandingAsksForNewService(
  deps: StandingAskMatchDeps,
  service: ServiceInstanceRow,
  actorId: string,
  locale: UiLocale = 'zh-CN',
): AskMatchOutcome[] {
  const outcomes: AskMatchOutcome[] = [];
  try {
    if (service.visibility === 'hidden') return outcomes;
    const providerAgent = deps.envStore.getAgent(service.provider_agent_id);
    if (providerAgent === undefined) return outcomes;
    const asks = deps.standingAskStore.listOpenBySemanticType(service.env_id, service.semantic_type);
    const serviceZone = serviceZoneId(deps, service);
    for (const ask of asks) {
      if (ask.asker_id === providerAgent.owner_id) continue; // own asset, no self-match
      if (ask.zone_id !== null && serviceZone !== ask.zone_id) continue; // zone unproven or different
      // Single-match claim FIRST — the winner owns the notification lane.
      const claimed = deps.standingAskStore.markMatched(ask.id, service.id);
      if (claimed === undefined) continue; // a concurrent claim won
      outcomes.push(deliverMatch(deps, claimed, service, providerAgent.owner_id, providerAgent.name, locale));
    }
  } catch (error) {
    deps.onMatchError?.(error);
  }
  return outcomes;
}

function deliverMatch(
  deps: StandingAskMatchDeps,
  ask: StandingAskRow,
  service: ServiceInstanceRow,
  providerOwnerId: string,
  providerAgentName: string,
  locale: UiLocale,
): AskMatchOutcome {
  const outcome: AskMatchOutcome = { ask, notified: false, autoPropose: 'off' };
  let agreementId: string | undefined;
  let autoPropose: AskMatchOutcome['autoPropose'] = 'off';
  let autoProposeReason: string | undefined;
  if (ask.auto_propose === 1) {
    const result = tryAutoPropose(deps, ask, service, locale);
    agreementId = result.agreementId;
    autoPropose = result.outcome;
    autoProposeReason = result.skipReason;
  }

  if (deps.notificationStore !== undefined) {
    const notified = notify(deps.notificationStore, {
      recipientId: ask.asker_id,
      actorId: providerOwnerId,
      envId: ask.env_id,
      kind: NOTIFICATION_KINDS.askMatched,
      title: t(locale, 'chrome.notif.askMatched'),
      body: {
        askId: ask.id,
        semanticType: ask.semantic_type,
        serviceId: service.id,
        serviceName: service.name,
        serviceOrigin: service.origin,
        providerAgentId: service.provider_agent_id,
        providerAgentName,
        providerName: deps.userStore.findById(providerOwnerId)?.display_name ?? providerOwnerId,
        autoPropose,
        // T-603 (R26): WHY auto-propose skipped — the manual-propose
        // replyHint is only actionable with the gate's cause in hand.
        ...(autoProposeReason !== undefined ? { autoProposeReason } : {}),
        ...(agreementId !== undefined ? { agreementId } : {}),
        replyHint:
          agreementId === undefined
            ? {
                endpoint: `POST /api/services/${service.id}/agreements`,
                yourMove: true,
              }
            : {
                endpoint: 'GET /api/agreements?envId=' + ask.env_id,
                yourMove: false, // the PROVIDER now holds the decision
              },
      },
      refId: service.id,
    });
    outcome.notified = notified !== null;

    // T-504 (EC24-F05): the PROVIDER's match signal — until now their only
    // cue was the board row vanishing (§11.2-2). ONE-SHOT event on their own
    // publish, NOT the §11.5-rejected reverse subscription: no standing
    // listener, no ask-arrival push. The replyHint is the decide lane when a
    // pre-filled proposal landed (that proposal's own doorbell rings
    // separately, full parity with the manual propose path), else the board
    // (the asker holds the next move).
    notify(deps.notificationStore, {
      recipientId: providerOwnerId,
      actorId: ask.asker_id,
      envId: ask.env_id,
      kind: NOTIFICATION_KINDS.askMatchedProvider,
      title: t(locale, 'chrome.notif.askMatchedProvider'),
      body: {
        askId: ask.id,
        semanticType: ask.semantic_type,
        serviceId: service.id,
        serviceName: service.name,
        askerName: deps.userStore.findById(ask.asker_id)?.display_name ?? ask.asker_id,
        autoPropose,
        ...(agreementId !== undefined ? { agreementId } : {}),
        replyHint:
          agreementId !== undefined
            ? {
                endpoint: `POST /api/agreements/${agreementId}/decide`,
                allowedDecisions: ['accept', 'reject'],
                yourMove: true,
              }
            : {
                endpoint: `GET /api/environments/${ask.env_id}/asks`,
                yourMove: false, // the asker may propose; nothing waits on you
              },
      },
      refId: ask.id,
    });
  }
  outcome.autoPropose = autoPropose;
  outcome.agreementId = agreementId;
  return outcome;
}

/**
 * The ask's desired terms → a PROPOSED agreement, through the SAME gates
 * the manual propose route enforces (backed device or computation, backing
 * unambiguity, flow-service action shape, read-clause/dataSchema subset).
 * A gate refusal degrades honestly (the notification names why) instead of
 * landing a contract that can never deliver — the T-310 lesson carried to
 * the matching lane.
 */
function tryAutoPropose(
  deps: StandingAskMatchDeps,
  ask: StandingAskRow,
  service: ServiceInstanceRow,
  locale: UiLocale,
): { outcome: AskMatchOutcome['autoPropose']; agreementId?: string; skipReason?: string } {
  const providerAgent = deps.envStore.getAgent(service.provider_agent_id);
  if (deps.agreementStore === undefined || providerAgent === undefined) {
    return { outcome: 'skipped' };
  }
  const unbacked =
    (unbackedFlagsForEnv(deps.envStore, [service]).get(service.id) ?? true) === true;
  const computation = deps.serviceStore.computationOf(service.id);
  if (unbacked && computation === undefined) {
    // Honest degradation (design §11.2(8)): no contract that can never
    // deliver — the asker still gets the match notification + replyHint.
    return { outcome: 'skipped-unbacked' };
  }
  const desired = parseTerms(ask.desired_terms_json);
  try {
    // The gate helpers read only {envStore} / {envStore, flowStore} of the
    // agreement context — a structural slice is exactly their surface.
    assertBackingUnambiguous(
      { envStore: deps.envStore } as unknown as AgreementRoutesContext,
      service,
    );
    assertFlowServiceTerms(
      { envStore: deps.envStore, flowStore: deps.flowStore } as unknown as AgreementRoutesContext,
      service,
      desired,
    );
    assertReadClauseWithinSchema(service, computation, desired);
    // R6-B-F01 / R6-C-F02: the signing-time deliverability gates ride the
    // same try — a match that could never deliver degrades to skip + reason
    // exactly like the gates above (the asker keeps the manual replyHint).
    assertDeliverableAtSigning(
      { envStore: deps.envStore, serviceStore: deps.serviceStore } as unknown as AgreementRoutesContext,
      service,
      desired,
    );
  } catch (error) {
    // The gates exist to protect the consumer; an ask written before the
    // service existed could not anticipate them. Skip + say why (T-603): the
    // caught gate's teaching rides the asker's notification so the
    // manual-propose replyHint is actionable.
    const reason = error instanceof ApiError ? error.message : String(error);
    return {
      outcome: 'skipped-invalid-terms',
      skipReason: reason.length > 240 ? `${reason.slice(0, 237)}...` : reason,
    };
  }
  const terms = withProvenanceNote(desired, ask);
  const row = deps.agreementStore.createAgreement({
    envId: ask.env_id,
    serviceId: service.id,
    consumerAgentId: null,
    consumerOwnerId: ask.asker_id,
    providerAgentId: service.provider_agent_id,
    providerOwnerId: providerAgent.owner_id,
    terms,
  });
  // Full parity with the manual propose path: doorbell + stream + audit.
  if (deps.notificationStore !== undefined) {
    notify(deps.notificationStore, {
      recipientId: providerAgent.owner_id,
      actorId: ask.asker_id,
      envId: ask.env_id,
      kind: NOTIFICATION_KINDS.agreementProposed,
      title: t(locale, 'chrome.notif.agreementProposed'),
      body: {
        agreementId: row.id,
        serviceId: service.id,
        serviceName: service.name,
        status: 'proposed',
        consumerName: deps.userStore.findById(ask.asker_id)?.display_name ?? ask.asker_id,
        termsSummary: summarizeTerms(terms, locale),
        provenance: 'standing-ask',
        askId: ask.id,
        replyHint: {
          endpoint: `POST /api/agreements/${row.id}/decide`,
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      },
      refId: row.id,
    });
  }
  deps.pipeline?.publishAgreement(ask.env_id, 'proposed', row.id, ask.asker_id);
  deps.pipeline?.log({
    envId: ask.env_id,
    actorId: ask.asker_id,
    kind: 'agreement-transition',
    payload: {
      agreementId: row.id,
      serviceId: service.id,
      from: null,
      to: 'proposed',
      provenance: 'standing-ask',
      askId: ask.id,
      terms: JSON.parse(row.terms_json) as unknown,
    },
  });
  return { outcome: 'proposed', agreementId: row.id };
}

/** design §11.2(8): the honest provenance note rides terms.notes. */
function withProvenanceNote(terms: AgreementTerms, ask: StandingAskRow): AgreementTerms {
  const marker = `${STANDING_ASK_PROVENANCE_NOTE} ${ask.id} (posted ${ask.created_at})`;
  return {
    ...terms,
    notes: terms.notes !== undefined && terms.notes.length > 0
      ? `${terms.notes} [${marker}]`
      : marker,
  };
}

/** The quota probe the create route runs BEFORE inserting (design §11.2(4)). */
export function assertAskQuota(
  store: StandingAskStore,
  envId: string,
  askerId: string,
): void {
  const open = store.countOpenOf(envId, askerId);
  if (open >= MAX_OPEN_ASKS_PER_MEMBER) {
    throw new ApiError(
      429,
      'ASK_QUOTA_EXCEEDED',
      `You already hold ${open} open standing asks in this environment — the cap is ` +
        `${MAX_OPEN_ASKS_PER_MEMBER} per member. Withdraw one (DELETE /api/environments/:id/asks/:askId ` +
        '— withdraw then re-ask keeps the board honest) or wait for expiry before posting another',
      undefined,
      { open, cap: MAX_OPEN_ASKS_PER_MEMBER },
    );
  }
}
