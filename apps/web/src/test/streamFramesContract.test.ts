/**
 * Stream-frame contract test (R84 Wave F0-1) — the three-way intersection
 * that makes R82-F2-class bugs ("server broadcasts a frame, web never
 * parses it, nobody notices") structurally impossible:
 *
 * 1. REGISTRY ⇔ SERVER: every kind in the shared registry
 *    (packages/shared/src/stream-frames.ts STREAM_FRAME_KINDS) has a real
 *    publish path — a collecting listener on a WorldSync instance captures
 *    one frame per publish method (and per action enum), and NODE_ENV=test
 *    turns on strict validation inside world-sync, so an invalid frame
 *    would throw at publish time.
 * 2. REGISTRY ⇔ WEB DISPATCH: every registered kind is either parsed by the
 *    REAL dispatch chain (lib/worldStreamRouter.parseWorldStreamFrame — the
 *    one useWorldStream runs) or listed in KNOWN_UNHANDLED_STREAM_KINDS with
 *    a reason. Exactly-one-of, both directions: a handled kind added to the
 *    known-unhandled list is also red (the list cannot go stale).
 * 3. REGISTRY ⇔ WEB TYPES: WorldStreamMessage's kind union equals
 *    StreamFrameKind (compile-time assertion — `npm run build` goes red on
 *    drift).
 *
 * Rollback verification (plan-r84 回滚验证): removing the world-session
 * branch from parseWorldStreamFrame turns section 2 red — verified during
 * the F0-1 implementation, then restored.
 */

import { describe, expect, it } from 'vitest';

import {
  AGREEMENT_STREAM_ACTIONS,
  PROPOSAL_STREAM_ACTIONS,
  STREAM_FRAME_KINDS,
  makeStreamErrorFrame,
  validateStreamFrame,
  type StreamFrameKind,
  type StreamMessage,
  type WorldSessionStatusMessage,
} from '@active-collaboration/shared';

// The server's real publish paths (pure module — no server boot needed).
import { WorldSync } from '../../../server/src/world-sync';

import type { WorldStreamMessage } from '../api/types';
import { KNOWN_UNHANDLED_STREAM_KINDS, parseWorldStreamFrame } from '../lib/worldStreamRouter';

const ACTOR = { id: 'user-1', displayName: '小A' };
const ENV_ID = 'env-1';

/** One valid sample frame per registered kind. */
const SAMPLE_FRAMES: { [K in StreamFrameKind]: Extract<StreamMessage, { kind: K }> } = {
  world: { kind: 'world', action: 'created', objectType: 'device', object: { id: 'dev-1' }, actor: ACTOR },
  presence: { kind: 'presence', action: 'online', user: ACTOR },
  proposal: { kind: 'proposal', action: 'submitted', proposalId: 'prop-1', envId: ENV_ID, actor: ACTOR },
  agreement: { kind: 'agreement', action: 'proposed', agreementId: 'agr-1', envId: ENV_ID, actor: ACTOR },
  error: makeStreamErrorFrame('STREAM_READ_ONLY', 'sample'),
  'world-session': {
    kind: 'world-session',
    envId: ENV_ID,
    status: 'active',
    simTimeSec: 12,
    simulationId: 'sim-1',
    observers: 1,
  },
};

/** Samples must themselves be valid — otherwise the test tests nothing. */
for (const [kind, frame] of Object.entries(SAMPLE_FRAMES)) {
  const invalid = validateStreamFrame(frame);
  if (invalid !== null) throw new Error(`sample frame for '${kind}' is invalid: ${invalid}`);
}

