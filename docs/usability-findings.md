# 可用性测试发现与修复目标

> 来源：2026-07-30 四轮模拟用户测试。测试者均为"零平台知识"用户，仅依赖 README、docs/、
> CLI --help、API 报错、openapi.yaml 推进任务；全程未读源码（除个别标注处）。
> 场景：① 学生小明 solo：智慧教室原型；② 研究生小李 solo：自建宿舍环境；
> ③ 小明(owner) + 小李(builder) 双用户同环境协作（教学楼，public 环境）；
> ④ R4 三用户共享生态（滨江创新社区）：陈工(物业)/小林(能源优化·纯软件)/小周(老人照护)，
> 聚焦跨 owner 服务发现→订阅→AC 协作→组合应用全链路。
> 原始记录：data/usertest-a/、data/usertest-b/、data/usertest-shared/、data/usertest-r4/。
> 状态：Fix-1（RC-1 统一变更管道）、Fix-2（RC-2 数据保真）、Fix-3（RC-3 决策链路）、
> Fix-4（RC-4 协作地基：成员管理 + viewer 只读 + 脱敏 + 治理广播）、
> Fix-5（RC-5 物理初始化与热平衡标定）、Fix-6（RC-6 构建/文档）、
> Fix-7（RC-7 提案 kind 扩展：install-agents/remove-devices/modify-object 真实化）、
> Fix-8（RC-8 AC 握手闭环：接线 + 应答门控 + 协作查询端点）已完成——
> **全部八个修复批次完成**。遗留项集中见文末「遗留清单」。
> 优先级 P0=阻断核心故事线，P1=严重（bug/数据丢失/安全），P2=体验。
> **固化指针约定（2026-09-03 起，Wave F6-2）**：新条目头部必须带「固化指针」
> 引用块（层/簇/固化物/回滚验证），未固化的条目标 `pending` 且不得标 ✅。
> 流程与模板见 [explore-solidify-loop.md](explore-solidify-loop.md)。存量条目不回填。

---

## P0：阻断"多用户智慧校园"核心故事线

### P0-1 ✅ 成员管理 API 整体缺失
> **已修复（Fix-4，2026-07-30）**：`POST /api/environments/:id/members`
> （owner 按 email 或 userId 邀请，role builder|viewer）、`PATCH …/members/:userId`
> （owner 改角色，owner 角色不可改）、`DELETE …/members/:userId`（owner 移除 /
> 成员自移除）、`GET …/members`（按视角脱敏）。邀请即时生效、无接受步骤——
> 被邀请者的 GET /api/environments 直接出现该环境（含 private）。viewer 端到端
> 只读：设备命令/提案/observations/env 写操作均 403（sim 命令门禁由"成员即可"
> 收敛为 owner|builder）；sandbox fork 保持允许（隔离的只读实验，不回写共享世界）。
> CLI：`eaf env members [add|set-role|remove]`。测试：`members.vitest.test.ts`。

`EnvRole` 有 viewer 但**无任何途径产生 viewer**；私有环境无法邀请成员 = 永久单人环境；
join 只对 public 开放且一律 builder。多用户协作的地基缺了一半。
（小李 solo F-01）
**修复目标**：`POST/DELETE /api/environments/:id/members`（owner 邀请 + 指定角色）、
`PATCH` 改角色；CLI 对应命令；viewer 只读语义端到端生效。

### P0-2 ✅ 设备控制命令不进 command_log
> **已修复（Fix-1，2026-07-30）**：sim 设备命令经统一变更管道
> （`apps/server/src/change-pipeline.ts`）落 command_log——kind=`device-command`，
> payload `{deviceId, commandName, params?, before, after}`（before/after 为设备
> 运行时状态），actorId=发命令的用户，simTime=仿真当前时间；与 replay-service
> 消费格式对齐，回放自动生成 `device-command-replay` 事件（e2e 测试覆盖：
> `apps/server/src/device-commands.vitest.test.ts`）。

仿真内设备命令（开关空调等）完全不留痕：协作"抢空调"事后**无法归因**，
回放也因此生成空事件（eventCount=0）。replay-service 已定义好消费格式
（`kind='device-command'` + `{deviceId, after}`），只差写入侧。
（小明协作 F1、小李协作）
**修复目标**：sim 设备命令经统一管道落 command_log（带 actor、before/after、simTime），
回放自动可消费。

### P0-3 ✅ 直通设备 API 绕过提案治理
> **已修复（Fix-1，2026-07-30）**：builder 调 `POST /devices` /
> `POST /devices:instantiate` 自动转为 `install-devices` 提案（返回提案，
> 规则校验/审批后设备才进入世界）；builder 的 PATCH/DELETE 与 agent 创建
> 一律 403 且报错指向提案 API。owner 保留直改，但全部落 command_log
> （kind=`env-direct-edit`，带 before/after）。

`POST /devices` 等旧环境 CRUD 接口可完全绕过提案-审批管道，builder 直接改共享世界，
治理形同虚设。
（小李协作）
**修复目标**：共享世界的结构变更一律走提案管道；旧直通接口对 builder 关闭
（或转为自动生成提案），仅 owner 保留直改权并落 command_log。

### P0-4 ✅ 场景导入/导出管道丢字段
> **已修复（Fix-2，2026-07-30）**：字段保真改由共享转换模块
> （`apps/server/src/env-map-conversion.ts`：zone 展开透传 + canonical
> `MAP_META_FIELDS` 清单）保证——grid 导入不再丢 events，zone
> `occupancy`/`envelopeU` 与 meta `envelopeU/occupancyHeatW/occupancyCo2Rate`
> 全链路透传；CLI world document 的 zone/map 白名单与 export/apply 补齐
> buildingId/floor/occupancy/storeyHeight 等字段。全链路 round-trip 保真
> 测试：`apps/server/src/environment-roundtrip.vitest.test.ts` +
> `apps/cli/src/test/roundtrip-fidelity.vitest.test.ts`（同一份
> teaching-building fixture 过 import→详情→bridge→仿真快照→export→apply）。
`POST /api/environments` 导入 teaching-building 后：13 个 zone 的 `floor/buildingId/
occupancy` 全丢、`storeyHeight: null`、`events: 0`——楼层模型与课表剧本静默蒸发；
`eaf env export → apply` 同样丢 events 与楼层字段（CLI README 宣称 round-trip 成立）。
B-A 的透传测试覆盖了 import/bridge，但**环境详情 API 视图**与 export 序列化漏了这些字段。
（小明 F-02/F-06、小李 F-04）
**修复目标**：导入/导出/详情三处字段保真，round-trip 测试覆盖 floor/occupancy/events。

## P1：严重问题（bug / 安全 / 信任）

### P1-1 ✅ rule-only 模式下 agent 零决策
> **已修复（Fix-3，2026-07-30）**：断点在链路三处——① `EngineRuntime.buildAgent`
> 在无 LLM 时直接 `enableLayer2:false`，`DualTriggerACManager` 因此从不构造
> `ACNecessityAssessor`，唯一会记录决策的组件不存在；② 即使事件到达，
> `handle_independently` 也只记统计不执行任何设备命令；③ hvac 声明的
> `temperature-control` 能力无 handler，命令必然失败。修复：rule-only 成为
> 一等模式——`ruleOnly` 下 assessor 照常运行但全部走确定性规则
> （`decisionSource:'rule'`：preCheck 覆盖/能力规则 + needs_llm 时的能力缺口
> 兜底），`handle_independently` 经 `commandExecutor` 确定性驱动事件 zone 的
> 空调（温度事件 → `temperature-control {target:24}`，恒温环接管 ±0.5°C 回差）。
> 降级显式化：agent 声明了 llm 但服务端未配置 `OLLAMA_BASE_URL` 时，
> `POST /api/simulations` 201 与 list 均带 `llmWarning` 字段，CLI
> `sim create` 打印 warn。端到端测试：高温事件 → `(rule)` 决策 → hvac
> 被下令 → 温度回落（`packages/core/src/runtime/EngineRuntime.vitest.test.ts`）。
> CLI README 示例已改为真实输出 `handle_independently (rule)`。
无 Ollama 时 agent 对 38°C 高危事件 30 tick 零决策；CLI README 的 `sim watch` 示例
明确展示了 rule 决策。LLM 静默降级（`llm:"ollama"`——历史值，后端已移除 R44-B——也返回 rule-only，201 无警告），
且与 `sim create --llm auto` 的提示行为不一致。没有 LLM 的平台几乎没有"agent"，
而学生本地没有 Ollama 是常态。（小明 F-05/F-07）
**修复目标**：核查规则决策链路为何未触发；降级显式警告；文档如实描述 rule-only 能力边界。

### P1-2 ✅ 课表事件"发生了但看不见"
> **已修复（Fix-2，2026-07-30）**：断点不在引擎——EngineRuntime 快照本已
> 带 `occupancy`，occupancy/weather 事件语义引擎级正确；断点在转换链：
> grid 导入把 events 整体丢掉、zone `occupancy` 在导入与 bridge 两处被
> 手写拷贝漏掉，导致环境创建的仿真没有课表可 fire、初始人数为 undefined。
> 修复（同 P0-4 的共享转换）后：环境仿真 8:00 后快照 zone occupancy=40
> 可观察、CO2 明显上升、14:00 冷空气经 baseline 通道持续生效（e2e 断言
> 见 `apps/server/src/environment-roundtrip.vitest.test.ts`）。
事件确实 fire（scheduledEvents 19→0），但快照 zone 无 `occupancy` 字段；
8:00 上课后 2.6 仿真小时 CO2 仍是 baseline；14:00 冷空气事件过后 outdoor 温度无持续效果。
（小明 F-03）注：B-B 引擎级测试是过的，疑似环境桥接/快照序列化链路丢失——与 P0-4 同根。
**修复目标**：快照暴露 occupancy；环境创建仿真的事件效果可观察；场景自称的验证点写进 e2e。

### P1-3 ✅ occupancy 热失控：教室 70°C，空调恒温器不干预
> **决策侧已修复（Fix-3，2026-07-30）**：诊断确认恒温控制环本身无 bug
> （`packages/simulation/src/devices/controllers.ts` 的 ±0.5°C 回差有专项测试），
> 断裂在"感知高温 → 下令开空调"之间：rule-only 下 agent 根本不产生决策
> （同 P1-1 断点①），且 `temperature-control` 是死命令（断点③），控制环因
> 无已注册 effect 而永远空转。Fix-3 后 rule-only agent 对高温事件确定性下令
> （`temperature-control {target:24}` → 注册冷却 effect → 恒温环接管），
> 端到端测试断言温度回落。
> **物理平衡侧已修复（Fix-5，2026-07-30）**：根因是热质量为全局常数——
> 任何房间（26m³ 厨房或 336m³ 走廊）共用同一个 100m³ 空气热容
> （123.1 kJ/K），40 人教室（3kW 显热）的松弛平衡点高达 baseline+55°C。
> 标定：zone 热质量改为按 zone 体积（bounds 面积 × storeyHeight）导出
> （ρ·V·c，`HeatTransferModel.airThermalMassJPerK`，经
> `registerZonePhysics` 的 `volumeM3` 元数据下发）；hvac 功率可由设备
> `initialState.coolingPowerW/heatingPowerW` 声明（默认仍 3kW）。
> 标定后（48m²×3.5m 教室、40 人、outdoor 邻接）：无空调初速
> ≈0.78°C/min、20 分钟 ≈+12°C（旧：≈1.3°C/min 起、1 小时 54°C 且仍在
> 爬升）；一台 3kW 空调设 24°C 时恒温环稳定在 ~24.3°C（≤28°C 目标）。
> 标定测试：`packages/core/src/runtime/physics-calibration.vitest.test.ts`。
occupancy=40 后 101 教室飙到 70.5°C，`active` 的 hvac 全程无决策。
（小明 F-04）**修复目标**：核查 hvac 恒温控制环为何未响应 occupancy 热源；
评估 occupancy 热模型与松弛的平衡。

### P1-4 ✅ 命令层安全与归因三缺口
> **已修复（Fix-1，2026-07-30）**：① 命令端点加鉴权——匿名 401；环境背书
> 仿真要求成员（任意角色），旧场景仿真仅创建者；openapi 的 `security: []`
> 已移除。② command_log actor 恒为实际操作者：提案 applied 记作者（审批人
> 记入 payload.decidedBy）、直改记 owner、设备命令记调用者。③ 世界变更广播
> 增加 `actor:{id,displayName}` 字段（向后兼容的可选字段），command_log 的
> device-command 记录带 before/after 前值后值。失败命令错误语义统一：设备
> 不存在 404 / 无 agent 管理 409 / 命令不存在 400，执行期失败为单层
> `{success:false,error}`（不再 HTTP 200 + 双层 success）。并发仍
> last-write-wins（设计如此），但每次覆盖现在可归因、可回放。

① sim 设备命令端点 `security: []`，匿名可控制设备；
② command_log 条目 actor 全记成审批人而非实际操作者；
③ 并发相反命令静默 last-write-wins，无冲突提示、无前值、广播不带 actor。
（小明协作 F2/F3/F4、小李协作）
**修复目标**：命令端点鉴权 + 权限语义（跨 owner 控制需校验）；command_log actor=实际操作者；
广播与日志带 actor；并发覆盖至少在响应/广播中可察觉。

### P1-5 ✅ hvac 能力契约不实 + 命令不可发现
> **已修复（Fix-3，2026-07-30）**：断点在 `SimulatedDevice.executeCommand`
> 按"能力名 === 命令名"精确匹配派发到 `CommandHandlerRegistry`，而注册表
> 只有 Power/Temperature/GenericSet 三类——`temperature-control`/`cooling`/
> `heating` 规范化后无任何 handler 认领（core 的 `DeviceResource` 里本有
> `temperature-control → set-temperature` 映射，但从不触达仿真派发层）。
> 修复（声明即可执行）：`TemperatureCommandHandler` 认领 `temperature-control`
> （与 set-temperature 同语义）；新增 `ClimateModeCommandHandler` 认领
> `cooling`/`heating`（设 mode + 上电 → 注册物理 effect）；
> `SimpleActionCommandHandler` 认领 open/close/lock/unlock/activate/stop/
> play-alert（扫描发现的其余模板死命令）；`set-fan-speed` 补上 fanSpeed
> 状态更新（原为静默空操作）。可查询单一事实源：`capability-contract.ts`
> （capabilities ∩ 注册 handler 推导），经 `SimulatedDevice.getExecutableCommands()`
> 暴露到仿真快照 `devices[].commands` 与环境设备详情 `commands` 字段，
> CLI `device list` / `env get --full` 展示；扫描测试断言所有 JSON 设备模板
> 声明的能力均可执行（`capability-contract.vitest.test.ts`）。
`temperature-control` 等 3 个能力是死命令（"no handler"），hvac 实际无法设温；
设备支持哪些命令**无任何清单可查**（唯一一次读源码自救）。
（小明协作 F5、小李协作）
**修复目标**：能力→命令映射可查询（设备详情或单独端点）；死能力要么实现要么从模板摘除。

### P1-6 ✅ 隐私：匿名可读成员邮箱
> **已修复（Fix-4，2026-07-30）**：成员序列化收敛到单点 `memberToJson`
> （env-serializers.ts）——成员见完整视图（userId + email），非成员/匿名
> 仅见 displayName + role（字段不出现而非为 null）。REST 详情与
> GET /members 两条路径同一函数；WS 流的 world/presence 消息本就不带
> 成员邮箱（presence 只有 {id, displayName}），契约已在 openapi.yaml 写明。

public 环境匿名 GET 详情/WS 广播中含 members 列表及**邮箱**。（小李协作）
**修复目标**：成员列表对非成员脱敏（displayName 即可，邮箱仅成员可见）。

### P1-7 ✅ 物理 bug：smoke/co2 初始值无中生有
> **已修复（Fix-5，2026-07-30）**：随机源精确定位在
> `PhysicalEnvironment.initializeDefaultModels`——所有内置默认值模型
> （`SimpleFunctionModel`/`DailyCycleModel`）的 `noiseLevel` 非零，每次
> 读取经 Box-Muller + `Math.random()` 加噪：smoke 模型
> `base:0, noise:0.5, min:0`（负半周被 clamp 到 0，正半周漏出 →
> 无烟雾源时快照出现 0~1.5+ 的幻影 smoke，逐实例不同）；co2 模型
> `base:400, noise:50` → 未定义初始漂移。修复原则"随机性必须显式
> 声明"：默认模型一律确定性（`PhysicalEnvironmentConfig.environmentNoise`
> 默认 false 时经 `registerDefaultModel` 把内置模型噪声置 0；
> scenario meta `environmentNoise: true` 可显式恢复旧行为）；用户经
> 公开 `registerValueModel` 注册的自定义模型噪声保留（属显式声明）。
> 回归测试：`PhysicalEnvironment.determinism.vitest.test.ts`
> （simulation）+ `physics-calibration.vitest.test.ts`（core，t=0 快照
> 两实例一致、step 300 后仍无幻影 smoke）。
无任何烟雾源的世界，t=0 快照 living-room `smoke≈1.49`（每次运行数值不同）；
co2 有未定义初始漂移。（小李 F-09）
**修复目标**：定位初始场值来源（疑似某处默认播种），未定义参数应从 0/baseline 开始。

### P1-8 ✅ README 快速开始给出残缺服务端
> **已修复（Fix-6，2026-07-30）**：① 根 `build` 改为 `turbo run build`
> （按 turbo pipeline 依赖序构建全部 workspace：packages + server + cli +
> web，`npm run build` 的产出即完整可跑；`build:all` 保留为等价别名）；
> ② server 启动自检 `apps/server/src/dist-freshness.ts`——仅当从 dist
> 运行时才生效，比较 dist 入口 mtime 与 src 最新非测试 .ts mtime，过期
> 则在 stderr 打出 STALE build 警告并指向 rebuild 命令（测试：
> `dist-freshness.vitest.test.ts`，实测警告可触发）；③ README 快速开始
> 与实际行为对齐（构建范围 + 警告说明）。
根 `build` 只构建 packages 不含 server，仓库自带 dist 过期 → 新用户照 README 操作
得到的路由集比 openapi.yaml 少一整版，报错 ROUTE_NOT_FOUND 毫无指向性。
两位用户各踩一次。（小明 F-01、小李 F-02）
**修复目标**：根 build 包含 server（或 server 启动时自检 dist 新旧并警告）；README 修正。

## P2：体验与文档

- **legacy `/api/scenarios` 是死胡同**（✅ Fix-6 2026-07-30）：openapi 五个操作全部
  标注 `deprecated: true` 并指向正路 `POST /api/environments`（导入即建环境）/
  `eaf apply`；写操作（POST/PUT/DELETE）起加鉴权（匿名 401——匿名写磁盘本就是
  漏洞），GET 保持匿名（旧前端场景列表页依赖）；routes/scenarios.ts 与 server.ts
  的过渡状态注释同步。测试：`scenarios.vitest.test.ts`（含匿名写 401 用例）。
- **核心任务线无用户文档**（✅ Fix-6）：新增
  [docs/tutorial-smart-campus.md](tutorial-smart-campus.md)「智慧教室 30 分钟
  上手」——注册/登录 → 导入 teaching-building → rule-only 仿真（含 llmWarning
  与 rule-only 能力边界的如实说明、仿真时间模型 speed/tickMs/step）→ 观察课表/
  CO₂/空调决策链 → 成员邀请 → install-devices 提案 → 审批 → command-log 审计 →
  沙箱 fork → 回放。每条 curl 命令均在真实 server 上执行验证过；README 与
  tutorial.md 已加指向链接。
- **仿真时间黑盒**（✅ Fix-6，文档向）：教程 §3 写明时间模型——speed=每 tick
  推进的仿真秒数（默认 1）、tickMs=tick 墙钟间隔（默认 10ms，options.tickMs
  可改）、`step {n}` 推进 n×speed 仿真秒（"推进到 simTimeSec=X"的操作方法）。
- **设备命令错误语义混乱**（✅ 已随 Fix-1 修复）：设备不存在 404 / 无 agent
  管理 409 / 命令不存在 400；失败为单层 `{success:false,error}`。
- **字段命名不一致**（✅ Fix-6，文档对齐不改 API）：以 openapi.yaml 为准——
  CLI README 注明 `--name` 即 API 的 `displayName`、`sim command --cmd` 即 body
  的 `commandName`；新教程全部使用正确字段名。
- **协作通知层缺失**（⚠️ 部分修复，Fix-4 2026-07-30）：提案生命周期已进 WS 广播
  （`{kind:'proposal', action: submitted|escalated|approved|rejected|applied|reverted,
  proposalId, actor}`，world-sync.ts / proposal-service.ts，openapi.yaml 已同步）——
  owner 对 escalated 有待办感知、作者实时看到审批结果；presence 本就随快照下发。
  **未做**：站内通知/邮件通道、离线期间的治理事件补投（见文末遗留清单）。
- **回放不含协作过程**（⚠️ Fix-6 如实标注）：回放产物 = 环境快照 + 时间窗内烘焙的
  命令/观测事件，协作决策过程在轨迹（/trajectory）里——教程 §8 已写明边界；
  把协作过程并入回放是功能增强，列入遗留清单。
- **后来者 onboarding 无载体**（未修，见遗留清单）：世界的"为什么存在"全押在
  owner 手写 description。
- **小项**：
  - ✅ `eaf apply` 引用校验失败不再留垃圾环境（Fix-6）：创建路径在 POST 环境
    **之前**前置校验全部文档内引用（device/agent/event 的 zoneId、agent bind、
    catalog model），失败即整批报错退出；`apps/cli/src/world/apply.ts`
    `prevalidateNewEnvironment`，e2e 回归测试覆盖（小李 F-05）。
  - ✅ import-ifc 空 IR / import-floorplan LLM 失败改为干净用户向错误（Fix-6）：
    空 IR 由 `compileBuildingIR` 抛 BuildingCompileError（"no rooms"，附排查
    指引）替代 ScenarioValidationError 堆栈贴脸；floorplan 的 LLM 失败附
    provider/model 与配置指引（`ollama pull qwen2.5vl:7b` 等——历史指引，ollama 已移除 R44-B），误导性裸 404
    不再出现；caller 给的 --scale/--calibrate 在 LLM 调用**之前**校验（非法值
    fail fast，缺省仍走 LLM 读出比例尺作 hint 的既有设计）；ollama 默认 vision（历史，已移除）
    模型改为视觉模型 `qwen2.5vl:7b`（`DEFAULT_OLLAMA_VISION_MODEL`，有意不沿用
    OLLAMA_MODEL 文本模型）（小李 F-06/F-07）。
  - ✅ 环境 name 200 字符上限（Fix-6）：空世界创建 / PATCH / 场景导入三条路径
    统一校验（`env-access.ts assertEnvNameLength`），openapi `maxLength: 200`
    同步（小李 F-10）。
  - ✅ trajectory 开启方式写进文档（Fix-6）：默认开启，JSONL 落
    `data/trajectories/<simId>/`，`EAF_TRAJECTORY_DIR` 改全局目录、
    `options.trajectoryDir` 改单次；openapi 端点描述 + 教程 §5（小明 F-14）。
  - ✅ apps/cli/README.md Commands 章节补 import-ifc / import-floorplan（Fix-6，
    含 EAF_VISION_* 配置与默认视觉模型说明）。
  - ⚠️ Windows 中文 body Content-Length：环境怪癖（Git Bash curl -d 的已知
    问题），非平台 bug——教程约定已写明用 `--data-binary @file` 规避（小明 F-12）。
  - 未修：重名环境 CLI 歧义（见遗留清单）。
  - ✅ 重启后旧 simulationId 失效写进教程 §9（仿真为运行期对象，不持久化）。

