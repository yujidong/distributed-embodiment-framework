/**
 * @vitest-environment node
 *
 * Wave F1-2 (docs/plan-r84-verification-framework.md): model-based testing of
 * the AGREEMENT lifecycle state machine (docs/lifecycles/agreement.md).
 *
 * fast-check generates random sequences of legal AND illegal lifecycle
 * commands (propose / decide / counter / suspend / hold / unhold / expire-hold
 * / terminate / remind / invoke / stale-sweep, by parties and non-parties)
 * and drives the REAL HTTP + store implementation. The model mirrors the
 * documented state graph; every command asserts the expected status code,
 * the resulting state, and the notification side effect.
 *
 * Invariants asserted (labels match docs/lifecycles/agreement.md):
 * - A1 legal-transition graph; rejected/terminated are terminal;
 * - A2 only `active` agreements meter invokes (held → 409 AGREEMENT_HELD);
 * - A3 every successful decide/counter/suspend/hold/unhold/terminate lands a
 *   persistent notification for the counterparty (refId = agreementId);
 * - A4 every proposed agreement older than 24h is picked up by the stale
 *   sweep (R77-F5 regression net) and the provider is reminded (once, then
 *   dedupeUnread/renotify silence);
 * - A5 usage_records is append-only (monotone count per agreement);
 * - A6 non-parties get 404 on every lane.
 *
 * v60 (R6-E-F08) note: the terminate actor set gained the ENV OWNER and the
 * provider-removal retire path reuses existing edges only — the state graph
 * below is UNCHANGED. This fixture's env owner IS the provider, so the new
 * actor is indistinguishable here; the distinct env-owner-terminate and the
 * retire/unlink semantics are pinned by provider-retire.vitest.test.ts.
 *
 * Aging is done by backdating created_at (the same fixture trick as
 * agreements.vitest.test.ts's stale-sweep test) — no wall-clock waits.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sweepStaleProposedAgreements } from './agreement-stale.js';
import { NOTIFICATION_KINDS } from './notifications.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

type Role = 'consumer' | 'provider' | 'stranger';
type ModelStatus =
  | 'proposed'
  | 'countered'
  | 'active'
  | 'held'
  | 'suspended'
  | 'rejected'
  | 'terminated';

interface ModelAgreement {
  status: ModelStatus;
  /** created_at was backdated 25h (stale-sweep + remind-window fixture). */
  aged: boolean;
  /** A successful remind already consumed the 10-min window in this phase. */
  remindUsed: { proposed: boolean; countered: boolean };
}

interface AgreementModel {
  agreements: ModelAgreement[];
  /** The aggregated stale reminder was delivered once (dedupeUnread blocks re-notify). */
  staleReminderSent: boolean;
}

