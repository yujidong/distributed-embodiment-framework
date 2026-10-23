# Runtime 架构分析与重组方案（R15-E2 系统性架构轮）

> 基于平台方反馈：机械重组可能导致 workflow 绕软与抽象层级打破。
> 本文档先系统性分析现状问题，再给出目标架构与实施路径。

## 1. 现状分析

### 1.1 事实测绘

**模块依赖图（core 包内）**：

```
runtime ──→ agent ──→ management ──→ decision ──→ agent     (环!)
   │            │          │            │
   │            ↓          ↓            ↓
   ├──→ decision    autonomous      environment
   ├──→ environment      ↑              ↑
   ├──→ flows            └── events ←───┘
   ├──→ reputation
   ├──→ trajectory
   └──→ scenario
```

**EngineRuntime（1896 行）的十项职责**：

| 职责 | 方法群 | 行数 | 本质 |
|------|--------|------|------|
| 生命周期编排 | constructor/start/pause/resume/step/stop | ~310 | **编排** |
| 事件注入 | injectEvent | ~104 | **编排** |
| 物理世界写入 | setZoneOccupancy/updateZoneBaseline/registerZoneGeometry/seedZoneBaselines/advanceTick | ~180 | **编排** |
| 设备控制与故障 | executeDeviceCommand/setDeviceFault/wrapDeviceWithFaults | ~180 | **编排** |
| Agent 构建 | buildAgent/resolveAgentDevices/resolveAgentZoneIds | ~130 | **工厂** |
| 决策记录 | recordDecision | ~45 | **桥接** |
| 声誉接线 | initReputation/finalizeCollaborationSessions | ~110 | **桥接** |
| 效果检查 | registerTemperatureEffectCheck/processDueEffectChecks | ~90 | **策略** |
| 快照查询 | getSnapshot/getCollaborations/readZoneEnvSnapshot | ~100 | **查询** |
| Flow 接线 | onFlowRun/getFlowEngine | ~20 | **桥接** |

**engine-shared（1669 行）**：类型契约 + 六域纯函数混居，无分区标注。

**server 消费面**：19 个方法（生命周期 6 + 查询 7 + 注入 3 + 故障 3）。

### 1.2 问题识别（按严重度）

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P1 | EngineRuntime 是上帝对象（10 职责） | 逐步累加无拆分 | 任何修改都在最大文件里，认知负担高 |
| P2 | engine-shared 正在抽屉化 | 「一切模块级」的切割标准太宽 | 类型契约与业务逻辑混居，无内聚边界 |
| P3 | domain 层有环（agent↔decision↔management） | 历史演进 | 编译可过但逻辑分层已破 |
| P4 | server 直接触及 runtime 深层内部 | 无显式端口 | 消费面不可控，重构阻力大 |
| P5 | 纯函数与类型无分层规则 | 缺架构约束文档 | 贡献者不知道什么该放哪 |

### 1.3 现有架构的优势（不应破坏）

- 事件总线（EnvironmentCenter EventManager）解耦了组件间通信——这是正确的
- 结构化类型（structural views）避免了对 simulation 包的硬依赖——这是正确的
- 决策/声誉/Flow 是独立模块，经组合而非继承进入 runtime——这是正确的

## 2. 目标架构

### 2.1 分层模型

```
┌─────────────────────────────────────────────────────┐
│  L4  消费层（apps/server、CLI、Web）                 │
│      只 import { EngineRuntime } from core           │
├─────────────────────────────────────────────────────┤
│  L3  编排层 runtime/                                 │
│      EngineRuntime —— 唯一编排入口（生命周期/注入/   │
│      tick/故障）+ 桥接（声誉/轨迹/Flow/决策回调）    │
│      不含纯逻辑，不含类型定义                         │
├─────────────────────────────────────────────────────┤
│  L2  塑形层 runtime/shaping/                         │
│      纯函数按领域分子模块：snapshot/events/agents/    │
│      collaboration/world —— 确定性，无引擎状态，无 I/O│
├─────────────────────────────────────────────────────┤
│  L1  契约层 runtime/contract.ts                      │
│      纯类型 + 常量 —— 唯一被所有层引用的零逻辑文件    │
├─────────────────────────────────────────────────────┤
│  L0  领域层（现有模块不动）                           │
│      decision/ reputation/ flows/ environment/ ...   │
└─────────────────────────────────────────────────────┘
```

### 2.2 分层规则（强制）

