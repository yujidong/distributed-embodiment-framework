#!/usr/bin/env node
// scripts/eval/acceptance-gate.mjs — plan-r84 F3-3：统计验收门禁 runner。
//
// 参数化重复执行指定旅程脚本 N 次（persona-r76/r82 这类 playwright 线束），
// 汇总通过率、按阈值判定门禁、失败按 friction/error 签名归簇计数，
// 结果 JSON + 趋势 ndjson 落盘。取代「两轮全绿」的人工判断。
//
// 用法：
//   node scripts/eval/acceptance-gate.mjs --script data/campus-e2e/ui/persona-r82.mjs \
//     [--runs 3] [--threshold 0.95] [--args "0 4"] [--max-errors 0] [--max-friction 0] \
//     [--summary data/devloop/r82-verify/summary.json] [--label r82] \
//     [--timeout-ms 1800000] [--no-trend]
//
// 单次运行判定（三者全满足才算 pass）：
//   1. 子进程 exit code 0（超时杀掉视为失败）；
//   2. --summary 给出的 summary.json 里 errors 数 <= --max-errors（缺省 0）；
//   3. 同上 friction 数 <= --max-friction（缺省 0）。
// 不给 --summary 时只看 exit code。
//
// 门禁语义：pass 率 >= --threshold（默认 0.95）exit 0，否则 exit 1；
// total=0 恒失败。N=20 留给夜间道，本 runner 不关心调度（F4 的事）。
//
// 失败聚类：friction 签名 = persona:where；error 签名 = 归一化错误串
// （UUID/时间戳/长数字抹平，同根因跨 run 归簇）。聚类纯函数在 gate-lib.mjs，
// 由 apps/server/src/eval-gates.vitest.test.ts 覆盖。

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendTrendLine, clusterFailures, judgeGate } from './gate-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ABS = p => resolve(ROOT, p);

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const SCRIPT = opt('script', '');
const RUNS = Number(opt('runs', '3'));
const THRESHOLD = Number(opt('threshold', '0.95'));
const SCRIPT_ARGS = opt('args', '').split(' ').filter(Boolean);
const MAX_ERRORS = Number(opt('max-errors', '0'));
const MAX_FRICTION = Number(opt('max-friction', '0'));
const SUMMARY = opt('summary', '');
const LABEL = opt('label', SCRIPT ? SCRIPT.replace(/.*\//, '').replace(/\.mjs$/, '') : 'gate');
const TIMEOUT_MS = Number(opt('timeout-ms', String(30 * 60 * 1000)));
const OUT_DIR = opt('out-dir', 'data/devloop/acceptance-gate');
const TREND = opt('trend', 'data/devloop/eval-trends/acceptance-gate.ndjson');
const NO_TREND = argv.includes('--no-trend');

if (!SCRIPT || !existsSync(ABS(SCRIPT))) {
  console.error(`error: --script <journey.mjs> required and must exist (got '${SCRIPT}')`);
  process.exit(2);
}
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error(`error: --runs must be a positive integer (got ${RUNS})`);
  process.exit(2);
}

/** 跑一次旅程脚本；resolve { code, timedOut }（code null = 被杀/启动失败）。 */
function runOnce() {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [ABS(SCRIPT), ...SCRIPT_ARGS], { cwd: ROOT });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut });
    });
  });
}

/** 读 summary.json 提失败面：errors / friction 数组（缺文件或形状不符返回 null）。 */
function readSummaryFailures() {
  if (!SUMMARY) return null;
  try {
    const s = JSON.parse(readFileSync(ABS(SUMMARY), 'utf8'));
    const errors = Array.isArray(s.errors) ? s.errors : [];
    const friction = Array.isArray(s.friction) ? s.friction : [];
    return { errors, friction };
  } catch {
    return null;
  }
}

