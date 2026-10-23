# 评估门禁（plan-r84 Wave F3）

> 2026-09-03。把 training-loop-v5 的手工 eval 与「两轮全绿」的人工验收变成
> 常驻 runner。三个组件：六块回归门禁（F3-1）、轨迹级评估（F3-2）、统计验收
> 门禁（F3-3）。CI 分层（PR 快道/夜间道/周级道）是 F4 的事，本文件只约定
> runner 的用法与门禁语义。

## F3-1 六块决策回归门禁 — `scripts/eval/decision-regression.mjs`

heldout 语料逐条打到 OpenAI 兼容端点，字段级断言 + rubric 简评。

```bash
node scripts/eval/decision-regression.mjs [--limit N] [--model ac-decision-v5] \
  [--base http://127.0.0.1:8000/v1] [--threshold 1.0] [--no-trend] [--out report.json]
```

- **输入**：`data/devloop/tmp/d1/lora-adapter-v5/labeled-corpus.ndjson` 的
  heldout 行（76 条）+ `data/devloop/tmp/d1/system-prompt-v5.txt`。
  `--limit N` 均匀抽样（与 deploy smoke 的步进选样一致），缺省全量。
- **端点**：`--base` 或 `LLM_BASE_URL`（与 server 同变量），默认
  `http://127.0.0.1:8000/v1`。429/5xx/超时/网络错误指数退避重试（6 次）。
- **门禁口径**（pass）：`jsonOk && 六块齐 && validateDecisionV1 过 &&
  action 在词表`。F0-2 验收锚点是「strict 六块率恒为 1.00」，故
  `--threshold` 默认 1.0。rubric 指标（`action_match` / `legacy_match` /
  `summary_grounded`）只报告不进门禁。
- **退出码**：通过率低于阈值 exit 1；夹具缺失/参数错误 exit 2。
- **deploy 集成**：`scripts/deploy-lora-v5.mjs` 的 step-4 smoke 已改为调用本
  runner（`--limit = --smoke`），就地实现退役。

## F3-2 轨迹级评估 — eval-report 扩展

`GET /api/simulations/:id/eval-report` 新增 `trajectory` 小节（registry 与
disk 两条路径同口径，数据全部来自 trajectory 已有字段，**无新埋点**）：

- `llmFailures`：T-105 写通过的 LLM 失败账本计数；
- `structuredOutput`：`decisionSource=llm` 决策中 `llm-json` / `llm-fsm`
  占比（T-024-part3 口径）——约束解码的合规率在这里可追踪；
- `chain`：链路完整率。`actionable` = 落到执行路径的决策
  （`handle_independently` / `initiate_ac`）；`withFeedback` = 其中
  `goalAchieved` 已结算（Fix-12 效果回检/仿真结算）的条数；
  `completeness = withFeedback/actionable`，分母为 0 时 null。

更细的「决策链路合理性评分」需要 OpenTelemetry gen-ai 语义约定级埋点
（plan-r84 F3-2 全量），本期止步于此设计，未埋点。

### F3-2a 口径解读（DOC-04：三个常被误读的计数）

报告自带 `methodology` 数组（R100，`apps/server/src/eval-report.ts` 的
`EVAL_METHODOLOGY`，随响应透出）是每条指标包含/排除规则的唯一事实源；
以下三条是 persona 实撞过的误读点：

- **`handshakes.failures.byCause.superseded` 不是失败**。同一事件已被
  别的握手 accept 接住之后，超出的发起被机制性去重（R100：它们同时
  计入 `cancelledByCoordinator` 减项，不进 `negotiationSuccessRate`
  分母）——这是发起协调器正常工作的证据，读报告时应从「失败」心智
  里剔除。（`byCause` 合计恒等于 `failed = initiated − succeeded` 的
  算术口径不变，superseded 只是其中的一个机制性归因桶。）
- **responders `bySource.fallback` 占比 = LLM 应答预算指标**，不是应答
  质量问题。`decisionSource='fallback'` 表示评估墙钟预算耗尽 / provider
  故障 / 输出不可解析后走了能力兜底（R5-F10：兜底记录带 `errorMessage`
  说明是哪类 knockout）；fallback 是韧性道按设计生效。占比高说明 LLM
  环境吞吐不足（本机 Ollama 类约束，见 pm-dev-backlog WONT-02），该去
  查 `trajectory.llmFailures` 与部署环境，而不是改应答逻辑。
