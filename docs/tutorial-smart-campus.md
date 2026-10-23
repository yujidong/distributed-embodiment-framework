# 教程：智慧教室 30 分钟上手（教学楼任务线）

> 这条任务线带你完整走一遍平台的核心闭环：
> **注册 → 导入教学楼 → 启动仿真 → 观察课表/CO₂/空调决策 → 协作治理（成员/提案/审批/审计）→ 沙箱实验 → 回放 → 服务市场**。
> 全部命令均以 `curl` 给出（复制即可跑），关键步骤附 `eaf` CLI 等价写法。
> 本文每一条命令都在当前版本上实际执行过；输出示例做了截断。
>
> 前置：服务已按 [README 快速开始](../README.md) 启动在 `http://localhost:8100`
> （`npm install && npm run build`，然后 `node apps/server/dist/index.js`）。
> **不需要 LLM 后端**（vLLM 等 OpenAI 兼容端点）——本教程全程 rule-only，并如实说明其能力边界。

约定（后文不再重复）：

```bash
BASE=http://localhost:8100
# 每个写操作的 body 都先写进文件再 --data-binary 提交。
# Windows Git Bash 用户注意：curl -d 直接带中文会因 Content-Length 计算错误
# 被服务器拒绝（FST_ERR_CTP_INVALID_CONTENT_LENGTH）——写文件再提交即可避开。
```

---

## 1. 注册与登录（2 分钟）

治理演示需要两个角色：**小明**（环境 owner）和**小李**（builder）。
先各注册一个账号：

```bash
printf '%s' '{"email":"xiaoming@example.edu","password":"campus-2026","displayName":"小明"}' > owner.json
printf '%s' '{"email":"xiaoli@example.edu","password":"campus-2026","displayName":"小李"}' > builder.json

curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' --data-binary @owner.json
# → {"id":"…","email":"xiaoming@example.edu","displayName":"小明","createdAt":"…"}
curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' --data-binary @builder.json
```

> 字段名是 **`displayName`**（不是 `name`）；密码至少 8 位。
> **register 只创建账号、不返回 token**——token 要再调 login 拿：

```bash
curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' --data-binary @owner.json
# → {"token":"eyJhbGciOi…"}
export OWNER_TOKEN=<上面返回的 token>
curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' --data-binary @builder.json
export BUILDER_TOKEN=<小李的 token>
```

CLI 等价（register 会自动登录并保存 token 到 `~/.eaf/config.json`）：

```bash
alias eaf="npx tsx apps/cli/src/main.ts"
eaf auth register --email xiaoming@example.edu --password campus-2026 --name 小明
```

> **Windows 用户注意**（R5 F-02）：Git Bash 下 `--name 小明` 或 `curl -d`
> 内联中文可能按 GBK 字节发出，服务端按 UTF-8 解码后昵称变乱码——请像上面
> 一样用 `--data-binary @file`（文件本身是 UTF-8）。万一昵称已经损坏，
> 用改名接口自救：`PATCH /api/me {"displayName":"新名字"}` 或
> CLI `eaf auth set-name 新名字`（Fix-13）。

## 2. 导入教学楼（3 分钟）

仓库自带一栋三层教学楼场景（`config/scenarios/teaching-building.json`）：
13 个 zone（每层 2 教室 + 走廊 + 楼梯井 + outdoor）、12 台设备
（3 台空调 + 9 个温度传感器）、1 个楼宇设施管理员 Agent、
**19 个课表/天气事件**（8:00 上课 occupancy=40、12:00 午间、18:00 放学、
14:00 冷空气过境）。

把场景 JSON 直接 POST 给环境创建端点，即完成导入（zones 烘焙进地图、
设备/Agent 展开为实例、事件挂到课表，单事务完成）：

```bash
curl -s -X POST $BASE/api/environments \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @config/scenarios/teaching-building.json > env.json
```

```bash
# 记下环境 id，并确认楼层/课表字段没有丢：
node -e "const e=require('./env.json');
console.log(e.id, '| zones:', e.zones.length, '| events:', e.events.length,
          '| devices:', e.devices.length, '| agents:', e.agents.length, '| myRole:', e.myRole)"
# → f777…  | zones: 13 | events: 19 | devices: 12 | agents: 1 | myRole: owner
```