## 做得好的（保持）

- 提案-审批-领地状态机按设计精确工作：规则校验报错带路径、领地内自动通过
  （source=zone-claim）、非领地 escalate、拒绝带 reason、revert 干净。
- 沙箱隔离彻底（跨层物理隔离回归断言也过）；破坏性测试（非法 JSON/越权/弱密码/
  20MB body/并发 PATCH）全部拦截且报错规范。
- `eaf apply` 幂等、错误聚合带路径；twin-sync 与 replay 一旦跑通错误信息教科书级。
- WS 世界广播秒级实时；owner 手写 description 是后来者唯一导读但确实有效。

## 第四轮（R4，2026-07-30）：三用户共享生态协作测试

> 场景：平台方种子公共环境「滨江创新社区」（5 zone 无设备）；陈工（物业，res-101 三台设备+楼宇管家）、
> 小林（能源优化·纯软件主体，energy-room 电表+需求响应服务）、小周（老人照护，res-101 两台传感+照护助手）。
> 链路：注册→join→建资产→跨 owner 发现/订阅服务→组合应用「高温天老人守护」仿真验证。
> 服务器配置 Ollama qwen3-14b-q4（LLM 决策全程在线）。原始记录：data/usertest-r4/。

### R4-P0-1 ✅ builder 无法在共享环境创建 Agent（Fix-7 已修）
Fix-1 把世界变更收敛进提案管道后，提案 kind 只有 install-devices/inject-scenario/modify-object/zone-claim
四种——`POST /agents` 对 builder 403 指向提案 API，但**没有 install-agents kind**（openapi 自述"尚无"）。
后果：共享环境 9 设备、0 Agent、0 服务，服务市场整体空转，教程第三章核心流程整体失效。
**修复（Fix-7）**：新增 `install-agents` kind（payload 对齐直建 API；校验绑定设备属作者、设备私有原则；
领地内自动通过；apply 触发派生服务；revert 级联清理）；builder 直建自动转提案；CLI 有明确提示。
migration v13 扩展 CHECK 约束。复测：三用户提案均约 6-11 秒 AI 审查自动 applied，服务数 0→22。
（陈工 F-03、小林 F-03、小周 F-01）

### R4-P0-2 ✅ AC 协作"发起易、应答无"（Fix-8 已修）
高温事件 → 照护助手 LLM `initiate_ac`（理由正确锁定楼宇管家空调服务）→ collaboration **永久 pending**：
被请求方 trajectory 零记录、activeCollaborations 为空、无收件箱/应答端点、pending 无超时出口；
发起方 ACExecutor 不等应答单方面驱动对方设备（空调 on/cooling 无 setpoint，8 仿真日零制冷）。
诊断四个断点：① `EngineRuntime.buildAgent` 从不调用 `agent.start()`，应答器从未订阅事件总线；
② 发起方发完提案立即单方面执行；③ 接线后暴露自应答死循环（join-response 被当新提案再评估，微任务风暴）；
④ 轨迹无 reasoning 字段、无协作应答记录。
**修复（Fix-8）**：buildAgent 接线 start()；握手门控（≥1 方 accept 才执行、仅接受方参与执行、
全拒/120s 超时取消）；循环防护；HVAC 默认 setpoint 24°C；trajectory 增 reasoning +
`collaboration-response` 记录；新端点 `GET /api/simulations/:id/collaborations`（双方视角）。
复测（真实 LLM）：39°C → initiate_ac → 楼宇管家 accept → 空调 24°C 制冷 → 室温稳定 24.1°C；
场景B 三方链路（能源优化师→楼宇管家+照护助手）首次成形。新增 16 个测试全绿。
（小周 F-12/F-13、陈工 F-12/F-13、小林 F-11/F-12）

### R4-P1 ✅ 已随 Fix-7 修复
- **remove-devices kind 缺失**：builder 误建设备永久滞留（绑定中的设备拒绝删除并提示先解绑；
  revert 按快照恢复原行）。（陈工 F-02）
- **modify-object 假成功**：对不支持的目标照样 applied 但世界无变化。改为按 PATCH 语义逐字段
  校验+真实写入+before/after 审计，不支持的目标/字段规则校验硬拒绝。（陈工 F-04、小周 F-06）

### R4-P1 未修（开放）
- **仿真命令通道无设备归属校验**（小周 F-11、陈工 F-11）：任何 builder 建仿真后可对他人设备执行
  其支持的命令（实测成功 set-temperature）。与 hass:// 真实硬件桥接叠加即为越权风险。需要明确
  语义：仿真=沙箱演练（文档写明）还是要求服务授权。
- **command-log 仅 env owner 可读**（陈工 F-14）：设备主人（builder）查不到自己设备被谁命令——
  与上一条叠加：越权做得到、审计看不见。
- **订阅≠消费，链路断在"用起来"**（陈工 F-10、小林 F-10）：subscribe 只是"我依赖的"声明性书签
  （部署清单输入），无数据流/回调/调用入口，也不影响 AC 发现命中率。运行时消费完全寄托
  "跑 LLM 仿真看 AC"一条路。服务市场目前只兑现"陈列+收藏"。**这是生态故事线的下一个设计缺口。**
- **rule-accept 语义空洞**（小周 F-15）：需求能力为空时 "0/0 matched" 照单全收——老人照护 Agent
  接受电网降载协作语义不通；accept 路径 LLM 未参与（评估 LLM 调用失败后走 capability fallback）。
- **reputation 记分与物理效果脱节**（陈工 F-15）：8 日零制冷被记 cooling success（score 0.75）——
  "命令执行成功"≠"处置成功"。

### R4-P2 体验（未修，择要）
- CLI 全局登录态 `~/.eaf/config.json` 被并行/多账号会话覆盖，写操作零提示串号（设备落到他人名下）。
  EAF_HOME 隔离可绕行，需要 profile 机制或文档显著提示。（陈工 F-01、小周 F-05）
- CLI 转提案零提示且提案响应不含新对象 id（需再 list 一次）；`--json` 管道下尤其困惑。（小周 F-09、陈工 F-07）
- `POST /agents` owner 返回 Agent / builder 返回 Proposal（oneOf），程序化调用需字段嗅探。（小林 F-06）
- subscribe 是 PUT 非 POST，POST 返回 ROUTE_NOT_FOUND 误导为端点不存在。（小林 F-07、小周）
- builder 连自己的设备也不能世界层直改（403），报错文案未说明"自有设备同样走提案"。（小林 F-08）
- `/api/me/overview` 订阅明细 provider 为 null——部署清单正需要"找谁签约"。（小周 F-10）
- 握手应答落在固定约 110-120s 周期（疑似轮询间隔），每次握手等约 2 分钟。（小周 F-16）
- snapshot 内 participant 状态滞后于 collaborations 端点；participants 数组 initiator 重复出现。（小周 F-17/F-18）
- LLM 决策延迟两轮之间从 5.6s 恶化到 117.5s（同模型），需观测。（小周 Fix-8 复测）
- speed=60 实际 wall:sim≈1:4000，文档未提示正确做法是 pause+step。（小周 F-14）
- 服务发现无全文搜索；CLI 无 service 命令组（服务市场对 CLI/AI 用户只能手搓 curl）。（陈工 F-09）

### R4 做得好的（保持）
- 提案+AI 审查秒批体验一致（设备/Agent 同管道同体验）；AI 审查理由语义相关（点名"能力与区域一致"）。
- 派生服务默认 public，"服务公开"双向成立（匿名可见全部 22 条）；unbacked 标记被用户按设计意图
  正确理解（"纯软件主体对世界的承诺"）。
- 设备私有在世界层成立（PATCH/DELETE 他人设备 403）；订阅幂等（alreadySubscribed）。
- trajectory 的 LLM 决策可复盘性（prompt/rawResponse 全量）获好评；Fix-8 后协作双方视角均可查。
- 组合应用主链路端到端跑通：事件→求人→握手→对方设备制冷→室温回落——愿景 ⑤⑥ 首次实证。

## 第五轮（R5，2026-07-31）：回归 + 补盲

> Fix-9/Fix-10 上线后：① R4 三用户回归验证各自发现；② 新 persona 小观（viewer/
> onboarding 补盲）、小莽（部署清单/回放/错误恢复补盲，刻意不看教程）。
> 原始记录：data/usertest-r4/ 各用户 notes.md「R5」章节。

### 回归结论（Fix-9/10 全部验证通过）
- CLI profile 隔离 ✔、createdIds + `proposal:true` ✔（不回溯历史提案）、
  `eaf service` 命令组 ✔、subscribe POST→405 ✔、command-log 成员限定视图
  ✔（陈工借此首次发现小林在 R4 命令过他的空调——审计价值实证）、
  me/overview provider ✔、collaborations 去重+advisory 注明 ✔、
  `sim step --to` 精确落点 ✔。
- **组合应用端到端回归通过**：39°C → initiate_ac（33.5s，较 Fix-8 轮的 117.5s
  回落）→ 握手闭环 → 空调 24°C 制冷 → 室温稳定 ~24.2°C。
- **zone-claim 领地自治实测惊艳**：领地内低风险提案同一毫秒 applied、
  跳过 LLM 审查（source=zone-claim）。
- viewer 只读**零漏网**（15 项写操作全 403，含自我提权）；沙箱内命令 200 vs
  环境仿真 403 的权限差分精确；hass estop 任何登录用户可触发是刻意设计（契约明示）。

### R5 新发现
- **R5-P1-1 提案审查 LLM 15s 超时致自助通道瘫痪**（小周 F-19、小莽 F-04、陈工实测）：
  审查 LLM 连续超时（冷启动 qwen3-14b 超 15s 预算）→ 低风险提案全部 escalate →
  owner 不在线时公共环境实质卡死。对比：决策 LLM 33s 正常。**修法方向**：
  审查超时预算调大/可配 + low-risk && ruleCheck.ok 时超时 fallback 自动通过
  （治理语义需平台方定）。列入 Fix-12。
- **R5-P1-2 回放≠仿真复盘**（小莽 F-06）：observations 只认 manual sync-binding
  推送，纯仿真产出空回放（observationEvents=0）；trajectory 与回放机制割裂。
  与遗留 6 合并：回放要消费仿真快照/trajectory 时序才能成为"复盘工具"。
- **R5-P2 批**（全部列入 Fix-13 并已修复，见下文 Fix-13 章节）：viewer 可注入
  事件（200）但命令 403 的不对称（契约未覆盖，小观 F-05）；viewer 见全体成员邮箱明文
  （观感偏宽，小观 F-04）；`sync-bindings` 契约 404 漂移（小观 F-06）；无改名接口
  （小莽中文昵称 GBK 乱码不可逆，F-02）；auth 限流阈值偏紧（多人并行/连续操作易触发，
  三人提及）；builder 自有设备 PATCH 403 文案仍未说明"自有设备同样走提案"（小林 F-08
  保持开放）；部署清单入口难找（CLI 无命令、overview 无链接，小莽 F-05）；env list 缺
  services 计数（小观 F-03）。
- **待核实 → 已定性（Fix-13）**：小莽 F-08 称 sim 是每环境共享 runtime（create 只是
  别名，stop 会停掉他人仿真）——**查代码证伪**：每次 create 构建独立 EngineRuntime
  （simulation-registry.ts:170），注册表 id 全局唯一、simTimeSec 从 0 开始；
  `runtime-<envId>` 是快照内引擎 id 而非注册表 id。不改代码，openapi 已补充说明，
  小莽笔记已回复。

### R5 做得好的
- 部署清单内容完整可用（型号/价格/采购链接/总价/外部依赖含 owner）——愿景
  "仿真→现实迁移"交付物首次被用户实测为"良"。
- 报错自愈率约 9/10（不存在 id/非法 JSON/非法枚举/越权 decide/重复订阅均一看就懂）。
- 审查 LLM 超时的 escalate fallback + 理由文本方向正确（fail-safe），只是预算太短。

## 第六轮（R6，2026-07-31）：Fix-11/13/14 用户复验

> 小周复验消费链路、小莽复验回放/改名/部署清单、小观复验 viewer 修复；
> 随后小周⇄陈工完成跨用户合约 invoke 闭环。原始记录：各用户 notes.md「R6」章节。

### 复验结论
- **跨用户合约消费闭环成立（愿景核心场景首次端到端实证）**：小周 propose →
  陈工 accept（"有收件箱了"）→ 小周 invoke set-temperature 26 → 陈工空调真实动作
  （经楼宇管家 Agent 下令，设备私有原则成立）→ UsageRecord 双方可审计 + 结算凭据归档。
  「高温天老人守护」从"祈祷 AC 命中"变为确定性消费；AC 退居未签约时的自组织兜底。
- 回放复验（小莽）：空回放 → 1196 条事件（决策+理由/CO₂ 曲线/设备状态），
  "复盘刚跑的仿真"核心诉求满足。改名、部署清单 CLI（"可直接当采购谈判一页纸"）、
  限流放宽全部验证通过。
- viewer 复验（小观）：邮箱脱敏（viewer 只见 displayName+role）、事件注入 403、
  services 计数，四项全过零回归。

### R6 新发现（→ Fix-15 批次）
- 修复状态（Fix-15，2026-07-31）：**F-21 / F-23 / F-24 / F-27 均已修复**。
  F-21 根因=被 kill 的 CLI 是 npx 包装进程、孤儿 node 子进程持有连接永不发
  close 帧（server 日志证实订阅只在 sim stop 时才移除）→ stream 加
  ping/pong 心跳（`AGREEMENT_STREAM_HEARTBEAT_MS`，默认 30s），一次未应答即
  terminate 并落账；F-23 根因=COLLABORATION_COMPLETED/ac-cancelled 只到
  initiator 的 manager，participant 会话无人驱动终态 → EngineRuntime 订阅
  这两个事件并回写所有 Agent 的会话终态；F-24 根因=AC 执行管道 Phase 2.5
  目标达成后 `clearAllDeviceEffects()` 清空全部设备 effect，恒温环只能开关
  已有 effect、无法重建 → 设备层自愈（按"target 是持续设定"语义从最后一次
  命令的 effect 快照重建，turn-off 不复活）；F-27 → 派生服务 interface 从
  承载设备可执行命令（capabilities ∩ 注册 handler）生成
  `{actions:[{name, parameters}]}`，API/CLI `service get` 透出。
- **F-21（中）stream 断开后 UsageRecord 未落账**。
- **F-23（中）AC ephemeral agreement 生命周期与协作状态不同步**：agreement 已
  terminated 而 collaborations 端点仍 active/in-progress，两视角矛盾。
- **F-24（中，待查）长时自由运行后 HVAC 失效**：~4000x 跑 30 仿真日后温度钉死 31.09，
  空调 target=24 无效、step 也不响应——与新鲜事件下正常降温矛盾。
- **F-27（轻，设计缺口）派生服务 interface={}**：不暴露可调用 action/参数清单，
  消费者只能猜命令名——"服务契约"名不副实。
- 轻量：stream 管道输出缓冲（F-20）、静态环境观测流无数据（F-22，场景内容缺口）、
  fallback decisionSource 未文档化（F-25）、invoke 借用任一 running 仿真的归属
  应文档化（F-26）、回放 sim-decision reasoning 英文（小莽 F-R6-01）、
  传感器读数只在 zone 级（F-R6-02）、device-state 不带状态值（F-R6-03）。
- 提供方待办感知：有收件箱（GET /api/agreements?role=provider&status=proposed）
  但 me/overview 无 pendingAgreements 计数/推送（陈工，与遗留 5 通知层合并）。

## 第七轮（R7，2026-07-31）：仿真→现实部署链路端到端

> 小部（builder）用 mock Home Assistant 验证部署链路：传导/安全闸/estop/
> twin-sync 全部工作；陈工复验通知门铃。原始记录：
> data/usertest-r4/user-f-bu/notes.md、user-a-chen/notes.md 的 R7 段。

### 复验结论
- **部署链路是闭环的**：仿真内验证过的设备 → hass:// 绑定 → 仿真命令真实
  传导到硬件（mock HA calls 证据确凿）→ twin-sync 把现实读数映回仿真。
  审计链完整（pending/approved/allowed/estopped 每步有记录）。
- **安全闸设计正确、默认安全**：confirm 默认策略 202+pendingId 软阻塞；
  hass:// 改绑强制 escalate 给 owner；Fix-9 归属例外连环境 owner 都拦；
  estop 全局即停且留审计。

### R7 新发现（→ Fix-18 批次，✅ 已全部修复 2026-07-31）
- ~~**F-01（中）install-devices 提案管道静默丢弃 binding**~~ ✅ POST
  /devices 接受 `binding` 并随提案流转：builder 的 hass:// 创建强制
  escalate 给 owner（与 modify-object 改绑同一道闸），owner 直建立即绑定；
  CLI `device add --binding` + escalated 时提示"需 owner 审批"。
- ~~**F-02（中）HA 实体 capabilities 与命令推导词汇表不一致**~~ ✅
  `GET /api/hass/entities` 增加 `suggestedCapabilities`：语义能力 + 平台
  命令推导可识别的控制动词（turn-on/turn-off/set-brightness 等），照抄
  即可控；openapi 写明。
- ~~**F-03（轻）仿真创建后新建的 Agent 不生效，409 不提示重建**~~ ✅
  DEVICE_NOT_MANAGED 拆分第二种情形：世界里已有管理 Agent 时，报错明确
  "仿真是创建时刻的世界快照，请重建仿真"。
- ~~**F-05（轻）部署清单不区分已绑 hass:// 设备**~~ ✅ deployment 设备条目
  增加 `binding` 与 `deploymentStatus`（bridged/simulation-only），附
  调用者设备的 `syncBindings` 摘要；CLI 对应展示 + notes 记桥接台数。
- ~~**F-16（中）自动批准的提案不给作者发通知**~~ ✅ applied/rejected 终态
  恒通知作者（auto-apply 路径 actor=作者，notify 加 allowSelf 旁路自回声
  抑制；approved 仍不单独发，applied 承载；reverted 保持自回声丢弃）。
- ~~**F-17（轻）CLI 子命令组尾部 --profile 被误作子命令**~~ ✅ 分发前先
  剥离全局旗标再匹配子命令（`eaf notifications --profile chen list`）。
- ~~**F-04（轻）注册字段三处不一致**~~ ✅ CLI `auth register` 增加
  `--display-name`（--name 保留兼容），help/README 写明对应 API 字段。
- 未编号观察（不改代码）：mock HA 无状态修改入口，twin-sync 持续同步无法
  端到端演示——测试基础设施限制。

## 第八轮（R8，2026-07-31）：生态成熟度回归

> Fix-16~21 上线后：小新（新人 onboarding）、小林（通知互验发送方+搜索）、
> 小周（全链回归）、陈工（通知互验接收方+quota 实测）。原始记录：各用户 notes.md。

### 结论：无功能性回退，生态故事线全链路闭合
- **合约消费链路首次完整跑通**：propose → 提供方收到通知 + todos 联动 →
  decide accept → invoke（quota 真实强制：1/1 后第 2 次 QUOTA_EXCEEDED）→
  usage 台账 → terminate。R4"订阅≠消费"的叙事真正闭合。
- 回归全绿：跨用户 invoke、AC 握手（R6 F-23 实际已修复——协作双视角终态
  completed 一致）、AC ephemeral 生命周期一致、回放 1391 事件、通知实时性、
  quotas 余量正常。LLM 决策延迟回归正常（5.8-6.7s）。
- **onboarding 质变**：小新 2 分钟 3 条命令读懂世界（对照小观 R5"前 10 分钟
  的迷茫"），导读 8/10；`env get` 主动提示 guide 存在是关键粘合剂；
  activity 时间线="导读=设定集，时间线=剧情连载"。

### R8 新发现（进遗留清单）
- 中文全文搜索纯子串太脆："温度"搜不到"温湿度计"（小新 F-02、小林 F-15）——
  需 bigram/分词或中英文别名映射。
- 通知 body 缺 consumerName + terms 摘要（"谁在按铃没说清"）；
  `GET /api/agreements/:id` 单查端点不存在。
- activity 摘要用裸 id 不带对象名（小林 F-16、小新）；`env join` 成功输出
  无下一步指引（小新 F-04）；`service list` 默认聚合全平台噪音大（小新 F-03）；
  `--q` 未进 help（小新 F-01）；terms 封闭 schema 业务意图只能塞 notes（小林 F-14）。

### 生态平台价值阶段性评估（愿景"是否有成为繁荣生态的价值"）
- **正向证据**：6 名用户 12 设备 5 Agent 28 服务在同一世界自发生长；
  三种典型生态角色（物业/纯软件/组合应用）全部走通；服务消费从发现→签约→
  调用→计量→审计闭环；治理（提案/领地/审批）不挡路（低风险秒批、领地自治）；
  安全边界（设备私有/viewer 只读/hass 归属例外）经多轮实测零漏网。
- **差距**：新人"导读→签约"的最后一公里（搜索质量、服务 id 直达）；
  通知内容丰富度；UI 通道未真实浏览器验证；真实硬件只有 mock 验证。
- **判断**：核心闭环已成立，具备小规模真实用户试点（alpha）的条件；
  下一阶段重点从"功能闭环"转向"内容生态"（更多真实场景模板与名录）。

## 根因分析（2026-07-30，修复按根因分批而非按症状打补丁）

症状聚类后只有六个根因：

- **RC-1 变更路径分叉**（P0-2、P0-3、P1-4①②④）：平台存在三条互不知情的世界变更路径——
  环境 CRUD 直通接口、sim 设备命令端点、提案-审批管道。鉴权、归因、日志、广播各自
  实现或缺失。设计文档 §4.1"统一变更管道"原则从未真正落地。
  **修法**：收敛为一条管道，鉴权/actor/command_log/广播在管道内一次完成；
  不是给每个端点分别补日志。