interface AgreementReal {
  ctx: TestAppContext;
  owner: TestUser; // env owner AND provider
  consumer: TestUser;
  stranger: TestUser;
  envId: string;
  serviceId: string;
  agreementIds: string[];
  usageCounts: number[];
  counterSeq: number;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function setupAgreementWorld(): Promise<AgreementReal> {
  const ctx = await makeTestApp();
  try {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('agreement-mbt-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
    expect(joined.statusCode).toBe(200);
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    return {
      ctx,
      owner,
      consumer,
      stranger,
      envId,
      serviceId: turnOn!.id,
      agreementIds: [],
      usageCounts: [],
      counterSeq: 0,
    };
  } catch (err) {
    await ctx.cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userOf(real: AgreementReal, role: Role): TestUser {
  return role === 'consumer' ? real.consumer : role === 'provider' ? real.owner : real.stranger;
}

function act(real: AgreementReal, role: Role, id: string, action: string, body?: Record<string, unknown>) {
  return real.ctx.app.inject({
    method: 'POST',
    url: `/api/agreements/${id}/${action}`,
    headers: auth(userOf(real, role).token),
    ...(body !== undefined ? { payload: body } : {}),
  });
}

function del(real: AgreementReal, role: Role, id: string, sub: string) {
  return real.ctx.app.inject({
    method: 'DELETE',
    url: `/api/agreements/${id}/${sub}`,
    headers: auth(userOf(real, role).token),
  });
}

function rowOf(real: AgreementReal, idx: number) {
  const row = real.ctx.app.agreementStore.getAgreement(real.agreementIds[idx]!);
  expect(row, `agreement row #${idx} exists`).toBeDefined();
  return row!;
}

function assertNotified(real: AgreementReal, userId: string, kind: string, refId: string): void {
  const hit = real.ctx.app.notificationStore.latestOfKind(userId, kind, refId);
  expect(hit, `notification ${kind} for ${refId} reaches ${userId}`).toBeDefined();
}

function notificationCount(real: AgreementReal, userId: string, kind: string, refId: string): number {
  return real.ctx.app.notificationStore
    .listForUser(userId, { limit: 500 })
    .filter(row => row.kind === kind && row.ref_id === refId).length;
}

/** A5: usage_records is append-only — the count may only grow. */
function assertUsageMonotone(real: AgreementReal, idx: number): void {
  const id = real.agreementIds[idx]!;
  const count = real.ctx.app.agreementStore.usageOf(id).length;
  expect(count, `usage count of agreement #${idx} never shrinks`).toBeGreaterThanOrEqual(
    real.usageCounts[idx]!,
  );
  real.usageCounts[idx] = count;
}

function assertFinalInvariants(model: AgreementModel, real: AgreementReal): void {
  model.agreements.forEach((agreement, idx) => {
    const id = real.agreementIds[idx]!;
    // A1: model and implementation agree on every agreement's state.
    expect(rowOf(real, idx).status, `agreement #${idx} status matches the model`).toBe(agreement.status);
    assertUsageMonotone(real, idx);
    if (agreement.status === 'proposed') {
      // No silent stall: the provider's doorbell rang at propose time and the
      // decide right sits with them (R77-F5 net).
      assertNotified(real, real.owner.id, NOTIFICATION_KINDS.agreementProposed, id);
    }
    if (agreement.status === 'countered') {
      assertNotified(real, real.consumer.id, NOTIFICATION_KINDS.agreementCountered, id);
    }
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

class ProposeCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    const res = await r.ctx.app.inject({
      method: 'POST',
      url: `/api/services/${r.serviceId}/agreements`,
      headers: auth(r.consumer.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    r.agreementIds.push(id);
    r.usageCounts.push(0);
    m.agreements.push({ status: 'proposed', aged: false, remindUsed: { proposed: false, countered: false } });
    // The provider learns there is a decision to make (no silent proposals).
    assertNotified(r, r.owner.id, NOTIFICATION_KINDS.agreementProposed, id);
  }
  toString(): string {
    return 'propose';
  }
}

class DecideCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(
    readonly idx: number,
    readonly decision: 'accept' | 'reject',
    readonly role: Role,
  ) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'decide', { decision: this.decision });
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404); // A6
      return;
    }
    const next: ModelStatus = this.decision === 'accept' ? 'active' : 'rejected';
    if (agreement.status === 'proposed') {
      if (this.role !== 'provider') {
        expect(res.statusCode).toBe(403); // the ball is with the provider
        return;
      }
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(next);
      agreement.status = next;
      // A3: the consumer learns the verdict without polling.
      assertNotified(
        r,
        r.consumer.id,
        this.decision === 'accept' ? NOTIFICATION_KINDS.agreementAccepted : NOTIFICATION_KINDS.agreementRejected,
        id,
      );
      return;
    }
    if (agreement.status === 'countered') {
      if (this.role !== 'consumer') {
        expect(res.statusCode).toBe(403); // the decide right moved to the consumer
        return;
      }
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(next);
      agreement.status = next;
      // A3: the provider learns the consumer's verdict on their counter-offer.
      assertNotified(
        r,
        r.owner.id,
        this.decision === 'accept' ? NOTIFICATION_KINDS.agreementAccepted : NOTIFICATION_KINDS.agreementRejected,
        id,
      );
      return;
    }
    // Every other state: decide is illegal and changes nothing (A1 terminality
    // for rejected/terminated included).
    expect(res.statusCode).toBe(this.role === 'provider' ? 409 : 403);
    expect(rowOf(r, idx).status).toBe(agreement.status);
  }
  toString(): string {
    return `decide(${this.idx}, ${this.decision}, ${this.role})`;
  }
}

class CounterCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'counter', {
      terms: { notes: `mbt-counter-${++r.counterSeq}` },
    });
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (this.role !== 'provider') {
      expect(res.statusCode).toBe(403);
      return;
    }
    if (agreement.status !== 'proposed') {
      expect(res.statusCode).toBe(409); // depth 1: countered/terminal states refuse
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('countered');
    agreement.status = 'countered';
    // A3: the consumer learns the ball is in their court.
    assertNotified(r, r.consumer.id, NOTIFICATION_KINDS.agreementCountered, id);
  }
  toString(): string {
    return `counter(${this.idx}, ${this.role})`;
  }
}

class SuspendCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'suspend');
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (this.role !== 'provider') {
      expect(res.statusCode).toBe(403);
      return;
    }
    if (agreement.status !== 'active') {
      expect(res.statusCode).toBe(409);
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    agreement.status = 'suspended';
    assertNotified(r, r.consumer.id, NOTIFICATION_KINDS.agreementSuspended, id);
  }
  toString(): string {
    return `suspend(${this.idx}, ${this.role})`;
  }
}

class HoldCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role, readonly durationSec: number) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'hold', { durationSec: this.durationSec });
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (this.role !== 'consumer') {
      expect(res.statusCode).toBe(403); // the hold is the consumer's circuit breaker
      return;
    }
    if (agreement.status !== 'active') {
      expect(res.statusCode).toBe(409);
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    agreement.status = 'held';
    assertNotified(r, r.owner.id, NOTIFICATION_KINDS.agreementHeld, id);
  }
  toString(): string {
    return `hold(${this.idx}, ${this.role}, ${this.durationSec}s)`;
  }
}

class UnholdCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await del(r, this.role, id, 'hold');
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (this.role !== 'consumer') {
      expect(res.statusCode).toBe(403);
      return;
    }
    if (agreement.status !== 'held') {
      expect(res.statusCode).toBe(409);
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    agreement.status = 'active';
    assertNotified(r, r.owner.id, NOTIFICATION_KINDS.agreementResumed, id);
  }
  toString(): string {
    return `unhold(${this.idx}, ${this.role})`;
  }
}

/** D3 lazy expiry: backdate the hold deadline, then a READ flips held → active. */
class ExpireHoldCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    if (agreement.status !== 'held') return;
    const id = r.agreementIds[idx]!;
    const resumedBefore = notificationCount(r, r.owner.id, NOTIFICATION_KINDS.agreementResumed, id);
    r.ctx.app.db
      .prepare('UPDATE service_agreements SET hold_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), id);
    const res = await r.ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(r.consumer.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
    agreement.status = 'active';
    // Lazy expiry is silent by design — no agreement.resumed row appears.
    expect(notificationCount(r, r.owner.id, NOTIFICATION_KINDS.agreementResumed, id)).toBe(resumedBefore);
  }
  toString(): string {
    return `expireHold(${this.idx})`;
  }
}

class TerminateCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'terminate');
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (agreement.status === 'rejected' || agreement.status === 'terminated') {
      expect(res.statusCode).toBe(409); // A1: terminal states stay put
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    const otherParty = this.role === 'consumer' ? r.owner.id : r.consumer.id;
    agreement.status = 'terminated';
    // A3: the OTHER party learns the termination (the actor already knows).
    assertNotified(r, otherParty, NOTIFICATION_KINDS.agreementTerminated, id);
  }
  toString(): string {
    return `terminate(${this.idx}, ${this.role})`;
  }
}