> 正路就是这个端点：`POST /api/environments`（body 带 `meta`/`version`
> 即被识别为场景导入）。旧的 `POST /api/scenarios` 已 **deprecated**——
> 存进去的场景无法实例化成环境，不要再走那条路。

> 也可以先浏览内置模板再导入：`GET /api/scenario-templates`（摘要）/
> `GET /api/scenario-templates/:id`（完整场景 JSON，可直接 POST 给上面的
> 端点）；CLI 等价：`eaf scenario-templates list`、`eaf scenario-templates
> show teaching-building`。Web UI 里对应「新建环境 → 模板」tab 的一键创建。

> 建议 owner 导入后顺手写一段世界导读（Fix-19），后来者进环境第一眼
> 就能读到世界目的与角色边界：`eaf env set-guide <env> --purpose "教学楼
> 能耗优化试验场" --role-viewer "可浏览/跑仿真观察/fork 沙箱，不可改世界"`；
> 配合 `eaf env activity <env>`（世界最近发生了什么）构成后来者的
> onboarding 入口。

## 3. 启动仿真（rule-only）与能力边界（4 分钟）

```bash
ENV_ID=$(node -p "require('./env.json').id")
printf '{"environmentId":"%s","options":{"llmClient":"none","tickMs":100}}' "$ENV_ID" > sim.json
curl -s -X POST $BASE/api/simulations \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @sim.json
# → {"id":"sim-f777…-1","state":"created","llm":"rule-only"}
SIM_ID=<返回的 id>
```

`llmClient` 三档：

- `none`——**rule-only**：确定性规则决策，不需要 LLM 后端，结果可复现（本教程用它）；
- `auto`——Agent 决策走 LLM（服务端须配 `LLM_BASE_URL`/`LLM_MODEL`，指向 vLLM 等 OpenAI 兼容端点；原 `ollama` 预设已移除 R44-B）。

**rule-only 能力边界（如实说明）**：规则 agent 会对事件做确定性处置——
高温事件触发事件 zone 的空调开机（`temperature-control {target:24}`，
随后恒温环按 ±0.5°C 回差维持），但它**不会发起跨 agent 协作**
（协作提案是 LLM 决策的产物）。想看协作，需要配置 LLM 后端（vLLM）。

**`llmWarning`**：如果 agent 声明了 `llm` 而服务端没配 `LLM_BASE_URL`，
`POST /api/simulations` 的 201 响应和 `GET /api/simulations` 列表会带
`llmWarning` 字段（CLI `sim create` 会打印警告）——不会静默降级。
本场景的管理员 agent 未声明 llm，所以看不到这个字段，属于正常。

启动 + 推进。先记住**时间模型**（不再是黑盒）：

- `speed` = **每 tick 推进的仿真秒数**（默认 1）；`tickMs` = tick 的墙钟间隔
  （默认 10ms，可在创建时用 `options.tickMs` 改）。
  例：`speed:60` + 默认 tickMs → 每秒墙钟约跑 100×60=6000 仿真秒；
- `POST …/step {n}` 在暂停状态下精确推进 **n×speed 仿真秒**——
  想"推进到 simTimeSec=X"，就把 speed 设成整除值再 step 相应次数。
- **推进到指定仿真时刻**（Fix-10）：`POST …/step {"toSimTimeSec":28800}`
  （CLI：`eaf sim step --to 28800`）直接按当前 speed 换算 tick 数推进到
  目标时刻——与 `n` 互斥，必须大于当前 simTimeSec，落点可能略超目标
  但小于一个 speed 步长。
- 注意 wall:sim 失真：`speed=60` 时 tick 的真实耗时让墙钟与仿真时间严重
  脱钩（R4 F-14），需要精确时刻的正确做法始终是 **pause + step**（或
  step toSimTimeSec），不要靠"让它跑一会"来凑时间。

```bash
# 8:00 上课铃 = simTimeSec 28800。speed=1000，step 29 次精确越过：
curl -s -X POST $BASE/api/simulations/$SIM_ID/start -H 'Content-Type: application/json' -d '{"speed":1000}'
curl -s -X POST $BASE/api/simulations/$SIM_ID/pause
curl -s -X POST $BASE/api/simulations/$SIM_ID/step  -H 'Content-Type: application/json' -d '{"n":29}'
# → {"id":"…","state":"paused","simTimeSec":29000}
```

