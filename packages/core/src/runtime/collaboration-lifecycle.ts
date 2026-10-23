/**
 * Collaboration lifecycle teardown helpers — free functions over agent
 * iterables (EngineRuntime sits at its arch-guard size ceiling; the per-agent
 * loops live here so the runtime file only carries one-line delegations).
 */

import { createLogger } from '@active-collaboration/shared';

import { CollaborationStatus } from '../management/CollaborationManager.js';

const logger = createLogger('CollaborationLifecycle');

/** Structural agent surface finalizeCollaborationSessions needs. */
export interface CollaborationSessionAgentLike {
  id: string;
  collaborationManager: {
    findSessionAnywhere(collaborationId: string): { status: CollaborationStatus } | undefined;
    updateSessionStatus(collaborationId: string, status: CollaborationStatus): void;
  };
}

/**
 * Fix-15 (F-23): drive every agent's session for a collaboration to its
 * terminal status. The ACExecutor completion / coordinator cancel events
 * are the authoritative end of a collaboration, but they only reached the
 * initiator's manager — participant-side sessions stayed 'active' forever
 * (getCollaborations showed them as live rows). Idempotent: agents without
 * the session are skipped, sessions already in history are left alone.
 */
export function finalizeCollaborationSessions(
  agents: Iterable<CollaborationSessionAgentLike>,
  collaborationId: string,
  status: CollaborationStatus,
): void {
  for (const agent of agents) {
    try {
      const manager = agent.collaborationManager;
      const session = manager.findSessionAnywhere(collaborationId);
      if (!session) continue;
      if (
        session.status === CollaborationStatus.COMPLETED ||
        session.status === CollaborationStatus.FAILED ||
        session.status === CollaborationStatus.CANCELLED
      ) {
        continue; // already terminal (e.g. initiator cancelled its own)
      }
      manager.updateSessionStatus(collaborationId, status);
    } catch (error) {
      logger.warn(`Session finalize failed for agent ${agent.id} (non-fatal): ${(error as Error).message}`);
    }
  }
}

/** Structural agent surface cancelPendingACHandshakes needs. */
export interface PendingHandshakeAgentLike {
  id: string;
  cancelPendingACHandshakes(reason: string): number;
}

/**
 * BUG-07 (world-session AC handshake silent death): cancel every agent's
 * pending AC handshakes with an explicit reason (e.g. 'runtime-rebuild'
 * before a world-session runtime swap, 'runtime-stopped' from
 * EngineRuntime.stop). The cancels are emitted synchronously on the live
 * bus so the trajectory recorder, agreement bridge and session finalizers
 * all observe them — call this BEFORE stop() releases the subscriptions.
 * Idempotent; returns the total number of handshakes cancelled.
 */
export function cancelPendingACHandshakes(
  agents: Iterable<PendingHandshakeAgentLike>,
  reason: string,
): number {
  let cancelled = 0;
  for (const agent of agents) {
    try {
      cancelled += agent.cancelPendingACHandshakes(reason);
    } catch (error) {
      logger.warn(`Pending-handshake cancel failed for agent ${agent.id} (non-fatal): ${(error as Error).message}`);
    }
  }
  return cancelled;
}
