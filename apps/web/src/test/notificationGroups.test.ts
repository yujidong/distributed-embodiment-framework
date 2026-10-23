/**
 * B3 notification grouping (lib/notifications): the「需要我处理」bucket is
 * kind-based — proposal.escalated + agreement.proposed (inbound requests
 * waiting on the recipient's decision), plus the T-059 decide-pending kinds
 * (agreement.countered / agreement.reminded arrive exactly when the
 * recipient's move is pending). Pure-function coverage for the bucketing,
 * the unread badge count, and the replyHint body parser (T-066 surface 1).
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIONABLE_NOTIFICATION_KINDS,
  bucketNotifications,
  isActionableNotification,
  replyHintOf,
} from '../lib/notifications';

function row(kind: string, readAt: string | null = null) {
  return { id: `${kind}-${readAt ?? 'unread'}`, kind, readAt };
}

describe('isActionableNotification', () => {
  it('matches exactly the inbound-request kinds', () => {
    expect(isActionableNotification('proposal.escalated')).toBe(true);
    expect(isActionableNotification('agreement.proposed')).toBe(true);
    expect(isActionableNotification('agreement.countered')).toBe(true);
    expect(isActionableNotification('agreement.reminded')).toBe(true);
    expect(ACTIONABLE_NOTIFICATION_KINDS).toHaveLength(4);
  });

  it('rejects outcome/echo kinds', () => {
    for (const kind of [
      'proposal.applied',
      'proposal.rejected',
      'agreement.accepted',
      'agreement.rejected',
      'agreement.terminated',
      'collaboration.accepted',
      'collaboration.rejected',
      '',
    ]) {
      expect(isActionableNotification(kind)).toBe(false);
    }
  });
});

describe('bucketNotifications', () => {
  it('splits actionable kinds out, preserving input order', () => {
    const inbox = [
      row('agreement.accepted'),
      row('proposal.escalated'),
      row('agreement.proposed', '2026-01-02T00:00:00Z'),
      row('collaboration.accepted'),
    ];
    const { actionable, actionableUnread } = bucketNotifications(inbox);
    expect(actionable.map(n => n.kind)).toEqual(['proposal.escalated', 'agreement.proposed']);
    // Only the unread actionable row counts toward the tab badge.
    expect(actionableUnread).toBe(1);
  });

  it('handles an empty inbox', () => {
    const { actionable, actionableUnread } = bucketNotifications([]);
    expect(actionable).toEqual([]);
    expect(actionableUnread).toBe(0);
  });

  it('counts every unread actionable row', () => {
    const inbox = [row('proposal.escalated'), row('agreement.proposed'), row('agreement.accepted')];
    expect(bucketNotifications(inbox).actionableUnread).toBe(2);
  });
});

describe('replyHintOf (T-066 surface 1)', () => {
  it('parses the machine-readable decide hint', () => {
    expect(
      replyHintOf({
        agreementId: 'ag-1',
        replyHint: {
          endpoint: 'POST /api/agreements/ag-1/decide',
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      }),
    ).toEqual({
      endpoint: 'POST /api/agreements/ag-1/decide',
      allowedDecisions: ['accept', 'reject'],
      yourMove: true,
    });
  });

  it('renders the waiting state when the move is not the recipient\'s', () => {
    const hint = replyHintOf({
      replyHint: { endpoint: 'POST /api/agreements/ag-1/decide', yourMove: false },
    });
    expect(hint).not.toBeNull();
    expect(hint?.yourMove).toBe(false);
    expect(hint?.allowedDecisions).toEqual([]);
  });

  it('older/unknown notification bodies read as "no hint"', () => {
    expect(replyHintOf({})).toBeNull();
    expect(replyHintOf({ replyHint: null })).toBeNull();
    expect(replyHintOf({ replyHint: 'decide!' })).toBeNull();
    expect(replyHintOf({ replyHint: { allowedDecisions: ['accept'] } })).toBeNull();
    expect(
      replyHintOf({ replyHint: { endpoint: 42, allowedDecisions: 'accept', yourMove: 'yes' } }),
    ).toBeNull();
  });
});
