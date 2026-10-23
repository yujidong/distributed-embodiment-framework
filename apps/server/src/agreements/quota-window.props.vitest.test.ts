/**
 * @vitest-environment node
 *
 * Wave F2-1 (docs/plan-r84-verification-framework.md): fast-check property
 * tests for the T-205 consumption-quota window (terms.quotaPerWindow /
 * windowSec / windowKind, sliding | fixed).
 *
 * The chain under test is the REAL one both invoke lanes share:
 *   consumptionQuotaStatus (agreements/terms.ts — the gate, extracted in
 *   Wave F2-1 so the manual 429 lane and the trigger skip lane cannot
 *   drift) → quotaWindowStartIso → AgreementStore.countUsageSince
 *   (outcome='success' only, T-205 "failures never count").
 *
 *   P1 universal sequence property: under ANY interleaving of successful /
 *      failed / partial invocations at arbitrary times, with the gate
 *      enforced (spent → the invoke is rejected and meters nothing), the
 *      success count inside the current window NEVER exceeds quotaPerWindow;
 *      and the store count always equals the oracle computed from the event
 *      log (window start per sliding/fixed semantics, successes only).
 *      Rollback check: neutralizing the `spent` comparison in
 *      consumptionQuotaStatus turns this property red.
 *   P2 window-start math: sliding = trailing windowSec; fixed = tumbling
 *      windows anchored at updated_at, with clock skew clamped.
 *   P3 boundary semantics: sliding counts a row exactly at now-windowSec
 *      (>= comparison) and forgets it 1ms later; fixed refills quota at the
 *      exact tumbling boundary.
 *
 * Time is fully deterministic: vi fake timers drive Date.now() (read by
 * quotaWindowStartIso), and usage rows carry explicit startedAt stamps.
 */

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumptionQuotaStatus,
  quotaWindowStartIso,
} from './terms.js';
import {
  AgreementStore,
  type AgreementRow,
  type AgreementTerms,
  type UsageOutcome,
} from '../db/agreement-store.js';
import { openDatabase, type EafDatabase } from '../db/database.js';

let db: EafDatabase;
let store: AgreementStore;

beforeAll(() => {
  db = openDatabase(':memory:');
  // The quota semantics under test do not involve referential integrity;
  // stub agreement rows reference no environments/services.
  db.pragma('foreign_keys = OFF');
  store = new AgreementStore(db);
});

// Close the native SQLite handle — a leaked one can access-violate
// (0xC0000005) at worker-thread teardown and kill the threads-pool runner.
afterAll(() => {
  db.close();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const quotaArb = fc.integer({ min: 1, max: 5 });
const windowSecArb = fc.integer({ min: 10, max: 3600 });
const windowKindArb = fc.constantFrom('sliding', 'fixed') as fc.Arbitrary<'sliding' | 'fixed'>;
const anchorArb = fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 });
const outcomeArb = fc.constantFrom<UsageOutcome>('success', 'failure', 'partial');

interface ConsumeEvent {
  /** ms to advance the clock before this invocation attempt. */
  deltaMs: number;
  outcome: UsageOutcome;
}

function eventsArb(windowSec: number): fc.Arbitrary<ConsumeEvent[]> {
  return fc.array(
    fc.record({
      deltaMs: fc.integer({ min: 0, max: 3 * windowSec * 1000 }),
      outcome: outcomeArb,
    }),
    { minLength: 1, maxLength: 24 },
  );
}

let agreementSeq = 0;

/** A fresh ACTIVE agreement whose updated_at (= fixed-window anchor) is `anchorMs`. */
function makeAgreement(terms: AgreementTerms, anchorMs: number): AgreementRow {
  vi.setSystemTime(anchorMs);
  agreementSeq += 1;
  return store.createAgreement({
    envId: 'env-quota-props',
    serviceId: `svc-${agreementSeq}`,
    consumerAgentId: null,
    consumerOwnerId: 'consumer-user',
    providerAgentId: 'provider-agent',
    providerOwnerId: 'provider-user',
    terms,
    status: 'active',
  });
}

function appendUsageAt(agreement: AgreementRow, t: number, outcome: UsageOutcome): void {
  const iso = new Date(t).toISOString();
  store.appendUsage({
    agreementId: agreement.id,
    envId: agreement.env_id,
    consumerAgentId: agreement.consumer_agent_id,
    providerAgentId: agreement.provider_agent_id,
    kind: 'invoke',
    action: 'run',
    quantity: 1,
    unit: 'action',
    outcome,
    startedAt: iso,
    endedAt: iso,
  });
}

/** Oracle: window start (ms) at `nowMs` for the given window semantics. */
function oracleWindowStartMs(kind: 'sliding' | 'fixed', windowSec: number, anchorMs: number, nowMs: number): number {
  const windowMs = windowSec * 1000;
  if (kind === 'fixed') {
    const elapsed = Math.max(0, nowMs - anchorMs);
    return anchorMs + Math.floor(elapsed / windowMs) * windowMs;
  }
  return nowMs - windowMs;
}

// ---------------------------------------------------------------------------
// P1 — the gate never lets a window hold more than quotaPerWindow successes
// ---------------------------------------------------------------------------

