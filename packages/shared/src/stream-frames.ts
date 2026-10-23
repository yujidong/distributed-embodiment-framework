/**
 * Stream-frame protocol registry (R84 Wave F0-1) — the single source of
 * truth for the frames of the environment realtime stream
 * `GET /api/environments/:id/stream` (WebSocket).
 *
 * History: R82-F2 — the server had been broadcasting `{kind:'world-session'}`
 * frames for a long time while the web client never parsed them, and nothing
 * noticed. Root cause: the stream protocol had no contract — frame shapes
 * lived as literals on the server and as a hand-maintained mirror union on
 * the web. This module kills that class of bug structurally:
 *
 * - both sides import the SAME frame types from here (no more mirrors);
 * - `validateStreamFrame` is a hand-written, zero-dependency validator per
 *   frame kind (the repo convention for wire parsing is defensive hand-rolled
 *   checks, not a JSON-Schema runtime);
 * - `STREAM_FRAME_KINDS` enumerates every registered kind so contract tests
 *   can assert the three-way intersection: registered ⇔ server-published ⇔
 *   web-parsed (or explicitly listed as known-unhandled).
 *
 * Compatibility contract: adding a frame kind is ADDITIVE — older clients
 * must ignore unknown kinds (they never misparse them); removing or
 * repurposing a kind is a breaking change.
 */

export type WorldAction = 'created' | 'updated' | 'deleted';
export type WorldObjectType = 'device' | 'agent' | 'environment' | 'service' | 'flow';

export interface PresenceUserRef {
  id: string;
  displayName: string;
}

export interface WorldChangeMessage {
  kind: 'world';
  action: WorldAction;
  objectType: WorldObjectType;
  /** The affected object (API JSON shape), or `{id}` for deletions. */
  object: unknown;
  /**
   * Who caused the change (Fix-1 unified change pipeline). Absent for
   * system-driven changes (twin-sync observation writes) and for messages
   * published before this field existed — subscribers must treat it as
   * optional.
   */
  actor?: PresenceUserRef;
}

export interface PresenceUpdateMessage {
  kind: 'presence';
  action: 'online' | 'offline';
  user: PresenceUserRef;
}

export interface PresenceSnapshotMessage {
  kind: 'presence';
  action: 'snapshot';
  users: PresenceUserRef[];
  /** Unauthenticated viewers connected to this environment. */
  anonymousCount: number;
}

export type PresenceMessage = PresenceUpdateMessage | PresenceSnapshotMessage;

/**
 * Governance events (Fix-4, RC-4): proposal lifecycle transitions broadcast
 * on the environment stream so the owner sees a todo (escalated) and the
 * author sees the verdict in real time instead of polling. `action` is the
 * state the proposal transitioned INTO; the internal funnel steps
 * (rule_check / ai_review) never appear — `submitted` covers the creation.
 */
export type ProposalStreamAction =
  | 'submitted'
  | 'escalated'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'reverted';

export const PROPOSAL_STREAM_ACTIONS: readonly ProposalStreamAction[] = [
  'submitted',
  'escalated',
  'approved',
  'rejected',
  'applied',
  'reverted',
];

export interface ProposalEventMessage {
  kind: 'proposal';
  action: ProposalStreamAction;
  proposalId: string;
  envId: string;
  /** Who caused the transition: the author on submit, the owner on decide. */
  actor: PresenceUserRef;
}

/**
 * Agreement lifecycle events (Fix-16): the service-consumption counterparts
 * of the Fix-4 governance events. `action` is the transition that just
 * happened — 'proposed' on creation, 'accepted'/'rejected' on the provider's
 * decide (or the CONSUMER's decide of a counter-offer, T-059), 'countered'
 * when the provider answers a proposal with new terms, 'held'/'resumed' on
 * the consumer's bounded pause (D3, T-080), 'suspended'/'terminated' on the
 * later lifecycle moves, and 'invoked' for each consumption act (success and
 * failure alike — stream consumers that care fetch the usage records).
 *
 * T-049: 'deleted' announces an agreement DESTROYED by a cascade;
 * 'restored' announces a remove-agents revert re-linking it by id.
 * v60 (R6-E-F08): removing a provider agent no longer destroys its
 * agreements — the retire transitions broadcast their LANDED state
 * (suspended / rejected / terminated, status_reason 'provider-unavailable')
 * instead. R100 (agreement-row-integrity): SERVICE-row deletion (T-403
 * derivation regeneration, device removal, blueprint uninstall) retires
 * the same way (status_reason 'service-unavailable') — no code path emits
 * 'deleted' any more; the action stays in the enum for consumer
 * compatibility. 'restored' marks the remove-agents revert's relink
 * (references restored, status stays retired — no suspended → active
 * edge exists).
 */
