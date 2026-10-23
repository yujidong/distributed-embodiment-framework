# 业务流（Flow）编排指南

> Flow 是用户定义的一等公民业务逻辑：**触发器 + DAG 动作图**，由引擎确定性执行，
> 不经过 Agent 的 LLM 决策。它与 Agent 自主决策并存——Flow 是用户的"确定性快车道"，
> Agent 通过环境状态变化与总线事件感知 Flow 的执行结果。

## 概念

> **导出文件可直接用于 `flow add`（R1 B1-12）**：`env export` 产物里的 flow
> 节点用**人读名**钉目标（`deviceName` / `assigneeAgentName`）；CLI 侧
> `flow add` / `flow update` / `flow adopt` 会按目标环境的当前设备/Agent
> 自动把名字翻译回 id（与 `world apply` 共用同一张映射）。名字拼错时是
> 指名回显的 usage 错误（附 `eaf device list --env …` 指路），不再是匿名
> 的 additionalProperties 422。直接写 id 的文件行为不变。

```jsonc
{
  "name": "客厅高温自动降温",
  "enabled": true,
  "trigger": {
    "kind": "condition",
    "zoneId": "living-room",
    "conditions": [{ "path": "temperature", "op": ">", "value": 30 }],
    "cooldownSimSec": 300
  },
  "plan": {
    "goal": "把客厅温度降到 26°",
    "nodes": [
      { "id": "n1", "capability": "cooling", "params": { "targetTemperature": 26 } },
      { "id": "n2", "capability": "ventilation", "dependsOn": ["n1"],
        "condition": "humidity > 70", "onFail": { "policy": "retry", "retries": 2 } }
    ]
  }
}
```

- **trigger**：三种触发方式（见下）。
- **plan.nodes**：动作节点 DAG。`capability` 为语义能力（如 `cooling`），
  `assigneeAgentId` 缺省时自动匹配**绑定设备能提供该能力**的 Agent
  （DevLoop：Agent 仅自身声明该能力、而其绑定设备都不提供的，创建/更新时即
  422 拒绝——Flow 执行只会通过 assignee 的绑定设备动作，声明不能执行）；
  **设备"声明"了能力还不够——必须有可执行路径**（T-002）：绑定设备要把该
  能力落到已注册的命令处理器上（`turn-on`/`set-brightness`/`cooling` 等，
  或经设备类型展开，如灯设备的 `lighting-control` → turn-on+set-brightness）。
  仅声明而无处理器的能力名（如 `switch`）会在创建/更新时 422，错误信息列出
  当前可用的可执行能力——否则运行时会以 "no handler / no effect for command
  switch" 中途失败；
  同样地，**Agent 创建/改绑时的能力声明必须由绑定设备背书**（T-206）：声明
  而无任何绑定设备提供（containment 匹配，与 Flow 运行时同一匹配器）会在
  install-agents 提案、属主直建与 modify-object 补丁**所有路径**上 422，
  错误信息列出绑定设备实际提供的能力；hass:// 绑定设备豁免（真实硬件），
  无绑定设备的 Agent 不得声明任何能力；
  **声明漂移不是执行障碍，但会被如实标注（T28/T36）**：assignee 的**声明面**
  不含节点能力时（撤过声明或从未声明），节点仍经绑定设备照常执行，但
  authoring 校验给 WARNING（receipt，不是 422）、运行记录带 `capabilityDrift`
  注记，且目录/合约面（`service get`/`list`、agreement 各响应）对该能力派生的
  服务行标注 `declaredByProvider:false`——行不收缩、可照常签约调用，恢复声明后
  标注消失。措辞无时态断言（"not declared"，不说 "no longer"）；
  **漂移≠失败（T40g 伴注，u1-F7 澄清）**：执行真相=设备面——带漂移的运行
  status 照常报告真实执行结果（human 行为 `status (degraded: capability 'x'
  not declared by 'agent'; N/M nodes executed via bound devices)`），degraded
  是治理面标注，不是执行失败的降级。
  `dependsOn` 声明先后依赖；`condition` 为守卫条件（迷你语言，单比较）；
  `onFail` 支持 `abort`（默认）/ `retry` / `compensate`（补偿节点）。
- **`params` 拼写即契约（R13/CB-F01）**：节点 `params` 的键必须命中命令处理器
  认识的拼写（如 `set-fan-speed` 认 `speed`/`fanSpeed`，`set-temperature` 认
  `targetTemperature`/`temperature`/`target`/`value`）。运行时会**静默丢弃**
  不认识的参数键——所以一条 params 全部拼错的节点等价于空参数执行（"no
  effect"）。创建/更新时的校验会对已知命令做**全不匹配检查**并 422 带改名
  提示（如 `fan_speed → speed`）；运行期报错也会列出实际发送的参数与接受的
  拼写。设备快照里的历史状态键不一定是命令参数名——以错误信息列出的拼写为准。
- **`set-mode` 的词表跟设备类型走（T-607/R26）**：气候家族设备
  （hvac/thermostat/air-conditioner）保持封闭枚举
  `mode: cooling|heating|auto`（错误照旧教学）；**其他设备类型**接受任意
  非空 `mode` 字符串并按原样写入状态（generic set-* 语义）——净化器
  `set-mode {mode:'turbo'}`、追日器 `{mode:'track'}`、UPS `{mode:'eco'}`
  直接可用，无需再借道 set-power 改写词表。
- **`deviceId` 钉住 + 跨 zone 读取 vs 动作（T-312）**：`event`/`condition`
  触发的 Flow **只动作触发 zone 内**的设备（钉住的设备在别的 zone 会 422
  "refuses to actuate another zone's device"）。跨 zone 的**读取**没问题：
  条件路径写 `roof.pvOutputW` 可以在 `plant-room` 的 Flow 里评估别的 zone
  的参数；需要跨 zone **动作**（如病房呼叫触发大堂广播）时，不要试图钉住
  其它 zone 的设备——自有设备可用 per-zone Flow 对（每 zone 一条事件流）
  或 `schedule` 设施级定时 Flow（无触发 zone 收敛）；**动作别人的设备**
  （或需要治理/计量/归因的跨区联动）走下文「跨区升级」的合约触发模式。
- **Zone 定位**：`event` / `condition` 触发携带触发 zone 时，执行只会动作
  **该 zone 内**的设备——assignee 优先选服务该 zone 的 Agent，设备优先选该
  zone 内的资源；若 assignee 在该 zone 没有能提供该能力的设备，节点**显式
  失败**（运行记录可见原因），绝不静默动作其它 zone 的设备（校园试点 P0：
  "101 教室过热"的 Flow 曾误开 108 教室空调）。
  **触发类型不对称是设计使然（T-312）**：zone 收敛只适用于 `event` /
  `condition` 触发（事故作用域——"zone X 的 Flow 永不触碰 zone Y"）；
  `schedule` 触发没有触发 zone，是**设施级定时程序**，**允许跨 zone 动作**
  （如夜间节能回退一次性调节 3 个 zone 的设备）。需要 zone 级作用域的定时
  逻辑，请为每个 zone 单独写一条 event/condition Flow（per-zone 事件流
  模式）。
