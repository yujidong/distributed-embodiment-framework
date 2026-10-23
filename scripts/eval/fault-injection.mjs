#!/usr/bin/env node
// scripts/eval/fault-injection.mjs — plan-r84 F4-4：系统化故障注入矩阵。
//
// 矩阵（每行：自带可控假后端 + 隔离临时 server，临时 DB/目录，不碰 :8100 与
// data/；spawn 子进程必须始终排空 stdout —— server 的 INFO 日志足以填满 64KB
// 管道缓冲，没人读时子进程阻塞在 write 上、整个事件循环停摆，本 harness 调试
// 期实测 3/4 挂起都是这个原因。FI_VERBOSE=1 才打印）：
//
// 行 1「LLM 断开 → 降级 → 恢复」（R84 初版）：
//   1. 杀掉假 vLLM（ECONNREFUSED = 熔断器认的 transient 签名）；
//   2. 降级断言：/api/health decision.mode 翻 'llm-unreachable'（Web 横幅由
//      该载荷驱动）；NL 命令仍 200 落 rules-llm-down；熔断器 fast-fail 不吃
//      provider 超时；
//   3. 恢复断言：posture 翻回 'llm'；冷却（LLM_BREAKER_COOLDOWN_MS）后
//      half-open 探测成功闭闸，parseSource 回 'llm'。
//
// 行 2「429 风暴 → 限流退避」（F4-4 扩展 a）：
//   假后端对 chat 回 429 + Retry-After（/v1/models 始终 200 —— 限流 ≠ 后端
//   死亡）。平台没有 Retry-After 兑现逻辑；它的退避是 请求队列 + 熔断器
//   背压，本行逐条断言真实语义：
//   a. 孤立 429（429→200 交错）不开熔断：consecutive 计数被成功重置，
//      LLM 道持续可用（不误开）；每条命令都拿到 200 回答（请求不丢）；
//   b. 连续 429 风暴 → 熔断开路 fast-fail（停止锤打限流后端 = 背压生效），
//      命令仍 200 走规则降级，posture 不翻 llm-unreachable（不误判死亡）；
//   c. 风暴结束 + 冷却后 half-open 探测闭闸，parseSource 回 'llm'（恢复）；
//   d. LLM_MAX_CONCURRENT=2 下 6 路并发风暴：llmQueue 指标反映积压
//      （depthHighWater/waitCount 增长），全部命令 200。
//
// 行 3「WS 断连 → 重订阅补齐」（F4-4 扩展 b，server 侧）：
//   世界流 /api/environments/:id/stream：
//   a. 新订阅者立刻收到 presence 快照帧（私有下发）；
//   b. 连接期内的变更（建 zone）实时推到订阅者；
//   c. 断连期变更 → 重订阅拿到新 presence 快照 + REST 重读（web 端
//      useWorldStream 的 reloadWorld 补齐缝）反映断连期变更；
//   d. 重订阅后的变更继续实时到达（断连不毒化频道）。
//
// 行 4「慢 LLM（高延迟）→ 超时分类与降级」（F4-4 扩展 c）：
//   假后端 chat 注入 5s 延迟（/v1/models 保持快 200），NL_LLM_TIMEOUT_MS=2s、
//   provider 超时 8s（调用方超时先触发）：
//   a. NL 命令在 NL 超时内返回 200 + rules-llm-down，不挂死在 5s 后端上；
//   b. AbortSignal.timeout 的 TimeoutError 分类为 transient（非 AbortError）
//      —— 连续两次后熔断开路，后续命令 fast-fail（计入熔断的正确分类）；
//   c. 全程 posture 保持 'llm'（慢 ≠ 死，liveness 不走 chat 道）；
//   d. 后端提速 + 冷却后 half-open 探测闭闸，parseSource 回 'llm'。
//
// 配套环境旋钮（本脚本全部显式设置）：LLM_LIVENESS_INTERVAL_MS /
// LLM_LIVENESS_FAILURE_THRESHOLD / LLM_BREAKER_COOLDOWN_MS / LLM_TIMEOUT_MS /
// LLM_DECISION_RETRIES / LLM_MAX_CONCURRENT / NL_LLM_TIMEOUT_MS。
//
// 前置：apps/server 已 build（npm run build）。退出码：有断言失败 → 1；
// 环境错误 → 2；全过 → 0。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { MR1_LLM_TEXTS, mrLabScenario } from '../nl-metamorphic-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 结果记录 -----------------------------------------------------------------
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}: ${detail}`);
}

// LLM 响应缓存以 prompt 为键 —— 复用同一命令文本会缓存命中、绕过 provider，
// 污染熔断/队列断言（实测：P2 复用文本拿到 parseSource=llm 的「假恢复」）。
// 每条命令带唯一后缀，保证每次都真实打到假后端。
let textSeq = 0;
const uniqueText = base => `${base}（批次${Date.now().toString(36)}-${++textSeq}）`;

// --- 可控假 vLLM 后端 -----------------------------------------------------------
// chat 行为可编程：setChatBehavior({status, delayMs, retryAfterSec} | fn(call))。
// 对 200 的 chat 请求回一罐「合法 NL intent JSON」（NL_INTENT_SCHEMA 仅需
// action）。kill() 立即拒连（ECONNREFUSED = 熔断器认的 transient 故障签名）。
const CANNED_INTENT = JSON.stringify({
  action: 'set_parameter',
  targetDevices: ['ac-living'],
  targetParameters: { temperature: 26 },
});

function startFakeVllm(model) {
  let alive = true;
  let chatCalls = 0;
  let behavior = { status: 200, delayMs: 0 };
  const server = createServer((req, res) => {
    if (!alive) {
      req.socket.destroy(); // 硬断，模拟进程被杀
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'vllm' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      chatCalls += 1;
      const plan = typeof behavior === 'function' ? behavior(chatCalls) : behavior;
      const respond = () => {
        const headers = { 'content-type': 'application/json' };
        if (plan.retryAfterSec !== undefined) headers['retry-after'] = String(plan.retryAfterSec);
        if (plan.status === 200) {
          res.writeHead(200, headers);
          res.end(JSON.stringify({
            id: 'chatcmpl-fault-injection',
            object: 'chat.completion',
            created: 1704067200,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: CANNED_INTENT }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        res.writeHead(plan.status, headers);
        res.end(JSON.stringify({
          error: { message: `fault-injection ${plan.status}`, type: 'rate_limit_exceeded', code: plan.status },
        }));
      };
      if (plan.delayMs > 0) setTimeout(respond, plan.delayMs);
      else respond();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise(resolvePromise => {
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        port: server.address().port,
        kill: () => { alive = false; },
        revive: () => { alive = true; },
        setChatBehavior: next => { behavior = next; },
        chatCalls: () => chatCalls,
        close: () => new Promise(res2 => server.close(res2)),
      });
    });
  });
}

// --- 隔离测试 server 管道 ---------------------------------------------------------
// 每行一个独立 server（各自的故障旋钮不同）+ 独立临时目录。
async function spawnServer(fake, model, extraEnv = {}) {
  const serverDist = resolve(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(serverDist)) {
    console.error('error: apps/server/dist/index.js missing — run npm run build first');
    process.exit(2);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'eaf-fault-injection-'));
  const port = 19300 + Math.floor(Math.random() * 500);
  const API = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, [serverDist], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SCENARIO_USER_DIR: join(workDir, 'scenarios'),
      EAF_DB_PATH: join(workDir, 'eaf.db'),
      EAF_TRAJECTORY_DIR: join(workDir, 'trajectories'),
      LLM_BASE_URL: `http://127.0.0.1:${fake.port}/v1`,
      LLM_MODEL: model,
      // F4-4 旋钮：秒级故障可见性 + 快速 provider 超时。熔断冷却 3s：长于
      // 降级段（三条命令 <1s）使降级段全程稳定 fast-fail，恢复段显式等过
      // 冷却再放 half-open 探测命令（冷却窗口落在管道中途会造成探测/拒答
      // 竞态 —— 实测偶发挂起，见 docs/ci.md「已知 flake」）。
      LLM_LIVENESS_INTERVAL_MS: '500',
      LLM_LIVENESS_FAILURE_THRESHOLD: '1',
      LLM_BREAKER_COOLDOWN_MS: '3000',
      LLM_TIMEOUT_MS: '2000',
      LLM_DECISION_RETRIES: '0',
      ...extraEnv,
    },
  });
  server.stderr.on('data', d => process.stderr.write(`  [server] ${d}`));
  // 必须始终排空子进程 stdout（见文件头注释）。
  const drain = d => {
    if (process.env.FI_VERBOSE === '1') process.stderr.write(`  [server:out] ${d}`);
  };
  server.stdout.on('data', drain);

  async function api(method, url, body, token) {
    const res = await fetch(`${API}${url}`, {
      method,
      signal: AbortSignal.timeout(90_000),
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** 轮询直到 /api/health 的 decision.mode === want（或超时返回最后一个值）。 */
  async function waitMode(want, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const res = await api('GET', '/api/health');
        last = res.body?.decision ?? null;
        if (last?.mode === want) return { mode: want, posture: last };
      } catch { /* server not up yet */ }
      await sleep(300);
    }
    return { mode: last?.mode ?? 'n/a', posture: last };
  }

  async function stop() {
    server.kill('SIGTERM');
    await sleep(500);
    rmSync(workDir, { recursive: true, force: true });
  }

  return { api, waitMode, port, workDir, stop };
}

