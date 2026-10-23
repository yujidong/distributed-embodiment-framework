# 世界会话（World Session）生命周期状态机

> R84 / Wave F1-1。从 `apps/server/src/world-session.ts`（R73「永不休眠 + 自动启动」、
> R82「no-session 时 mutation 自愈重试」之后的实现）反推。每个迁移标注代码出处
> （文件:行号，以本文件撰写时为准）。同族的模型测试见
> `apps/server/src/world-session-mbt.vitest.test.ts`（F1-2）。

## 状态集

| 状态 | 含义 | 视图表现 |
|---|---|---|
| `absent` | `sessions` map 中无该 env 的条目（且服务未关闭）。`statusOf()` 返回 `undefined` | env detail 无 `worldSession` 块 |
| `idle` | 会话存在、runtime 存活、无观察者。R73 后是稳态：不再自动降级 | `status: 'idle'`，带 `observers: 0` |
| `active` | 有观察者 pin（`observe()` 计数 > 0） | `status: 'active'`，带 `observers: n` |
| `hibernated` | 显式 freeze（POST stop 的 freeze 语义）或跨进程 boot 收养后的检查点态；runtime 已释放 | `status: 'hibernated'`，带 `checkpointAtSec` / `hibernatedAt` / `simStartEpochMs` |
| `closed` | 服务关停（`close()`），`sessions` 清空，`closed=true` | `statusOf()` 返回 `undefined` |

## 迁移图

```text
                 onWorldMutation(create=*) / targetFor / observe
                 （环境可仿真：scenarioOfEnv 不抛）
        ┌────────────────────────────────────────────────────┐
        │                                                    ▼
   absent ──出生 wake──▶ idle ──observe()──▶ active
    ▲  ▲                 ▲  ▲                    │
    │  │                 │  └────release() 观察者归零────────┘
    │  │                 │
    │  │        freeze（外部 POST stop → registry.hibernate
    │  │          + adoptExternalHibernate）
    │  │                 │
    │  │        ┌────────▼─────────┐   boot 收养（adoptHibernated,
    │  │        │   hibernated     │◀── server.ts 启动扫描 / 懒重绑定
    │  │        └────────┬─────────┘
    │  │                 │ 到达（targetFor/observe/onWorldMutation）
    │  │                 │ → wakeHibernated：checkpoint + 当前 env 行
    │  │                 │   重建 + 快进
    │  │                 ▼
    │  │               idle（observer 随后立刻翻 active）
    │  │
    │  └── close() ──▶ closed（终态；一切操作不再创建会话）
    │
    └── husk/检查点丢失自愈：状态标记与 registry 实况不一致时，
        丢弃残骸按当前 env 行重建（见「自愈迁移」）

故障动作：scenarioOfEnv 抛 ENVIRONMENT_INVALID（0-zone 环境）
  · absent 上任何创建路径失败 → 保持 absent（warn-only，不抛给调用方）
  · hibernated 上 wake 失败 → 保持 hibernated（下一次到达重试）
  · idle/active 上 mutation 的重建失败 → 保持原状（诚实降级，下次 mutation 重试）
```

## 迁移明细（触发事件 / 监护条件 / 副作用 / 出处）

### 创建族（absent → idle）

1. **出生 wake**：`onWorldMutation(envId, { create: true })`，无会话且未 closed
   → `createSessionDiscardingHusk` → `createSession`。
   出处：`world-session.ts:353-371`（入口）、`world-session.ts:616-657`（创建体）。
   副作用：registry 构建 runtime（`sim-<envId>-world-session` 确定性 id）、
   启动 lazy runtime（`startSessionRuntime`, `world-session.ts:608-614`）、
   **publish 广播帧**（`world-session.ts:654`）。
2. **R82 自愈重试**：`onWorldMutation(..., { create: false })` 在无会话时同样重试创建
   ——`create` 标志不再区分（`world-session.ts:357-372`）。监护条件：`!this.closed`。
   这是 R82-F1「永久死亡」反模式的消除点，详见下文。
