# CI 三层流水线与测试约定（plan-r84 Wave F4）

> 2026-09-03 起。把测试按「不确定性分层消解」组织成三条道：PR 快道要便宜且
> 确定，夜间道驯化 LLM 语义不确定性，周级道压规模与长时稳定性。
> 原则 4（发现与回归分离）：探索式发现允许贵、允许不可复现；固化进这三条道的
> 回归必须便宜、必须可复现。

## 三条道

| 道 | 入口 | 内容 | 预算 |
|---|---|---|---|
| PR 快道 | `npm run test:fast`（本地） | 单元 + 契约（OpenAPI 漂移、流帧、决策 schema、错误信封）+ 属性（F2-1 fast-check）+ 蜕变规则道（F2-2 规则半） | 目标 < 5 分钟；实测见下 |
| PR 全量 | ci.yml：`npm run build` + `npm test` | 全部 vitest（含重型 MBT 与 flaky 隔离区） | ~45 分钟（CI） |
| 夜间道 | nightly.yml（cron / dispatch） | 全量 vitest 复跑 + fault-injection（F4-4） | 小时级 |
| LLM 门禁道 | llm-gates.yml（仅 dispatch，需 [self-hosted, gpu] + vLLM） | decision-regression（F3-1）+ nl-metamorphic-llm（F2-2 LLM 半）+ acceptance-gate（F3-3）——2026-09-29 从 nightly 拆出：无 GPU runner 时 self-hosted job 永久 queued 会把 nightly 并发组堵死 | 小时级 |
| 周级道 | weekly.yml（cron / dispatch） | capacity-bench server 档 + loadtest 阶梯冒烟；放大到 dense/extreme + invariant 常开见 weekly.yml 尾注 | 小时~天级 |

### 快道实测（2026-09-04，plan-r84 Wave D 后；32 核开发机，与他 agent 共享）

`npm run test:fast -- --force --continue`（无缓存全量执行）三次：
**4m20.7s / 4m12.1s / 4m08.4s，均值 4m14s，达标 ≤5 分钟**（第三次同时
是无 LLM 环境证明：`LLM_BASE_URL= LLM_MODEL=` 置空跑，llm-integration
178 / core 2540 / simulation 235 / shared 20 全绿，server 与 web 各有的
1 个红是共享工作区里其他在途改动的文件，与 LLM 无关）。server 快道
128 文件 1168 测试，单道 244–252s；其余 workspace 最快 1s（llm-integration）
到 ~40s（web），server 是唯一关键路径（core 159 文件仅 19s）。

做法（诚实版）：不加 workers、不砍断言——把 2026-09-04 实测墙钟 > 25s 的
27 个 full-app 重启动成本文件移出快道（`HEAVY_FULL_APP_SUITES`，
apps/server/vitest.fast.config.ts），合计 ~1181s 执行时间（约占 52%）。
它们的门禁归属不变：ci.yml PR 全量道 + nightly full-vitest 每晚复跑全量。
契约/属性/蜕变规则道文件（openapi / nl-metamorphic / *.props 等）全部
留在快道；mbt 与 flaky 隔离区排除不变。

历史记录（2026-09-03，改动前）：墙钟 7m06s，10/10 任务绿（server 154
文件 1725 测试）。瓶颈不是并发槽（12 workers 只省 30s 还立刻 flap
hass-simulation/observability/quotas，已回退 6 workers），而是 150+ 个
文件各自启动 full-app 实例的固定成本——分组是唯一不砍覆盖的压法。
30s 阈值（16 文件）在空机实测 4m50s 达标，但共享机器有外部负载时余量
不足（实测冲到 5m29s），放宽到 25s 换 ~60s 抗负载余量。

注意：turbo 会缓存 test:fast 结果——输入没变的重复执行是秒级日志回放
（`Cached: N`）；要诚实计时必须 `--force`。`--continue` 只是为了在别的
套件红的时候也能跑完 server 计时，正常 PR 使用不需要。

### Windows teardown 段错误（2026-09-11）：server 两档配置在 win32 切 forks pool