## 4. 观察：课表 → occupancy → CO₂（5 分钟）

```bash
curl -s $BASE/api/simulations/$SIM_ID/snapshot > snap.json
node -e "const s=require('./snap.json');
const z=s.zones.find(z=>z.id==='classroom-101');
console.log('t='+s.simTimeSec, '101:', JSON.stringify(z.parameters), 'occupancy:', z.occupancy)"
# → t=29000 101: {temperature:26, …, co2:600} occupancy: 40
```

8:00 课表事件已生效：101 教室 occupancy=40。再推进约 1 个仿真小时，
看 40 个人的热量与呼吸累积：

```bash
curl -s -X POST $BASE/api/simulations/$SIM_ID/step -H 'Content-Type: application/json' -d '{"n":4}' > /dev/null
curl -s $BASE/api/simulations/$SIM_ID/snapshot > snap.json
node -e "const s=require('./snap.json');const z=s.zones.find(z=>z.id==='classroom-101');
console.log('t='+s.simTimeSec,'temp:',z.parameters.temperature.toFixed(1),'co2:',z.parameters.co2.toFixed(0))"
# → t=33000 temp: 48.9 co2: 839
```

温度 +23°C、CO₂ +240 ppm——物理是标定过的（zone 热质量按体积导出），
不是随机数。**注意此时空调没开**：课表 occupancy 事件的规则处置不含
"预判性开空调"，管理员在等一个温度事件（下一节）。

CLI 等价：`eaf sim snapshot $SIM_ID --zones` 给出全 zone 参数表。

## 5. 观察空调决策链（5 分钟）

注入一个高温事件，触发 rule-only 的确定性处置：

```bash
printf '%s' '{"type":"temperature-spike","zoneId":"classroom-101","parameter":"temperature","value":38,"severity":"high"}' > event.json
curl -s -X POST $BASE/api/simulations/$SIM_ID/events \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @event.json
# → {"eventId":"evt-runtime-1","parameter":"temperature","value":38,"targetAgentIds":["71eb…"]}

curl -s -X POST $BASE/api/simulations/$SIM_ID/step -H 'Content-Type: application/json' -d '{"n":3}' > /dev/null
curl -s $BASE/api/simulations/$SIM_ID/snapshot > snap.json
node -e "const s=require('./snap.json');
const z=s.zones.find(z=>z.id==='classroom-101');
const hv=s.devices.find(d=>d.zoneId==='classroom-101'&&d.type==='hvac');
console.log('temp:', z.parameters.temperature.toFixed(1), '| hvac:', JSON.stringify(hv.state));
console.log('decision:', JSON.stringify(s.recentDecisions[0]))"
# → temp: 29.6 | hvac: {"status":"on","targetTemperature":24,"power":true}
#   decision: {"eventType":"occupancy",…,"decision":"handle_independently","decisionSource":"rule"}
```

链路完整可见：事件 → `(rule)` 决策 → 空调下令 `target:24` → 恒温环接管 →
温度从 48.9 回落到 29.6。设备实际接受哪些命令可以直接查（快照里每台
设备的 `commands` 数组，这里是
`["temperature-control","cooling","heating","turn-on","turn-off"]`）。

**决策轨迹**默认开启（JSONL 落在 `data/trajectories/<simId>/`，可用
`EAF_TRAJECTORY_DIR` 或创建时的 `options.trajectoryDir` 改目录），
直接查询：

```bash
curl -s "$BASE/api/simulations/$SIM_ID/trajectory" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
const j=JSON.parse(d);console.log('records:',j.records.length);
const r=j.records[0];console.log(r.decision, '| source:', r.decisionSource)})"
# → records: 7   handle_independently | source: rule
```

## 6. 协作治理：成员 → 提案 → 审批 → 审计（6 分钟）

小李发现 302 教室没有空调。owner 先把他邀请为 builder：

```bash
printf '%s' '{"email":"xiaoli@example.edu","role":"builder"}' > member.json
curl -s -X POST $BASE/api/environments/$ENV_ID/members \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @member.json
# → {"userId":"…","role":"builder","displayName":"小李",…}（邀请即时生效，无接受步骤）
```