- **RC-2 多层手写转换**（P0-4、P1-2、P2 回放内容）：scenario JSON ↔ environment 行 ↔
  map_data ↔ 仿真快照 ↔ CLI export，五层各自手写字段拷贝，每加一个字段（floor/
  occupancy/events）就有多处遗漏。逐字段补 = 打补丁。
  **修法**：字段保真由共享的单向转换函数 + round-trip 保真测试保证
  （同一份 fixture 过全链路断言无字段丢失），新增字段只有单点要改。
- **RC-3 决策→命令链路断裂**（P1-1、P1-3、P1-5）：rule-only 零决策、hvac 恒温环不响应
  occupancy 热源、能力声明与 handler 注册不对齐——三者都是"事件→决策→命令→handler"
  链路在不同配置下断在不同位置，且**能力契约不可查询**让断裂对用户不可见。
  **修法**：先端到端 tracing 定位所有断点（env-backed sim vs scenario sim、
  rule vs LLM），修链路本身；能力→命令映射做成可查询的单一事实源。
- **RC-4 协作身份模型不完整**（P0-1、P1-6、通知类 P2）：成员关系只有 join-public
  一条路径，viewer 是死角色，成员信息序列化不区分内外视角，状态变化无通知通道。
  **修法**：成员管理 API + viewer 端到端 + 按视角脱敏 + 提案生命周期进 WS 广播。
- **RC-5 物理初始化与平衡未标定**（P1-3 热失控部分、P1-7）：初始场值来源不明
  （smoke 无中生有）、occupancy 热源与松弛/恒温控制不平衡。
  **修法**：初始化路径审计（未定义参数恒从 0/baseline 出发）+ 平衡常数标定。
- **RC-6 发布物与文档漂移**（P1-8、命名/教程类 P2）：根 build 不含 server 导致 dist 过期；
  文档/CLI/openapi 三处命名不一致；核心任务线无教程。
  **修法**：build 闭包修正 + 启动自检；教程补任务线；命名对齐 openapi。
- **RC-7 提案管道覆盖不全**（R4-P0-1、R4-P1）：Fix-1 收敛变更路径时只迁移了设备与场景，
  Agent 创建/设备删除没有对应 kind，modify-object 的 apply 是空壳——管道"收口"了但
  kind 清单没跟上，builder 核心动作整体悬空。
  **修法**：补齐 kind（install-agents/remove-devices）+ modify-object 真实化；
  新增变更类型时 kind/校验/apply/revert/契约/CLI 六位一体。
- **RC-8 协作协议实现与运行时装配脱节**（R4-P0-2）：AC 应答器在 core 里实现了，
  但 EngineRuntime 装配 Agent 时不 start()；发起方不等应答就执行；协议事件格式
  不兼容导致应答被当新提案（接线即死循环）。"实现了"≠"接上了"，缺端到端握手测试
  让断裂长期隐形。
  **修法**：装配接线 + 握手门控 + 循环防护 + 双方轨迹 + 查询端点 + 真实事件总线
  e2e 测试（39°C→握手→制冷全链断言）。

## 修复路线（按根因，对应批次）

1. **Fix-1（RC-1）**：统一变更管道——sim 命令鉴权 + actor 归因 + command_log 落账 +
   直通接口收敛进提案管道 + 广播带 actor。覆盖 P0-2、P0-3、P1-4、P1-6 附带的隐私点。
2. **Fix-2（RC-2）**：数据保真——转换层统一 + round-trip 测试 + 快照暴露 occupancy。覆盖 P0-4、P1-2。
3. **Fix-3（RC-3）**：决策链路端到端诊断与修复 + 能力/命令可查询。覆盖 P1-1、P1-3（决策侧）、P1-5。
4. **Fix-4（RC-4）**：成员管理 + viewer + 脱敏 + 治理事件广播。覆盖 P0-1、P1-6、通知类 P2。
5. **Fix-5（RC-5）**：物理初始化审计 + 热平衡标定。覆盖 P1-7、P1-3（物理侧）。
6. **Fix-6（RC-6）**：build 闭包 + 启动自检 + 任务线教程 + 命名对齐。覆盖 P1-8 与 P2 杂项。
7. **Fix-7（RC-7）**：提案 kind 扩展——install-agents/remove-devices/modify-object 真实化 +
   CLI 提示 + migration v13。覆盖 R4-P0-1、R4-P1。
8. **Fix-8（RC-8）**：AC 握手闭环——buildAgent start() 接线 + 应答门控与超时 + 循环防护 +
   默认 setpoint + 双方轨迹 + collaborations 查询端点。覆盖 R4-P0-2。

## 遗留清单（Fix-8 收官后仍未做，按建议优先级排序）

1. **服务消费链路闭环（R4 最大设计缺口）**：subscribe 目前只是依赖书签；缺运行时数据通路/
   服务调用语义/订阅驱动 AC 发现。"服务市场"只兑现陈列+收藏，生态故事线断在"用起来"。
2. **仿真命令通道的设备归属语义**（R4-P1）：任何 builder 可在仿真内命令他人设备；
   需定调"仿真=沙箱"还是"服务授权"，与 hass:// 桥接的越权风险一起评估。
3. **command-log 对设备主人开放**（R4-P1）：builder 查不到自己设备的命令审计。
4. **rule-accept 语义**（R4-P1）：能力需求为空时照单全收；accept 评估 LLM 未参与（fallback）。
5. **协作通知层**：站内通知/邮件通道、离线期间治理事件的补投（Fix-4 只做了
   WS 实时广播，掉线即错过）。
6. ~~回放不含协作决策过程~~ ✅ Fix-14 已关闭：回放烘焙 trajectory 决策、
   zone 参数采样与设备状态变化（见下文 Fix-14 章节）。
7. **CLI 多账号 profile**：全局登录态串号（R4 实测设备落错名下）；EAF_HOME 是绕行不是方案。
8. **CLI/契约细节批**：提案响应含新对象 id + CLI 提示、service 命令组、subscribe POST 兼容或
   405、`/api/me/overview` provider 补全、snapshot participant 状态同步、participants 去重。
9. **后来者 onboarding 载体**：世界导读/结构化说明字段（目前只有 owner 手写 description）。
10. **重名环境 CLI 歧义**：`--env` 按名解析撞名时只有报错没有消歧路径（用 id 可绕过）。
11. **仿真时间 API**：无法直接"推进到 simTimeSec=X"；speed 与实际 wall:sim 比例未写文档。
12. **握手应答延迟**（R4）：应答疑似按固定约 120s 周期处理；LLM 决策延迟两轮间 5.6s→117.5s
    需观测归因。
13. **reputation 与物理效果对齐**（R4）：命令成功≠处置成功，记分应看效果回检。
14. **modify-object 改绑他人设备未拦截**（Fix-7 遗留）：与 install-agents 的设备私有原则不对称。
15. **import-floorplan 确认闭环**：无拖拽编辑界面（最小闭环 --ir/--from-ir/--merge 可用）。
16. **core 的 21 个在库 TDD RED** 与 experiments 目录：按既定约束未触碰。

## 下一步计划（R4 收官后，2026-07-30 定）

原则：先补安全与体验的小批次，再跑一轮回归+补盲测试（R5），最后啃最大的设计缺口
（服务消费链路）——它改变平台语义，应该在干净的测试基线上做。

### Fix-9：安全与审计批（对应遗留 2/3/14）
- 仿真命令通道定调：明确"仿真=隔离沙箱演练"语义并写进契约与教程，或按服务授权校验
  设备归属——与 hass:// 真实硬件桥接的越权风险一起评估，先定语义再实现。
- command-log 对设备主人（builder）开放自己设备的命令审计。
- modify-object 的 boundDeviceIds 收紧到与 install-agents 同等的设备私有原则。

### Fix-10：CLI/契约体验批（对应遗留 7/8/11）
- CLI 多账号 profile（或至少 EAF_HOME 写进 CLI README 显著位置）；提案响应携带新对象 id
  + CLI 转提案明示；`eaf service` 命令组（list/get/subscribe）；subscribe POST 兼容或返回
  405；`/api/me/overview` 订阅明细补 provider；snapshot participant 状态与 collaborations
  端点同步；participants 数组去重；仿真时间 API（推进到 simTimeSec=X）。

### R5：第五轮模拟用户测试（Fix-9/10 之后）
- **回归**：R4 三用户故事线全程重跑（建资产→发现→订阅→握手→组合应用），确认无回退。
- **补盲——本轮未覆盖的通道与功能**：
  - Web UI 通道（R1-R4 全部走 API/CLI，UI 只保证构建绿）；
  - 部署清单导出（tutorial 第五章，"要落地需要买什么/暴露什么/签约什么"——愿景的
    仿真→现实迁移链路的关键交付物，从未被用户测过）；
  - 回放（Fix-8 后 trajectory 已含握手记录，回放边界是否如文档所述）；
  - 新用户 onboarding（零导读进入别人建了一半的世界，检验遗留 9 的实际伤害）；
  - viewer 角色端到端（Fix-4 之后没有在真实多用户场景复测过）。
- **新 persona 建议**：第 4 个用户（viewer/观光客）、第 5 个用户（只读文档不学教程的
  "莽撞型"用户，专测错误恢复路径）。
- **协作质量观测**：握手延迟（遗留 12）、LLM 决策延迟归因、rule-accept 空转（遗留 4）
  在真实多事件场景的出现频率——为 Fix-12 定量级。

### Fix-11：服务消费链路设计+实现（遗留 1，R4 最大设计缺口）
- **设计文档已出：[docs/service-consumption-design.md](service-consumption-design.md)**
  （agreement 合约生命周期 + invoke/stream/AC 三类消费 + UsageRecord 计量 +
  SettlementProvider SPI；默认 Null 结算、无限资源假设；区块链结算留给
  独立项目经适配器接入，核心保持单位中性、合规隔离）。
- 实现前仍需平台方确认的开放点：invoke 的执行路由细节（同步/异步）、
  stream 的推送通道选型、AC ephemeral agreement 的默认开关。

### Fix-12：协作质量批（对应遗留 4/12/13 + R5 新发现）——✅ 已完成（2026-07-31）
- ~~accept 评估让 LLM 参与（fallback 只在 LLM 不可用时），空需求不照单全收~~
  ✅ LLM 优先链路补齐；fallback 收紧：空需求拒绝、匹配率 <50% 拒绝（理由含明细）、
  decisionSource 区分 llm/rule/fallback。
- ~~握手应答事件驱动化~~ ✅ 根因不是轮询：应答评估 LLM 调用无独立预算，撞上 Ollama
  provider 默认 120s 超时后走 fallback——accept 稳定落在 ~110-120s 的真相。
  评估调用加独立预算（默认 30s，`AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS`）。
- ~~reputation 记分与处置效果回检对齐~~ ✅ 温度类命令登记仿真时间回检
  （默认 600 仿真秒窗口），after 未朝目标方向变化记 reputation failure。
- ~~提案审查 LLM 超时预算~~（R5-P1-1）✅ `PROPOSAL_REVIEW_LLM_TIMEOUT_MS`
  （默认 60s）+ **平台方决策的超时兜底**：低风险且 ruleCheck.ok 的提案超时自动放行
  （`PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE` 默认开；审计标记
  `review-timeout-auto-approve`，owner 可 revert；中高风险维持 escalate）。
- **回放消费仿真时序**（R5-P1-2，与遗留 6 合并）：**未做，滚动到遗留清单**——
  回放烘焙仿真快照/trajectory 是独立功能块，建议单独批次。

### Fix-13：R5-P2 杂项批 ——✅ 已完成（2026-07-31）
- ~~viewer 事件注入不对称~~（小观 F-05）✅ 环境背书仿真的
  `POST /api/simulations/:id/events` 对 viewer 一律 403，与 /commands 的 Fix-4
  只读规则对齐；openapi 写明该门禁（端点仍在 legacy optionalAuth 作用域，仅新增
  viewer 判定）。
- ~~成员邮箱对 viewer 明文~~（小观 F-04）✅ 视角矩阵改为：owner/builder 见
  userId+email，viewer/非成员/匿名只见 displayName+role（env 详情内嵌成员与
  GET /members 同一转换点）。
- ~~sync-bindings 契约漂移~~（小观 F-06）✅ 核实为**方法不匹配**而非端点缺失：
  该路径只有 PUT/GET（契约与实现一致），POST 返回 404。契约已写明"本路径无
  POST"，并加测试钉住该行为。
- ~~无改名接口~~（小莽 F-02）✅ `PATCH /api/me {displayName}`（非空、≤80 字符）
  + CLI `eaf auth set-name <name>`。
- ~~auth 限流偏紧~~（三人提及）✅ `/api/auth/*` 默认 10→30 次/分，
  `RATE_LIMIT_AUTH_PER_MIN` 可配；.env.example 补齐全部限流变量。
- ~~部署清单入口难找~~（小莽 F-05）✅ CLI `eaf env deployment <id|name>`
  （人类模式打印采购清单摘要：设备/厂商/型号/价格/采购链接、要暴露的服务、
  要签约的外部服务 + notes）；README/CLI README/openapi 均写进入口。
- ~~builder 自有设备 PATCH 403 文案~~（小林 F-08）✅ 报错明确"世界层直改仅限
  环境 owner，自有设备也一样"，并指明 modify-object 提案路径。
- ~~env list 缺 services 计数~~（小观 F-03）✅ `counts.services`（按调用者可见性
  过滤，同环境详情规则）；CLI 表格加 svc 列。
- 小莽 F-08（sim 共享 runtime 疑点）：**证伪，不改代码**——核实结论写进
  小莽 notes 与 openapi 创建仿真说明。

### Fix-14：回放消费仿真时序 ——✅ 已完成（2026-07-31）
- ~~回放≠仿真复盘~~（R5-P1-2 小莽 F-06，与遗留 6 合并）✅ 回放产物烘焙
  仿真侧时序，纯仿真运行不再是 observationEvents=0 的空回放：
  - **决策/协作**（`sim-decision` 事件）：回放创建时扫描
    `EAF_TRAJECTORY_DIR/<simId>/` 的 trajectory JSONL，把窗口内属于本环境
    （record.scenario === envId）的决策/collaboration-response 记录按
    recordedAt 烘焙，agentId/decision/decisionSource/reasoning/
    collaborationId 放事件 `details`；事件挂在 agent 管理的 zone 上。
  - **物理演进**（`zone-sample` 事件）：env 背书仿真运行期新增
    wall-clock 轮询 + sim-time 阈值采样器，把全 zone 参数快照
    （temperature/co2/occupancy 等）追加到该仿真 trajectory 目录的
    `sim-timeline.jsonl`；间隔 `EAF_ZONE_SAMPLE_SIM_SEC`（默认 60 仿真秒）。
    回放按 recordedAt 窗口过滤烘焙，曲线在 `details.parameters`。
  - **设备状态**（`device-state` 事件）：订阅仿真总线的
    DEVICE_STATE_CHANGE / DEVICE_OPERATION_EXECUTED（失败操作不算），
    同样落 sim-timeline.jsonl 并烘焙（deviceId/service 在 `details`）。
  - core 侧最小改动：scenario 事件 schema 增加可选 `details` 对象透传
    （引擎不解释，只让回放元数据过 loadScenarioFile 校验）。ReplayReport
    增加 decisionEvents/zoneSampleEvents/deviceStateEvents 计数；
    openapi 与教程 §8 同步。遗留 6 就此关闭。

## 第九轮（R9，2026-08-05）：世界视图详情栏 UX + 仿真 LLM 可见性 ——✅ 已修复（2026-08-05）

- **世界视图右侧详情栏（WorldSidebar）标题看不完整、预览信息过载**。
  用户原话："右边框里很多标题都看不完整，大多就只有几个字符，光是预览完全不知道
  是什么。需要提供拉长的方式选择看到什么程度；预览方式需要修改——没有必要在预览
  界面出现那么多小字细节解释，反正也看不清。"
  → ① 侧栏左边缘加拖拽 handle，宽度 320–640px 可调（默认 360），localStorage
  持久化，与既有折叠按钮共存（折叠再展开恢复宽度，`lib/sidebarWidth.ts`）；
  ② tab bar 改横向滚动、标签不再截断（`title` 兜底）；③ 列表项名称改两行
  clamp 完整可读；④ 设备/Agent 详情改"摘要先行"：默认只剩名称/类型/owner/状态
  等一行级信息，capabilities、初始状态 JSON、绑定设备、管理区域、声誉明细、
  LLM 配置、服务清单全部收进默认折叠的展开区（`DetailSection`）。
- **仿真"大量失败"无从排查：LLM 模式不可见**。仿真创建 LLM 模式默认 'none'
  （rule-only），Agent 遇需要协作/伙伴选择的事件全部 Defer，前端只有一个很小的
  rule-only 角标，用户看不到模式、模型名与降级原因。
  → ① 三处默认值（WorldViewPage / ScenarioDetailPage / useAppStore）改 'auto'
  （有 LLM 就用、没有自动降级 rule-only 并带 llmWarning）；② 仿真控制台新增显眼
  的 LLM 状态条（`LlmStatusBar`）：模式（历史值 ollama，已移除/rule-only）+ 模型名 + 降级
  warning 警示 banner——server 侧 SimulationRecord/sim 信息响应新增 `llmModel`
  字段（openapi 同步），rule-only 时直接说明"无 LLM，协作决策不可用"；
  ③ 决策条目展示 defer/失败原因：core 的 RuntimeDecisionRecord 补 `reasoning`
  字段（此前 reasoning 只进 trajectory 与服务端日志，不上快照），LivePanels
  最近决策与事件流决策行均可见；④ Agent 详情摘要行显示 LLM 配置状态
  （无/模型名；历史 ollama 选项已移除），细节进折叠区。

## 第十轮（R10，2026-08-18）：前端可视化批次浏览器实测（Playwright 无头）——✅ 已修复（2026-08-18）

实测方法：Playwright 无头 Chromium（`data/campus-e2e/ui/probe-vis.mjs`，会话 cookie
驱动真实 UI），校园场景（132 zone / 3 栋楼）从文件选择器导入后逐页截图核对。
发现并修复：

- **2D 楼层图整层不可见**（P0）。ReactFlow `fitView` 仅在初始化生效，而世界数据
  异步到达；且 `minZoom=0.2` 容不下 239m 宽楼层。→ 内容就绪/切楼层时显式重 fit，
  `minZoom` 降 0.05（WorldMap.tsx）。
- **室外围护 zone（校园室外 325×250m）劫持视图**：fitView 包围盒被撑到 20 倍大、
  管辖它的 Agent 锚点飞到楼外空地、32° 基线把整幅地图热力染红、3D 里变成压住
  楼栋的巨板。→ 室外 zone 从 fit 目标/Agent 锚点/热力填充/3D 挤出中全部排除
  （WorldMap.tsx + lib/building3d.ts）。
- **仿真控制台地图永久空白**（P0）。RF11 受控模式 `createNodeInternals` 同步
  nodes 时丢弃已测量 width/height，节点 `visibility:hidden` 等 ResizeObserver
  重测；快照每 1.5s 重建 nodes 使其永远无法完成初始化。→ buildGraph 给
  zone/doorGap/deviceDot/agentMarker 显式写 `width`/`height`（layout 常量），
  不依赖运行时测量。
- **楼层切换 tab 与图层开关叠在一起**（均 absolute top-left）。→ `.world-canvas
  .floor-switcher { top: 52px }`。
- **创建环境对话框 React 受控/非受控警告**：空白模式名称 input 与导入模式文件
  input 同位置被 React 复用。→ 两个 input 各加稳定 `key`。

实测确认可用：区域作用域多选（132/132 全选→排除）、速度三档（实时×1/演示/极速）、
LLM rule-only 降级横幅、热力图例、评估 tab 五卡（决策/握手/回检/声誉）、通知
「需要我处理/全部动态」分组、3D 楼栋视图（室外巨板消除后三栋楼清晰）、蓝图与
评分报告 tab 出现。另注：配额 `running_sims_per_user` 3/3 耗尽时前端红色错误
banner 展示正确；实测产生的仿真已用 API 全部 stop。

## 第十一轮（R11，2026-08-18）：E2E 体验系统化（首次体验闭环）——✅ 已修复（2026-08-18）

方法：按规划 W1-W7 逐波「实现 → vitest → Playwright 无头浏览器实测（截图）→ 修复」，
探针脚本 data/campus-e2e/ui/probe-w{1,2,34,5,6}.mjs + smoke.mjs（一条命令全序列，
根 package.json `npm run e2e:ui`）。

- **新用户断链（P0）**：注册→能跑的仿真需 6+ 步且要自备 JSON；starter-home 按钮
  名实不符（实为打开导入框）。→ 服务端新增只读 `GET /api/scenario-templates[/:id]`
  （CLI 同步 `eaf scenario-templates`）；创建对话框加默认「模板」tab（11 个内置场景
  一键创建）；工作台三步引导卡（创建环境→装蓝图→跑仿真，完成态推导+dismiss）。
  实测：注册→环境创建仅 2 次点击。
- **演示节奏（P0）**：校园场景首个事件在 t=36000s，学生 10 分钟看不到任何活动。
  → 生成器加 9 条演示剧本（t=60-570s：学生进入/温度越限/故障/恢复/宿舍/图书馆），
  ×60 演示档 ~10s 看完整轮；控制台首次进入小贴士（可 dismiss）。实测 23 条事件
  触发、地图热力随剧情变化。
- **LLM 不可见（P0）**：rule-only 只有一行 warning。→ LlmStatusBar 内嵌「如何启用」
  四步指引（装 ollama/pull 模型/OLLAMA_BASE_URL/重启——历史指引，已移除 R44-B）；仿真创建 select 加模式说明行。
- **地图导航（P1）**：zone 点选无反馈、无楼栋聚焦。→ zone 选中态高亮+侧栏详情；
  楼栋 chip（DORM1/LIB1/TB1）聚焦 fit；对比度 12%→18%、图例三刻度、操作 hint。
  实测修复两个附带 bug：室外 zone 吞掉全部 zone 点击（zIndex+点击排除）、
  楼栋 chip 显示原始 id（formatBuildingId）。
- **操作门槛（P1）**：事件注入要懂 schema、部署面板 940 行平铺。→ 事件注入四个
  预设 chip（人员进入/温度越限/恢复/浓烟）；部署向导四步 stepper（连接→绑定→
  安全闸→测试，完成态驱动建议步）。
- **走查确认**：英文界面无未翻译 key；暗色主题正常；非成员看公开环境时编辑
  控件正确隐藏。开放问题：公开环境的非成员可直接创建并运行仿真（计自己配额），
  产品侧需确认是否预期；公开环境缺少显式「只读访客」身份标识与「加入环境」
  入口的显眼度。

## 第十二轮（R12，2026-08-18/19）：agent 模拟真人试点 + 系统性修复——✅ 已修复（2026-08-19）

