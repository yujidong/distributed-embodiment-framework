/**
 * R44-F1 第二阶段（plan-r84 Wave D）：fast-lane 并发自适应。
 *
 * 背景：R44 城市测量里 fast-lane 固定 32 槽对 std 档是空转、对 dense 档曾
 * 手动调到 16 才首次触到引擎排队边界——固定值要么自限要么过冲。本模块把
 * 槽位变成一个保守的控制回路：
 *
 * - 升档（additive）：队列持续非空超过 scaleUpQueueMs 且窗口内无 429、
 *   失败率不超阈值 → +stepUp 槽，到 max 封顶。每次升档后重新计时，必须再
 *   持续排队才再升，不会一口气冲顶。
 * - 降档（multiplicative）：窗口内出现 429 立即减半；否则窗口失败率超过
 *   maxFailureRate 也减半，到 min 封底。429 是后端明确说「太多了」，
 *   不等失败率积累。
 * - 两次调整之间有 minAdjustIntervalMs 冷却，避免在边界上振荡。
 *
 * 显式设置 LLM_FAST_LANE_CONCURRENT 时保持旧的固定语义（R44 各档位实验
 * 就是用它钉死槽位的）——fixed 模式不挂控制器。
 */

export interface FastLaneConcurrencyConfig {
  min: number;
  max: number;
  /** LLM_FAST_LANE_CONCURRENT 显式设置时的钉死值；undefined = 自适应。 */
  fixed?: number;
}

export const FAST_LANE_DEFAULT_MIN = 8;
export const FAST_LANE_DEFAULT_MAX = 32;

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 解析 fast-lane 并发 env。容错风格与 client.ts 里 LLM_FAST_LANE_CONCURRENT
 * 的旧解析一致（模块加载期 parseInt，不 throw）：
 * - LLM_FAST_LANE_CONCURRENT：显式钉死（fixed），优先级最高；
 * - LLM_FAST_LANE_MIN / LLM_FAST_LANE_MAX：自适应区间，默认 8/32；
 *   min > max 时 max 收敛到 min（宁低不高）。
 */
export function parseFastLaneConcurrency(env: NodeJS.ProcessEnv = process.env): FastLaneConcurrencyConfig {
  const fixed = positiveInt(env.LLM_FAST_LANE_CONCURRENT);
  if (fixed !== undefined) {
    return { min: fixed, max: fixed, fixed };
  }
  const min = positiveInt(env.LLM_FAST_LANE_MIN) ?? FAST_LANE_DEFAULT_MIN;
  const maxRaw = positiveInt(env.LLM_FAST_LANE_MAX) ?? FAST_LANE_DEFAULT_MAX;
  return { min, max: Math.max(min, maxRaw) };
}

export interface AdaptiveConcurrencyOptions {
  min: number;
  max: number;
  /** 队列持续非空多少 ms 后才允许升档（默认 250）。 */
  scaleUpQueueMs?: number;
  /** 每次升档加的槽数（默认 4）。 */
  stepUp?: number;
  /** 降档乘数（默认 0.5，即减半）。 */
  downFactor?: number;
  /** 失败率统计窗口（最近 N 次完成，默认 16）。 */
  windowSize?: number;
  /** 窗口失败率超过该值降档（默认 0.25）。 */
  maxFailureRate?: number;
  /** 两次调整的最小间隔 ms（默认 1000）。 */
  minAdjustIntervalMs?: number;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
}

export interface CompletionOutcome {
  ok: boolean;
  /** 后端 429（rate-limited）——立即降档信号。 */
  rateLimited?: boolean;
}

export class AdaptiveConcurrencyController {
  private limit: number;
  private readonly min: number;
  private readonly max: number;
  private readonly scaleUpQueueMs: number;
  private readonly stepUp: number;
  private readonly downFactor: number;
  private readonly windowSize: number;
  private readonly maxFailureRate: number;
  private readonly minAdjustIntervalMs: number;
  private readonly now: () => number;

  private window: CompletionOutcome[] = [];
  /** 队列从何时起持续非空；空队列时归 null。 */
  private queueSince: number | null = null;
  private lastAdjustAt = 0;

  constructor(options: AdaptiveConcurrencyOptions) {
    this.min = Math.max(1, Math.floor(options.min));
    this.max = Math.max(this.min, Math.floor(options.max));
    this.scaleUpQueueMs = options.scaleUpQueueMs ?? 250;
    this.stepUp = Math.max(1, Math.floor(options.stepUp ?? 4));
    this.downFactor = options.downFactor ?? 0.5;
    this.windowSize = Math.max(1, Math.floor(options.windowSize ?? 16));
    this.maxFailureRate = options.maxFailureRate ?? 0.25;
    this.minAdjustIntervalMs = options.minAdjustIntervalMs ?? 1000;
    this.now = options.now ?? Date.now;
    // 从 min 起步：空载不空转，负载来了按上面的节奏爬。
    this.limit = this.min;
  }

  get current(): number {
    return this.limit;
  }

  /** 档位边界（观测端点展示用）。 */
  get minLimit(): number {
    return this.min;
  }

  get maxLimit(): number {
    return this.max;
  }

  /** 队列深度观测（入队/出队时由 RequestQueue 喂入）。 */
  observeQueue(depth: number): void {
    if (depth > 0) {
      if (this.queueSince === null) this.queueSince = this.now();
    } else {
      this.queueSince = null;
    }
  }

  /**
   * 一次请求完成的归宿。429 立即降档；窗口失败率超限降档；否则若队列已
   * 持续非空足够久则升档。返回 true 表示 limit 变了（调用方据此同步
   * RequestQueue 的 maxConcurrent）。
   */
  recordCompletion(outcome: CompletionOutcome): boolean {
    this.window.push(outcome);
    if (this.window.length > this.windowSize) this.window.shift();

    const now = this.now();
    if (now - this.lastAdjustAt < this.minAdjustIntervalMs) return false;

    if (outcome.rateLimited === true || this.failureRate() > this.maxFailureRate) {
      return this.downshift(now);
    }

    if (
      this.queueSince !== null &&
      now - this.queueSince >= this.scaleUpQueueMs &&
      this.limit < this.max
    ) {
      this.limit = Math.min(this.max, this.limit + this.stepUp);
      this.lastAdjustAt = now;
      // 重新计时：下一次升档需要又一段持续排队。
      this.queueSince = now;
      return true;
    }
    return false;
  }

  private failureRate(): number {
    if (this.window.length === 0) return 0;
    const failed = this.window.filter(o => !o.ok).length;
    return failed / this.window.length;
  }

  private downshift(now: number): boolean {
    const next = Math.max(this.min, Math.floor(this.limit * this.downFactor));
    if (next === this.limit) return false;
    this.limit = next;
    this.lastAdjustAt = now;
    // 降档后重新积累排队证据，不允许立刻升回去。
    this.queueSince = null;
    return true;
  }
}
