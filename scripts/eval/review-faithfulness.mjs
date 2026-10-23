#!/usr/bin/env node
// scripts/eval/review-faithfulness.mjs — R4 Batch 4 T44：aiReview 忠实性夜间评测门。
//
// 背景（u3 F3）：agent update（modify-object）撤 A 栋能力的提案，aiReview.reason
// 曾写成「给 M 栋烟感加能力」——对象/方向/分区全错。Batch 4 修复 = 装配层补
// target-before/patch-diff（提案块旁显式 diff）+ SYSTEM_PROMPT 忠实性段；本
// runner 是防模型漂移的语义质量门：对真实 server 走完整提案流（fixture 环境
// + 干扰设备 + modify-object 提案），对 aiReview.reason 做确定性忠实性断言：
//   reviewed           aiReview 存在且 source='ai'（reason 非空）；
//   targetNamed        reason 提及目标对象（名或 id）；
//   directionConsistent方向词与 patch 一致（撤→撤词且无加词；加→加词；改分区→提及目标分区）;
//   noForeignZone      reason 不提及提案对象之外的分区块（u3 的 bldg-m-f1 形态）。
//
// 用法：
//   node scripts/eval/review-faithfulness.mjs                    # 打 http://127.0.0.1:8100
//   EAF_API=http://host:port node scripts/eval/review-faithfulness.mjs
//   --threshold 0.8                                              # 升硬门（缺省 0 = 只记录不阻塞）
//
// 门禁语义（eval-gates.md 同款）：缺省 observe-only——通过率照记趋势
// data/devloop/eval-trends/review-faithfulness.ndjson，不 exit 1；连续两轮
// 失败率 ≥ 20%（rate < 0.8）再以 --threshold 0.8 升硬门。server 无 LLM
// （decision.mode ≠ 'llm'）时 skip（exit 2）——规则道没有语义可评。

import { mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.EAF_API ?? 'http://127.0.0.1:8100';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREND = join(ROOT, 'data', 'devloop', 'eval-trends', 'review-faithfulness.ndjson');
const THRESHOLD = (() => {
  const i = process.argv.indexOf('--threshold');
  return i !== -1 ? Number(process.argv[i + 1]) : 0; // 0 = observe-only
})();
const POLL_BUDGET_MS = 120_000;
const POLL_STEP_MS = 3_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 串行 + 退避的 API 调用（429/网络错误重试，最多 6 次）。 */
async function api(method, url, body, token) {
  const delays = [0, 2000, 5000, 10000, 20000, 40000];
  let last = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.log(`    … backoff ${delays[attempt]}ms (${method} ${url})`);
      await sleep(delays[attempt]);
    }
    let res;
    try {
      res = await fetch(`${API}${url}`, {
        method,
        signal: AbortSignal.timeout(120_000),
        headers: {
          'Content-Type': 'application/json',
          ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      last = error;
      continue;
    }
    if (res.status === 429) { last = new Error('429'); continue; }
    let parsed = null;
    try { parsed = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: parsed };
  }
  throw last ?? new Error('unreachable');
}

async function registerAndLogin(email, displayName) {
  const password = 'Test#2026';
  await api('POST', '/api/auth/register', { email, password, displayName });
  const login = await api('POST', '/api/auth/login', { email, password });
  if (login.status !== 200) throw new Error(`login failed for ${email}: ${login.status}`);
  return { email, token: login.body.token, id: login.body.user?.id ?? login.body.id };
}

// --- fixture：a 区值守 agent + b 区干扰烟感（u3 形态的最小回放）-------------

function fixtureScenario(id) {
  return {
    version: '1.0',
    meta: { id, name: 'Review Faithfulness Fixture' },
    zones: [
      { id: 'zone-a', name: 'A栋值守区', adjacentZoneIds: [] },
      { id: 'zone-b', name: 'B栋展厅', adjacentZoneIds: [] },
    ],
    devices: [
      // 干扰项：b 区确有烟感（当时的 fire-drill overlay 同理）——忠实性即
      // 「reason 不把上下文当提案」。LLM 道若忽略忠实性段就会跑题到它。
      {
        id: 'smoke-b', type: 'smoke-detector', zoneId: 'zone-b',
        capabilities: ['detect-smoke', 'raise-alarm'],
      },
    ],
    agents: [
      {
        id: 'wd-guard', name: 'WD-Guard', zoneId: 'zone-a',
        capabilities: ['detect-smoke', 'play-alert', 'set-fan-speed'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: [],
      },
    ],
    events: [],
  };
}

const REMOVAL_WORDS = /(remove|removes|removed|removing|drop|dropping|revoke|revoking|withdraw|撤|移除|删除|去掉|取消)/i;
const ADDITION_WORDS = /(adds?\b|adding|grants?\b|introduce|新增|添加|增加|加装|授予)/i;

/** 逐案断言（确定性；word-list 是上界近似——夜评记录用，不替代人工复核）。 */
const CASES = [
  {
    id: 'remove-capability',
    patch: { capabilities: ['detect-smoke', 'play-alert'] }, // 撤 set-fan-speed
    checks: {
      targetNamed: (reason, target) => reason.includes(target.name) || reason.includes(target.id),
      directionConsistent: reason => REMOVAL_WORDS.test(reason),
      noAddOfRemoved: reason => !ADDITION_WORDS.test(reason),
      noForeignZone: reason => !/zone-b|B栋/i.test(reason),
    },
  },
  {
    id: 'add-capability',
    patch: { capabilities: ['detect-smoke', 'play-alert', 'set-fan-speed', 'patrol-waypoint'] },
    checks: {
      targetNamed: (reason, target) => reason.includes(target.name) || reason.includes(target.id),
      directionConsistent: reason => ADDITION_WORDS.test(reason),
    },
  },
  {
    id: 'move-zone',
    patch: { managedZoneIds: ['zone-b'] },
    checks: {
      targetNamed: (reason, target) => reason.includes(target.name) || reason.includes(target.id),
      directionConsistent: reason => /zone-b|B栋/i.test(reason),
    },
  },
];

async function submitAndAwaitReview(token, envId, targetId, patch) {
  const submitted = await api('POST', `/api/environments/${envId}/proposals`,
    { kind: 'modify-object', payload: { targetId, patch } }, token);
  if (submitted.status !== 201) {
    return { error: `proposal submit failed: ${submitted.status} ${JSON.stringify(submitted.body)}` };
  }
  const proposalId = submitted.body.id;
  const deadline = Date.now() + POLL_BUDGET_MS;
  let proposal = submitted.body;
  while (Date.now() < deadline) {
    if (proposal?.aiReview != null) return { proposal };
    await sleep(POLL_STEP_MS);
    const got = await api('GET', `/api/proposals/${proposalId}`, undefined, token);
    if (got.status !== 200) return { error: `proposal poll failed: ${got.status}` };
    proposal = got.body;
  }
  return { error: `aiReview did not land within ${POLL_BUDGET_MS}ms (proposal ${proposalId})` };
}

// --- 主流程 ------------------------------------------------------------------

async function main() {
  console.log(`T44 aiReview faithfulness — nightly lane against ${API}`);
  const probe = await api('GET', '/api/health');
  if (probe.status === 0) {
    console.error(`API unreachable at ${API}`);
    process.exit(2);
  }
  const mode = probe.body?.decision?.mode;
  const model = probe.body?.decision?.model;
  if (mode !== 'llm') {
    console.error(`SKIP: server decision mode=${mode} — the semantic review lane needs an LLM.`);
    process.exit(2);
  }
  console.log(`server LLM: mode=${mode} model=${model}`);

  const ts = Date.now().toString(36);
  const owner = await registerAndLogin(`t44-review-${ts}@dev.test`, 'T44 Owner');

  const created = await api('POST', '/api/environments', fixtureScenario(`t44-faithful-${ts}`), owner.token);
  if (created.status !== 201) throw new Error(`env create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const envId = created.body.id;
  const agentRow = created.body.agents?.find(a => a.id === 'wd-guard' || a.name === 'WD-Guard');
  if (agentRow === undefined) throw new Error(`fixture agent missing in env detail: ${JSON.stringify(created.body.agents)}`);
  const target = { id: agentRow.id, name: agentRow.name };
  console.log(`fixture: env=${envId} target=${target.name} (${target.id})`);

  const rows = [];
  for (const c of CASES) {
    const outcome = await submitAndAwaitReview(owner.token, envId, target.id, c.patch);
    if (outcome.error !== undefined) {
      rows.push({ caseId: c.id, pass: false, detail: outcome.error, checks: {} });
      console.log(`  ❌ [${c.id}] ${outcome.error}`);
      continue;
    }
    const review = outcome.proposal.aiReview;
    const reason = typeof review?.reason === 'string' ? review.reason : '';
    const checks = {};
    for (const [name, fn] of Object.entries(c.checks)) {
      checks[name] = name === 'targetNamed' ? fn(reason, target) : fn(reason);
    }
    checks.reviewed = review?.source === 'ai' && reason.trim().length > 0;
    const pass = Object.values(checks).every(Boolean);
    rows.push({ caseId: c.id, pass, detail: JSON.stringify(reason.slice(0, 220)), checks });
    console.log(`  ${pass ? '✅' : '❌'} [${c.id}] ${JSON.stringify(checks)} :: ${reason.slice(0, 160)}`);
  }

  const passCount = rows.filter(r => r.pass).length;
  const rate = rows.length > 0 ? passCount / rows.length : 0;
  console.log(`\nfaithfulness: ${passCount}/${rows.length} = ${(rate * 100).toFixed(1)}% (threshold=${THRESHOLD || 'observe-only'})`);

  // 趋势留痕（与 decision-regression 同目录同格式）。
  try {
    mkdirSync(dirname(TREND), { recursive: true });
    appendFileSync(TREND, JSON.stringify({
      ts: new Date().toISOString(), model, pass: passCount, total: rows.length,
      rate, threshold: THRESHOLD, gatePass: THRESHOLD === 0 ? null : rate >= THRESHOLD,
    }) + '\n');
  } catch (error) {
    console.warn(`trend append failed (non-fatal): ${error.message}`);
  }

  if (THRESHOLD > 0 && rate < THRESHOLD) {
    console.error(`GATE FAIL: rate ${(rate * 100).toFixed(1)}% < threshold ${(THRESHOLD * 100).toFixed(1)}%`);
    process.exit(1);
  }
  console.log('observe-only run: trend recorded, gate not enforced (eval-gates.md T44 段).');
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