async function main() {
  console.log(`acceptance-gate: script=${SCRIPT} runs=${RUNS} threshold=${THRESHOLD}`);
  console.log(`  pass rule: exit 0 && errors<=${MAX_ERRORS} && friction<=${MAX_FRICTION}${SUMMARY ? ` (summary=${SUMMARY})` : ' (no --summary: exit code only)'}`);

  const runs = [];
  const allFailures = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    const { code, timedOut } = await runOnce();
    const durationMs = Date.now() - t0;
    const summary = readSummaryFailures();
    const errorCount = summary?.errors.length ?? null;
    const frictionCount = summary?.friction.length ?? null;
    let pass = code === 0 && !timedOut;
    if (summary !== null) {
      pass = pass && errorCount <= MAX_ERRORS && frictionCount <= MAX_FRICTION;
    }
    runs.push({ run: i + 1, pass, exitCode: code, timedOut, errors: errorCount, friction: frictionCount, durationMs });
    console.log(
      `  [run ${i + 1}/${RUNS}] ${pass ? 'PASS' : 'FAIL'} exit=${code}${timedOut ? ' (timeout)' : ''} ` +
      `errors=${errorCount ?? 'n/a'} friction=${frictionCount ?? 'n/a'} ${(durationMs / 1000).toFixed(0)}s`,
    );
    if (!pass) {
      if (timedOut) allFailures.push({ signature: 'timeout', detail: `run ${i + 1} exceeded ${TIMEOUT_MS}ms` });
      if (code !== 0 && code !== null) allFailures.push({ signature: `exit-${code}`, detail: `run ${i + 1} exit code ${code}` });
      for (const f of summary?.friction ?? []) {
        allFailures.push({ signature: `friction:${f.persona ?? '?'}:${f.where ?? '?'}`, detail: `${f.expect ?? ''} ⇒ ${f.actual ?? ''}` });
      }
      for (const e of summary?.errors ?? []) {
        const raw = typeof e === 'string' ? e : (e?.e?.message ?? JSON.stringify(e));
        allFailures.push({ signature: `error:${raw}`, detail: `run ${i + 1}: ${raw}` });
      }
    }
  }

  const pass = runs.filter(r => r.pass).length;
  const gate = judgeGate({ pass, total: runs.length, threshold: THRESHOLD });
  const clusters = clusterFailures(allFailures);
  const report = {
    generatedAt: new Date().toISOString(),
    label: LABEL,
    script: SCRIPT,
    args: SCRIPT_ARGS,
    summaryPath: SUMMARY || null,
    passRule: { exitZero: true, maxErrors: MAX_ERRORS, maxFriction: MAX_FRICTION },
    pass,
    total: runs.length,
    rate: +gate.rate.toFixed(4),
    threshold: THRESHOLD,
    gatePass: gate.gatePass,
    runs,
    failureClusters: clusters,
  };

  mkdirSync(ABS(OUT_DIR), { recursive: true });
  const out = ABS(`${OUT_DIR}/gate-${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n════════ 失败聚类 ════════');
  if (clusters.length === 0) console.log('  (no failures)');
  for (const c of clusters) console.log(`  ×${c.count} ${c.signature}`);
  console.log(`\nRESULT: ${pass}/${runs.length} (${(gate.rate * 100).toFixed(1)}%) gate=${gate.gatePass ? 'PASS' : 'FAIL'} (threshold=${THRESHOLD})`);
  console.log(`report: ${out}`);

  if (!NO_TREND) {
    mkdirSync(dirname(ABS(TREND)), { recursive: true });
    const line = appendTrendLine(
      text => appendFileSync(ABS(TREND), text),
      { label: LABEL, script: SCRIPT, pass, total: runs.length, rate: +gate.rate.toFixed(4), threshold: THRESHOLD, gatePass: gate.gatePass },
    );
    console.log(`trend: ${ABS(TREND)} ← ${JSON.stringify(line)}`);
  }
  process.exit(gate.gatePass ? 0 : 1);
}

main().catch(error => {
  console.error(`acceptance-gate failed: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