症状：Windows 开发机上 `npm run test:fast -w @active-collaboration/server`
（默认 threads pool）在**所有测试文件全绿、最后一个文件完成后**的 worker
teardown 阶段以 0xC0000005（access violation）退出，高峰期 7 跑约 6 崩，
崩溃点不随具体测试文件变化（最后完成的总是调度末尾的文件，如
boot-config-s3）。`--pool=forks` 100% 稳定。

排查结论：

- **不是测试侧句柄泄漏**。审计发现并修复了 7 处未关闭的
  better-sqlite3 句柄/full-app 实例（agent-llm-null、
  agent-llm-null-migration、capability-demand、world-lazy、
  quota-window.props、shares、env-objects 第二 describe——这些修复作为
  卫生改进保留），修复后 threads pool 仍 3/3 崩在同一 teardown 点。
- **不是近期源码/依赖改动**：better-sqlite3 12.11.1 / vitest 1.6.1 /
  tinypool 版本近一周未变；疑似套件规模增长（每 worker 承担的
  native env 开关次数）把概率推过阈值。
- 最小探针（6 个 worker_threads 各开关 200 个 :memory: 库后并发
  terminate）无法复现——精确 native 机理未定位（需 crash dump，
  遗留）；但经验事实充分：threads 在全套件规模下高概率崩、forks
  全稳，且 vitest 官方本就不建议 worker_threads 跑 better-sqlite3
  这类 native 模块。

决策：`apps/server/vitest.fast.config.ts` 与 `apps/server/vitest.config.ts`
按平台条件化 `pool: win32 → 'forks'，其他 → 'threads'`。不违背既有决策
——历史记录只约束 maxWorkers=6（并行饥饿），从未强制 threads；Linux CI
未观测到该崩溃，保持 threads 不动。收益附带：forks 下快道实测
**198.8s / 198.5s / 197.5s（135 文件 1227 测试，3/3 exit 0）**，比
threads 时代的 244–252s 还快（进程隔离减少了堆/GC 互扰），5 分钟预算
余量反而变大。

规则（防复发）：任何 `makeTestApp()`/`openDatabase()` 必须配对的
`cleanup()`/`close()`——未关闭的 native 句柄在 worker teardown 是
悬着的雷，上述 7 处就是审计出来的实例。

### PR 快道（`npm run test:fast`）的范围约定

- server 用 `apps/server/vitest.fast.config.ts`：在默认排除之外再排除
  `**/*-mbt.vitest.test.ts`（F1 重型 model-based testing，分钟级）、
  `**/*.flaky.vitest.test.ts`（隔离区，见下）与 `HEAVY_FULL_APP_SUITES`
  （实测 > 25s 的 27 个 full-app 重启动成本文件，plan-r84 Wave D）。
  三组在全量道照常跑，第三组另有 nightly full-vitest 的每晚复跑。
- apps/cli 没有 `test:fast` 脚本，turbo 自动跳过：CLI 套件是端到端集成
  道（单跑 8 分钟+），进不了 5 分钟预算；三通道一致性的守门由 server 的
  OpenAPI 契约测试 + cli 套件在全量道共同承担。
