/**
 * Stream-frame registry unit tests (R84 F0-1) — validator semantics per
 * frame kind. The end-to-end three-way contract (registry ⇔ server publish
 * paths ⇔ web dispatch) lives in apps/web/src/test/streamFramesContract.
 */

import { describe, expect, it } from 'vitest';

import {
  STREAM_FRAME_KINDS,
  isStreamFrameKind,
  makeStreamErrorFrame,
  validateStreamFrame,
  type StreamMessage,
} from './stream-frames';

const ACTOR = { id: 'u1', displayName: 'U' };

function validFrames(): StreamMessage[] {
  return [
    { kind: 'world', action: 'created', objectType: 'device', object: { id: 'd1' } },
    { kind: 'world', action: 'deleted', objectType: 'flow', object: { id: 'f1' }, actor: ACTOR },
    { kind: 'presence', action: 'online', user: ACTOR },
    { kind: 'presence', action: 'snapshot', users: [ACTOR], anonymousCount: 2 },
    { kind: 'proposal', action: 'escalated', proposalId: 'p1', envId: 'e1', actor: ACTOR },
    { kind: 'agreement', action: 'invoked', agreementId: 'a1', envId: 'e1', actor: ACTOR },
    makeStreamErrorFrame('STREAM_READ_ONLY', 'teaching'),
    {
      kind: 'world-session',
      envId: 'e1',
      status: 'hibernated',
      simTimeSec: 3,
      simulationId: 's1',
      checkpointAtSec: 3,
      hibernatedAt: '2026-01-01T00:00:00Z',
    },
  ];
}

describe('stream-frames registry', () => {
  it('accepts one valid frame per registered kind', () => {
    const frames = validFrames();
    for (const frame of frames) expect(validateStreamFrame(frame)).toBeNull();
    expect(new Set(frames.map(f => f.kind))).toEqual(new Set(STREAM_FRAME_KINDS));
  });

  it('rejects malformed frames with a readable reason', () => {
    expect(validateStreamFrame(null)).toMatch(/object/);
    expect(validateStreamFrame({ kind: 'nope' })).toMatch(/unknown stream frame kind/);
    expect(validateStreamFrame({ kind: 'world', action: 'created', objectType: 'galaxy', object: {} }))
      .toMatch(/objectType/);
    expect(validateStreamFrame({ kind: 'world', action: 'created', objectType: 'device' }))
      .toMatch(/object/);
    expect(validateStreamFrame({ kind: 'presence', action: 'online' })).toMatch(/user/);
    expect(
      validateStreamFrame({ kind: 'presence', action: 'snapshot', users: [], anonymousCount: -1 }),
    ).toMatch(/anonymousCount/);
    expect(validateStreamFrame({ kind: 'proposal', action: 'submitted', proposalId: '', envId: 'e1', actor: ACTOR }))
      .toMatch(/proposalId/);
    expect(validateStreamFrame({ kind: 'agreement', action: 'zapped', agreementId: 'a1', envId: 'e1', actor: ACTOR }))
      .toMatch(/action/);
    expect(validateStreamFrame({ kind: 'error', code: '', message: 'x' })).toMatch(/code/);
    expect(
      validateStreamFrame({ kind: 'world-session', envId: 'e1', status: 'active', simTimeSec: Number.NaN, simulationId: 's1' }),
    ).toMatch(/simTimeSec/);
  });

  it('isStreamFrameKind gates on the registry', () => {
    for (const kind of STREAM_FRAME_KINDS) expect(isStreamFrameKind(kind)).toBe(true);
    expect(isStreamFrameKind('nope')).toBe(false);
    expect(isStreamFrameKind(undefined)).toBe(false);
  });
});
