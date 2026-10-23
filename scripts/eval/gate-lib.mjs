// scripts/eval/gate-lib.mjs — plan-r84 Wave F3 的纯函数共享库。
//
// 两个 runner（decision-regression.mjs / acceptance-gate.mjs）共用的确定性
// 逻辑全部收敛在这里：样本评估、汇总、门禁判定、失败聚类、趋势追加。
// 与平台运行期零耦合（不 fetch、不读环境变量），core 的校验器由调用方注入，
// 因此 apps/server 的 vitest 可以直接 import 本文件做单测
// （参照 nl-metamorphic.vitest.test.ts import scripts/ 的既有惯例）。

/** 六块契约块名（decision-v1 的顶层键；唯一事实源是 schema 文件本身）。 */
export const SIX_BLOCKS = ['situation', 'goals', 'actionPlan', 'explanation', 'collaboration', 'uncertainty'];

/** 与 packages/llm-integration strip-think 同一契约：剥掉 qwen 风格 think 块。 */
export function stripThink(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * 从模型输出提取 JSON 对象：先整串 parse，失败退回首个 '{' 到末个 '}'
 * 切片（与 eval-v5.mjs 的既有口径一致）。失败返回 null。
 */
export function extractJsonObject(text) {
  const clean = stripThink(text);
  try {
    const parsed = JSON.parse(clean);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch { /* fall through */ }
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(clean.slice(first, last + 1));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch { /* keep null */ }
  }
  return null;
}

/**
 * 单样本字段级断言 + rubric 简评。
 *
 * deps:
 *   validateDecision(payload) → { valid, errors }（server 侧 validateDecisionV1）
 *   toLegacyAction(action)   → legacy 决策词（cognitiveActionToLegacyDecision）
 *
 * 门禁口径 pass = jsonOk && sixBlocks && schemaValid && actionInVocab
 * （F0-2 验收锚点：格式层必须恒过）；actionMatch / legacyMatch /
 * summaryGrounded 是语义 rubric，只报告不进门禁。
 */
export function evaluateDecisionSample({ text, target, instruction, validateDecision, toLegacyAction }) {
  const parsed = extractJsonObject(text);
  const checks = {
    jsonOk: parsed !== null,
    sixBlocks: false,
    schemaValid: false,
    actionInVocab: false,
    actionMatch: false,
    legacyMatch: false,
    summaryNonEmpty: false,
    summaryGrounded: false,
  };
  const schemaErrors = [];
  let action = null;
  if (parsed !== null) {
    checks.sixBlocks = SIX_BLOCKS.every(b => b in parsed);
    const verdict = validateDecision(parsed);
    checks.schemaValid = verdict.valid === true;
    if (!checks.schemaValid) schemaErrors.push(...(verdict.errors ?? []).slice(0, 3));
    const candidate = parsed?.actionPlan?.primary?.action;
    if (typeof candidate === 'string' && candidate.length > 0) {
      // 词表合法性以 legacy 映射不抛为准（schema 的 enum 已兜一层）。
      try {
        const legacy = toLegacyAction(candidate);
        checks.actionInVocab = typeof legacy === 'string' && legacy.length > 0;
        action = candidate;
        if (action === target) checks.actionMatch = true;
        if (toLegacyAction(action) === toLegacyAction(target)) checks.legacyMatch = true;
      } catch { checks.actionInVocab = false; }
    }
    const summary = parsed?.explanation?.summary;
    if (typeof summary === 'string' && summary.trim().length > 0) {
      checks.summaryNonEmpty = true;
      // grounded 启发式（沿用 eval-v5.mjs）：summary 提及 zone id 或事件词。
      const zone = instruction?.match(/Zone=([\w-]+)/)?.[1] ?? '';
      const evType = instruction?.match(/Event ([\w-]+)/)?.[1] ?? '';
      if ((zone && summary.includes(zone))
        || (evType && summary.toLowerCase().includes(evType.split('-')[0].toLowerCase()))) {
        checks.summaryGrounded = true;
      }
    }
  }
  const pass = checks.jsonOk && checks.sixBlocks && checks.schemaValid && checks.actionInVocab;
  return { pass, action, checks, schemaErrors };
}

/** 汇总样本结果 → 门禁数 + rubric 指标（率值四舍五入到千分位）。 */
export function summarizeSamples(results) {
  const n = results.length;
  const pass = results.filter(r => r.pass).length;
  const rateOf = pred => {
    const hit = results.filter(r => pred(r)).length;
    return n > 0 ? +(hit / n).toFixed(3) : null;
  };
  const actionDist = {};
  for (const r of results) {
    if (typeof r.action === 'string') actionDist[r.action] = (actionDist[r.action] ?? 0) + 1;
  }
  return {
    pass,
    total: n,
    rate: n > 0 ? +(pass / n).toFixed(4) : null,
    metrics: {
      json_ok: rateOf(r => r.checks.jsonOk),
      six_blocks: rateOf(r => r.checks.sixBlocks),
      schema_valid: rateOf(r => r.checks.schemaValid),
      action_in_vocab: rateOf(r => r.checks.actionInVocab),
      action_match: rateOf(r => r.checks.actionMatch),
      legacy_match: rateOf(r => r.checks.legacyMatch),
      summary_nonempty: rateOf(r => r.checks.summaryNonEmpty),
      summary_grounded: rateOf(r => r.checks.summaryGrounded),
    },
    actionDist,
  };
}

/** 均匀抽样（与 deploy-lora-v5.mjs smoke 的步进选样一致）。 */
export function pickSpread(list, limit) {
  if (limit <= 0 || list.length <= limit) return [...list];
  const step = list.length / limit;
  return Array.from({ length: limit }, (_, i) => list[Math.min(list.length - 1, Math.floor(i * step))]);
}

/** 门禁判定：通过率达阈值即过；total=0 恒失败（空集没有验收意义）。 */
export function judgeGate({ pass, total, threshold }) {
  const rate = total > 0 ? pass / total : 0;
  return { rate, gatePass: total > 0 && rate >= threshold, threshold };
}

/**
 * 失败签名归一化：抹掉 UUID / 长数字 / 时间戳，让「同根因」归到同簇
 * （R76-F1 类 429 与 R82 类摩擦在重跑间 id 必然漂移，不归一化聚类恒为 1）。
 */
export function normalizeSignature(text) {
  return String(text ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{10,}\b/g, '<num>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.:Z+-]*/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * 失败聚类：failures = [{ signature, detail? }]，按归一化签名归簇计数，
 * 簇按 count 降序；每簇保留最多 3 条样例 detail。
 */
export function clusterFailures(failures) {
  const clusters = new Map();
  for (const f of failures) {
    const sig = normalizeSignature(f?.signature ?? 'unknown');
    const cluster = clusters.get(sig) ?? { signature: sig, count: 0, examples: [] };
    cluster.count += 1;
    if (f?.detail !== undefined && cluster.examples.length < 3) {
      cluster.examples.push(String(f.detail).slice(0, 200));
    }
    clusters.set(sig, cluster);
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

/** 趋势追加：一行 ndjson（{ts, ...row}），父目录缺则建。返回追加的行对象。 */
export function appendTrendLine(writeLine, row) {
  const line = { ts: new Date().toISOString(), ...row };
  writeLine(JSON.stringify(line) + '\n');
  return line;
}
