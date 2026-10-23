#!/usr/bin/env node
// scripts/eval/llm-record.mjs — plan-r84 F4-2：LLM 录制回放（VCR）的「录」端。
//
// 把选定请求集对真后端（vLLM）的响应录进 LLMCache 的 SQLite 持久库
// （LLM_CACHE_PATH 同款表结构）。回放端是 packages/llm-integration 的
// LLM_REPLAY 模式（client.ts）：开启后 chat() 只查缓存，miss 抛
// LLMReplayMissError（带请求指纹）。PR 快道因此可以确定性跑 LLM 相关测试，
// 不依赖 GPU。
//
// 请求集：
//   decision-heldout   F3-1 回归门禁同款语义请求：heldout 语料指令 ×
//                      system-prompt-v5，temperature 0，--limit 与 runner 用
//                      同一个 pickSpread（N 条 = runner 实际会发的前 N 条）。
//   nl-metamorphic     F2-2 夜间道语料。NL 意图 prompt 内含运行时世界状态
//                      （设备在线位、zone 实时参数），静态重建必漂移——所以
//                      本 set 用「在线捕获」：spawn 一个临时 server（隔离 DB/
//                      目录，LLM_CACHE_PATH 指向目标库），把
//                      scripts/nl-metamorphic-llm.mjs 跑一遍，它经过的每个
//                      LLM 请求自然落进缓存。需要 apps/server 已 build。
//
// 用法：
//   node scripts/eval/llm-record.mjs --set decision-heldout [--limit 20] [--force]
//   node scripts/eval/llm-record.mjs --set nl-metamorphic        # 走真后端捕获
//   node scripts/eval/llm-record.mjs --set decision-heldout --verify  # 只校验不打后端
//
// 通用参数：--cache data/devloop/llm-vcr/golden.db（默认）
//           --base <vLLM /v1>（默认 LLM_BASE_URL ?? http://127.0.0.1:8000/v1）
//           --model <名>（默认 LLM_MODEL ?? ac-decision-v5）——必须与回放侧
//           chat() 实际使用的模型一致（server 侧 = LLM_MODEL，归一化后的值）。
//
// 退出码：录制有失败 / verify 有 miss → 1；参数或环境错误 → 2；全好 → 0。
// verify 不碰后端，可在 PR 快道当「golden trace 完整性」检查用。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickSpread } from './gate-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ABS = p => resolve(ROOT, p);

const require = createRequire(import.meta.url);
// 键函数与缓存类从 llm-integration dist 取（单一事实源）；dist 必须先 build。
const { buildCacheKey, LLMCache } = require(ABS('packages/llm-integration/dist/cache.js'));

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const SET = opt('set', 'decision-heldout');
const LIMIT = Number(opt('limit', '20'));
const CACHE_PATH = opt('cache', 'data/devloop/llm-vcr/golden.db');
const BASE = (opt('base', process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8000/v1')).replace(/\/+$/, '');
const MODEL = opt('model', process.env.LLM_MODEL ?? 'ac-decision-v5');
const FORCE = args.includes('--force');
const VERIFY = args.includes('--verify');
const TIMEOUT_MS = Number(opt('timeout', '120000'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 请求集定义 ---------------------------------------------------------------
// 每项 = LLMCacheKeyInput 同款字段 + 可选 note（打印用）。provider 固定
// 'openai-compatible'（server 唯一后端；replay 侧 client.provider.name）。

function decisionHeldoutRequests() {
  const CORPUS = opt('corpus', 'data/devloop/tmp/d1/lora-adapter-v5/labeled-corpus.ndjson');
  const SYS_PROMPT = opt('system-prompt', 'data/devloop/tmp/d1/system-prompt-v5.txt');
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
  return pickSpread(heldout, LIMIT).map((s, i) => ({
    provider: 'openai-compatible',
    model: MODEL,
    systemPrompt,
    userPrompt: s.instruction,
    temperature: 0,
    maxTokens: 700, // 与 decision-regression ask() 一致（不进键，仅录制请求体）
    note: `heldout[${i}] target=${s.action}`,
  }));
}

// --- 后端调用（429/5xx/网络错误指数退避）--------------------------------------

async function ask(req) {
  const delays = [0, 2000, 5000, 10000, 20000, 40000];
  let lastError = 'unreachable';
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.log(`    … backoff ${delays[attempt]}ms (attempt ${attempt + 1})`);
      await sleep(delays[attempt]);
    }
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: req.userPrompt },
          ],
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 700,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
      }
      const j = await res.json();
      return {
        text: j?.choices?.[0]?.message?.content ?? '',
        usage: j?.usage
          ? {
              promptTokens: j.usage.prompt_tokens ?? 0,
              completionTokens: j.usage.completion_tokens ?? 0,
              totalTokens: j.usage.total_tokens ?? 0,
            }
          : undefined,
        model: j?.model ?? req.model,
      };
    } catch (e) {
      lastError = String(e?.message ?? e);
    }
  }
  return { error: lastError };
}