/** T-309/T-059: the waiting side nudges the decider; 10-minute rate window. */
class RemindCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'remind');
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    const phase = agreement.status === 'countered' ? 'countered' : 'proposed';
    if (agreement.status !== 'proposed' && agreement.status !== 'countered') {
      // Guard order at the route (agreements.ts:627-645): the waiting-side
      // check (403) precedes the status check (409) — outside an open
      // negotiation the "waiting side" is the consumer by default, so the
      // provider gets 403 while the consumer reaches the 409.
      expect(res.statusCode).toBe(this.role === 'provider' ? 403 : 409);
      expect(rowOf(r, idx).status).toBe(agreement.status);
      return;
    }
    const waitingSide: Role = phase === 'countered' ? 'provider' : 'consumer';
    if (this.role !== waitingSide) {
      expect(res.statusCode).toBe(403); // only the waiting side may nudge
      return;
    }
    if (!agreement.aged || agreement.remindUsed[phase]) {
      // Within 10 minutes of creation / the last reminder → rate limited.
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('REMIND_RATE_LIMITED');
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded).toBe(true);
    agreement.remindUsed[phase] = true;
    const decider = phase === 'countered' ? r.consumer.id : r.owner.id;
    assertNotified(r, decider, NOTIFICATION_KINDS.agreementReminded, id);
    // T9 (R2, u2-F5): the agent provider's deterministic deliverability lane.
    // The provider here is always the lab agent, and the fixture proposal is
    // on the fully-backed derived turn-on service — so the FIRST aged remind
    // of a PROPOSED agreement auto-accepts it through the ordinary
    // proposed → active edge (countered belongs to the consumer; the lane
    // does not touch it). The model follows the same transition the real row
    // took, so every later command sees the true state.
    if (phase === 'proposed') {
      expect(res.json().autoDecision).toMatchObject({ decision: 'accept' });
      agreement.status = 'active';
      assertNotified(r, r.consumer.id, NOTIFICATION_KINDS.agreementAccepted, id);
    }
  }
  toString(): string {
    return `remind(${this.idx}, ${this.role})`;
  }
}

/** Test fixture: backdate created_at by 25h, then immediately verify the stale
 *  sweep picks the agreement up (A4 fires deterministically, not by luck). */
class AgeCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    if (agreement.aged) return;
    r.ctx.app.db
      .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), r.agreementIds[idx]!);
    agreement.aged = true;
    runSweepAndAssert(m, r);
  }
  toString(): string {
    return `age(${this.idx})`;
  }
}

class InvokeCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    if (m.agreements.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.agreements.length;
    const agreement = m.agreements[idx]!;
    const id = r.agreementIds[idx]!;
    const res = await act(r, this.role, id, 'invocations', { action: 'turn-on' });
    if (this.role === 'stranger') {
      expect(res.statusCode).toBe(404);
      return;
    }
    if (this.role !== 'consumer') {
      expect(res.statusCode).toBe(403); // consumption is the consumer's lane
      return;
    }
    if (agreement.status === 'held') {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('AGREEMENT_HELD');
    } else if (agreement.status !== 'active') {
      // A2: only active agreements meter invokes.
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');
    } else {
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().usage.kind).toBe('invoke');
      expect(res.json().usage.outcome).toBe('success');
    }
    assertUsageMonotone(r, idx); // A5
    expect(rowOf(r, idx).status).toBe(agreement.status); // invoking never moves the state
  }
  toString(): string {
    return `invoke(${this.idx}, ${this.role})`;
  }
}

