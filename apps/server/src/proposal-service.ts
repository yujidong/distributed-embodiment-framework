/**
 * Proposal service — the P-A governance pipeline
 * (multi-user-simulation-design.md §4)
 *
 * Drives the proposal state machine:
 *
 * ```
 * submitted → rule_check → ai_review → approved → applied → reverted
 *               │            │                     ↑
 *               ▼            ▼                     │
 *            rejected     escalated ──(owner)──────┘
 * ```
 *
 * - `submit` persists the proposal, runs the deterministic rule check
 *   (proposal-rules.ts), then the AI reviewer (proposal-reviewer.ts). A
 *   low-risk proposal whose entire zone footprint is stewarded by its author
 *   (zone_claims, §5.3) SKIPS AI review and auto-approves. Rule-check
 *   failures land as `rejected` with the full issue list; high-risk markers
 *   force `escalated` regardless of the reviewer.
 * - `decide` is the owner's verdict on an escalated proposal; approving
 *   applies the change to the world.
 * - `apply` writes the world (device instances, map-data events, zone-claim
 *   grants), records the change in `command_log` as `{before, after,
 *   decidedBy}`, and broadcasts via WorldSync. Attribution (Fix-1): the log
 *   entry's actor is always the proposal AUTHOR — the user whose change the
 *   world absorbed — while `decidedBy` names the human approver (null when
 *   the pipeline auto-approved). The rule check RE-RUNS at apply time so a
 *   proposal approved against a stale world never applies over a conflicting
 *   one.
 * - `revert` inverts the apply entry: devices it created are deleted, events
 *   it appended are removed from map data, zone-claim grants are revoked.
 *
 * Every user-visible status change is broadcast on the environment stream as
 * `{kind:'proposal', action, proposalId, actor}` (Fix-4 governance events):
 * `submitted` on creation, then `escalated` / `approved` / `rejected` /
 * `applied` / `reverted` as the pipeline moves. The internal funnel steps
 * (rule_check / ai_review) are not announced.
 *
 * `modify-object` runs through the same pipeline with a REAL apply (Fix-7):
 * the rule check validates the patch field-by-field (same semantics as the
 * owner-only PATCH routes) and the apply writes it via the store, recording
 * before/after so revert restores the prior state. Unsupported targets or
 * patch fields are rule-check rejections — never applied-but-noop.
 *
 * Fix-7 adds two more kinds with real world effects:
 * - `install-agents` — creates agent instances (owner = author) and runs the
 *   derivation sync so their device-derived services appear; revert removes
 *   the agents (services cascade).
 * - `remove-devices` — deletes the author's own unbound devices (bound ones
 *   are rule-check rejections); revert restores the exact rows it deleted.
 */

import type { AuthUser } from './auth/index.js';
import type { ChangePipeline } from './change-pipeline.js';
import { ApiError } from './errors.js';
import { agentToJson, deviceToJson, ownerRef, zonesOf } from './env-serializers.js';
import { t } from './i18n/index.js';
import type { UiLocale } from '@active-collaboration/shared';
import type { CatalogStore } from './db/catalog-store.js';
import {
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvironmentStore,
  type EnvMapData,
  type EnvMapEvent,
} from './db/environment-store.js';
import type { AgreementRow } from './db/agreement-store.js';
import type { ServiceInstanceRow } from './db/service-store.js';
import type { CommandLogStore, ProposalRow, ProposalStore } from './db/proposal-store.js';
import type { NotificationStore } from './db/notification-store.js';
import {
  NOTIFICATION_KINDS,
  notify,
  proposalObjectSummary,
} from './notifications.js';
import type { ReputationStore } from './db/reputation-store.js';
import type { DerivedSyncChange, ServiceStore } from './db/service-store.js';
import { toPublicUser, type UserStore } from './db/user-store.js';
import type { ZoneClaimStore } from './db/zone-claim-store.js';
import { checkProposalRules, proposalZoneIds, type RuleCheckResult } from './proposal-rules.js';
import {
  EscalatingReviewer,
  type ProposalReviewer,
  type ReviewVerdict,
} from './proposal-reviewer.js';
import type { QuotaConfig } from './quotas.js';
import type { HumanReviewThresholds } from './proposal-human-review-policy.js';
import { publishServiceChanges, syncDerivedForAgentWithNotices, syncDerivedForDeviceWithNotices } from './service-derivation-sync.js';
import type { StandingAskMatchDeps } from './standing-asks.js';
import type { ProposalStreamAction } from './world-sync.js';

/**
 * Proposal statuses that stream subscribers care about (Fix-4), mapped to
 * the broadcast action. The internal funnel steps (rule_check / ai_review)
 * are not broadcast; creation is announced as 'submitted'.
 */
const STREAM_ACTION_BY_STATUS: Partial<Record<ProposalRow['status'], ProposalStreamAction>> = {
  submitted: 'submitted',
  escalated: 'escalated',
  approved: 'approved',
  rejected: 'rejected',
  applied: 'applied',
  reverted: 'reverted',
};

export interface ProposalServiceDeps {
  envStore: EnvironmentStore;
  catalogStore: CatalogStore;
  proposalStore: ProposalStore;
  commandLogStore: CommandLogStore;
  userStore: UserStore;
  /** Fix-7: derivation sync for governed agent installs / device removals. */
  serviceStore: ServiceStore;
  /** Fix-7: reputation view carried on broadcast service messages. */
  reputationStore: ReputationStore;
  /** Fix-1: unified change recording (command_log + actor-carrying broadcast). */
  pipeline: ChangePipeline;
  quotas: QuotaConfig;
  /**
   * S1 (Task 3): deployment-level human-review breadth thresholds
   * (PROPOSAL_HUMAN_REVIEW_* env vars). A per-env owner override
   * (mapData.governance.humanReview) wins field by field inside the rule
   * check. Absent = all classes disarmed.
   */
  humanReviewThresholds?: HumanReviewThresholds;
  /** P-B §5.3: zone stewardship grants, consulted for zone autonomy. */
  zoneClaimStore: ZoneClaimStore;
  /**
   * T-072 (D-1 decide half): env decision delegations — an escalated
   * zone-claim also notifies the active delegate, and a delegate-decided
   * apply reaches the owner. Duck-typed for minimal test deps (absent =
   * no delegations; every consultation fails closed).
   */
  delegationStore?: {
    getActive(envId: string, scope: 'zone-claims'): { delegate_id: string } | undefined;
  };
  /** P-B: a real LLM reviewer. Defaults to escalate-everything (P-A). */
  reviewer?: ProposalReviewer;
  /** Fix-16: the persistent doorbell for verdicts + escalations. */
  notificationStore: NotificationStore;
  /**
   * T-209: flow lookup for remove-agents cascade warnings (flows whose plan
   * references a removed agent). Duck-typed — absent in minimal test deps,
   * the warnings degrade instead of blocking. P2F §11 adds the create/delete
   * surface adopt-config's apply/revert needs (a promoted flow-definition
   * lands as a flow row; its revert removes it).
   */
  flowStore?: {
    listByEnvironment(envId: string): Array<{
      id: string; name: string; plan_json: string; trigger_json: string; created_by: string | null;
    }>;
    create?(input: {
      environmentId: string;
      name: string;
      description?: string;
      enabled?: boolean;
      trigger: import('@active-collaboration/core').FlowTrigger;
      plan: import('@active-collaboration/core').FlowDefinition['plan'];
      inputs?: import('@active-collaboration/core').FlowInputSpec[];
      policy?: Record<string, unknown>;
      agentInvocable?: boolean;
      createdBy?: string | null;
    }): { id: string; name: string };
    delete?(id: string): void;
  };
  /**
   * T-049 + v60 (R6-E-F08): agreement handling for remove-agents — apply
   * RETIRES the provider's agreements (suspended/rejected/terminated with
   * status_reason 'provider-unavailable', then unlinked so the FK cascade
   * destroys nothing) and notifies their consumer owners; revert re-links
   * the rows to the restored service/agent (status stays retired — there is
   * no suspended → active edge). Duck-typed — absent in minimal test deps,
   * the handling degrades to the pre-T-049 cascade instead of blocking.
   */
  agreementStore?: {
    agreementsOfProviderAgent(agentId: string): AgreementRow[];
    getAgreement(id: string): AgreementRow | undefined;
    restoreAgreement(row: AgreementRow): AgreementRow;
    retireProviderAgreements?(
      agentId: string,
    ): Array<{ row: AgreementRow; from: AgreementRow['status'] }>;
    relinkProviderAgreement?(
      id: string,
      refs: { serviceId: string | null; providerAgentId: string },
    ): AgreementRow | undefined;
  };
  /**
   * P2F §11 (adopt-config): sourceFork lineage verification — the fork row
   * must exist and belong to this env at submit time (the promotion itself
   * never needs the fork alive, §11.1). Duck-typed.
   */
  sandboxStore?: {
    get(forkId: string): Pick<
      import('./db/sandbox-store.js').SandboxRow,
      'id' | 'env_id' | 'created_at' | 'fork_base_json' | 'owner_id' | 'status'
    > | undefined;
  };
  /** P2F §11.2: evidence (eval-run) validation. Duck-typed. */
  evalRunStore?: {
    get(id: string): { env_id: string; status: string } | undefined;
  };
  /**
   * T-069 (R23): standing-ask matching on derivation-sync CREATED
   * services (需求板). Duck-typed — absent in minimal deps, matching is
   * skipped (the publish itself is unaffected).
   */
  standingAsks?: StandingAskMatchDeps;
}

