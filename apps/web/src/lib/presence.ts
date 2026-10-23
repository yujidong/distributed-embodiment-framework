/**
 * Presence reducer — applies `{kind:'presence', ...}` frames from the
 * environment stream (`/api/environments/:id/stream`) to the online roster.
 *
 * Pure functions mirroring lib/worldChange.ts: `parsePresenceMessage` is the
 * defensive wire parser (a bad frame must not kill the stream);
 * `applyPresenceMessage` reduces a frame onto the current list —
 * snapshot REPLACES the roster, online upserts by id (multi-tab users and
 * the snapshot→online overlap stay single entries), offline removes by id.
 */

import type { PresenceMessage, PresenceUserRef } from '../api/types';

function isUserRef(value: unknown): value is PresenceUserRef {
  const user = value as Partial<PresenceUserRef> | null | undefined;
  return (
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string' &&
    user.id.length > 0 &&
    typeof user.displayName === 'string'
  );
}

export function parsePresenceMessage(raw: unknown): PresenceMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as {
    kind?: unknown;
    action?: unknown;
    user?: unknown;
    users?: unknown;
    anonymousCount?: unknown;
  };
  if (message.kind !== 'presence') return null;
  if (message.action === 'snapshot') {
    if (!Array.isArray(message.users) || !message.users.every(isUserRef)) return null;
    if (typeof message.anonymousCount !== 'number' || message.anonymousCount < 0) return null;
    return message as unknown as PresenceMessage;
  }
  if (message.action === 'online' || message.action === 'offline') {
    if (!isUserRef(message.user)) return null;
    return message as unknown as PresenceMessage;
  }
  return null;
}

/** Apply a presence frame to the roster (see the file header for semantics). */
export function applyPresenceMessage(
  online: readonly PresenceUserRef[],
  message: PresenceMessage,
): PresenceUserRef[] {
  if (message.action === 'snapshot') return [...message.users];
  if (message.action === 'online') {
    return online.some(user => user.id === message.user.id)
      ? [...online]
      : [...online, message.user];
  }
  return online.filter(user => user.id !== message.user.id);
}