方法：三个 persona（新手学生/进阶学生/教师）由独立 agent 扮演，用 Playwright 无头
浏览器走真实 UI 完成任务卡（脚本 data/campus-e2e/ui/persona-*.mjs，截图 shots/persona-*.png），
摩擦日志按严重度回收后系统修复。这是首次"模拟真人"试点，证明 persona 测试能抓到
探针脚本抓不到的问题（安全越权、决策链路静默失败）。

### P0 修复

- **仿真列表/操作越权（安全）**：GET /api/simulations 返回所有用户的仿真、
  ?environmentId= 被忽略、任何人可 stop 他人仿真。→ 列表按「创建者+成员环境+admin」
  过滤；environmentId 真正生效且校验环境可见性；start/pause/resume/stop/step 仅
  创建者/环境 owner·builder/admin；stop 容忍空 JSON body（Fix-47，simulation-access
  测试 22 例）。
- **温度越限「说了会做但什么都没做」（F1）**：根因二重——① Flow 执行链路 zone 盲：
  「101 过热降温」Flow 把制冷命令发到了 108 教室空调（能力匹配的第一台）；② LLM 模式
  下 handle_independently 本来就不产生命令但决策记录只字不提。→ flow-invoker 优先
  触发 zone 内设备、无可用设备显式失败；决策记录补 actuation 可见性标注（core 回归 6/6）。
- **「运行仿真」静默新建**：已有活动仿真时每次点击都新建（配额 3/人很快顶爆）。
  → 启动前查活动仿真，有则 popover「进入现有仿真/新建/取消」。

### P1 修复

- 成员 tab 从只读变可管理：批量导入对话框（逐行结果 added/already_member/not_found）、
  角色下拉、移除成员；被加入环境新增 `member.added` 通知（不再"被加入了都不知道"）。
- 控制台右抽屉 rail 从裸 « 图标加竖排文字「注入·面板」（两个学生都没找到入口）。
- Flow 页文案 `<触发器>` HTML 实体泄漏改「」引号。
- 叙事时间线 132 个过滤 chip 收进「筛选（N Agent · M 区域）▸」折叠行。
- 评分报告 owner 明细 156 台设备文字墙改滚动容器 + 类目计数。
- 模板列表按请求语言返回（?lang=/Accept-Language，复用 i18n 插件）；overview 加
  simulationCount（引导卡步骤③精确判定）。

### LLM 实机验证（Ollama qwen3-vl:8b）

- 校园模板 4 个 Agent 全部 llmEnabled；简单事件 precheck 短路（设计如此，省 token）；
  注入跨域/特殊能力事件后 **bySource.llm=6、AC 握手 2 发起 2 成功**——协作决策链路
  真实工作。教学楼模板 Agent 无 llm block（rule-only），做 LLM 演示应选校园模板。

### 遗留（下一轮）

- 教师链：学生侧仍无"班级环境"引导；评分报告是计数不是评分；邀请机制缺失
  （学生须先自行注册）。
- 仿真控制台无 URL 直达（只能从工作台/环境页挂入）；eval 跨仿真按环境聚合的
  语义不直观；GET /api/environments 混合公开与自有（建议默认"我的"）。
- Agent 向导步骤依赖无提示（绑定设备前需先有对应能力）。
- 能耗数据仍无 UI 呈现（只有 snapshot API + 控制台能耗列）。

## 第十三轮（R13，2026-08-19）：深圳场景改进 + 信息分级重构——✅ 已修复（2026-08-19）

用户方向：校园场景暂缓深挖（场景/建模难一步到位），转向深圳城市级具身韧性系统；
前端遮挡/拥挤根源是「所有内容堆首页」，确立三级展示模式。

### Track S：深圳场景（config/scenarios/shenzhen-resilience.json）

- 6 条事件全补 humanNarrative（lint 清零）+ cinematography 补齐（原仅 E1 有运镜）。
- 节奏打散（30/75/140/200/255/330，原等距 60s）+ 4 条 recovery（风停/水退/火灭/
  伤员清零，t=420-580）——原来 one-shot 事件后世界永远停在灾中状态。
- 新增龙岗取血冷链事件（原 long-gang 零事件，血液中心全程陪跑）。
- 显式邻接 3 对（原 polygon proximity 派生近乎为空，邻接推理失效）。
- 卫健委虚拟指挥中心锚点设备（原 health-commission 无设备，marker 漂海面）。
- 验证：lint 无 finding；rule-only ×400 仿真 11/11 事件全触发；geo 地图渲染正确。
- 删除根目录 nul 垃圾文件（曾阻塞 ripgrep 全仓搜索）。
- 注意：导入环境时 agent/device id 会重新生成（按 id 查会"找不到"，按 name 查）。

### Track F：信息分级三级模式（用户定义的交互）

- **列表行只显示名字**（+色块/徽章/⚠）：设备去掉「type·zone」meta、Agent 去掉
  「N 设备 · M 区域」计数、服务去掉长 meta（提供方/来源/可见性/信誉）。
- **点行 = 行内展开简介**（不换视图）：设备 type·zone·能力数；Agent 绑定数·LLM
  状态·信誉；服务提供方·来源·可见性·描述 2 行。共享 RowBrief 组件 + lib/rowBrief
  纯函数。
- **简介里「查看完整详情」按钮** = 进现有详情视图（点行不再直接进详情）。
- 服务详情的描述/interface JSON 包 DetailSection 折叠（原几十行 JSON 平铺）。
- 地图 .perspective-banner 与 .canvas-view-control 同位冲突修复（top 10→44px）。
- styles.css 编辑教训：Git Bash sed -i 会把 CRLF 洗成 LF，该文件只可用支持 CRLF
  保留的方式编辑（已在文档与 handoff 记录）。

### 遗留

- 深圳场景 polygon 仍是矩形近似（非真实行政区边界）；geo 瓦片依赖外网（已在
  scenario 文档 known limitations 注明）；shenzhen 专属蓝图未做（等场景稳定）。
- Agent 行无故障字段可显（fault 是仿真事件不是设备属性）。

## 第十四轮（R14，2026-08-19）：透明度与可视化攻坚 Playwright 实测

方法：R14 计划 §5 规程。独立探针 `data/campus-e2e/ui/probe-r14.mjs`（独立账号
state-r14.json，stage=setup/app/healthview/sim/simhealth/wizard/blueprint/cleanup），
真实浏览器逐项操作 + 截图目检（shots/r14-*.png）；校园模板 + personal-health 模板
各建一个环境，实测后仿真全 stop、环境全删。Ollama qwen3-vl:8b 在线，健康场景跑到
真实 LLM 协作（initiate_ac + AC 事件流）。

### 各项验收结论

- **P0-1 应用概览 tab ✅**：侧栏首 tab「应用」默认选中；计数 chips（设备 156 /
  Agent 4 / 服务 540 / Flow 2 / 区域 132）齐；健康度列出「未绑定设备的 Agent」
  「无服务的 Agent」（校园 132 zone 全被 4 个 Agent 的 managedZoneIds 覆盖，
  zoneUnmanaged 正确地为空）；关系总览按 Agent 分组，点健康问题里的 Agent 名
  跳到 Agent tab 详情。截图 r14-app-overview / r14-app-overview-jump。
- **P0-2 正在发生头条 ✅（修复后）**：hero-line 随决策滚动（demo 事件 →
  「TB1 楼宇管家 对 TB1 102 教室 独立处理（理由）· 5 秒前」）；rule-only 注入
  温度越限后出决策行；LLM 模式下健康场景出「…发起协作」+ 英文 LLM reasoning。
  截图 r14-hero-initial / r14-hero-running / r14-hero-after-inject。
- **P0-3 可视化兜底 ✅**：① personal-health（已补 bounds）世界视图布局不重叠、
  zone 名低缩放下保留、放大后全名+类型标签可读，未匹配分类的 zone 走中性浅灰
  （classifyZone 词表是校园向的， residential/clinic/hospital 等多落 'other'，
  类别色只有宿舍紫/室外绿——属设计内，扩词表留作后续）。② 「显示全部协作边」
  开关在控制台地图右上，健康场景 AC 起来后出现，可勾/退勾，hint 文案在；
  默认 60s 窗口过滤逻辑由 collabGraph vitest 覆盖（实测时全部边都在窗口内，
  数量差未复现）。③ 无 bounds 力导 fallback 跳过（纯函数 vitest 已覆盖）。
  截图 r14-health-world / r14-health-world-zoom / r14-collab-default /
  r14-collab-show-all。
- **P0-4**：同 ①，personal-health 已达可读水准（与养老院差距在类别色覆盖率，
  非布局）。
- **P1-1 一句话造 Flow 向导 ✅**：三步走完（zone + temperature > 30 → cooling），
  创建成功并进画布，Flow 出现在列表；无执行器 zone（楼梯井）在步骤②被阻断，
  引导文案 + 「去『设备』页添加」链接 + 下一步禁用。截图 r14-wizard-step1/2/3 /
  r14-wizard-created / r14-wizard-blocked。
- **P1-2 建造后体检 ✅（修复后）**：蓝图安装成功即出一次性体检卡
  （data-testid="health-check-card"），列健康问题、可跳「应用」总览、可 dismiss、
  重进 tab 不再出现。截图 r14-blueprint-health-card / r14-healthcard-jump-app。
- **P1-3 时间线计数 ✅**：校园 rule-only 仿真抽屉头条显示
  「叙事时间线 · 11 个剧集 · 16 条原始事件 · 点击展开」，R13 苏州的
  「0 条事件」矛盾未复现。截图 r14-timeline-count。

### 修复项（实测抓出，当场修）

- **HeroLine 注入事件丢「对什么」**：注入事件不上总线、不在 scenarioEvents 里，
  决策行的 zone 部分被整体省略。deriveHeroLine 增加 triggerHints 兜底
  （store 里注入面板已按 eventId 记录 zoneId），改后注入事件的头条显示
  「对 TB1 101 教室」。lib/happeningNow.ts + HeroLine.tsx + 补 vitest 用例。
- **蓝图安装后世界视图不刷新（存量 bug，P1-2 使其显形）**：useInstallBlueprint
  只 invalidate react-query 的 environments.detail，但打开的世界在 zustand
  （openEnvironment），装完蓝图后侧栏计数/地图/应用概览/体检卡全是旧数据。
  onSuccess 增加「当前打开环境即目标环境时 reloadWorld()」。hooks/useBlueprints.ts。
- 回验：apps/web vitest 71 文件 554 用例全绿；npm run build -w web 通过。

### 遗留

- rule-only 决策 reasoning 是英文模板句（"Agent has direct actuator coverage…"），
  hero line 原样展示对中文用户不友好——需服务端把 reasoning 结构化或本地化。
- RuntimeDecisionRecord 无 zoneId 字段，hero/剧集的 zone 只能靠 scenarioEvents +
  triggerHints 客户端拼接；跨会话/刷新后注入事件的 zone 仍丢。
- 健康度检查标题的「Agent」被 CSS text-transform 成大写「AGENT」（.object-detail__label
  惯例），美观问题。
- 协作边 60s 窗口与「显示全部」的数量差未在浏览器复现（需 >60s 无活动的长仿真）；
  classifyZone 词表校园向，健康/医院类 zone 类别色覆盖率低。
- 运维教训：后台起 server 必须重定向 stdout（本轮 server 日志超 16MiB 被杀）；
  后台任务默认 600s 超时，长仿真验证要 disable_timeout；vite 端口被占会静挪到
  5174，起探针前确认 5173 真的是目标实例。

### P2 收尾批（2026-08-19，纯前端小修，未起浏览器）

- **LLM 调用延迟可见**：快照 `llm.triage` 早已带 `avgBigModelLatencyMs` /
  `avgTriageLatencyMs`（wire 上现成，未改契约）。deriveLlmLine 在分流行追加
  「大模型均延 9.0s · 分流均延 1.5s」，<1s 显示 ms；对应模型未应答过（null）
  时不显示。lib/llmMetrics.ts + llmMetricsLib:bigModelLatency/triageLatency
  双语 key + 4 个新 vitest 用例。
- **文本截断规则统一**：扫完全部 clamp/ellipsis 类，reasoning 系
  （event-log/hero/decision-item）此前已有 title 兜底；本轮给缺 title 的
  截断点补齐：object-list__name 全部用点（FlowsPage / NotificationsPage /
  WorkbenchPage×2 / DeploymentPanel×4 / AgreementsPanel / ZonePanel /
  ServicesPanel；WorldSidebar 两处原本就有）、episode-row__summary、
  collab-node__id、reputation-bar__capability、template-card__description、
  object-list__brief-desc。`.device-node__name` 为无组件引用的死 CSS，未动；
  ObservabilityCard 行级 title 已覆盖，跳过。
- **speed select 非预设值空白**：ControlBar SpeedSelect 在非预设值时追加临时
  option「自定义 ×N」（沿用 ReplayBar 已验证的同款处理），组件导出并在
  speedPresets.test.tsx 补 2 个用例；sim.speedPreset.custom 双语 key。
- 回验：apps/web vitest 71 文件 558 用例全绿；npm run build -w web 通过。

## R15（2026-08-20，成熟度轮：健壮性 · 展示门面 · LLM 服务层 · 契约收口）

> 计划：docs/plan-r15-maturity.md；soak 报告 docs/soak-r15.md；部署/运维
> docs/deployment.md。全部经 Playwright 实测（data/campus-e2e/ui/probe-r15.mjs
> + verify/soak.mjs + verify/llm-load.mjs）。

### Track A 健壮性（全部验收通过）

- **A1 soak**：22min 墙钟 / 5.68 仿真日（×400 速度）——RSS 前 6 分钟升温后
  完全走平（303±1MiB）、tickWallMs 无上漂（首段 2.9s 为启动期 LLM 决策，
  回落至 600ms 级）、决策全程持续（F-24 无回归）、WS 1259 帧 0 断连、
  快照体积有界。autoThrottled 全程为真是设计行为（Fix-42b′ 饱和降速）。
- **A2 数据安全**：v1→最新全链迁移测试 + v22→v23 边界 + WAL 备份→删除→恢复
  round-trip 测试；`POST /api/admin/backup`（一致性在线快照）+ `eaf admin
  backup`；流程文档化。v24 迁移在真实 soak 库上热升级实测。
- **A3 可观测性**：`GET /api/health`（公开探活+DB 探测，docker healthcheck
  已切换）；/api/metrics 与管理摘要新增 RSS/heap、逐仿真 tick 成本、LLM
  延迟 p50/p95/p99、队列深度与等待统计。
- **A4 配置自检**：所有非法 env 一次性聚合报出（含过去"用到才炸"的
  LLM_MAX_CONCURRENT/OLLAMA_BASE_URL/HASS_URL）；空串视为未设置。

### Track B 展示门面（实测通过）

- **B1 可分享回放**：公开环境一键生成只读分享链接（`/share/:id` 匿名可看
  决策链+物理曲线+事件时间线+世界快照）；私有环境 403 ENV_NOT_PUBLIC（对齐
  匿名环境详情边界）。评委无账号全程走通（probe share 阶段截图目检）。
- **B2 演示剧本一键播放**：控制台「播放演示剧本」逐幕跳到 campus 9 条
  demo 事件的时刻并暂停展示（跳转→暂停→停留 4s→下一幕），演示模式下可用；
  剧本时刻已过则禁用并解释。

### Track C LLM 服务层

- **C1 并发治理**：全局队列（LLM_MAX_CONCURRENT，启动校验并热应用）；队列
  等待统计（waitCount/avgWaitMs/maxWaitMs/depthHighWater）进管理摘要与
  Prometheus。**30 并发仿真压测**（verify/llm-load.mjs）：创建 30 仿真
  1.19s；23 次 LLM 调用 0 错误；队列峰值深度 20、平均等待 8.2s、最大 15.0s、
  端到端 p95 16.2s，突发完全吸收后归零。
- **C2 多后端**：`LLM_PROVIDER=openai-compatible` + LLM_BASE_URL/LLM_API_KEY/
  LLM_MODEL（vLLM/LM Studio/云网关）；决策与提案审查客户端共用；缺 BASE_URL
  或 MODEL 启动即报；Ollama 路径完全兼容。
- **C3 延迟归因**：deployment.md §5 固化四步分诊法（排队→端到端差→错误率
  →trajectory 复盘）；soak 锚点（qwen3-vl:8b p95 33.2s 属模型生成类）。

### Track D 契约/体验收口

- **D1 控制台 URL 直达**：`/simulations/:simId` 恢复页（列表反查 envId →
  重开控制台）；失效链接自解释（区分不存在与服务重启）。实测 URL 保持、
  控制台完整恢复。
- **D2 环境列表语义**：`GET /api/environments` 默认"我的"，`?filter=all`
  显式看公开；web 两页签、CLI `eaf env list --all`、openapi 同步。
- **D3 规则理由结构化+本地化**：决策记录带 reasoningCode/reasoningParams
  （precheck.*/rule.*），链路贯通 record→trajectory→回放事件→分享页；
  控制台 hero 行/事件流/决策链/分享页按 code 渲染中文模板，英文审计原文
  保留。实测：「（Agent 在 lib1-reading-f0-1 有直接执行器覆盖…）」上线。
- **D4 决策记录 zoneId**：服务端权威 zone 上记录（hero 行 zone 解析首选，
  替代客户端 triggerHints 拼接、刷新即丢的旧路）。
- **D5 目录搜索别名**：「温度」→ 温湿/temperature 扩展（OR 匹配
  name/model/device_type/capabilities），实测搜到「小米温湿度传感器2」。
- **D9 classifyZone 词表**：新增 medical（医院/诊所/病房/护理）类别与
  commercial 词条（街道/商铺/门店/retail）。
- **D6/D7 复核**：GET /api/agreements/:id 与通知 consumerName/termsSummary、
  activity 对象名——前几轮已交付，本轮确认在位。

### D 剩余三项（同日补完，probe-r15.mjs dlast 阶段实测）

- **D8 能耗曲线面板**：lib/deviceEnergy.ts（纯函数：live 流累积/去重/换仿真
  重置、zone 汇总、Top 设备曲线+总量虚线 option）+ EnergyPanel（控制台右抽屉
  环境曲线之下，默认收起）。实测：校园 156 台计量设备，「TB1 xxx 教室 ·
  839 Wh」zone 徽章 + echarts 画布上线（回放游标不污染——数据源是 live 流）。
- **D9 GeoWorldMap zone 选中态**：zone polygon 可点击（选中=粗描边 3.5 +
  fill 0.3，再点取消），世界视图与控制台均接线。实测：苏州 geo 场景点击后
  stroke-width 3.5 出现。注意 Playwright force-click 在 Leaflet SVG path 上
  不可靠，须用真实鼠标坐标点击并等 ≥900ms 图层重建。
- **D10 教师链收口**：migration v25 env_invites——名册导入未注册邮箱挂起为
  待接受邀请（status 'invited'），**学生注册即自动入班**（auth 注册回调接受
  全部 pending）；owner 可视化邀请列表（成员 tab）+ 撤销（GET/DELETE
  /api/environments/:id/invites）；学生引导：工作台空态「找我的班级/公开环境」
  CTA（/environments?tab=public 直达公开页签）+「被邀请过？注册即入班」提示。
  评分维度仍为决策点（未做评分进化）。实测：invited 挂起→注册自动入班
  （myRole=builder）→UI 列表→撤销减一，全链路绿。

### Track E 本轮增量（E3 + E1；E2 度量）

- **E3 双 fallback 统一**：3D 视图的未定界 zone 不再走自建三列网格，改用与
  2D 地图相同的邻接力导布局（layoutUnboundedZonePositions 导出共享；
  px→米统一缩放保留邻接聚类），同一环境在两个视图中的排布语义一致。
  building3d 测试改为断言邻接聚类保留 + 无重叠。
- **E1 死 CSS 清理**：全量扫描 676 个类选择器（识别动态拼接前缀与
  leaflet/react-flow 库注入类），删除真死代码 52 行（.device-node 家族 7
  条——R14 已标注——与 .console-side 2 条）。
- **E2 度量与第一刀（Fix-31 持续项）**：起点 EngineRuntime 3040 行（目标
  <1500）、ACExecutor 3185、ACNecessityAssessor 1972、DualTriggerACManager
  1905；全仓千行文件 24 个。**第一刀已落**：模块级类型/常量/纯函数整块抽到
  runtime/engine-shared.ts（公开面经 re-export 保持不变，core 1245 测试
  全绿）——EngineRuntime 3040 → 2277。**第二刀已落**：快照组装三方法
  （getSnapshot/buildServicesSnapshot/buildLlmSnapshot，约 215 行）纯函数化
  为 buildEngineSnapshot/buildServicesSnapshot/buildLlmSnapshot（结构化
  SnapshotInput，engine-shared 不引 CognitiveAgent/EnvironmentCenter；
  getSnapshot 只收集材料并委托），EngineRuntime 2277 → 2173。**第三刀已落**：
  recordHandshakeToTrajectory + getCollaborations（约 120 行）纯函数化
  （engine-shared 结构化 HandshakeRecorderLike/CollaborationAgentLike），
  EngineRuntime 2173 → 2062。**第四刀已落**：injectEvent 的输入整形/payload/
  逐 Agent SystemEvent 构造 + buildAgent 的 dualTriggerConfig 组装
  （约 110 行）纯函数化（resolveInjection/buildInjectedEventPayload/
  buildInjectedSystemEvent/buildAgentDualTriggerConfig），
  EngineRuntime 2062 → 1998（破 2000）。**第五刀已落**：决策记录整形
  （buildDecisionRecord + extractRecordEventId/ZoneId，R15-D3/D4 字段保留）、
  温度效应检查的资格/方向判定与效果评估（resolveEffectCheck/
  isEffectEffective）、zone 物理注册元数据（zonePhysicsRegistration），
  EngineRuntime 1998 → 1956。**第六刀已落**：readZoneEnvSnapshot 整体纯化
  （buildZoneEnvSnapshot——流条件评估的 zone 环境读路径）+ initReputation
  三个订阅处理器的载荷解析（parseCollabMessageAction/
  parseCollabCompletedAction/parseDeviceOperationAction；完成态分类复用
  classifyCollaborationOutcome，partial≠failure 语义保留），
  EngineRuntime 1956 → 1923。**架构复核与止血（平台方指出重组风险后）**：
  审计确认①依赖方向未破（decision/reputation/flows 无反向引 runtime，
  无环）②但存在真实问题：类上遗留无引用的 extractEventId/ZoneId 两个
  static（与新纯函数构成两份实现）——已删除；engine-shared 头部补齐
  **分层规则**（L1 只进不出防环 / L2 编排永不入此文件 / L3 SnapshotInput
  冻结不许扩 / L4 防抽屉化与拆分预案：超 1800 行须用 ts-morph 类 AST 工具
  拆 CONTRACT 层，禁用行启发式文本手术——本轮实测其会截断 union 续行与
  注释归属，已回滚）。**决策：1500 行指标让位于架构质量**——六刀所得
  3040→1896 保持，后续缩减只接受真实接缝（constructor 装配 builder 化），
  机械切片停止。EngineRuntime 终值 1896。