- 夜间 LLM 道不是 vitest 测试（是 scripts/eval/* runner），天然不在快道里。

## LLM 录制回放（VCR，F4-2）

PR 快道要不依赖 GPU 跑 LLM 相关测试，靠 LLMCache 升级出的 VCR 模式：

- **回放端**：`LLM_REPLAY=1`（或 `new LLMClient(..., { replay: true })`）。
  开启后 `chat()` 只查响应缓存；命中即返回（与正常缓存命中无差别），
  miss 抛 `LLMReplayMissError`，错误带请求指纹（cache key + provider +
  model + prompt 预览），照着指纹补录即可。未挂缓存就开 replay 是配置
  错误（同样抛 `LLMReplayMissError`）。单测：
  `packages/llm-integration/src/replay.vitest.test.ts`。
- **录制端**：`scripts/eval/llm-record.mjs`。请求集：
  - `--set decision-heldout [--limit 20]`：F3-1 同款语义请求（heldout 语料
    × system-prompt-v5，temperature 0；`--limit` 与 runner 用同一个
    `pickSpread`，前 N 条就是 runner 实际会发的前 N 条）。直连后端录制，
    不需要起 server。
  - `--set nl-metamorphic`：在线捕获——spawn 隔离的临时 server
    （`LLM_CACHE_PATH` 指向目标库），把 `scripts/nl-metamorphic-llm.mjs`
    跑一遍，经过的 LLM 请求自然落库。NL 意图 prompt 内含运行时世界状态，
    静态重建必漂移，所以只能在线录。
  - `--verify`：只校验不打后端（golden trace 完整性检查，PR 道可用）。
- 缓存库默认 `data/devloop/llm-vcr/golden.db`（gitignored，可随时用真后端
  重新录制，不提交）。`--model` 必须与回放侧 chat() 实际用的模型一致
  （server 侧 = 归一化后的 `LLM_MODEL`）。
- 键的语义与 LLMCache 完全一致：空白归一、format 键序无关、大小写敏感、
  temperature 分桶（显式 0 ≠ 省略）。

## 快道的 LLM 依赖策略（plan-r84 Wave D）

快道必须在没有 LLM 后端的环境全绿。约定：**有缓存用缓存、无缓存用 mock，
快道里没有任何测试真打 LLM 端点**。golden.db 不入库（会过期且大），所以
快道也不依赖 VCR golden 库——VCR 回放（上节）是给「想在本机复跑 LLM 语义」
的开发者用的可选路径，不是快道门禁。

现状盘点（2026-09-04 审计，快道全量无 LLM 实测绿）：

- server 套件：`test-utils.ts` 的 `buildTestServer` 在构建前 scrub 掉
  环境里的 `LLM_BASE_URL`/`LLM_MODEL`（dev shell / 仓库根 .env 都不会泄
  漏进测试实例）。少数显式传 `llmBaseUrl` 的套件指的都是**不可达地址**
  （`127.0.0.1:1`/`:9` 等死端口）——它们测的就是失败/降级路径。
- llm-integration 套件：要么 mock `cross-fetch`（openai-compatible /
  guided-json 等），要么打 `127.0.0.1` 上的临时 HTTP stub（queue /
  abort-signal / vllm-compat），要么用死端口断言失败路径。`localhost:8000`
  只作为「假定的 vLLM 地址」出现在 mock 的 URL 断言里，不会真连。
- 验证方式：`LLM_BASE_URL= LLM_MODEL= npm run test:fast`（置空串而非
  unset——dotenv 不覆盖已存在的 key，空串能压住仓库根 .env 里的值）。
  实测记录见「快道实测」节。

新增 LLM 相关测试的规则：默认走 mock/stub；需要真实语义响应的，录进
golden 库后在**自己的** suite 里用 `LLM_REPLAY=1` + 显式 cache 回放，
且该 suite 必须能在无 golden 库时跳过或失败得可诊断（LLMReplayMissError
的指纹就是诊断信息）——不能引入「本机必须有 vLLM 才过」的快道测试。

## 故障注入（F4-4）

`node scripts/eval/fault-injection.mjs`（前置：`npm run build`）。矩阵四行，
同一模式：自带可控假 vLLM（chat 行为可编程：状态码/延迟/Retry-After）+
隔离的临时 server + API 级断言：

1. **LLM 不可用时的降级与恢复**：断言降级（posture 翻 llm-unreachable、
   banner 载荷在场、NL 命令走规则 fallback、熔断器开路后 fast-fail）与
   恢复（单次探测翻回 llm、half-open 探测闭闸、parseSource 回 llm）。
2. **429 风暴 → 限流退避**：/v1/models 保持 200（限流 ≠ 死亡）。孤立
   429 不开熔断（连续计数被成功复位）、连续风暴 fast-fail 背压 + posture
   不翻、恢复后 half-open 闭闸、并发风暴下 llmQueue 指标反映积压。
3. **WS 断连 → 重订阅补齐**：世界流订阅者连接即得 presence 快照、连接期
   变更实时推送、断连期变更经重订阅快照 + REST 重读补齐、重订阅后频道
   不毒化。
4. **慢 LLM → 超时分类与降级**：chat 注入 5s 延迟，NL 命令在
   NL_LLM_TIMEOUT_MS 预算内降级（不挂死）、调用方 TimeoutError 计入熔断
   transient（开路 fast-fail）、posture 不翻、提速后恢复。

配套环境旋钮（本脚本显式设置，也可手工用）：

- `LLM_LIVENESS_INTERVAL_MS` / `LLM_LIVENESS_FAILURE_THRESHOLD`：R74 活性
  探测节奏与翻转阈值（默认 30s / 2 次）。
- `LLM_BREAKER_COOLDOWN_MS`：熔断器开路→半开冷却（默认 5 分钟，模块加载
  时读取，首个 per-backend 熔断器创建时生效）。
- `LLM_MAX_CONCURRENT`：全局 LLM 请求队列并发上限（行 2 置 2 以观测
  积压）；`NL_LLM_TIMEOUT_MS`：NL 道调用方墙钟预算（秒，行 4 置 2）。

## flaky 隔离区约定

- 确认偶发且未根治的测试：文件名加 `.flaky.` 段
  （如 `world-hibernate.flaky.vitest.test.ts`），并在文件头注释写清偶发
  签名与最近一次观测。快道跳过、全量道照跑；根治后改回原名。
- 已有缓解的已知 flake（不改名，记录在此）：
  - server 全套件并行饥饿：全 app 实例在默认 worker 数下互饿定时器，
    `apps/server/vitest.config.ts` 以 maxWorkers 6 约束（world-hibernate
    的 frozen-vs-continuous 对拍曾因此 flap）。快道试 12 workers 实测
    会 flap hass-simulation / observability / quotas（2026-09-03），
    已回退 6。2026-09-28 nightly 补充：hosted runner 只有 4 vCPU，6
    workers 超售下 beforeEach 的 full-app 启动（迁移回放 + 场景导入）
    会饿过 vitest 默认 10s hook 超时（agreements-phase2 / services 的
    migration 用例报 Hook timed out）——全量道 hookTimeout 加宽到 60s
    （30s 在 16+ 墙钟分钟的套件 teardown 上仍会饿死，09-29 nightly
    agreements R99 / flows Fix-44a / services v4 实证）。2026-09-29
    再补充：threads pool 共享单个 16GB 堆，6 workers 在 16GB runner 上
    会触发 GC 死亡螺旋（一小时零输出后 exit 1、无摘要）——CI 环境
    maxWorkers 降到 3（`process.env.CI` 判定），本地保持 6。
  - web `routes.test.tsx`：turbo 全 workspace 并行下 route-guard 的 RTL
    默认 1s 超时 flap（R45/R46 时只给部分断言加宽过）。2026-09-03 已把
    文件内全部 findBy* 统一加宽到 5s（该文件既有模式），全量 `npm test`
    复跑 11/11 绿 —— 已根治，不移交隔离区。
- 故障注入 harness 自身的教训（2026-09-03）：spawn 子进程必须排空 stdout
  （`stdio: 'pipe'` 而没人读时，64KB 管道缓冲写满后子进程阻塞在 write，
  表现为「请求随机挂死」）。fault-injection.mjs 与 llm-record.mjs 的
  server spawn 均已带 drain。

## 怎么跑

```bash
npm run test:fast            # PR 快道（本地，<5 分钟目标）
LLM_BASE_URL= LLM_MODEL= npm run test:fast   # 同上，显式无 LLM 环境（快道的 LLM 依赖策略）
npm test                     # 全量 vitest（= ci.yml 门禁）
node scripts/eval/fault-injection.mjs            # 故障注入矩阵（无需 GPU）
LLM_BASE_URL=http://<vllm>:8000/v1 LLM_MODEL=ac-decision-v5 \
  node scripts/eval/llm-record.mjs --set decision-heldout --limit 20
node scripts/eval/llm-record.mjs --set decision-heldout --limit 20 --verify
node scripts/eval/decision-regression.mjs        # 夜间道 runner（需 vLLM）
node scripts/nl-metamorphic-llm.mjs              # 夜间道 runner（需运行中的 API + vLLM）
```
