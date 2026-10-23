/**
 * Service derivation sync + broadcast (R21-W5 extraction from
 * routes/env-objects.ts, pure move).
 *
 * The derivation-sync SERVICE the proposal pipeline and the env-object
 * routes share: publishing service changes as world-sync messages, and the
 * T-403 (DevLoop R19, NW-F03) honest-sync wrappers that doorbell every
 * consumer whose live agreement rode a regenerated derived row. Lives in a
 * service module (not a route file) so nothing under routes/ is depended
 * on by services — the import-direction guard (arch-guards.vitest.test.ts)
 * holds this line.
 */

import type { UiLocale } from '@active-collaboration/shared';

import type { ChangePipeline } from './change-pipeline.js';
import type { EnvironmentStore } from './db/environment-store.js';
import { parseJsonArray } from './db/environment-store.js';
import type { NotificationStore } from './db/notification-store.js';
import { noHistoryView, type ReputationStore } from './db/reputation-store.js';
import {
  unbackedFlagsForEnv,
  type DerivedSyncChange,
  type ServiceStore,
} from './db/service-store.js';
import { matchStandingAsksForNewService, type StandingAskMatchDeps } from './standing-asks.js';
import { toPublicUser, type UserStore } from './db/user-store.js';
import { ownerRef, serviceToJson } from './env-serializers.js';
import { t } from './i18n/index.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';

export function ownerRefFor(ctx: Pick<{ userStore: UserStore }, 'userStore'>, userId: string) {
  const user = ctx.userStore.findById(userId);
  return ownerRef(user ? toPublicUser(user) : undefined, userId);
}

/**
 * Publish derivation-sync changes as world-sync service messages (the
 * marketplace updates live when bindings/capabilities change). Shared with
 * the proposal service (Fix-7): governed agent installs and device removals
 * broadcast the same service messages as the owner direct-edit routes.
 */
export interface ServiceChangeBroadcastDeps {
  envStore: EnvironmentStore;
  reputationStore: ReputationStore;
  userStore: UserStore;
  pipeline: ChangePipeline;
  /**
   * T-069 (R23): when present, CREATED derived services also run the
   * standing-ask matcher (需求板 — design-data-services.md §11). Optional
   * so minimal contexts skip matching instead of crashing the sync lane.
   */
  standingAsks?: StandingAskMatchDeps;
}

export function publishServiceChanges(
  ctx: ServiceChangeBroadcastDeps,
  envId: string,
  changes: DerivedSyncChange[],
  actorId: string,
): void {
  if (changes.length === 0) return;
  const rows = changes.filter(change => change.action !== 'deleted').map(change => change.row);
  const unbacked = unbackedFlagsForEnv(ctx.envStore, rows);
  for (const change of changes) {
    if (change.action === 'deleted') {
      ctx.pipeline.publish(envId, 'deleted', 'service', { id: change.row.id }, actorId);
      continue;
    }
    const agent = ctx.envStore.getAgent(change.row.provider_agent_id);
    const provider = {
      id: change.row.provider_agent_id,
      name: agent?.name ?? change.row.provider_agent_id,
      owner: agent ? ownerRefFor(ctx, agent.owner_id) : { id: '', displayName: '' },
    };
    ctx.pipeline.publish(
      envId,
      change.action,
      'service',
      serviceToJson(
        change.row,
        provider,
        unbacked.get(change.row.id) ?? true,
        ctx.reputationStore.scoreFor(envId, change.row.provider_agent_id, change.row.semantic_type) ??
          noHistoryView(),
      ),
      actorId,
    );
    // T-069: the second 'created' seam — derived rows appearing (governed
    // agent installs / device capability changes) claim matching standing
    // asks. Best-effort lane inside the matcher; never breaks the sync.
    if (change.action === 'created' && ctx.standingAsks !== undefined) {
      matchStandingAsksForNewService(ctx.standingAsks, change.row, actorId);
    }
  }
}

// ---------------------------------------------------------------------------
// T-403 (DevLoop R19, NW-F03): derivation-sync agreement honesty
// ---------------------------------------------------------------------------

/**
 * Duck-typed agreement read for the T-403 cascade honesty helper — the real
 * {@link import('./db/agreement-store.js').AgreementStore} satisfies it;
 * minimal contexts omit it and the notices degrade to nothing.
 */
export interface DerivedAgreementSource {
  agreementsOfProviderAgent(agentId: string): Array<{
    id: string;
    /** v60 (R6-E-F08): nullable — retired rows are unlinked, never destroyed. */
    service_id: string | null;
    status: string;
    consumer_owner_id: string;
    consumer_agent_id: string | null;
  }>;
  /**
   * R100: post-sync read of one agreement's LANDED state — service-row
   * deletion now RETIRES (suspended/rejected/terminated +
   * status_reason 'service-unavailable') instead of cascade-destroying, so
   * the doorbell reports the retired status, never a fake 'deleted'.
   */
  getAgreement?(id: string): { status: string; status_reason: string | null } | undefined;
}

export interface DerivedAgreementNoticeDeps {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  agreementStore?: DerivedAgreementSource;
  notificationStore?: NotificationStore;
  /** Broadcast lane for `agreement: deleted` world-sync messages. */
  pipeline?: ChangePipeline;
  locale?: UiLocale;
}