| 规则 | 内容 | 违反后果 |
|------|------|---------|
| R1 | L1 只被 L2/L3/L4 引用，自身零 import（除 shared/llm 包类型） | 破坏无环保证 |
| R2 | L2 只 import L1 + L0（领域模块类型）；不引 L3，不持有状态 | 编排逻辑混入 |
| R3 | L3 只 import L1 + L2 + L0；状态变更与副作用只在此层 | 纯函数被污染 |
| R4 | 上下文对象（SnapshotInput 等）冻结字段集——扩字段 = 抽取失败 | 接口膨胀 |
| R5 | 新声明必须归入对应 L2 子模块；不允许新建 catch-all 文件 | 抽屉化 |

### 2.3 L2 子模块划分（按领域内聚）

| 子模块 | 承载 | 来源 |
|--------|------|------|
| `shaping/snapshot.ts` | 快照组装（zone/device/agent/service/llm/collab） | engine-shared 快照段 |
| `shaping/events.ts` | 事件注入整形 + 订阅载荷解析 | engine-shared 事件段 |
| `shaping/world.ts` | zone 几何/基线/占用/温度/故障归一 | engine-shared 纯量段 |
| `shaping/collaboration.ts` | 决策记录/握手轨迹/协作视图 | engine-shared 协作段 |
| `shaping/agents.ts` | dual-trigger 配置组装 | engine-shared Agent 段 |

### 2.4 不做的事

- **不拆 EngineRuntime 为多个类**——十项职责中八项是编排/桥接，拆出来会制造
  N 个互相引用的小类（workflow 绕软）。正确做法：编排集中、逻辑外置。
- **不解 domain 层的环**（agent↔decision↔management）——那是独立的架构债，
  影响面远超 runtime，本轮只标记不动。
- **不做 server 端口收窄**——消费面 19 个方法已经稳定，收窄是 breaking change，
  属于下一轮 API 治理范畴。

## 3. 实施路径

### 步骤 A：拆分 L1 契约层
`engine-shared.ts` → `contract.ts`（类型+常量+结构视图+设备工厂）
工具：TypeScript Compiler API（AST 精确声明提取，禁用行启发式）。

### 步骤 B：拆分 L2 塑形层
剩余纯函数按 §2.3 分入五个子模块，`shaping/index.ts` 统一导出。

### 步骤 C：L3 对齐
EngineRuntime 的 import 改为从 `./contract.js` 和 `./shaping/index.js`；
删除 `engine-shared.ts`。

### 步骤 D：验证门禁
tsc 零错 → core 1245 测试全绿 → npm run build → npm test 11/11 →
`grep -r "engine-shared" 确认无残留引用`。

## 4. 实施结果（2026-08-20 完成）

| 文件 | 行数 | 角色 |
|------|------|------|
| `runtime/contract.ts` | 532 | **L1 契约层**：22 个声明（类型+结构视图+设备工厂） |
| `runtime/shaping/world.ts` | 261 | **L2 物理世界**：常量+zone 几何/基线/故障/效果检查 |
| `runtime/shaping/snapshot.ts` | 320 | **L2 快照组装**：EngineSnapshot+zone-env+services+llm+collab |
| `runtime/shaping/events.ts` | 127 | **L2 事件整形**：注入解析+载荷构建+订阅解析器 |
| `runtime/shaping/collaboration.ts` | 237 | **L2 协作记录**：决策+握手轨迹+跨 Agent 视图 |
| `runtime/shaping/agents.ts` | 81 | **L2 Agent 配置**：dual-trigger 组装 |
| `runtime/shaping/index.ts` | 9 | **L2 barrel** |
| `runtime/EngineRuntime.ts` | 1900 | **L3 编排层**：生命周期+注入+tick+故障+桥接 |
| ~~runtime/engine-shared.ts~~ | ~~1669~~ | 已删除，拆入上述 |

工具：TypeScript Compiler API（AST 精确声明提取）。
验证：tsc 零错 → core 1245 测试全绿 → npm test 11/11 → 分层审计通过
（L1 零反向依赖、L2 零 runtime 引用、无 engine-shared 残留）。

## 5. 构造器分解（同日，阶段性全测）

Constructor 从 189 行内联代码分解为 4 个装配方法 + 1 个编排骨架：

| 方法 | 职责 | 对应原步骤 |
|------|------|-----------|
| `assembleWorld()` | TimeManager/物理环境/zone 几何/基线/占用 | 1–1d |
| `assembleDevices()` | 设备工厂/故障包裹/zone 定位 | 3 |
| `assembleFlows()` | FlowEngine 接线（zone 限定 invoker/env 读/publish/onRun） | 5c |
| `assembleLlmLogging()` | LLM 轨迹回调（含 triage） | 6 |

Constructor 本体只剩字段赋值 + 按依赖序调用装配方法 + 构建日志（~70 行）。
每个阶段（A/B/C）均 tsc + core 1245 测试 + npm test 11/11 全绿后才进下一阶段。
