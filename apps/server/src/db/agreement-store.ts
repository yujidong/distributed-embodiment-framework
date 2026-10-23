/**
 * Agreement store — service consumption contracts (Fix-11,
 * service-consumption-design.md §3, Phase 1)
 *
 * A ServiceAgreement is the bilateral contract between a consumer (a user,
 * optionally naming one of their agents) and a service offer. It is NOT a
 * world-structure change: proposals/governance do not apply — creating one
 * is a marketplace act between two owners, exactly like a subscription but
 * with a lifecycle both sides can act on.
 *
 * Lifecycle (§3.1): proposed → active | rejected → suspended | terminated.
 * The design's `accepted` state is transient: a provider accept lands the
 * agreement directly in `active`. Terminal states: rejected, terminated.
 *
 * usage_records is APPEND-ONLY by construction: the store exposes append +
 * read only, no update/delete — the metering evidence must stay immutable
 * and auditable (§3.3). settlement_receipts is likewise append-only: the
 * SettlementProvider's archived output (§3.4).
 */

import { randomUUID } from 'node:crypto';

import { ApiError } from '../errors.js';
import type { EafDatabase } from './database.js';

/**
 * R14 Wave-B (design-consent-semantics.md §5.1): 'countered' joins the
 * lifecycle — the provider's counter-offer on a proposal. It is a
 * NON-terminal state whose DECIDE RIGHT belongs to the CONSUMER (accept →
 * active with the countered terms, reject → rejected terminal). Depth 1:
 * proposed → countered happens at most once (re-negotiation = terminate and
 * re-propose; the state space stays bounded, v1 has no negotiation tree).
 *
 * D3 (DevLoop R28, T-080): 'held' joins — the CONSUMER's bounded
 * consumption pause (a circuit breaker for debugging/venting without
 * nuking the relationship). While held, auto-trigger execution AND manual
 * invokes are suspended for THAT agreement only; the provider sees the
 * status; the hold auto-expires (lazy evaluation — the standing-asks
 * pattern: reads/trigger-evaluations flip an expired hold back to 'active',
 * no resident sweeper, so stale data is never returned); quota is untouched
 * (nothing executes, nothing burns). NON-terminal: terminate still applies.
 */
export type AgreementStatus =
  | 'proposed'
  | 'countered'
  | 'active'
  | 'held'
  | 'rejected'
  | 'suspended'
  | 'terminated';

export const AGREEMENT_STATUSES: readonly AgreementStatus[] = [
  'proposed',
  'countered',
  'active',
  'held',
  'rejected',
  'suspended',
  'terminated',
];

/**
 * Establishment path (§3.1): 'explicit' = a marketplace proposal decided by
 * the provider; 'ac' = an ephemeral agreement landed automatically when an
 * AC handshake succeeds — born active, terminated when the collaboration
 * ends (completed / cancelled / timed out).
 */
export type AgreementSource = 'explicit' | 'ac';

export const AGREEMENT_SOURCES: readonly AgreementSource[] = ['explicit', 'ac'];

/**
 * R5-F09: the DISPLAY outcome of a terminated agreement — the ONE 口径 shared
 * by the arrival digest's completedCollaborations and the F08/T30 restricted
 * view (terminatedAgreementRestrictedJson). Never write a second copy.
 *
 * - a metered usage outcome (success/partial/failure) always wins — it is the
 *   measured truth of what the collaboration delivered;
 * - an AC ephemeral agreement closed without a usage row is a CANCELLED
 *   collaboration (Fix-21: the executor never ran);
 * - an EXPLICIT agreement that never reached 'active' (activated_at NULL —
 *   proposed/countered straight to terminated) is likewise 'cancelled': it
 *   was never in effect, so it cannot be shown as a "completed
 *   collaboration" (the F09 mislabel);
 * - T34 (R3 u3-F6/u4-F7): an EXPLICIT agreement that WAS active but closed
 *   with NO usage row reads 'ended-without-delivery' — it was in effect and
 *   delivered NOTHING, which the old 'completed' default (the F09-era
 *   label) stated as a collaboration that produced results. The ledger must
 *   not outshine the world history: activated + 0 metered rows is a distinct,
 *   honest verdict. Read-time derivation — historical rows re-derive to the
 *   corrected label (no migration; the state machine is untouched: outcome
 *   is a derived DISPLAY tag, not a lifecycle state).
 */
export function terminatedAgreementOutcome(
  row: Pick<AgreementRow, 'source' | 'activated_at'>,
  usageOutcome: string | undefined,
): string {
  if (usageOutcome !== undefined) return usageOutcome;
  if (row.source === 'ac') return 'cancelled';
  return row.activated_at !== null ? 'ended-without-delivery' : 'cancelled';
}

/**
 * All-optional agreement terms (§3.1). Unit-neutral by design: the core
 * stores `pricePerUnit`/`priceUnit` verbatim for future settlement adapters
 * and never interprets them; absent quota/price fields mean "unlimited"
 * (infinite-resources assumption, principle 6).
 *
 * `trigger`/`action` (Wave-4a, 小林 R8 F-14): the STRUCTURED form of the
 * business intent that used to fit only in free-text `notes` ("grid-peak 时
 * 调回 26°C"). Still non-binding contract data — nothing watches the trigger
 * or executes the action automatically (usage/invoke are unaffected);
 * automatic trigger execution is post-Wave-4 work.
 */