- 执行语义与 AC 工作流一致：拓扑波次执行、条件为 false 跳过子树、失败按策略处理，
  每次执行产出节点级 trace（运行历史可查）。

## 委托节点（机制 A：混合主导业务流）

动作节点旁边可以放一种**委托节点**（`delegate`）：向 assignee Agent 的 LLM 判断提
一个**有界封闭问题**，Flow 仍是过程所有者（拓扑、守卫、失败策略不变）。这是
**逐节点显式 opt-in**——不含委托节点的 Flow 行为与从前逐位一致；`PlanExecutor`
不调用任何模型，LLM 只在 `delegateRunner` 接缝后面。

```jsonc
{
  "id": "pick-shed-target",
  "assigneeAgentId": "energy-optimizer",   // 缺省：作者作用域内自动匹配
  "delegate": {
    "question": "当前负载与在住情况，选一台 HVAC 限载并给出目标温度（18–26）",
    "mode": "actuating",                   // 'advice' | 'actuating'
    "budget": {                            // 仅 actuating；advice 带 budget → 422
      "maxCommands": 2,
      "deviceIds": ["hvac-101", "hvac-102"],   // 必须是 assignee 绑定且可执行的设备
      "allowedCommands": ["set-temperature"]
    },
    "outputs": ["targetTemp"],             // 仅 advice：提升为守卫路径
    "timeoutMs": 30000,                    // 判断的墙上时钟上界（默认 30000）
    "fallback": { "policy": "none" }       // 或 { "policy": "node", "nodeId": "safe-shed" }
  },
  "dependsOn": ["detect-peak"],
  "onFail": { "policy": "abort" }
}
```

- **两种变体**：`advice` 只记录判断（不碰任何设备）；`actuating` 可在预算内
  直接动作——走与动作节点**相同的自有设备命令路径**（归因 = flow run + 委托节点）。
  委托节点不得携带 `capability`/`params`/`deviceId`（422 教学）。
- **预算三面闸**：命令数（`maxCommands`）、设备（`deviceIds`，钉定语义）、命令名
  （`allowedCommands`，可执行路径校验）。预算外的提案**逐条拒绝并记录理由**
  （`rejectedActuations`），不整体失败也不静默截断。**T-605（R26）：命令校验
  是"预算并集"语义**——运行时闸门是（设备 ∈ deviceIds）∧（命令 ∈
  allowedCommands），模型对每条提案自然配对（设备，命令）；因此一个命令只需在
  **至少一台**预算设备上有可执行路径即可（创作校验与运行时同一契约）。异构
  预算（"PA 上 play-alert + 显示屏上 show-message"）从此可表达；仅在**所有**
  预算设备上都无可执行路径的命令才 422（逐命令点名每台设备提供的能力）。
  部分设备可执行时附一条 warning 列出可执行的设备（教学配对）；需要严格
  "每设备各自的命令集"时，用**多个 delegate 节点**分别钉定各自预算。
  **zone 收敛同样覆盖预算**
  （批准裁决 #1）：event/condition 触发时预算设备必须全部在触发 zone 内
  ——"zone X 的 Flow 永不触碰 zone Y"包括判断驱动的动作；跨 zone 走 per-zone
  委托或协议调用。`schedule` 保持设施级不对称（无触发 zone）。
- **归因（T-608/R26）**：Flow 触发的设备动作在设备审计道
  （`accessLog`/`lastActionBy`）记为 `by: "flow:<flowId>"`——稳定、可经
  GET /api/flows 解析、长度适配 accessLog 环。委托节点的模型提案动作同标
  （设备审计获得 flow 来源；agentId 仍随节点结果归因）。直连命令道仍记
  用户 displayName；协议自动执行道不变（command_log 的 autoTrigger/
  agreementId 归因）。动作 `params` 保持纯净（actor 走调用上下文，R17）。
- **advice 输出供下游分支**：`outputs` 白名单键被提升为守卫路径
  `delegate.<nodeId>.<key>`——下游节点（`dependsOn` 该委托节点）的 `condition`
  可以写 `"delegate.pick-shed-target.targetTemp > 20"`。白名单外的输出键会被
  **记录**（`ignoredOutputKeys`），绝不静默丢弃。
- **超时与降级都诚实落账**：`timeoutMs` 到点放弃等待 → `fallback`；
  LLM 故障 → T-022 语义（有界重试仅瞬时错误 → `decisionSource:
  'rule-llm-down'`，provider 错误进 reasoning → `fallback`）；无 LLM / assignee
  被禁用 / 操作员关掉独立动作（`autoActuateIndependent=false`，sim > agent
  policy > 默认）同理，理由逐条记录。
- **fallback 两种形状**：`{policy:'none'}` 记录 no-op（节点成功、流程继续）；
  `{policy:'node', nodeId}` 委托节点显式失败，回退**动作节点**带外执行一次
  （compensate 语义：正常调度中被排除，不会双跑；委托成功则记录
  "compensation not required"）。回退目标必须是本 plan 里的**动作节点**。
- **运行 trace**（nodeResults 的 `result`）携带完整审计：`variant`、
  `decision`/`reasoning`/`decisionSource`/`confidence`、`outputs`、
  `actuations`（deviceId+command+params+applied）、`rejectedActuations`、
  `budgetUsage`、`fallbackUsed`+`fallbackReason`。四通道同步：REST/OpenAPI、
  Web 画布（类型已含 FlowDelegateNode）、CLI `--file` YAML/JSON、场景 JSON
  内嵌 `flows`。
- 委托是 **Flow 专属节点**：LLM 合成 plan 的 `PLAN_JSON_SCHEMA` 不接受它
  （设计 §8.5.1——不允许模型自由嵌入判断步骤）。

### 怎么选委托问题的措辞（T-609/R26）

小模型（8B 级本地视觉-语言模型）对**开放式问题**极易漂移：R26 实测一条
advice 委托问"大堂是否需要限流"，模型自行引入了范围外的 zone 上下文
（舒适度、CO₂），在占用 520 时两次拒绝预期分支；改成**封闭阈值式**后一次
通过。经验法则：

- **写成封闭/有界形式**。阈值模板：*"若 `occupancy >= 300` 则建议限流；
  只看 occupancy，忽略 comfort/CO₂ 等其他参数"*——判据、边界、排除项
  全部显式写出，模型的自由度只剩答案本身。