export type AgreementStreamAction =
  | 'proposed'
  | 'countered'
  | 'accepted'
  | 'rejected'
  | 'held'
  | 'resumed'
  | 'suspended'
  | 'terminated'
  | 'invoked'
  | 'deleted'
  | 'restored';

export const AGREEMENT_STREAM_ACTIONS: readonly AgreementStreamAction[] = [
  'proposed',
  'countered',
  'accepted',
  'rejected',
  'held',
  'resumed',
  'suspended',
  'terminated',
  'invoked',
  'deleted',
  'restored',
];

export interface AgreementEventMessage {
  kind: 'agreement';
  action: AgreementStreamAction;
  agreementId: string;
  envId: string;
  /** Who caused it: consumer on propose/invoke, provider on decide/suspend. */
  actor: PresenceUserRef;
}

/**
 * Server-level stream error (T-007): sent when a client does something the
 * stream cannot act on — e.g. sending data on the receive-only world stream.
 * `code` is a stable machine string ('STREAM_READ_ONLY', …); `message`
 * teaches the client where the intent actually belongs (REST endpoints).
 */
export interface StreamErrorMessage {
  kind: 'error';
  code: string;
  message: string;
}

/** Build a well-formed `{kind:'error'}` teaching frame (T-007). */
export function makeStreamErrorFrame(code: string, message: string): StreamErrorMessage {
  return { kind: 'error', code, message };
}

/**
 * Living-worlds P1W: authoritative world-session lifecycle transitions on
 * the env stream (the same broadcast channel the world's governance frames
 * ride). Additive `kind` — readers that do not know it ignore it (older
 * clients simply miss session status, they never misparse it).
 */
export interface WorldSessionStatusMessage {
  kind: 'world-session';
  envId: string;
  status: 'active' | 'idle' | 'hibernated';
  simTimeSec: number;
  simulationId: string;
  observers?: number;
  checkpointAtSec?: number;
  hibernatedAt?: string;
}

export const WORLD_SESSION_STATUSES: readonly WorldSessionStatusMessage['status'][] = [
  'active',
  'idle',
  'hibernated',
];

/** Any message forwarded on an environment stream socket. */
export type StreamMessage =
  | WorldChangeMessage
  | PresenceMessage
  | ProposalEventMessage
  | AgreementEventMessage
  | StreamErrorMessage
  | WorldSessionStatusMessage;

export type StreamFrameKind = StreamMessage['kind'];

/**
 * Every registered frame kind of the environment stream. The contract test
 * (apps/web/src/test/streamFramesContract.test.ts) asserts the three-way
 * intersection over this list: the server publishes each kind, and the web
 * client either parses it or lists it in KNOWN_UNHANDLED_STREAM_KINDS.
 */
export const STREAM_FRAME_KINDS: readonly StreamFrameKind[] = [
  'world',
  'presence',
  'proposal',
  'agreement',
  'error',
  'world-session',
];

export function isStreamFrameKind(kind: unknown): kind is StreamFrameKind {
  return typeof kind === 'string' && (STREAM_FRAME_KINDS as readonly string[]).includes(kind);
}

const WORLD_ACTIONS: readonly WorldAction[] = ['created', 'updated', 'deleted'];
const WORLD_OBJECT_TYPES: readonly WorldObjectType[] = [
  'device',
  'agent',
  'environment',
  'service',
  'flow',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isUserRef(value: unknown): value is PresenceUserRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.displayName === 'string'
  );
}

function isOptionalUserRef(value: unknown): boolean {
  return value === undefined || isUserRef(value);
}

function validateWorldFrame(frame: Record<string, unknown>): string | null {
  if (!WORLD_ACTIONS.includes(frame.action as WorldAction)) {
    return `world.action must be one of ${WORLD_ACTIONS.join('|')}`;
  }
  if (!WORLD_OBJECT_TYPES.includes(frame.objectType as WorldObjectType)) {
    return `world.objectType must be one of ${WORLD_OBJECT_TYPES.join('|')}`;
  }
  if (!isRecord(frame.object)) return 'world.object must be an object';
  if (!isOptionalUserRef(frame.actor)) return 'world.actor must be a user ref when present';
  return null;
}