**系统性架构轮（平台方要求基于设计重组，非机械切片）**：按
docs/architecture-runtime.md 的四层模型（L1 契约/L2 塑形/L3 编排/L4 消费）
+ 五条分层规则（R1-R5）+ 五个领域子模块，用 TypeScript Compiler API
（AST 精确声明提取，零行启发式）将 engine-shared.ts 拆为：

- `runtime/contract.ts`（532 行）—— L1 契约层（类型+结构视图+设备工厂）
- `runtime/shaping/{world,snapshot,events,collaboration,agents}.ts`
  （共 1035 行）—— L2 塑形层（按领域内聚的纯函数）
- `runtime/shaping/index.ts`（barrel）

engine-shared.ts 已删除。EngineRuntime（1900 行）作为唯一 L3 编排入口。
core 1245 测试全绿，npm test 11/11，分层审计通过。
  下一切片：getSnapshot 组装与
  决策记录/声誉接线两个内聚块（需传 this 上下文对象，风险高于本刀）。

**Fix-31 后续切片候选**：reputation 接线块（initReputation + onReputation… + rememberAcCapabilities/finalizeCollaborationSessions，约 170 行）与 buildAgent（约 140 行）。（快照组装三方法——约 215 行——已于第二刀完成）
`getSnapshot`(约 120 行) + `buildServicesSnapshot`(约 20 行) +
`buildLlmSnapshot`(约 73 行)，整段约 215 行移入 engine-shared 纯函数。所需
上下文字段（已核实）：scenario/state/simTimeSec+timeManager 当前时刻/speed/
tickCount/lastTickWallMs/autoThrottled/physicalEnv(经 readZoneEnvSnapshot)/
zoneOccupancy/devicesById/agents/agentRuntimeInfo/recentDecisions/firedEventIds
+scenario.events/envCenter 服务注册表/sharedLlmClient 缓存 +triageOption/
faultProfiles。做法：engine-shared 定义 `SnapshotContext` 接口承载上述字段，
三个 builder 改纯函数；`getSnapshot()` 只收集字段并委托。预期 2326 → ~2130。
再往后：reputation 接线块（initReputation 1650-1746 + onReputation… 1747-1775
+ rememberAcCapabilities/finalizeCollaborationSessions，约 170 行）与
buildAgent(1399-1538，约 140 行) 是下一批候选。

### Track F 内容生态（P2，R13 遗留补齐）

- **三个深圳韧性专属蓝图**（种子 idempotent，启动自动入库）：
  `sz-flood-drainage` 易涝点排水哨兵（水位计+智能排水阀+水务值守，暴雨湿度
  >90% 自动开阀）、`sz-cbd-air-guard` CBD 空气净化哨兵（CO₂>1000ppm 自动
  净化）、`sz-emergency-lighting` 应急照明套件（烟感→应急灯全亮）。设备类型
  对齐 shenzhen-resilience 词表；Flow 节点只用已验证可执行的 capability
  （turn-on 等，与教室蓝图同一词汇）。
- **端到端实测**（深圳环境全链）：模板建环境 → 蓝图安装（2 设备+1 Agent+
  1 Flow，201）→ 注入暴雨 humidity=95 → **排水阀自动开启**（power:true，
  累计 741.67Wh）→ flow_runs 台账 `success` → 清理 204。蓝图测试 +2 用例。

### 遗留（下一轮候选）

- **Track E 剩余**：styles.css 拆分（~5340 行）、EngineRuntime 瘦身（见上度量）。
- 教师评分报告从计数进化为评分（需平台方定义维度——决策点）。
- 探针小坑（已修在探针内）：无 body 的 DELETE 带 content-type:json 会被
  Fastify 400；probe 会话 cookie 需挂在页面域（5173）而非 API 域；
  控制台右抽屉 R12 起默认收起（探针需先点 console-drawer__collapse）。

---

## R40-D2（2026-08-28）：多利益相关者实时探索（5-persona，suzhou-city 私有副本）

> 场景：从公共画廊模板 suzhou-city 导入私有舞台（9 zone / 33 device / 12 agent /
> 2 flow），5 个 persona（owner 市政业主 / facility 园区设施 / security 应急安全 /
> health 社康医疗 / retail 商户零售）各自注册并加入。探针：
> `data/devloop/tmp/d2/*.mjs`（副本 DB `d2-explore.db`，server :8189）。
> 逐项判定与新能力专项见 [devloop-r40-d2-report.md](devloop-r40-d2-report.md)。

### D2-F1 [P1] suzhou-city / teaching-building 模板 agents 无 llm block —— 导入即 rule-only

复现：`GET /api/scenario-templates/suzhou-city`（12 agents，`llm` 字段 0 个）→
`POST /api/environments` 导入 → `POST /api/simulations` → 响应 `llm:"rule-only"` +
`llmWarning: "This environment has no LLM configured at the world level (no agent
declares an llm block)…"`。对照：11 个画廊模板中其余 9 个 agents 全部带 llm block
（如 shenzhen-resilience 12/12）。影响：画廊翻新（dc712b3）遗漏了这两个模板的
认知栈接线；用户导入后 LLM 决策/what-if 全走规则路径，且唯一的提示埋在创建响应
的 llmWarning 里（列表/UI 场景卡片上不可见）。修复方向：给两个模板的 agents 补
`llm` block；或导入时若 server 已自动探测到本地 LLM 则默认继承（可被显式 llm:null
覆盖）。

### D2-F2 [P1] NL 指挥链路：意图解析正确，但 4/4 命令零执行且报告 success:true

复现（sim `sim-4a3af698-…-mtcysufo-2`，agent `5327ac6d` 园区设施能源管家，
llm=ac-decision-v4:latest，`POST /api/agents/:id/command`）：

- "把园区厂房的空调温度设为26度" → intent 解析完全正确（set_parameter /
  目标设备 7629b492 / temperature 26），但 actionPlan.primary.action=
  **invoke_flow 且 flowId="invoke_flow_id"**（占位符幻觉）→ NL lane 返回
  `executionResult {success:true, actions:[], message:'decision "invoke_flow" —
  no device commands executed by the NL lane'}`，设备状态无任何变化。
- "把园区厂房的空调温度调到26度" → decision=escalate（"beyond what I can safely
  do"）→ 同样零执行。
- "打开园区厂房的空调" → decisionSource=rules、action=wait → 零执行（耗时 31.3s）。
- "把厂房空调温度调到26度，不要询问直接执行" → invoke_flow 且 flowId="unknown"。

根因两层：(a) `nl-orchestrator.ts` Stage 3 只执行 `handle_independently`，其他动作
（含携带完整 deviceActions 的 invoke_flow）一律不执行也不回退，但对外报告
success:true——用户说了话、系统说成功、设备没动；(b) ac-decision-v4 微调模型对
简单温控命令系统性偏向 invoke_flow/escalate/wait（幻觉 flowId 是 A4 修复之外的
新失败面）。修复方向：NL lane 对 invoke_flow 决策校验 flowId 存在性（未知→教学
错误或回退 primary.deviceActions）；executionResult.success 对"零执行"应诚实为
false/`no-op`。

### D2-F3 [P2] NL 回复不跟随用户语言且泄漏决策内部 jargon

复现（同 D2-F2 第一条）：中文命令的 naturalLanguageResponse 为英文
`I'm running the "invoke_flow_id" procedure ({"targetZones":[…]}). If severity > 2
or confidence < 0.5, I'll escalate.` —— 既不跟随提问语言，又把内部 flowId/阈值
常量直接外泄给最终用户。修复方向：generateNLResponse 模板按 intent 语言生成；
内部参数不进用户可见文案。

### D2-F4 [P2] what-if 对 catalog 一键放置的设备全零 delta（误导性 neutral）

复现：`POST /api/agents/5327ac6d…/what-if` {text:"如果关闭园区厂房空调30分钟…"}
→ verdict neutral、confidence 0.85、delta {temperature:0, energy:0, comfort:0}；
同一世界的模板灯杆结构化干预 turn-off 1800s → energy -30、light -0.64（正常）。

**根因（R41-C2 排查确认，比初判更深）**：不是物理接线缺失——catalog 物理初值
（coolingPowerW 等）经 `catalogPhysicsInitialState` 正确落入设备 initialState，
SimulatedDevice 也正确使用。真正断点在 **world-state 的场景重建模型**：
`planWorldStateRestore`（packages/core/src/runtime/shaping/world-state.ts:329）
对不在 `context.deviceIds`（来自场景设备）里的 checkpoint 设备直接丢弃并告警
"no longer exists in the scenario"。catalog 设备是**运行时**经 install-devices
提案加入的，不在场景 JSON 里 → what-if 的两个 fork、休眠跨进程恢复、沙盒廉价
fork 都从场景重建世界 → catalog 设备连同其状态在副本侧整体消失 → 干预命令
找不到设备 → 全零 delta + 高置信 neutral。

**影响面**：三条链路（what-if 预测、hibernate/resume 跨进程、P2F §10.1 便宜
fork）对一切运行时添加的设备全部失明——不只误导预测，还可能让恢复后的世界
静默少设备。

**修复设计（待实施，引擎级）**：
1. `EngineWorldStateExport` 增加 `deviceDefinitions?: Array<ScenarioDevice 形状>`
   ——导出时对 `devicesById` 中不在 scenario.devices 的设备携带定义
   （type/capabilities/zoneId/role/binding + 当前 initialState 作种子）。
2. `restoreWorldState` 在应用状态前先实例化这些定义（走与启动装配相同的
   deviceFactory 路径），再进既有的 deviceRestores 流程。
3. 向后兼容：旧 checkpoint 无该字段行为不变；恢复侧警告保留（防真删除漂移）。

**R42-C 修正（复现后根因再下移一层）**：最小复现（starter-home→建 sim→catalog
装格力空调→what-if 点名它）证明普通 sim 的活快照**根本不含**新设备（snap 3 台
无新机）——普通 sim 是设计上的冻结快照，env 级行根本没进运行时；此前"导出丢
设备"的 world-state 设计修的是更下一层（世界会话/已含设备的运行时）。三道门
的实测演化：①解析面不识设备（400 unknown）→ 已修（mergeEnvDeviceViews 合并
env 行设备进解析视图）；②fork 场景缺设备 → 已修（whatIfScenarioOf 用
environmentToScenario 补齐缺失定义，携带 catalog 物理初值）；③设备 lane
"agent 不管理该设备"——运行时绑定冻结所致，**保留为教学性拒绝**（诚实）。
**R43-C 裁定（设计作废归档）**：链路核查证明架构已正确处理——catalog
instantiate 记账 kind=`env-direct-edit` ∈ WORLD_MUTATION_KINDS → 变更漏斗触发
onWorldMutation → 世界会话从 env 当前行重建拓扑（scenarioOfEnv 天然含新设备）
→ 沙盒 checkpoint fork 因此可见新设备。普通 sim 的冻结语义由 what-if 三道门
修复（R42-C）覆盖。**原"导出信封带 deviceDefinitions + restore 实例化"设计
不再需要**，归档；world-state.ts 的 "no longer exists" 警告保留为真删除漂移
的诚实信号。
**根治方向（架构级，待立项）**：对 env 演化世界的 what-if 应路由到**世界会话
的当前世界**（scenarioOfEnv 每次重建，天然含新设备），而非冻结普通 sim；
或 world-session 的 onWorldMutation 语义扩展到普通 sim 的 what-if 请求时。
**R81-D4 已实施（plan-r81 Wave D，2026-09-04）**：what-if 端点的 fork 源
重路由到权威世界会话的当前状态——活会话一次暂停+导出
（`exportLiveSessionWorld`），休眠会话读其 checkpoint（拓扑取 env 当前行，
同 wakeHibernated 规则）；无会话/会话读取失败回退 agent 自身（冻结）sim，
并在响应 `forkSource: {kind, simulationId}` 中诚实标注
（`world-session` | `simulation`）。沙箱 fork 的 what-if 不受影响（测 fork
自己的世界）。实现：`whatIfForkSourceOf`（apps/server/src/routes/agent-nl.ts）；
验收钉：agent-what-if-world-session.vitest.test.ts（活会话新设备非零 delta +
锚定世界此刻、无会话回退、休眠 checkpoint 三钉）。
4. 验收：catalog 设备上跑 what-if 出现非零 delta；休眠恢复后设备计数一致；
   R40-A5 的零 delta 降置信（已上线）继续兜底未知残案。

### D2-F5 [P2] 升级通道（A3）工作但标定偏保守：普通温控命令触发 owner 升级通知

复现（同 D2-F2 第二条）：normal 优先级的调温命令 → decision=escalate → owner
收到 `agent.escalated` 通知（文案本身很好："只通知，未执行"）。问题在标定：
若每个常规命令都可能升级，owner 通知箱会被噪声淹没，升级通道的教育价值被稀释。
修复方向：NL 命令 lane 的决策提示词中把"用户显式指令 + 能力覆盖内"标记为
handle_independently 倾向；或升级通知按 severity 分级聚合。

> **已修复核实（R84，2026-09-04）**：定位确认标定已在此前落地——NL 决策
> 提示词 CALIBRATION 行（4a75754：显式指令 + 能力覆盖内 =
> handle_independently 倾向）+ 确定性 override 扩到 escalate（c904f1d
> R46-P0-4c：规则已映射出自有设备动作时，LLM 的 escalate 被改写为
> handle_independently 并执行）；且 NL 通道的 owner 通知仅 emergency 意图
> 触发（agent-nl.ts `escalateToOwner` 条件 `intent.action === 'emergency'`），
> 普通调温命令无法到达通知箱。**固化指针**：agent-nl.vitest 新增反例钉
> （非 owner 成员发普通调温命令 → 200 + owner 通知箱零 agent.escalated，
> 同文件 emergency 阳性对照不变）；nl-orchestrator.vitest R84 组钉住
> 「LLM escalate + 集合/普通命令 → deterministic override 执行」。

### D2-F6 [P3] dist-staleness 自检误报（turbo 增量构建只重写变更文件）

复现：src/routes/simulations.ts mtime 11:53、dist/routes/simulations.js mtime
12:22（构建更新），但 dist/index.js 仍是 05:49 → server 启动打印 "dist is older
than src — STALE build"。`dist-freshness.ts` 只对比 dist/index.js 单文件 mtime，
增量构建不重写未变文件 → 误报。修复方向：取 dist 树内最新 mtime 做比较。

### D2-F7 [P3] GET /api/environments 未知 query 静默忽略，新用户看不到公共画廊

复现：新注册用户 `GET /api/environments` → `[]`；`?visibility=public`、
`?mine=1` 均静默吞掉（200 空列表）；正确参数是 `?filter=all`（文档在 openapi）。
同仓库 activity 端点对未知 query 严格 400——同一约定两种执行。影响：多利益相关者
剧本第一步（发现画廊）就卡住。修复方向：对未知 query 400（带教学信息），或空
"mine" 结果时附 hint 指向 filter=all。

### D2-F8 [P3] 模板导入把全部设备所有权归导入者，builder 复用模板设备即被拒

复现：owner 导入 suzhou-city 后 33 个模板设备 owner 全为 owner；facility 绑定
其中电表创建 agent → 提案被规则检查拒绝："device … is owned by another user —
agents may only bind their author"（教学错误本身质量好）。多利益相关者剧本要
复用模板设备时只能各自从 catalog 重新放置（我们即如此绕过）。修复方向：导入
选项或提案 kind 支持"设备所有权移交/共享"；或模板自带 per-agent 设备归属建议。

### D2-F9 [P3] adopt-config 中等风险在 AI allow 后无 owner 介入即应用

复现：security 提交 adopt-config（sourceFork 溯源 + flow-definition 工件，
riskLevel medium）→ aiReview allow → 直接 `applied`（新 flow 进入权威世界），
owner 无通知无决策点。design-living-worlds §11 称晋升是"一次显式的治理行为"。
当前与普通 low/medium 提案同语义（AI 放行即自动应用）。修复方向：adopt-config
强制 escalate（或提供环境级开关），让"权威晋升"与设计语义一致。

### 正面记录（本轮验证通过、无需修复）

- 设备私有边界（绑定他人设备被规则检查拒绝）、协议 terms 的封闭 schema 教学
  400、condition flow 创建时的非标准参数 lint 警告（非阻塞且事后仍正确触发）。
- `agent.escalated` 通知：中文、带事件上下文/severity/confidence、"只通知，未执行"
  的安全语义明示。
- R40-C1 写入后快照点：注入 power-overload 当场触发 condition flow（run 记录带
  evaluatedValue:true），fork 内未触发是因为 checkpoint 已携带 true（边沿语义正确）。
- R40-A5 熔断：死 LLM 端口下首个事件 581ms 后续 32-41ms，决策标注
  `rule.llm_down`（14/20），无 10-20s 卡顿。

## R41-A1（2026-08-28）：campus-collab 协作压力场多利益相关者实测

> 场景：`校园（协作压力档·21 智能体服务网格）`（campus-collab）私有导入
> （132 zone / 156 设备 / 21 agent / **631 派生服务** / 14 事件 / 2 flow），
> 5 persona（校长-owner / 设施 / 能源 / 安防 / 后勤）。仿真以 speed=60
> 事件粒度步进跑满 14 条事件（28860-180000 sim-s，墙钟 24.6 min）。探针：
> `data/devloop/tmp/a1/*.mjs`（副本 DB `a1-collab.db`，server :8186）。
> 度量与判定见 [devloop-r41-a1-report.md](devloop-r41-a1-report.md)。

### R41-F1 [P1] 场景事件携带物理层未知参数（wind/status）→ 24 万条 WARN 日志洪泛

复现：campus-collab 仿真步进越过 `collab-storm-warning`（parameter `wind`）
与 `collab-hvac-fault`（parameter `status`）后，server.log 单次 25 min 运行累计
**242,222 条 `Unknown parameter: wind, using default` + 2,230 条 `Unknown
parameter: status, using default`**（314k 行 / 31MB，占日志 99%）。物理引擎对
未知 zone 参数每次求值都告警且无抑制（对比 "No history for …" 有 further
occurrences suppressed）。影响：日志 I/O 与可观测性（真实 WARN 被淹没）、
大档位长时间运行的磁盘膨胀。修复方向：未知参数告警按 (zone,parameter) 去重
抑制；或场景导入时校验事件 parameter ∈ 物理参数表并拒绝/降级。

### R41-F2 [P1] 21-agent 档 LLM 吞吐天花板：120s 超时 ×2 重试后熔断，事件决策链最长达 218s

复现（历史环境，ollama 已移除 R44-B）：单 ollama（qwen3-14b-q4）+ 平台 LLM 队列 `maxConcurrent: 3`（health
端点 llmQueue）。全 14 事件运行中：队列深度高水位 6、累计排队 37 次、
avgWait 35.5s、maxWait 86.9s；`collab-weekend-sweep` / `collab-hvac-fault` 的
LLM 调用 **request timed out after 120000ms ×2 attempts** → 3 条 llm-failure
记录 + 1 条 `rule-llm-down` 降级决策（defer），合计 4/29 ≈ 14% LLM 路径调用
失败/降级。溢出后果：熔断器打开（circuit-open, 74s 探针周期），此后所有 NL
command 的意图解析全部走 rules-llm-down 快速失败。事件注入→全部决策完成的
墙钟中位数 ~65s、最大 218s（hvac-fault，含降级链）。这不是故障而是本轮的
测量对象——结论：21-agent 档在单 14B 模型上已饱和，A2 需分层决策（楼层管家
走 triage 小模型）或提高队列并发。

### R41-F3 [P2] AC 伙伴匹配只看能力阈值、不看服务目录——631 服务网格不参与 accept/reject

复现：`collab-lib-humid` 中校园空气质量管理处 initiate_ac 后广播提案给 5 个
楼层管家，全部被拒，理由一律是 `Capability-based rejection (broadcast): only
1/3 matched (threshold 0.5) (cooling); missing: humidity-control, ventilation`；
accept 侧同理（`Capability-based acceptance (broadcast): 2/2 matched`）。
全程 22 条 collaboration-response 中 accept/reject 判定均为能力匹配文案，
**无一条引用服务目录**（631 条派生服务只进入 LLM 提示的 partnerServices 上下文，
不进入确定性应答路径）。即"密集服务网格"扩大了发起方可见的伙伴面，但握手
成败仍由能力列表决定——服务语义（semanticType/接口）没有成为协作面。
修复方向：广播匹配把 partner 的 published 服务（semanticType）纳入打分，
或在 preCheck 前做服务目录检索。

### R41-F4 [P2] sandbox fork 的 env 字段指向父环境——"在 fork 里建 flow"实际写入权威世界

复现：`POST /api/environments/:id/sandboxes {fromCheckpoint:true}` 201，响应
的 `forkEnvironmentId` 即父 envId（fork 是一个 `sim-*-fork-*` 仿真，不是独立
env）。随后 `POST /api/environments/{forkEnvironmentId}/flows` 创建"fork 候选"
flow → **直接落在父环境 flow 列表**。再走 adopt-config 晋升后同名 flow 出现两份
（adopt 应用不做同名/同语义去重检测）。影响：多利益相关者在沙箱里的"试验"
会污染权威世界，且晋升产生重复工件。修复方向：fork 响应显式区分
`parentEnvironmentId` / `forkSimulationId` 并在教学文案中标明"flow/服务写操作
直接作用于父环境"；adopt-config 应用前做同名工件检测。

### R41-F5 [P2] 协议 consumerAgent 必须本人持有——导入模板的 21 个 agent 全归导入者，4/5 persona 无法以自己中心的名义发起协议

复现：energy persona（builder）对楼层管家服务 `POST /api/services/:id/agreements
{consumerAgentId: <校园能源调度中心>}` → 403 `"The consumer agent of an
agreement must be an agent you own"`。模板导入把 21 个 agent 的所有权全部归
导入者（owner），因此校长以外任何 persona 以"能源调度中心/安防巡更队"名义
发起协议都被拒，只能 owner 代理发起（实测代理路径 201→active 正常）或 persona
自建 agent。与 D2-F8（设备所有权同模式）同根：模板导入缺少 per-agent 归属
建议/移交选项。影响：多利益相关者协议剧本在模板舞台上不可直接扮演。

### R41-F6 [P3] NL what-if 不支持群体干预表述；NL 意图解析 LLM 预算 12s 对 14B 模型过紧