/**
 * R77-F5 net: run the stale sweep and assert its contract against the model —
 * every aged proposed agreement is in the candidate set (A4), and the first
 * sweep that finds any delivers exactly one aggregated provider reminder
 * (dedupeUnread + the 24h re-notify window silence the repeats).
 */
function runSweepAndAssert(m: AgreementModel, r: AgreementReal): void {
  const result = sweepStaleProposedAgreements({
    agreementStore: r.ctx.app.agreementStore,
    notificationStore: r.ctx.app.notificationStore,
    serviceStore: r.ctx.app.serviceStore,
  });
  const staleIdx = m.agreements
    .map((agreement, idx) => ({ agreement, idx }))
    .filter(({ agreement }) => agreement.status === 'proposed' && agreement.aged);
  expect(result.stale).toBe(staleIdx.length);
  if (staleIdx.length === 0 || m.staleReminderSent) {
    expect(result.notified).toBe(0);
    return;
  }
  expect(result.notified).toBe(1);
  m.staleReminderSent = true;
  const reminder = r.ctx.app.notificationStore.latestOfKind(
    r.owner.id,
    NOTIFICATION_KINDS.agreementProposedStale,
    `stale-proposals:${r.envId}`,
  );
  expect(reminder).toBeDefined();
  const listed = (
    (JSON.parse(reminder!.body_json) as { agreements: Array<{ agreementId: string }> }).agreements
  ).map(entry => entry.agreementId);
  for (const { idx } of staleIdx) {
    expect(listed).toContain(r.agreementIds[idx]!);
  }
}

/** R77-F5 net: the platform-side stale sweep (24h threshold, aggregated + deduped). */
class SweepCommand implements fc.AsyncCommand<AgreementModel, AgreementReal> {
  check(): boolean {
    return true;
  }
  async run(m: AgreementModel, r: AgreementReal): Promise<void> {
    runSweepAndAssert(m, r);
  }
  toString(): string {
    return 'staleSweep';
  }
}

// ---------------------------------------------------------------------------
// Command generation
// ---------------------------------------------------------------------------

const idxArb = fc.nat({ max: 24 });
const roleArb = fc.constantFrom<Role>('consumer', 'provider', 'stranger');
const partyRoleArb = fc.constantFrom<Role>('consumer', 'provider');

const commandsArb = fc.commands(
  [
    // Propose is weighted up (listed thrice) so sequences build a population
    // of agreements before hammering their transitions.
    fc.constant(new ProposeCommand()),
    fc.constant(new ProposeCommand()),
    fc.constant(new ProposeCommand()),
    fc.record({ idx: idxArb, decision: fc.constantFrom('accept' as const, 'reject' as const), role: roleArb })
      .map(c => new DecideCommand(c.idx, c.decision, c.role)),
    fc.record({ idx: idxArb, decision: fc.constantFrom('accept' as const, 'reject' as const), role: roleArb })
      .map(c => new DecideCommand(c.idx, c.decision, c.role)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new CounterCommand(c.idx, c.role)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new SuspendCommand(c.idx, c.role)),
    fc.record({ idx: idxArb, role: roleArb, durationSec: fc.integer({ min: 1, max: 3600 }) })
      .map(c => new HoldCommand(c.idx, c.role, c.durationSec)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new UnholdCommand(c.idx, c.role)),
    idxArb.map(idx => new ExpireHoldCommand(idx)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new TerminateCommand(c.idx, c.role)),
    fc.record({ idx: idxArb, role: partyRoleArb }).map(c => new RemindCommand(c.idx, c.role)),
    idxArb.map(idx => new AgeCommand(idx)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new InvokeCommand(c.idx, c.role)),
    fc.constant(new SweepCommand()),
  ],
  // 'max' forces full-length sequences (40 commands): the default 'small'
  // size generated ~5-command runs whose indexed commands rarely hit an
  // existing agreement — verified empirically (0 successful decides in 15
  // runs). Indices are taken modulo the live population for the same reason.
  { size: 'max', maxCommands: 40 },
);