export interface AgreementTerms {
  meteringUnit?: string;
  quotaPerWindow?: number;
  windowSec?: number;
  /**
   * T-070 (R22, FM-F05 terms half): the trigger automation's auto-reset
   * clause — an event-armed actuation otherwise pegs the device indefinitely
   * (the night's floodlight stuck at 100%). Optional; requires trigger+action
   * (it arms only from a trigger-driven invocation of the agreed action).
   * Executed by the T-035 trigger executor through the SAME metered
   * invocation core, attributed 'auto-reset' (usage row + command_log
   * autoReset marker). afterSec counts SIM seconds on the armed runtime;
   * onEvent fires on the next matching injected event; first-to-fire wins.
   */
  autoReset?: AgreementAutoResetTerms;
  /**
   * Quota window semantics (Wave-6, Fix-20 遗留): 'sliding' (default, the
   * pre-Wave-6 behavior) counts consumption of the LAST windowSec seconds;
   * 'fixed' counts within tumbling windows of windowSec anchored at the
   * moment the agreement (re)entered 'active' (its updated_at — invoke
   * requires active, so updated_at IS the activation time). Only meaningful
   * together with quotaPerWindow+windowSec.
   */
  windowKind?: 'sliding' | 'fixed';
  pricePerUnit?: string;
  priceUnit?: string;
  notes?: string;
  trigger?: AgreementTrigger;
  action?: AgreementAction;
  /**
   * R14 Wave-A (design-data-services.md §6): the data-read clause — a closed
   * sub-object on data-service agreements. Enforced: fields (server-side
   * frame filter; request-level widening 422s), quotaPerWindow/windowSec
   * (a READ budget, separate from the invoke budget above — T-307 by kind),
   * minFreshnessSec (cache frame below it → 409 DATA_STALE). Declarative:
   * cadenceSec (push-lane throttle anchor, best-effort) and retentionSec
   * (contract + frame echo only — NOT technically enforceable, the platform
   * cannot stop a consumer from copying delivered data).
   */
  read?: AgreementReadTerms;
  /**
   * R6-C-F02: the zone the agreed action's physical effect must REACH.
   * Optional; absent = the contract carries no physical-target claim (pure
   * data services, informational triggers) and the signing-time
   * reachability gate does not apply. Deliberately distinct from
   * trigger.zoneId, which scopes the EVENT the trigger automation watches —
   * cross-zone "observe here, act there" contracts (T-064) stay
   * legitimate.
   */
  targetZoneId?: string;
  /**
   * R6-C-F02 exemption: 'propagation' declares the service reaches the
   * target zone through system-level delivery (central HVAC, district
   * loops) rather than declared zone adjacency — the signing-time
   * reachability gate honors the declaration. Contract data only; nothing
   * executes differently because of it.
   */
  delivery?: 'propagation';
}

export interface AgreementReadTerms {
  /** Allowed dataSchema field subset; absent = unrestricted (all fields). */
  fields?: string[];
  /** Read budget per window — counts kind='read' usage rows only. */
  quotaPerWindow?: number;
  windowSec?: number;
  /** Maximum acceptable frame age (seconds); a staler cache → 409 DATA_STALE. */
  minFreshnessSec?: number;
  /** Desired push cadence (seconds) — declarative, best-effort throttle. */
  cadenceSec?: number;
  /** Consumer retention declaration (seconds) — contract only, echoed per frame. */
  retentionSec?: number;
}

/**
 * Structured trigger condition (all fields optional): "when <eventType>
 * raises <parameter> past <threshold> in <zoneId>".
 */
export interface AgreementTrigger {
  eventType?: string;
  parameter?: string;
  threshold?: number;
  zoneId?: string;
}

/**
 * T-070: the auto-reset clause of a trigger-action agreement. Exactly what
 * "reset" means must be NEGOTIATED (the platform never guesses an inverse):
 * `action` is the reset command + params; `afterSec` arms a sim-time
 * countdown from the trigger-driven invocation; `onEvent` fires the reset on
 * the next injected event matching the clause. At least one of the two
 * triggers must be present (validation enforces it).
 */
export interface AgreementAutoResetTerms {
  /** Fire the reset this many SIM seconds after the trigger action executed. */
  afterSec?: number;
  /** Or: fire the reset on the next injected event matching this clause. */
  onEvent?: AgreementTrigger;
  /** The reset action — required; a reset clause names nothing is invalid. */
  action: AgreementAction;
}

/** The action the consumer expects when the trigger condition holds. */
export interface AgreementAction {
  command: string;
  params?: Record<string, unknown>;
}

