/**
 * @vitest-environment node
 *
 * T-059 (DevLoop R14, design-consent-semantics.md §5) — counter-offers:
 * the provider's answer to a unilaterally drafted proposal.
 *
 * The stakeholder story is EN-F14: terms were consumer-drafted and the
 * provider's only moves were accept-all / reject — real negotiation has a
 * counter. Now: proposed ─ provider counter ─▶ countered ─ consumer decide ─▶
 * active (with the COUNTERED terms as the contract) | rejected. Depth 1;
 * the decide right and the remind right both follow the state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('T-059 counter-offers (consent semantics §5)', () => {
  let ctx: TestAppContext;
  let provider: TestUser; // env owner + provider agent owner
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    provider = await registerUser(ctx.app, { displayName: 'Facility Provider' });
    consumer = await registerUser(ctx.app, { displayName: 'Energy Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(provider.token),
      payload: { ...importableScenario('counter-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(provider.token),
    });
    serviceId = ((services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启'))!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function propose(terms: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms },
    });
  }

  function counter(terms: Record<string, unknown>, token = provider.token) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/counter`,
      headers: auth(token),
      payload: { terms },
    });
  }

  function decide(decision: 'accept' | 'reject', token: string, body?: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(token),
      payload: { decision, ...(body ?? {}) },
    });
  }

  function remind(token: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/remind`,
      headers: auth(token),
      payload: {},
    });
  }

  async function notificationsOf(token: string): Promise<Array<{ kind: string; refId: string | null; body: Record<string, unknown> }>> {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: auth(token) });
    return res.json().notifications;
  }

  /** T120 (R19-u2): the workbench doorbell — GET /api/me/overview todos. */
  async function todosOf(token: string): Promise<{ pendingAgreements: number; unreadNotifications: number }> {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(token) });
    return res.json().todos;
  }

  async function runningSim(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(consumer.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(consumer.token), payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  let agreementId: string;

  it('EN-F14 replay: prose-only proposal → provider counters structured terms → accept → the countered clause binds', async () => {
    // The consumer drafts a prose-only contract (the EN-F14 hole: nothing
    // enforceable, provider can only accept or reject).
    const proposed = await propose({ notes: '尽量在用电高峰调低空调' });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().termsEnforced).toBe(false);
    agreementId = proposed.json().id as string;

    // The proposed notification carries a machine-readable reply hint.
    const providerInbox = await notificationsOf(provider.token);
    const proposedNote = providerInbox.find(n => n.kind === 'agreement.proposed' && n.refId === agreementId)!;
    expect(proposedNote.body.replyHint).toEqual({
      endpoint: `POST /api/agreements/${agreementId}/decide`,
      allowedDecisions: ['accept', 'reject'],
      yourMove: true,
    });

    // The provider counters with a STRUCTURED clause — its unilateral entry
    // into tightening the contract.
    const countered = await counter({
      quotaPerWindow: 20,
      windowSec: 3600,
      action: { command: 'turn-on' },
      notes: 'grid-peak 时调回 26°C；仅允许开启命令',
    });
    expect(countered.statusCode).toBe(200);
    const body = countered.json();
    expect(body.status).toBe('countered');
    // Both versions visible; the effective one is the counter.
    expect(body.terms.notes).toBe('尽量在用电高峰调低空调');
    expect(body.counteredTerms.action.command).toBe('turn-on');
    expect(body.effectiveTerms.action.command).toBe('turn-on');
    expect(body.termsEnforced).toBe(true); // recomputed on the EFFECTIVE terms

    // The consumer's notification carries the diff + reply hint.
    const consumerInbox = await notificationsOf(consumer.token);
    const counteredNote = consumerInbox.find(n => n.kind === 'agreement.countered' && n.refId === agreementId)!;
    expect(counteredNote.body.counteredTermsSummary).toBeTruthy();
    expect((counteredNote.body.termsDiff as string[]).some(d => d.startsWith('added action'))).toBe(true);
    expect((counteredNote.body.replyHint as { yourMove: boolean }).yourMove).toBe(true);

    // The provider may NOT decide anymore — the ball moved.
    const providerDecide = await decide('accept', provider.token);
    expect(providerDecide.statusCode).toBe(403);
    expect(providerDecide.json().error.message).toContain("consumer's court");

    // The consumer accepts: the countered terms BECOME the contract.
    const accepted = await decide('accept', consumer.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().terms.action.command).toBe('turn-on');
    expect(accepted.json().terms.quotaPerWindow).toBe(20);
    expect(accepted.json().effectiveTerms.action.command).toBe('turn-on');
    expect(accepted.json().termsEnforced).toBe(true);

    // termsEnforced recompute is REAL: the countered clause binds invokes.
    await runningSim();
    const wrongAction = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-off' },
    });
    expect(wrongAction.statusCode).toBe(422);
    expect(wrongAction.json().error.code).toBe('AGREEMENT_TERMS_VIOLATION');
    expect(wrongAction.json().error.agreedCommand).toBe('turn-on');
    const rightAction = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on' },
    });
    expect(rightAction.statusCode).toBe(200);
    expect(rightAction.json().termsEnforced).toBe(true);
  });

  it('consumer rejects the counter → rejected terminal; the original never activated', async () => {
    const proposed = await propose({ quotaPerWindow: 5, windowSec: 60 });
    agreementId = proposed.json().id as string;
    await counter({ quotaPerWindow: 1, windowSec: 60 });

    const rejected = await decide('reject', consumer.token);
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');
    expect(rejected.json().terms.quotaPerWindow).toBe(5); // original untouched
    expect(rejected.json().effectiveTerms.quotaPerWindow).toBe(5);
    // Terminal: no further moves. Counter → 409; the consumer's decide
    // right existed ONLY in countered — on rejected the pre-existing
    // provider-only rule answers 403.
    expect((await counter({ quotaPerWindow: 2, windowSec: 60 })).statusCode).toBe(409);
    expect((await decide('accept', consumer.token)).statusCode).toBe(403);
  });

  it('T120 (R19-u2): the proposal doorbell — the workbench todo follows the decide right', async () => {
    // Baseline: nobody owes anybody a decision.
    expect((await todosOf(provider.token)).pendingAgreements).toBe(0);
    expect((await todosOf(consumer.token)).pendingAgreements).toBe(0);

    // B proposes to A: A (provider) holds the decision — the inbox row mints
    // yourMove=true and the workbench bell rings for A only.
    const proposed = await propose({ quotaPerWindow: 5, windowSec: 60 });
    agreementId = proposed.json().id as string;
    expect((await todosOf(provider.token)).pendingAgreements).toBe(1);
    expect((await todosOf(consumer.token)).pendingAgreements).toBe(0);
    const minted = (await notificationsOf(provider.token))
      .find(n => n.kind === 'agreement.proposed' && n.refId === agreementId)!;
    expect((minted.body.replyHint as { yourMove: boolean }).yourMove).toBe(true);

    // A counters: the decide right (and the doorbell) moves to B — the
    // provider's bell falls silent, the consumer's rings, and the countered
    // row mints yourMove=true.
    await counter({ quotaPerWindow: 20, windowSec: 3600 });
    expect((await todosOf(provider.token)).pendingAgreements).toBe(0);
    expect((await todosOf(consumer.token)).pendingAgreements).toBe(1);
    const counteredNote = (await notificationsOf(consumer.token))
      .find(n => n.kind === 'agreement.countered' && n.refId === agreementId)!;
    expect((counteredNote.body.replyHint as { yourMove: boolean }).yourMove).toBe(true);

    // B decides: both bells fall silent and BOTH historical rows (the
    // proposed one on A's side, the countered one on B's side) read
    // yourMove=false through the list-route revalidation.
    await decide('accept', consumer.token);
    expect((await todosOf(provider.token)).pendingAgreements).toBe(0);
    expect((await todosOf(consumer.token)).pendingAgreements).toBe(0);
    const providerRow = (await notificationsOf(provider.token))
      .find(n => n.kind === 'agreement.proposed' && n.refId === agreementId)!;
    const consumerRow = (await notificationsOf(consumer.token))
      .find(n => n.kind === 'agreement.countered' && n.refId === agreementId)!;
    expect((providerRow.body.replyHint as { yourMove: boolean }).yourMove).toBe(false);
    expect((consumerRow.body.replyHint as { yourMove: boolean }).yourMove).toBe(false);
  });

  it('P3 (R11, u3-F3): a decided agreement stops advertising "← your move" — the inbox revalidates the stored hint', async () => {
    const proposed = await propose({ notes: 'move-flag revalidation' });
    agreementId = proposed.json().id as string;

    // While proposed, the provider's inbox advertises the move (the mint-time
    // snapshot and the live state agree).
    const before = (await notificationsOf(provider.token))
      .find(n => n.kind === 'agreement.proposed' && n.refId === agreementId)!;
    expect((before.body.replyHint as { yourMove: boolean }).yourMove).toBe(true);

    // The consumer withdraws the proposal — the provider has no move anymore,
    // so the SAME stored row must stop advertising one.
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(consumer.token),
      payload: { reason: '提案错投到他人服务，回收重发' },
    });
    expect(terminated.statusCode).toBe(200);

    const after = (await notificationsOf(provider.token))
      .find(n => n.kind === 'agreement.proposed' && n.refId === agreementId)!;
    const hint = after.body.replyHint as { yourMove: boolean; endpoint: string };
    expect(hint.yourMove).toBe(false); // the stale flag flipped...
    expect(hint.endpoint).toBe(`POST /api/agreements/${agreementId}/decide`); // ...the historical affordance survives
  });

  it('T24 (R3): the counter-ACCEPT carries the consumer reason into statusReason + the provider notification', async () => {
    const proposed = await propose({ quotaPerWindow: 5, windowSec: 60 });
    agreementId = proposed.json().id as string;
    expect(proposed.statusCode).toBe(201);
    await counter({ quotaPerWindow: 20, windowSec: 3600 });

    const accepted = await decide('accept', consumer.token, { reason: '接受 counter：额度放宽到 20 可接受' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().statusReason).toBe('接受 counter：额度放宽到 20 可接受');

    const providerNotes = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(provider.token),
    });
    const acceptedNote = (providerNotes.json().notifications as Array<{ kind: string; refId: string | null; body: Record<string, unknown> }>)
      .find(n => n.kind === 'agreement.accepted' && n.refId === agreementId);
    expect(acceptedNote?.body.reason).toBe('接受 counter：额度放宽到 20 可接受');

    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(provider.token),
    });
    expect(got.json().statusReason).toBe('接受 counter：额度放宽到 20 可接受');
  });

  it('DB-F03 (R15): feed attribution follows who acted — a counter-accept is attributed to the CONSUMER', async () => {
    // The live-round audit bug: the feed's 'active' entry for a
    // countered-then-accepted agreement named the PROVIDER as actor, though
    // the consumer's accept was the closing move.
    const proposed = await propose({ quotaPerWindow: 5, windowSec: 60 });
    agreementId = proposed.json().id as string;
    await counter({ quotaPerWindow: 2, windowSec: 60 });
    await decide('accept', consumer.token);

    const feed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity`,
      headers: auth(provider.token),
    })).json().entries as Array<{
      kind: string; action: string; objectId: string;
      actor: { id: string; displayName: string } | null;
      summary: string;
    }>;
    const entries = feed.filter(e => e.kind === 'agreement' && e.objectId === agreementId);
    expect(entries.map(e => e.action).sort()).toEqual(['active', 'proposed']);
    const active = entries.find(e => e.action === 'active')!;
    expect(active.actor!.id).toBe(consumer.id); // NOT the provider
    expect(active.summary).toContain('counter');

    // Control: a DIRECT provider accept (no counter) still attributes the
    // provider — the discriminator is the counter, not the status.
    const direct = await propose({ quotaPerWindow: 5, windowSec: 60 });
    const directId = direct.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${directId}/decide`,
      headers: auth(provider.token),
      payload: { decision: 'accept' },
    });
    // The decide landed within the same millisecond as the propose (fast
    // local ops) — nudge updated_at so the transition entry exists.
    ctx.app.db
      .prepare(`UPDATE service_agreements SET updated_at = ? WHERE id = ?`)
      .run(new Date(Date.parse(direct.json().updatedAt as string) + 1000).toISOString(), directId);
    const feed2 = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity`,
      headers: auth(provider.token),
    })).json().entries as Array<{
      kind: string; action: string; objectId: string; actor: { id: string } | null;
    }>;
    const directActive = feed2.find(e => e.kind === 'agreement' && e.objectId === directId && e.action === 'active');
    expect(directActive).toBeDefined();
    expect(directActive!.actor!.id).toBe(provider.id);
  });

  it('a countered agreement shows a countered feed entry (provider acted)', async () => {
    const proposed = await propose({ quotaPerWindow: 5, windowSec: 60 });
    agreementId = proposed.json().id as string;
    await counter({ quotaPerWindow: 2, windowSec: 60 });
    const feed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity`,
      headers: auth(provider.token),
    })).json().entries as Array<{
      kind: string; action: string; objectId: string; actor: { id: string } | null;
    }>;
    const countered = feed.find(e => e.kind === 'agreement' && e.objectId === agreementId && e.action === 'countered');
    expect(countered).toBeDefined();
    expect(countered!.actor!.id).toBe(provider.id);
  });

  it('depth 1: a second counter 409s (renegotiation = terminate + re-propose)', async () => {
    const proposed = await propose({ notes: 'first' });
    agreementId = proposed.json().id as string;
    expect((await counter({ notes: 'second' })).statusCode).toBe(200);
    const again = await counter({ notes: 'third' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('terminate');
  });

  it('a counter identical to the proposal 400s (no-change counters are noise)', async () => {
    const terms = { quotaPerWindow: 5, windowSec: 60 };
    const proposed = await propose(terms);
    agreementId = proposed.json().id as string;
    const identical = await counter(terms);
    expect(identical.statusCode).toBe(400);
    expect(identical.json().error.message).toContain('identical');
  });

  it('only the provider counters; only from proposed', async () => {
    const proposed = await propose({ notes: 'x' });
    agreementId = proposed.json().id as string;
    expect((await counter({ notes: 'y' }, consumer.token)).statusCode).toBe(403);

    // An active agreement cannot be countered either.
    await decide('accept', provider.token);
    const onActive = await counter({ notes: 'z' });
    expect(onActive.statusCode).toBe(409);
  });

  it('counter terms run the SAME closed schema as propose (unknown read fields 400)', async () => {
    const proposed = await propose({ notes: 'x' });
    agreementId = proposed.json().id as string;
    const bad = await counter({ read: { fields: ['nonexistent-field'] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('no registered computation');
    const unknownTerm = await counter({ totallyUnknown: 1 } as Record<string, unknown>);
    expect(unknownTerm.statusCode).toBe(400);
    expect(unknownTerm.json().error.message).toContain('terms.totallyUnknown');
  });

  it('remind follows the decide right (symmetric): consumer in proposed, provider in countered', async () => {
    const proposed = await propose({ notes: 'x' });
    agreementId = proposed.json().id as string;
    // proposed: consumer may remind (rate window anchors at creation → 429
    // immediately, with the R13 anchor note); the provider may not.
    const consumerRemind = await remind(consumer.token);
    expect(consumerRemind.statusCode).toBe(429);
    expect(consumerRemind.json().error.message).toContain('PROPOSAL CREATION');
    const providerRemindInProposed = await remind(provider.token);
    expect(providerRemindInProposed.statusCode).toBe(403);
    expect(providerRemindInProposed.json().error.message).toContain('PROVIDER');

    await counter({ notes: 'counter' });
    // countered: the PROVIDER may remind the consumer; the consumer may not.
    const consumerRemindInCountered = await remind(consumer.token);
    expect(consumerRemindInCountered.statusCode).toBe(403);
    expect(consumerRemindInCountered.json().error.message).toContain('CONSUMER');
    const providerRemind = await remind(provider.token);
    expect(providerRemind.statusCode).toBe(429); // same creation-anchored window
    expect(providerRemind.json().error.message).toContain('PROPOSAL CREATION');
  });

  it('terminate still works from countered (any non-terminal state, either party)', async () => {
    const proposed = await propose({ notes: 'x' });
    agreementId = proposed.json().id as string;
    await counter({ notes: 'y' });
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');
  });

  it('the status filter accepts countered; legacy decide behavior is unchanged', async () => {
    // Regression: provider decides a PROPOSED agreement exactly as before.
    const proposed = await propose({ notes: 'plain' });
    agreementId = proposed.json().id as string;
    const accepted = await decide('accept', provider.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().counteredTerms).toBeNull();

    // The list filter knows the new status.
    const counteredProposal = await propose({ notes: 'second' });
    agreementId = counteredProposal.json().id as string;
    await counter({ notes: 'countered version' });
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&status=countered`,
      headers: auth(consumer.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().agreements.map((a: { id: string }) => a.id)).toContain(agreementId);
  });
});
