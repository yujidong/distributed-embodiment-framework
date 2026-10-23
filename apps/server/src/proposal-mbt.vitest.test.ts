/**
 * @vitest-environment node
 *
 * Wave F1-2 (docs/plan-r84-verification-framework.md): model-based testing of
 * the PROPOSAL lifecycle state machine (docs/lifecycles/proposal.md).
 *
 * fast-check generates random sequences of submit / decide / revert commands
 * (legal and illegal: wrong decider, wrong state, non-member author) and
 * drives the REAL HTTP + proposal-service pipeline. The default test reviewer
 * escalates everything (test-utils.ts), so valid submissions land in
 * `escalated` and exercise the owner-decide funnel — EXCEPT the §5.3 zone
 * autonomy path: once the builder holds a zone-claim, their low-risk
 * submissions fully inside the claimed zone skip AI review and auto-APPLY
 * (source 'zone-claim'; the model tracks the live claim set). A second
 * describe enables `proposalReviewTimeoutAutoApprove` to cover the
 * rule-fallback auto-apply path and its T-004 owner-notification invariant.
 *
 * Invariants asserted (labels match docs/lifecycles/proposal.md):
 * - P1 funnel liveness: after submit returns, the status is one of
 *   {rejected, escalated, applied} — submitted/rule_check/ai_review/approved
 *   never persist (no silent pending);
 * - P2 terminality: rejected/reverted refuse decide AND revert (409);
 *   applied refuses decide (409); escalated refuses revert (409);
 * - P3 decide belongs to the env owner (others 403); revert belongs to the
 *   author or the env owner (others 403);
 * - P4 verdicts reach the author (proposal.applied/rejected, allowSelf on the
 *   auto paths); escalations reach the owner (proposal.escalated);
 * - P5 an auto-applied proposal (no human verdict, reviewer_id null) always
 *   pings the env owner with proposal.auto_applied (T-004);
 * - P6 audit closure: applied ⇒ command_log apply entry; reverted ⇒
 *   `revert:<kind>` entry.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ProposalKind, ProposalStatus } from './db/proposal-store.js';
import { NOTIFICATION_KINDS } from './notifications.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

type Role = 'owner' | 'builder' | 'stranger';
/** Statuses the model can observe at rest (funnel steps never persist, P1). */
type RestStatus = 'escalated' | 'applied' | 'rejected' | 'reverted';

interface ModelProposal {
  status: RestStatus;
  kind: ProposalKind;
  authorRole: 'builder';
  /** zone-claim proposals: the zone the grant covers (§5.3 autonomy input). */
  claimZoneId?: string;
}

interface ProposalModel {
  proposals: ModelProposal[];
  /**
   * §5.3 zone autonomy: zones the builder currently stewards (granted by an
   * applied zone-claim, revoked by its revert). A low-risk submit whose whole
   * footprint lies inside these zones auto-applies instead of escalating.
   */
  claimedZoneIds: string[];
}