- **给枚举而不是给开放讨论**。"从预算设备中选一台（输出 deviceId）"优于
  "怎样调度更省电"。
- 开放式问题交给更强的模型，或干脆不委托（见「与 Agent 的分工建议」）。

### 小模型上的 actuating 委托：读 trace 与兜底（T-609/R26）

R26 两个租户、7 次 actuating 委托执行全部 0 动作（qwen3-vl:8b 在文本里
推理、从未输出结构化 `actuations` 数组）——节点 success、confidence
0.95–0.98、`budgetUsage.commandsExecuted: 0`。**这是模型能力边界，不是
平台故障**；trace 是诚实的。读法：

- `budgetUsage.commandsExecuted: 0` **且** `actuations`/`rejectedActuations`
  缺席 = 模型没提出（或没输出可解析的）任何动作。"被预算拒绝"会出现在
  `rejectedActuations`（逐条带理由），与此可区分。
- 兜底模式（今天就可用）：
  1. **确定性回退节点**：`fallback: {policy:'node', nodeId}`——委托不落
     地时由动作节点带外执行一次（compensate 语义）；
  2. **信封升级**：`policy.onBudgetExhausted: 'escalate'`——耗尽即升级；
  3. **advice + 守卫动作**（机制 A 的设计形态）：委托只出判断
     （`outputs` 提升为守卫路径），动作节点用 `condition` 守卫——判断错
     或空不会直接碰设备；
  4. **换模型**：结构化 actuation 输出对 8B 级视觉-语言模型是实测硬边界，
     需要更强模型（云端或更大的本地模型）才能让 actuating 半边真正动作。

## 通知节点与等待节点（FEAT-05/06）

动作/委托/服务节点之外还有两种确定性节点（互斥字段块：一个节点恰好是
action/delegate/service/notify/wait 之一，混带 = 422 教学预检）：

- **通知节点 `notify: {to, target?, message}`**——确定性车道的「通知到人」
  （此前只能用 speaker play-alert 近似）。投递走环境通知管道（与 policy
  升级、握手应答同族，`kind: flow.notification`）：`to:'owner'` = 环境
  owner（不得带 target）；`to:'role'` + `target:'owner'|'builder'|'viewer'`
  = 该角色全部成员（拼错角色 = 422——「会静默谁都不通知」的陷阱被响亮
  拒绝）；`to:'agent'` + `target:'<agentId>'` = 该 agent 的 owner 用户
  （握手应答同一解析规则）。运行台账的节点结果携带实际收件人与通知 id
  （`{recipients, notificationIds}`），投递被管道噪音控制丢弃或角色无
  成员 = 诚实节点失败。Web 画布可创作（R2-FEAT-06：「+ 通知节点」，
  to/target/message 表单）。
- **等待节点 `wait: {simSec}`**——确定性错峰（图书馆立即、实验楼 +5min
  此前只能用不同设定温度伪错峰）。依赖齐具后挂起 simSec **仿真秒**才
  完成：运行按波次分段执行，挂起态进 checkpoint（hibernate/resume 不丢
  调度），暂停的世界不倒计时，到期 tick 经串行队列续跑下游。台账节点
  结果携带 `{waitSimSec, dueSimSec, resumedAtSimSec}`；**台账一运行一
  行**——挂起期间不落行，直触入口（手动 run / agent 调用）拿到的是
  `status:'waiting'` 的中间应答（带 `waiting.resumeAtSimSec` 与
  `pendingNodeIds`，不落台账）。无下游依赖的 wait 节点 = 校验 warning
  （它什么也不错峰）。**限制**：含 wait 节点的 Flow 不能作为
  flow-service 被协议调用（409 `FLOW_RUN_ASYNC`——调用是同步契约，
  计量/回执链的是完成的运行；错峰属于消费方自己的编排）。

```jsonc
{
  "id": "staggered-setback", "name": "错峰节能回退", "enabled": true,
  "trigger": { "kind": "event", "eventType": "grid-peak", "zoneId": "library" },
  "plan": {
    "goal": "立即回退图书馆，5 分钟后回退实验楼并通知值班员",
    "nodes": [
      { "id": "lib", "capability": "set-temperature", "deviceId": "hvac-lib", "params": { "targetTemperature": 26 } },
      { "id": "hold", "dependsOn": ["lib"], "wait": { "simSec": 300 } },
      { "id": "lab", "dependsOn": ["hold"], "capability": "set-temperature", "deviceId": "hvac-lab", "params": { "targetTemperature": 26 } },
      { "id": "tell", "dependsOn": ["lab"], "notify": { "to": "role", "target": "owner", "message": "错峰回退已完成" } }
    ]
  }
}
```

## 输入参数面与流程服务（机制 D：Flow-as-a-Service）

Flow 过去有触发器、没有函数签名。机制 D 补上**输入参数面（inputs）**，
并把一条带参数面的 Flow **发布为可协商、可计量调用的服务**（所有方原话：
"flow 可以以单独暴露 service 的方式存在？与 agent/干系人商议出一个
service，之后直接调用"）。

### 声明与插值

```jsonc
{
  "name": "夜间节能回退（参数化）",
  "trigger": { "kind": "event", "eventType": "grid-peak", "zoneId": "zone-a" },
  "inputs": [
    { "name": "setpoint", "type": "number", "required": true, "min": 16, "max": 26 },
    { "name": "mode", "type": "string", "enum": ["eco", "comfort"], "default": "comfort" }
  ],
  "plan": {
    "goal": "夜间回退到指定温度",
    "nodes": [{
      "id": "n1", "capability": "cooling", "deviceId": "hvac-101",
      "params": { "targetTemperature": "${input:setpoint}", "profile": "mode-${input:mode}" }
    }]
  }
}
```

- `inputs` 是**逐参数声明**（name/type/required/default/enum/min/max），
  闭合 schema——拼错的键得到精确 422 路径，绝不静默丢弃。**缺省**（不写
  `inputs`）= 无参数面（pre-D 语义：运行不接受 params，不可发布为服务）；
  **空数组 `[]`** = 合法的零参签名。
- 节点 params 值与节点 `condition` 支持**唯一一种插值** `"${input:name}"`：
  整串即一个引用时保留**类型**（number 进的是 number）；嵌在更长字符串里
  则按文本插值。**作者校验**（创建/更新 422 教学）：引用必须已声明，且被
  引用的输入 required 或带 default（可选无默认的输入被省略时引用无法求值）。
- **调用传参**（手动运行 / 服务调用）与作者声明共用**同一个校验函数**
  （`resolveFlowRunParams`）：面是闭合的（未知键报错）、无类型强转
  （'20' 不是 20）、min/max 闭区间、enum 成员校验、required 可被 default
  满足。违规 → 422 `FLOW_PARAMS_INVALID`（教学 issue 列表）。