// --- nl-metamorphic 在线捕获 --------------------------------------------------

/** 等 server /api/health 起来（最多 30s）。 */
async function waitForHealth(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

async function captureNlMetamorphic(cachePath) {
  const serverDist = ABS('apps/server/dist/index.js');
  const runner = ABS('scripts/nl-metamorphic-llm.mjs');
  if (!existsSync(serverDist)) {
    console.error('error: apps/server/dist/index.js missing — run npm run build first');
    process.exit(2);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'eaf-llm-record-'));
  const port = 18300 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SCENARIO_USER_DIR: join(workDir, 'scenarios'),
    EAF_DB_PATH: join(workDir, 'eaf.db'),
    EAF_TRAJECTORY_DIR: join(workDir, 'trajectories'),
    LLM_BASE_URL: BASE,
    LLM_MODEL: MODEL,
    LLM_CACHE_PATH: cachePath,
  };
  console.log(`capture: spawning server on :${port} (backend ${BASE}, model ${MODEL})`);
  const server = spawn(process.execPath, [serverDist], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  server.stderr.on('data', d => process.stderr.write(`  [server] ${d}`));
  // 必须排空子进程 stdout，否则管道缓冲写满后 server 事件循环阻塞。
  server.stdout.on('data', () => {});
  try {
    if (!(await waitForHealth(port))) throw new Error('server did not come up within 30s');
    console.log('capture: server up — running nl-metamorphic-llm against it');
    const code = await new Promise(res => {
      const child = spawn(process.execPath, [runner], {
        env: { ...process.env, EAF_API: `http://127.0.0.1:${port}` },
        stdio: 'inherit',
        cwd: ROOT,
      });
      child.on('close', res);
      child.on('error', () => res(2));
    });
    // 录制语义：runner 的门禁结论不决定本脚本成败（蜕变矩阵红 ≠ 没录到），
    // 但如实上报。
    if (code !== 0) console.warn(`capture: runner exited ${code} — cache entries up to the failure point are still recorded`);
    return { runnerExit: code };
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    rmSync(workDir, { recursive: true, force: true });
  }
}

// --- 主流程 -------------------------------------------------------------------

async function main() {
  mkdirSync(dirname(ABS(CACHE_PATH)), { recursive: true });
  const cache = new LLMCache({ persistPath: ABS(CACHE_PATH), maxSize: 100000 });
  console.log(`llm-record: set=${SET} cache=${ABS(CACHE_PATH)} model=${MODEL}${VERIFY ? ' (verify only)' : ` base=${BASE}`}`);

  if (SET === 'nl-metamorphic') {
    if (VERIFY) {
      // NL prompt 内含运行时状态，键无法离线重算——只能报库规模。
      console.log('verify: nl-metamorphic keys are runtime-bound; offline verify not possible (use decision-heldout --verify).');
      process.exit(0);
    }
    const { runnerExit } = await captureNlMetamorphic(ABS(CACHE_PATH));
    console.log(`RESULT: nl-metamorphic capture done (runner exit ${runnerExit}); cache=${ABS(CACHE_PATH)}`);
    process.exit(0);
  }

  if (SET !== 'decision-heldout') {
    console.error(`error: unknown --set '${SET}' (decision-heldout | nl-metamorphic)`);
    process.exit(2);
  }

  const requests = decisionHeldoutRequests();
  console.log(`request set: ${requests.length} heldout prompts`);
  let recorded = 0;
  let skipped = 0;
  const missing = [];
  for (const [i, req] of requests.entries()) {
    const key = buildCacheKey(req);
    const label = `[${i + 1}/${requests.length}] ${req.note ?? ''} key=${key.slice(0, 12)}…`;
    const hit = cache.get(key);
    if (hit && !FORCE) {
      skipped++;
      console.log(`  ${label} SKIP (already recorded)`);
      continue;
    }
    if (VERIFY) {
      missing.push({ key, note: req.note, preview: req.userPrompt.replace(/\s+/g, ' ').slice(0, 100) });
      console.log(`  ${label} MISS`);
      continue;
    }
    const out = await ask(req);
    if (out.error !== undefined) {
      missing.push({ key, note: req.note, error: out.error });
      console.log(`  ${label} FAIL — ${out.error}`);
      continue;
    }
    cache.set(key, { response: out.text, usage: out.usage, model: out.model, storedAt: Date.now() });
    recorded++;
    console.log(`  ${label} REC ${out.text.length} chars`);
  }

  console.log(`\nRESULT: recorded=${recorded} skipped=${skipped} ${VERIFY ? 'missing' : 'failed'}=${missing.length} cache=${ABS(CACHE_PATH)}`);
  if (missing.length > 0) {
    for (const m of missing.slice(0, 10)) {
      console.log(`  fingerprint key=${m.key} ${m.note ?? ''} ${m.error ?? `prompt="${m.preview}…"`}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch(error => {
  console.error(`llm-record failed: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