describe('F0-1 stream-frame contract: registry ⇔ server publish paths', () => {
  it('every registered kind is emitted by a real WorldSync publish path and validates', () => {
    const sync = new WorldSync();
    const collected: StreamMessage[] = [];
    sync.subscribe(ENV_ID, message => collected.push(message));

    // world frames: every action, and every objectType the server publishes
    // (including 'flow' — flows.ts / proposal-service.ts publish those).
    for (const action of ['created', 'updated', 'deleted'] as const) {
      for (const objectType of ['device', 'agent', 'environment', 'service', 'flow'] as const) {
        sync.publish(ENV_ID, action, objectType, { id: 'obj-1' }, ACTOR);
      }
    }
    // world frames without an actor (system-driven twin-sync writes).
    sync.publish(ENV_ID, 'updated', 'device', { id: 'obj-2' });

    // governance frames: the full action enums, not just a sample.
    for (const action of PROPOSAL_STREAM_ACTIONS) {
      sync.publishProposal(ENV_ID, action, 'prop-1', ACTOR);
    }
    for (const action of AGREEMENT_STREAM_ACTIONS) {
      sync.publishAgreement(ENV_ID, action, 'agr-1', ACTOR);
    }

    // world-session frames: the live states and the hibernated shape.
    sync.publishWorldSession(ENV_ID, { status: 'active', simTimeSec: 1, simulationId: 'sim-1', observers: 2 });
    sync.publishWorldSession(ENV_ID, { status: 'idle', simTimeSec: 2, simulationId: 'sim-1', observers: 0 });
    sync.publishWorldSession(ENV_ID, {
      status: 'hibernated',
      simTimeSec: 3,
      simulationId: 'sim-1',
      checkpointAtSec: 3,
      hibernatedAt: '2026-01-01T00:00:00Z',
    });

    // presence frames: online broadcast + private snapshot + offline.
    sync.joinPresence(ENV_ID, ACTOR); // first connection broadcasts 'online'
    const snapshot = sync.joinPresence(ENV_ID, { id: 'user-2', displayName: '小B' });
    collected.push(snapshot); // returned privately, bypasses broadcast()
    sync.leavePresence(ENV_ID, { id: 'user-2', displayName: '小B' }); // last close broadcasts 'offline'

    // error frames are constructed inline by the stream route via the shared
    // builder (T-007 receive-only teaching frame) — no WorldSync path.
    const errorFrame = makeStreamErrorFrame('STREAM_READ_ONLY', 'teaching');
    collected.push(errorFrame);

    // Strict validation (NODE_ENV=test) already threw on any invalid frame;
    // assert explicitly so the intent is visible in the test body.
    for (const frame of collected) {
      expect(validateStreamFrame(frame)).toBeNull();
    }

    const publishedKinds = new Set(collected.map(frame => frame.kind));
    expect([...publishedKinds].sort()).toEqual([...STREAM_FRAME_KINDS].sort());
  });

  it('strict mode rejects an invalid frame at publish time (the guard bites)', () => {
    const sync = new WorldSync();
    sync.subscribe(ENV_ID, () => undefined);
    expect(() =>
      sync.publish(ENV_ID, 'created', 'galaxy' as never, { id: 'obj-1' }, ACTOR),
    ).toThrow(/invalid stream frame/);
    expect(validateStreamFrame({ kind: 'nope' })).toMatch(/unknown stream frame kind/);
  });
});

describe('F0-1 stream-frame contract: registry ⇔ web dispatch', () => {
  it('every registered kind is parsed by the real dispatch chain or explicitly known-unhandled', () => {
    for (const kind of STREAM_FRAME_KINDS) {
      const parsed = parseWorldStreamFrame(SAMPLE_FRAMES[kind]);
      if (KNOWN_UNHANDLED_STREAM_KINDS.includes(kind)) {
        // Documented non-handling (see worldStreamRouter.ts for the reasons):
        // the dispatch chain must NOT accidentally parse it.
        expect(parsed, `kind '${kind}' is listed known-unhandled but the dispatch chain parses it — shrink the list`).toBeNull();
      } else {
        expect(
          parsed?.kind,
          `kind '${kind}' is registered but the web client neither parses it nor lists it as known-unhandled (R82-F2 class)`,
        ).toBe(kind);
      }
    }
  });

  it('the known-unhandled list cannot drift off the registry', () => {
    for (const kind of KNOWN_UNHANDLED_STREAM_KINDS) {
      expect(STREAM_FRAME_KINDS, `'${kind}' is not a registered kind`).toContain(kind);
    }
  });

  it('unknown future kinds are explicitly ignored, never misparsed (additive contract)', () => {
    expect(parseWorldStreamFrame({ kind: 'future-kind', payload: 1 })).toBeNull();
    expect(parseWorldStreamFrame('not even an object')).toBeNull();
  });
});

describe('F0-1 stream-frame contract: registry ⇔ web types', () => {
  it('WorldStreamMessage kind union equals the registry kind set', () => {
    // Runtime half: registered kinds = dispatched ∪ known-unhandled (checked
    // above); the compile-time half below fails `npm run build` on drift.
    type Equals<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const unionMatchesRegistry: Equals<WorldStreamMessage['kind'], StreamFrameKind> = true;
    expect(unionMatchesRegistry).toBe(true);

    // And the shared WorldSessionStatusMessage shape is what the web parser
    // accepts (statuses + required fields).
    const session: WorldSessionStatusMessage = SAMPLE_FRAMES['world-session'];
    expect(parseWorldStreamFrame(session)?.kind).toBe('world-session');
  });
});