- 手动运行带参：`POST /api/simulations/:simId/flows/:flowId/run`
  body `{"params": {...}}`；CLI `eaf sim run-flow <simId> <flowId>
  --params '{"setpoint":20}'`；场景 JSON 内嵌 Flow 的 inputs 声明随加载
  校验并落库。运行台账（`flow_runs.inputs`）记录**实际入参**
  （调用方传参经 default 合并后的 effective 值）。
- 注意：带 required 无 default 入参的 Flow，其**自身触发器**触发时没有
  入参来源——引擎的参数门会诚实落一条 **failed** 运行记录（绝不静默
  代值）；这类 Flow 的参数化入口是手动运行与服务调用。

### 发布为服务（provider 侧）

`POST /api/environments/:envId/agents/:agentId/services` 带
`backing: {kind:'flow', flowId}`（CLI：`eaf service publish --env … --agent …
--name … --type … --flow <flowId>`）：

- 发布门（全部教学式）：流属于本环境（404）、enabled（409
  `FLOW_NOT_RUNNABLE`）、**已声明 inputs 面**——空数组即可（422
  `FLOW_INPUTS_REQUIRED`：接口必须是契约）；provider agent 在流作者的
  **T-201 作用域**内（422 `SERVICE_BACKING_INVALID`——"作者身份而非权限
  等级是边界"：执行发生在提供方上下文，谁出面谁执行）。
- **interface 由平台从 inputs 面生成**（手动 interface 一律拒绝）： 
  `{kind:'flow', flowId, actions:[{name:'run', parameters:{<入参 schema>}}],
  delegateNodeCount}`——委托节点数（机制 A 的谨慎性数据化）让消费方在
  签约前看到"一次确定性调用"内部是否含 agent 判断。流编辑自动刷新该
  interface；**删除流即下线服务**（级联连带协议）。
- **T-609 注（R26，RT26-F09）**：flow-service 合约的 `autoReset` 复位
  用的也是 `action.command: "run"`——复位就是**带复位参数的第二次计量
  运行**（`autoReset.action: {command:'run', params:{…}}`，params 按
  flow inputs 面校验；计量归属 `agreement:<id>:auto-reset`，见
  design-data-services.md §6.1）。
- 市场照常：`?origin=flow` 筛选、Web 卡片（「流程服务」+ 参数面 + 委托
  数）、visibility 三档照旧。

### 协商与调用（consumer 侧）

```jsonc
// POST /api/services/<svcId>/agreements —— 结构化条款是合约形状
{
  "terms": {
    "trigger": { "eventType": "grid-peak", "zoneId": "zone-a" },  // 可选：T-035 自动执行
    "action": { "command": "run", "params": { "setpoint": 20 } }, // 必填且 command 必须 'run'
    "quotaPerWindow": 10, "windowSec": 3600                        // 只数成功（T-205）
  }
}
// invoke：POST /api/agreements/<id>/invocations { "action": "run", "params": {...} }
```

- **propose/counter 即校验**（最早的边界）：无 terms.action → 400；
  command ≠ 'run' → 400；terms params 越出 inputs 面 → 422。
- **调用**：T-205 合并覆写（协商参数压住调用参数——消费方不能放大）；
  inputs oracle 复验（422 `FLOW_PARAMS_INVALID`，计量为 failure、不烧配额）；
  经 `FlowEngine.runDirect(triggerKind 'service')` 在**提供方上下文**同步
  执行——节点只动流作者自己的 Agent/设备（T-201 + zone 收敛原样生效，
  **零新增权限机器**）。
- **计量按次**：UsageRecord `kind='invoke'`、`quantity=1`、**`unit='flow-run'`**
  （作者重构节点数不给合同变相涨价；`partial`/`failed` 按失败计量、不烧
  配额）；**effectRef = runId**——receipt 直接链到 flow_runs 台账（逐节点
  trace、含委托结果）。command_log 落 `flow-service-run` 审计行
  （agreement + flow + run + autoTrigger 源事件）。
- **terms.trigger 自动执行**（T-035 免费获得）：active 协议 + 匹配注入事件
  → 自动 run 一次（配额耗尽跳过不计量）；**归属分离**——流自己的触发器是
  提供方自动化（不计量），协议触发是消费方合约（计量 + receipt）。

## 策略信封（机制 C：给流程内的 Agent 活动画界）

Flow 级可选元数据 `policy`，约束**该流程内的一切 Agent 活动**（无论入口是
触发器、手动、Agent 还是服务调用）——流程作者对"混合主导"的总闸：

```jsonc
{
  "name": "受界定的削载流程",
  "trigger": { "kind": "event", "eventType": "grid-peak", "zoneId": "zone-a" },
  "policy": {
    "maxDelegationsPerRun": 1,              // 每次运行的委托节点执行上限
    "minConfidenceToActuate": 0.6,          // actuating 委托的置信度门槛
    "onBudgetExhausted": "escalate",        // 'fallback'（默认）| 'escalate'
    "escalate": { "channel": "notification", "toRole": "owner" }  // v1：通知环境所有者
  },
  "plan": { "...": "委托节点（机制 A）+ 动作节点" }
}
```

- **maxDelegationsPerRun**：每次运行的委托节点执行上限。超出的委托节点在
  **咨询 LLM 之前**即被拒绝（零模型成本），走它自己声明的确定性 fallback
  （`fallbackReason: 'budget-exhausted'`，decisionSource `rule`）——与超时 /
  LLM-down 同一条诚实降级路径：`fallback:'none'` 是成功 + no-op 记录，
  `fallback:{policy:'node'}` 是节点失败 + 回退节点带外执行。计数的是
  **执行**（含降级）而非成功；预算按运行重置。
- **minConfidenceToActuate**：actuating 委托的置信度门槛（0–1）。回答的置信度
  低于门槛（**或未给出可用置信度**——保守读法：无法验证即不满足）时，
  **拒绝一切动作**（逐条记录拒绝理由），判断与置信度照常诚实记录，流程按
  advice 语义继续——与 `autoActuateIndependent=false` 同形。
- **优先级链**：sim 级选项 > **flow 信封** > per-agent decisionPolicy > 平台
  默认。信封**只能收紧**：operator 关掉的它开不了，但 agent 策略允许的它
  可以拒（记录的信封理由优先于 agent 策略理由时按此序）。