复现（sim `sim-5921d6f1-…-mtdbobuh-1`）：能源中心 what-if "如果晚高峰把教学楼
全部空调设定温度调高2度…" → 400 "could not map it onto an intervention"，
提示只列 3 个设备 UUID（群体/别名表述无法映射，需逐设备点名）；改单设备
英文表述后 200（1.2s，走确定性预测器，质量良好）。command 侧意图解析 LLM
预算 12s（caller AbortSignal）在 qwen3-14b 负载下全部超时回落 rules-llm-down
（`打开宿舍3层走廊的全部照明用于演练` 解析为 set_parameter 而非照明指令组）。
另：ask "温度和CO2情况" 被规则解析器把"2"当参数值（`parameter "temperature 2"
clamped to 5`）。修复方向：what-if 支持按 zone/capability 的组目标表述；
意图解析预算随模型档位配置；规则解析器数字抽取加边界。

### 正面记录（本轮验证通过、无需修复）

- **导入规模**：631 服务/21 agent/156 设备模板导入 + 仿真创建 + 14 事件全链路
  无一 5xx；fork 内服务目录查询 631 条 60ms 返回。
- **治理闭环**：后勤 install-devices 提案（low risk）自动 applied、设备落位、
  owner 收到 `proposal.auto_applied` 通知；adopt-config（medium risk）**escalate
  到 owner**（D2-F9 的改进已生效）→ approved → flow 进入权威世界。
- **AC 会话内服务消费**：3 个完成的 service-composition 会话各生成一条真实的
  服务协议（发起方作为 consumer，会话结束 terminated）——自治协作确实经过了
  服务层，只是生命周期是会话级的。
- 订阅通道：energy persona 跨 owner 订阅 3 条楼层管家服务全部 201。
- 效果回检（effectChecks）0/6 通过是数据点而非故障：温度类协作的效果窗口内
  未见回落，需 A2 结合执行链细查。

---

## R44（2026-08-29）：深圳韧性城市首跑 —— 103 agent / 1,279 服务城市档实测

> 场景：`深圳韧性城市（大规模档·城市级服务网格）`（resilience-city-standard）
> 私有导入（6 区 / 362 设备 / 103 agent：96 v5 设施+区管家 + 7 qwen3-14b-q4
> 市级职能中心 / **1,279 派生服务** / 12 条台风链式事件）。speed=60 事件粒度
> 步进跑满 12 条（3,600→32,405 sim-s，墙钟 473s）。DB 副本
> `data/devloop/tmp/r44city/`、server :8176、基于 `eede3e1` 的干净 worktree
> 构建（主树当时有并行会话的未完成编辑）。探针：`data/devloop/tmp/r44city/*.mjs`。
> 四节度量与规模对比表见 [devloop-r44-city-report.md](devloop-r44-city-report.md)。

### R44-F1 [P1] 城市档 LLM 吞吐天花板：全局并发 3 + 单实例 ollama（历史后端，已移除），avgWait 10s / maxWait 41s

复现：任意宝安区事件（16 v5 + 7×14B 同时决策）步进期间 `/api/health.llmQueue`
深度峰值 24、268 次入队、avgWaitMs 10,042、maxWaitMs 40,573。分道时延
v5 p50 6.33s / 14B p50 27.3s，而**无争用生成**分别是 ~0.99s / ~13.5s（本次
轨迹 min 列）——膨胀几乎全是排队。v5 的 1s 级调用与 14B 的 30s 级调用挤同
一条 `LLM_MAX_CONCURRENT=3` 队列（`packages/llm-integration/src/client.ts`
全局 RequestQueue）。单事件决策完成 p50 45s / max 60s，演示节奏尚可，但
193-agent 超大档（resilience-city-dense，同 repo 已就位）会线性恶化。
**修复方向**：v5/14B 分道队列（短调用不被长调用 head-of-line 阻塞）；
并发随 agent 数缩放或自适应；历史方案——ollama `num_parallel`/双实例（已移除，改 vLLM 连续批处理）。

### R44-F2 [P1] NL what-if 城市档退化：能力粒度表述无 LLM 兜底 + teach-back 只列 UUID + 同名设备跨区静默解析

> **部分修复（R83-F1，2026-09-03）**：what-if 路径的中文调温映射、teach-back
> 裸 UUID（改设备名）、英文文案本地化已修并实测（predictor 47/47、
> agent-what-if 13/13）；能力粒度组目标表述、LLM 兜底、跨区同名消歧为
> 其他路径，待查。
>
> **部分修复·第二批（R84，2026-09-04）**：①群体/集合表述——NL 命令通道
> 支持集合目标：`packages/core/src/nl/command-parser.ts` 新增
> `expandCollectiveTarget`（全部/所有/all 标记 + 能力类别词表 + zone 限定
> （「我区/本区/全区」→ managed zones）∩ 能力过滤展开为设备集，上限
> `COLLECTIVE_MAX_DEVICES=32`，溢出进 rejected 教学而非静默截断）；展开为
> 权威集——模糊片段匹配与 LLM 道的同名过度扩张都被确定性收缩，跨区设备
> 不再混入。零命中（区内无该类别设备）给中文教学（按设备名列可操作面），
> 不再「正在持续观察局势」式静默。②teach-back 裸 UUID 残余两处：emergency
> 升级通知标题/summary 的 agentId 改 agent 名（agent-nl.ts
> `escalateToOwner`）；invoke-lane 409 SERVICE_NOT_BACKED 的 backing
> device 改设备名（usage 台账保留精确 id 作机器通道）。MR4 红线扫描扩至
> ask 404 / what-if rename-trap / emergency 回复 / 集合教学文案。
> **固化指针**：nl-orchestrator.vitest +6（R84 组）、command-parser 全量
> 111 绿、nl-metamorphic.vitest +MR6 两例（13/13）、agent-nl.vitest 16/16、
> agreements.vitest C4-(d)。**遗留**：what-if 通道的群体表述（多设备干预
> 结构）仍不支持；同名设备跨区消歧为 R49/R76-F4 既有战线。


复现（`nl.mjs` + 结果 `nl-results.json`）：①"把全市应急照明全部打开""把我区
全部排水阀打开"等能力粒度表述 → 400 "could not map it onto an intervention"
（6-32ms，`packages/core/src/cognition/predictor.ts` 确定性解析，**不走 LLM
兜底**）；点名设备（"避难所空调 1 关闭 60 分钟"）→ 200/1.4s 质量良好。
②该 400 的 teach-back 列出 `deviceId(capability/…)` **不含设备名**——区管家
一档要吐 50+ 个裸 UUID，城市档完全不可读。③设备名跨区不唯一（"应急照明 1"
全市 ×13，"避难所空调 1" ×13…）：福田CBD 区管家问"应急照明 1 打开"被
静默解析到**宝安**的同名设备，指标落在 bao-an 区——跨区设备错绑用户无感知。
**修复方向**：解析失败回落 14B 意图解析（预算与 command 通道分开）；teach-back
渲染 `名称(区)`；同名命中 >1 返回候选消歧；支持 capability/zone 组目标表述
（R41-F6 的城市档重申+升级）。

### R44-F3 [P2] 市级职能中心在 AC funnel 中饿死：39 次 initiate_ac 零次主导、仅 1 次应答

复现：7 个 14B 市级中心产生 39 次 initiate_ac 决策（占市级决策 93%），但
`InitiatorCoordinator`（先到先得，60s 冷却）全部判负——12 条协作的主发起人
**清一色 v5 设施管家**（应急避难所 3 独中 3 条）；市级中心仅以应答方出现 1 次
（雨水泵站 1 → 市电网调度中心，accept）。模板设计意图"市级中心分层协调"
在协作拓扑上未成立：14B 的角色退化为本区事件的第 17-23 个评估者（占该档
14B 时延预算的绝大多数）。**修复方向**：认领按角色加权（city-wide 事件
市级中心优先），或按事件严重度路由主发起权；给"中心"一个显式的
escalation-bus 而非共享广播。

### R44-F4 [P3] 轨迹遥测两处不一致：应答记录 eventId 为合成 UUID；应答 LLM 调用不记 model/durationMs

复现：63 条 collaboration-response 中 17 条（罗湖伤亡/盐田疏散/龙岗交通 3 个
事件的全部应答）eventId 是 `e6196969-…` 式合成 UUID 而非场景事件
id——按 eventId 归因会把这些会话记成 0 应答（本次 runner 的 settle-poll 即
被此误导）。同因，26 条走 LLM 的应答不携带 model/durationMs，分道时延账目
缺应答侧一半。**修复方向**：广播派生事件回填源 eventId；应答轨迹补记
model/durationMs（与 assessment 对齐）。

### 正面记录（本轮验证通过、无需修复）

- **导入与目录**：103 agent/362 设备/1,279 服务模板导入 244ms，无 5xx；全列表
  86ms（1.33MB）、过滤 4-32ms、中文 `q=排水` 174 行 18-50ms——目录翻倍不劣化。
- **F3 服务面亚线性**：发起方候选面稳定 ~360 行、应答方只带自有面（4-53 行），
  评估 promptTokens p50 2,375 反而低于 campus 的 3,028；无超长/超时/截断。
- **决策与协作质量**：234/234 决策 100% 准确、0 llm-failure、0 降级；握手
  12/12、协作 12 完成 0 失败、AC 服务协议 39 份、effectChecks 75%（campus 0%）。
- **跨区协作真实发生**：46/57（81%）发起-应答对跨区，6 区全连通，台风链
  （宝安内涝→南山停电→福田疏散）在协作图上可见。
- 升级通道 84% 触发但 owner 通知按事件去重为 12 条，无洪泛；197 条 escalated
  initiate_ac 全部按 R43-A 语义放行 AC。

### R44-dense-F1 [P1] fast-lane 并发 6 成为 193-agent 档第一瓶颈——引擎侧零排队、平台侧自限（R44-F1 第二阶段）

复现（`vllm-samples.jsonl` + `throughput.json`）：dense 档 12 事件 428 次
vLLM 调用，`/metrics` 连续采样 **max num_requests_waiting = 0**（引擎从未
排队）、max running = 6（正好等于 fast-lane 上限）；直连 96 并发决策形载荷
p50 仍 1.0s / 89.5 req/s / 7.2k tok/s。而平台侧 v5 决策 p50 3.17s
（std 档 2.01s）、单事件 31-38 路齐发挤 6 槽、批内 spread 4.3-6.4s、
单事件 hop p50 13.5s、全剧本 230.4s。**瓶颈从引擎彻底移到 fast-lane 槽位**。
**修复方向**：`LLM_FAST_LANE_CONCURRENT` 随档位缩放（dense 已验证引擎可吃
16-32 并发）；或按队列深度自适应。

### R44-dense-F2 [P1] 193-agent 档协作 funnel 首次失灵：354 发起 → 81 应答 → 15 协议，2/12 握手卡 pending

复现（`eval-report.json` + `collaborations.json`）：握手 12 发起 / 10 成功 /
2 失败（83.3%）——三档首个握手失败档位。两条失败（罗湖 mass-casualty 检测
能力协作、南山 UPS 备电协作）各带 5 个候选 partner，窗口内无一 accept，
status 停在 pending。发起 354 次仅 81 次得到应答（23%）：候选 partner 选择
或应答 deadline 在高密度下命中率下降。**修复方向**：partner 候选按相关度
（而非仅半径）排序并保证至少一个高优先候选；pending 协作给超时重派或降级
close，避免握手率随规模漂移。

### R44-dense-F3 [P2] what-if fork 时延超线性：世界 ×2 → 交互时延 ×5.5（1.3s → 7.5-8.9s）

复现（`nl-results.json`）：同名探针在 std 档 1.3-1.4s / 200；dense 档
7.66s / 7.47s / 8.88s（复测 2.84s，方差大）。agent ×1.87、设备 ×2、
服务 ×1.93，而 fork 预测时延 ×5.5+——预测器全量 fork 世界快照的成本
超线性。**修复方向**：fork 按干预的受影响半径裁剪（只仿真受影响区/设备
邻域）；或缓存世界快照增量。另：R44-F2-③ 同名设备跨区静默解析在 dense
恶化（6 区 ×5 同编号设施，福田区管家问"应急照明 1"落到宝安设备），
teach-back 裸 UUID 问题不变。

### R44-dense-F4 [P3] 遥测三缺口在 dense 全部恶化（§R44-F4 同族扩大）

复现：①`/api/health.llmQueue` 只报全局道——dense 全程 v5 走 fast-lane，
全局道零入队（waitCount 全程不动），fast-lane 的 active/queued/wait 完全
不可观测；②81 条应答 0 条带 model/durationMs；③40/81（49%，std 档 27%）
应答 eventId 为合成 UUID，按事件归因漏计面扩大。**修复方向**：health
暴露 fast-lane 队列统计；应答轨迹补 model/durationMs 与真实发起人 id
（`providerAgentId` 本轮 81/81 全部自指，配对统计只能走 collaborations
口径）。

### R44-dense 正面记录

- **导入线性**：193 agent / 722 设备 / 2,465 服务私有导入 1,122ms（无 5xx）；
  任务书预估 30-60s 未发生。目录查询 66-101ms（×1.93 规模不劣化）。
- **决策质量满血**：403/403 准确、0 llm-failure、0 降级——统一 v5 后
  std 档 14B 404 的 83.3% 欠账清零；市级中心恢复 28 次 initiate_ac 发起面。
- **prompt 亚线性再验证**：2,465 服务下评估 promptTokens p50 2,283 与
  std 档持平（区半径裁剪生效），无截断/超时。
- **跨区协作拓扑保持**：9/12 去重协作跨多区（最大跨 5 区的疏散链）；
  accept 逐调用率与 std 档持平（LLM 10.8% vs 8.8%）。
- GPU 侧健康：VRAM 全程平坦（+110MiB）、util 峰 98% 均值 26%、
  kvCache 峰 3%——单卡 32GB 对 193-agent 城市网格余量充足。

### R44-extreme-F1 [P1] 区管家提案评估 prompt 突破 vLLM 8192 上下文——extreme 档首个硬断裂点，被能力兜底接住

复现（`server.log` + `trajectory-full.json` 8 条 llm-failure）：区管家
（75 设施/区）的协作提案评估 prompt 渲染全区 75 台设备清单 → 输入
≥7,693 tok + 500 预留输出 > `max_model_len` 8,192 → **400 "This model's
maximum context length is 8192 tokens"**。8 条失败轨迹：event1 宝安区
管家、mega-shelter-open **6 条（六区区管家同批全灭）**、event10 宝安。
每次 CollaborationProposalHandler 落能力兜底（'fallback' 通道 23/180 =
8 次 400 + 15 次 JSON 解析失败）。注意断点不在服务目录：决策道
promptTokens p50 2,334 三档持平（目录亚线性成立），断在**agent 绑定
设备数随档位线性放大**的设备清单渲染。**修复方向**：提案评估 prompt
对设备清单做能力聚合/预算裁剪（评估只需"我有什么能力"，不需要 75 台
设备逐行）；或按 max_model_len 自适应压缩；或区管家一档只带zone级
设备+能力摘要。

### R44-extreme-F2 [P2] 轨迹 API 500 条 cap 首次不够用：全量视图截断 + cap 参数不透传 + 合成 eventId 漏计 57%

复现（`trajectory-full.json` 重建过程）：单跑 1,128 条记录（940 决策 +
180 应答 + 8 失败），`GET /api/simulations/:id/trajectory` 无过滤路径返回
**最新 500 条**（`TRAJECTORY_RECORD_CAP` 硬编码，路由层不透传 `cap`
查询参数——store 层 `readTrajectoryDirRecords` 明明支持）；按 eventId
过滤路径又会漏掉 **102/180（57%，dense 49%、std 27%）携带合成 UUID
eventId 的应答**（事件口径只见 78/180）。极端档是首个"全量轨迹视图
不完整"的档位，事件归因与事后审计双失真。本次分析被迫改读磁盘原始
日志（segment-000001.jsonl）。**修复方向**：路由层透传 cap（或按
total-count 提示截断）；应答记录 eventId 落真实场景事件 id（§R44-F4
原始缺陷）。

### R44-extreme-F3 [P3] 应答遥测三缺口在 extreme 全量失真：0/180 带 model/durationMs、providerAgentId 180/180 自指

复现（density2 分析）：180 条应答 0 条带 model/durationMs（分道时延
账目在协作面完全缺失）；`providerAgentId` 恒等于应答方自身 → 去重
无向协作边 = 0（std 46 对、dense 0/46 可用后彻底 0/180）——跨区应答
拓扑只能走 collaborations 数据口径（本轮 11/12 握手跨区由
initiator/participants 得出）。与 R44-F4/R44-dense-F4 同族第三档恶化，
"只测不修"三连。**修复方向**：应答轨迹补 model/durationMs 与真实
发起人 id（提案 payload 里有，写入轨迹即可）。

### R44-extreme-F4 [P3] effectChecks 三档连降：75% → 61.8% → 43.8%，与协议数 12× 放大背离

复现（`eval-report.json`）：协议 15→180（×12）而效果回检通过率
10.5/24 = 43.8%（dense 10.5/17 = 61.8%、std 75%）。极端档 91.7% 的
accept 由确定性能力规则拍板（rule 142 + fallback 23），LLM 深思参与
的协议从 74/81（dense 91%）缩到 15/180（8.3%）——"确定性 accept 的
协议"在效果窗口内的可验证率显著更低。**修复方向**：effectChecks
分通道统计（rule/fallback/llm 协议的通过率分开看）；或对 rule-accept
协议定义更贴能力语义的回检指标。

### R44-extreme-F5 [P3] fast-lane 16 槽首次触及引擎排队边界 + 协作 funnel 成为墙钟主体（观测记录）

复现（`vllm-samples.jsonl` + `throughput.json`）：max running = 16
（= 槽上限）、**max waiting = 11**（四档首次非零；决策波满载时提案
评估突发到达）；决策 p50 4.37s = 76-83 路挤 16 槽的 ~5 波排队
（min 1.34s 无争用）。直连 128 并发 p50 1,309ms / 94.8 req/s——引擎
余量仍大，32 槽可整批吃下。另：全剧本 487s 中 vLLM 聚合忙时仅
~81s（999 请求 × 1.31s ÷ 16），hop p50 40.2s 的主体是 funnel 编排
（广播/评估/去重/回检）——**下一档优化目标是协调面批处理而非 LLM**。
（与 R44-dense-F1 的差别：槽位已非第一瓶颈，仅排队波形可见。）

### R44-extreme 正面记录

- **导入亚线性三连**：463 agent / 1,801 设备 / 6,005 服务导入 1,528ms
  （dense ×2.4 agent 仅耗时 ×1.37）；目录 6,005 行全列表 455ms、过滤
  49-127ms——四档无劣化。
- **决策道满血**：940/940 准确、决策道 0 失败、completionTokens p50
  231 无截断；升级率 87.6%（823/940）通知不洪泛。
- **funnel 修复规模成立**：握手 12/12、0 pending（dense 修前 10/12）；
  扇出广播 15 partner/握手，180 应答 180 accept 180 协议；跨区 11/12
  去重握手（最大单协作跨 7 区——盐田疏散横贯全市）；LLM 逐调用
  accept 9.6% 与前三档（7.7-10.8%）持平——v5 应答语义未漂移。
- **what-if 半径裁剪线性扩展**：1,801 设备下 fork 302/1,801、
  1.15-1.24s（dense 修后 0.46s @ 121/722）——时延随受影响半径线性、
  随全世界规模解耦；外推不裁剪需 7-10s。
- **引擎与内存余量**：128 直连 p50 1.3s / 94.8 req/s / 7.6k tok/s、
  kvCache 8.1%、VRAM +31MiB 平坦；Node WS 稳态 ~630MiB——463 agent
  档平台与引擎都不是容量约束。

## R45（2026-09-01）：实机冒烟测试（REST + CLI 通道，LLM 未配置）