3. **到达即创建**：`targetFor`（`world-session.ts:277-286`）/ `observe`
   （`world-session.ts:293-317`）经 `ensureCaughtUp`：无会话先试磁盘懒重绑定
   （`tryRebindFromDisk`, `world-session.ts:479-496`），否则创建
   （`world-session.ts:522`）。
4. **freshness 义务触发**：`noteFreshnessObligation`（`world-session.ts:405-409`）。

### 观察族（idle ⇄ active）

- `observe()`：pin +1，非 active → **active** 并 publish（`world-session.ts:293-302`）。
- release（`observe` 返回的释放函数）：pin −1，归零且 active → **idle** 并 publish
  （`world-session.ts:303-316`）。幂等（`released` 标志）且对过期 state 无效。
- `observeOrMaterialize`（env world stream 的 pin，原 `observeIfPresent`，F7 崩溃
  恢复）：会话存在时同上 pin；**不存在时惰性重建**——硬重启（无磁盘 checkpoint）
  丢失的内存会话由观察流按 env 当前行重新 materialize（经 `observe()` →
  `ensureCaughtUp`：磁盘 checkpoint 优先于 t=0 全新世界）。创建/唤醒失败
  （0-zone 不可仿真、服务 closed）warn-only 返回空 release，治理流照常服务。
  设计限制：无 trajectory 目录的 `/stop` 走 discard+drop（`stopWorldSessionIfAny`），
  **不留持久 stopped 标记**——硬重启后与崩溃丢失不可区分，会被惰性重建复活；
  有 trajectory 目录的 `/stop` 是 freeze 语义（checkpoint 落盘），重启后经
  boot 扫描/懒重绑回到 hibernated，按既有 wake-on-arrival 语义在到达时唤醒。

### 休眠族（idle/active → hibernated → idle）

- **显式 freeze**（R73 后唯一进入 hibernated 的路径）：外部 `POST /stop` 走
  freeze 语义——`registry.hibernate` 写 checkpoint 释放 runtime
  （`simulation-registry.ts:830`），路由回告
  `adoptExternalHibernate`（`routes/simulations-world-session.ts:82` →
  `world-session.ts:454-470`）：状态翻 hibernated、观察者清零、**publish**。
  设计上的自动降级扫描已被 R73 钉死为空桩
  （`scheduleHibernateSweep`, `world-session.ts:761-764`；义务谓词逻辑
  `hibernateIfEligible` 保留在 `world-session.ts:771-814` 但不再有调用方调度）。
- **boot 收养**（跨进程 absent → hibernated）：server 启动扫描 trajectory 目录，
  `registry.adoptHibernatedCheckpoint` + `adoptHibernated`
  （`server.ts:1437-1441` → `world-session.ts:424-443`），**publish** 带
  checkpoint 元数据；或到达时懒重绑定（`tryRebindFromDisk`,
  `world-session.ts:517-521`）。
- **wake**（hibernated → idle）：任何到达路径经 `ensureCaughtUp` →
  `wakeHibernated`（`world-session.ts:690-713`）：读 checkpoint → 用**当前**
  env 行重建拓扑（schema 漂移产出教学警告 `scenarioDriftNotes`,
  `world-session.ts:169-195`）→ `resumeEnvSession` → 状态翻 idle 并 **publish**
  （`world-session.ts:708-711`）→ 随后 `catchUp` 快进到墙钟映射的 now
  （`world-session.ts:721-748`）。墙锚 `simStartEpochMs` 跨过休眠边界不变
  （checkpoint 携带，restore 时收养，`world-session.ts:82-84, 247-249`）。

### T129（R21-F1）：追平的调用方等待语义（后台化，状态机零变化）

R20/R21 故障的落座点：世界落后墙钟数小时时，`catchUp` 的快进量不可控
（数万 sim 秒），而它在 per-env 操作 FIFO 内被调用方同步等待——消费道
（invoke/read/stream 定向）全部排在队头后面直到公网网关裸 504。T129 语义
修正（**不新增/不修改任何状态迁移**，上图与 MBT 锚点全部不变）：