- **onBudgetExhausted**：耗尽时除逐节点 fallback 外——`'fallback'`（默认）
  静默（拒绝已落在节点结果里）；`'escalate'` 额外把
  `FlowRun.policyEscalations`（`{kind:'budget-exhausted', nodeId, message}`
  列表）落到运行台账，并向**环境所有者**发 `flow-policy-escalation` 通知
  （refId=runId，body 带流程/运行/触发上下文与拒绝清单）。**升级只发信号
  不改流程**：修改权仍是 creator/owner。
- **kill-switch 免费获得**：`enabled:false` 即停（引擎每次评估重读
  flowsProvider，委托车道随之死亡）；被禁用的 assignee 使委托节点显式降级
  并触发 fallback（Fix-44e 已覆盖 Flow 路径）。
- **编写校验**（与运行时同一 oracle）：闭合 schema（拼错的键得到精确 422
  路径）；`escalate` 块但 `onBudgetExhausted≠'escalate'` 是死配置 → 422 教学；
  无委托节点的流带信封 → 警告（当前无物可界）；**自身触发器 + required 无
  default 入参** → 警告（自动触发的运行会诚实落 FAILED 记录——引擎参数门
  绝不代值，见机制 D 的归属分离）。

## Agent 调用面（机制 B：agentInvocable）

Flow 级可选布尔标志 `agentInvocable`（**默认关闭**）：开启后，**作者 T-201
作用域内的 Agent** 可以在它的 LLM 决策答案里点名这条流程作为自己的
"标准作业程序"——决策记录携带 `invokeFlow: {flowId, params}`，执行经
`FlowEngine.runAsAgent` 受治车道：

```jsonc
{
  "name": "夜间节能回退",
  "agentInvocable": true,
  "trigger": { "kind": "event", "eventType": "never", "zoneId": "zone-a" },
  "inputs": [ { "name": "setpoint", "type": "number", "required": true, "min": 16, "max": 26 } ],
  "plan": { "...": "动作/委托节点" }
}
```

- **门在前、执行在后**（全部为运行前判定，被拒时**不落运行记录**，教学理由
  记在决策的 reasoning 上）：
  1. `agentInvocable !== true` → 拒绝（"set agentInvocable: true on the flow"）；
  2. 流不存在/停用 → 拒绝（未知流时列出该 Agent 实际可调用的流清单——
     **幻觉/注入的 flowId 无法越过门**）；
  3. **同租户**：`ownerEligibleForFlowAuthor(agent.ownerUserId, flow.authorUserId)`
     ——T-201 同一 oracle。跨租户复用不走此开关，须发布为 flow-service 并经
     active 协议调用（机制 D；拒绝信息明确指路）。
- **入参走机制 D 的 inputs 校验**（`resolveFlowRunParams` 同一 oracle）：Agent
  传的坏参数（越界/类型不符/未声明的键）**诚实落 FAILED 运行记录**
  （triggerKind `agent`）——绝不静默代值。
- **台账归因**：triggerKind `'agent'` + `invokedBy {agentId, eventId?}`——
  (agentId, eventId) 把运行台账连回决策记录流（决策侧也携带 `invokeFlow`）。
- **信封免费生效**（机制 C 的裁决）：Agent 入口与其它入口一样汇聚到
  `FlowEngine.runFlow`，信封自动约束该次运行内的一切委托活动。
- **诚实的提示面（S1）**：Agent 的 LLM prompt 只列出它**实际可调用**的流
  （同一 oracle 计算的 offering——enabled + flag on + 同租户），带参数契约
  （名字:类型 + required 标记），经 untrusted-block 消毒。无可调用流时提示
  面与 pre-B 逐字节一致。结构化答案 schema 新增可选 `invokeFlow`
  （`{flowId, params}`）；畸形值被丢弃并在 reasoning 记注（不静默）。
- **被采纳的调用取代即兴**：决策同时携带 invokeFlow 且被采纳时，Agent 的
  确定性设备命令车道**不再执行**（流程就是处置本身，叠加即兴会双重动作）；
  调用被拒时回退到设备命令（teaching 理由记在案）。shadow 仿真与既有的
  独立动作门（acMode/decision-only）同样压制调用车道并自报家门。
- **计量**：同租户车道不建协议计量——归因走运行台账（`invokedBy`）。跨租户
  的授权/计量/配额只在机制 D 的协议车道存在（设计 §6 的裁决）。
- **通道**：REST `POST/PATCH /api/.../flows`（`agentInvocable` 布尔，非布尔
  400）、Web 列表只读徽标、CLI `flow add/update --file`（YAML 键 `agentInvocable`，
  显式键替换、缺省键保留）、场景 JSON 内嵌 flows 随导入存活。运行台账列
  `invoked_by_agent_id` / `invoked_by_event_id`（v40 迁移）。

## 治理（T-201）：作者作用域、设备歧义与跨租户拒绝

多租户环境里 Flow 是**作者私有的确定性通道**——三条边界规则在创建/更新时
（422 `FLOW_INVALID`，带逐节点 issue）与运行时（refused 运行记录）**同一套语义**
强制执行（T-051 起，运行时的分配解析与作者侧校验共用同一个可执行性 oracle，
两边的判定不会再分叉）：

1. **作者作用域（author scoping）**：成员创建的 Flow 只能驱动**作者自己的
   Agent/设备**（`flow.authorUserId` vs Agent 的 `ownerUserId`）。环境所有者
   （owner）创建的 Flow 没有作者标记，不受限。没有属主归属的 Agent
   （场景 JSON/模板 Agent、legacy 行）对所有人可见可用——模板 Agent 因此
   仍然是"公共执行器"。跨租户的显式 `assigneeAgentId` 或自动匹配都会被拒绝，
   错误信息指明替代路径：
   > `assignee 'X' is owned by another tenant — flow nodes actuate the flow
   > author's own agents/devices; cross-tenant actuation runs through an
   > agreement invocation (provider-executed, metered)`
2. **跨租户的正确通道是合约（agreement）**：要用别人的 Agent/设备，走合约
   调用（provider 侧执行、计量计费），不要试图把对方写进自己的 Flow——
   拒绝信息本身会教这一点。
3. **设备歧义必须钉定**：同一 assignee 有**多个**绑定设备满足节点能力
   （可执行路径、zone 过滤后）而未钉 `deviceId` 时，创建/更新 422 **报错并列出
   候选设备**（`pin one with node.deviceId or split into per-device nodes`）——
   歧义不再是 warning + 任意选一个（SF-F01：消警 Flow 曾同时触发 turn-off 和
   turn-on 两个设备还报 success 2/2）。钉定的设备必须：存在于当前世界快照、
   绑定在 assignee 名下、经可执行路径提供该能力、且（zone 触发时）位于触发
   zone 内。Web 画布的动作节点表单提供"设备钉定"下拉（只列 assignee 的绑定
   设备）；CLI/场景 JSON 直接写 `"deviceId": "..."`。