> 方法：全量 build 后以临时 DB（`data/smoke-2026-09-01.db`）起独立实例 :8180，
> 系统性探测 REST 端点 + `eaf --json` CLI；双账号（owner + 非成员）权限差分；
> `npm test`（turbo 全量）。LLM 后端（LLM_BASE_URL/LLM_MODEL）未配置，
> rule-only 降级链路本身作为测试对象。测试产物（仿真/环境/分享链接）均为
> 临时库数据，未触碰既有 data/*.db。

### S1 [P2] `POST /api/simulations/:id/step` 未知 body 字段静默忽略——`{"ticks":100}` 只推进 1 tick

复现：建仿真 → pause → `POST /step {"ticks":100}` → 200，但 simTimeSec 只 +1
（路由只认 `n`/`toSimTimeSec`，`body.n ?? 1`，未知字段无任何校验）；
`{"n":10,"bogus":1}` 同样静默接受。用户按直觉写 `ticks` 会得到"成功但没动"
的结果，running 状态下返回的 simTimeSec 还会被自由运行掩盖，几乎无法自查。
与平台自身约定直接冲突：POST /api/environments 未知 query、
GET /api/environments 非 filter 参数（D2-F7）、eval-runs/training-export
都是响亮 400 教学——step 是漏网的一致性问题。修复方向：step body 加
unknown-field 400（列出接受的 `n`/`toSimTimeSec`），与现有教学文案同款。

### S2 [P3] resilience-city 五档模板中文名完全相同——模板列表无法区分档位

复现：`GET /api/scenario-templates`（或 CLI `eaf scenario-templates list`）：
`resilience-city-standard/-extreme/-insane/-titanic/-colossal` 五档的
`meta.name.zh` 全是「深圳韧性城市（大规模档·城市级服务网格）」，只有
`resilience-city-dense` 是「超大档」；英文 name 反而每档不同
（"standard tier"/"extreme tier"…）。中文用户在模板列表/创建对话框里
看到五个同名条目，只能靠 id 猜档位。修复方向：五档 zh 名补档位词
（与 en 对齐），或模板 API 增 tier 字段。

### S3 [P3] 设备命令成功响应仍是双层 `success/result` 包装

复现：`POST /api/simulations/:id/commands` 成功 →
`{"success":true,"result":{"success":true,"result":{...,"executionTime":1}}}`。
Fix-1 只把失败路径统一为单层 `{success:false,error}`，成功路径保留双层
嵌套，程序化调用要剥两层皮、成败路径结构不对称。修复方向：成功响应
拍平为单层（或契约里明确双层语义并给 CLI/SDK 统一解包）。

### S4 [P3] 端口占用时先完成全部 seed 再 listen 失败

复现：8100 已被占用时启动第二个实例：日志显示 blueprint/catalog/模板环境
seed 全部执行完（写 DB），最后才 `Failed to start server: EADDRINUSE`
+ 裸 node stack。seed 实测幂等（重复启动无重复数据），所以无实际破坏，
但"先写库后绑端口"的顺序让失败实例白做一遍 seed，且报错不够友好。
修复方向：listen 前置或 EADDRINUSE 特判为一行用户向提示
（"port 8100 already in use — set PORT"）。

### 正面记录（本轮验证通过、无需修复）

- **dist 自检与构建**：`npm run build` 7/7 成功；server 启动无 STALE 警告。
- **LLM 未配置降级显式化全链路**：启动日志明确 "RULE-ONLY until it is set"；
  `POST /api/simulations` 201 带 `llmWarning`；CLI `sim create` stderr 打
  warning 且 `--json` stdout 不受污染。
- **rule-only 决策链路端到端**：注入 38°C 温度事件 → trajectory 记录
  `handle_independently (rule)` → 客厅空调 power=true/mode=cooling/
  target=24 → step 300 后室温 38→30.2°C 持续回落（P1-1/P1-3 不复发）。
- **物理初始化**：t=0 快照 smoke=0、co2 无幻影漂移（P1-7 不复发）；
  zone baseline 与 parameters 并存。观察：未声明 occupancy 的 zone 快照
  为 `null`（living-room 为数值）——null=未声明 语义可接受，非 bug。
- **错误语义一致且带 escape hatch**：404 ENV/DEVICE_NOT_FOUND、405
  subscribe（"use PUT"）、403 文案含"join it or ask the owner"、422
  STEP_TOO_LARGE 带分块建议、400 未知 query/字段列合法值；
  CONTENT_LENGTH_MISMATCH（Git Bash 中文 body 怪癖）检测并给出
  `--data-binary @file` 指引。
- **环境发现**：GET /api/environments 默认 mine + 空列表 hint（"16 PUBLIC
  environment(s)… ?filter=all"）；filter=all 正常；未知 query 响亮 400。
- **回放分享全链路**：私有环境创建分享 403 ENV_NOT_PUBLIC（文案指引先转
  public）→ 转 public → 201 分享链接 → 匿名 GET /api/shares/:id 200；
  回放烘焙决策 5/zone 采样 117/设备状态 12 条事件（Fix-14 成立）。
- **跨用户权限差分**：非成员 PATCH 环境 403、非成员对 env 仿真下设备命令
  403（"requires membership"）、非创建者 stop 他人仿真 403。
- **CLI 通道**：`--json` 全通（auth/env list/scenario-templates/sim 全生命
  周期/device list 带 commands/service/flow/me）；未知子命令 exit 2 +
  教学文案；框架 init 日志走 stderr 不污染 stdout。
- **模板导入**：starter-home 模板 GET → POST /api/environments 201，
  3 zone/3 设备/1 Agent/10 派生服务/2 内嵌 Flow 全数落库。

### 因 LLM 后端未配置而无法验证

- LLM 决策质量与 decisionSource=llm 路径；AC 握手（initiate_ac→应答→门控）；
  提案 AI 审查（PROPOSAL_REVIEWER=auto 在无 LLM 时应走 escalate/超时兜底，
  未实测）；NL command/ask/what-if 的 LLM 意图解析（仅验证规则解析路径
  存在）；triage 小模型与 LLM 队列排队行为。

### 测试基线

- `npm test`（turbo，11 workspace）：8 成功；**web#test 报 1 失败**
  （`routes.test.tsx > redirects legacy ?env= share links`），但该用例
  单独重跑通过、web 全套件立即复跑 719/719 全绿——判定为 turbo 并发下
  的 flaky（时序/共享态），非回归。建议记录观察：若再现需查测试隔离。

## R46（2026-09-01）：系统性修复轮——S1–S4 已修 + CLI/前端 UX 深度优化

> 方法：五路并行修复（server/core、CLI、文档模板、前端深度 UX），全部经
> 自动化测试验证（core 2466 / server 1622 / cli 166 / web 722 全绿）。

### 冒烟发现的 S1–S4 全部已修（FIXED）

- **S1 FIXED**：`POST /api/simulations/:id/step` 未知 body 字段响亮 400
  （`routes/simulations.ts:834`，文案点名被拒字段与合法字段 `n`/`toSimTimeSec`），
  附回归测试。
- **S2 FIXED**：resilience-city 五档中文名按 tier 区分（改生成源头
  `scripts/generate-resilience-city.mjs` 并重新生成，标准/超大/极端/疯狂/泰坦/巨像档），
  `scenario validate` 全过。
- **S3 FIXED（breaking）**：设备命令成功响应拍平为单层——`body.result`
  直接是命令 payload，不再双层嵌套；失败信封与 202 pending 形状不变。
  openapi.yaml / CLI（`sim command`）/ Web 消费方已三通道同步。
- **S4 FIXED**：seed 延后到 listen 成功之后（`deferBootSeeds`），EADDRINUSE
  快速失败并给友好文案（指明端口与 `PORT=` 替代），失败实例不再白做 seed 写库。

### 同轮修复的其他问题

- **CLI trailing `--lang` bug**：`eaf env list --lang zh-CN` 曾抛 unknown
  option（stripGlobalFlags/GLOBAL_FLAGS 漏 lang），已修 + 回归测试；
  GENERAL_HELP 全局 flags 补 `--lang`。
- **CLI 帮助补齐**：`env session status`、`agreement hold/resume/read` 等
  已实现但未文档化的子命令补进 help；新增 `agreement get`、
  `agreement receipts`、`env eval-run status`、`device get`、`me quotas`
  五个命令；通知表格渲染 ×N 聚合；SIGINT 退出码对齐 130。
- **Flow 引擎**：schedule 触发器在 flowsProvider 抛错时静默漏触发的边角
  （lastTickSimSec 先推进后读 provider）已修；event 触发器 zone 收敛改为
  `trigger.zoneId ?? event.zoneId`（未声明 zoneId 时按事件 zone 收敛）。
- **server 工程债**：event-source poller interval 泄漏接入 onClose；
  rollupSweepTimer 补 clearInterval。
- **文档**：README 的 Ollama 段落全面改为 vLLM/OpenAI 兼容端点（R44-B
  后的正确方式），文档导览补 vision.md；flow-authoring.md 触发器表格
  结构修复 + zone 收敛语义澄清；认知架构文档补落地状态注记；roadmap
  文首补 R16–R70 指针；devloop 默认端口 8110→8100。
- **前端深度 UX**（详单见 git）：危险操作确认补齐（停止仿真/离开环境/
  设为公开/合约终止/世界休眠）；Flow 画布脏状态保护（未保存徽标 +
  切换前确认）；仿真控制台三层收敛（状态带 + 地图 + 折叠抽屉）；
  WorldSidebar 14 tab 改两级分组导航；Toast 分类（info/success/error +
  aria-live）；通知页 kind i18n + 相对时间；控制台错误升级 banner 带重试；
  共享 Loading 组件替换裸文本加载态；echarts 温度系列暖色（与 danger
  语义分离）；`?tab=` 深链补 sandboxes/externalChannel + rosterReport
  非 owner 防御；popover Esc/点击外部关闭；i18n 硬编码清理
  （severity/时间 locale/raw token 直出）。

---

## R76（2026-09-03）：愿景全链路验证（LLM 生产姿态）

> 方法：5 个 persona 经真实前端（Playwright 线束 persona-r76.mjs）走
> 建环境→放设备→Agent 向导→服务发布/订阅/合约/试用→NL 命令→Flow→部署 tab
> 全链路；decision.mode=llm（vLLM ac-decision-v5）。环境 a3d9dab6（public，
> 6 成员/17 设备/7 Agent/33 服务）。轮次笔记与留痕：
> data/devloop/r76-vision-chain/（NOTES.md、journeys/、findings.jsonl、shots/）。

### R76-F1 [P1] 会话登录态丢失（bootstrapAuth 吞 429）→ builder 的 Agent 向导能力芯片全部 ⚠ 静默卡死

> **已修复（Wave A / A1，2026-09-03）**：bootstrapAuth 对 429/5xx 按
> Retry-After 退避重试，仅 401 定性未登录（useAppStore.ts）；`/auth/me`
> 拆 session 限流桶默认 300/min（rate-limit.ts/config.ts，新 env
> `RATE_LIMIT_SESSION_PER_MIN`）；AgentWizard 在 user=null 时给教学提示
> 而非静默禁用按钮。测试：bootstrapAuth 5 例、rate-limit/config、向导
> 提示 2 例全绿。

复现：builder 登录后（cookie 有效）让 `GET /api/auth/me` 失败一次——自动化
场景下把 auth 限流桶打爆即可（`/api/auth/*` 全部端点共享 30 req/min，
`apps/server/src/rate-limit.ts:106-108`；并行注册 + 每次 API 断言重新登录 +
页面整载 bootstrap 很容易超限）→ 整页刷新进公开环境页：页头变「登录」但
REST/WS 走 cookie 一切照常（放设备、加入、侧栏计数都正常）→ 打开 Agent 向导：
全部能力芯片 ⚠ unbacked、「下一步」禁用，无任何提示。
根因链：`bootstrapAuth`（`apps/web/src/store/useAppStore.ts:353-362`）把
getMe 的任何失败（含 429）吞成 `user=null` 且 `authChecked=true`、永不重试；
`/environments/:envId` 未包 RequireAuth（`apps/web/src/App.tsx:251`）使
"匿名+cookie"半登录态可达；AgentWizard `viewerId=user?.id??''`
（`AgentWizard.tsx:60`）→ `bindableDevices` 空 → 芯片全 unbacked →
`stepError` 禁用下一步（`lib/agentWizard.ts:283/351`）。env owner 免疫
（`isEnvOwner` 来自 `world.myRole` REST 字段而非 store.user）。
修复方向：bootstrapAuth 对 429 按 Retry-After 退避重试（而非一次失败即判
登出）；向导检测到 `user=null` 时给教学提示（"会话状态丢失，请刷新"）而非
静默卡死；`/auth/me` 与 `/auth/login` 限流分桶（读态 bootstrap 不应与暴力
破解面共享配额）；考虑给 `/environments/:envId` 的匿名态加显眼标识。

### R76-F2 [P1] 空白环境 0 zone：名录放置死路且无引导

> **已修复（Wave A / A2，2026-09-03）**：调研发现服务端
> `POST /api/environments/:id/zones` 早已存在（owner 直建 / builder 自动转
> install-zones 提案，T-055）——死路纯 UI 缺口。CatalogPanel 加 0-zone
> 空态引导「创建第一个区域」内联表单；builder 提交转提案 + toast +
> rule-check 内联教学。测试：blank-env-zones 2 例 + catalogEmptyZones
> 4 例全绿。

复现：工作台「+ 新建环境」→「空白环境」tab 创建成功 → 进入环境 → 名录选
任意设备 → 放置 → 落位 zone 下拉 **0 项** → 确认后静默无效（设备不落库，
无 toast 无错误）。空白环境没有任何建 zone 的引导入口提示，新用户在此
卡死（本轮 organizer 两次实测均 blocked：`no-zone-options(0)-place-noop`）。
修复方向：空白环境创建后首访引导建第一个 zone（或直接随创建生成默认
zone）；名录放置在 0 zone 时禁用并给出"请先创建区域"的内联教学。

### R76-F3 [P2] NL 命令决策来源无 UI 标识

> **已修复（Wave A / A4，2026-09-03）**：聊天条目输入行加决策来源 chip
> （`intent.parseSource`：LLM / 规则 / 规则 · LLM 降级），降级态琥珀色 +
> tooltip 明示「行为可能与 LLM 不同」；i18n 双语。见
> `apps/web/src/components/AgentChatPanel.tsx` 与 test/agentChatPanel.test.tsx。

复现：本轮 6 条 NL 命令线上 parseSource 有 llm ×4 与 rules-llm-down ×2
（vLLM 短时降级规则兜底），但聊天条目没有任何"本条决策来自 LLM 还是规则"
的标识——用户无法区分，降级时以为 LLM 在工作。线束只能通过侦听
`/api/agents/:id/command` 响应体拿到真相。修复方向：聊天条目加决策来源
徽标（llm/rules/rules-llm-down），降级时额外提示。

### R76-F4 [P2] 同名设备 NL 误路由：指名自有设备命中他人同名设备，触发错误的所有权教学

> **已修复（Wave A / A4，2026-09-03）**：`bestNameFragmentMatches` 增加
> own-first 消歧（第五参 `ownDeviceIds`，同等匹配长度下自有候选排前，严格
> 更强的他人指名仍胜出——R78-A 混合场景测试保持绿）；教学 pass 的最强匹配
> 落在自有设备（Agent 面 ∪ 本轮已执行 ∪ 当前用户拥有）上时不再拼接所有权
> 教学。见 packages/core/src/nl/command-parser.ts、apps/server/src/
> nl-foreign-mention.ts 与两侧测试。

复现：环境中多人放了同款设备（林姐与阿May/小苏名下各有
「Aqara智能窗帘电机（开合帘版）」）。book/flower 在世界会话指名**自己**
的设备发命令，响应却是「属于 街区运营者林姐，不在我的管理范围内」——
同名匹配优先命中了他人的设备；coffee「打开格力空调（大1匹）」LLM 真实
执行成功（✓ temperature-control target 22）后，响应尾部仍混入对另一台
同名设备的矛盾教学。修复方向：NL 设备解析优先本人绑定设备（owner 加权）；
同名歧义时列出候选让 Agent 反问或按"我的设备优先"消歧；执行成功后不应
再拼接对其他同名设备的所有权教学。

### R76-F5 [P2] 越权指名他人设备：中文教学与英文 raw 错误双轨并存

> **已修复（Wave A / A4，2026-09-03）**：NL 命令 lane 的跨组织 403 统一走
> 本地化教学（设备名 + 归属 + 服务 + 合约路径，复用
> `foreignDeviceTeaching`，跟随 request.locale）；英文 raw gate 原文只进
> command_log 审计（device-command-denied.reason）。hass:// 真实硬件等
> 非越权形状的 403 保留 gate 原文（不同边界、不同 sanctioned lane）。见
> apps/server/src/routes/agent-nl.ts 与 agent-nl.vitest.test.ts。

复现：flower 探针「打开客厅温度传感器」（林姐的设备）→ 阻断本身正确，但
响应是英文 API 原文「请求失败：Natural-language agent commands carry the
SAME device ownership boundaries…」；而同会话内另一条路径（book/flower 的
同名误路由）给出的却是中文教学（归属说明 + 发起合约指引 +
POST /api/services/{id}/agreements）。同一场景两种语言两种质量。
修复方向：统一走教学路径（本地化 + 归属 + 合约指引），raw 错误只进日志。

### R76-F6 [P3] 部署 tab 无现实→仿真反向映射 UI 入口（已知设计差距）

复现：部署面板只有 sim→hass 绑定/指令测试/安全控制台；反向映射（现实设备
状态回流仿真）无 UI 入口。属 docs/design-hil-reverse-mapping.md 的已知
差距，记录为体验确认而非新缺陷。

### 正面记录（本轮验证通过、无需修复）

- **多用户共建共享世界全链路**：5 账号注册/加入（aria 直命中 `加入环境
  <名>`）→ 各自名录放设备（builder 放置转 install-devices 提案 + LLM 审查
  自动应用，WS 广播带完整 caps/owner 实时到端）→ 各自 Agent 向导四步建成
  （F1a backed/unbacked 芯片分组正确、绑定步校验生效、bound=true）→
  环境终态 17 设备/7 Agent/33 服务/6 成员。
- **服务生态协作**：3 个服务发布成功并出现在市场（街区设施保障/咖啡环境
  调节/街区安防巡检）；订阅星标 ✓；合约提案双方（coffee/prop→林姐派生
  服务）真实落库 status=proposed。
- **跨用户协作闭环走通（补测 probe-r76-agreement.mjs）**：provider 在
  「合约」tab 收件箱一键接受（decide 200，proposed→active）→ consumer
  在服务市场详情页试调已持约服务成功，**lane=agreement（持约计量）**，
  返回运行中世界的真实读数（co2=618.7，承载设备正确），计量台账新增
  kind=invoke 记录；合约之外的越权指名仍被所有权边界正确阻断。
- **LLM 生产姿态落地**：NL 命令 parseSource=llm 占 4/6（其余 2 条为 vLLM
  短时降级的 rules-llm-down，规则兜底正确接管）；coffee 的命令由 LLM 解析
  并**真实执行**温度控制。提案 LLM 审查（builder 放置/建 Agent）全程在线。
- **Flow 引擎（DAG 画布编辑器）**：prop 经新编辑器创建「巡逻夜间布防」
  落库 enabled=true（Wave A 补测 probe-r76-flow；条件触发 temperature>30 +
  动作钉本人 Agent 能力，创建 POST 201）。空提交时校验教学内联逐条列出
  缺失项（名称/目标/节点级能力），中文可操作、节点级定位，质量良好。
  更正：早先记录的「客厅高温自动制冷由 prop 创建」系误报——该 flow 为
  starter-home 模板内嵌种子。
- **越权阻断语义正确**：cross-org NL 命令被所有权边界正确阻断（仅文案
  问题，见 F5）。
- **部署 tab**：DeploymentPanel 渲染正常，HA 未配置提示
  （HASS_UNCONFIGURED_HINT）按预期显示。
- **越权/权限差分**：builder 放置/建 Agent 走提案管道、owner 直改——
  双轨权限模型在真实 UI 下行为正确。

### 线束侧教训（非产品问题，细节见 NOTES.md）

- starter-home 模板 GET 未带 token → 401 错误对象被当场景粘贴 →
  SCENARIO_VALIDATION_FAILED（线束 bug，已修）。
- 公开化点错同名卡片（线束已按 真实名+组织者 双过滤）。
- 名录搜「摄像头」无结果是线束 fill 吞错+定长等待+hasText 字面匹配三重
  问题——API 与 UI 实测均正常返回 2 行（萤石/海康摄像机）。

### Wave A 回归验证（2026-09-03）

- **persona-r76 全量（0-4）**：errors 0 / probes 2 / friction 1；环境终态
  scale 24 设备 / 12 Agent / 52 服务 / 6 成员。唯一 friction（prop 业务流
  「行数未变（2)」）定性为线束陈旧——FlowsPage 已重设计为 DAG 画布编辑器，
  线束步骤已重写并经 probe-r76-flow.mjs 实测：新编辑器走通、flow 真实落库
  enabled=true、空提交时校验拦截有清晰内联教学（逐条中文 + 节点级定位）。
  另更正早先误报：「客厅高温自动制冷」为 starter-home 模板种子，非 prop
  创建。
- **apps/web 全量 755 绿**。
- **apps/server 全量 1668 里 20 败**，经 git stash 干净树对照实验三分定性：
  ① Wave A 仅引入 **1** 个回归（agent-nl-org-boundary 断言旧的英文 raw
  文案，已更新为新中文教学断言）；② presence 3 例系 R73 存量，顺手极小
  修复；③ 其余 7 文件 17 例全部是 R73「世界永不休眠+自动启动」
  （commit 2f12769）后的存量测试回填债（见下条）。

### R73-test-debt [P2] R73 测试回填债：「世界永不休眠」语义变更使 7 文件 17 用例失效

R73（commit 2f12769）把世界会话改为永不休眠 + 自动启动后，一批断言旧
休眠语义的测试没有回填：world-session×4 文件、fork-lifecycle-p2f、
replay-sim-timeline、world-session-commands，共 17 用例持续红。修复方向：
按永不休眠语义重写 hibernation 断言与夹具时序（不恢复休眠行为本身）。
已立项 plan-r81-improvement.md Wave E / E5。

---

## R82（2026-09-03）：净室验收轮（Wave A 后）

> 方法：一尘不染的环境（5 个新鲜账号 @yanshou.cn + 新环境「R82 验收生态圈」
> 3e3c78a0，public）重跑 R76 全链路（线束 persona-r82.mjs），验收 Wave A
> 修复并暴露残留环境掩盖不住的问题。三轮演进：R1 blank 引导走通但暴露
> R82-F1；R2 builder 全绿但暴露 R82-F2；R3 判定轮全绿。轮次笔记与留痕：
> data/devloop/r82-verify/（NOTES.md、journeys/、findings.jsonl、shots/）。

### R82-F1 [P1] 世界会话一次性唤醒：空白环境出生唤醒失败后永久死亡

> **已修复（2026-09-03，R82 轮内）**：`world-session.ts` no-session 分支——
> no-session 且未 closed 时每次 world mutation 重试创建一次（自愈）。
> 测试 `apps/server/src/world-session-r82.vitest.test.ts` 2/2，存量零新增失败。

复现：空白环境创建（0 zone）→ 出生唤醒失败 → 之后放设备、建 Agent 等
mutation 全部带 create=false，会话行永远不存在——Agent 不思考、NL 命令
无控制台入口（「进入世界仿真」后聊天输入框永不出现）。R76 靠 starter-home
导入兜底（模板出生即有 zone，唤醒成功）从未踩到；净室 blank 路径首次暴露。
修复方向：no-session 分支在 mutation 时自愈重试（按此落地）。

### R82-F2 [P1] web 端不认 world-session 流帧：页面打开期间的会话创建不可感知

> **已修复（2026-09-03，R82 轮内）**：`worldChange.ts` 解析+合入
> `{kind:'world-session'}` 帧、`useAppStore` 新 action、`useWorldStream`
> 分发。测试 worldChange.test.ts / worldUx.test.tsx 等 web 侧 20 例全绿。

复现：F1 修复后 server 侧会话已自愈创建，但打开着的环境页依旧无 NL 入口
——web 的世界流解析器（`apps/web/src/lib/worldChange.ts`）不认识
world-session 帧，`useWorldStream.ts` 收到即丢弃，`world.worldSession`
停留在"无"直到整页刷新。修复方向：流帧解析/合入/分发三连（按此落地）。

### 正面记录（本轮验证通过、无需修复）

- **A2 空白环境引导（R1 双 HIT）**：空白创建 → 名录 0-zone 空态「创建第一个
  区域」→ 建 zone 落库 → 就地放置设备，全程未走 starter 导入兜底——R76-F2
  的修复在真实 UI 下成立。
- **A4 决策来源徽标硬断言 5/5**：每个 persona 的 `.agent-chat__source` 徽标
  存在且变体与线上 parseSource 一致（本轮全走 rules 快路径，徽标正确显示
  rules）——R76-F3 修复的 UI 证据。
- **R76-F5 端到端证据**：flower 越权指名他人设备拿到统一中文教学（归属 +
  服务暴露说明 + 合约路径），英文 raw 双轨消除。
- **Flow DAG 编辑器**：prop 经新编辑器创建 flow 落库 enabled=true（R2；
  线束已重写该步骤）。
- **判定轮（R3）全绿**：errors 0 / friction 0 / probes 2，scale 14 设备 /
  11 Agent / 43 服务 / 5 成员；Wave A 已修项零复发；hits 32（lin 7 /
  coffee 8 / book 5 / prop 8 / flower 4）。

---

## R83（2026-09-03）：多样化验收轮

> 方法：R82 净室之后的第二轮放行验收，覆盖差异化链路——organizer 走
> starter-home 导入主路径（R75 P0 回归）、合约批准闭环进线束、what-if
> 探针、事件注入、5 路并发注册压力。环境「R83 多样化验收圈」（68f16828，
> public）。线束 persona-r83.mjs；留痕 data/devloop/r83-verify/。

### R83-F1 [P1] what-if 中文「调温到 N 度」解析缺口 + 裸 UUID teach-back + 英文文案

> **已修复（2026-09-03，R83 轮内）**：`packages/core/src/cognition/predictor.ts`
> + `apps/server/src/routes/agent-nl.ts`——中文「把/将 <zone> 温度调/设到
> N 度」映射（zone 名解析 + 温度能力设备选取优先级
> set-temperature > temperature-control > cooling/heating + 只读传感器排除 +
> 无设备降级 parameter_change）；未映射错误文案本地化（locale 传入）+
> 设备名替代裸 UUID。测试：predictor 47/47、agent-what-if 13/13 绿。
> 修复后实测：verdict="degradation" + confidence + 完整 baseline/delta 序列
> （6.7s），证据 data/devloop/r83-verify/whatif-probe-{req,resp}.json。

复现：book 在控制台「问预测」发「如果把客厅温度调到 35 度会怎样」→
400「I understood the what-if question but could not map it onto an
intervention. Known devices: 5f120af9-…(capability/…)」——中文调温表述
无映射、teach-back 列裸 UUID（R44-F2 同族）、文案英文。修复方向：中文
调温映射 + teach-back 设备名 + 文案本地化（按此落地）。

### R83-F2 [P1] lazy-driver 墙锚违约：世界创建后 8ms 被推到 sim 600

> **已修复（2026-09-03，R83 轮内）**：`apps/server/src/lazy-driver.ts`——
> sleep 区分 wakeNow 提前解除（重评估到期集）vs 定时到点；代际守卫丢弃
> 过期 advance。新测试 lazy-driver.vitest.test.ts 4 例 + world-session 族
> 43 例全绿。

复现：R83 首轮期间实测 lazy driver 在世界创建后 8ms 即把 sim 时间推进到
600（按 T-410 墙锚应在 10s 墙钟后）——sleep 的提前解除被当作到点处理，
且过期代际的 advance 未被丢弃。修复方向：wakeNow/定时分流 + 代际守卫
（按此落地）。

### 正面记录（本轮验证通过、无需修复）

- **模板导入路径**：starter-home 导入后「进入世界仿真」即刻可用——R75 P0
  （导入自动起会话）在当前代码下仍活。
- **合约批准闭环（线束化）**：提案 → provider 收件箱一键接受（decide 200
  → active）→ consumer 持约调用 lane=agreement 成功；复跑中提案目标服务
  漂移（lin 传感器 → prop 摄像机）由 provider 动态路由正确跟随。
- **事件注入**：控制台右抽屉注入温度突升事件，确认含 eventId +
  targetAgentIds（LLM 决策链路实战送达）。
- **并发注册压力**：5 路同窗口并发注册 5/5 ok（~25s/路）——A1 session 桶
  拆分 + bootstrapAuth 退避重试正面验证（R76-F1 不复发）。
- **判定轮全绿**：errors 0 / friction 0 / probes 3；scale 21 设备 / 16
  Agent / 67 服务 / 5 成员；hits 36（lin 8 / coffee 8 / book 6 / prop 9 /
  flower 5）。
- **E5 R73 测试回填完成**：7 文件 33/33 绿（重写 16 例 + 删 1 化石例），
  零产品代码改动——plan-r81 Wave E 首项清零。
- **观察项定性**：8 条 terminated 合约为 AC 会话级协议正常终止（R41 设计）；
  2 条 self-agreement 提案 pending 为 R80 开放探针的数据点，非回归。

## R81-WB（2026-09-04）：Wave B1 三分钟 wow 路径计时实走（Playwright）

线束 `data/campus-e2e/ui/wow-path-r81.mjs`（注册 → 导入 starter-home →
进仿真 → NL「打开空调」→ 演示模式验证），产物 data/devloop/wow-path/
（journal/findings/summary + shots）。生产 :8100 + vite :5173 实走结果：
wow 主路径 **6.8s**（预算 180s），全程 0 P0/P1。

| 步骤 | 耗时 |
|---|---|
| 1 注册（UI 全程） | 0.5s |
| 2 导入 starter-home（空态一键） | 4.0s |
| 3 进入仿真控制台 | 0.3s |
| 4 NL「打开空调」→ 设备动作 ✓ | 2.0s |
| 5 演示模式（B2 验证：横幅 + speed=10 → 退出恢复 1×） | 0.8s |

### R81-WB-F1 [P2] 注册落地页（工作台）没有一键导入入口

注册后落在工作台 `/`，「导入 starter-home」空态按钮在 `/environments`
——新用户需自行发现「环境」导航 tab，wow 路径多一次认知跳跃（新手引导
卡片的「选择模板创建」指向模板对话框，非 starter-home 一键）。修复方向：
工作台空态三选一卡片对齐环境首页（Fix-27 已有同方向条目），或在新手
引导第一步直接给 starter-home 一键按钮。

### 正面记录

- **演示模式闭环**：世界视图「演示模式」→ 新建私有仿真 → 注入 heat-demo
  → 10× 播放 → 横幅步骤条（回家→高温→CO₂→灯光→回落）→「退出演示」恢复
  1×——全链路实测（shots/05、06），speed 断言经 API 快照验证。
- **匿名只读**：probe-anon-r81.mjs 验证访客打开公开世界——访客只读徽标 +
  登录提示在场，运行仿真/演示模式/LLM 选择均不渲染（shots/07）。

---

## R84-F6（2026-09-04）：探索轮发现固化

### R84-F6-P2 [P2] 专注模式遗留 / 弹窗遮挡下「进入世界仿真」静默失败（无反馈）

> **已修复（2026-09-04，R84 轮内）**：`apps/web/src/lib/consoleLayout.ts`
> 新增 `loadConsoleLayoutForEntry()`——新鲜控制台挂载永远不以专注模式起步
> （剥离持久化的 focus 并回写收敛存储），`SimulationView` 挂载改走该入口。
>
> **固化指针**：层=UI-probe；簇=UI 可用性（静默失败/错误不可见）；
> 固化物=探针 `data/campus-e2e/ui/probe-console-entry.mjs`（生产 vite
> 实测 6/6）+ 单测 `apps/web/src/test/consoleEntryFocus.test.tsx`（2 例）与
> `consoleLayout.test.ts` 的 R84-F6 describe（4 例）；
> 回滚验证=2026-09-04：回滚 SimulationView 挂载入口 → consoleEntryFocus
> 1 例红；恢复 → 全绿（探针修复前复现 A4 聊天输入框 0、修复后在场）。

复现（F6 探索两轮实测，data/devloop/explore/2026-09-03T22-0[4,7]-*-s[1,2]/
findings.jsonl：「进入世界仿真后仍无 .agent-chat__input」）。两条机制：

1. **专注模式遗留（真缺陷）**：专注模式持久化在 localStorage
   （ac.consoleLayout.v3）。控制台开专注 → 返回世界视图 → 再点「进入世界
   仿真」→ 控制台以双抽屉隐藏重开，Agent 对话面板（世界会话主 NL 入口）
   不在 DOM，全程零提示；用户/探针读作"按钮静默无效"，退出专注"自愈"。
2. **弹窗遮挡（模态语义，记录非缺陷）**：世界页对话框（如成员 tab「批量
   导入」）的 `.dialog-backdrop`（fixed inset:0 z-index:100）拦截指针
   事件——按钮在遮罩下点不到是模态本意，探针 `.click().catch(()=>{})`
   把 Playwright 的拦截超时吞成"静默"。关窗后同一按钮立即生效。

修复取"自动退出遮挡态再跳转"语义（专注模式是会话内 zen 视图，不是跨次
进入的偏好）；弹窗侧不改模态语义，由探针 B 组断言把"遮罩拦截 + 关窗即
生效"固化成文档化行为。

## R84（2026-09-04）：存量可用性残余清扫

> 多轮复现未修项的定向清扫。R44-F2（群体表述 + teach-back UUID）与
> D2-F5（升级通道标定）的标注见各条目内的 R84 引用块；本小节固化另外两项。

### R84-S1 [P2] 同名环境 UI 收口（R75-1/4 残余）——✅ 已修复（2026-09-04）

> **已修复（2026-09-04，R84 轮内）**：环境列表卡片在 owner 之外并列创建
> 时间（`EnvironmentsHomePage.tsx` 卡片 `scenario-card__id` 行 +
> `formatEnvTime`，i18n key `environments.createdAt` zh/en）——同名两份
> （内置 demo vs 用户导入）在网格上即可区分。重复导入的提示侧：server 的
> duplicate-name 教学警告（environment-store.ts `countOwnedEnvironmentsWithName`
> → environments.ts `finishCreation` 的 warnings）此前只在模板卡片路径
> 浮出（R78 toast），空白/粘贴 JSON 导入路径会丢——现已同样
> `pushToast(detail.warnings)`，重名导入即告知「已存在 N 个同名环境」，
> 是否保留两份由用户决定（合并视图不做，超出最小修复）。
>
> **固化指针**：层=UI；`npm run build` 全绿（web tsc + vite）；
> server 侧重名警告由 environments.vitest 既有用例钉住。

### R84-S2 [P2] 名录零命中关键词补别名（R80-3 残余）——✅ 已修复（2026-09-04）

> **已修复（2026-09-04，R84 轮内）**：API 层复测（GET /api/catalog?q=）
> 确认「摄像头/烟感」已被 R80/R15-D5 别名覆盖；仍零命中的常见心智词按
> catalog 种子数据驱动补进 `catalog-store.ts` `QUERY_ALIASES`：
> 水浸/漏水/内涝 → 雷达水位计（water-level）；新风/换气 → 空气净化器
> （air-purification）；地暖/暖气/供暖/制冷 → heating/cooling 能力的空调；
> 除湿 → 加湿器。目录里没有的设备类保持诚实空结果（门磁仍 0 行——别名
> 只放宽不发明）。
>
> **固化指针**：catalog.vitest 新增「R80-3 residual zero-hit keywords」
> 用例（8 词锚定具体设备名 + 门磁空结果红线），28/28 绿。

## R85（2026-09-08）：控制台/世界视图可拖拽分栏 + 可读性批次

### R85-S1 [P2] 双抽屉固定尺寸不可拖、小字号密集——✅ 已修复（2026-09-08）

> **问题现象**：仿真控制台右抽屉固定 340px、底部事件抽屉固定 35% 高，
> 世界视图右侧栏为手搓 pointermove 拖拽（clamp 320–640px）——宽屏下
> 名单/报表列不开，窄屏下画布被挤压；同时暗色主题 `--text-dim`/`--border`
> 对比偏弱，chat/事件流/tab 等高频区域 11–12px 字号刺眼。
>
> **修复方式**：两处布局统一改 `react-resizable-panels`（v3.0.6）。
> SimulationView：垂直 PanelGroup（`ac.consolePanels.v1`）= 主区 Panel
> （内嵌水平 PanelGroup `ac.consolePanelsH.v1`：地图 Panel + 拖拽把手 +
> 右抽屉 Panel，defaultSize 24%/min 15%/max 45%）+ 事件抽屉 Panel
> （35%/15%/60%）；抽屉开合仍是条件渲染（折叠时不挂 Panel，开合语义与
> `ac.consoleLayout.v3` 不变），折叠钮吸附在地图 Panel 右缘，ReplayBar 留在
> 主区 Panel 底部原位。WorldViewPage：`detail-body` 改水平 PanelGroup
> （`ac.worldPanels.v1`），侧栏 maxSize 50% 取代 640px 封顶；手搓拖拽 wiring
> 与 `lib/sidebarWidth.ts`（及其测试）删除，`WorldSidebar` 的 `width` prop
> 一并移除。focus（'f'）/present 模式不挂抽屉 Panel，行为不变。
> 可读性：暗色 `--text-dim` #8b95a3→#9ba6b5、`--border` #2d333f→#39414f
> （亮色同步微调；`lib/theme.ts` 镜像同步）；`.zone-node__params`、
> `.event-log__reasoning` 11→12px，`.agent-chat__*` 12→13px（log
> max-height 260px→40vh），`.replay-bar`/`.world-tab`/`.event-drawer__header`
> →13px；新增 `@media (max-width: 1280px)` 收窄抽屉内边距，分栏
> defaultSize 在窄屏降一档（页面内 `narrowViewport()`）。
>
> **固化指针**：层=UI；`apps/web` tsc 全绿、vitest 115 文件 802 用例全绿
> （受影响的 consoleLayout/consoleEntryFocus/worldUx/agentLifecycle/
> rowBrief/zoneRoomsDetail 六件已同步更新断言）。

---

## R-DEMO（2026-09-09）：领导演示彩排发现（太仓校区 taicang-campus）

> 来源：`docs/demo-taicang-leadership.md` 的端到端彩排（CLI 全流程 +
> Playwright 动线 probe `data/campus-e2e/ui/probe-leadership-demo.mjs`）。
> 目的不是产品缺陷修复，而是把"演示前必须知道的事"固化进脚本与 checklist。

### R-DEMO-1 [P1] 本机网络下 OSM/Carto 底图瓦片不可达，地图满屏占位图

> **问题现象**：环境详情页 geo 地图所有瓦片渲染为 "API KEY REQUIRED"
> 占位图。实测 `curl` OSM 与 Carto 瓦片端点均超时（000），高德栅格瓦片
> `webrd0{s}.is.autonavi.com` 正常（200）。默认 provider `carto-voyager`
> 在该网络下不可用。
>
> **处置（演示侧）**：`apps/web/.env.local` 配置 `VITE_AMAP_KEY` +
> `VITE_AMAP_JSCODE` 后在左下角切换器选"高德"。已写入演示脚本 checklist。
> **平台侧启示**：geo 视图对"瓦片全灭"无降级提示，领导演示场景下这是
> 第一印象级风险——建议后续加瓦片加载失败检测与自动切换备选 provider。

### R-DEMO-2 [P2] 仿真控制台深链匿名访问显示"找不到这个仿真"

> **问题现象**：`/simulations/:simId` 深链在未登录浏览器打开时渲染
> "找不到这个仿真"错误页（`api.listSimulations()` 401 → 查无此 id），
> 而非引导登录。演示中若误开无痕窗口会卡在这里。
>
> **处置（演示侧）**：checklist 增加"控制台页需登录态"；probe 脚本已改为
> 先经 vite 代理 `POST /api/auth/login` 再访问。匿名只读渠道用
> `/share/:shareId` 回放分享页（已验证无需登录，含决策链 + 物理曲线）。
> **平台侧启示**：401 与"不存在"被合并成同一错误页，语义上把
> "没权限"说成了"不存在"，可考虑区分。

### R-DEMO-3 [P2] 演示环境创建路径：scenario JSON 整体 POST 导入，且默认 private

> **问题现象**：`eaf env create` 只能建空环境；从场景建可演示环境需
> `POST /api/environments`（body 为整份 scenario JSON），导入结果默认
> `private`，匿名分享链接前必须 `PATCH visibility=public`。CLI 无对应
> 封装（`eaf apply` 是另一条 YAML 路径）。
>
> **处置（演示侧）**：完整命令序列已写入演示脚本 §3，并留存了彩排通过的
> 环境 id 与分享链接可直接复用。
> **平台侧启示**：`eaf env import --file scenario.json [--visibility public]`
> 是值得补的三通道缺口（case-study-smart-campus 的"课前环境生产"动线
> 同样卡在这里）。

## R97（2026-09-15）：本地新眼睛探索轮（3D/步行/部署/实时仿真/整体业务逻辑）

> 本地栈（8100+5173，rule-only），ENV_B 西浦太仓（93 zone / 122 设备 / 16 agent）
> 为重点。探针 `data/campus-e2e/ui/r97-*.mjs`，截图 `shots-r97/`。
> 探索 + 修复同一轮闭环；web 全量 843 用例绿。

### R97-F1 [P1] B1 地下层 walk 渲染成无限空旷网格——✅ 已修复（2026-09-15）

> 根因：B1 是停车场式大空间，提取器把车位线识别成"墙"（包络覆盖率
> 83.8%，正常楼层 3~6%），rooms/floor 数组为空；渲染侧砌出 9552 顶点的
> 矮墙海洋且部署判定全拒。修法：新增开放大厅判定（`openHall.ts`：
> rooms/floor 均空且墙盒包络覆盖率 >0.4）——命中时 4 条包络墙替代杂墙、
> 部署放宽到包络内可放、进入显示提示 chip。顶点 9552→96，正常楼层零误伤
> （openHall.test.ts 6 例）。

### R97-F2 [P2] 世界总览「平面」视图默认近乎空白且无引导——✅ 已修复

> 默认楼层取 floors[0]（有地下层时=B1，仅 2 栋楼有 → 空白）。改为
> `defaultActiveFloor`（区域数最多楼层，并列取近地面层），默认即铺出
> 19 个 1F zone 卡片（buildings.test.ts +3 例）。

### R97-F5 [P2] walk 部署按 E 完全静默——✅ 已修复

> 放置被拒（ghost 红色/非房间地面）时无任何反馈。加准星 flash
> 「⚠️ 此处无法部署——请对准房间内的地面」，E 键与点击两路径共用。

### R97-F6 [P2] 新建设备空表单静默提交——✅ 已修复

> 校验本存在但错误文案渲染在侧栏滚动区外。移至按钮旁红字 + 禁用态。

### R97 开放项（未修，按优先级）

- **R97-F3 [P2]** 3D 总览楼栋无名称标注（dollhouse/walk 有，唯独总览 3D 没有）。
- **R97-F7 [P3]** 设备表单类型/能力建议 chips 为英文原始标识符（中英混杂）。
- **R97-F8 [P3]** 仿真控制台 WS 首连必失败一次再重连（功能无损，错误噪音）。
- **R97-F9 [P3]** 控制台布局警告 `Invalid layout total size: 65%`。
- **R97-F10 [P3]** 「决策引擎：规则模式」提示整段英文。
- **R97-F4 [P3]** 打磨批：E 栋 3F 出生朝向楼外；dollhouse 俯视文字镜像 +
  标签重叠；walk 无效 zone 参数静默回退无提示。
- **R97-F11~F14 [P3]** /auth/me 401 console 噪音；拓扑漂移 banner 裸英文
  设备 ID；「世界动态」空态无占位文案；EN 模式拼接中文名。

### R97 正面记录

- walk WASD 移动/指针锁定/楼层 rail 切换流畅；D 栋 1F 墙体/房间标注/设备
  /agent 化身/小地图/实时温度全正常。
- 实时仿真：注入事件 ~10s 内 UI 三处联动（活动时间线/叙事/正在发生）；
  深链恢复控制台正常。
- 匿名跳登录、错误密码反馈、404 页、主题/语言切换、tab 往返无状态残留。
- 已知项未复现：R-DEMO-1（瓦片）、R82-F2（world-session 流帧）。

### R97-deploy（2026-09-15）：8086 部署后远端冒烟

> R97 修复 + admin 面板部署 8086 后的 Playwright 复验（demo-owner 账号，
> 只读为主）。探针 `r97-deploy-*.mjs`，截图 `shots-r97/deploy-*.png`。
> 结果：F1/F2/F5 修复远端确认上线、/admin 权限门与邀请码注册正常、
> 仿真控制台启动/步进/实时联动正常、零数据污染。

- **DEPLOY-F1 [P1] walk 放置被服务端拒绝时 UI 静默——✅ 已修复并上线
  8086（2026-09-15，commit 6134840）**：`useInteriorDeploy` 的 catch 只有
  console.warn；公开环境里匿名/非成员按 E 放设备必踩。修法：
  `placeFailureKind`（401/403→forbidden，其余→error）+ 复用 R97-F5
  flash 通道分文案提示。interiorDeploy.test.ts 4 例；8086 远端复测
  403 flash 正确出现、无落库。
- **DEPLOY-F2 [P3]** grid 环境 walk 的 R92 降级页整页近黑、仅左上角一行
  小红字（文案正确但观感差）。
- 勘误：demo-owner@eaf.local 是 a0c90a81「跨 Agent 协作 Demo」的 owner，
  非 4ac2ee9d 太仓校区成员（后者 owner 是「演示管理员」）。

### 多用户 E2E 收敛战役（2026-09-16 → 09-18，R1–R19）：四角色 × 十九轮「探索→PM→开发→部署→复测」循环

> 四个互不相通的用户 sub-agent（运营经理/设备商/安防集成商/分析师）在公网演示站
> 153.35.3.18:8086 做十九轮「探索→PM 分诊→开发修复→部署→全新 agent 复测」循环，
> 发现统一走 PM 任务书（T1–T111），修复以 19 个批次提交（Batch 1–19）并由全新用户
> agent 验收。完整证据链：`data/campus-e2e/rounds/`（各轮 users/pm/dev 报告 +
> `CONVERGENCE-REPORT-R1-R19.md`）。

- **收敛结论**：R19 首个完全干净轮（四角色 0 P0/0 P1）。P1 轨迹
  28→8→11→7→5→4→3→11(挑刺轮)→4→2→1→1→2→4→4→6(聚4)→3(新鲜代码)→2→1→0；
  P0 自 R2 起连续十八轮为零。
- **多用户主链闭环并经多轮回归**：邮箱邀请未注册同事→注册自动入班（T88 前缀家族
  与 T98 NL 短 id/显示名解析把「复制短 id 到处 NOT_FOUND」的痛点整个消灭）；
  propose→accept→invoke→双边 usage/receipts→terminate（R10 双边计量实证）。
- **诚实边界体系成型**：read 诚实拒绝家族五连（UNWRITTEN/NO_READING/INPUTS_EMPTY/
  METRIC_NO_READING/STOPPED——全部 failure 计量、零假成功零假收据）、辖区披露
  ask/what-if 双道统一（T105/T109 单一 targetZones 口径）、unbacked 措辞-行为逐字
  对齐（T103 分 origin 分道）、高倍速伙伴响应窗口双语说明行（T111，B1-4 定性收尾）。
- **战略守卫**（Batch 8 T79）：render-walk 面 manifest（121 命令面对账、50 面行走、
  96 项书面豁免）把「human<json」家族机器化把守，后续每批扩面；R102 违例从用户
  逐轮发现改为 walk 逐面拦截。
- **方法论教训**（写进各 PM 任务书）：R8 的「stderr 取证伪回归」假阳性 → 固化
  `eaf --version` 指纹 + 合并流取证协议；部署后冷却 5 分钟再放用户（重启窗口伪回归
  两次）；「每批新功能需要一轮稳定期」是收敛主导项——render-walk 扩面把它机器化。
- **遗留**：P2/P3 打磨长尾（前缀覆盖剩余面、通知 yourMove 门铃、me 计数口径）、
  全量道基线红 6 个（flow.vitest 1 / consent-semantics 3 / e2e 2，快道全绿之外）、
  world-hibernate 负载 flake、演示站 node 无守护进程（外部 SIGTERM 后需手动拉起）。