- 追平从操作 FIFO 移到独立的 **per-env 后台链**（`scheduleCatchUp` /
  `awaitCatchUp`），分块间 yield 事件循环，逐块重校验记录（并发
  rebuild/stop 时安静退出）；追赶**永远完整跑完**——世界不撒谎、不跳变、
  不截断。
- 调用方同步等待至多 `catchUpSyncWaitMs`（默认 10s，`WorldSessionDeps`
  可注入）；超过即拿到已就绪的记录先行，追赶在后台继续。健康世界
  （缺口 < 上限）语义与 T129 前逐位一致：`targetFor` 返回已追平的世界。
- 兜底：消费道三条 lane 各有诚实等待下限（默认 90s）——定向无法进展时
  503（invoke `CONSUMPTION_TARGET_PENDING`（定向段，决策段仍为 T128 的
  `INVOKE_DECISION_PENDING`）/ read `READ_TARGETING_PENDING` / stream
  升级 `CONSUMPTION_TARGET_PENDING`）+ retryAfterSec，工作在后台完成。
- 可观测性：队列等待时长、懒重绑/唤醒耗时、追平目标与分块进度均有带
  时长的 info/warn 日志（`WorldSession` logger）。

### 分层追平（粗精度快进，多天积压唤醒提速）

T129 把追平移出调用方等待，但追平本身的速率没变：多天积压的世界唤醒时
全精度快进只有 ~65 sim-sec/s（实测 647144 sim-sec 缺口快进 2 小时 45 分，
期间时钟观感冻结）。分层追平在不破坏等价臂实质的前提下提速——状态机
零迁移变化（追平不是迁移，是同一醒来语义的提速）：

- **两层边界**：缺口 > `catchUpCoarseMinGapSimSec`（默认 86400=1 天）时，
  追平目标前 `catchUpPreciseTailSimSec`（默认 3600=1 小时）以外的**远旧
  区段**走粗精度快进；**近段**保持 observed 全精度（R30 语义不变——到达
  的观察者读到的最近历史与持续运行逐位一致）。
- **粗推通道**（core `EngineRuntime.advanceTo(T, {coarseStrideSec,
  coarseSubstepSec})`）：due 时刻（schedule 边界 / flow 触发 / 事件注入 /
  effect-check / flow-wait）**逐一如实触发、时刻与逐 tick 运行相同**——
  这是等价臂的实质（懒世界醒来的时刻与持续运行相同），由
  `packages/core/src/runtime/EngineRuntime.coarse-advance.vitest.test.ts`
  钉死（粗 vs 精 vs step() 三方对照：事件 id+触发时刻、flow 运行序列、
  occupancy 逐位相符）。只有两个 due 时刻**之间**的物理推进变粗：步长
  ≤3600 sim-sec、子步 dt≈30s（env 基线与断电转换仍逐子步刷新）。
  condition-flow 重评估在粗推期间骑 §8.3  sanction 的 10× tick 网格
  （与 idle 层同一政策，边沿最多晚一个网格槽被检出）。
- **容差（文档化的 LOD 类，同 §8.4：跨精度比较非逐位一致）**——实测
  （`scripts/catchup-coarse-bench.mjs`，一次性脚本非 CI）：
  - 温度等弛豫量：1 天窗口逐 2h 检查点取最大瞬态偏差，dt=10/30/60 分别
    ≤0.003 / 0.009 / 0.016°C（小夹具，含两次热尖峰事件）；24-zone 夹具
    7.5 天全程温度有界（[22.0, 24.9]°C，无失稳）。
  - 累积量（如 cumulativeEnergyWh）：活跃循环的 HVAC 1 天终点相对偏差
    ~0.3%（dt=10）；离散状态（on/off/mode/target）逐位一致。
  - due 触发结果（事件、flow 运行、occupancy、设备离散状态）**零容差**——
    逐位一致是测试钉住的契约，不是测量值。