/** 注册 + 登录一次性账号，返回 token。 */
async function registerAndLogin(api, tag) {
  await api('POST', '/api/auth/register', { email: `${tag}@dev.test`, password: 'Test#2026', displayName: 'FI' });
  const login = await api('POST', '/api/auth/login', { email: `${tag}@dev.test`, password: 'Test#2026' });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  return login.body.token;
}

/** 起 NL 命令道所需的最小场景 + 仿真，返回 command(text) 助手。 */
async function setupNlLane(api, token, model, tag) {
  const scenario = mrLabScenario(`fi-lab-${tag}`);
  scenario.agents[0].llm = { provider: 'openai-compatible', model };
  const created = await api('POST', '/api/scenarios', scenario, token);
  if (created.status !== 201) throw new Error(`scenario create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const sim = await api('POST', '/api/simulations', { scenarioId: scenario.meta.id }, token);
  if (sim.status !== 201) throw new Error(`sim create failed: ${sim.status} ${JSON.stringify(sim.body)}`);
  const simId = sim.body.id;
  return {
    simId,
    command: text => api('POST', '/api/agents/home-ops/command', { text, simId }, token),
  };
}

// =================================================================================
// 行 1：LLM 断开 → 降级 → 恢复（R84 初版，断言原样保留）
// =================================================================================
async function rowLlmOutage() {
  console.log('\n══ ROW 1: LLM 不可用时的降级与恢复 ══');
  const MODEL = 'fi-model';
  const fake = await startFakeVllm(MODEL);
  const h = await spawnServer(fake, MODEL);
  console.log(`fake vLLM :${fake.port} (model=${MODEL}), server :${h.port}, workdir=${h.workDir}`);

  try {
    // ---- 启动 + 基线（LLM 活） ---------------------------------------------
    const up = await h.waitMode('llm', 30_000);
    check('boot: posture llm (backend alive)', up.mode === 'llm', `mode=${up.mode}`);

    const ts = Date.now().toString(36);
    const token = await registerAndLogin(h.api, `fi-r1-${ts}`);
    const { command } = await setupNlLane(h.api, token, MODEL, ts);

    const baseline = await command(MR1_LLM_TEXTS[0]);
    check(
      'baseline: LLM lane parses (parseSource=llm)',
      baseline.status === 200 && baseline.body?.intent?.parseSource === 'llm',
      `status=${baseline.status} parseSource=${baseline.body?.intent?.parseSource}`,
    );

    // ---- 故障注入：杀掉 LLM 后端 --------------------------------------------
    console.log('\n── FAULT: kill LLM backend ──');
    fake.kill();

    const down = await h.waitMode('llm-unreachable', 15_000);
    check(
      'degraded: posture flips to llm-unreachable',
      down.mode === 'llm-unreachable',
      `mode=${down.mode} detail=${down.posture?.unreachableDetail ?? 'n/a'}`,
    );
    // 横幅的 API 级事实源：Web banner（EnvironmentsHomePage decisionBanner）
    // 由 health.decision 的 mode + model 两个字段驱动（公开健康面不含
    // unreachableDetail —— 该字段只在 admin observability 里）。
    check(
      'degraded: banner payload present (mode llm-unreachable + model)',
      down.posture?.mode === 'llm-unreachable' && down.posture?.model === MODEL,
      `mode=${down.posture?.mode} model=${down.posture?.model}`,
    );

    console.log('  … degraded command #1 (pays provider timeout, breaker counts)');
    const degradedCmd = await command(MR1_LLM_TEXTS[1]);
    const src = degradedCmd.body?.intent?.parseSource;
    check(
      'degraded: NL command still 200 via rule fallback',
      degradedCmd.status === 200 && (src === 'rules-llm-down' || src === 'rules'),
      `status=${degradedCmd.status} parseSource=${src}`,
    );

    // 熔断器 fast-fail：前 threshold(2) 次 transient 失败开路后，后续调用
    // 应立即被拒（LlmCircuitOpenError），命令延迟 << provider 超时（2s）。
    console.log('  … degraded command #2 (second transient failure — opens the breaker)');
    await command(MR1_LLM_TEXTS[2]); // 第二次失败，开闸
    console.log('  … degraded command #3 (must fast-fail on the open breaker)');
    const t0 = Date.now();
    const fastCmd = await command(MR1_LLM_TEXTS[3]);
    const fastMs = Date.now() - t0;
    check(
      'degraded: circuit-open fast-fail (no provider-timeout wait)',
      fastCmd.status === 200 && fastMs < 2000,
      `status=${fastCmd.status} latency=${fastMs}ms parseSource=${fastCmd.body?.intent?.parseSource}`,
    );

    // ---- 恢复：复活后端 ------------------------------------------------------
    console.log('\n── RECOVER: revive LLM backend ──');
    fake.revive();

    const back = await h.waitMode('llm', 15_000);
    check('recovered: posture flips back to llm', back.mode === 'llm', `mode=${back.mode}`);

    // 等过熔断冷却（3s）后下一次 LLM 调用即 half-open 探测；假后端已活，
    // 探测成功闭闸，意图解析回到 LLM 道。
    await sleep(4000);
    const recovered = await command(MR1_LLM_TEXTS[0]);
    check(
      'recovered: half-open probe closes the breaker (parseSource=llm)',
      recovered.status === 200 && recovered.body?.intent?.parseSource === 'llm',
      `status=${recovered.status} parseSource=${recovered.body?.intent?.parseSource}`,
    );
  } finally {
    await h.stop();
    await fake.close();
  }
}

// =================================================================================
// 行 2：429 风暴 → 限流退避（队列背压 + 熔断不误开 + 恢复 + 队列积压指标）
// =================================================================================
async function rowRateLimitStorm() {
  console.log('\n══ ROW 2: 429 风暴 → 限流退避 ══');
  const MODEL = 'fi-model-429';
  const fake = await startFakeVllm(MODEL);
  // LLM_MAX_CONCURRENT=2：小并发上限让 6 路突发必然形成可观测积压。
  const h = await spawnServer(fake, MODEL, { LLM_MAX_CONCURRENT: '2' });
  console.log(`fake vLLM :${fake.port} (model=${MODEL}), server :${h.port}, workdir=${h.workDir}`);

  try {
    const up = await h.waitMode('llm', 30_000);
    check('boot: posture llm (backend alive)', up.mode === 'llm', `mode=${up.mode}`);

    const ts = Date.now().toString(36);
    const token = await registerAndLogin(h.api, `fi-r2-${ts}`);
    const { command } = await setupNlLane(h.api, token, MODEL, ts);

    const baseline = await command(uniqueText(MR1_LLM_TEXTS[0]));
    check(
      'baseline: LLM lane parses (parseSource=llm)',
      baseline.status === 200 && baseline.body?.intent?.parseSource === 'llm',
      `status=${baseline.status} parseSource=${baseline.body?.intent?.parseSource}`,
    );

    // ── P1 孤立 429：熔断不误开、请求不丢 ─────────────────────────────────
    // 下一次 chat 调用 429（consecutive=1），随后 200（成功复位计数）——
    // 熔断阈值是「连续」2 次，交错限流永不开闸。注意 chatCalls 在 handler
    // 求值前已自增，目标号必须在设置行为前捕获。
    console.log('\n── P1: isolated 429 (next call only, Retry-After: 1) ──');
    const blipTarget = fake.chatCalls() + 1;
    fake.setChatBehavior(call => (call === blipTarget
      ? { status: 429, delayMs: 0, retryAfterSec: 1 }
      : { status: 200, delayMs: 0 }));
    const callsBefore = fake.chatCalls();
    const blip = await command(uniqueText(MR1_LLM_TEXTS[1]));
    check(
      'isolated 429: command still 200 via honest degradation (请求不丢)',
      blip.status === 200 && ['rules-llm-down', 'rules'].includes(blip.body?.intent?.parseSource),
      `status=${blip.status} parseSource=${blip.body?.intent?.parseSource}`,
    );
    fake.setChatBehavior({ status: 200, delayMs: 0 });
    const afterBlip = await command(uniqueText(MR1_LLM_TEXTS[2]));
    check(
      'isolated 429: breaker stays closed (熔断不误开, parseSource=llm)',
      afterBlip.status === 200 && afterBlip.body?.intent?.parseSource === 'llm' &&
        fake.chatCalls() > callsBefore,
      `status=${afterBlip.status} parseSource=${afterBlip.body?.intent?.parseSource} chatCalls=${fake.chatCalls()}`,
    );

    // ── P2 连续 429 风暴：背压生效（fast-fail 停止锤打）+ 不误判死亡 ───────
    console.log('\n── P2: sustained 429 storm ──');
    fake.setChatBehavior({ status: 429, delayMs: 0, retryAfterSec: 1 });
    const storm1 = await command(uniqueText(MR1_LLM_TEXTS[3]));
    await command(uniqueText(MR1_LLM_TEXTS[0])); // 连续失败累计 → 开闸
    const t0 = Date.now();
    const storm3 = await command(uniqueText(MR1_LLM_TEXTS[1]));
    const storm3Ms = Date.now() - t0;
    check(
      'storm: every command answered 200 via rule fallback (请求不丢)',
      storm1.status === 200 && storm3.status === 200 &&
        ['rules-llm-down', 'rules'].includes(storm3.body?.intent?.parseSource),
      `status=${storm1.status},${storm3.status} parseSource=${storm3.body?.intent?.parseSource}`,
    );
    check(
      'storm: breaker backpressure fast-fail (退避生效, no hammering)',
      storm3Ms < 2000,
      `latency=${storm3Ms}ms`,
    );
    const posture = await h.waitMode('llm', 5000);
    check(
      'storm: posture stays llm (429 on chat ≠ dead backend — /v1/models healthy)',
      posture.mode === 'llm',
      `mode=${posture.mode}`,
    );

    // ── P3 恢复：风暴结束 + 冷却 → half-open 闭闸 ─────────────────────────
    console.log('\n── P3: storm ends, cooldown → half-open probe ──');
    fake.setChatBehavior({ status: 200, delayMs: 0 });
    await sleep(4000);
    const recovered = await command(uniqueText(MR1_LLM_TEXTS[2]));
    check(
      'recovered: half-open probe closes the breaker (parseSource=llm)',
      recovered.status === 200 && recovered.body?.intent?.parseSource === 'llm',
      `status=${recovered.status} parseSource=${recovered.body?.intent?.parseSource}`,
    );

    // ── P4 并发风暴：队列指标反映积压，全部请求不丢 ───────────────────────
    console.log('\n── P4: 6-way concurrent storm (LLM_MAX_CONCURRENT=2), queue backlog ──');
    const healthBefore = (await h.api('GET', '/api/health')).body?.llmQueue ?? {};
    fake.setChatBehavior({ status: 429, delayMs: 350, retryAfterSec: 1 });
    const burst = await Promise.all([
      command(uniqueText(MR1_LLM_TEXTS[0])), command(uniqueText(MR1_LLM_TEXTS[1])),
      command(uniqueText(MR1_LLM_TEXTS[2])), command(uniqueText(MR1_LLM_TEXTS[3])),
      command(uniqueText(MR1_LLM_TEXTS[0])), command(uniqueText(MR1_LLM_TEXTS[1])),
    ]);
    const healthAfter = (await h.api('GET', '/api/health')).body?.llmQueue ?? {};
    check(
      'concurrent storm: all 6 commands answered 200 (请求不丢)',
      burst.every(res => res.status === 200),
      `statuses=${burst.map(res => res.status).join(',')}`,
    );
    check(
      'concurrent storm: queue backlog visible in llmQueue metrics',
      (healthAfter.depthHighWater ?? 0) > (healthBefore.depthHighWater ?? 0) &&
        (healthAfter.waitCount ?? 0) - (healthBefore.waitCount ?? 0) >= 4 &&
        healthAfter.maxConcurrent === 2,
      `depthHighWater ${healthBefore.depthHighWater}→${healthAfter.depthHighWater}, ` +
        `waitCount ${healthBefore.waitCount}→${healthAfter.waitCount}, maxConcurrent=${healthAfter.maxConcurrent}`,
    );
  } finally {
    await h.stop();
    await fake.close();
  }
}

// =================================================================================
// 行 3：WS 断连 → 重订阅补齐（server 侧世界流）
// =================================================================================

/** 收帧直到 pred 命中（超时返回 null）。默认 20s：8s 在超订的 hosted
 *  runner 上不够——2026-09-29 nightly 的 resubscribe 快照帧真实到达但
 *  晚于 8s（同 job 其余检查全过，仅这一条超时）。 */
function nextFrame(socket, pred, timeoutMs = 20_000) {
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolvePromise(null);
    }, timeoutMs);
    function onMessage(data) {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (pred(frame)) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolvePromise(frame);
      }
    }
    socket.on('message', onMessage);
  });
}

async function rowWsReconnect() {
  console.log('\n══ ROW 3: WS 断连 → 重订阅补齐快照 ══');
  const MODEL = 'fi-model-ws';
  const fake = await startFakeVllm(MODEL);
  const h = await spawnServer(fake, MODEL);
  console.log(`fake vLLM :${fake.port}, server :${h.port}, workdir=${h.workDir}`);

  let socket = null;
  try {
    const up = await h.waitMode('llm', 30_000);
    check('boot: server up', up.mode === 'llm', `mode=${up.mode}`);

    const ts = Date.now().toString(36);
    const token = await registerAndLogin(h.api, `fi-r3-${ts}`);
    const env = await h.api('POST', '/api/environments', { name: `fi-ws-${ts}` }, token);
    if (env.status !== 201) throw new Error(`env create failed: ${env.status} ${JSON.stringify(env.body)}`);
    const envId = env.body.id;

    const streamUrl = `ws://127.0.0.1:${h.port}/api/environments/${envId}/stream`;
    const openSocket = () => new Promise((resolvePromise, reject) => {
      const s = new WebSocket(streamUrl, { headers: { authorization: `Bearer ${token}` } });
      s.once('open', () => resolvePromise(s));
      s.once('error', reject);
    });

    // ── a. 新订阅者立刻收到 presence 快照 ──────────────────────────────────
    // 先建 zone（device 需落在 zone 上）；zone 变更广播的是 environment-
    // updated 帧，device 变更才是 device-created 帧 —— 用 device 做实时断言。
    const z0 = await h.api('POST', `/api/environments/${envId}/zones`, { id: 'z1', name: '一区' }, token);
    if (z0.status !== 201) throw new Error(`zone create failed: ${z0.status} ${JSON.stringify(z0.body)}`);
    const addDevice = name =>
      h.api('POST', `/api/environments/${envId}/devices`,
        { name, type: 'light', capabilities: ['light'], zoneId: 'z1' }, token);

    socket = await openSocket();
    const snap1 = await nextFrame(socket, f => f.kind === 'presence' && f.action === 'snapshot');
    check(
      'subscribe: presence snapshot frame on connect',
      snap1 !== null && Array.isArray(snap1.users),
      snap1 === null ? 'no frame within 20s' : `users=${snap1.users.length}`,
    );

    // ── b. 连接期变更实时推送 ──────────────────────────────────────────────
    const d1Frame = nextFrame(
      socket,
      f => f.kind === 'world' && f.objectType === 'device' && f.action === 'created',
    );
    const d1 = await addDevice('灯一');
    const d1Got = await d1Frame;
    check(
      'live: device-created world frame pushed to subscriber',
      d1.status === 201 && d1Got !== null,
      `post=${d1.status} frame=${d1Got === null ? 'missing' : 'received'}`,
    );

    // ── c. 断连期变更 → 重订阅补齐 ────────────────────────────────────────
    console.log('\n── FAULT: drop the stream, mutate while away ──');
    socket.close();
    await sleep(300);
    socket = null;
    const d2 = await addDevice('灯二');
    if (d2.status !== 201) throw new Error(`device 灯二 create failed: ${d2.status}`);

    socket = await openSocket();
    const snap2 = await nextFrame(socket, f => f.kind === 'presence' && f.action === 'snapshot');
    check(
      'resubscribe: fresh presence snapshot after reconnect',
      snap2 !== null,
      snap2 === null ? 'no frame within 20s' : 'snapshot received',
    );
    // 世界状态补齐缝 = REST 重读（web useWorldStream 断连后 reloadWorld 的
    // 同一通道）：断连期建的「灯二」必须在重读里。
    const devices = await h.api('GET', `/api/environments/${envId}/devices`, undefined, token);
    const deviceNames = (devices.body?.devices ?? []).map(d => d.name);
    check(
      'resubscribe: REST re-read backfills the disconnected-window mutation',
      deviceNames.includes('灯一') && deviceNames.includes('灯二'),
      `devices=${deviceNames.join(',')}`,
    );

    // ── d. 重订阅后频道不毒化：后续变更继续实时到达 ────────────────────────
    const d3Frame = nextFrame(
      socket,
      f => f.kind === 'world' && f.objectType === 'device' && f.action === 'created',
    );
    const d3 = await addDevice('灯三');
    const d3Got = await d3Frame;
    check(
      'resubscribe: post-reconnect mutations stream live again',
      d3.status === 201 && d3Got !== null,
      `post=${d3.status} frame=${d3Got === null ? 'missing' : 'received'}`,
    );
  } finally {
    socket?.close();
    await h.stop();
    await fake.close();
  }
}