interface ProposalReal {
  ctx: TestAppContext;
  owner: TestUser;
  builder: TestUser;
  stranger: TestUser;
  envId: string;
  proposalIds: string[];
  seq: number;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function setupProposalWorld(overrides: Parameters<typeof makeTestApp>[0] = {}): Promise<ProposalReal> {
  const ctx = await makeTestApp(overrides);
  try {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const builder = await registerUser(ctx.app, { displayName: 'Builder' });
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Proposal MBT Lab',
        visibility: 'public',
        mapData: {
          zones: [
            { id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } },
            { id: 'zone-b' },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    expect(joined.statusCode).toBe(200);
    return { ctx, owner, builder, stranger, envId, proposalIds: [], seq: 0 };
  } catch (err) {
    await ctx.cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userOf(real: ProposalReal, role: Role): TestUser {
  return role === 'owner' ? real.owner : role === 'builder' ? real.builder : real.stranger;
}

function rowOf(real: ProposalReal, idx: number) {
  const row = real.ctx.app.proposalStore.get(real.proposalIds[idx]!);
  expect(row, `proposal row #${idx} exists`).toBeDefined();
  return row!;
}

function assertNotified(real: ProposalReal, userId: string, kind: string, refId: string): void {
  const hit = real.ctx.app.notificationStore.latestOfKind(userId, kind, refId);
  expect(hit, `notification ${kind} for ${refId} reaches ${userId}`).toBeDefined();
}

function assertNotNotified(real: ProposalReal, userId: string, kind: string, refId: string): void {
  const hit = real.ctx.app.notificationStore.latestOfKind(userId, kind, refId);
  expect(hit, `no notification ${kind} for ${refId} at ${userId}`).toBeUndefined();
}

/**
 * T39→T59 (R6): applied notices aggregate per (recipient, kind, ENV) — the
 * proposal id rides body.recent[].proposalId (capped digest; the newest
 * body's top-level proposalId also names the latest apply). This helper
 * asserts the digest reached the user AND names the proposal.
 */
function assertAppliedNotified(real: ProposalReal, userId: string, proposalId: string): void {
  const rows = real.ctx.app.notificationStore.listForUser(userId, { limit: 100 });
  const hit = rows.find(row => {
    if (row.kind !== NOTIFICATION_KINDS.proposalApplied) return false;
    try {
      const body = JSON.parse(row.body_json) as {
        proposalId?: string;
        recent?: Array<{ proposalId?: string }>;
      };
      if (body.proposalId === proposalId) return true;
      return Array.isArray(body.recent) && body.recent.some(item => item.proposalId === proposalId);
    } catch {
      return false;
    }
  });
  expect(hit, `applied digest naming ${proposalId} reaches ${userId}`).toBeDefined();
}

/** P1: the funnel steps never persist — a stored status is a REST status. */
function assertRestStatus(status: ProposalStatus, context: string): void {
  expect(
    ['escalated', 'applied', 'rejected', 'reverted'],
    `${context}: funnel steps (submitted/rule_check/ai_review/approved) never persist, got "${status}"`,
  ).toContain(status);
}

function assertFinalInvariants(model: ProposalModel, real: ProposalReal): void {
  model.proposals.forEach((proposal, idx) => {
    const id = real.proposalIds[idx]!;
    const row = rowOf(real, idx);
    expect(row.status, `proposal #${idx} status matches the model`).toBe(proposal.status);
    assertRestStatus(row.status, `proposal #${idx}`);
    if (row.status === 'escalated') {
      // The only resting non-terminal state always has an action surface:
      // the owner was notified with the decide replyHint.
      assertNotified(real, real.owner.id, NOTIFICATION_KINDS.proposalEscalated, id);
    }
    if (row.status === 'applied' || row.status === 'reverted') {
      // P6: the apply entry exists (for reverted rows the apply entry is what
      // the revert inverted — both stay in the append-only log).
      expect(
        real.ctx.app.commandLogStore.findApplyEntry(id, row.kind),
        `proposal #${idx} has an apply entry in the command log`,
      ).toBeDefined();
    }
    if (row.status === 'reverted') {
      const revertEntries = real.ctx.app.commandLogStore
        .listForEnv(real.envId, { kind: `revert:${row.kind}`, limit: 500 })
        .filter(entry => entry.proposal_id === id);
      expect(revertEntries.length, `proposal #${idx} has a revert entry`).toBeGreaterThan(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Commands (escalate-everything reviewer: valid submits land in `escalated`)
// ---------------------------------------------------------------------------

class SubmitCommand implements fc.AsyncCommand<ProposalModel, ProposalReal> {
  constructor(
    readonly variant: 'devices' | 'devices-bad-zone' | 'zones' | 'zone-claim',
    readonly authorRole: 'builder' | 'stranger',
  ) {}
  check(): boolean {
    return true;
  }
  async run(m: ProposalModel, r: ProposalReal): Promise<void> {
    const n = ++r.seq;
    const payloads: Record<typeof this.variant, { kind: ProposalKind; payload: Record<string, unknown> }> = {
      devices: {
        kind: 'install-devices',
        payload: {
          devices: [{
            name: `MBT Sensor ${n}`,
            type: 'temperature-sensor',
            capabilities: ['temperature-reading'],
            zoneId: 'zone-a',
          }],
        },
      },
      'devices-bad-zone': {
        kind: 'install-devices',
        payload: {
          devices: [{
            name: `MBT Sensor ${n}`,
            type: 'temperature-sensor',
            capabilities: ['temperature-reading'],
            zoneId: 'zone-nope',
          }],
        },
      },
      zones: {
        kind: 'install-zones',
        payload: { zones: [{ id: `mbt-zone-${n}`, name: `MBT Zone ${n}` }] },
      },
      'zone-claim': {
        kind: 'zone-claim',
        payload: { zoneId: n % 2 === 0 ? 'zone-a' : 'zone-b' },
      },
    };
    const spec = payloads[this.variant];
    const res = await r.ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${r.envId}/proposals`,
      headers: auth(userOf(r, this.authorRole).token),
      payload: spec,
    });
    if (this.authorRole === 'stranger') {
      expect(res.statusCode).toBe(403); // non-member authors never enter the funnel
      return;
    }
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; status: ProposalStatus };
    // §5.3 zone autonomy: a low-risk install-devices whose whole footprint
    // (zone-a) is stewarded by the builder skips AI review and auto-applies.
    const expected: RestStatus =
      this.variant === 'devices-bad-zone'
        ? 'rejected'
        : this.variant === 'devices' && m.claimedZoneIds.includes('zone-a')
          ? 'applied'
          : 'escalated';
    // P1: submit is a synchronous funnel — it returns a REST status.
    expect(body.status).toBe(expected);
    r.proposalIds.push(body.id);
    m.proposals.push({
      status: expected,
      kind: spec.kind,
      authorRole: 'builder',
      ...(this.variant === 'zone-claim'
        ? { claimZoneId: (spec.payload as { zoneId: string }).zoneId }
        : {}),
    });
    if (expected === 'rejected') {
      // P4: a rule-check rejection reaches the author even though the author
      // IS the transition actor (Fix-18 allowSelf).
      assertNotified(r, r.builder.id, NOTIFICATION_KINDS.proposalRejected, body.id);
    } else if (expected === 'applied') {
      // Zone-autonomy auto-apply: reviewer_id null (no human verdict), so P4
      // reaches the author and P5 (T-004) pings the owner with auto_applied.
      expect(rowOf(r, r.proposalIds.length - 1).reviewer_id).toBeNull();
      assertAppliedNotified(r, r.builder.id, body.id);
      // T59: the auto_applied row aggregates per env — assert on the body's
      // proposal id, not the (family) refId.
      const ownerAutoApplied = r.ctx.app.notificationStore
        .listForUser(r.owner.id, { kind: NOTIFICATION_KINDS.proposalAutoApplied, limit: 100 })
        .find(row => {
          try {
            return (JSON.parse(row.body_json) as { proposalId?: string }).proposalId === body.id;
          } catch {
            return false;
          }
        });
      expect(ownerAutoApplied, `auto_applied digest naming ${body.id} reaches the owner`).toBeDefined();
    } else {
      // P4: the owner's doorbell rings — escalated never sits silently.
      assertNotified(r, r.owner.id, NOTIFICATION_KINDS.proposalEscalated, body.id);
    }
    // P1 again through the store (not just the HTTP response).
    assertRestStatus(rowOf(r, r.proposalIds.length - 1).status, `after submit ${this.variant}`);
  }
  toString(): string {
    return `submit(${this.variant}, ${this.authorRole})`;
  }
}

class DecideCommand implements fc.AsyncCommand<ProposalModel, ProposalReal> {
  constructor(
    readonly idx: number,
    readonly decision: 'approved' | 'rejected',
    readonly role: Role,
  ) {}
  check(): boolean {
    return true;
  }
  async run(m: ProposalModel, r: ProposalReal): Promise<void> {
    if (m.proposals.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.proposals.length;
    const proposal = m.proposals[idx]!;
    const id = r.proposalIds[idx]!;
    const res = await r.ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${id}/decide`,
      headers: auth(userOf(r, this.role).token),
      payload: { decision: this.decision },
    });
    if (this.role !== 'owner') {
      expect(res.statusCode).toBe(403); // P3: only the env owner decides
      expect(rowOf(r, idx).status).toBe(proposal.status);
      return;
    }
    if (proposal.status !== 'escalated') {
      expect(res.statusCode).toBe(409); // P2
      expect(res.json().error.code).toBe('PROPOSAL_NOT_DECIDABLE');
      expect(rowOf(r, idx).status).toBe(proposal.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    const next: RestStatus = this.decision === 'approved' ? 'applied' : 'rejected';
    expect(res.json().status).toBe(next);
    proposal.status = next;
    if (next === 'applied' && proposal.kind === 'zone-claim' && proposal.claimZoneId !== undefined) {
      // §5.3: the stewardship grant is live now — the builder's later
      // low-risk submits inside this zone auto-apply.
      if (!m.claimedZoneIds.includes(proposal.claimZoneId)) {
        m.claimedZoneIds.push(proposal.claimZoneId);
      }
    }
    // P4: the verdict reaches the author (applied notices ride the T39 batch
    // digest — the proposal id is asserted among the digest items).
    if (next === 'applied') {
      assertAppliedNotified(r, r.builder.id, id);
    } else {
      assertNotified(r, r.builder.id, NOTIFICATION_KINDS.proposalRejected, id);
    }
    // An owner-decided apply is NOT an auto-apply — the owner made the call,
    // so no proposal.auto_applied echo (P5's negative half).
    assertNotNotified(r, r.owner.id, NOTIFICATION_KINDS.proposalAutoApplied, id);
  }
  toString(): string {
    return `decide(${this.idx}, ${this.decision}, ${this.role})`;
  }
}

class RevertCommand implements fc.AsyncCommand<ProposalModel, ProposalReal> {
  constructor(readonly idx: number, readonly role: Role) {}
  check(): boolean {
    return true;
  }
  async run(m: ProposalModel, r: ProposalReal): Promise<void> {
    if (m.proposals.length === 0) return; // no population yet — no-op
    const idx = this.idx % m.proposals.length;
    const proposal = m.proposals[idx]!;
    const id = r.proposalIds[idx]!;
    const res = await r.ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${id}/revert`,
      headers: auth(userOf(r, this.role).token),
    });
    const canRevert = this.role === 'owner' || this.role === 'builder'; // author or env owner (P3)
    if (!canRevert) {
      expect(res.statusCode).toBe(403);
      expect(rowOf(r, idx).status).toBe(proposal.status);
      return;
    }
    if (proposal.status !== 'applied') {
      expect(res.statusCode).toBe(409); // P2
      expect(res.json().error.code).toBe('PROPOSAL_NOT_APPLIED');
      expect(rowOf(r, idx).status).toBe(proposal.status);
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('reverted');
    proposal.status = 'reverted';
    if (proposal.kind === 'zone-claim' && proposal.claimZoneId !== undefined) {
      // The revert revoked the stewardship grant (§5.3) — autonomy ends here.
      m.claimedZoneIds = m.claimedZoneIds.filter(zoneId => zoneId !== proposal.claimZoneId);
    }
    // The revert verdict reaches the author — unless the author reverted
    // themselves (the self-echo drop is deliberate for `reverted`).
    if (this.role === 'owner') {
      assertNotified(r, r.builder.id, NOTIFICATION_KINDS.proposalReverted, id);
    } else {
      assertNotNotified(r, r.builder.id, NOTIFICATION_KINDS.proposalReverted, id);
    }
  }
  toString(): string {
    return `revert(${this.idx}, ${this.role})`;
  }
}

// ---------------------------------------------------------------------------
// Command generation
// ---------------------------------------------------------------------------

const idxArb = fc.nat({ max: 14 });
const roleArb = fc.constantFrom<Role>('owner', 'builder', 'stranger');

const submitArb = fc
  .record({
    variant: fc.constantFrom(
      'devices' as const,
      'devices' as const,
      'devices-bad-zone' as const,
      'zones' as const,
      'zone-claim' as const,
    ),
    authorRole: fc.constantFrom('builder' as const, 'builder' as const, 'stranger' as const),
  })
  .map(c => new SubmitCommand(c.variant, c.authorRole));

const commandsArb = fc.commands(
  [
    // Submits weighted up (listed thrice) so sequences build a population of
    // proposals before hammering their transitions.
    submitArb,
    submitArb,
    submitArb,
    fc.record({ idx: idxArb, decision: fc.constantFrom('approved' as const, 'rejected' as const), role: roleArb })
      .map(c => new DecideCommand(c.idx, c.decision, c.role)),
    fc.record({ idx: idxArb, decision: fc.constantFrom('approved' as const, 'rejected' as const), role: roleArb })
      .map(c => new DecideCommand(c.idx, c.decision, c.role)),
    fc.record({ idx: idxArb, role: roleArb }).map(c => new RevertCommand(c.idx, c.role)),
  ],
  // 'max' forces full-length sequences — see the same comment in
  // agreement-mbt.vitest.test.ts (default size starved the indexed commands).
  { size: 'max', maxCommands: 30 },
);

// ---------------------------------------------------------------------------
// The model-based properties
// ---------------------------------------------------------------------------

describe('proposal lifecycle MBT (Wave F1-2)', () => {
  it('escalate-funnel: random legal+illegal command sequences respect the state graph', async () => {
    await fc.assert(
      fc.asyncProperty(commandsArb, async commands => {
        let run: { model: ProposalModel; real: ProposalReal } | undefined;
        try {
          await fc.asyncModelRun(async () => {
            const real = await setupProposalWorld();
            run = { model: { proposals: [], claimedZoneIds: [] }, real };
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

  it('auto-apply funnel (T-004): every low-risk auto-applied proposal pings the env owner', async () => {
    // P5 under the Fix-45d fallback reviewer: no human verdict (reviewer_id
    // null) ⇒ proposal.auto_applied reaches the owner, proposal.applied
    // reaches the author — and an applied proposal still refuses decide (P2).
    const submissionArb = fc.array(
      fc.constantFrom('devices' as const, 'zones' as const),
      { minLength: 1, maxLength: 6 },
    );
    await fc.assert(
      fc.asyncProperty(submissionArb, async variants => {
        const real = await setupProposalWorld({ proposalReviewTimeoutAutoApprove: true });
        try {
          for (const variant of variants) {
            const n = ++real.seq;
            const spec = variant === 'devices'
              ? {
                  kind: 'install-devices',
                  payload: {
                    devices: [{
                      name: `MBT Sensor ${n}`,
                      type: 'temperature-sensor',
                      capabilities: ['temperature-reading'],
                      zoneId: 'zone-a',
                    }],
                  },
                }
              : {
                  kind: 'install-zones',
                  payload: { zones: [{ id: `mbt-zone-${n}`, name: `MBT Zone ${n}` }] },
                };
            const res = await real.ctx.app.inject({
              method: 'POST',
              url: `/api/environments/${real.envId}/proposals`,
              headers: auth(real.builder.token),
              payload: spec,
            });
            expect(res.statusCode).toBe(201);
            const body = res.json() as { id: string; status: ProposalStatus };
            // P1: the whole funnel (approve + apply) completes inside submit.
            expect(body.status).toBe('applied');
            const row = real.ctx.app.proposalStore.get(body.id)!;
            expect(row.reviewer_id).toBeNull(); // no human verdict — AUTO-applied
            // P4: the author learns their change landed.
            assertAppliedNotified(real, real.builder.id, body.id);
            // P5 (T-004): the owner's world changed without their hand — they
            // MUST be told. T59: the auto_applied row aggregates per env (the
            // refId is the family key) — the proposal id is asserted on the body.
            const ownerAutoApplied = real.ctx.app.notificationStore
              .listForUser(real.owner.id, { kind: NOTIFICATION_KINDS.proposalAutoApplied, limit: 100 })
              .find(row => {
                try {
                  return (JSON.parse(row.body_json) as { proposalId?: string }).proposalId === body.id;
                } catch {
                  return false;
                }
              });
            expect(ownerAutoApplied, `auto_applied digest naming ${body.id} reaches the owner`).toBeDefined();
            // P6: the apply entry exists for a later revert.
            expect(real.ctx.app.commandLogStore.findApplyEntry(body.id, spec.kind)).toBeDefined();
            // P2: an applied proposal cannot be decided anymore.
            const lateDecide = await real.ctx.app.inject({
              method: 'POST',
              url: `/api/proposals/${body.id}/decide`,
              headers: auth(real.owner.token),
              payload: { decision: 'rejected' },
            });
            expect(lateDecide.statusCode).toBe(409);
            expect(lateDecide.json().error.code).toBe('PROPOSAL_NOT_DECIDABLE');
            expect(real.ctx.app.proposalStore.get(body.id)!.status).toBe('applied');
          }
        } finally {
          await real.ctx.cleanup();
        }
      }),
      { numRuns: 10 },
    );
    // 120s was enough on a developer box (local ≈60s for this property);
    // the 4-vCPU hosted runner at 6 workers slows the per-run full-app
    // boots 3-5x — 2026-09-29 push CI died at exactly 120s.
  }, 300_000);
});