builder **不能直改共享世界**（`POST /devices` 会被转成提案或 403），
结构变更走提案管道：

```bash
printf '%s' '{"kind":"install-devices","payload":{"devices":[{"name":"302 空调","type":"hvac","capabilities":["temperature-control","cooling","turn-on","turn-off"],"zoneId":"classroom-302","initialState":{"power":false}}]}}' > proposal.json
curl -s -X POST $BASE/api/environments/$ENV_ID/proposals \
  -H "Authorization: Bearer $BUILDER_TOKEN" -H 'Content-Type: application/json' --data-binary @proposal.json > prop.json
node -p "const p=require('./prop.json'); p.status + ' | ruleCheck.ok=' + p.ruleCheck.ok"
# → escalated | ruleCheck.ok=true
```

规则校验通过（`ruleCheck` 带逐字段明细，失败时会指到具体路径），
非领地安装被 escalate 给 owner。owner 审批——现在有 CLI 一条命令
（R40 起 `eaf` 默认配置文件里登录的就是小明/owner）：

```bash
PROP_ID=$(node -p "require('./prop.json').id")
eaf env proposals decide $PROP_ID --approve --reason "room-302 needs AC"
# → proposal prop-… (install-devices) approved — status: applied
#   created: dev-…（设备已进世界；反悔：eaf env proposals revert $PROP_ID）
```

> `--reason` 内联中文在 Git Bash 下同样受第 1 节 R5 F-02 的编码问题影响，
> 内联请用 ASCII（或换 PowerShell/WSL 再写中文）。

**Web 按钮**是同一条路：世界视图侧栏「应用」tab 的待决提案里，标
「可由我裁决」的行有 批准/驳回 按钮，已生效的提案带 回滚 入口
（确认弹层后执行）；作者等待期间可 催办（10 分钟限一次，
`eaf env proposals remind $PROP_ID` 同义）。

API 等价（直接用 token）：

```bash
printf '%s' '{"decision":"approved","reason":"302 教室确实缺空调，同意安装"}' > decide.json
curl -s -X POST $BASE/api/proposals/$PROP_ID/decide \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @decide.json
# → status: applied
```

审计——每一次世界变更都在 command_log（owner 查全量；其他成员查与自己
相关的条目——自己的操作 + 自己设备收到的命令）：

```bash
curl -s "$BASE/api/environments/$ENV_ID/command-log?limit=5" \
  -H "Authorization: Bearer $OWNER_TOKEN" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
for (const e of JSON.parse(d).entries) console.log(e.kind,'|',e.actor.displayName)})"
# → install-devices | 小李
```

actor 恒为**实际操作者**（提案 applied 记作者，审批人记入
payload.decidedBy）；仿真里的手动设备命令也会落账（kind=device-command，
带 before/after）：

```bash
printf '%s' '{"deviceId":"<hvac-101 的设备 id>","commandName":"temperature-control","params":{"target":26}}' > cmd.json
curl -s -X POST $BASE/api/simulations/$SIM_ID/commands \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @cmd.json
# → {"success":true,…}
```

> 设备命令的 body 字段是 **`commandName`**（不是 `command`）。
>
> 归属语义：仿真是隔离的演练沙箱——成员可在仿真内操控任意设备（不回写
> 共享世界）；唯一例外是绑定 `hass://` 的真实硬件桥接设备，只允许设备
> 主人在仿真中操控（其他人调用返回 403），因为命令可能经 twin-sync
> 传导到真实硬件。

## 7. 沙箱实验（3 分钟）

想"先试试再决定"？fork 一个隔离沙箱——基础层 + 已 applied 提案的完整拷贝，
独立仿真，怎么折腾都不回写共享世界（任何角色包括 viewer 都可以 fork）：

```bash
curl -s -X POST $BASE/api/environments/$ENV_ID/sandboxes \
  -H "Authorization: Bearer $BUILDER_TOKEN" -H 'Content-Type: application/json' -d '{}' > sb.json
SB_SIM=$(node -p "require('./sb.json').simulationId")
curl -s -X POST $BASE/api/simulations/$SB_SIM/start -H 'Content-Type: application/json' -d '{"speed":1000}' > /dev/null
curl -s -X POST $BASE/api/simulations/$SB_SIM/step  -H 'Content-Type: application/json' -d '{"n":30}' > /dev/null
curl -s $BASE/api/simulations/$SB_SIM/snapshot | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
const s=JSON.parse(d);console.log('sandbox t='+s.simTimeSec,'devices:',s.devices.length)})"
# → sandbox t=32000 devices: 13（含刚审批的 302 空调）
```

