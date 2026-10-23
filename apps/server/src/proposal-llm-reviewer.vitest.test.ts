/**
 * @vitest-environment node
 *
 * LLM semantic reviewer tests (P-B, multi-user-simulation-design.md §5.2).
 *
 * The LLM client is mocked (ReviewLlmClient structural interface). Covered:
 * - the three verdict tiers (allow / reject / escalate) pass through;
 * - the verdict request uses ChatParams.format constrained decoding;
 * - malformed output degrades to `escalate`;
 * - call failure / timeout (Fix-12 platform policy): LOW-risk proposals
 *   auto-approve with source 'review-timeout-auto-approve' (owner can
 *   revert), MEDIUM-risk degrades to `escalate`, and the policy switch
 *   (timeoutAutoApprove: false) restores pure escalate;
 * - high-risk proposals escalate WITHOUT ever calling the LLM (§5.2 code
 *   invariant);
 * - the prompt carries the environment context (zones, devices, overlays).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import type { AuthUser } from './auth/index.js';
import { openDatabase, type EafDatabase } from './db/database.js';
import { EnvironmentStore } from './db/environment-store.js';
import { UserStore } from './db/user-store.js';
import { LLMReviewer, DEFAULT_REVIEW_TIMEOUT_MS } from './proposal-llm-reviewer.js';
import type { ReviewInput } from './proposal-reviewer.js';

const author: AuthUser = { id: 'user-1', email: 'author@example.com', displayName: 'Author' };

function verdictJson(outcome: string, reason = 'because') {
  return { content: JSON.stringify({ outcome, reason }), model: 'mock-model' };
}

describe('LLMReviewer (P-B semantic review)', () => {
  let db: EafDatabase;
  let envStore: EnvironmentStore;
  let envId: string;
  let ownerId: string;
  let llm: { chat: Mock<[ChatParams], Promise<ChatResponse>> };
  let reviewer: LLMReviewer;

  function input(overrides: Partial<ReviewInput> = {}): ReviewInput {
    return {
      envId,
      author,
      kind: 'install-devices',
      payload: {
        devices: [{ name: 'Corridor Sensor', type: 'temperature-sensor', zoneId: 'zone-a' }],
      },
      riskLevel: 'low',
      ...overrides,
    };
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    envStore = new EnvironmentStore(db);
    const owner = new UserStore(db).create('owner@example.com', 'hash', 'Owner');
    ownerId = owner.id;
    const env = envStore.createEnvironment({
      name: 'Review Lab',
      ownerId: owner.id,
      mapData: { zones: [{ id: 'zone-a', name: 'Corridor' }, { id: 'zone-b' }] },
    });
    envId = env.id;
    envStore.createDevice({
      envId,
      ownerId: owner.id,
      name: 'Existing HVAC',
      type: 'hvac',
      capabilities: ['temperature-control'],
      zoneId: 'zone-a',
    });
    llm = { chat: vi.fn<[ChatParams], Promise<ChatResponse>>(async () => verdictJson('allow')) };
    reviewer = new LLMReviewer({ llm, envStore, timeoutMs: 50 });
  });

  afterEach(() => {
    db.close();
  });

  it('passes through allow / reject / escalate verdicts with reasons', async () => {
    llm.chat.mockResolvedValueOnce(verdictJson('allow', 'looks reasonable'));
    expect(await reviewer.review(input())).toEqual({
      outcome: 'allow',
      reason: 'looks reasonable',
      source: 'ai',
    });

    llm.chat.mockResolvedValueOnce(verdictJson('reject', 'absurd scenario'));
    expect((await reviewer.review(input())).outcome).toBe('reject');

    llm.chat.mockResolvedValueOnce(verdictJson('escalate', 'unsure'));
    expect((await reviewer.review(input())).outcome).toBe('escalate');
  });

  it('requests constrained decoding via ChatParams.format and sends env context', async () => {
    await reviewer.review(input());
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const params = llm.chat.mock.calls[0][0];
    expect(params.format).toMatchObject({
      type: 'object',
      properties: { outcome: { enum: ['allow', 'reject', 'escalate'] } },
      required: ['outcome', 'reason'],
    });
    const userMessage = params.messages.find(m => m.role === 'user')!;
    expect(userMessage.content).toContain('Corridor Sensor');
    expect(userMessage.content).toContain('Existing HVAC');
    expect(userMessage.content).toContain('zone-a');
  });

  it('degrades to escalate on unparseable output', async () => {
    llm.chat.mockResolvedValueOnce({ content: 'I cannot decide this, sorry', model: 'mock' });
    const verdict = await reviewer.review(input());
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reason).toContain('non-compliant');
  });

  it('degrades to escalate on schema-breaking output (unknown outcome)', async () => {
    llm.chat.mockResolvedValueOnce(verdictJson('approve-everything'));
    expect((await reviewer.review(input())).outcome).toBe('escalate');

    llm.chat.mockResolvedValueOnce({ content: '{"outcome":"allow"}', model: 'mock' });
    expect((await reviewer.review(input())).outcome).toBe('escalate');
  });

  it('recovers a verdict embedded in prose/code fences', async () => {
    llm.chat.mockResolvedValueOnce({
      content: 'Here is my verdict:\n```json\n{"outcome":"allow","reason":"fine"}\n```',
      model: 'mock',
    });
    expect((await reviewer.review(input())).outcome).toBe('allow');
  });

  it('T-103: a think-wrapped verdict parses to the real outcome', async () => {
    llm.chat.mockResolvedValueOnce({
      content:
        '<think>drafting... {"outcome":"reject","reason":"draft guess"}</think>\n' +
        '{"outcome":"allow","reason":"final answer"}',
      model: 'mock',
    });
    expect(await reviewer.review(input())).toEqual({
      outcome: 'allow',
      reason: 'final answer',
      source: 'ai',
    });
  });

  it('T-103: a draft object before the final verdict does not win', async () => {
    llm.chat.mockResolvedValueOnce({
      content:
        'Considering {"outcome":"reject","reason":"early draft"} — final call: ' +
        '{"outcome":"escalate","reason":"final"}',
      model: 'mock',
    });
    expect(await reviewer.review(input())).toEqual({
      outcome: 'escalate',
      reason: 'final',
      source: 'ai',
    });
  });

  it('degrades to escalate when the LLM call fails on a MEDIUM-risk proposal', async () => {
    llm.chat.mockRejectedValueOnce(new Error('connection refused'));
    const verdict = await reviewer.review(input({ riskLevel: 'medium' }));
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reason).toContain('connection refused');
  });

  it('degrades to escalate when the LLM call times out on a MEDIUM-risk proposal', async () => {
    llm.chat.mockImplementationOnce(() => new Promise<ChatResponse>(() => {}));
    const verdict = await reviewer.review(input({ riskLevel: 'medium' }));
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reason).toContain('timed out');
  });

  it('T-023: the review budget arrives as an AbortSignal that fires on timeout', async () => {
    // The reviewer must CANCEL the in-flight call, not just race it — the
    // orphaned fetch kept holding a global LLM concurrency slot for up to
    // the provider timeout (120s), starving simulation decisions.
    let received: AbortSignal | undefined;
    llm.chat.mockImplementationOnce(params => new Promise<ChatResponse>((_resolve, reject) => {
      received = params.signal;
      // A client that honors signals (the real LLMClient/providers do).
      params.signal?.addEventListener('abort', () => {
        reject(new Error('This operation was aborted'));
      }, { once: true });
    }));
    const verdict = await reviewer.review(input({ riskLevel: 'medium' }));
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reason).toContain('timed out');
    // The signal was passed AND aborted by the budget timer (reviewer's
    // timeoutMs is 50ms in this suite).
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received!.aborted).toBe(true);
  });

  it('T-023: a signal-respecting client that answers inside the budget is used verbatim', async () => {
    // The signal must not fire while the budget is intact — a slow-but-
    // within-budget review still returns the model's verdict.
    llm.chat.mockImplementationOnce(async params => {
      expect(params.signal?.aborted).toBe(false);
      return verdictJson('allow', 'within budget');
    });
    const verdict = await reviewer.review(input({ riskLevel: 'medium' }));
    expect(verdict).toEqual({ outcome: 'allow', reason: 'within budget', source: 'ai' });
  });

  it('Fix-12 policy: timeout + LOW-risk + rule-check-passed auto-approves with an audit marker', async () => {
    // reviewer has timeoutMs: 50; the hanging chat always trips the budget.
    llm.chat.mockImplementationOnce(() => new Promise<ChatResponse>(() => {}));
    const verdict = await reviewer.review(input({ riskLevel: 'low' }));
    expect(verdict.outcome).toBe('allow');
    expect(verdict.source).toBe('review-timeout-auto-approve');
    expect(verdict.reason).toContain('timed out');
    // T-063(e): code-authored reasons are localized (zh default).
    expect(verdict.reason).toContain('自动通过');
    expect(verdict.reason).toContain('回滚');
  });

  it('Fix-12 policy: a failed LLM call (not only timeout) also auto-approves low-risk', async () => {
    llm.chat.mockRejectedValueOnce(new Error('connection refused'));
    const verdict = await reviewer.review(input({ riskLevel: 'low' }));
    expect(verdict).toMatchObject({
      outcome: 'allow',
      source: 'review-timeout-auto-approve',
    });
    expect(verdict.reason).toContain('connection refused');
  });

  it('Fix-12 policy off (timeoutAutoApprove: false): low-risk failure restores pure escalate', async () => {
    const strictReviewer = new LLMReviewer({ llm, envStore, timeoutMs: 50, timeoutAutoApprove: false });
    llm.chat.mockRejectedValueOnce(new Error('connection refused'));
    const verdict = await strictReviewer.review(input({ riskLevel: 'low' }));
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.source).toBe('ai');
    expect(verdict.reason).toContain('connection refused');
  });

  it('Fix-12: the default budget is 60s — a 20s cold-start review completes (old 15s budget escalated it)', async () => {
    expect(DEFAULT_REVIEW_TIMEOUT_MS).toBe(60_000);
    vi.useFakeTimers();
    try {
      const defaultBudgetReviewer = new LLMReviewer({ llm, envStore });
      llm.chat.mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        return verdictJson('allow', 'cold start finished');
      });
      const pending = defaultBudgetReviewer.review(input());
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending).outcome).toBe('allow');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Fix-12: deps.timeoutMs still overrides the default budget', async () => {
    // The suite-wide reviewer uses timeoutMs: 50 — a 20s response must NOT
    // be waited for when the operator/deps shrink the budget. Medium risk
    // keeps the degradation at escalate (low risk would take the
    // auto-approve policy path — covered above).
    vi.useFakeTimers();
    try {
      llm.chat.mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        return verdictJson('allow');
      });
      const pending = reviewer.review(input({ riskLevel: 'medium' }));
      await vi.advanceTimersByTimeAsync(100);
      const verdict = await pending;
      expect(verdict.outcome).toBe('escalate');
      expect(verdict.reason).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates high-risk proposals without ever calling the LLM', async () => {
    const verdict = await reviewer.review(input({ riskLevel: 'high' }));
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reason).toContain('高风险提案'); // T-063(e): localized
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('reviews medium-risk proposals via the LLM (only high is force-escalated)', async () => {
    llm.chat.mockResolvedValueOnce(verdictJson('reject', 'medium but absurd'));
    expect((await reviewer.review(input({ riskLevel: 'medium' }))).outcome).toBe('reject');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // T44 (R4, u3 F3) — aiReview faithfulness: the modify-object assembly fix.
  // patch.capabilities is the POST-change full list; without the target's
  // before-state a REMOVAL was invisible to the model, and a capability
  // removal got narrated as "adds smoke detection… in zone bldg-m-f1".
  // ---------------------------------------------------------------------------

  let agentId: string;

  function modifyInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
    return input({
      kind: 'modify-object',
      payload: { targetId: agentId, patch: { capabilities: ['detect-smoke'] } },
      riskLevel: 'medium',
      ...overrides,
    });
  }

  it('modify-object (agent target): prompt carries target-before + patch-diff exposing the removal', async () => {
    const agent = envStore.createAgent({
      envId,
      ownerId,
      name: 'WD-Guard',
      capabilities: ['detect-smoke', 'play-alert', 'set-fan-speed'],
      managedZoneIds: ['zone-a'],
    });
    agentId = agent.id;

    await reviewer.review(modifyInput());
    const userMessage = llm.chat.mock.calls[0][0].messages.find(m => m.role === 'user')!.content;

    // The before-face: the target's CURRENT state from the env store.
    expect(userMessage).toContain('<untrusted name="target-before"');
    expect(userMessage).toContain('WD-Guard');
    expect(userMessage).toContain('set-fan-speed'); // the capability being removed is VISIBLE
    expect(userMessage).toContain('play-alert');
    // The diff: explicit before → after with added/removed sets.
    expect(userMessage).toContain('<untrusted name="patch-diff"');
    expect(userMessage).toContain('"removed"');
    expect(userMessage).toContain('play-alert');
    // The S1 block separation is intact: proposal, target and context are
    // distinct blocks (an env-context smoke device stays OUT of the proposal face).
    expect(userMessage).toContain('<untrusted name="proposal-payload"');
    expect(userMessage).toContain('<untrusted name="environment-context"');
  });

  it('modify-object (device target): before-face resolves the device row', async () => {
    const devices = envStore.devicesOf(envId);
    await reviewer.review(input({
      kind: 'modify-object',
      payload: { targetId: devices[0].id, patch: { name: 'Renamed HVAC' } },
      riskLevel: 'medium',
    }));
    const userMessage = llm.chat.mock.calls[0][0].messages.find(m => m.role === 'user')!.content;
    expect(userMessage).toContain('<untrusted name="target-before"');
    expect(userMessage).toContain('Existing HVAC'); // device before-state present
    expect(userMessage).toContain('"objectType": "device"');
    // Scalar diff shape (from → to, no added/removed for scalars).
    expect(userMessage).toContain('"from": "Existing HVAC"');
    expect(userMessage).toContain('"to": "Renamed HVAC"');
  });

  it('modify-object with an unresolvable target: prompt degrades to payload-only (as before T44)', async () => {
    await reviewer.review(input({
      kind: 'modify-object',
      payload: { targetId: 'no-such-object', patch: { capabilities: ['x'] } },
      riskLevel: 'medium',
    }));
    const userMessage = llm.chat.mock.calls[0][0].messages.find(m => m.role === 'user')!.content;
    expect(userMessage).not.toContain('target-before');
    expect(userMessage).not.toContain('patch-diff');
    expect(userMessage).toContain('<untrusted name="proposal-payload"');
    expect(userMessage).toContain('<untrusted name="environment-context"');
  });

  it('non-modify-object kinds are unchanged (no target-before face)', async () => {
    await reviewer.review(input()); // install-devices
    const userMessage = llm.chat.mock.calls[0][0].messages.find(m => m.role === 'user')!.content;
    expect(userMessage).not.toContain('target-before');
    expect(userMessage).toContain('<untrusted name="proposal-payload"');
  });

  it('the system prompt carries the faithfulness rules (restatement + traceability + escalate-on-drift)', async () => {
    const agent = envStore.createAgent({
      envId,
      ownerId,
      name: 'WD-Guard',
      capabilities: ['detect-smoke'],
    });
    agentId = agent.id;
    await reviewer.review(modifyInput());
    const systemMessage = llm.chat.mock.calls[0][0].messages.find(m => m.role === 'system')!.content;
    expect(systemMessage).toContain('FAITHFULNESS RULES');
    expect(systemMessage).toContain('target-before');
    expect(systemMessage).toContain('escalate');
  });
});