export class ProposalService {
  private readonly reviewer: ProposalReviewer;
  /**
   * R33 (DevLoop, Smart F1): per-env submission pipeline serialization.
   * submit() is async (the reviewer await splits the rule check from the
   * apply across ticks), so two sequential builder submissions used to
   * interleave: install-agents was rule-checked BEFORE the install-devices
   * ahead of it applied → "boundDeviceIds references unknown device" → the
   * agent proposal was REJECTED and had to be resubmitted by hand. The
   * promise chain runs each env's full pipeline (check → review → apply)
   * to completion in submission order — sequential proposals now see each
   * other's effects. Owner decide() needs no chain: its apply re-runs the
   * rule check and its writes are synchronous (single event-loop tick).
   */
  private readonly pipelines = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ProposalServiceDeps) {
    this.reviewer = deps.reviewer ?? new EscalatingReviewer();
  }

  /** Enqueue `run` on the env's serialized pipeline; submissions stay ordered. */
  private enqueue<T>(envId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.pipelines.get(envId) ?? Promise.resolve();
    const tail = prev.then(run, run); // run even when the predecessor failed
    const quiet = tail.then(() => undefined, () => undefined);
    this.pipelines.set(envId, quiet);
    void quiet.then(() => {
      if (this.pipelines.get(envId) === quiet) this.pipelines.delete(envId);
    });
    return tail;
  }

  /**
   * Submit a proposal and run it through rule check + AI review. The
   * terminal status it lands in (rejected / escalated / applied) is on the
   * returned row — submission itself always succeeds when the input is
   * well-formed. R33 (Smart F1): the whole pipeline is serialized per env,
   * so a proposal submitted after another one lands against the world the
   * earlier one already wrote (sequential installs chain without the
   * resubmit dance).
   */
  async submit(
    env: EnvironmentRow,
    author: AuthUser,
    kind: ProposalRow['kind'],
    payload: Record<string, unknown>,
    locale: UiLocale = 'zh-CN',
  ): Promise<ProposalRow> {
    return this.enqueue(env.id, () => this.submitNow(env, author, kind, payload, locale));
  }

  private async submitNow(
    env: EnvironmentRow,
    author: AuthUser,
    kind: ProposalRow['kind'],
    payload: Record<string, unknown>,
    locale: UiLocale = 'zh-CN',
  ): Promise<ProposalRow> {
    const { proposalStore } = this.deps;
    const check = checkProposalRules(this.ruleContext(), env, kind, payload, author.id);
    const created = proposalStore.create({
      envId: env.id,
      authorId: author.id,
      kind,
      payload,
      status: 'rule_check',
      expiresAt: check.expiresAt,
    });
    // Fix-4: governance events on the environment stream — the owner learns
    // there is a proposal at all; the author watches its verdict live.
    this.deps.pipeline.publishProposal(env.id, 'submitted', created.id, author.id);

    if (!check.ok) {
      return this.transition(created.id, {
        status: 'rejected',
        riskLevel: check.riskLevel,
        ruleCheck: check,
        decidedAt: new Date().toISOString(),
      }, author.id, locale);
    }
    this.transition(created.id, {
      status: 'ai_review',
      riskLevel: check.riskLevel,
      ruleCheck: check,
    }, author.id, locale);

    // High-risk markers (hass:// bindings, oversized batches) never reach
    // the AI verdict — they go straight to the owner (§5.2). T-058a
    // exception: a SUPERVISED-ZONE consent gate (escalateWithAiAdvisory)
    // still runs the reviewer as ADVISOR — its verdict is recorded on
    // aiReview for the deciding owner, but it can neither auto-apply nor
    // veto: "AI 语义审查无法替代机构同意" (design-consent-semantics.md §1)
    // becomes mechanism — the reason validates "reasonable", only the owner
    // validates "permitted".
    if (check.forceEscalate) {
      if (check.escalateWithAiAdvisory !== true) {
        return this.transition(created.id, { status: 'escalated' }, author.id, locale);
      }
      const advisory = await this.reviewer.review({
        envId: env.id,
        author,
        kind,
        payload,
        riskLevel: check.riskLevel,
        locale,
      });
      return this.transition(
        created.id,
        { status: 'escalated', aiReview: advisory },
        author.id,
        locale,
      );
    }

    // Zone autonomy (§5.3): a steward's LOW-risk proposal that lies fully
    // inside zones they hold a claim on skips AI review entirely and
    // auto-approves. Cross-zone or non-low-risk proposals run the full
    // funnel below.
    if (check.riskLevel === 'low' && this.coversByZoneClaims(env.id, author.id, kind, check)) {
      this.transition(created.id, {
        status: 'approved',
        aiReview: {
          outcome: 'allow',
          // T-063(e): code-authored governance note, localized at submit time.
          reason: t(locale, 'chrome.governance.zoneClaimAutonomy'),
          source: 'zone-claim',
        } satisfies ReviewVerdict,
        decidedAt: new Date().toISOString(),
      }, author.id, locale);
      return this.apply(created.id, null, author.id, locale);
    }

    const verdict = await this.reviewer.review({
      envId: env.id,
      author,
      kind,
      payload,
      riskLevel: check.riskLevel,
      locale,
    });
    if (verdict.outcome === 'reject') {
      return this.transition(created.id, {
        status: 'rejected',
        aiReview: verdict,
        decidedAt: new Date().toISOString(),
      }, author.id, locale);
    }
    if (verdict.outcome === 'escalate') {
      return this.transition(created.id, { status: 'escalated', aiReview: verdict }, author.id, locale);
    }
    this.transition(created.id, {
      status: 'approved',
      aiReview: verdict,
      decidedAt: new Date().toISOString(),
    }, author.id, locale);
    return this.apply(created.id, null, author.id);
  }

  /**
   * Owner (or, since T-072, the delegated zone-claims member) verdict on an
   * escalated proposal. Approving applies the change; the verdict is
   * recorded as a human review result whose source names WHO decided —
   * 'owner' vs 'delegate' — so surfaces and audit can tell them apart.
   */
  async decide(
    proposal: ProposalRow,
    reviewer: AuthUser,
    decision: 'approved' | 'rejected',
    reason?: string,
    locale: UiLocale = 'zh-CN',
    decidedVia: 'owner' | 'delegate' = 'owner',
  ): Promise<ProposalRow> {
    if (proposal.status !== 'escalated') {
      throw new ApiError(
        409,
        'PROPOSAL_NOT_DECIDABLE',
        `Proposal "${proposal.id}" is "${proposal.status}" — only escalated proposals can be decided`,
      );
    }
    const verdict: ReviewVerdict = {
      outcome: decision === 'approved' ? 'allow' : 'reject',
      reason:
        reason ??
        (decision === 'approved'
          ? decidedVia === 'delegate'
            ? 'Approved by the delegated zone-claims decider'
            : 'Approved by the environment owner'
          : decidedVia === 'delegate'
            ? 'Rejected by the delegated zone-claims decider'
            : 'Rejected by the environment owner'),
      source: decidedVia === 'delegate' ? 'delegate' : 'owner',
    };
    const now = new Date().toISOString();
    if (decision === 'rejected') {
      return this.transition(proposal.id, {
        status: 'rejected',
        aiReview: verdict,
        reviewerId: reviewer.id,
        decidedAt: now,
      }, reviewer.id, locale);
    }
    this.transition(proposal.id, {
      status: 'approved',
      aiReview: verdict,
      reviewerId: reviewer.id,
      decidedAt: now,
    }, reviewer.id, locale);
    return this.apply(proposal.id, reviewer.id, reviewer.id, locale, decidedVia);
  }

  /**
   * Apply an approved proposal: write the world, log the change, broadcast.
   * The rule check re-runs first — if the world moved on and the proposal
   * no longer passes, it is rejected instead of applied.
   *
   * Attribution (Fix-1): the command_log actor is the proposal AUTHOR (the
   * change is theirs); `decidedBy` records who approved it — the owner on a
   * decide() call, null on auto-approval (zone-claim autonomy / reviewer
   * allow). T-072 adds `decidedVia`: 'owner' vs 'delegate', so the audit
   * trail distinguishes an owner-decided apply from a delegate-decided one
   * without resolving user ids against the env.
   */
  private async apply(
    proposalId: string,
    decidedBy: string | null,
    actorId: string,
    locale: UiLocale = 'zh-CN',
    decidedVia: 'owner' | 'delegate' = 'owner',
  ): Promise<ProposalRow> {
    const { envStore, proposalStore } = this.deps;
    const proposal = this.getOrThrow(proposalId);
    if (proposal.status !== 'approved') {
      throw new ApiError(
        409,
        'PROPOSAL_NOT_APPLICABLE',
        `Proposal "${proposalId}" is "${proposal.status}" — only approved proposals can be applied`,
      );
    }
    const env = envStore.getEnvironment(proposal.env_id);
    if (!env) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${proposal.env_id}" not found`);
    }
    const payload = JSON.parse(proposal.payload_json) as Record<string, unknown>;

    const check = checkProposalRules(this.ruleContext(), env, proposal.kind, payload, proposal.author_id);
    if (!check.ok) {
      return this.transition(proposal.id, {
        status: 'rejected',
        ruleCheck: check,
        decidedAt: new Date().toISOString(),
      }, actorId);
    }

    let after: unknown;
    const broadcasts: (() => void)[] = [];
    proposalStore.transaction(() => {
      switch (proposal.kind) {
        case 'install-devices':
          after = this.installDevices(env, proposal, check, broadcasts);
          break;
        case 'install-agents':
          after = this.installAgents(env, proposal, check, broadcasts);
          break;
        case 'install-zones':
          after = this.installZones(env, proposal, check, broadcasts);
          break;
        case 'remove-devices':
          after = this.removeDevices(env, proposal, check, broadcasts);
          break;
        case 'remove-agents':
          after = this.removeAgents(env, proposal, check, broadcasts, locale);
          break;
        case 'inject-scenario':
          after = {
            ...this.installDevices(env, proposal, check, broadcasts),
            ...this.injectEvents(env, proposal, check, broadcasts),
          };
          break;
        case 'modify-object':
          after = this.modifyObject(env, proposal, check, broadcasts);
          break;
        case 'zone-claim':
          after = this.grantZoneClaim(env, proposal, decidedBy ?? proposal.author_id);
          break;
        case 'adopt-config':
          after = this.adoptConfig(env, proposal, check, broadcasts);
          break;
        // C3 (R42-B): governance-plane ownership handover — no world-session
        // wake (ownership is not a world mutation; the sim topology and
        // every derived service stay untouched).
        case 'ownership-transfer':
          after = this.applyOwnershipTransfer(env, proposal, check, broadcasts);
          break;
      }
      this.deps.pipeline.log({
        envId: env.id,
        actorId: proposal.author_id,
        proposalId: proposal.id,
        kind: proposal.kind,
        payload: { before: null, after, decidedBy, decidedVia },
      });
    });
    for (const broadcast of broadcasts) broadcast();

    return this.transition(proposal.id, {
      status: 'applied',
      appliedAt: new Date().toISOString(),
    }, actorId);
  }

  /**
   * Revert an applied proposal by inverting its apply entry (§4.3): devices
   * it created are deleted, agents it created are deleted (their services
   * cascade), devices it removed are restored from the apply snapshot, a
   * modify-object patch is rolled back to its before-state, events it
   * appended are removed from map data, zone-claim grants are revoked.
   * Missing objects (deleted meanwhile) are tolerated.
   */
  async revert(proposal: ProposalRow, actor: AuthUser, locale: UiLocale = 'zh-CN'): Promise<ProposalRow> {
    const { envStore, proposalStore, commandLogStore } = this.deps;
    if (proposal.status !== 'applied') {
      throw new ApiError(
        409,
        'PROPOSAL_NOT_APPLIED',
        `Proposal "${proposal.id}" is "${proposal.status}" — only applied proposals can be reverted`,
      );
    }
    const env = envStore.getEnvironment(proposal.env_id);
    if (!env) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${proposal.env_id}" not found`);
    }
    const applyEntry = commandLogStore.findApplyEntry(proposal.id, proposal.kind);
    if (!applyEntry) {
      throw new ApiError(
        409,
        'PROPOSAL_NOT_REVERTIBLE',
        `Proposal "${proposal.id}" has no apply entry in the command log`,
      );
    }
    const after = (JSON.parse(applyEntry.payload_json) as { after?: unknown }).after;

    const broadcasts: (() => void)[] = [];
    proposalStore.transaction(() => {
      const applied = (after ?? {}) as {
        devices?: { id: string }[];
        agents?: { id: string }[];
        zones?: { id: string }[];
        removedDevices?: DeviceInstanceRow[];
        removedAgents?: AgentInstanceRow[];
        removedServices?: ServiceInstanceRow[];
        removedAgreements?: AgreementRow[];
        events?: { id: string }[];
        zoneId?: string;
        granteeId?: string;
        objectType?: 'device' | 'agent';
        targetId?: string;
        before?: Record<string, unknown> | null;
        // P2F §11: adopt-config's apply entry (flows it created; agents it
        // patched with their before-state; computations it registered with
        // their before-rows). Keyed `agents` would collide with the
        // install-agents shape ({id}[]) — adopt's carries before-state.
        flows?: Array<{ id: string }>;
        adoptAgents?: Array<{ id: string; before: Record<string, unknown> | null }>;
        computations?: Array<{
          serviceId: string;
          before: {
            kind: string;
            spec_json: string;
            schema_version: number;
            registered_by: string;
          } | null;
        }>;
        // C3 (R42-B): the ownership-transfer apply entry — one record per
        // moved object with its previous owner (what revert restores).
        transfers?: Array<{
          kind: 'agent' | 'device';
          id: string;
          name: string;
          fromUserId: string;
          toUserId: string;
          devices: 'bound' | 'keep';
          movedDeviceIds: string[];
        }>;
      };
      // A reverted zone-claim revokes the stewardship it granted (§5.3).
      if (proposal.kind === 'zone-claim' && applied.zoneId !== undefined) {
        this.deps.zoneClaimStore.revoke(env.id, applied.zoneId, applied.granteeId ?? proposal.author_id);
      }
      // P2F §11: adopt-config inverse — remove the created flows, roll the
      // patched agents back to their before-state, restore (or revoke) the
      // registered computations. Missing objects are tolerated.
      if (proposal.kind === 'adopt-config') {
        this.revertAdoptConfig(env, applied, actor.id, broadcasts);
      }
      // C3 (R42-B): ownership-transfer inverse — the reverse transfer
      // restores every recorded owner (agents + carried bound devices +
      // standalone devices). Missing objects are tolerated.
      if (proposal.kind === 'ownership-transfer' && Array.isArray(applied.transfers)) {
        this.revertOwnershipTransfer(env, applied.transfers, actor.id, broadcasts);
      }
      // T-055 install-zones inverse: remove the created zones — but ONLY
      // while they are still empty. A zone with devices in it (or under an
      // agent's management) is load-bearing now; removing it would orphan
      // the objects, so the revert is refused with a teaching message.
      if (proposal.kind === 'install-zones') {
        const zoneIds = (applied.zones ?? []).map(zone => zone.id);
        const currentZones = new Set(parseMapData(env).zones.map(zone => zone.id));
        const devicesByZone = new Map<string, number>();
        for (const device of envStore.devicesOf(env.id)) {
          devicesByZone.set(device.zone_id, (devicesByZone.get(device.zone_id) ?? 0) + 1);
        }
        const managedZones = new Set<string>();
        for (const agent of envStore.agentsOf(env.id)) {
          for (const zoneId of parseJsonArray<string>(agent.managed_zone_ids_json)) {
            managedZones.add(zoneId);
          }
        }
        const occupied = zoneIds.filter(zoneId => {
          if (!currentZones.has(zoneId)) return false; // already gone — tolerated
          return (devicesByZone.get(zoneId) ?? 0) > 0 || managedZones.has(zoneId);
        });
        if (occupied.length > 0) {
          throw new ApiError(
            409,
            'PROPOSAL_NOT_REVERTIBLE',
            `Proposal "${proposal.id}" created zone(s) ${occupied.map(id => `"${id}"`).join(', ')} that are no ` +
            'longer empty (devices installed or agents managing them) — remove or relocate those objects first, ' +
            'then revert. An occupied zone cannot be deleted out from under its objects.',
          );
        }
        const mapData = parseMapData(env);
        const surviving = mapData.zones.filter(zone => !zoneIds.includes(zone.id));
        const updated = envStore.updateEnvironment(env.id, {
          mapData: { ...mapData, zones: surviving },
        });
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'updated', 'environment', {
            id: updated.id,
            name: updated.name,
            mapType: updated.map_type,
            zones: zonesOf(updated),
            updatedAt: updated.updated_at,
          }, actor.id),
        );
      }
      let revertedDevices = 0;
      for (const device of applied.devices ?? []) {
        if (envStore.getDevice(device.id)) {
          envStore.deleteDevice(device.id);
          revertedDevices += 1;
          broadcasts.push(() =>
            this.deps.pipeline.publish(env.id, 'deleted', 'device', { id: device.id }, actor.id),
          );
        }
      }
      // The raw DELETE leaves service rows touched by the FK (derived rows
      // source_device_id → SET NULL) without touching the store write
      // methods — notify explicitly so the live-runtime world: mirror
      // converges (the removeDevices discipline, :1335).
      if (revertedDevices > 0) this.deps.serviceStore.notifyCatalogChange(env.id);
      // install-agents inverse: remove the agents; their services cascade in
      // the database — collect ids first so subscribers see the removals.
      let revertedAgents = 0;
      for (const agent of applied.agents ?? []) {
        if (!envStore.getAgent(agent.id)) continue;
        const serviceIds = this.deps.serviceStore.servicesOfAgent(agent.id).map(row => row.id);
        // R100 (v60 discipline, parity with the remove-agents lane :1419):
        // retire + unlink the agent's agreements BEFORE the row goes — an
        // install-agents revert must not physically swallow contracts that
        // were signed after the install.
        this.deps.agreementStore?.retireProviderAgreements?.(agent.id);
        envStore.deleteAgent(agent.id);
        revertedAgents += 1;
        broadcasts.push(() => {
          this.deps.pipeline.publish(env.id, 'deleted', 'agent', { id: agent.id }, actor.id);
          for (const serviceId of serviceIds) {
            this.deps.pipeline.publish(env.id, 'deleted', 'service', { id: serviceId }, actor.id);
          }
        });
      }
      // The FK cascade removes the agents' service rows without touching the
      // store write methods — notify explicitly so the live-runtime world:
      // mirror converges (the removeAgents discipline, :1405).
      if (revertedAgents > 0) this.deps.serviceStore.notifyCatalogChange(env.id);
      // remove-devices inverse: restore the exact rows the apply deleted
      // (original ids + bindings, so references that survived resolve again).
      for (const row of applied.removedDevices ?? []) {
        if (envStore.getDevice(row.id)) continue;
        envStore.restoreDevice(row);
        const json = deviceToJson(row, this.ownerRefFor(row.owner_id));
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'created', 'device', json, actor.id),
        );
      }
      // remove-agents inverse: restore the agent rows and their cascaded
      // services verbatim (original ids, so flows/subscriptions resolve).
      for (const row of applied.removedAgents ?? []) {
        if (envStore.getAgent(row.id)) continue;
        envStore.restoreAgent(row);
        const json = agentToJson(row, this.ownerRefFor(row.owner_id));
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'created', 'agent', json, actor.id),
        );
      }
      for (const row of applied.removedServices ?? []) {
        if (this.deps.serviceStore.getService(row.id)) continue;
        this.deps.serviceStore.restoreService(row);
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'created', 'service', { id: row.id }, actor.id),
        );
      }
      // T-049 + v60 (R6-E-F08) remove-agents inverse: the provider's
      // agreements were RETIRED (suspended/rejected/terminated + unlinked),
      // not destroyed. Revert RE-LINKS each row to the restored service and
      // agent (original ids, so display/audit references resolve again) but
      // deliberately keeps the retired STATUS — there is no suspended →
      // active edge anywhere in the lifecycle; the parties or the env owner
      // close the row through the existing terminate channel. Rows genuinely
      // missing (pre-v60 cascade window) still restore verbatim.
      if (this.deps.agreementStore !== undefined) {
        for (const row of applied.removedAgreements ?? []) {
          const existing = this.deps.agreementStore.getAgreement(row.id);
          if (existing === undefined) {
            this.deps.agreementStore.restoreAgreement(row);
            broadcasts.push(() => {
              this.deps.pipeline.publishAgreement(env.id, 'restored', row.id, actor.id);
            });
            continue;
          }
          const relinked = row.provider_agent_id !== null
            ? this.deps.agreementStore.relinkProviderAgreement?.(row.id, {
                serviceId: row.service_id,
                providerAgentId: row.provider_agent_id,
              })
            : undefined;
          if (relinked !== undefined) {
            broadcasts.push(() => {
              this.deps.pipeline.publishAgreement(env.id, 'restored', row.id, actor.id);
            });
          }
        }
      }
      // modify-object inverse: roll the target back to its before-state.
      if (proposal.kind === 'modify-object' && applied.targetId !== undefined && applied.before) {
        this.revertModifyObject(env, applied.targetId, applied.objectType, applied.before, actor.id, broadcasts);
      }
      const eventIds = new Set((applied.events ?? []).map(event => event.id));
      if (eventIds.size > 0) {
        const mapData = parseMapData(env);
        const remaining = (mapData.events ?? []).filter(event => !eventIds.has(event.id));
        if (remaining.length !== (mapData.events ?? []).length) {
          const nextMapData: EnvMapData = { ...mapData, events: remaining };
          const updated = envStore.updateEnvironment(env.id, { mapData: nextMapData });
          broadcasts.push(() => this.broadcastEnvironmentUpdated(updated, actor.id));
        }
      }
      this.deps.pipeline.log({
        envId: env.id,
        actorId: actor.id,
        proposalId: proposal.id,
        kind: `revert:${proposal.kind}`,
        payload: { before: after ?? null, after: null },
      });
    });
    for (const broadcast of broadcasts) broadcast();

    return this.transition(proposal.id, { status: 'reverted' }, actor.id, locale);
  }

  /** Load a proposal or throw the standard 404. */
  getOrThrow(id: string): ProposalRow {
    const row = this.deps.proposalStore.get(id);
    if (!row) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', `Proposal "${id}" not found`);
    return row;
  }

  /**
   * Transition + governance broadcast (Fix-4): every status change a
   * subscriber cares about is announced on the environment stream with the
   * actor who caused it. Internal funnel steps map to no event.
   *
   * Fix-16: the same transitions also land a persistent notification —
   * `escalated` pings the environment owner (有待审批), the terminal verdicts
   * ping the author. `approved` is deliberately NOT notified: it is
   * transient (every approval is followed by `applied` inside the same
   * call), so the applied notification carries the verdict — two rows for
   * one decision would be noise.
   */
  private transition(
    proposalId: string,
    patch: Parameters<ProposalStore['transition']>[1],
    actorId: string,
    locale: UiLocale = 'zh-CN',
  ): ProposalRow {
    const next = this.deps.proposalStore.transition(proposalId, patch);
    const action = STREAM_ACTION_BY_STATUS[next.status];
    if (action !== undefined) {
      this.deps.pipeline.publishProposal(next.env_id, action, next.id, actorId);
    }
    this.notifyTransition(next, actorId, locale);
    return next;
  }

  /** Fix-16 doorbell for one proposal transition (see transition()). */
  private notifyTransition(proposal: ProposalRow, actorId: string, locale: UiLocale): void {
    const { notificationStore } = this.deps;
    if (proposal.status === 'escalated') {
      const env = this.deps.envStore.getEnvironment(proposal.env_id);
      if (!env) return;
      notify(notificationStore, {
        recipientId: env.owner_id,
        actorId,
        envId: proposal.env_id,
        kind: NOTIFICATION_KINDS.proposalEscalated,
        title: t(locale, 'chrome.notif.proposalEscalated'),
        body: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          status: 'escalated',
          // T-059 §5.3 pattern: the notification names WHERE the decision
          // goes (the delegate's inbox doubles as their action surface).
          replyHint: {
            endpoint: `POST /api/proposals/${proposal.id}/decide`,
            allowedDecisions: ['approved', 'rejected'],
            yourMove: true,
          },
        },
        refId: proposal.id,
      });
      // T-072 (D-1 decide half): an escalated zone-claim also reaches the
      // ACTIVE delegate — the owner handed them the decide right, so the
      // pending claim lands on their desk too (both may decide; whoever
      // moves first wins, the 409 PROPOSAL_NOT_DECIDABLE guards the race).
      const delegation = this.deps.delegationStore?.getActive(proposal.env_id, 'zone-claims');
      if (
        proposal.kind === 'zone-claim' &&
        delegation !== undefined &&
        delegation.delegate_id !== env.owner_id &&
        delegation.delegate_id !== actorId
      ) {
        notify(notificationStore, {
          recipientId: delegation.delegate_id,
          actorId,
          envId: proposal.env_id,
          kind: NOTIFICATION_KINDS.proposalEscalated,
          title: t(locale, 'chrome.notif.proposalEscalated'),
          body: {
            proposalId: proposal.id,
            proposalKind: proposal.kind,
            status: 'escalated',
            delegatedToYou: true,
            replyHint: {
              endpoint: `POST /api/proposals/${proposal.id}/decide`,
              allowedDecisions: ['approved', 'rejected'],
              yourMove: true,
            },
          },
          refId: proposal.id,
        });
      }
      return;
    }
    const verdict: Record<string, { kind: string; titleKey: string }> = {
      rejected: { kind: NOTIFICATION_KINDS.proposalRejected, titleKey: 'chrome.notif.proposalRejected' },
      applied: { kind: NOTIFICATION_KINDS.proposalApplied, titleKey: 'chrome.notif.proposalApplied' },
      reverted: { kind: NOTIFICATION_KINDS.proposalReverted, titleKey: 'chrome.notif.proposalReverted' },
    };
    const entry = verdict[proposal.status];
    if (entry === undefined) return;
    // Fix-18 (R7 F-16): applied/rejected ALWAYS reach the author — on
    // auto-decided paths (AI allow, zone-claim autonomy, review-timeout
    // auto-approve, rule-check rejection) the transition actor IS the
    // author, but the verdict was the platform's, so the self-echo drop
    // must not silence it. `reverted` keeps the drop (self-revert echo).
    const allowSelf = proposal.status === 'applied' || proposal.status === 'rejected';
    // R102 (li-13 呼应): the rejection notice carries the WHY — rule-check
    // issues (the reason the pipeline refused) and the payload's object
    // summary, not just the bare status word.
    const ruleCheck = proposal.rule_check_json !== null
      ? (JSON.parse(proposal.rule_check_json) as { issues?: string[] })
      : {};
    // T39 (R3 u3-F4): the APPLIED lane coalesces micro-bursts — a bulk
    // install applying N proposals back-to-back used to ring the bell N
    // times with bare {proposalId, proposalKind, status} one-liners. Within
    // APPLIED_COALESCE_WINDOW_MS the notices merge into ONE digest row
    // (title names the count; body items carry the per-proposal OBJECT
    // summary — "改了哪个 agent 的什么" is answerable). A single apply keeps
    // the ordinary one-row shape.
    if (proposal.status === 'applied') {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(proposal.payload_json);
        if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
      } catch { /* corrupt payload — the digest still lands, summary omitted */ }
      // T59 (R6, u1-F8/u2-F-3-1): the applied-class kinds now aggregate per
      // (recipient, kind, env) in the store — repeat_count is the ×N badge
      // and the body keeps the latest N proposal items (the per-proposal
      // audit stays in the activity feed / proposal ledger). The T39 2s
      // micro-bucket is superseded here: a 12-minute drip no longer rings
      // the bell once per proposal.
      const summary = proposalObjectSummary(proposal.kind, payload);
      notify(notificationStore, {
        recipientId: proposal.author_id,
        actorId,
        envId: proposal.env_id,
        kind: entry.kind,
        title: t(locale, entry.titleKey),
        body: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          status: 'applied',
          ...(summary !== undefined ? { summary } : {}),
        },
        refId: `proposals-applied:${proposal.env_id}`,
        allowSelf,
      });
    } else {
      notify(notificationStore, {
        recipientId: proposal.author_id,
        actorId,
        envId: proposal.env_id,
        kind: entry.kind,
        title: t(locale, entry.titleKey),
        body: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          status: proposal.status,
          ...(proposal.status === 'rejected' && Array.isArray(ruleCheck.issues) && ruleCheck.issues.length > 0
            ? { issues: ruleCheck.issues.slice(0, 3) }
            : {}),
        },
        refId: proposal.id,
        allowSelf,
      });
    }

    // T-004: an AUTO-applied proposal (no human verdict — reviewer_id null,
    // i.e. rule-fallback / zone-claim autonomy / review-timeout
    // auto-approve) also reaches the environment owner: their world changed
    // and previously they had no signal at all. When the owner IS the
    // author, the notification above already told them (the self-echo drop
    // here prevents a second ring); owner-decided applies stay silent to
    // the owner — they made the call. T-072: a DELEGATE-decided apply also
    // reaches the owner — the delegated right was exercised on their world,
    // which is exactly the "changed without the owner's hand" case T-004
    // exists for (the delegate already knows; the author was notified above).
    const decidedByDelegate =
      proposal.status === 'applied' &&
      parseJsonObject(proposal.ai_review_json)?.source === 'delegate';
    if (proposal.status === 'applied' && (proposal.reviewer_id === null || decidedByDelegate)) {
      const env = this.deps.envStore.getEnvironment(proposal.env_id);
      if (!env) return;
      // T59: env-aggregated like the author lane — the owner's inbox shows
      // ONE row per environment (×N badge, capped recent items), not one
      // row per auto-applied proposal (u1's 65-row morning).
      notify(notificationStore, {
        recipientId: env.owner_id,
        actorId,
        envId: proposal.env_id,
        kind: decidedByDelegate
          ? NOTIFICATION_KINDS.proposalDelegateApplied
          : NOTIFICATION_KINDS.proposalAutoApplied,
        title: t(
          locale,
          decidedByDelegate
            ? 'chrome.notif.proposalDelegateApplied'
            : 'chrome.notif.proposalAutoApplied',
        ),
        body: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          status: 'applied',
          authorId: proposal.author_id,
          ...(decidedByDelegate ? { decidedById: proposal.reviewer_id, decidedVia: 'delegate' } : {}),
        },
        refId: `proposals-applied:${proposal.env_id}`,
        // The owner IS the actor only if they delegated to themselves —
        // impossible (OWNER_CANNOT_BE_DELEGATE), but keep the guard honest.
        allowSelf: decidedByDelegate,
      });
    }
  }

  private ruleContext() {
    return {
      envStore: this.deps.envStore,
      catalogStore: this.deps.catalogStore,
      quotas: this.deps.quotas,
      ...(this.deps.humanReviewThresholds !== undefined
        ? { humanReviewThresholds: this.deps.humanReviewThresholds }
        : {}),
      ...(this.deps.flowStore !== undefined ? { flowStore: this.deps.flowStore } : {}),
      ...(this.deps.agreementStore !== undefined ? { agreementStore: this.deps.agreementStore } : {}),
      ...(this.deps.sandboxStore !== undefined ? { sandboxStore: this.deps.sandboxStore } : {}),
      ...(this.deps.evalRunStore !== undefined ? { evalRunStore: this.deps.evalRunStore } : {}),
      serviceStore: this.deps.serviceStore,
      userStore: this.deps.userStore,
    };
  }

  /**
   * §5.3 eligibility: the proposal's zone footprint is fully covered by
   * claims the author holds. Only install-devices / inject-scenario /
   * install-agents have a determinable footprint (proposalZoneIds);
   * everything else returns false.
   */
  private coversByZoneClaims(
    envId: string,
    authorId: string,
    kind: ProposalRow['kind'],
    check: RuleCheckResult,
  ): boolean {
    const zoneIds = proposalZoneIds(kind, check);
    if (zoneIds === null) return false;
    return zoneIds.every(zoneId => this.deps.zoneClaimStore.isClaimedBy(envId, zoneId, authorId));
  }

  /**
   * Apply a zone-claim: grant the author stewardship of the zone (§5.3).
   * The grant is idempotent (re-claiming an already-held zone is a no-op)
   * and the after-payload is what `revert` needs to revoke it.
   */
  /**
   * T-055: merge the validated zones into the environment's mapData (every
   * other mapData field — events, meta, floorPlans — is preserved verbatim).
   * Returns the `{zones}` fragment of the apply entry's after-payload (the
   * zone ids revert needs).
   */
  private installZones(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { zones: Array<{ id: string }> } {
    const mapData = parseMapData(env);
    const merged: EnvMapData = { ...mapData, zones: [...mapData.zones, ...check.zones] };
    const updated = this.deps.envStore.updateEnvironment(env.id, { mapData: merged });
    // Same broadcast shape as the owner's PATCH mapData path — subscribers
    // re-read the environment for the new zone list.
    broadcasts.push(() =>
      this.deps.pipeline.publish(env.id, 'updated', 'environment', {
        id: updated.id,
        name: updated.name,
        mapType: updated.map_type,
        zones: zonesOf(updated),
        updatedAt: updated.updated_at,
      }, proposal.author_id),
    );
    return { zones: check.zones.map(zone => ({ id: zone.id })) };
  }

  private grantZoneClaim(
    env: EnvironmentRow,
    proposal: ProposalRow,
    actorId: string,
  ): { zoneId: string; granteeId: string; grantedBy: string } {
    const payload = JSON.parse(proposal.payload_json) as { zoneId: string };
    const grant = { zoneId: payload.zoneId, granteeId: proposal.author_id, grantedBy: actorId };
    this.deps.zoneClaimStore.grant({ envId: env.id, ...grant });
    return grant;
  }

  /**
   * P2F §11 (adopt-config apply): install the validated artifacts into the
   * authoritative env through the stores their native authoring uses —
   * flow rows via FlowStore, agent patches via updateAgent (modify-object
   * semantics), computation specs via registerComputation. The change
   * pipeline logs the entry (kind 'adopt-config' wakes the world session)
   * and each artifact broadcasts like its native route. The after-payload
   * carries everything revert needs: created flow ids, agent before/after
   * JSON, computation before-rows (null = previously unregistered).
   * Attribution: sourceFork lineage rides the PROPOSAL payload (audit);
   * the command_log actor is the author as everywhere (Fix-1).
   */
  private adoptConfig(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): {
    flows: Array<{ id: string }>;
    adoptAgents: Array<{ id: string; before: unknown; after: unknown }>;
    computations: Array<{ serviceId: string; before: unknown }>;
  } {
    const createdFlows: Array<{ id: string }> = [];
    const agentChanges: Array<{ id: string; before: unknown; after: unknown }> = [];
    const computationChanges: Array<{ serviceId: string; before: unknown }> = [];

    for (const artifact of check.adoptArtifacts) {
      if (artifact.type === 'flow-definition') {
        if (this.deps.flowStore?.create === undefined) {
          throw new ApiError(
            409,
            'PROPOSAL_NOT_APPLICABLE',
            'adopt-config flow artifacts need the flow store (wired in the server; not in this context)',
          );
        }
        const row = this.deps.flowStore.create({
          environmentId: env.id,
          name: artifact.flow.name,
          description: artifact.flow.description,
          enabled: artifact.flow.enabled,
          trigger: artifact.flow.trigger as import('@active-collaboration/core').FlowTrigger,
          plan: artifact.flow.plan as import('@active-collaboration/core').FlowDefinition['plan'],
          ...(artifact.flow.inputs !== undefined
            ? { inputs: artifact.flow.inputs as unknown as import('@active-collaboration/core').FlowInputSpec[] }
            : {}),
          ...(artifact.flow.policy !== undefined ? { policy: artifact.flow.policy } : {}),
          ...(artifact.flow.agentInvocable !== undefined ? { agentInvocable: artifact.flow.agentInvocable } : {}),
          createdBy: proposal.author_id,
        });
        createdFlows.push({ id: row.id });
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'created', 'flow', { id: row.id, name: row.name }, proposal.author_id),
        );
        continue;
      }
      if (artifact.type === 'agent-policy') {
        const existing = this.deps.envStore.getAgent(artifact.agentId);
        if (existing === undefined || existing.env_id !== env.id) {
          // Deleted since approval — tolerated, recorded (never noop-silent).
          agentChanges.push({ id: artifact.agentId, before: null, after: null });
          continue;
        }
        const before = agentToJson(existing, this.ownerRefFor(existing.owner_id));
        const row = this.deps.envStore.updateAgent(
          artifact.agentId,
          artifact.patch as Parameters<EnvironmentStore['updateAgent']>[1],
        );
        const after = agentToJson(row, this.ownerRefFor(row.owner_id));
        agentChanges.push({ id: artifact.agentId, before, after });
        broadcasts.push(() =>
          this.deps.pipeline.publish(env.id, 'updated', 'agent', after, proposal.author_id),
        );
        continue;
      }
      // computation-spec
      const before = this.deps.serviceStore.computationOf(artifact.serviceId) ?? null;
      this.deps.serviceStore.registerComputation({
        serviceId: artifact.serviceId,
        kind: artifact.spec.kind as 'zone-query' | 'device-aggregate' | 'flow-report',
        specJson: JSON.stringify(artifact.spec),
        schemaVersion: artifact.schemaVersion,
        registeredBy: proposal.author_id,
      });
      computationChanges.push({ serviceId: artifact.serviceId, before });
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'updated', 'service', { id: artifact.serviceId }, proposal.author_id),
      );
    }
    // `adoptAgents` (not `agents`): the revert's install-agents loop reads
    // `agents` as create-rows to DELETE — adopt's agent entries are PATCHES
    // to roll back, a different inverse.
    return { flows: createdFlows, adoptAgents: agentChanges, computations: computationChanges };
  }

  /**
   * P2F §11 (adopt-config revert): the apply entry's inverse — created flows
   * are deleted (their flow-services cascade exactly like the flows route's
   * DELETE), patched agents roll back to the recorded before-state, and
   * registered computations restore their previous row (or are revoked when
   * none existed). Missing objects are tolerated.
   */
  private revertAdoptConfig(
    env: EnvironmentRow,
    applied: {
      flows?: Array<{ id: string }>;
      adoptAgents?: Array<{ id: string; before: Record<string, unknown> | null }>;
      computations?: Array<{ serviceId: string; before: { kind: string; spec_json: string; schema_version: number; registered_by: string } | null }>;
    },
    actorId: string,
    broadcasts: (() => void)[],
  ): void {
    for (const flow of applied.flows ?? []) {
      const existing = this.deps.flowStore?.listByEnvironment(env.id)
        .find(row => row.id === flow.id);
      if (existing === undefined) continue; // already deleted — tolerated
      this.deps.flowStore?.delete?.(flow.id);
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'deleted', 'flow', { id: flow.id }, actorId),
      );
    }
    for (const change of applied.adoptAgents ?? []) {
      if (change.before === null || !this.deps.envStore.getAgent(change.id)) continue;
      const before = change.before;
      // decisionPolicy/llm restore with modify-object's frozen-snapshot
      // semantics: an ABSENT key in the before-JSON means the row was NULL
      // (agentToJson omits nulls) — the patch is rolled back to null, not
      // skipped (otherwise a promoted policy would survive its own revert).
      const row = this.deps.envStore.updateAgent(change.id, {
        ...(before.capabilities !== undefined ? { capabilities: before.capabilities as string[] } : {}),
        decisionPolicy: (before.decisionPolicy as Record<string, unknown> | null | undefined) ?? null,
        llm: (before.llm as Record<string, unknown> | null | undefined) ?? null,
        ...(before.enabled !== undefined ? { enabled: before.enabled as boolean } : {}),
      });
      const json = agentToJson(row, this.ownerRefFor(row.owner_id));
      broadcasts.push(() => this.deps.pipeline.publish(env.id, 'updated', 'agent', json, actorId));
    }
    for (const change of applied.computations ?? []) {
      if (change.before === null) {
        this.deps.serviceStore.revokeComputation(change.serviceId);
      } else {
        this.deps.serviceStore.registerComputation({
          serviceId: change.serviceId,
          kind: change.before.kind as 'zone-query' | 'device-aggregate' | 'flow-report',
          specJson: change.before.spec_json,
          schemaVersion: change.before.schema_version,
          registeredBy: change.before.registered_by,
        });
      }
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'updated', 'service', { id: change.serviceId }, actorId),
      );
    }
  }

  /**
   * C3 (R42-B, devloop-r41-a1 §8): apply an ownership-transfer — write the
   * governance-plane owner columns (agent_instances.owner_id /
   * device_instances.owner_id; an agent with devices:'bound' carries its
   * bound devices) through the store's ownerId patch. The after-payload
   * records each object's PREVIOUS owner — that is what revert restores.
   * Deliberately NO derivation sync: ownership is not the data plane
   * (provider_agent_id + reputation are untouched, §8.4).
   */
  private applyOwnershipTransfer(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { transfers: Array<{ kind: 'agent' | 'device'; id: string; name: string; fromUserId: string; toUserId: string; devices: 'bound' | 'keep'; movedDeviceIds: string[] }> } {
    const applied: Array<{ kind: 'agent' | 'device'; id: string; name: string; fromUserId: string; toUserId: string; devices: 'bound' | 'keep'; movedDeviceIds: string[] }> = [];
    for (const transfer of check.ownershipTransfers) {
      // Re-read under the apply transaction — the rule check re-ran, so the
      // rows exist; a delete racing inside the tick is tolerated, recorded.
      if (transfer.kind === 'agent') {
        const agent = this.deps.envStore.getAgent(transfer.id);
        if (agent === undefined) continue;
        const row = this.deps.envStore.updateAgent(transfer.id, { ownerId: transfer.toUserId });
        const movedDeviceIds: string[] = [];
        if (transfer.devices === 'bound') {
          for (const deviceId of transfer.boundDeviceIds) {
            if (!this.deps.envStore.getDevice(deviceId)) continue;
            this.deps.envStore.updateDevice(deviceId, { ownerId: transfer.toUserId });
            movedDeviceIds.push(deviceId);
          }
        }
        applied.push({ ...transfer, movedDeviceIds });
        broadcasts.push(() => {
          const json = agentToJson(row, this.ownerRefFor(row.owner_id));
          this.deps.pipeline.publish(env.id, 'updated', 'agent', json, proposal.author_id);
          for (const deviceId of movedDeviceIds) {
            this.deps.pipeline.publish(env.id, 'updated', 'device', { id: deviceId }, proposal.author_id);
          }
        });
        continue;
      }
      const device = this.deps.envStore.getDevice(transfer.id);
      if (device === undefined) continue;
      const row = this.deps.envStore.updateDevice(transfer.id, { ownerId: transfer.toUserId });
      applied.push({ ...transfer, movedDeviceIds: [] });
      broadcasts.push(() =>
        this.deps.pipeline.publish(
          env.id,
          'updated',
          'device',
          deviceToJson(row, this.ownerRefFor(row.owner_id)),
          proposal.author_id,
        ),
      );
    }
    return { transfers: applied };
  }

  /**
   * C3 (R42-B): the apply entry's inverse — every recorded object (and each
   * carried bound device) moves back to its recorded previous owner. The
   * same reverse transfer discipline as the forward path: owner columns
   * only, no world mutation, no derivation sync.
   */
  private revertOwnershipTransfer(
    env: EnvironmentRow,
    transfers: Array<{ kind: 'agent' | 'device'; id: string; fromUserId: string; movedDeviceIds?: string[] }>,
    actorId: string,
    broadcasts: (() => void)[],
  ): void {
    for (const transfer of transfers) {
      if (transfer.kind === 'agent') {
        const agent = this.deps.envStore.getAgent(transfer.id);
        if (agent === undefined) continue; // deleted meanwhile — tolerated
        const row = this.deps.envStore.updateAgent(transfer.id, { ownerId: transfer.fromUserId });
        broadcasts.push(() =>
          this.deps.pipeline.publish(
            env.id,
            'updated',
            'agent',
            agentToJson(row, this.ownerRefFor(row.owner_id)),
            actorId,
          ),
        );
        for (const deviceId of transfer.movedDeviceIds ?? []) {
          if (!this.deps.envStore.getDevice(deviceId)) continue;
          this.deps.envStore.updateDevice(deviceId, { ownerId: transfer.fromUserId });
          broadcasts.push(() =>
            this.deps.pipeline.publish(env.id, 'updated', 'device', { id: deviceId }, actorId),
          );
        }
        continue;
      }
      const device = this.deps.envStore.getDevice(transfer.id);
      if (device === undefined) continue;
      const row = this.deps.envStore.updateDevice(transfer.id, { ownerId: transfer.fromUserId });
      broadcasts.push(() =>
        this.deps.pipeline.publish(
          env.id,
          'updated',
          'device',
          deviceToJson(row, this.ownerRefFor(row.owner_id)),
          actorId,
        ),
      );
    }
  }

  /**
   * Create the proposed device instances (owner = proposal author). Returns
   * the `{devices}` fragment of the apply entry's after-payload.
   */
  private installDevices(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { devices: ReturnType<typeof deviceToJson>[] } {
    const created: ReturnType<typeof deviceToJson>[] = [];
    for (const device of check.devices) {
      let row: DeviceInstanceRow = this.deps.envStore.createDevice({
        envId: env.id,
        ownerId: proposal.author_id,
        name: device.name,
        type: device.type,
        brand: device.brand,
        capabilities: device.capabilities,
        zoneId: device.zoneId,
        position: device.position,
        initialState: device.initialState,
      });
      if (device.binding !== null) {
        row = this.deps.envStore.updateDevice(row.id, { binding: device.binding });
      }
      const json = deviceToJson(row, this.ownerRefFor(proposal.author_id));
      created.push(json);
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'created', 'device', json, proposal.author_id),
      );
    }
    return { devices: created };
  }

  /**
   * Create the proposed agent instances (owner = proposal author) and run
   * the derivation sync so their device-derived services appear — identical
   * to the owner direct-create path. Returns the `{agents}` fragment of the
   * apply entry's after-payload.
   */
  private installAgents(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { agents: ReturnType<typeof agentToJson>[] } {
    const created: ReturnType<typeof agentToJson>[] = [];
    for (const agent of check.agents) {
      const row = this.deps.envStore.createAgent({
        envId: env.id,
        ownerId: proposal.author_id,
        name: agent.name,
        capabilities: agent.capabilities,
        boundDeviceIds: agent.boundDeviceIds,
        managedZoneIds: agent.managedZoneIds,
        llm: agent.llm,
        // T-604 (R26): scope-of-practice blocklist rides the install.
        ...(agent.cannotDeliverClasses !== undefined
          ? { cannotDeliverClasses: agent.cannotDeliverClasses }
          : {}),
        // T-051: the author's per-agent actuation defaults ride the install.
        decisionPolicy: agent.decisionPolicy,
        // R15 (FR15-F02): the author's derived-service visibility default
        // rides the install — the apply-time derivation honors it.
        derivedServiceVisibility: agent.derivedServiceVisibility,
      });
      const json = agentToJson(row, this.ownerRefFor(proposal.author_id));
      created.push(json);
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'created', 'agent', json, proposal.author_id),
      );
      this.deferServiceChanges(env.id, this.deps.serviceStore.syncDerivedForAgent(row.id), proposal.author_id, broadcasts);
    }
    return { agents: created };
  }

  /**
   * Delete the proposed devices (Fix-7 remove-devices): derived services
   * sourced from each device go first, then the row itself. The after-payload
   * carries the FULL pre-delete rows — that snapshot is what revert restores.
   */
  private removeDevices(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { removedDevices: DeviceInstanceRow[] } {
    const removed: DeviceInstanceRow[] = [];
    for (const device of check.removedDevices) {
      const current = this.deps.envStore.getDevice(device.id);
      if (!current) continue; // deleted meanwhile — nothing to remove
      this.deferServiceChanges(env.id, this.deps.serviceStore.deleteDerivedForDevice(current.id), proposal.author_id, broadcasts);
      this.deps.envStore.deleteDevice(current.id);
      removed.push(current);
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'deleted', 'device', { id: current.id }, proposal.author_id),
      );
    }
    // The FK cascade removes service rows without touching the store write
    // methods — notify explicitly so the live-runtime world: mirror converges.
    if (removed.length > 0) this.deps.serviceStore.notifyCatalogChange(env.id);
    return { removedDevices: removed };
  }

  /**
   * Delete the proposed agents (T-209 remove-agents): cascaded services are
   * snapshotted BEFORE the row delete (the FK removes them) so revert can
   * restore them verbatim. The after-payload carries the FULL pre-delete
   * agent + service rows — that snapshot is what revert restores.
   *
   * T-049 + v60 (R6-E-F08) cascade honesty: the provider's agreements are
   * RETIRED, not destroyed — active/held → suspended, pending offers →
   * rejected, ephemeral AC → terminated (status_reason
   * 'provider-unavailable'), then unlinked so the FK cascade deletes nothing
   * and the ledger (terminated history + append-only usage/receipts)
   * survives. Each transition is broadcast on the env stream and every
   * affected CONSUMER owner gets a persistent notification — a consumer
   * losing their provider is never silent. The pre-retire snapshot still
   * rides the after-payload; revert re-links the rows (status stays retired).
   */
  private removeAgents(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
    locale: UiLocale = 'zh-CN',
  ): { removedAgents: AgentInstanceRow[]; removedServices: ServiceInstanceRow[]; removedAgreements: AgreementRow[] } {
    const removedAgents: AgentInstanceRow[] = [];
    const removedServices: ServiceInstanceRow[] = [];
    const removedAgreements: AgreementRow[] = [];
    for (const agent of check.removedAgents) {
      const current = this.deps.envStore.getAgent(agent.id);
      if (!current) continue; // deleted meanwhile — nothing to remove
      removedServices.push(...this.deps.serviceStore.servicesOfAgent(current.id));
      // T-049: snapshot BEFORE the retire (revert re-links the rows by their
      // original ids; the pre-retire row carries the service/agent refs).
      const agreements = this.deps.agreementStore?.agreementsOfProviderAgent(current.id) ?? [];
      removedAgreements.push(...agreements);
      // v60: retire + unlink BEFORE the agent row goes — the FK cascades
      // (agent row AND its service rows) then have nothing to match.
      // Minimal duck-typed deps without the v60 methods degrade to the old
      // cascade-destroy behavior.
      const retired = this.deps.agreementStore?.retireProviderAgreements?.(current.id) ?? [];
      this.deps.envStore.deleteAgent(current.id);
      removedAgents.push(current);
      broadcasts.push(() => {
        this.deps.pipeline.publish(env.id, 'deleted', 'agent', { id: current.id }, proposal.author_id);
        for (const service of removedServices) {
          if (service.provider_agent_id !== current.id) continue;
          this.deps.pipeline.publish(env.id, 'deleted', 'service', { id: service.id }, proposal.author_id);
        }
        for (const { row, from } of retired) {
          const pre = agreements.find(candidate => candidate.id === row.id);
          // Retire only lands suspended/rejected/terminated — all valid
          // stream actions (AgreementStatus is wider).
          this.deps.pipeline.publishAgreement(
            env.id,
            row.status as 'suspended' | 'rejected' | 'terminated',
            row.id,
            proposal.author_id,
          );
          // T-025: every lifecycle transition lands an audit row.
          this.deps.pipeline.log({
            envId: env.id,
            actorId: proposal.author_id,
            proposalId: proposal.id,
            kind: 'agreement-transition',
            payload: {
              agreementId: row.id,
              serviceId: pre?.service_id ?? null,
              from,
              to: row.status,
              reason: 'provider-unavailable',
              providerAgentId: current.id,
            },
          });
          // The consumer loses their provider — ring the doorbell (the
          // provider owner IS the proposal author; the self-echo drop in
          // notify() keeps their inbox quiet).
          notify(this.deps.notificationStore, {
            recipientId: row.consumer_owner_id,
            actorId: proposal.author_id,
            envId: env.id,
            kind: NOTIFICATION_KINDS.agreementProviderRemoved,
            title: t(locale, 'chrome.notif.agreementProviderRemoved'),
            body: {
              agreementId: row.id,
              serviceId: pre?.service_id ?? null,
              providerAgentId: current.id,
              providerAgentName: current.name,
              from,
              status: row.status,
              reason: 'provider-unavailable',
              proposalId: proposal.id,
            },
            refId: row.id,
          });
        }
      });
    }
    // The FK cascade removes the agents' service rows without touching the
    // store write methods — notify explicitly so the live-runtime world:
    // mirror converges.
    if (removedAgents.length > 0) this.deps.serviceStore.notifyCatalogChange(env.id);
    return { removedAgents, removedServices, removedAgreements };
  }

  /**
   * Apply a modify-object patch for real (Fix-7): the rule check already
   * validated + normalized the patch, so this writes it via the store with
   * the same semantics as the owner-only PATCH routes, syncing derived
   * services on capability/name/binding changes. The after-payload carries
   * before/after JSON so revert restores the prior state.
   */
  private modifyObject(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { objectType: 'device' | 'agent'; targetId: string; before: unknown; after: unknown } {
    const target = check.modifyTarget;
    if (!target) {
      // Unreachable (the rule check gates apply) — fail loudly, never noop.
      throw new ApiError(409, 'PROPOSAL_NOT_APPLICABLE', 'modify-object proposal has no validated target');
    }
    if (target.objectType === 'device') {
      const existing = this.deps.envStore.getDevice(target.id);
      if (!existing) {
        throw new ApiError(404, 'DEVICE_NOT_FOUND', `Device "${target.id}" not found`);
      }
      const before = deviceToJson(existing, this.ownerRefFor(existing.owner_id));
      const row = this.deps.envStore.updateDevice(
        target.id,
        target.patch as Parameters<EnvironmentStore['updateDevice']>[1],
      );
      const after = deviceToJson(row, this.ownerRefFor(row.owner_id));
      broadcasts.push(() =>
        this.deps.pipeline.publish(env.id, 'updated', 'device', after, proposal.author_id),
      );
      if (target.patch.capabilities !== undefined || target.patch.name !== undefined) {
        // T-403: the honesty wrapper — a regeneration that drops a derived
        // row cascade-deletes its agreements; consumers get the doorbell.
        this.deferServiceChanges(env.id, syncDerivedForDeviceWithNotices(this.deps, target.id, proposal.author_id, { proposalId: proposal.id }), proposal.author_id, broadcasts);
      }
      return { objectType: 'device', targetId: target.id, before, after };
    }
    const existing = this.deps.envStore.getAgent(target.id);
    if (!existing) {
      throw new ApiError(404, 'AGENT_NOT_FOUND', `Agent "${target.id}" not found`);
    }
    const before = agentToJson(existing, this.ownerRefFor(existing.owner_id));
    const row = this.deps.envStore.updateAgent(
      target.id,
      target.patch as Parameters<EnvironmentStore['updateAgent']>[1],
    );
    const after = agentToJson(row, this.ownerRefFor(row.owner_id));
    broadcasts.push(() =>
      this.deps.pipeline.publish(env.id, 'updated', 'agent', after, proposal.author_id),
    );
    if (target.patch.boundDeviceIds !== undefined) {
      // T-403: same honesty wrapper (unbound-device derived rows regenerate
      // away and take their agreements with them).
      this.deferServiceChanges(env.id, syncDerivedForAgentWithNotices(this.deps, target.id, proposal.author_id, { proposalId: proposal.id }), proposal.author_id, broadcasts);
    }
    return { objectType: 'agent', targetId: target.id, before, after };
  }

  /**
   * modify-object revert: write the before-JSON back through the store and
   * re-sync derived services. `before.binding` carries the wire form where
   * the sim:// default is materialized — the `sim://<own id>` value maps
   * back to a NULL binding.
   */
  private revertModifyObject(
    env: EnvironmentRow,
    targetId: string,
    objectType: 'device' | 'agent' | undefined,
    before: Record<string, unknown>,
    actorId: string,
    broadcasts: (() => void)[],
  ): void {
    if (objectType === 'device') {
      if (!this.deps.envStore.getDevice(targetId)) return;
      const binding = typeof before.binding === 'string' && before.binding !== `sim://${targetId}`
        ? before.binding
        : null;
      const row = this.deps.envStore.updateDevice(targetId, {
        name: before.name as string,
        type: before.type as string,
        brand: (before.brand as string | null) ?? null,
        capabilities: before.capabilities as string[],
        zoneId: before.zoneId as string,
        position: (before.position as Record<string, unknown> | null) ?? null,
        initialState: (before.initialState as Record<string, unknown> | null) ?? null,
        binding,
      });
      const json = deviceToJson(row, this.ownerRefFor(row.owner_id));
      broadcasts.push(() => this.deps.pipeline.publish(env.id, 'updated', 'device', json, actorId));
      // T-403: revert re-syncs derivations too (the inverse patch can drop
      // rows) — same consumer doorbell as the forward apply.
      this.deferServiceChanges(env.id, syncDerivedForDeviceWithNotices(this.deps, targetId, actorId), actorId, broadcasts);
      return;
    }
    if (objectType === 'agent') {
      if (!this.deps.envStore.getAgent(targetId)) return;
      const row = this.deps.envStore.updateAgent(targetId, {
        name: before.name as string,
        capabilities: before.capabilities as string[],
        boundDeviceIds: before.boundDeviceIds as string[],
        managedZoneIds: before.managedZoneIds as string[],
        llm: (before.llm as Record<string, unknown> | null) ?? null,
        // T-604 (R26): the scope-of-practice blocklist restores with the
        // rest of the before state (same frozen-snapshot semantics).
        cannotDeliverClasses: (before.cannotDeliverClasses as string[] | null | undefined) ?? null,
        // T-051: the decision policy restores with the rest of the before
        // state (same frozen-snapshot semantics as llm: absent → null).
        decisionPolicy: (before.decisionPolicy as Record<string, unknown> | null) ?? null,
      });
      const json = agentToJson(row, this.ownerRefFor(row.owner_id));
      broadcasts.push(() => this.deps.pipeline.publish(env.id, 'updated', 'agent', json, actorId));
      // T-403: same doorbell on the agent revert path.
      this.deferServiceChanges(env.id, syncDerivedForAgentWithNotices(this.deps, targetId, actorId), actorId, broadcasts);
    }
  }

  /** Queue derivation-sync changes for broadcast after the apply transaction. */
  private deferServiceChanges(
    envId: string,
    changes: DerivedSyncChange[],
    actorId: string,
    broadcasts: (() => void)[],
  ): void {
    if (changes.length === 0) return;
    broadcasts.push(() =>
      publishServiceChanges(
        {
          envStore: this.deps.envStore,
          reputationStore: this.deps.reputationStore,
          userStore: this.deps.userStore,
          pipeline: this.deps.pipeline,
          ...(this.deps.standingAsks !== undefined
            ? { standingAsks: this.deps.standingAsks }
            : {}),
        },
        envId,
        changes,
        actorId,
      ),
    );
  }

  /**
   * Append the proposed events to the environment's map data (the bridge
   * fires them on schedule). Event ids are namespaced by the proposal id so
   * they never collide with existing events and are trivially removable on
   * revert.
   */
  private injectEvents(
    env: EnvironmentRow,
    proposal: ProposalRow,
    check: RuleCheckResult,
    broadcasts: (() => void)[],
  ): { events: EnvMapEvent[] } {
    const events = check.events.map(event => ({
      ...(event as unknown as EnvMapEvent),
      id: `${proposal.id}:${(event as { id: string }).id}`,
    }));
    if (events.length === 0) return { events };
    const mapData = parseMapData(env);
    const updated = this.deps.envStore.updateEnvironment(env.id, {
      mapData: { ...mapData, events: [...(mapData.events ?? []), ...events] },
    });
    broadcasts.push(() => this.broadcastEnvironmentUpdated(updated, proposal.author_id));
    return { events };
  }

  /** Same broadcast shape as PATCH /api/environments/:id. */
  private broadcastEnvironmentUpdated(updated: EnvironmentRow, actorId: string): void {
    this.deps.pipeline.publish(updated.id, 'updated', 'environment', {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      mapType: updated.map_type,
      visibility: updated.visibility,
      zones: zonesOf(updated),
      updatedAt: updated.updated_at,
    }, actorId);
  }

  private ownerRefFor(userId: string) {
    const user = this.deps.userStore.findById(userId);
    return ownerRef(user ? toPublicUser(user) : undefined, userId);
  }
}