用完停掉：`curl -s -X POST $BASE/api/sandboxes/<sandboxId>/stop -H "Authorization: Bearer $BUILDER_TOKEN"`。

## 8. 回放（2 分钟）

把一个**墙钟时间窗**内的世界变更（observations + command_log + 仿真侧时序）
离线转成一个可重新运行的场景 JSON：

```bash
FROM=$(node -e "console.log(new Date(Date.now()-3600e3).toISOString())")
TO=$(node -e "console.log(new Date().toISOString())")
printf '{"from":"%s","to":"%s","name":"教学楼首日试运行回放"}' "$FROM" "$TO" > replay.json
curl -s -X POST $BASE/api/environments/$ENV_ID/replays \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @replay.json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
const j=JSON.parse(d);console.log('report:',JSON.stringify(j.report));
console.log('scenario zones:',j.scenario.zones.length,'events:',j.scenario.events.length)})"
# → report: {…,"commandEvents":4,"decisionEvents":3,"zoneSampleEvents":…,…}
```

**回放已含仿真决策与物理演进**（Fix-14）：时间窗内仿真运行的
trajectory 决策/协作记录烘焙为 `sim-decision` 事件（agentId、decision、
reasoning 在 `details` 里），zone 参数周期采样（默认每 60 仿真秒，
`EAF_ZONE_SAMPLE_SIM_SEC` 可配）烘焙为 `zone-sample` 事件
（temperature/CO₂/occupancy 曲线在 `details.parameters`），设备状态变化
烘焙为 `device-state` 事件——刚跑的仿真可以直接复盘，不再是只有命令的
空回放。`mode:"save"` 可存入用户场景库而不是下载。

## 9. 服务市场演示（5 分钟）

环境里的服务目录不是手工登记的：每台绑定设备 × 每条可执行能力自动派生一行
`derived` 服务（解绑即消失、能力变更即刷新，见 service-store 的 derivation
sync）。本文的教学楼有 12 台设备；如果换成太仓校区场景
（`data/devloop/r82-xjtlu/campus.json`，112 台设备 / 8 种类型），派生服务会
自动铺满目录——能源调度员的 11 块电表、安防官的 38 个烟感/人流传感器全部
开箱可见。此外，当 Agent 的能力并集命中平台的语义规则（如楼宇管家集齐
air-quality-monitoring + temperature-control + cooling）时，还会自动出现
`aggregate` 聚合服务（如 campus-air-comfort）。

看看当前环境的服务目录：

```bash
eaf service list --env $ENV_ID --origin derived
# curl 等价：curl -s $BASE/api/environments/$ENV_ID/services
```

可见性三档：`public`（任何能读环境的人，含公开环境的匿名访客）/
`members`（仅环境成员，derived 行的存储默认值）/ `hidden`（仅提供者 owner +
环境 owner）。派生/聚合服务的有效可见性**跟随环境**（设备私有、服务公开）：
环境设为 public 后，members 档的 derived 与 aggregate 服务默认即对匿名访客
开放，无需任何额外开关——

```bash
printf '%s' '{"visibility":"public"}' > demo-vis.json
curl -s -X PATCH $BASE/api/environments/$ENV_ID \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @demo-vis.json
```

如需收回（公开环境但服务仅成员可见），把 mapData 的
`derivedServiceVisibility` 显式拨到 `members`；旋钮只收紧不放宽——非公开
环境下拨 `public` 不生效（防意外泄漏）。

```bash
printf '%s' '{"mapData":{"derivedServiceVisibility":"members"}}' > demo-vis.json
curl -s -X PATCH $BASE/api/environments/$ENV_ID \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' --data-binary @demo-vis.json
```

> mapData PATCH 是**深合并**（R5-F01）：没提到的键（zones、events、
> semanticOfferRules…）原样保留，上面这条只拨可见性开关、不动世界
> 本身。想清空整个 zone 列表必须显式 `zones: []` 并附顶层
> `confirmClearZones: true`（缺确认 409）。