// =================================================================================
// 行 4：慢 LLM（高延迟）→ NL 超时内降级 + 超时计入熔断 transient
// =================================================================================
async function rowSlowLlm() {
  console.log('\n══ ROW 4: 慢 LLM → 超时分类与降级 ══');
  const MODEL = 'fi-model-slow';
  const fake = await startFakeVllm(MODEL);
  // NL_LLM_TIMEOUT_MS=2（秒 → 2000ms 调用方中止）；provider 超时 8s ——
  // 调用方 NL 预算先触发，超时签名是 AbortSignal.timeout 的 TimeoutError。
  const h = await spawnServer(fake, MODEL, { NL_LLM_TIMEOUT_MS: '2', LLM_TIMEOUT_MS: '8000' });
  console.log(`fake vLLM :${fake.port} (model=${MODEL}), server :${h.port}, workdir=${h.workDir}`);

  try {
    const up = await h.waitMode('llm', 30_000);
    check('boot: posture llm (backend alive)', up.mode === 'llm', `mode=${up.mode}`);

    const ts = Date.now().toString(36);
    const token = await registerAndLogin(h.api, `fi-r4-${ts}`);
    const { command } = await setupNlLane(h.api, token, MODEL, ts);

    // 后端先快后慢：基线确认 LLM 道可用，再注入 5s 延迟。
    const baseline = await command(uniqueText(MR1_LLM_TEXTS[0]));
    check(
      'baseline: LLM lane parses (parseSource=llm)',
      baseline.status === 200 && baseline.body?.intent?.parseSource === 'llm',
      `status=${baseline.status} parseSource=${baseline.body?.intent?.parseSource}`,
    );

    console.log('\n── FAULT: inject 5s chat latency ──');
    fake.setChatBehavior({ status: 200, delayMs: 5000 });

    // ── a. NL 命令在 NL_LLM_TIMEOUT 内降级，不挂死 ─────────────────────────
    // 一次命令两次 LLM 调用（意图 + 决策），各吃 2s 调用方中止 → ~4s，
    // 远小于「挂死在慢后端」的 2×5s。
    const t1 = Date.now();
    const slow1 = await command(uniqueText(MR1_LLM_TEXTS[1]));
    const slow1Ms = Date.now() - t1;
    const notes = slow1.body?.intent?.notes ?? [];
    check(
      'slow LLM: command 200 within NL timeout budget (降级而非挂死)',
      slow1.status === 200 && ['rules-llm-down', 'rules'].includes(slow1.body?.intent?.parseSource) &&
        slow1Ms >= 2500 && slow1Ms < 10_000,
      `status=${slow1.status} parseSource=${slow1.body?.intent?.parseSource} latency=${slow1Ms}ms`,
    );
    check(
      'slow LLM: honest accounting note carries the LLM failure',
      notes.some(note => String(note).includes('LLM intent parse failed')),
      `notes=${JSON.stringify(notes).slice(0, 160)}`,
    );

    // ── b. 超时分类 transient：连续两次后熔断开路 → fast-fail ──────────────
    // TimeoutError（AbortSignal.timeout）不是 AbortError —— 调用方超时计入
    // 熔断（circuit-breaker 只豁免调用方主动 AbortError）。命令 #1 的两次
    // 调用已贡献两次连续失败；#2 必须 fast-fail。
    const t2 = Date.now();
    const slow2 = await command(uniqueText(MR1_LLM_TEXTS[2]));
    const slow2Ms = Date.now() - t2;
    check(
      'slow LLM: caller timeout counts transient → breaker opens → fast-fail',
      slow2.status === 200 && slow2Ms < 2000,
      `status=${slow2.status} latency=${slow2Ms}ms parseSource=${slow2.body?.intent?.parseSource}`,
    );

    // ── c. 全程 posture 不翻（慢 ≠ 死：liveness 走 /v1/models 快 200）──────
    const posture = await h.waitMode('llm', 5000);
    check(
      'slow LLM: posture stays llm (slow chat ≠ dead backend)',
      posture.mode === 'llm',
      `mode=${posture.mode}`,
    );

    // ── d. 后端提速 + 冷却 → half-open 闭闸恢复 ───────────────────────────
    console.log('\n── RECOVER: backend fast again ──');
    fake.setChatBehavior({ status: 200, delayMs: 0 });
    await sleep(4000);
    const recovered = await command(uniqueText(MR1_LLM_TEXTS[3]));
    check(
      'recovered: half-open probe closes the breaker (parseSource=llm)',
      recovered.status === 200 && recovered.body?.intent?.parseSource === 'llm',
      `status=${recovered.status} parseSource=${recovered.body?.intent?.parseSource}`,
    );
  } finally {
    await h.stop();
    await fake.close();
  }
}

async function main() {
  await rowLlmOutage();
  await rowRateLimitStorm();
  await rowWsReconnect();
  await rowSlowLlm();

  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`fault-injection failed: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
