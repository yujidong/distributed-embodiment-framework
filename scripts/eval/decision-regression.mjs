#!/usr/bin/env node
// scripts/eval/decision-regression.mjs — plan-r84 F3-1：六块 heldout 回归门禁。
//
// 把散落在 data/devloop/tmp/d1/eval-v5.mjs 与 deploy-lora-v5.mjs smoke 段里的
// 六块 heldout 评测转正为常驻 runner：
//   heldout 语料 → 对 OpenAI 兼容端点逐条请求 → 字段级断言（六块结构 +
//   decision-v1 schema 校验 + action 词表合法性）+ rubric 简评（action 命中/
//   legacy 等价/summary 落地）→ 通过率 JSON + 趋势追加
//   data/devloop/eval-trends/decision-regression.ndjson（每运行一行
//   {ts, model, pass, total, rate, threshold, gatePass}）。
//
// 用法：
//   node scripts/eval/decision-regression.mjs [--limit N] [--model ac-decision-v5]
//     [--base http://127.0.0.1:8000/v1] [--threshold 1.0]
//     [--corpus <ndjson>] [--system-prompt <txt>] [--no-trend]
// 环境：LLM_BASE_URL 等价于 --base（server 同款变量）。
//
// 门禁语义：pass 率（jsonOk && 六块齐 && validateDecisionV1 过 && action 在词表）
// 低于 --threshold（默认 1.0 —— F0-2 验收锚点「strict 六块率恒为 1.00」）exit 1；
// rubric 指标（action_match 等）只报告不进门禁。429/超时/网络错误指数退避重试。
//
// 纯函数（断言/汇总/趋势）在 scripts/eval/gate-lib.mjs，由
// apps/server/src/eval-gates.vitest.test.ts 覆盖。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateDecisionSample,
  judgeGate,
  appendTrendLine,
  pickSpread,
  summarizeSamples,
} from './gate-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ABS = p => resolve(ROOT, p);

const require = createRequire(import.meta.url);
// 校验器与词表映射从 core dist 取（唯一事实源 decision-v1.json 的派生物）；
// dist 必须先 build（AGENTS.md：改源码后 npm run build）。
const { validateDecisionV1 } = require(ABS('packages/core/dist/decision/decision-schema.js'));
const { cognitiveActionToLegacyDecision } = require(ABS('packages/core/dist/decision/cognitive-decision.js'));

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const MODEL = opt('model', 'ac-decision-v5');
const BASE = (opt('base', process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8000/v1')).replace(/\/+$/, '');
const CORPUS = opt('corpus', 'data/devloop/tmp/d1/lora-adapter-v5/labeled-corpus.ndjson');
const SYS_PROMPT = opt('system-prompt', 'data/devloop/tmp/d1/system-prompt-v5.txt');
const LIMIT = Number(opt('limit', '0')); // 0 = 全量 heldout
const THRESHOLD = Number(opt('threshold', '1.0'));
const TREND = opt('trend', 'data/devloop/eval-trends/decision-regression.ndjson');
const NO_TREND = args.includes('--no-trend');
const OUT = opt('out', ''); // 结果 JSON 落盘路径（缺省只 stdout）
const TIMEOUT_MS = Number(opt('timeout', '120000'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 串行 + 指数退避的单条 chat 请求（429/5xx/网络错误/超时重试，最多 6 次）。 */
async function ask(systemPrompt, instruction) {
  const delays = [0, 2000, 5000, 10000, 20000, 40000];
  let lastError = 'unreachable';
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.log(`    … backoff ${delays[attempt]}ms (attempt ${attempt + 1})`);
      await sleep(delays[attempt]);
    }
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: instruction },
          ],
          temperature: 0,
          max_tokens: 700,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        // 4xx（非 429）是确定性错误，重试无意义。
        return { error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
      }
      const j = await res.json();
      return { text: j?.choices?.[0]?.message?.content ?? '', ms: Date.now() - t0 };
    } catch (e) {
      lastError = String(e?.message ?? e);
    }
  }
  return { error: lastError };
}

async function main() {
  if (!existsSync(ABS(CORPUS)) || !existsSync(ABS(SYS_PROMPT))) {
    console.error(`error: corpus or system prompt not found (corpus=${ABS(CORPUS)}, prompt=${ABS(SYS_PROMPT)})`);
    process.exit(2);
  }
  const systemPrompt = readFileSync(ABS(SYS_PROMPT), 'utf8').trim();
  const corpus = readFileSync(ABS(CORPUS), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const heldout = corpus.filter(s => s.heldout);
  if (heldout.length === 0) {
    console.error('error: corpus has no heldout rows');
    process.exit(2);
  }
  const evalSet = pickSpread(heldout, LIMIT);
  console.log(`decision-regression: model=${MODEL} base=${BASE}`);
  console.log(`eval set: ${evalSet.length}/${heldout.length} heldout (threshold=${THRESHOLD})`);

  const results = [];
  const failures = [];
  for (const [i, s] of evalSet.entries()) {
    const out = await ask(systemPrompt, s.instruction);
    if (out.error !== undefined) {
      results.push({ pass: false, action: null, checks: {}, error: out.error });
      failures.push({ slice: i, target: s.action, error: out.error });
      console.log(`  [${i + 1}/${evalSet.length}] REQUEST-FAIL target=${s.action} — ${out.error}`);
      continue;
    }
    const r = evaluateDecisionSample({
      text: out.text,
      target: s.action,
      instruction: s.instruction,
      validateDecision: validateDecisionV1,
      toLegacyAction: cognitiveActionToLegacyDecision,
    });
    results.push(r);
    if (!r.pass) failures.push({ slice: i, target: s.action, action: r.action, checks: r.checks, schemaErrors: r.schemaErrors });
    console.log(
      `  [${i + 1}/${evalSet.length}] ${r.pass ? 'PASS' : 'FAIL'} action=${r.action} (target ${s.action}) ` +
      `match=${r.checks.actionMatch} legacy=${r.checks.legacyMatch} ${out.ms}ms`,
    );
  }

  const summary = summarizeSamples(results);
  const gate = judgeGate({ pass: summary.pass, total: summary.total, threshold: THRESHOLD });
  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    base: BASE,
    corpus: CORPUS,
    heldoutTotal: heldout.length,
    ...summary,
    threshold: THRESHOLD,
    gatePass: gate.gatePass,
    failures,
  };
  console.log(`\nmetrics: ${JSON.stringify(summary.metrics)}`);
  console.log(`action_dist: ${JSON.stringify(summary.actionDist)}`);
  console.log(`RESULT: ${summary.pass}/${summary.total} (${((summary.rate ?? 0) * 100).toFixed(1)}%) gate=${gate.gatePass ? 'PASS' : 'FAIL'} (threshold=${THRESHOLD})`);

  if (OUT) {
    mkdirSync(dirname(ABS(OUT)), { recursive: true });
    writeFileSync(ABS(OUT), JSON.stringify(report, null, 2));
    console.log(`report: ${ABS(OUT)}`);
  }
  if (!NO_TREND) {
    mkdirSync(dirname(ABS(TREND)), { recursive: true });
    const line = appendTrendLine(
      text => appendFileSync(ABS(TREND), text),
      { model: MODEL, pass: summary.pass, total: summary.total, rate: summary.rate, threshold: THRESHOLD, gatePass: gate.gatePass },
    );
    console.log(`trend: ${ABS(TREND)} ← ${JSON.stringify(line)}`);
  }
  process.exit(gate.gatePass ? 0 : 1);
}

main().catch(error => {
  console.error(`decision-regression failed: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