> `hidden` 行永不因此放开——隐私档位是提供者的显式选择；published 服务
> 也保持自己发布时的可见性。

派生服务只覆盖"单设备能做什么"。跨设备的数据产品要显式发布
（`published` origin），再挂一个 computation 把它变成周期性可读的数据服务。
以太仓校区世界为例——全校能耗报表（能源调度员绑定全部 11 块电表，正好满足
`inputs.devices` 只能圈 provider 自己设备的隐私护栏 T-065）：

```bash
eaf service publish --env $ENV_ID --agent campus-energy-manager \
  --name 全校能耗报表 --type energy-report \
  --description "汇总 11 栋学院楼电表的实时功率" --visibility members
# → service published: 全校能耗报表 (svc-…)

eaf service computation register svc-… --spec '{
  "kind":"device-aggregate","refreshSec":60,
  "inputs":{"zones":"*",
    "devices":["bldg-a-meter","bldg-b-meter","bldg-c-meter","bldg-d-meter","bldg-e-meter","bldg-f-meter","bldg-g-meter","bldg-h-meter","bldg-j-meter","bldg-m-meter","bldg-s-meter"],
    "metrics":[
      {"source":"device","capability":"read-power","path":"power","fn":"avg","as":"avgPowerW"},
      {"source":"device","capability":"read-power","path":"power","fn":"max","as":"peakPowerW"}]}}'
```

图书馆环境订阅（`zone-query` 直接聚合 zone 物理参数，无需设备）：

```bash
eaf service publish --env $ENV_ID --agent bldg-d-steward \
  --name 图书馆环境订阅 --type environment-feed \
  --description "D栋图书馆 1F 温湿度/CO2 周期帧" --visibility public
eaf service computation register svc-… --spec '{
  "kind":"zone-query","refreshSec":30,
  "inputs":{"zones":["bldg-d-f1"],
    "metrics":[
      {"source":"zone","path":"temperature","fn":"avg","as":"temperature"},
      {"source":"zone","path":"humidity","fn":"avg","as":"humidity"},
      {"source":"zone","path":"co2","fn":"avg","as":"co2"}]}}'
```

flow-backed 服务：一条声明了 inputs 面的 enabled flow 本身就是可发布的契约
（invoke = 以提供者上下文跑一次 flow，T-201 作者域即安全模型）。太仓校区的
`flow-m-smoke-broadcast` 已带零参签名（`inputs: []`），导入后直接可发布：

```bash
eaf flow list --env $ENV_ID          # 找到 flow-m-smoke-broadcast 的 id
eaf service publish --env $ENV_ID --agent bldg-m-steward \
  --name M栋烟雾应急广播 --type emergency-broadcast --flow <flowId>
# → flow-service published: … invoke: eaf agreement invoke <agreementId> --action run --params '{}'
```

> 没声明 inputs 的 flow 会被 422 `FLOW_INPUTS_REQUIRED` 拒掉——先补签名
> 再发布：`eaf flow update <flowId> --file flow.yaml`（yaml 里加
> `inputs: []`），或 `PATCH /api/flows/<flowId> {"inputs":[]}`。

## 10. 收尾与下一步

```bash
curl -s -X POST $BASE/api/simulations/$SIM_ID/stop > /dev/null   # 停止仿真
```

- 仿真 id 是运行期对象：**服务重启后旧 simulationId 全部失效**（环境/设备/
  提案持久化在 SQLite，仿真不持久化），重新创建即可；
- 想体验 LLM 决策与协作：起 vLLM（`vllm serve ... --served-model-name qwen3-14b-q4`，
  见 docs/deployment.md §5），带 `LLM_BASE_URL`/`LLM_MODEL` 重启服务，仿真用
  `llmClient:"auto"`；
- 声明式玩法：这份教学楼也可以写成 world document 用 `eaf apply` 管理
  （`eaf env export` 可导出），见 [apps/cli/README.md](../apps/cli/README.md)；
- 另一条任务线（Web UI 观光 → 建世界 → 服务嵌入城市）见
  [docs/tutorial.md](tutorial.md)；API 契约全文见
  [apps/server/openapi.yaml](../apps/server/openapi.yaml)。
