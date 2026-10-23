/**
 * Change pipeline — the single funnel for shared-world mutations (Fix-1,
 * multi-user-simulation-design.md §4.1)
 *
 * Three paths change the shared world, and they used to implement (or skip)
 * auth, attribution, command_log and broadcast independently:
 *
 * 1. the proposal pipeline (proposal-service.ts) — governed structural
 *    changes;
 * 2. direct edits (routes/env-objects.ts, routes/catalog.ts,
 *    routes/environments.ts) — owner-only structural edits;
 * 3. sim device commands (routes/simulations.ts) — runtime control of
 *    devices inside an environment-backed simulation.
 *
 * This module is the shared tail of all three: once a change is authorized
 * and executed, recording it is ONE operation — an append-only command_log
 * entry naming the ACTUAL operator as actor, plus a WorldSync broadcast
 * carrying the same actor so subscribers learn "who did it". Routes and
 * services never call CommandLogStore.append / WorldSync.publish directly
 * for world mutations; they go through here.
 *
 * command_log payload conventions (consumed by replay-service.ts):
 * - `device-command`   `{deviceId, commandName, params?, before, after}` —
 *   before/after are the device's runtime state around the command.
 * - `env-direct-edit`  `{objectType, action, objectId?, before, after}` —
 *   owner direct structural edits (object JSON before/after, null at the
 *   created/deleted end).
 * - proposal kinds     `{before, after, decidedBy}` — actor is the proposal
 *   AUTHOR; decidedBy names the human approver (null for auto-approval).
 *
 * T-025 governance-audit kinds (every governance mutation surface lands a
 * row; actor = who acted, before/after = the state change):
 * - `agreement-transition` `{agreementId, serviceId, from, to, decision?,
 *   terms?/counteredTerms?}` — propose/decide/counter/suspend/terminate.
 *   NOT rendered by the activity feed (the agreement table already
 *   reconstructs the lifecycle with the T-060 bilateral filter; the raw
 *   rows are the owner/actor audit trail).
 * - `member-change`      `{action: added|role-changed|removed, userId,
 *   before, after}` — invite/batch-import/role-change/removal.
 * - `access-grant`       `{objectType: 'service', action: granted|revoked,
 *   objectId, granteeUserId, expiresAt?/before?, after}` — hidden-service
 *   consent doors (a repeat POST is an extension: a new row with the new
 *   expiry).
 * - `computation-change` `{objectType: 'service', action: registered|
 *   revoked, objectId, computationKind?, activeAgreementsNotified?}`.
 * - `share-create` / `share-revoke` (T-108) — anonymous replay links.
 */

import type { CommandLogRow, CommandLogStore } from './db/proposal-store.js';
import type { UserStore } from './db/user-store.js';
import type {
  AgreementStreamAction,
  PresenceUserRef,
  ProposalStreamAction,
  WorldAction,
  WorldObjectType,
  WorldSync,
} from './world-sync.js';

export interface ChangeLogEntry {
  envId: string;
  /** The ACTUAL operator: proposal author, editing owner, commanding user. */
  actorId: string;
  proposalId?: string | null;
  kind: string;
  payload: unknown;
  /** Simulation seconds when the change happened (device commands). */
  simTime?: number | null;
}

/**
 * Living-worlds P1W (design §6.1 (b) — "every governance action wakes the
 * world"; T-037 semantics): the command_log kinds that CHANGE THE WORLD and
 * therefore wake/land-in the env's authoritative world session. Agreement
 * lifecycle and member changes are governance but not world mutations —
 * they do not wake (freshness obligations have their own trigger on
 * activation). Device commands are sim-scoped (they already execute inside
 * whichever world targeted them) and do not wake either.
 */
const WORLD_MUTATION_KINDS: ReadonlySet<string> = new Set([
  'env-direct-edit', // owner direct structural edits
  'install-devices',
  'install-agents',
  'install-zones',
  'remove-agents',
  'remove-devices',
  'inject-scenario',
  'modify-object',
  'zone-claim',
  'adopt-config', // P2F §11: promoted config lands in the authoritative world
]);

/** The kinds that are governance APPLIES (world-changing proposal kinds). */
const PROPOSAL_APPLY_PREFIXES = ['install-', 'remove-', 'inject-', 'modify-', 'zone-', 'adopt-'];

export function isWorldMutationKind(kind: string): boolean {
  if (WORLD_MUTATION_KINDS.has(kind)) return true;
  // revert:<kind> rows land the same world changes in reverse.
  if (kind.startsWith('revert:')) return WORLD_MUTATION_KINDS.has(kind.slice('revert:'.length));
  return false;
}

export function isProposalApplyKind(kind: string): boolean {
  return PROPOSAL_APPLY_PREFIXES.some(prefix => kind.startsWith(prefix));
}

export class ChangePipeline {
  constructor(
    private readonly deps: {
      commandLogStore: CommandLogStore;
      worldSync: WorldSync;
      userStore: UserStore;
      /**
       * Living-worlds P1W: called AFTER a world-mutating change is logged —
       * the single wake hook for governance world changes (proposal applies
       * create the session; direct edits refresh an existing one). Async by
       * nature; the pipeline never awaits it (the change itself is done).
       */
      onWorldMutation?: (envId: string, options: { create: boolean }) => void;
    },
  ) {}

  /** Append the audit entry for an executed change. */
  log(entry: ChangeLogEntry): CommandLogRow {
    const row = this.deps.commandLogStore.append(entry);
    if (isWorldMutationKind(entry.kind)) {
      try {
        this.deps.onWorldMutation?.(entry.envId, { create: isProposalApplyKind(entry.kind) });
      } catch {
        // The wake hook must never break the audit tail.
      }
    }
    return row;
  }

  /** Broadcast a world change with its actor attached (resolved to a ref). */
  publish(
    envId: string,
    action: WorldAction,
    objectType: WorldObjectType,
    object: unknown,
    actorId: string,
  ): void {
    this.deps.worldSync.publish(envId, action, objectType, object, this.actorRef(actorId));
  }

  /** Broadcast a proposal lifecycle transition (Fix-4 governance events). */
  publishProposal(
    envId: string,
    action: ProposalStreamAction,
    proposalId: string,
    actorId: string,
  ): void {
    this.deps.worldSync.publishProposal(envId, action, proposalId, this.actorRef(actorId));
  }

  /** Broadcast an agreement lifecycle transition (Fix-16). */
  publishAgreement(
    envId: string,
    action: AgreementStreamAction,
    agreementId: string,
    actorId: string,
  ): void {
    this.deps.worldSync.publishAgreement(envId, action, agreementId, this.actorRef(actorId));
  }

  /** `{id, displayName}` for logs and broadcasts; falls back to the raw id. */
  actorRef(userId: string): PresenceUserRef {
    const user = this.deps.userStore.findById(userId);
    return { id: userId, displayName: user?.display_name ?? userId };
  }
}