describe('consumption quota gate (T-205)', () => {
  it('never exceeds quota inside the window, any call sequence, sliding or fixed', () => {
    fc.assert(
      fc.property(
        quotaArb,
        windowSecArb.chain(w => fc.tuple(fc.constant(w), eventsArb(w))),
        windowKindArb,
        anchorArb,
        (quota, [windowSec, events], kind, anchorMs) => {
          const terms: AgreementTerms = { quotaPerWindow: quota, windowSec, windowKind: kind };
          const agreement = makeAgreement(terms, anchorMs);
          const appended: Array<{ t: number; outcome: UsageOutcome }> = [];
          let t = anchorMs;
          for (const ev of events) {
            t += ev.deltaMs;
            vi.setSystemTime(t);
            const status = consumptionQuotaStatus(terms, agreement, since =>
              store.countUsageSince(agreement.id, since),
            );
            expect(status).not.toBeNull();
            // Gate semantics: spent → the lane rejects (manual 429 / trigger
            // skip) and NOTHING is metered as consumption.
            if (!status!.spent) {
              appendUsageAt(agreement, t, ev.outcome);
              appended.push({ t, outcome: ev.outcome });
            }
            // Invariant 1: successes in the CURRENT window never exceed quota.
            const windowStartIso = quotaWindowStartIso(terms, agreement);
            const inWindow = store.countUsageSince(agreement.id, windowStartIso);
            expect(inWindow).toBeLessThanOrEqual(quota);
            // Invariant 2: the store count equals the oracle (successes only,
            // started_at >= window start) — T-205 "failures never count".
            const windowStartMs = oracleWindowStartMs(kind, windowSec, anchorMs, t);
            expect(Date.parse(windowStartIso)).toBe(windowStartMs);
            const oracle = appended.filter(e => e.outcome === 'success' && e.t >= windowStartMs).length;
            expect(inWindow).toBe(oracle);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — window-start math (sliding vs fixed)
// ---------------------------------------------------------------------------

describe('quotaWindowStartIso semantics', () => {
  it('sliding = trailing windowSec; fixed = tumbling windows anchored at updated_at (skew clamped)', () => {
    fc.assert(
      fc.property(
        windowSecArb,
        windowKindArb,
        anchorArb,
        fc.integer({ min: -5000, max: 5 * 3600 * 1000 }),
        (windowSec, kind, anchorMs, offsetMs) => {
          const terms: AgreementTerms = { quotaPerWindow: 3, windowSec, windowKind: kind };
          const agreement = makeAgreement(terms, anchorMs);
          const now = anchorMs + offsetMs;
          vi.setSystemTime(now);
          const startMs = Date.parse(quotaWindowStartIso(terms, agreement));
          expect(startMs).toBe(oracleWindowStartMs(kind, windowSec, anchorMs, now));
          if (kind === 'fixed' && now >= anchorMs) {
            expect(startMs).toBeLessThanOrEqual(now);
            expect(now - startMs).toBeLessThan(windowSec * 1000);
            expect((startMs - anchorMs) % (windowSec * 1000)).toBe(0);
          }
          if (kind === 'fixed' && now < anchorMs) {
            expect(startMs).toBe(anchorMs); // clock skew: elapsed clamps to 0
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P3 — boundary moments
// ---------------------------------------------------------------------------

describe('quota window boundaries', () => {
  it('sliding: a success exactly at now-windowSec still counts; 1ms older is forgotten', () => {
    fc.assert(
      fc.property(quotaArb, windowSecArb, anchorArb, (quota, windowSec, anchorMs) => {
        const terms: AgreementTerms = { quotaPerWindow: quota, windowSec, windowKind: 'sliding' };
        const agreement = makeAgreement(terms, anchorMs);
        const t0 = anchorMs + 1234;
        appendUsageAt(agreement, t0, 'success');

        vi.setSystemTime(t0 + windowSec * 1000);
        expect(store.countUsageSince(agreement.id, quotaWindowStartIso(terms, agreement))).toBe(1);

        vi.setSystemTime(t0 + windowSec * 1000 + 1);
        expect(store.countUsageSince(agreement.id, quotaWindowStartIso(terms, agreement))).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('fixed: quota refills at the exact tumbling boundary, never mid-window', () => {
    fc.assert(
      fc.property(
        windowSecArb,
        anchorArb,
        fc.integer({ min: 1, max: 4 }),
        (windowSec, anchorMs, windowsAhead) => {
          const terms: AgreementTerms = { quotaPerWindow: 1, windowSec, windowKind: 'fixed' };
          const agreement = makeAgreement(terms, anchorMs);
          // Spend the single quota unit inside window 0.
          appendUsageAt(agreement, anchorMs + 1, 'success');
          // Mid-window: still spent.
          vi.setSystemTime(anchorMs + windowSec * 1000 - 1);
          expect(
            consumptionQuotaStatus(terms, agreement, since =>
              store.countUsageSince(agreement.id, since),
            )!.spent,
          ).toBe(true);
          // Exactly at a later tumbling boundary: the old row is out of window.
          vi.setSystemTime(anchorMs + windowsAhead * windowSec * 1000);
          const status = consumptionQuotaStatus(terms, agreement, since =>
            store.countUsageSince(agreement.id, since),
          );
          expect(status!.spent).toBe(false);
          expect(status!.current).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('T-205: failures and partials never burn quota, in either window kind', () => {
    fc.assert(
      fc.property(
        quotaArb,
        windowSecArb,
        windowKindArb,
        anchorArb,
        fc.array(fc.constantFrom<UsageOutcome>('failure', 'partial'), { minLength: 1, maxLength: 20 }),
        (quota, windowSec, kind, anchorMs, failures) => {
          const terms: AgreementTerms = { quotaPerWindow: quota, windowSec, windowKind: kind };
          const agreement = makeAgreement(terms, anchorMs);
          let t = anchorMs;
          for (const outcome of failures) {
            t += 1;
            appendUsageAt(agreement, t, outcome);
          }
          vi.setSystemTime(t);
          const status = consumptionQuotaStatus(terms, agreement, since =>
            store.countUsageSince(agreement.id, since),
          );
          expect(status!.current).toBe(0);
          expect(status!.spent).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