/**
 * T-403: run a derivation sync HONESTLY. `service_instances.service_id … ON
 * DELETE CASCADE` used to silently DESTROY the agreements riding a
 * regenerated derived row (the consumer's next read 404'd with no trace).
 * R100 (wang-07) closed the data-integrity hole at the choke point:
 * ServiceStore.deleteService retires + unlinks the agreements first, so
 * the rows and their usage/receipts ledger SURVIVE with
 * status_reason 'service-unavailable'. What this wrapper adds is the
 * DOORBELL: each consumer of a live retired agreement gets a persistent
 * notification carrying the LANDED status, the reason and the successor
 * semantic types the same sync created, and the env stream broadcasts the
 * retired transition (T-049/v60 parity — never a fake 'deleted').
 * Self-echo suppression is notify()'s default (the actor already knows).
 *
 * Agreements are snapshotted BEFORE the sync (their pre-sync status
 * classifies which ones the retirement actually moved).
 */
function runDerivedSyncWithNotices(
  deps: DerivedAgreementNoticeDeps,
  envId: string,
  actorId: string,
  involvedAgentIds: string[],
  run: () => DerivedSyncChange[],
  meta?: { proposalId?: string },
): DerivedSyncChange[] {
  // Snapshot: agreements per service for the agents whose derived rows the
  // sync may touch (dead rows only matter; updated/created rows keep theirs).
  const agreementsByService = new Map<string, Array<{
    id: string;
    status: string;
    consumer_owner_id: string;
  }>>();
  if (deps.agreementStore !== undefined) {
    for (const agentId of involvedAgentIds) {
      for (const agreement of deps.agreementStore.agreementsOfProviderAgent(agentId)) {
        // v60: already-retired (unlinked) rows have no service to ride —
        // the sync's deleted-row doorbell does not apply to them.
        if (agreement.service_id === null) continue;
        const list = agreementsByService.get(agreement.service_id) ?? [];
        list.push(agreement);
        agreementsByService.set(agreement.service_id, list);
      }
    }
  }
  const changes = run();
  if (agreementsByService.size === 0) return changes;

  const successors = changes
    .filter(change => change.action === 'created')
    .map(change => change.row.semantic_type);
  const locale = deps.locale ?? 'zh-CN';
  for (const change of changes) {
    if (change.action !== 'deleted') continue;
    const agreements = agreementsByService.get(change.row.id) ?? [];
    const retired = agreements.filter(
      row => row.status !== 'rejected' && row.status !== 'terminated',
    );
    for (const agreement of retired) {
      // R100: the agreement SURVIVED the service-row deletion — read its
      // landed retire status (fallback 'suspended', the explicit-lane
      // landing) and broadcast/notify the TRUTH, never a fake 'deleted'.
      const landed = deps.agreementStore?.getAgreement?.(agreement.id);
      const landedStatus = (landed?.status ?? 'suspended') as 'suspended' | 'rejected' | 'terminated';
      deps.pipeline?.publishAgreement(envId, landedStatus, agreement.id, actorId);
      if (deps.notificationStore !== undefined) {
        notify(deps.notificationStore, {
          recipientId: agreement.consumer_owner_id,
          actorId,
          envId,
          kind: NOTIFICATION_KINDS.agreementDerivedRegenerated,
          title: t(locale, 'chrome.notif.agreementDerivedRegenerated'),
          body: {
            agreementId: agreement.id,
            serviceId: change.row.id,
            serviceName: change.row.name,
            semanticType: change.row.semantic_type,
            status: landedStatus,
            statusReason: landed?.status_reason ?? 'service-unavailable',
            reason: 'derived-service-regenerated',
            successorSemanticTypes: successors,
            ...(meta?.proposalId !== undefined ? { proposalId: meta.proposalId } : {}),
            actorId,
          },
          refId: agreement.id,
        });
      }
    }
  }
  return changes;
}

/**
 * T-403 wrapper for the device-scoped derivation sync: every agent bound to
 * the device may lose derived rows (capability drop / type-death).
 */
export function syncDerivedForDeviceWithNotices(
  deps: DerivedAgreementNoticeDeps,
  deviceId: string,
  actorId: string,
  meta?: { proposalId?: string },
): DerivedSyncChange[] {
  const device = deps.envStore.getDevice(deviceId);
  if (!device) return [];
  const involved = deps.envStore
    .agentsOf(device.env_id)
    .filter(agent => parseJsonArray<string>(agent.bound_device_ids_json).includes(deviceId))
    .map(agent => agent.id);
  return runDerivedSyncWithNotices(
    deps,
    device.env_id,
    actorId,
    involved,
    () => deps.serviceStore.syncDerivedForDevice(deviceId),
    meta,
  );
}

/**
 * T-403 wrapper for the agent-scoped derivation sync: rebinding devices
 * drops the derived rows of every device that left the binding.
 */
export function syncDerivedForAgentWithNotices(
  deps: DerivedAgreementNoticeDeps,
  agentId: string,
  actorId: string,
  meta?: { proposalId?: string },
): DerivedSyncChange[] {
  const agent = deps.envStore.getAgent(agentId);
  if (!agent) return [];
  return runDerivedSyncWithNotices(
    deps,
    agent.env_id,
    actorId,
    [agentId],
    () => deps.serviceStore.syncDerivedForAgent(agentId),
    meta,
  );
}