export interface AgreementRow {
  id: string;
  env_id: string;
  /**
   * v60 (R6-E-F08): NULLABLE — a retired agreement (provider agent removed)
   * is unlinked so the service-row FK cascade has nothing to match and the
   * ledger survives. Non-null on every live agreement; null only after a
   * provider retire (status_reason = 'provider-unavailable') or a pre-v60
   * row restored without its service.
   */
  service_id: string | null;
  consumer_agent_id: string | null;
  consumer_owner_id: string;
  /** v60 (R6-E-F08): NULLABLE — same retire-unlink story as service_id. */
  provider_agent_id: string | null;
  provider_owner_id: string;
  terms_json: string;
  /**
   * T-059 (R14): the provider's counter-offer terms (FULL terms object, not
   * a diff — simple storage, clear audit). Non-null while status='countered'
   * and after an accept-from-counter (kept for audit); the original
   * proposal's terms_json is NEVER overwritten during the countered state.
   * On consumer accept the countered terms are COPIED into terms_json — the
   * enforcement paths (invoke/reads/stream) keep reading terms_json only.
   */
  countered_terms_json: string | null;
  status: AgreementStatus;
  source: AgreementSource;
  /** The AC an ephemeral (source='ac') agreement belongs to; null otherwise. */
  collaboration_id: string | null;
  /**
   * D3 (T-080): the wall-clock expiry of a consumer hold (set when status
   * becomes 'held', cleared on resume). Lazy evaluation: reads and trigger
   * evaluations flip an expired hold back to 'active' — no resident timer.
   */
  hold_expires_at: string | null;
  /**
   * R5-F09 (v59): the first moment the agreement (re)entered 'active';
   * NULL = never in effect. The terminated-outcome 口径
   * (terminatedAgreementOutcome — arrival digest + F08/T30 restricted view)
   * reads it to tell "was active, then ended" from "never active"
   * ('cancelled'); since T34 an active-but-unmetered close reads
   * 'ended-without-delivery', not 'completed'. Born-active (AC ephemeral)
   * rows stamp it at creation; pre-v59 rows were backfilled by the migration
   * (active-family and terminal rows — see database.ts v59).
   */
  activated_at: string | null;
  /**
   * v60 (R6-E-F08): WHY the row reached its current status when a platform
   * event (not a party action) moved it — 'provider-unavailable' marks the
   * provider-agent-removed retire (see retireProviderAgreements). Party-
   * driven transitions (decide/suspend/hold/terminate routes) always carry
   * NULL — the reason column never overrides the party's own act.
   */
  status_reason: string | null;
  /**
   * v63 (R2 T9, u2-F5/u4-F7): the remind trace — the newest `agreement
   * remind` stamp and the running total. Reminders are NOT lifecycle
   * transitions (updated_at is untouched by markReminded); these columns
   * ARE the observable mark ("已提醒 N 次，最近 <时刻>"), so "reminded and
   * waiting" never reads as "never reminded" again. NULL/0 = never reminded.
   */
  last_reminded_at: string | null;
  remind_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * v60 (R6-E-F08): the status_reason written when a provider agent's removal
 * retires its agreements. One shared literal — the retire path writes it,
 * the arrival digest's provider-unavailable section reads it.
 */
export const PROVIDER_UNAVAILABLE_REASON = 'provider-unavailable';

/**
 * R100 (agreement-row-integrity, wang-07): the status_reason written when a
 * SERVICE row's deletion (derived-service regeneration, device removal,
 * blueprint uninstall…) retires the agreements riding it — see
 * retireServiceAgreements. DISTINCT from 'provider-unavailable' (the agent
 * is gone): the provider agent usually survives a service deletion; only
 * the contracted offer is gone.
 */
export const SERVICE_UNAVAILABLE_REASON = 'service-unavailable';

/** R101/R102: one service's metered usage aggregate over a rolling window.
 *  invocations = succeeded + failed + partial + other（other = 既非成败也非
 *  partial 的历史口径行）——差额类别有名有姓（wang-16 观察）。 */
export interface ServiceUsageSummary {
  invocations: number;
  succeeded: number;
  failed: number;
  /** R102: AC 协作的部分达成行（outcome='partial'）。 */
  partial: number;
}

/**
 * R6-E-F08 full failover (agreement-failover.ts): the status_reason written
 * when the unreachable-provider watchdog suspends an agreement whose provider
 * agent missed heartbeats past the failover threshold. DISTINCT from
 * 'provider-unavailable': unreachable is RECOVERABLE (the agent may come
 * back — recovery terminates + re-signs, see resignRecoveredAgreement);
 * unavailable (removal) never recovers.
 */
export const PROVIDER_UNREACHABLE_REASON = 'provider-unreachable';

/**
 * R6-E-F08 full failover: the status_reason written when the watchdog closes
 * a provider-unreachable suspension because the provider heartbeats again —
 * the old row terminates and a successor is re-signed on identical terms
 * (no suspended → active edge exists; re-activation = terminate + re-sign).
 */
export const PROVIDER_RECOVERED_REASON = 'provider-recovered';

export interface CreateAgreementInput {
  envId: string;
  serviceId: string;
  consumerAgentId: string | null;
  consumerOwnerId: string;
  providerAgentId: string;
  providerOwnerId: string;
  terms: AgreementTerms;
  /** Default 'explicit'; 'ac' rows are born active (no decide step). */
  source?: AgreementSource;
  /** Default 'proposed'; ephemeral AC agreements pass 'active'. */
  status?: AgreementStatus;
  collaborationId?: string | null;
}

export type UsageKind = 'invoke' | 'stream' | 'ac' | 'read';
export type UsageOutcome = 'success' | 'failure' | 'partial';
/**
 * UX-04 (v67): the invoke lane's entry kind — manual consumer POST vs the
 * terms.trigger auto-execution vs the T-070 auto-reset. Null on lanes the
 * vocabulary does not cover (ac/stream/read) and pre-v67 rows.
 */
export type UsageSource = 'manual' | 'autoTrigger' | 'autoReset';

export interface UsageRecordRow {
  id: string;
  agreement_id: string;
  env_id: string;
  consumer_agent_id: string | null;
  provider_agent_id: string | null;
  kind: UsageKind;
  /** The invoked action name (kind='invoke'); null for other kinds. */
  action: string | null;
  quantity: number;
  unit: string;
  outcome: UsageOutcome;
  /** command_log entry id of the executed effect, when one exists. */
  effect_ref: string | null;
  /**
   * C3 (R25-NF4, DevLoop R28): WHY an outcome='failure' row failed (device
   * absent, command rejected, quota window spent, param vocabulary…). Null
   * for successes and pre-C3 rows — the reason rode only server logs before.
   */
  failure_reason: string | null;
  /**
   * v58: the metered service's origin (derived / published / flow /
   * aggregate), snapshotted from service_instances at write time — the
   * origin funnel no longer depends on the trajectory face. Null for
   * pre-v58 rows and rows metered after their service row was gone.
   */
  origin: string | null;
  /**
   * FEAT-08 (v66): the simulation that metered the row (invoke core's target
   * sim — a private sim and the world session fulfilling the SAME agreement
   * are distinguishable now). Null for pre-v66 rows and lanes without a sim
   * attribution (ac/stream/read).
   */
  simulation_id: string | null;
  /** UX-04 (v67): the invoke lane's entry kind (manual/autoTrigger/autoReset). */
  source: string | null;
  started_at: string;
  ended_at: string;
}

export interface AppendUsageInput {
  agreementId: string;
  envId: string;
  consumerAgentId: string | null;
  providerAgentId: string | null;
  kind: UsageKind;
  action?: string | null;
  quantity: number;
  unit: string;
  outcome: UsageOutcome;
  effectRef?: string | null;
  /** C3: the failure cause — stored verbatim on outcome='failure' rows. */
  failureReason?: string | null;
  /** v58: the metered service's origin (service_instances.origin snapshot). */
  origin?: string | null;
  /** FEAT-08 (v66): the simulation the invocation ran against (invoke lanes). */
  simulationId?: string | null;
  /** UX-04 (v67): the invoke lane's entry kind (manual/autoTrigger/autoReset). */
  source?: UsageSource | null;
  startedAt: string;
  endedAt: string;
}

export interface SettlementReceiptRow {
  id: string;
  agreement_id: string;
  env_id: string;
  provider: string;
  status: 'recorded';
  usage_record_ids_json: string;
  quote_json: string | null;
  created_at: string;
}

export class AgreementStore {
  constructor(private readonly db: EafDatabase) {}