- **`effectChecks` 是两条车道的并集**：reputation 温度类效果回检 ∪
  device-execution 真实设备调用回执（后者切片单列在
  `deviceExecutions`）。T71 起全部是整数事件桶：`partial` 单列、不计入
  successes（`passRate = successes/attempts`；加拢恒等式
  `ok + partial + failed = attempts`）；计数是事件、分数是权重
  （success=1 / partial=0.5 / failure=0），两者不可混读。

## F3-3 统计验收门禁 — `scripts/eval/acceptance-gate.mjs`

参数化重复执行旅程脚本 N 次，通过率阈值判定 + 失败签名聚类。

```bash
node scripts/eval/acceptance-gate.mjs --script data/campus-e2e/ui/persona-r82.mjs \
  --summary data/devloop/r82-verify/summary.json --label r82 \
  [--runs 3] [--threshold 0.95] [--args "0 4"] [--max-errors 0] [--max-friction 0]
```

- **单 run pass 判定**：exit 0 且（给了 `--summary` 时）summary.json 的
  `errors` 数 ≤ `--max-errors`、`friction` 数 ≤ `--max-friction`。超时
  （`--timeout-ms`，默认 30 分钟）杀掉视为失败。
- **门禁语义**：`pass/total ≥ --threshold`（默认 0.95）exit 0，否则 exit 1；
  total=0 恒失败。N=20 留给夜间道。
- **失败聚类**：friction 签名 = `persona:where`；error 签名做归一化
  （UUID/时间戳/长数字抹平）——同根因跨 run 归簇计数，簇按 count 降序。
- **结果**：报告 JSON 落 `data/devloop/acceptance-gate/gate-<label>-<ts>.json`。

## T44 aiReview 忠实性门禁 — `scripts/eval/review-faithfulness.mjs`（R4 Batch 4）

- **动机**（u3 F3）：agent update（modify-object）撤能力提案的 aiReview.reason
  曾描述成「给另一分区烟感加能力」——对象/方向/分区全错。Batch 4 的装配修复
  （target-before/patch-diff 块 + SYSTEM_PROMPT 忠实性段）拦装配缺陷；本 runner
  拦模型漂移——单测断言不了自然语言。
- **做法**：打真实 server（EAF_API，缺省 127.0.0.1:8100），一次性 fixture
  （注册 owner、导入含 a 区值守 agent + b 区干扰烟感的场景环境），逐案提交
  modify-object 提案（撤能力 / 加能力 / 改分区），轮询 aiReview 落地后对
  reason 做**确定性**断言：`reviewed`（source='ai' 且 reason 非空）、
  `targetNamed`（提及目标名/id）、`directionConsistent`（方向词与 patch 一致，
  词表上界近似）、`noForeignZone`（不提及提案对象之外的分区块）。
- **门禁语义**：**observe-only 先行**——缺省 `--threshold 0`，通过率照记趋势、
  恒 exit 0；连续两轮失败率 ≥ **20%**（`rate < 0.8`）后以
  `--threshold 0.8` 升硬门（写入夜评排程时同时复核词表）。server 无 LLM
  （`decision.mode ≠ 'llm'`）时 skip（exit 2），不计失败。
- **趋势**：`data/devloop/eval-trends/review-faithfulness.ndjson`
  （`{ts, model, pass, total, rate, threshold, gatePass}`；observe 轮
  `gatePass: null`）。

## 趋势文件格式（ndjson，每次运行追加一行）

`data/devloop/eval-trends/decision-regression.ndjson`：

```json
{"ts":"2026-09-03T20:00:00.000Z","model":"ac-decision-v5","pass":5,"total":5,"rate":1,"threshold":1,"gatePass":true}
```

`data/devloop/eval-trends/acceptance-gate.ndjson`：

```json
{"ts":"2026-09-03T20:00:00.000Z","label":"r82","script":"data/campus-e2e/ui/persona-r82.mjs","pass":3,"total":3,"rate":1,"threshold":0.95,"gatePass":true}
```

公共字段 `ts/pass/total/rate/threshold/gatePass` 稳定，趋势图按这两个文件
画即可。`--no-trend` 关闭追加（试跑时用）。

## 测试与纯函数边界

两个 runner 的确定性逻辑（样本评估、汇总、门禁判定、签名归一化、聚类、
趋势追加）全部在 `scripts/eval/gate-lib.mjs`，由
`apps/server/src/eval-gates.vitest.test.ts` 覆盖；F3-2 聚合由
`apps/server/src/eval-report-trajectory.vitest.test.ts` 覆盖。
