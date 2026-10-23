/**
 * @vitest-environment node
 *
 * R44-F1 第二阶段（plan-r84 Wave D）：fast-lane 并发自适应。
 * - parseFastLaneConcurrency：env 解析（默认 8/32、MIN/MAX 覆盖、
 *   LLM_FAST_LANE_CONCURRENT 钉死、容错）。
 * - AdaptiveConcurrencyController：升档（持续排队 + 后端健康）、降档
 *   （429 立即 / 失败率超限）、边界 clamp、调整冷却。
 * - RequestQueue 接线：完成事件驱动控制器并同步 maxConcurrent。
 */

import { describe, expect, it } from 'vitest';

import {
  AdaptiveConcurrencyController,
  FAST_LANE_DEFAULT_MAX,
  FAST_LANE_DEFAULT_MIN,
  parseFastLaneConcurrency,
} from '../src/adaptive-concurrency';
import { RequestQueue } from '../src/client';

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('parseFastLaneConcurrency', () => {
  it('defaults to adaptive 8..32 with no env', () => {
    expect(parseFastLaneConcurrency({})).toEqual({
      min: FAST_LANE_DEFAULT_MIN,
      max: FAST_LANE_DEFAULT_MAX,
      fixed: undefined,
    });
  });

  it('LLM_FAST_LANE_MIN / LLM_FAST_LANE_MAX override the bounds', () => {
    expect(parseFastLaneConcurrency({ LLM_FAST_LANE_MIN: '4', LLM_FAST_LANE_MAX: '16' })).toEqual({
      min: 4, max: 16, fixed: undefined,
    });
  });

  it('LLM_FAST_LANE_CONCURRENT pins a fixed limit (legacy R44 workflow)', () => {
    expect(parseFastLaneConcurrency({ LLM_FAST_LANE_CONCURRENT: '16' })).toEqual({
      min: 16, max: 16, fixed: 16,
    });
    // 钉死优先于区间配置。
    expect(
      parseFastLaneConcurrency({ LLM_FAST_LANE_CONCURRENT: '16', LLM_FAST_LANE_MIN: '4' }),
    ).toEqual({ min: 16, max: 16, fixed: 16 });
  });

  it('tolerates garbage: invalid values fall back to defaults, min > max collapses to min', () => {
    expect(parseFastLaneConcurrency({ LLM_FAST_LANE_MIN: 'abc', LLM_FAST_LANE_MAX: '-3' })).toEqual({
      min: FAST_LANE_DEFAULT_MIN, max: FAST_LANE_DEFAULT_MAX, fixed: undefined,
    });
    expect(parseFastLaneConcurrency({ LLM_FAST_LANE_MIN: '24', LLM_FAST_LANE_MAX: '8' })).toEqual({
      min: 24, max: 24, fixed: undefined,
    });
    expect(parseFastLaneConcurrency({ LLM_FAST_LANE_CONCURRENT: '0' })).toEqual({
      min: FAST_LANE_DEFAULT_MIN, max: FAST_LANE_DEFAULT_MAX, fixed: undefined,
    });
  });
});