  // -------------------------------------------------------------------------
  // Agreements
  // -------------------------------------------------------------------------

  createAgreement(input: CreateAgreementInput): AgreementRow {
    const now = new Date().toISOString();
    const row: AgreementRow = {
      id: randomUUID(),
      env_id: input.envId,
      service_id: input.serviceId,
      consumer_agent_id: input.consumerAgentId,
      consumer_owner_id: input.consumerOwnerId,
      provider_agent_id: input.providerAgentId,
      provider_owner_id: input.providerOwnerId,
      terms_json: JSON.stringify(input.terms),
      countered_terms_json: null,
      status: input.status ?? 'proposed',
      source: input.source ?? 'explicit',
      collaboration_id: input.collaborationId ?? null,
      hold_expires_at: null,
      // R5-F09 (v59): born-active rows (AC ephemeral) are activated at birth.
      activated_at: (input.status ?? 'proposed') === 'active' ? now : null,
      status_reason: null,
      last_reminded_at: null,
      remind_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO service_agreements
         (id, env_id, service_id, consumer_agent_id, consumer_owner_id,
          provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
          status, source, collaboration_id, hold_expires_at, activated_at, status_reason,
          last_reminded_at, remind_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.service_id, row.consumer_agent_id,
        row.consumer_owner_id, row.provider_agent_id, row.provider_owner_id,
        row.terms_json, row.countered_terms_json, row.status, row.source,
        row.collaboration_id, row.hold_expires_at, row.activated_at, row.status_reason,
        row.last_reminded_at, row.remind_count, row.created_at, row.updated_at,
      );
    return row;
  }

  getAgreement(id: string): AgreementRow | undefined {
    return this.db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(id) as
      | AgreementRow
      | undefined;
  }

  /** Every agreement in an environment (visibility filtering is the route's job). */
  agreementsOfEnv(envId: string): AgreementRow[] {
    return this.db
      .prepare(
        'SELECT * FROM service_agreements WHERE env_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(envId) as AgreementRow[];
  }

  /**
   * R5-F07: cheap monotone invalidation signal for the arrival-digest day
   * memo — the newest termination stamp in the env. One MAX aggregate over
   * the env's rows (no full-table scan); a newly terminated agreement bumps
   * it, so a frozen digest naturally expires the moment a collaboration
   * completes. Null when the env has no terminated agreements yet.
   */
  latestTerminatedAt(envId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(updated_at) AS latest FROM service_agreements
         WHERE env_id = ? AND status = 'terminated'`,
      )
      .get(envId) as { latest: string | null };
    return row.latest;
  }

  /**
   * T-049: agreements whose PROVIDER is one agent. Pre-v60 these were the
   * rows the FK cascade destroyed when the agent was removed; since v60
   * (R6-E-F08) the removal paths RETIRE + UNLINK them first (see
   * retireProviderAgreements), and this query remains the snapshot source
   * for the remove-agents revert.
   */
  agreementsOfProviderAgent(agentId: string): AgreementRow[] {
    return this.db
      .prepare(
        'SELECT * FROM service_agreements WHERE provider_agent_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(agentId) as AgreementRow[];
  }

  /**
   * T9 (R2, u2-F5/u4-F7): record a remind ON the row — the observable mark
   * that the nudge happened ("已提醒 N 次，最近 <时刻>"). Deliberately does
   * NOT touch updated_at: a reminder is not a lifecycle transition (no
   * state changes, the TLA transition set is untouched); the remind columns
   * are the trace so the consumer can tell "reminded, waiting" from
   * "never reminded".
   */
  markReminded(id: string, at: string): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    const count = existing.remind_count + 1;
    this.db
      .prepare(
        'UPDATE service_agreements SET last_reminded_at = ?, remind_count = ? WHERE id = ?',
      )
      .run(at, count, id);
    return { ...existing, last_reminded_at: at, remind_count: count };
  }

  /**
   * Re-insert a previously snapshotted agreement row with its ORIGINAL id
   * and timestamps (T-049: the revert of a remove-agents proposal restores
   * the FK-destroyed agreements verbatim, so consumers regain their
   * provider — the T-209 restoreService pattern applied to agreements).
   * Note: the append-only usage_records/settlement_receipts of the dead
   * window are NOT resurrected (they cascade too); the restored agreement
   * resumes metering from its restored state.
   */
  restoreAgreement(row: AgreementRow): AgreementRow {
    this.db
      .prepare(
        `INSERT INTO service_agreements
         (id, env_id, service_id, consumer_agent_id, consumer_owner_id,
          provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
          status, source, collaboration_id, hold_expires_at, activated_at, status_reason,
          last_reminded_at, remind_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.service_id, row.consumer_agent_id,
        row.consumer_owner_id, row.provider_agent_id, row.provider_owner_id,
        row.terms_json, row.countered_terms_json ?? null, row.status, row.source,
        row.collaboration_id, row.hold_expires_at ?? null, row.activated_at ?? null,
        row.status_reason ?? null, row.last_reminded_at ?? null, row.remind_count ?? 0,
        row.created_at, row.updated_at,
      );
    return row;
  }

  /**
   * Move an agreement to a new status (updated_at bumps with the transition).
   * `reason` records WHY a platform event moved the row (v60: only
   * 'provider-unavailable'); party-driven routes omit it and any prior
   * reason is cleared — the reason always describes the LATEST transition.
   */
  setStatus(id: string, status: AgreementStatus, reason: string | null = null): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    const updatedAt = new Date().toISOString();
    // R5-F09 (v59): the FIRST activation stamp sticks — later transitions
    // (hold/resume, suspend, terminate) never rewrite or clear it.
    const activatedAt = status === 'active'
      ? (existing.activated_at ?? updatedAt)
      : existing.activated_at;
    this.db
      .prepare('UPDATE service_agreements SET status = ?, activated_at = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, activatedAt, reason, updatedAt, id);
    return { ...existing, status, activated_at: activatedAt, status_reason: reason, updated_at: updatedAt };
  }

  // -------------------------------------------------------------------------
  // v60 (R6-E-F08): provider-agent removal — retire, never destroy
  // -------------------------------------------------------------------------

  /**
   * Retire every agreement a removed provider agent carried, then UNLINK the
   * rows (service_id / provider_agent_id → NULL) so the agent's FK cascades
   * (its own row AND its service rows) have nothing left to match — the
   * ledger, including terminated history and its append-only usage/receipt
   * rows, survives the deletion. The cascade ACTIONS stay in place for every
   * other lane (T-403 derivation sync still relies on them).
   *
   * Non-terminal rows move to their honest end-of-provider state, each an
   * EXISTING lifecycle edge (no state-machine growth, CollabProtocol.tla
   * untouched):
   * - explicit active → suspended (the provider suspend edge; a held row is
   *   settled through the same net effect as resume + suspend);
   * - explicit proposed/countered → rejected (the pending offer can never
   *   be fulfilled — better a truthful rejection than a decidable dead
   *   offer);
   * - ephemeral AC active/held → terminated (born-active, ends terminated —
   *   the provider's death ends the collaboration; the unmetered row reads
   *   'cancelled' per terminatedAgreementOutcome).
   *
   * Terminal rows (rejected/terminated) keep their status — history is not
   * rewritten. NO automatic resume exists anywhere: a re-created/reverted
   * agent never revives a retired agreement (revert only re-links, see
   * relinkProviderAgreement); the parties or the env owner close the row
   * explicitly through the existing terminate channel.
   *
   * Returns the transitions applied (post-state row + from-status) so the
   * caller can notify/broadcast/audit each one.
   */
  retireProviderAgreements(agentId: string): Array<{ row: AgreementRow; from: AgreementStatus }> {
    const rows = this.agreementsOfProviderAgent(agentId);
    const transitions: Array<{ row: AgreementRow; from: AgreementStatus }> = [];
    this.db.transaction(() => {
      for (const row of rows) {
        if (row.status === 'rejected' || row.status === 'terminated') continue;
        const to: AgreementStatus =
          row.source === 'ac'
            ? 'terminated'
            : row.status === 'proposed' || row.status === 'countered'
              ? 'rejected'
              : 'suspended';
        const updatedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE service_agreements
             SET status = ?, hold_expires_at = NULL, status_reason = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(to, PROVIDER_UNAVAILABLE_REASON, updatedAt, row.id);
        transitions.push({
          row: {
            ...row,
            status: to,
            hold_expires_at: null,
            status_reason: PROVIDER_UNAVAILABLE_REASON,
            updated_at: updatedAt,
          },
          from: row.status,
        });
      }
      // Unlink EVERY row of the agent (terminal history included) — the
      // whole point: nothing references the doomed agent/service rows any
      // more, so the cascades delete nothing.
      this.db
        .prepare(
          'UPDATE service_agreements SET service_id = NULL, provider_agent_id = NULL WHERE provider_agent_id = ?',
        )
        .run(agentId);
    })();
    // The returned rows predate the unlink; reflect it so callers serialize
    // the truth.
    return transitions.map(({ row, from }) => ({
      row: { ...row, service_id: null, provider_agent_id: null },
      from,
    }));
  }

  /**
   * R100 (agreement-row-integrity, wang-07): the SERVICE-row counterpart of
   * retireProviderAgreements. Called BEFORE any `service_instances` row is
   * deleted (ServiceStore.deleteService is the single choke point), so the
   * `service_agreements.service_id … ON DELETE CASCADE` never physically
   * swallows an agreement or its usage/receipts ledger again. Same mapping
   * as the v60 provider lane: AC ephemeral → terminated, pending
   * (proposed/countered) → rejected, active/held → suspended — all with
   * status_reason 'service-unavailable'; terminal history untouched. Then
   * EVERY row of the service unlinks (service_id → NULL; provider_agent_id
   * stays — the agent usually survives a service deletion). No automatic
   * resume exists: the parties close the retired row explicitly through the
   * terminate channel (or re-sign on the successor service).
   *
   * Returns the transitions applied (post-state, already-unlinked rows +
   * from-status) so callers can notify/broadcast/audit each one.
   */
  retireServiceAgreements(serviceId: string): Array<{ row: AgreementRow; from: AgreementStatus }> {
    const rows = this.db
      .prepare('SELECT * FROM service_agreements WHERE service_id = ?')
      .all(serviceId) as AgreementRow[];
    const transitions: Array<{ row: AgreementRow; from: AgreementStatus }> = [];
    this.db.transaction(() => {
      for (const row of rows) {
        if (row.status === 'rejected' || row.status === 'terminated') continue;
        const to: AgreementStatus =
          row.source === 'ac'
            ? 'terminated'
            : row.status === 'proposed' || row.status === 'countered'
              ? 'rejected'
              : 'suspended';
        const updatedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE service_agreements
             SET status = ?, hold_expires_at = NULL, status_reason = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(to, SERVICE_UNAVAILABLE_REASON, updatedAt, row.id);
        transitions.push({
          row: {
            ...row,
            status: to,
            hold_expires_at: null,
            status_reason: SERVICE_UNAVAILABLE_REASON,
            updated_at: updatedAt,
          },
          from: row.status,
        });
      }
      // Unlink EVERY row of the service (terminal history included) — the
      // whole point: nothing references the doomed service row any more, so
      // the cascade deletes nothing.
      this.db
        .prepare('UPDATE service_agreements SET service_id = NULL WHERE service_id = ?')
        .run(serviceId);
    })();
    return transitions.map(({ row, from }) => ({
      row: { ...row, service_id: null },
      from,
    }));
  }

  /**
   * remove-agents revert (v60): re-attach a retired agreement to its
   * restored service/provider rows (references only — the STATUS stays
   * suspended/rejected/terminated; there is deliberately no suspended →
   * active edge anywhere in the lifecycle). No-op unless the row is still
   * in its unlinked post-retire shape.
   */
  relinkProviderAgreement(
    id: string,
    refs: { serviceId: string | null; providerAgentId: string },
  ): AgreementRow | undefined {
    const existing = this.getAgreement(id);
    if (!existing) return undefined;
    if (existing.service_id !== null || existing.provider_agent_id !== null) return undefined;
    this.db
      .prepare('UPDATE service_agreements SET service_id = ?, provider_agent_id = ? WHERE id = ?')
      .run(refs.serviceId, refs.providerAgentId, id);
    return { ...existing, service_id: refs.serviceId, provider_agent_id: refs.providerAgentId };
  }

  /**
   * v60: the env's agreements parked by a provider removal (suspended with
   * the provider-unavailable reason) — the arrival digest's
   * providerUnavailableAgreements section (env-owner visibility into "this
   * contract lost its provider; terminate it or leave it parked").
   */
  suspendedProviderUnavailableOfEnv(envId: string): AgreementRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_agreements
         WHERE env_id = ? AND status = 'suspended' AND status_reason = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(envId, PROVIDER_UNAVAILABLE_REASON) as AgreementRow[];
  }

  /**
   * v60: memo-invalidation companion of latestTerminatedAt (the R5-F07
   * pattern) — the newest provider-unavailable stamp in the env, so a fresh
   * retire expires the frozen arrival digest instead of hiding until
   * tomorrow. Null when no row was ever retired here.
   */
  latestProviderUnavailableAt(envId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(updated_at) AS latest FROM service_agreements
         WHERE env_id = ? AND status_reason = ?`,
      )
      .get(envId, PROVIDER_UNAVAILABLE_REASON) as { latest: string | null };
    return row.latest;
  }

  // -------------------------------------------------------------------------
  // R6-E-F08 full failover: the unreachable-provider watchdog (stale — the
  // agent missed heartbeats but was NOT removed; agreement-failover.ts)
  // -------------------------------------------------------------------------

  /**
   * The rows the watchdog evaluates each sweep: EXPLICIT agreements that are
   * active (suspend candidates) or already parked by the watchdog itself
   * (suspended + provider-unreachable — recovery candidates). Boundaries:
   * AC ephemeral rows are out of scope (their collaboration lifecycle closes
   * them and the stale hard gate already blocks new consumption); retired
   * rows (provider-unavailable, unlinked) never recover by construction and
   * are excluded here too.
   */
  failoverWatchRows(): AgreementRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_agreements
         WHERE source = 'explicit' AND provider_agent_id IS NOT NULL AND service_id IS NOT NULL
           AND (status = 'active'
                OR (status = 'suspended' AND status_reason = ?))
         ORDER BY env_id ASC, id ASC`,
      )
      .all(PROVIDER_UNREACHABLE_REASON) as AgreementRow[];
  }

