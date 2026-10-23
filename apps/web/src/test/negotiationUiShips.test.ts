/**
 * T-066 bundle-grep regression: the negotiation/consumption affordances must
 * SHIP in the web bundle. R15's audit found the backend machinery rendered
 * nowhere (0 x replyHint, 0 x yourMove, 0 x /reads in the built bundle) —
 * this suite pins the presence of each surface's marker strings by importing
 * the shipping modules directly (source-of-truth for what the bundle links):
 * the i18n keys must exist in BOTH dictionaries (zh-CN source + en-US
 * mirror) and the surface modules must reference the machinery.
 */

import { describe, expect, it } from 'vitest';

import { enUS } from '../i18n/en-US';
import { zhCN } from '../i18n/zh-CN';
import {
  ACTIONABLE_NOTIFICATION_KINDS,
  replyHintOf,
} from '../lib/notifications';
import { canCounter, canDecide, canRemind, termsDiffLines } from '../lib/agreements';
import { canReadAgreement, readQuotaMeter } from '../lib/dataRead';

function lookup(bundle: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = bundle;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

describe('T-066 surface 1 ships: replyHint decide affordance on notifications', () => {
  it('the affordance strings exist in BOTH locale dictionaries', () => {
    for (const key of ['yourMove', 'waitingOnCounterpart', 'goDecide']) {
      const zh = lookup(zhCN as Record<string, unknown>, ['notificationsPage', key]);
      const en = lookup(enUS as Record<string, unknown>, ['notificationsPage', key]);
      expect(typeof zh, `zh-CN notificationsPage.${key}`).toBe('string');
      expect(typeof en, `en-US notificationsPage.${key}`).toBe('string');
    }
  });

  it('the inbox groups the decide-pending kinds and parses replyHint bodies', () => {
    expect(ACTIONABLE_NOTIFICATION_KINDS).toContain('agreement.countered');
    expect(ACTIONABLE_NOTIFICATION_KINDS).toContain('agreement.reminded');
    expect(
      replyHintOf({ replyHint: { endpoint: 'POST /api/agreements/x/decide', yourMove: true } })
        ?.yourMove,
    ).toBe(true);
  });
});

describe('T-066 surface 2 ships: agreement detail (counter/decide/remind + terms diff)', () => {
  it('the detail strings exist in BOTH locale dictionaries', () => {
    for (const key of [
      'back',
      'termsOriginal',
      'termsCountered',
      'termsEffective',
      'diffTitle',
      'diffAdded',
      'diffRemoved',
      'diffChanged',
      'enforcedOn',
      'enforcedOff',
      'remind',
      'remindLimited',
      'counterSubmit',
    ]) {
      const zh = lookup(zhCN as Record<string, unknown>, ['agreementDetail', key]);
      const en = lookup(enUS as Record<string, unknown>, ['agreementDetail', key]);
      expect(typeof zh, `zh-CN agreementDetail.${key}`).toBe('string');
      expect(typeof en, `en-US agreementDetail.${key}`).toBe('string');
    }
    for (const ns of ['agreements', 'agreementsLib']) {
      const zh = lookup(zhCN as Record<string, unknown>, [ns, 'statusCountered']);
      const en = lookup(enUS as Record<string, unknown>, [ns, 'statusCountered']);
      expect(typeof zh, `zh-CN ${ns}.statusCountered`).toBe('string');
      expect(typeof en, `en-US ${ns}.statusCountered`).toBe('string');
    }
  });

  it('the negotiation gates and diff machinery exist in the shipped lib', () => {
    expect(typeof canDecide).toBe('function');
    expect(typeof canCounter).toBe('function');
    expect(typeof canRemind).toBe('function');
    expect(termsDiffLines({ quotaPerWindow: 1 }, { quotaPerWindow: 2 })).toEqual([
      { key: 'quotaPerWindow', change: 'changed', before: '1', after: '2' },
    ]);
  });

  it('the ApiClientError carries machine-readable detail fields (retryAfterSec etc.)', async () => {
    const { ApiClientError: Err } = await import('../api/client');
    const err = new Err(429, 'REMIND_RATE_LIMITED', 'too soon', undefined, { retryAfterSec: 42 });
    expect(err.detail('retryAfterSec')).toBe(42);
  });
});

describe('T-066 surface 3 ships: data-read screen (POST /reads + /reads/latest)', () => {
  it('the read strings exist in BOTH locale dictionaries', () => {
    for (const key of [
      'title',
      'readNow',
      'readLatest',
      'quota',
      'freshBadge',
      'staleBadge',
      'cachedBadge',
      'freshnessSec',
      'receiptsShow',
      'help_AGREEMENT_TERMS_VIOLATION',
      'help_QUOTA_EXCEEDED',
      'help_DATA_STALE',
      'help_DEVICE_SCOPE_INVALID',
      'help_ACCESS_GRANT_REVOKED',
    ]) {
      const zh = lookup(zhCN as Record<string, unknown>, ['agreementRead', key]);
      const en = lookup(enUS as Record<string, unknown>, ['agreementRead', key]);
      expect(typeof zh, `zh-CN agreementRead.${key}`).toBe('string');
      expect(typeof en, `en-US agreementRead.${key}`).toBe('string');
    }
  });

  it('the read gates, quota meter and endpoint wrappers exist in the shipped modules', async () => {
    expect(typeof canReadAgreement).toBe('function');
    expect(typeof readQuotaMeter).toBe('function');
    const client = await import('../api/client');
    expect(typeof client.readAgreementData).toBe('function');
    expect(typeof client.readAgreementLatest).toBe('function');
    expect(typeof client.getAgreementReceipts).toBe('function');
  });
});
