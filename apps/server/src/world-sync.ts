/**
 * World sync — in-process pubsub for environment change broadcasts + presence
 *
 * Every mutation of an environment (device/agent created/updated/deleted,
 * environment patched/deleted) is published on the environment's channel;
 * the WebSocket route `GET /api/environments/:id/stream` forwards messages
 * to subscribed sockets. Concurrency model is last-write-wins + broadcast
 * (product_design.md §11.6) — no OT/CRDT.
 *
 * Presence (P2e-2): the stream route also reports each socket's join/leave,
 * tracked as userId → connection count (plus an anonymous counter for
 * unauthenticated viewers of public environments). A user's FIRST connection
 * broadcasts `{kind:'presence', action:'online'}` and their LAST disconnect
 * broadcasts `'offline'`; every new client immediately receives a private
 * `snapshot` message with the full online list. Anonymous viewers only move
 * `anonymousCount` in snapshots — they never broadcast.
 *
 * In-process by design: one server process owns all subscribers.
 *
 * Frame protocol (R84 F0-1): the frame TYPES live in
 * `@active-collaboration/shared` `stream-frames.ts` — the single source of
 * truth shared with the web client (R82-F2 根治：不再各端手写镜像).
 * Every frame leaving this module (broadcast fan-out AND the private
 * presence snapshot returned by joinPresence) is checked against the
 * registry's `validateStreamFrame`: an invalid frame THROWS under
 * NODE_ENV=test (contract tests and every route-level suite catch it
 * immediately); in production it is logged as an error and still delivered
 * (a broken frame must not block the mutation pipeline).
 */

import { createLogger, validateStreamFrame } from '@active-collaboration/shared';
import type { StreamMessage } from '@active-collaboration/shared';

// The frame contract is defined once in shared/stream-frames.ts; re-exported
// here so the existing `from './world-sync.js'` imports keep working.
export type {
  AgreementEventMessage,
  AgreementStreamAction,
  PresenceMessage,
  PresenceSnapshotMessage,
  PresenceUpdateMessage,
  PresenceUserRef,
  ProposalEventMessage,
  ProposalStreamAction,
  StreamErrorMessage,
  StreamMessage,
  WorldAction,
  WorldChangeMessage,
  WorldObjectType,
  WorldSessionStatusMessage,
} from '@active-collaboration/shared';

import type {
  AgreementStreamAction,
  PresenceSnapshotMessage,
  PresenceUserRef,
  ProposalStreamAction,
  WorldAction,
  WorldObjectType,
  WorldSessionStatusMessage,
} from '@active-collaboration/shared';

const logger = createLogger('WorldSync');

/**
 * Strictness switch (F0-1): tests must FAIL on an invalid frame, production
 * must not. Read via globalThis so this module also typechecks under the web
 * app's tsconfig (no @types/node) — the contract test imports it.
 */
function strictStreamFrameValidation(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.NODE_ENV === 'test';
}