  /**
   * Recovery half of the watchdog: the provider heartbeats again, so the
   * parked agreement closes as terminated (reason 'provider-recovered') and
   * a SUCCESSOR agreement is born active on identical terms/parties —
   * "re-activation = terminate + re-sign"; the lifecycle's transition set
   * stays untouched (deliberately NO suspended → active edge, TLA 零扩张).
   * One transaction: the pair lands or nothing does. Quota/usage history
   * stays on the old row — the successor starts a clean ledger.
   */
  resignRecoveredAgreement(old: AgreementRow): { terminated: AgreementRow; successor: AgreementRow } {
    let terminated: AgreementRow | undefined;
    let successor: AgreementRow | undefined;
    this.db.transaction(() => {
      terminated = this.setStatus(old.id, 'terminated', PROVIDER_RECOVERED_REASON);
      successor = this.createAgreement({
        envId: old.env_id,
        serviceId: old.service_id as string,
        consumerAgentId: old.consumer_agent_id,
        consumerOwnerId: old.consumer_owner_id,
        providerAgentId: old.provider_agent_id as string,
        providerOwnerId: old.provider_owner_id,
        terms: JSON.parse(old.terms_json) as AgreementTerms,
        source: old.source,
        status: 'active',
        ...(old.collaboration_id !== null ? { collaborationId: old.collaboration_id } : {}),
      });
    })();
    // The transaction ran to completion or threw — both are always set here.
    return { terminated: terminated as AgreementRow, successor: successor as AgreementRow };
  }

