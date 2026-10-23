/**
 * World-stream frame router (R84 F0-1) — the single dispatch chain every
 * frame of `GET /api/environments/:id/stream` passes through. Extracted from
 * useWorldStream so the contract test
 * (src/test/streamFramesContract.test.ts) exercises the REAL dispatch order,
 * not a copy of it.
 *
 * Compatibility contract (additive kinds): a frame whose `kind` this client
 * does not know is IGNORED — old clients must never misparse new frames.
 * The failure mode this guards against is the opposite one (R82-F2): the
 * SERVER registering a kind the client silently drops forever. Every
 * registered kind (shared STREAM_FRAME_KINDS) is therefore either parsed
 * here or listed in KNOWN_UNHANDLED_STREAM_KINDS with a reason — the
 * contract test asserts exactly-one-of, so "发了没人认" turns CI red.
 */

import type { StreamFrameKind } from '@active-collaboration/shared';

import type { WorldStreamMessage } from '../api/types';
import { parsePresenceMessage } from './presence';
import { parseWorldMessage, parseWorldSessionMessage } from './worldChange';

/**
 * Registered frame kinds this client DELIBERATELY does not dispatch:
 * - 'proposal' / 'agreement' — governance frames; the web surfaces them
 *   through the activity feed / notifications (REST + polls), the live
 *   stream handling was never built for them;
 * - 'error' — T-007 teaching frame for clients that SEND on the
 *   receive-only stream; browsers never trigger it.
 *
 * Shrinking this list (implementing a kind) is always safe; growing it
 * requires a comment justifying why the frame is safe to ignore.
 */
export const KNOWN_UNHANDLED_STREAM_KINDS: readonly StreamFrameKind[] = [
  'proposal',
  'agreement',
  'error',
];

/**
 * Parse one raw stream frame into the typed union, or null when the frame
 * is malformed, of a known-unhandled kind, or of a kind this client version
 * does not know yet (additive-compat ignore). Dispatch order matters: each
 * parser gates on its own `kind`, so order is about cost only.
 */
export function parseWorldStreamFrame(raw: unknown): WorldStreamMessage | null {
  const worldMessage = parseWorldMessage(raw);
  if (worldMessage) return worldMessage;
  // R82 fix: world-session creation/status frames update world.worldSession
  // — without this the「进入世界仿真」entry only existed for sessions
  // present at page load.
  const sessionMessage = parseWorldSessionMessage(raw);
  if (sessionMessage) return sessionMessage;
  const presenceMessage = parsePresenceMessage(raw);
  if (presenceMessage) return presenceMessage;
  return null;
}