function validatePresenceFrame(frame: Record<string, unknown>): string | null {
  if (frame.action === 'snapshot') {
    if (!Array.isArray(frame.users) || !frame.users.every(isUserRef)) {
      return 'presence.users must be an array of user refs';
    }
    if (typeof frame.anonymousCount !== 'number' || frame.anonymousCount < 0) {
      return 'presence.anonymousCount must be a non-negative number';
    }
    return null;
  }
  if (frame.action === 'online' || frame.action === 'offline') {
    if (!isUserRef(frame.user)) return 'presence.user must be a user ref';
    return null;
  }
  return "presence.action must be 'online'|'offline'|'snapshot'";
}

function validateProposalFrame(frame: Record<string, unknown>): string | null {
  if (!PROPOSAL_STREAM_ACTIONS.includes(frame.action as ProposalStreamAction)) {
    return `proposal.action must be one of ${PROPOSAL_STREAM_ACTIONS.join('|')}`;
  }
  if (!isNonEmptyString(frame.proposalId)) return 'proposal.proposalId must be a non-empty string';
  if (!isNonEmptyString(frame.envId)) return 'proposal.envId must be a non-empty string';
  if (!isUserRef(frame.actor)) return 'proposal.actor must be a user ref';
  return null;
}

function validateAgreementFrame(frame: Record<string, unknown>): string | null {
  if (!AGREEMENT_STREAM_ACTIONS.includes(frame.action as AgreementStreamAction)) {
    return `agreement.action must be one of ${AGREEMENT_STREAM_ACTIONS.join('|')}`;
  }
  if (!isNonEmptyString(frame.agreementId)) return 'agreement.agreementId must be a non-empty string';
  if (!isNonEmptyString(frame.envId)) return 'agreement.envId must be a non-empty string';
  if (!isUserRef(frame.actor)) return 'agreement.actor must be a user ref';
  return null;
}

function validateErrorFrame(frame: Record<string, unknown>): string | null {
  if (!isNonEmptyString(frame.code)) return 'error.code must be a non-empty string';
  if (typeof frame.message !== 'string') return 'error.message must be a string';
  return null;
}

function validateWorldSessionFrame(frame: Record<string, unknown>): string | null {
  if (!isNonEmptyString(frame.envId)) return 'world-session.envId must be a non-empty string';
  if (!WORLD_SESSION_STATUSES.includes(frame.status as WorldSessionStatusMessage['status'])) {
    return `world-session.status must be one of ${WORLD_SESSION_STATUSES.join('|')}`;
  }
  if (typeof frame.simTimeSec !== 'number' || !Number.isFinite(frame.simTimeSec)) {
    return 'world-session.simTimeSec must be a finite number';
  }
  if (!isNonEmptyString(frame.simulationId)) {
    return 'world-session.simulationId must be a non-empty string';
  }
  if (frame.observers !== undefined && typeof frame.observers !== 'number') {
    return 'world-session.observers must be a number when present';
  }
  if (frame.checkpointAtSec !== undefined && typeof frame.checkpointAtSec !== 'number') {
    return 'world-session.checkpointAtSec must be a number when present';
  }
  if (frame.hibernatedAt !== undefined && typeof frame.hibernatedAt !== 'string') {
    return 'world-session.hibernatedAt must be a string when present';
  }
  return null;
}

/**
 * Validate a frame against the registered shape of its `kind`. Returns null
 * when valid, otherwise a human-readable reason (test failure messages and
 * production error logs consume it). An UNKNOWN kind is a contract violation
 * here — the additive-compatibility rule (ignore unknown kinds) applies to
 * READERS, not to the server that emits frames.
 */
export function validateStreamFrame(frame: unknown): string | null {
  if (!isRecord(frame)) return 'frame must be an object';
  switch (frame.kind) {
    case 'world':
      return validateWorldFrame(frame);
    case 'presence':
      return validatePresenceFrame(frame);
    case 'proposal':
      return validateProposalFrame(frame);
    case 'agreement':
      return validateAgreementFrame(frame);
    case 'error':
      return validateErrorFrame(frame);
    case 'world-session':
      return validateWorldSessionFrame(frame);
    default:
      return `unknown stream frame kind: ${String(frame.kind)}`;
  }
}