- **速率实测**（24-zone 夹具，缺口 647144 sim-sec ≈ 7.5 天）：全精度道
  4775 sim-sec/s（外推 2.3 分钟）→ 粗推 dt=10 24240 sim-sec/s（5.1×）、
  dt=30 64296（13.5×）、dt=60 72901（15.3×）。真实校园（65 sim-sec/s
  基线）的瓶颈构成无法本地复现，预期 5–15× → 数分钟级追平；远旧段速率
  的调节手段是 stride/substep 旋钮（见下）。
- **旋钮**（`EAF_WORLD_SESSION_CATCHUP_*`，正有限数，启动校验）：
  `COARSE_MIN_GAP_SIM_SEC`（默认 86400）、`PRECISE_TAIL_SIM_SEC`（默认
  3600）、`COARSE_STRIDE_SIM_SEC`（默认 3600）、`COARSE_SUBSTEP_SIM_SEC`
  （默认 30；调大是容差权衡——显式 dt 参数化场模型）。
- **可观测**：追平开始 warn 带分层计划（粗段量 / 精尾量），进度日志带
  相位（coarse/precise leg），完成日志带分段统计（各段 sim-sec、墙钟、
  sim-sec/s）；会话视图（env detail `worldSession` 块）additive 透出
  `catchUpProgress {targetSimSec, currentSimSec, phase, startedAt}`——
  仅追平活跃时存在（openapi WorldSessionStatus 已同步）。


### 自愈迁移（消除「永久死亡」与「楔死」两类反模式）

- **F7（硬重启崩溃丢失）**：持续被观察钉住的世界从不写 checkpoint，硬 kill 后
  磁盘无 checkpoint → 内存会话永久丢失。两半修复：①eager——boot 扫描的
  hard-kill 复活原先被 `rebound > 0` 门控吞掉（零 checkpoint 世界时全灭），
  解闸为 `rebound > 0 || bareWorldIds.length > 0`（`server.ts` boot 扫描）；
  ②lazy——env world stream 的 `observeOrMaterialize` 在会话缺席时按当前 env
  行惰性重建（boot 扫描扫不到的情形：trajectory 目录不存在等）。两者都是
  fire-and-forget/warn-only，绝不阻塞启动或治理流。
- **R82-F1（永久 absent）**：R73 让 0-zone 空世界在出生时必败
  （`ENVIRONMENT_INVALID`，设计如此）。R82 之前 `create=false` 且无会话直接
  return —— 出生失败过的 env 永远拿不到会话。现在 hook 只在世界变更类事件上
  触发，每次触发本身就是「拓扑可能已可仿真」的信号，值得一试
  （`world-session.ts:357-372`）；失败留在 warn-only 路径，世界编辑永不因
  「世界还仿真不了」而失败。
- **husk 楔死（WORLD_SESSION_EXISTS）**：确定性 id 下的停止/残留记录曾让一切
  后续创建抛 `WORLD_SESSION_EXISTS`。`createSessionDiscardingHusk` 对该错误码
  丢弃残骸重试一次（`world-session.ts:668-681`）；`ensureCaughtUp` 对「记录消失
  或被带外 stop」的 husk 同样丢弃重建（`world-session.ts:574-583`）。
- **陈旧 hibernated 标记**：checkpoint 记录没了但同 id 下有活记录（有人走过通用
  /resume 路由）时，收养活记录并按当前 env 行重建，而不是重建进楔死
  （`world-session.ts:523-559`）。带外 hibernate 的对偶路径在
  `world-session.ts:561-573`。
- **checkpoint 丢失**：`wakeHibernated` 发现 checkpoint 记录消失时从零重建
  （`world-session.ts:692-696`）。

### 属性变更非迁移（T43，R4）

- 会话 runtime 的 **`speed` 是属性不是状态**：对 running（idle/active 会话共享
  同一 runtime 视角）世界经 `/resume` 带 `speed` 即就地 retarget
  （`EngineRuntime.retargetSpeed`，响应带 `speedRetargeted: true`）——下一 tick
  生效，**不产生任何本图迁移、不触发广播**（「迁移即广播」不变量不涉及）。
  paused 路径照旧（resume 时同迁移重设速度）。倍速窗口采样
  （`effectiveSpeedWindowPerSec`）随 start/pause 重置，冻结间隙不计入推进时间。