// ---------------------------------------------------------------------------
// The model-based property
// ---------------------------------------------------------------------------

describe('agreement lifecycle MBT (Wave F1-2)', () => {
  it('R77-F5 net (deterministic anchor): an aged proposal is swept up and the provider reminded', async () => {
    // The random property below exercises this chain among thousands of
    // interleavings; this deterministic anchor pins the exact regression
    // sequence so a rollback of agreement-stale.ts goes red on every run.
    const real = await setupAgreementWorld();
    try {
      const proposed = await real.ctx.app.inject({
        method: 'POST',
        url: `/api/services/${real.serviceId}/agreements`,
        headers: auth(real.consumer.token),
        payload: {},
      });
      expect(proposed.statusCode).toBe(201);
      const id = proposed.json().id as string;
      real.ctx.app.db
        .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), id);
      const model: AgreementModel = {
        agreements: [{ status: 'proposed', aged: true, remindUsed: { proposed: false, countered: false } }],
        staleReminderSent: false,
      };
      real.agreementIds.push(id);
      real.usageCounts.push(0);
      runSweepAndAssert(model, real);
      expect(model.staleReminderSent).toBe(true);
      // A decided proposal leaves the stale set (no double-remind after action).
      const decided = await act(real, 'provider', id, 'decide', { decision: 'reject' });
      expect(decided.statusCode).toBe(200);
      model.agreements[0]!.status = 'rejected';
      const after = sweepStaleProposedAgreements({
        agreementStore: real.ctx.app.agreementStore,
        notificationStore: real.ctx.app.notificationStore,
        serviceStore: real.ctx.app.serviceStore,
      });
      expect(after.stale).toBe(0);
    } finally {
      await real.ctx.cleanup();
    }
  }, 60_000);

  it('R77-F5 decide net (deterministic anchor): accept notifies the consumer "callable now"', async () => {
    // Deterministic anchor for invariant A3 on the decide lane: a provider
    // accept MUST land an agreement.accepted notification for the consumer —
    // rolling the notify call back turns this red on every run.
    const real = await setupAgreementWorld();
    try {
      const proposed = await real.ctx.app.inject({
        method: 'POST',
        url: `/api/services/${real.serviceId}/agreements`,
        headers: auth(real.consumer.token),
        payload: {},
      });
      const id = proposed.json().id as string;
      const decided = await act(real, 'provider', id, 'decide', { decision: 'accept' });
      expect(decided.statusCode).toBe(200);
      expect(decided.json().status).toBe('active');
      assertNotified(real, real.consumer.id, NOTIFICATION_KINDS.agreementAccepted, id);
      const rejected = await real.ctx.app.inject({
        method: 'POST',
        url: `/api/services/${real.serviceId}/agreements`,
        headers: auth(real.consumer.token),
        payload: {},
      });
      const rejectedId = rejected.json().id as string;
      const rejectedDecide = await act(real, 'provider', rejectedId, 'decide', { decision: 'reject' });
      expect(rejectedDecide.statusCode).toBe(200);
      assertNotified(real, real.consumer.id, NOTIFICATION_KINDS.agreementRejected, rejectedId);
    } finally {
      await real.ctx.cleanup();
    }
  }, 60_000);

  it('random legal+illegal command sequences respect the state graph and its invariants', async () => {
    await fc.assert(
      fc.asyncProperty(commandsArb, async commands => {
        let run: { model: AgreementModel; real: AgreementReal } | undefined;
        try {
          await fc.asyncModelRun(async () => {
            const real = await setupAgreementWorld();
            run = { model: { agreements: [], staleReminderSent: false }, real };
            return run;
          }, commands);
          assertFinalInvariants(run!.model, run!.real);
        } finally {
          if (run !== undefined) await run.real.ctx.cleanup();
        }
      }),
      { numRuns: 15 },
    );
  }, 300_000);
});