  /**
   * R6-E-F08 full failover: the env's parked provider-trouble queue — both
   * removal retirements (provider-unavailable, never recover) and watchdog
   * suspensions (provider-unreachable, may recover). The arrival digest's
   * providerUnavailableAgreements section reads this superset; the `reason`
   * column on each entry keeps the two failure modes distinguishable.
   */
  suspendedProviderTroubleOfEnv(envId: string): AgreementRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_agreements
         WHERE env_id = ? AND status = 'suspended' AND status_reason IN (?, ?)
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(envId, PROVIDER_UNAVAILABLE_REASON, PROVIDER_UNREACHABLE_REASON) as AgreementRow[];
  }

  /**
   * Memo-invalidation companion of suspendedProviderTroubleOfEnv: the newest
   * provider-trouble stamp (either reason) in the env, so a fresh retire OR
   * watchdog suspension expires the frozen arrival digest.
   */
  latestProviderTroubleAt(envId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(updated_at) AS latest FROM service_agreements
         WHERE env_id = ? AND status_reason IN (?, ?)`,
      )
      .get(envId, PROVIDER_UNAVAILABLE_REASON, PROVIDER_UNREACHABLE_REASON) as { latest: string | null };
    return row.latest;
  }

  // -------------------------------------------------------------------------
  // D3 (DevLoop R28, T-080): the consumer hold — bounded consumption pause
  // -------------------------------------------------------------------------

  /** The wall-clock hold ceiling (design ruling: durationSec max 3600). */
  static readonly HOLD_MAX_SEC = 3600;

  /**
   * Consumer holds an ACTIVE agreement: status 'held' + the wall-clock
   * expiry. Auto-trigger execution and manual invokes suspend for THIS
   * agreement only; quota never burns (nothing executes). Route enforces
   * the consumer right, the active precondition, and the 1..3600s bound.
   */
  hold(id: string, expiresAt: string): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE service_agreements SET status = ?, hold_expires_at = ?, updated_at = ? WHERE id = ?',
      )
      .run('held', expiresAt, updatedAt, id);
    return { ...existing, status: 'held', hold_expires_at: expiresAt, updated_at: updatedAt };
  }

  /** Consumer resumes a HELD agreement (DELETE /hold): back to active. */
  resume(id: string): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    const updatedAt = new Date().toISOString();
    // A hold requires a prior active state, so activated_at is normally set
    // already; the ?? keeps the guard total (v59).
    const activatedAt = existing.activated_at ?? updatedAt;
    this.db
      .prepare(
        'UPDATE service_agreements SET status = ?, hold_expires_at = NULL, activated_at = ?, updated_at = ? WHERE id = ?',
      )
      .run('active', activatedAt, updatedAt, id);
    return { ...existing, status: 'active', hold_expires_at: null, activated_at: activatedAt, updated_at: updatedAt };
  }

  /**
   * D3 lazy expiry (the standing-asks pattern — no resident sweeper, stale
   * data is never returned): if the row is held and its deadline passed,
   * flip it back to 'active' NOW. Returns the settled row (identity when
   * nothing was due). Called at every agreement read boundary and at trigger
   * evaluation, so an expired hold never blocks consumption a moment longer
   * than the first read after the deadline.
   */
  settleExpiredHold(row: AgreementRow): AgreementRow {
    if (row.status !== 'held' || row.hold_expires_at === null) return row;
    const expiresMs = Date.parse(row.hold_expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs > Date.now()) return row;
    return this.resume(row.id);
  }

  /**
   * T-059 (design-consent-semantics.md §5.1): the provider's counter-offer —
   * stores the FULL countered terms (not a diff) beside the untouched
   * original and moves the agreement to 'countered'; the decide right passes
   * to the consumer. Terms validation happens at the route (the same closed
   * schema as propose); the store only persists.
   */
  counter(id: string, terms: AgreementTerms): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    const updatedAt = new Date().toISOString();
    const counteredJson = JSON.stringify(terms);
    this.db
      .prepare(
        'UPDATE service_agreements SET status = ?, countered_terms_json = ?, updated_at = ? WHERE id = ?',
      )
      .run('countered', counteredJson, updatedAt, id);
    return { ...existing, status: 'countered', countered_terms_json: counteredJson, updated_at: updatedAt };
  }

  /**
   * T-059: the consumer accepts the counter-offer — the countered terms
   * BECOME the contract (copied into terms_json so every enforcement path
   * — invoke, reads, stream — reads one column), the agreement lands
   * active. countered_terms_json stays for audit.
   *
   * T24 (R3): an optional decision reason rides the accept — same R102
   * channel as setStatus (statusReason describes the LATEST transition;
   * party acts without a reason keep it NULL).
   */
  acceptCounter(id: string, reason: string | null = null): AgreementRow {
    const existing = this.getAgreement(id);
    if (!existing) {
      throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
    }
    if (existing.countered_terms_json === null) {
      throw new ApiError(409, 'AGREEMENT_NOT_COUNTERED', `Agreement "${id}" has no counter-offer to accept`);
    }
    const updatedAt = new Date().toISOString();
    // v59: accepting a counter IS the (first) activation for a never-active
    // agreement; an already-stamped row keeps its original stamp.
    const activatedAt = existing.activated_at ?? updatedAt;
    this.db
      .prepare(
        'UPDATE service_agreements SET status = ?, terms_json = countered_terms_json, activated_at = ?, status_reason = ?, updated_at = ? WHERE id = ?',
      )
      .run('active', activatedAt, reason, updatedAt, id);
    return {
      ...existing,
      status: 'active',
      terms_json: existing.countered_terms_json,
      activated_at: activatedAt,
      status_reason: reason,
      updated_at: updatedAt,
    };
  }

  /**
   * Active ephemeral agreements of one AC collaboration (Fix-11 Phase 2) —
   * the rows the AC bridge closes when the collaboration ends.
   */
  activeAgreementsOfCollaboration(collaborationId: string): AgreementRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_agreements
         WHERE collaboration_id = ? AND status = 'active'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(collaborationId) as AgreementRow[];
  }

  /** Fix-16 provider todo: proposed agreements waiting for the user's decide. */
  /**
   * T120 (R19-u2): the workbench "待处理合约" bell — agreements WAITING ON
   * THIS USER's decision, wherever the ball currently sits: `proposed` waits
   * on the PROVIDER, `countered` waits on the CONSUMER (T-059 decide-right
   * follows the counter). Before this the bell only counted the proposed leg
   * — a consumer holding a counter-offer saw todo=0 while the inbox said
   * "your move".
   */
  countAgreementsAwaitingDecision(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM service_agreements
         WHERE (provider_owner_id = ? AND status = 'proposed')
            OR (consumer_owner_id = ? AND status = 'countered')`,
      )
      .get(userId, userId) as { n: number };
    return row.n;
  }

  /**
   * R77-F5 residual: proposed agreements created before `olderThanIso` and
   * still undecided — the stale-proposal sweep's candidate set (aggregated
   * into one provider reminder per env by agreement-stale.ts).
   */
  staleProposedAgreements(olderThanIso: string): AgreementRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_agreements
         WHERE status = 'proposed' AND created_at < ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(olderThanIso) as AgreementRow[];
  }

  /**
   * T-060 (§6.2, D-4 default = offered): the env-level aggregate
   * transparency signal — how many agreements are currently active in this
   * environment. Non-attributed by construction (no parties, no services,
   * no actions): the market-temperature crumb bilateralization took away,
   * returned without re-publicizing anyone's transactions.
   */
  countActiveOfEnv(envId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM service_agreements WHERE env_id = ? AND status = 'active'",
      )
      .get(envId) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Usage records — APPEND-ONLY (no update/delete methods by design, §3.3)
  // -------------------------------------------------------------------------

  appendUsage(input: AppendUsageInput): UsageRecordRow {
    const row: UsageRecordRow = {
      id: randomUUID(),
      agreement_id: input.agreementId,
      env_id: input.envId,
      consumer_agent_id: input.consumerAgentId,
      provider_agent_id: input.providerAgentId,
      kind: input.kind,
      action: input.action ?? null,
      quantity: input.quantity,
      unit: input.unit,
      outcome: input.outcome,
      effect_ref: input.effectRef ?? null,
      failure_reason: input.outcome !== 'failure' ? null : (input.failureReason ?? null),
      origin: input.origin ?? null,
      simulation_id: input.simulationId ?? null,
      source: input.source ?? null,
      started_at: input.startedAt,
      ended_at: input.endedAt,
    };
    this.db
      .prepare(
        `INSERT INTO usage_records
         (id, agreement_id, env_id, consumer_agent_id, provider_agent_id,
          kind, action, quantity, unit, outcome, effect_ref, failure_reason, origin, simulation_id, source, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agreement_id, row.env_id, row.consumer_agent_id,
        row.provider_agent_id, row.kind, row.action, row.quantity, row.unit,
        row.outcome, row.effect_ref, row.failure_reason, row.origin,
        row.simulation_id, row.source, row.started_at, row.ended_at,
      );
    return row;
  }

  /** Every usage record in an environment (Fix-22 training export). */
  usageOfEnv(envId: string): UsageRecordRow[] {
    return this.db
      .prepare(
        'SELECT * FROM usage_records WHERE env_id = ? ORDER BY started_at ASC, id ASC',
      )
      .all(envId) as UsageRecordRow[];
  }

  usageOf(agreementId: string): UsageRecordRow[] {
    return this.db
      .prepare(
        'SELECT * FROM usage_records WHERE agreement_id = ? ORDER BY started_at ASC, id ASC',
      )
      .all(agreementId) as UsageRecordRow[];
  }

  /**
   * R101 (trust-visibility ②): a service's verifiable履约摘要 — aggregated
   * metered usage since `sinceIso`, joined over the agreements CURRENTLY
   * linked to the service row (rows retired by service loss are unlinked
   * and fall out — the summary describes the live offer). Aggregate only:
   * no party identities, safe for the stranger-facing market surface.
   */
  usageSummaryForService(serviceId: string, sinceIso: string): ServiceUsageSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS invocations,
                COALESCE(SUM(CASE WHEN u.outcome = 'success' THEN 1 ELSE 0 END), 0) AS succeeded,
                COALESCE(SUM(CASE WHEN u.outcome = 'failure' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN u.outcome = 'partial' THEN 1 ELSE 0 END), 0) AS partial
         FROM usage_records u JOIN service_agreements a ON u.agreement_id = a.id
         WHERE a.service_id = ? AND u.started_at >= ?`,
      )
      .get(serviceId, sinceIso) as ServiceUsageSummary;
    return row;
  }

  /** R101: the same summary for EVERY service of an env (one grouped query for the list lane). */
  usageSummariesForEnv(envId: string, sinceIso: string): Map<string, ServiceUsageSummary> {
    const rows = this.db
      .prepare(
        `SELECT a.service_id AS serviceId,
                COUNT(*) AS invocations,
                COALESCE(SUM(CASE WHEN u.outcome = 'success' THEN 1 ELSE 0 END), 0) AS succeeded,
                COALESCE(SUM(CASE WHEN u.outcome = 'failure' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN u.outcome = 'partial' THEN 1 ELSE 0 END), 0) AS partial
         FROM usage_records u JOIN service_agreements a ON u.agreement_id = a.id
         WHERE a.env_id = ? AND a.service_id IS NOT NULL AND u.started_at >= ?
         GROUP BY a.service_id`,
      )
      .all(envId, sinceIso) as Array<ServiceUsageSummary & { serviceId: string }>;
    return new Map(rows.map(({ serviceId, ...summary }) => [serviceId, summary]));
  }

  /**
   * Fix-20 quota enforcement (service-consumption-design.md §6 Phase 2):
   * consumption acts of one agreement since `sinceIso` (sliding window) —
   * the count `quotaPerWindow`/`windowSec` terms are checked against.
   *
   * T-205: counts only outcome='success' rows — the quota budget is
   * DELIVERED consumption acts. Every invoke is still metered (audit
   * completeness, see appendUsage callers), but probes and device-rejected
   * attempts can neither burn quota nor hide from the audit trail.
   *
   * T-307 (DevLoop R12, EN-F17): the budget counts rows of ONE kind —
   * `kind` parameterizes it (invoke path passes 'invoke', the read lane
   * passes 'read'; a zero-message stream session is passive observation
   * and must starve neither budget). Single function, no copies — the
   * T-307 lesson generalized by the R14 data-services design (§5.3).
   */
  countUsageSince(agreementId: string, sinceIso: string, kind: UsageKind = 'invoke'): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM usage_records ' +
        "WHERE agreement_id = ? AND started_at >= ? AND outcome = 'success' AND kind = ?",
      )
      .get(agreementId, sinceIso, kind) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Settlement receipts — append-only provider output (§3.4)
  // -------------------------------------------------------------------------

  appendReceipt(input: {
    agreementId: string;
    envId: string;
    provider: string;
    status: 'recorded';
    usageRecordIds: string[];
    quote: unknown | null;
  }): SettlementReceiptRow {
    const row: SettlementReceiptRow = {
      id: randomUUID(),
      agreement_id: input.agreementId,
      env_id: input.envId,
      provider: input.provider,
      status: input.status,
      usage_record_ids_json: JSON.stringify(input.usageRecordIds),
      quote_json: input.quote === null ? null : JSON.stringify(input.quote),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO settlement_receipts
         (id, agreement_id, env_id, provider, status, usage_record_ids_json, quote_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agreement_id, row.env_id, row.provider, row.status,
        row.usage_record_ids_json, row.quote_json, row.created_at,
      );
    return row;
  }

  receiptsOf(agreementId: string): SettlementReceiptRow[] {
    return this.db
      .prepare(
        'SELECT * FROM settlement_receipts WHERE agreement_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(agreementId) as SettlementReceiptRow[];
  }
}

/** Parse a stored terms blob (never throws — '{}' on corruption). */
export function parseTerms(termsJson: string): AgreementTerms {
  try {
    const parsed = JSON.parse(termsJson) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as AgreementTerms;
    }
  } catch {
    // fall through to empty terms
  }
  return {};
}