### 暂停拒绝（F2 修复）

- 通用 `POST /api/simulations/:id/pause` 对世界会话**拒绝**：409
  `WORLD_SESSION_PAUSE_UNSUPPORTED`（教学信息，带当前 runtime 状态与替代路径）。
  原因：会话是墙钟映射的 living world——观察者 pin 的
  `startSessionRuntime` 会静默解除暂停，且每次到达的 catch-up 都会把世界快进到
  墙钟现在（`advanceTo` 只拒 stopped），200 `{state:'paused'}` 必然撒谎。
  本图零迁移变化：要真正停下世界走 freeze 语义（`/hibernate` 或 `/stop` →
  hibernated），这是唯一诚实的「停」。普通（非会话）sim 的 pause 语义不变。

### 通用仿真路由上的会话到达语义（R2-BUG-04）

世界会话 runtime 是 lazy 的（`scheduling:'lazy'`，无墙钟 tick）——无 due 源时
simTimeSec 恒定是**设计**，但三条通用 sim 路由曾把它呈现成「假运行」
（200 `{state:'running'}` 而时钟冻结）。修复后这三条路由对世界会话都是
**到达路径**（状态机零迁移变化，与观察族同一唤醒/追平语义）：

- **sim 流** `GET /api/simulations/:id/stream`：连接期间经
  `observeOrMaterialize` pin 会话 ACTIVE（唤醒 + 追平），断开释放——控制台
  看会话与时钟推进不再依赖世界页是否开着（`routes/simulations.ts` 流处理器）。
- **`POST /start`**：路由到 `targetFor`（唤醒 + 追平，T129 同步上限），响应带
  真实 `simTimeSec`；携带 `speed` 拒 400（会话速率固定为墙钟速率，原地 retarget
  走 `/resume {speed}`，见上节 T43）；唤醒失败 503 `WORLD_SESSION_WAKE_FAILED`。
  入口：`startWorldSessionIfAny`（`routes/simulations-world-session.ts`）。
- **`POST /events`**：注入前先 `targetFor` 追平（同一同步上限）——事件落在
  追平后的仿真时刻，不再冻结时刻落账；服务不可用时 warn-only 退回直接注入。

注意 T129 语义不变：积压超过同步上限时调用方先返回、后台继续快进——
「到达即追平」的保证是**调度追平 + 有界等待**，不是无限等待。

### 关停（→ closed）

- `close()`（`world-session.ts:829-833`）：置 `closed`、清 timer、清 `sessions`。
  之后 `ensureCaughtUp` 抛 `WORLD_SESSION_CLOSED`（`world-session.ts:515`）、
  `onWorldMutation` 无会话分支直接返回（`world-session.ts:358-360`）：
  **任何操作都不再创建会话**（关停语义）。`targetFor` 把该异常降级为
  `undefined`（warn-only），调用方回退 legacy 解析。
- `dropForEnv`（env 删除级联，`world-session.ts:821-826`）：只丢内存状态，
  registry 记录由 registry 级联。

## 不变量（MBT 断言锚点）

a. **R82 回归钉**：任何 world mutation 之后，若环境可仿真（有 zone）且服务未
   closed，会话不得停留在 absent。
b. **关停语义**：close 之后任何操作都不再创建会话（`statusOf` 恒 undefined）。
c. **id 稳定**：同 env 的会话 id 恒为 `sim-<envId>-world-session`，重建/自愈
   不产生第二个 id。
d. **迁移即广播**：每次可观察的状态迁移都伴随 `onStatusChange` 广播帧，且最后一
   帧的 status 与迁移后状态一致（F0 帧契约的姊妹钉；`publish` 统一收口在
   `world-session.ts:258-264`）。
e. **墙锚连续**：freeze → wake 往返后 `simStartEpochMs` 不变（hibernated 视图持
   checkpoint 的锚，wake 路径 restore 收养同一值）。