function describeFrame(message: StreamMessage): string {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/** Registry check on an outgoing frame; see the file header for the policy. */
function assertValidFrame(message: StreamMessage): void {
  const invalid = validateStreamFrame(message);
  if (invalid === null) return;
  if (strictStreamFrameValidation()) {
    throw new Error(`WorldSync: invalid stream frame (${invalid}): ${describeFrame(message)}`);
  }
  logger.error(`invalid stream frame published (delivered anyway): ${invalid}`, describeFrame(message));
}

type StreamListener = (message: StreamMessage) => void;

interface PresenceState {
  /** userId → user + open connection count (multi-tab stays online). */
  users: Map<string, { user: PresenceUserRef; connections: number }>;
  /** Unauthenticated connections (no user broadcast, counted only). */
  anonymous: number;
}

export class WorldSync {
  private readonly channels = new Map<string, Set<StreamListener>>();
  private readonly presence = new Map<string, PresenceState>();

  /**
   * Publish a change to every subscriber of `envId` (no-op when none).
   * `actor` identifies the user who caused the change; omit it only for
   * system-driven changes.
   */
  publish(
    envId: string,
    action: WorldAction,
    objectType: WorldObjectType,
    object: unknown,
    actor?: PresenceUserRef,
  ): void {
    this.broadcast(envId, { kind: 'world', action, objectType, object, ...(actor !== undefined ? { actor } : {}) });
  }

  /**
   * Broadcast a proposal lifecycle transition (Fix-4). The actor identifies
   * the human who caused it (author on submit, owner on decide/revert).
   */
  publishProposal(
    envId: string,
    action: ProposalStreamAction,
    proposalId: string,
    actor: PresenceUserRef,
  ): void {
    this.broadcast(envId, { kind: 'proposal', action, proposalId, envId, actor });
  }

  /** Broadcast an agreement lifecycle event (Fix-16). */
  publishAgreement(
    envId: string,
    action: AgreementStreamAction,
    agreementId: string,
    actor: PresenceUserRef,
  ): void {
    this.broadcast(envId, { kind: 'agreement', action, agreementId, envId, actor });
  }

  /**
   * Living-worlds P1W: broadcast an authoritative world-session status
   * transition (ACTIVE/IDLE/HIBERNATED) on the environment's stream.
   */
  publishWorldSession(
    envId: string,
    view: {
      status: WorldSessionStatusMessage['status'];
      simTimeSec: number;
      simulationId: string;
      observers?: number;
      checkpointAtSec?: number;
      hibernatedAt?: string;
    },
  ): void {
    this.broadcast(envId, {
      kind: 'world-session',
      envId,
      status: view.status,
      simTimeSec: view.simTimeSec,
      simulationId: view.simulationId,
      ...(view.observers !== undefined ? { observers: view.observers } : {}),
      ...(view.checkpointAtSec !== undefined ? { checkpointAtSec: view.checkpointAtSec } : {}),
      ...(view.hibernatedAt !== undefined ? { hibernatedAt: view.hibernatedAt } : {}),
    });
  }

  /** Subscribe to an environment's channel; returns an unsubscribe function. */
  subscribe(envId: string, listener: StreamListener): () => void {
    let listeners = this.channels.get(envId);
    if (!listeners) {
      listeners = new Set();
      this.channels.set(envId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.channels.get(envId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.channels.delete(envId);
    };
  }

  subscriberCount(envId: string): number {
    return this.channels.get(envId)?.size ?? 0;
  }

  /** Total live stream listeners across every environment (R15-A3 metrics). */
  totalSubscribers(): number {
    let total = 0;
    for (const listeners of this.channels.values()) total += listeners.size;
    return total;
  }

  /**
   * Register one open stream connection for `user` (null = anonymous) and
   * return the snapshot to send back to that client. A user's first
   * connection broadcasts `online` to the other subscribers; `exclude` is
   * the new client's own listener (it learns the roster from the snapshot,
   * so it must not also receive its own online broadcast).
   */
  joinPresence(
    envId: string,
    user: PresenceUserRef | null,
    options: { exclude?: StreamListener } = {},
  ): PresenceSnapshotMessage {
    const state = this.stateOf(envId);
    if (user === null) {
      state.anonymous += 1;
    } else {
      const entry = state.users.get(user.id);
      if (entry) {
        entry.connections += 1;
      } else {
        state.users.set(user.id, { user, connections: 1 });
        this.broadcast(envId, { kind: 'presence', action: 'online', user }, options.exclude);
      }
    }
    const snapshot: PresenceSnapshotMessage = {
      kind: 'presence',
      action: 'snapshot',
      users: [...state.users.values()].map(entry => entry.user),
      anonymousCount: state.anonymous,
    };
    // The snapshot bypasses broadcast() (the route sends it privately), so
    // it gets its own registry check.
    assertValidFrame(snapshot);
    return snapshot;
  }

  /**
   * Register one closed stream connection. A user's LAST close broadcasts
   * `offline`; anonymous closes just decrement the counter. Idempotent-ish:
   * leaving twice for the same connection is a no-op (guarded counts).
   */
  leavePresence(envId: string, user: PresenceUserRef | null): void {
    const state = this.presence.get(envId);
    if (!state) return;
    if (user === null) {
      state.anonymous = Math.max(0, state.anonymous - 1);
    } else {
      const entry = state.users.get(user.id);
      if (entry) {
        entry.connections -= 1;
        if (entry.connections <= 0) {
          state.users.delete(user.id);
          this.broadcast(envId, { kind: 'presence', action: 'offline', user: entry.user });
        }
      }
    }
    if (state.users.size === 0 && state.anonymous === 0) {
      this.presence.delete(envId);
    }
  }

  /** Current online roster (tests + debugging). */
  presenceOf(envId: string): { users: PresenceUserRef[]; anonymousCount: number } {
    const state = this.presence.get(envId);
    return {
      users: state ? [...state.users.values()].map(entry => entry.user) : [],
      anonymousCount: state?.anonymous ?? 0,
    };
  }

  /** Fan out a stream message; a broken listener must not break the others. */
  private broadcast(envId: string, message: StreamMessage, exclude?: StreamListener): void {
    assertValidFrame(message);
    const listeners = this.channels.get(envId);
    if (!listeners) return;
    for (const listener of listeners) {
      if (listener === exclude) continue;
      try {
        listener(message);
      } catch {
        // A broken subscriber must not break the mutation or other listeners.
      }
    }
  }

  private stateOf(envId: string): PresenceState {
    let state = this.presence.get(envId);
    if (!state) {
      state = { users: new Map(), anonymous: 0 };
      this.presence.set(envId, state);
    }
    return state;
  }
}