### securityFlags（T-078，DevLoop R23）：文本面注入"标记不拒绝"

**裁决**：Flow 保持 builder 直接编写——上面的 T-201 作者作用域就是安全
模型，不设提案车道（理由全文见 design-mixed-initiative-flows.md §8.6：
广度被所有权封顶 + zone 钉定 + 委托预算 + 策略信封，提案车道只是复制
治理）。唯一真实缺口是**文本**：Flow 的 name/description/plan.goal/
delegate 问题会在流程被列出、发布为服务或经 adopt-config 晋升时进入
**其他查看者**的 LLM prompt。收口规则：

- 创建/更新时这些字段过 S1 规范注入检测器（与 prompt 净化器同一张
  模式表）。**命中不拒绝**——Flow 是合法表达，检测器对"Override the
  previous temperature threshold setting"这类运维语言会误报——而是：
  - `validateFlow` 记一条 **warning**（随 FLOW_INVALID 的 issues 一起
    可见）；
  - API 响应（create 201 / PATCH 200 / 列表 / 详情，三通道同形）携带
    派生的 `securityFlags: [{field, marker, evidence}]` 字段；干净流程
    **没有该字段**（常见形状逐字节不变）。该字段每次读取现算（不落库），
    检测模式表扩展会自动重新标记既有流程。
- **标记在治理面强制 human review**：adopt-config 晋升携带被标记的
  flow-definition 时，规则检查 force-escalate（riskLevel high，理由自名
  并点名该流程）——被标记文本永远不会被自动应用进环境。
- **净化兜底**：被标记文本进入任何 LLM prompt 前都会被包裹在
  `<untrusted>` 块中并中和（agent-invocable 流程列表、partner 服务名、
  delegate 问题、提案评审器 payload 四处接缝均有测试钉住）。换句话说：
  标记是给"人"的治理信号；净化是给"模型"的防线——两者缺一不可，
  也互不替代。

## 跨区升级（T-064）：病房呼叫 → 大堂广播

zone 收敛是**设计使然的安全边界**（见上）：`event`/`condition` 触发的 Flow
"zone X 的 Flow 永不触碰 zone Y 的设备"，运行时对跨 zone 动作**显式拒绝**。
当一个 zone 的事件必须驱动**另一个 zone 的设备**（病房呼叫按钮 → 大堂 PA
广播、机房高温 → 消防泵），而目标设备属于**提供方**（别的属主/Agent）时，
正确的通道不是绕过 zone 边界，而是**带触发子句的合约（agreement with
trigger clause）**——T-035 的 AgreementTriggerExecutor 会自动执行它：

> **同属主内的显式跨区：节点级 `crossZone: true`（R1 B1-8）**。zone 收敛的
> 两侧判定（authoring 校验与运行期 invoker）共用同一函数，触发 zone 已声明
> 时跨区钉定在 **authoring 就报错**（错误文案与运行期一致）。若跨区正是意图
> （典型：消防疏散广播——烟感在本区、音柱在每个分区），在节点上声明
> `crossZone: true`，两侧同口径放行，"配置绿灯、着火爆雷"不再存在。
> `event` 触发未声明 zoneId 时运行期按事件实际 zone 收敛，authoring 无法
> 预知——此时跨区钉定给 **warning**（点名运行期将拒绝的文案与 `crossZone`
> 出路），错误级判定仍留给运行期的事件事实。

- **terms.trigger** 声明"何时"（病房事件：eventType + zoneId，可选
  parameter/threshold）；
- **terms.action** 声明"何事"（提供方大堂设备的命令 + 受约束的 params——
  消费方不能扩大或改写约定的动作）；
- 执行走与手动调用**同一条合约执行核心**：条款强制（action 必须是约定
  命令）、设备门（命令必须在提供方设备上可执行）、**计量**（UsageRecord
  kind=invoke + settlement receipt）、**配额**（quotaPerWindow 花尽即跳过，
  与手动 429 同策略）、**归因**（command_log 带 agreementId + autoTrigger
  源事件；设备侧审计字段——显示设备的 `contentSetBy`、门锁的
  `accessLog.by`——记录为 `agreement:<id>`，经 invocation context 传递，
  **不污染命令 params**）。

具体示例（消费方=病房站，提供方=大堂服务台，PA 为 display-panel 设备）：

```jsonc
// POST /api/services/<lobby-pa 的 set-message 派生服务 id>/agreements
{
  "terms": {
    "notes": "病房呼叫 → 大堂 PA 广播",
    "trigger": { "eventType": "patient-call", "zoneId": "zone-ward" },
    "action": {
      "command": "set-message",
      "params": { "content": "3 号病房呼叫，请家属到一楼大厅服务台" }
    },
    "quotaPerWindow": 10,       // 可选：防广播轰炸
    "windowSec": 3600
  }
}
// 提供方 accept → active。此后任何仿真里注入
// POST /api/simulations/:simId/events { "type": "patient-call", "zoneId": "zone-ward" }
// 都会触发：lobby-pa 设备 state.content 更新 + contentSetBy = "agreement:<id>"，
// usage 台账 +1（invoke/success），command_log 归因到合约与病房事件。
```

端到端行为由 `agreements-trigger-autoexec.vitest.test.ts` 的 T-064 用例钉住
（病房事件 → 计量触发 → 大堂 PA set-message，含 params 纯净性断言）。跨区
**读取**条件、per-zone Flow 对、`schedule` 设施级 Flow 见上文 T-312 条目——
那些是**自有设备**的跨区形态；跨租户/提供方设备的跨区动作一律走合约触发。

## 触发器

| kind | 语义 | 关键字段 |
|---|---|---|
| `event` | 匹配注入事件（场景事件或手动注入），先写物理场、**先执行 Flow 再投递 Agent**；触发 zone 取 `trigger.zoneId ?? event.zoneId`——未声明 `zoneId` 时收敛到注入事件所在 zone（仍是 zone 级 Flow，zone 收敛照常生效），声明了则必须与事件相等 | `eventType` / `zoneId` / `parameter`（声明了就必须相等；`zoneId` 缺省时见左列收敛规则）+ `conditions` + `cooldownSimSec`（Fix-44f：可选防抖，外部高频注入源适用） |
| `condition` | 每个仿真 tick 评估环境状态，**false→true 边沿**触发（R40-C1：事件注入的物理写入后有一个**写入后快照点**——在 agent 通道行动前评估一次，防止 agent 先把参数拉回阈值下导致 Flow 永远观察不到边沿；与 tick 评估共用同一评估器与 cooldown/边沿状态，不会重复计数） | `zoneId` + `conditions` + `cooldownSimSec`（触发后防抖）+ `hysteresisSimC`（T-107：复位窗——短于该窗的 false 间歇不复位边沿，阈值抖动不再重复触发；与 cooldown 互补，cooldown 压制触发后的重 fire，不看谓词状态）+ `activeWindowSimSec`（FEAT-01：日内活动窗，见下） |
| `schedule` | 仿真时间定时：一次性 / 周期 / 日内时刻锚点 / 作息相对锚点（FEAT-01） | `atSimTimeSec` / `everySimSec` / `startAtSimTimeSec` / `endAtSimTimeSec` / `atTimeOfDaySec` / `relativeToOccupancy` |