describe('AdaptiveConcurrencyController', () => {
  const base = {
    min: 8,
    max: 32,
    stepUp: 4,
    scaleUpQueueMs: 250,
    minAdjustIntervalMs: 1000,
  };

  it('starts at min and upshifts only after the queue stays non-stop busy', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, now: clock.now });
    expect(c.current).toBe(8);

    // 队列刚非空就完成 → 不够持续，不升档。
    c.observeQueue(3);
    clock.advance(100);
    expect(c.recordCompletion({ ok: true })).toBe(false);
    expect(c.current).toBe(8);

    // 持续非空超过 scaleUpQueueMs → 升一档。
    clock.advance(200); // queueSince 起算已 300ms
    expect(c.recordCompletion({ ok: true })).toBe(true);
    expect(c.current).toBe(12);
  });

  it('re-arms after each upshift: another sustained period is needed for the next step', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, now: clock.now });
    c.observeQueue(5);
    clock.advance(300);
    c.recordCompletion({ ok: true }); // → 12, queueSince 重置
    clock.advance(1000); // 冷却结束，但 queueSince 重置后只过了 1000ms…
    // 冷却 1000ms 内不允许再调；推进到冷却结束且排队持续也够。
    clock.advance(1000);
    expect(c.recordCompletion({ ok: true })).toBe(true);
    expect(c.current).toBe(16);
  });

  it('does not upshift when the queue drains (no sustained pressure)', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, now: clock.now });
    c.observeQueue(2);
    clock.advance(500);
    c.observeQueue(0); // 队列排空，证据清零
    clock.advance(2000);
    expect(c.recordCompletion({ ok: true })).toBe(false);
    expect(c.current).toBe(8);
  });

  it('clamps upshift at max', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, max: 13, now: clock.now });
    c.observeQueue(2);
    clock.advance(300);
    c.recordCompletion({ ok: true }); // 8 → 12
    clock.advance(1300);
    c.recordCompletion({ ok: true }); // 12 → min(13, 16) = 13
    expect(c.current).toBe(13);
    clock.advance(1300);
    expect(c.recordCompletion({ ok: true })).toBe(false); // 到顶不再变
    expect(c.current).toBe(13);
  });

  it('429 downshifts immediately (halving), even with a healthy history', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, now: clock.now });
    c.observeQueue(4);
    clock.advance(300);
    c.recordCompletion({ ok: true }); // → 12
    clock.advance(1100);
    expect(
      c.recordCompletion({ ok: false, rateLimited: true }),
    ).toBe(true);
    // floor(12 * 0.5) = 6 → clamp 到 min 8。
    expect(c.current).toBe(8);
  });

  it('downshifts when the window failure rate exceeds the threshold (no 429 needed)', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({
      ...base,
      windowSize: 4,
      maxFailureRate: 0.25,
      now: clock.now,
    });
    // 先升到 12。
    c.observeQueue(4);
    clock.advance(300);
    c.recordCompletion({ ok: true });
    expect(c.current).toBe(12);
    clock.advance(1100);
    // 窗口 [ok] → 加 1 个失败 = 1/2 = 0.5 > 0.25 → 降档。
    expect(c.recordCompletion({ ok: false })).toBe(true);
    expect(c.current).toBe(8); // floor(12/2)=6 → clamp 8
  });

  it('does not downshift below min', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, windowSize: 2, now: clock.now });
    expect(c.recordCompletion({ ok: false, rateLimited: true })).toBe(false);
    expect(c.current).toBe(8);
  });

  it('honours the adjust cooldown', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, now: clock.now });
    c.observeQueue(4);
    clock.advance(300);
    c.recordCompletion({ ok: true }); // → 12 at t+300
    // 冷却内（<1000ms）即使证据齐备也不动。
    clock.advance(500);
    expect(c.recordCompletion({ ok: false, rateLimited: true })).toBe(false);
    expect(c.current).toBe(12);
  });

  it('after a downshift, queue pressure must rebuild before an upshift', () => {
    const clock = fakeClock();
    const c = new AdaptiveConcurrencyController({ ...base, windowSize: 4, now: clock.now });
    c.observeQueue(4);
    clock.advance(300);
    c.recordCompletion({ ok: true }); // → 12
    clock.advance(1100);
    c.recordCompletion({ ok: false, rateLimited: true }); // → 8, queueSince 清零
    // 队列仍在（observeQueue 未再报 0），但 queueSince 已清零——
    // 立即的完成不升档。
    clock.advance(1100);
    expect(c.recordCompletion({ ok: true })).toBe(false);
    expect(c.current).toBe(8);
    // 重新报告排队并持续后才可以升。
    c.observeQueue(4);
    clock.advance(1300);
    expect(c.recordCompletion({ ok: true })).toBe(true);
    expect(c.current).toBe(12);
  });
});

describe('RequestQueue × AdaptiveConcurrencyController wiring', () => {
  it('starts at controller.current and resizes the live limit on adjustments', async () => {
    const clock = fakeClock();
    const controller = new AdaptiveConcurrencyController({
      min: 2,
      max: 8,
      stepUp: 2,
      scaleUpQueueMs: 100,
      minAdjustIntervalMs: 0,
      windowSize: 4,
      now: clock.now,
    });
    const queue = new RequestQueue(99 /* ignored: controller wins */, controller);
    expect(queue.getStats().maxConcurrent).toBe(2);

    // 2 个慢任务占满槽位 + 2 个排队 → 持续排队证据。
    const slow = () => new Promise<string>(resolve => setTimeout(() => resolve('ok'), 60));
    const runs = [queue.run(slow), queue.run(slow), queue.run(slow), queue.run(slow)];
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queue.getStats().queued).toBe(2);
    clock.advance(500); // 让控制器看到持续排队（时钟是注入的，与真实墙钟无关）
    await Promise.all(runs);
    expect(controller.current).toBeGreaterThan(2);
    expect(queue.getStats().maxConcurrent).toBe(controller.current);
  });

  it('a 429 from the provider task downshifts the live limit', async () => {
    const clock = fakeClock();
    const controller = new AdaptiveConcurrencyController({
      min: 1,
      max: 8,
      minAdjustIntervalMs: 0,
      now: clock.now,
    });
    const queue = new RequestQueue(1, controller);
    // 先升上去。
    controller.observeQueue(3);
    clock.advance(500);
    controller.recordCompletion({ ok: true });
    queue.setMaxConcurrent(controller.current);
    const before = queue.getStats().maxConcurrent;
    expect(before).toBeGreaterThan(1);

    await expect(
      queue.run(async () => {
        throw new Error('API request failed: 429 Too Many Requests');
      }),
    ).rejects.toThrow(/429/);
    expect(queue.getStats().maxConcurrent).toBeLessThan(before);
    expect(queue.getStats().maxConcurrent).toBe(controller.current);
  });

  it('stats expose the adaptive bounds for observability', () => {
    const controller = new AdaptiveConcurrencyController({ min: 3, max: 9 });
    const queue = new RequestQueue(3, controller);
    expect(queue.getStats()).toMatchObject({ adaptive: { min: 3, max: 9 } });
    expect(new RequestQueue(3).getStats()).not.toHaveProperty('adaptive');
  });
});