### 时间语义（FEAT-01：日内时刻 / 时间窗 / 作息相对）

三个声明形态覆盖 persona 实撞的作息编排（dorm-life / lab-safety / library-comfort）：

- **每日时刻 `atTimeOfDaySec`**（schedule）：日内秒-of-day（0 ≤ v < 86400，
  `84600` = 23:30）。每个仿真日 `(prev, cur]` tick 窗口跨过
  `day*86400 + atTimeOfDaySec` 时触发一次——「每天 23:30 就寝」不必再手算
  绝对仿真秒。与 `atSimTimeSec`/`everySimSec` 可组合；大 tick 跨多日时每 tick
  至多触发一次（与周期触发同纪律）。按日触发记忆进 checkpoint，休眠恢复
  不复燃；编辑锚点（fingerprint 变化）重新武装。
- **日内活动窗 `activeWindowSimSec: [startSec, endSec]`**（condition）：窗口
  **折叠进边沿谓词**——窗外整体读 false，窗开时谓词已成立即在开窗点产生
  上升沿；窗外物理噪声（宿舍凌晨功率抖动误触削峰流）不会触发。
  `start > end` 跨午夜（22:00–06:00 = `[79200, 21600]`）；`start === end`
  是空窗，validateFlow 报错（教学）。hysteresis/cooldown 语义不变。
- **作息相对 `relativeToOccupancy: { zoneId?, before, offsetSec }`**（schedule）：
  在 occupantSchedule 边界**前** `offsetSec` 秒触发——「到馆前 30 分钟预冷」
  = `{ before: 'arrive', offsetSec: 1800 }`（`before: 'depart'` = 离馆边界）。
  引擎按场景 occupantSchedule 预测表求值（与 due-moments 的 occupancyBoundaries
  同一枚枚举，懒惰推进会为锚点醒来）。`zoneId` 钉定来源 zone（该 zone 必须有
  occupantSchedule，否则 422）；缺省 = 所有带 occupantSchedule 的 zone，每 zone
  每边界每日各触发一次；`repeatDaily: false` 的作息只在 day 0 锚定。
  offset 大于边界时刻时锚点落在前一天小时内（前一日傍晚触发，语义诚实）。
  一个 occupantSchedule 都没有的世界 + 未钉 zoneId = 非阻塞 warning（不会
  静默永不触发）。FEAT-07 二阶段的临时作息覆盖（occupantScheduleOverlay）
  只接管人头流——锚点仍锚**基础作息**（考试周预冷时刻不随 overlay 漂移）。

四通道同语义：Web 画布（触发器节点表单）/ CLI（`eaf flow add --file`，
`eaf scenario validate` 经同一份 validateFlow）/ OpenAPI（FlowTrigger schema）
/ 场景 JSON（`flows[].trigger`）。

**计时基准**：边沿评估与 cooldown 计时都基于**仿真时间**（sim 秒），不是墙钟——
`cooldownSimSec: 300` 指触发后 300 sim 秒内不再重 fire；演示档（高 speed）下
墙钟几秒就走完这 300 sim 秒，但 Flow 看到的节奏与实时档完全一致。

### 委托降级与守卫（T-108 / F16）

`delegate.<节点>.<输出>` 建议-守卫在委托**降级**时（LLM 不可用，或 rule-only
agent 的确定性回退不产出建议输出）读不到路径——守卫为 false，二分守卫的两个
分支（`== "lab-b"` / `!= "lab-b"`）**全部跳过**，运行死路（R29 实测
CleanroomGuard）。两种写法避免：

1. 声明降级泳道：`delegate.fallback { policy: "node", nodeId: "<回退动作节点>" }`
   ——委托失败时回退节点兜底执行一次；
2. 裸条件守卫：守卫直接读环境状态（如 `humidity > 70`），不依赖建议输出，
   建议缺席时仍可求值。

`fallback { policy: "none" }` 是作者的知情选择（不再提示）；未声明 fallback
且守卫引用其输出的流程在保存时收到 WARNING（教学不阻断）。

## 条件

`conditions` 是 `{path, op, value}` 数组，**AND** 语义；OR 用多条 Flow 表达。
`path` 支持两种写法：`temperature`（触发 zone 的参数）或 `living-room.temperature`（限定 zone）。
**节点级 `condition` 守卫同样支持裸参数写法**（Fix-44c：按触发 zone 提升，
与触发条件一致）；`op` 支持 `== != > < >= <=`。

**条件可见哪些参数（T-304 ∪ T-606）**：每 zone 的参数集是
标准七参数（temperature/humidity/light/motion/smoke/co2/pm2_5）∪ 该 zone
baseline **声明**的键 ∪ 本运行时**注入过**的参数名（POST
/api/simulations/:id/events 的 parameter 字段写入）。注入是合法的编排手法
（如 `badge-anomaly-count` 由门禁事件持续写入）；创建/编辑 Flow 时，既非
标准参数也未被任何 baseline 声明的条件路径会得到**非阻塞 warning**
（`validationWarnings` 随创建/编辑响应返回）——运行时注入可让它工作，但
在 zone baseline 里声明该键可使其成为结构化字段（首值可预期、快照始终
可见）。注意：联合集随注入增长——先写条件后注入的场景，注入前条件只是
"尚未满足"，不会回填历史。

**热编辑语义（Fix-44d）**：修改触发器定义会**重新武装**该 Flow——一次性
schedule 改 `atSimTimeSec` 后会在新时刻再次触发；条件触发器改谓词后边沿
状态重置。cooldown 不因编辑重置。

## 三通道

- **Web**：世界视图 →「业务流」→ 画布编辑器（触发器节点 + 动作节点拖拽连线，
  保存时服务端校验并高亮问题节点；运行历史抽屉看节点级 trace，每行标注执行该次
  运行的仿真——Flow 是环境级的，见「运行行为」节）。声明了
  policy 信封的流在列表行带只读警示徽标（信封的编写走 REST/CLI 的
  `policy` 字段——画布暂不编辑流级元数据，与 inputs 面一致）；开启
  `agentInvocable` 的流带只读「Agent 可调用」徽标，运行历史里的 agent
  触发行显示「Agent 调用」触发来源（invokedBy 归因在 run 详情）。
- **CLI**：`eaf flow list/get/add/update/rm/enable/disable/runs`（`add/update --file`
  从 YAML/JSON 读定义，支持委托节点、inputs 面、policy 信封与
  `agentInvocable` 开关——显式键替换、缺省键保留）；`eaf sim
  run-flow <simId> <flowId> [--params '<json>']` 手动触发一次（调试用，参数按
  inputs 面校验）；`eaf service publish --flow <flowId>` 把流发布为服务
  （机制 D）；`eaf agreement invoke <id> --action run --params '<json>'`
  调用流程服务。
- **API / 场景 JSON**：`GET/POST /api/environments/:id/flows`、`GET/PATCH/DELETE
  /api/flows/:id`、`GET /api/flows/:id/runs`（契约见 openapi.yaml；
  `agentInvocable` 布尔于 create/PATCH，FlowRun.triggerKind 含 `agent` 并带
  `invokedBy`）；场景 JSON 可内嵌 `flows` 数组随场景加载（含
  `agentInvocable`，随导入存活）。

## 运行行为

- **acMode=shadow 的仿真中 Flow 引擎整体挂起**（T-302）：Flow 完全不触发——
  无运行记录、无设备写入（也不伪造 would-have-run 记录）。shadow 的承诺是
  绝对的："shadow 仿真永不改变物理状态"同时覆盖 Agent 驱动与 Flow 驱动两条
  通道；Flow 作为用户的确定性通道在 enabled/advisory 模式下照常运行。
- Flow 的 enabled/编辑对**运行中的仿真即时生效**，无需重启（编辑触发器
  会重新武装一次性/边沿状态，见「条件」节）。
- 执行事件上总线（`flow.triggered` / `flow.executed`），仿真事件流与轨迹均可见；
  每次执行落运行台账（每 Flow 保留最近 50 条；runId 为全局唯一 UUID）。
- 单条 Flow 失败不影响引擎与其他 Flow；assignments 不可满足（没有 Agent 能交付
  某能力）在创建/更新时即被 422 拒绝；**触发 zone 不存在同样在创建/加载时
  拒绝**（Fix-44k）；场景 JSON 内嵌的 Flow 在**加载时**做同样的语义校验
  （Fix-44f），且导入道（POST /api/environments）注入与 REST 创作道相同的
  T-002 可执行性 + R13 参数拼写 oracle——非法能力/拼写在导入期即 422
  FLOW_INVALID 带改名提示（BUG-06）；校验通过后内嵌 Flow 在导入环境时
  **自动落库为该环境的 Flow**（Fix-44a）。
- 每环境 Flow 数量上限 50（`FLOW_QUOTA_EXCEEDED`；Fix-44f）。
- 被禁用的 Agent 不会执行 Flow 节点（Fix-44e：Agent 主开关覆盖 Flow 路径）。
- CLI/HTTP 脚注（R26）：Git-Bash 下用 heredoc 传**含非 ASCII 的 JSON** 给
  curl 会出现 `CONTENT_LENGTH_MISMATCH`（heredoc 换行被 CRLF 化，字节数与
  Content-Length 不符）——报错信息已给出解法：改用
  `curl --data-binary @file.json`。

### Flow 是环境级的，运行台账按仿真归因（T-714/R29，F8）

Flow 挂在**环境**上，不属于任何单个仿真：该环境**每一个**运行中的仿真——包括其他
stakeholder 各自开的调试仿真、以及世界会话正本——都会武装并执行同一组 Flow。你的
「晨间预热」也会在同事的仿真里 08:00 准时触发（R29 实测：biz 账号的预热流与中庭
过热守卫在 physics 测试者的仿真里照常执行）。这是设计而非事故：编排是用户资产的
一部分，仿真只是执行器。排查「谁触发的」：查每个 Flow 的运行台账
（`GET /api/flows/:id/runs`），**每条 run 携带 `simulationId`**；画布「运行历史」
抽屉的每一行也标注执行该次运行的仿真。设备与物理场**状态**各仿真独立，互不干扰。

### 多自动化通道写同一设备：last-writer-wins（UX-16）

多条自动化通道（其他启用中的 Flow、active 合约的 `terms.trigger` 触发自动化、
手动 invoke）写**同一设备**时，平台不做互斥也不做调度仲裁：**后到的写入生效**
（last-writer-wins）——确定性、可审计，是既定语义而非缺陷。平台的职责是让冲突
**可见**而不阻断：

- **创作期**：保存 Flow 时若其动作面与其他启用中的 Flow、或 active 合约的触发
  自动化写同一设备，create/PATCH 响应的 `validationWarnings` 点名冲突方与设备
  （画布保存后显示为 warning，不阻断保存）。
- **合约面**：`GET /api/agreements` 列表的完整视图行带 `contentionSummary`
  （冲突合约数 + 共享写入对数）；详情 GET 的 `contentions`（D1）给出具体
  （deviceId, param）冲突对；触发执行时的 command_log 行也带 `contentionWith`
  标记。CLI 列表以 `⚠×N` 列标注。

不希望竞态时的做法：错开触发窗口（schedule/cooldown）、拆分目标设备，或对
合约重新约定条款。

### 条件阈值要给「物理弛豫」留余量（R29，F4）

事件注入写入的 zone 参数随后会被物理场弛豫回 baseline：实测 co2 注入 1400 在首次
条件评估前就衰减回 1000 以下（守卫不触发），注入 5000–9000 则可靠触发；而
schedule/条件流读取的自定义参数（如 `pvOutputW`）也可能按弛豫语义漂移（2100 一例
未见衰减）。编写条件阈值时按「注入值会衰减」预留余量——要么提高注入量级，要么把
该键声明进 zone baseline 使其结构化（首值可预期，见「条件」节）。

### 跨区边界速查（T-312，R29，F2）

per-zone actuation 是安全边界：**动作节点只能驱动触发 zone 内的设备**（pin 其它
zone 的设备在创建/加载时被 422 拒绝，错误信息自带教学）。跨区组合的合法写法：
**schedule** 流可跨区动作（事件/条件流才受触发 zone 约束）；条件里**读**任意 zone
的参数（`roof-garden.pvOutputW` 这类 `zone.param` 路径）不受限；「A 区事件 → 动
B 区设备」用**每 zone 一条流**配对表达（如 cleanroom 密封 + lab-b 净化器两条流）。

## 与 Agent 的分工建议

- 确定性、安全相关、必须可复现的逻辑 → 写成 Flow（如"温度 > 35° 必须关机"）。
- 需要权衡、协作、开放世界判断的逻辑 → 交给 Agent（Flow 执行后的状态 Agent 能看到，
  会纳入它自己的决策上下文）。
