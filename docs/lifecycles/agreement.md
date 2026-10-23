# 合约（Agreement）生命周期状态机

> Wave F1-1（docs/plan-r84-verification-framework.md）。本文是合约状态机的唯一事实源之一：
> 状态集合以 `apps/server/src/db/agreement-store.ts:43-60`（`AGREEMENT_STATUSES`）为准，
> 迁移守卫以 `apps/server/src/routes/agreements.ts` 为准。配套的 model-based 测试
> `apps/server/src/agreement-mbt.vitest.test.ts` 把本图编码为可执行模型。
>
> 历史 bug 锚点：**R77-F5**（proposed 滞留无人行动——Wave A5 以 agreement-stale.ts 24h
> sweep + decide 批准时"callable now"通知闭环）、T-059（countered 态与决定权转移）、
> D3/T-080（held 有界暂停）、T-309（remind 催促通道）、**R6-E-F08**（provider agent
> 删除毁约——v60 以 retire + unlink 闭环，见"死亡语义"节）。

## 状态集合

| 状态 | 含义 | 可行动方 | 终态 |
|---|---|---|---|
| `proposed` | 消费方已提议，等待提供方决定 | provider：decide/counter/terminate；consumer：remind/terminate | 否 |
| `countered` | 提供方还价，决定权转移给消费方（深度 1，只此一轮） | consumer：decide/terminate；provider：remind/terminate | 否 |
| `active` | 合约生效，可 invoke/stream/read 计量 | provider：suspend/terminate；consumer：invoke/hold/terminate | 否 |
| `held` | 消费方有界暂停（≤3600s，懒过期自动回 active） | consumer：unhold/terminate；provider：terminate | 否 |
| `suspended` | 提供方暂停 | 双方仅可 terminate（**无 resume 通道，见"已知不对称"**） | 否 |
| `rejected` | 被拒绝（proposed/countered 阶段的 decide reject） | 无 | **是** |
| `terminated` | 任一方终止 | 无 | **是** |

另有 `source='ac'` 的临时合约（ac-agreement-bridge.ts）：出生即 `active`，协作结束时
terminate，不走 propose/decide。

## 迁移表

| 迁移 | 触发 | 行为方 | 守卫（拒绝码） | 副作用 |
|---|---|---|---|---|
| ∅ → proposed | `POST /api/services/:id/agreements`（agreements.ts:130） | consumer | 服务可提议、有背板或有 computation（409 SERVICE_NOT_BACKED）；**R6-B-F01**：aggregate 报价背板为空（invoke 道同款判定：规则可解析 + 绑定设备持有规则 actuates 能力）签约即 409 SERVICE_NOT_BACKED；**R6-C-F02**：terms.targetZoneId 物理不可达签约即 422 SERVICE_ZONE_UNREACHABLE（同 zone/声明相邻/ terms.delivery=propagation 豁免；env 级 `governance.contractReachabilityCheck:false` 可关） | notify provider `agreement.proposed`（含 replyHint）；`publishAgreement('proposed')`；command_log `agreement-transition` |
| proposed → active | `POST …/decide {accept}`（agreements.ts:350,432） | provider | 非 provider 403；非 proposed 409 AGREEMENT_NOT_PROPOSED；**R6-B-F01/R6-C-F02**：accept 前按当前世界重跑签约门禁（世界可能在提议后漂移） | notify consumer `agreement.accepted`（**R77-F5 修复：body 带 `callable:true`**，agreements.ts:459-484）；publish；audit；数据合约触发 freshness obligation |
| proposed → rejected | 同上 `{reject}` | provider | 同上 | notify consumer `agreement.rejected`；publish；audit |
| proposed → countered | `POST …/counter`（agreements.ts:527） | provider | 仅 proposed（409）；terms 必须与原案不同（400）；还价 terms 过同一组签约门禁（R6-B-F01/R6-C-F02） | notify consumer `agreement.countered`（termsDiff + replyHint）；publish；audit（存全量还价 terms） |
| countered → active | `POST …/decide {accept}`（agreements.ts:363-430） | **consumer** | 非 consumer 403（"ball is in the consumer's court"）；对还价 terms 重跑签约门禁（R6-B-F01/R6-C-F02） | 还价 terms 拷入 terms_json（agreement-store.ts:473 `acceptCounter`）；notify provider `agreement.accepted`；publish；audit |
| countered → rejected | 同上 `{reject}` | consumer | 同上 | notify provider `agreement.rejected`；publish；audit |
| active → suspended | `POST …/suspend`（agreements.ts:706） | provider | 仅 active（409 AGREEMENT_NOT_ACTIVE） | notify consumer `agreement.suspended`；publish；audit |
| active → held | `POST …/hold {durationSec≤3600}`（agreements.ts:754） | consumer | 仅 active（409）；1..3600s（400，HOLD_MAX_SEC=agreement-store.ts:393） | notify provider `agreement.held`（带 holdExpiresAt）；publish；audit |
| held → active | `DELETE …/hold`（agreements.ts:831）或**懒过期** | consumer / 系统 | 仅 held（409 AGREEMENT_NOT_HELD） | 显式 resume：notify provider `agreement.resumed`；懒过期（`settleExpiredHold`，agreement-store.ts:438）在读/触发边界静默翻回，**无通知** |
| 任意非终态 → terminated | `POST …/terminate`（agreements.ts:870） | 任一方；**env owner**（v60/R6-E-F08：provider 失联合约的最后收口方，双方均收通知） | rejected/terminated → 409 AGREEMENT_TERMINAL；非当事方且非 env owner 403 | notify 对方（env owner 终止时 notify **双方**）`agreement.terminated`；publish；audit |
| **provider agent 删除**（系统迁移，v60/R6-E-F08） | `DELETE /api/agents/:id` 与 remove-agents 提案 apply | 系统（`AgreementStore.retireProviderAgreements`） | 仅下表现有边组合，无新状态/边 | 见"死亡语义"节 |
| proposed/countered（不变） | `POST …/remind`（agreements.ts:622） | 等待方（proposed→consumer 催 provider；countered→provider 催 consumer） | 非等待方 403（**先于**状态检查：守卫顺序 visibility 404 → 等待方 403 → 状态 409，agreements.ts:627-645）；其他状态 409；10 分钟窗口（REMIND_WINDOW_MS，agreements.ts:122）内重复 → 429 REMIND_RATE_LIMITED（带 earliestAt 锚点） | notify 决定方 `agreement.reminded`（replyHint）；**无状态迁移**；T9 起另落**提醒落痕**（v63 列 `last_reminded_at`/`remind_count`，`updated_at` 不动——提醒不是迁移），get/list/响应三面可读「已提醒 N 次，最近 <时刻>」；provider 为 agent 的 proposed 提案顺触发一次确定性应答判定（见"agent provider 确定性应答"节） |
| active（不变） | `POST …/invocations`（agreements.ts:918） | consumer | 非 consumer 403；held → 409 AGREEMENT_HELD；非 active → 409 AGREEMENT_NOT_ACTIVE；配额窗口超 → 429 QUOTA_EXCEEDED | 追加 usage_records（kind=invoke，agreement-store.ts:555，**append-only**）；结算 receipt；command_log `device-command`（effectRef） |
| proposed（不变） | stale sweep（agreement-stale.ts:48，server.ts:1379 接线：boot + 每小时） | 系统 | created_at 超过 24h（STALE_PROPOSAL_THRESHOLD_MS，agreement-stale.ts:30） | 每 (provider, env) 聚合一条 `agreement.proposed-stale`；dedupeUnread + 24h 重通知窗口（agreement-stale.ts:32）降噪 |
| proposed（不变，provider 为 agent 时） | **agent provider 确定性应答**（remind 触发，agreements/provider-decision.ts） | 系统（规则判定，无 LLM） | 仅 proposed 且 `provider_agent_id` 非空；走既有 proposed→active / proposed→rejected 边，**零新增迁移** | accept/reject 沿用 decide 道的全部副作用（notify + publish + audit，`decidedBy: 'provider-agent:auto'`）；reject 的 reason 落 `status_reason`；判定不了（retired/unlinked 行）→ 保持 proposed |

**非当事方/非 env owner**：变更端点（decide/counter/suspend/hold/terminate/invoke/reads/
stream）一律 404（与不存在不可区分）。**读端点（get/usage/receipts）自 T6（R2 u4-F2）
起与列表口径对齐**，见下节。

## 可见性（T6，R2 u4-F2：列表能看到的，详情就读得到；T30，R3：两侧同受限）

R5-F06 已裁定「已完成的协作是世界历史」：`GET /api/agreements?include=terminated`
向 env 成员开放 terminated 行，公开环境还向陌生人开放（R5-F08）。
T6 之前 `get/usage/receipts` 对同一批读者一律 404——列表给了 id、详情说"不存在"
（u4 的"半张票"）。裁定：**读端点与列表同口径**。
T30（R3 u2-F-02）补齐另一半：**非当事方成员在 list 与 get 读 terminated
一律受限视图**——列表此前用完整序列化绕过了详情道的匿名化（owner 身份
与 terms 在 list 行全给了）。当事方与 env owner 的完整视图不变；
active/held/proposed/countered 可见性零变化；状态机零变化（纯读侧）。

| 读者 × 状态 | get / usage / receipts | list（?include=terminated） |
|---|---|---|
| 当事方 / env owner × 任意状态 | 200 完整视图（不变） | 200 完整视图行（不变） |
| env 成员（非当事方）× terminated | 200 **受限视图**（`view: 'restricted'`） | 200 **受限视图行**（T30：与 get 逐字段一致） |
| 公开环境任意读者（含匿名）× terminated | 200 **受限视图**（与列表 R5-F08 逐字同口径：参与者以 agent 呈现、服务名、outcome、时间、计量行——无 owner 身份，隐藏服务保持 T-308 占位） | 200 **受限视图行**（不变） |
| 成员/陌生人 × 非 terminated | 404（存在性保护不变） | 不出现（不变） |
| 私有环境陌生人 × terminated | 404（列表本就看不到，详情也不开） | 不出现（不变） |

受限视图是**只读的过去**：不改变任何迁移、不暴露 owner 身份、不给陌生人任何
live 行的存在性线索。状态机零变化（本节只动读侧序列化）。

## terminated 的 outcome 口径（派生标签，非状态；T34，R3）

terminated 行的 `outcome` 是**读时派生的展示标签**（唯一事实源
`terminatedAgreementOutcome`，digest / 受限视图 / get 共用），不是生命周期
状态、不参与任何迁移：

| 情形 | outcome |
|---|---|
| 有计量行（任一 kind） | 最新一行的计量 outcome（success / partial / failure 优先） |
| AC ephemeral，无计量行 | `cancelled`（executor 从未运行） |
| explicit，从未 active（`activated_at` NULL） | `cancelled`（R5-F09：未生效不能叫完成） |
| explicit，曾 active，0 计量行 | `ended-without-delivery`（T34：已生效但未发生交付——旧口径 'completed' 把账实不符说成了完成；历史行读时按新口径重派生，无迁移） |

状态机零变化：outcome 派生不增删任何迁移边（`*-mbt` 与 `formal/` 零扩张）。

## 死亡语义（v60，R6-E-F08）

provider agent 被删除（owner 直删或 remove-agents 提案 apply）时，其合约**不再被
FK CASCADE 物理删除**。删除路径先执行 `AgreementStore.retireProviderAgreements`：

| 删除前状态 | source | 删除后状态 | 依据的现有边 |
|---|---|---|---|
| active | explicit | `suspended`（`status_reason='provider-unavailable'`） | active → suspended（ProviderSuspend） |
| held | explicit | `suspended`（清 hold 期限，同因） | held → active → suspended 的组合净效果 |
| proposed / countered | explicit | `rejected`（同因） | proposed/countered → rejected（dead offer 不可被 decide 的地雷被拆除） |
| active / held | ac | `terminated`（同因；无计量行时 outcome 口径 = cancelled） | 任意非终态 → terminated |
| rejected / terminated | 任意 | **不动**——历史保留 | — |

随后所有行（含终态历史）被 **unlink**（`service_id`/`provider_agent_id` → NULL），
FK 动作保持 CASCADE 不变——级联只是再也匹配不到这些行。usage_records /
settlement_receipts 随之幸存。

**R100（agreement-row-integrity，wang-07）：同一纪律推广到服务行删除。**
`ServiceStore.deleteService` 是所有服务行删除的唯一收口（T-403 派生服务再生、
设备删除的 `deleteDerivedForDevice`、服务直删）：删除前先
`retireServiceAgreements`——映射与 v60 相同（AC→terminated、待决→rejected、
active/held→suspended），`status_reason='service-unavailable'`，随后
`service_id → NULL`（`provider_agent_id` 保留——agent 通常存活）。蓝图卸载
（agent 走 v60 provider 道 retire、设备先经 `deleteDerivedForDevice` 收口）与
install-agents revert（补挂 v60 retire）同步收口。至此没有任何代码路径物理
删除合约行；env 删除仍是整体世界 teardown（唯一剩余的 CASCADE 域，见下）。
T-403 的 `agreement.derived-regenerated` 通知与流广播改报落地状态（不再发
`deleted`——该流动作已无任何发出方，枚举保留兼容）。

- **原因列**：`status_reason`（v60 新列）只由平台事件写入；party 驱动的迁移恒为
  NULL（setStatus 清除旧值）。API 透出为增量字段 `statusReason`。
- **世界可见性**：每次 retire 迁移落 `agreement-transition` 审计行 + env 流广播
  （suspended/rejected/terminated）+ 消费方持久通知
  （`agreement.provider-removed`）；arrival digest 新增 **env-owner 专属**
  `providerUnavailableAgreements` 区（suspended + provider-unavailable 行），
  memo 失效信号携带最新 retire 时间戳（R5-F07 同型）。R5-F08 受限视图口径不变。
- **不自动恢复**：agent 复活/重新注册/revert 都不复活 retired 合约——没有也不新增
  suspended → active 边。remove-agents revert 只做 relink（引用恢复，状态保持
  retired）。显式收口走现有 terminate 通道（当事方或 env owner）。
- **TLA 影响**：迁移集合零扩张（上表全是 CollabProtocol.tla 已有的边，只是执行方
  多了"系统"与 env owner），formal/ 规约无需改动；活性/不变量结论不变。
- **未覆盖（遗留）**：blueprint 卸载与 install-agents revert 的批量拆除道仍是物理
  级联；stale（心跳失联但 agent 未删）不提供 failover（存量 active 合约维持
  active，新消费被既有 stale 硬门拒）——完整 failover 扫描是 R6-E-F17。

## 监护机制（防 R77-F5 类滞留）

1. **stale sweep**（agreement-stale.ts）：proposed 超 24h 必被捞起并聚合提醒 provider。
   注意：**countered 不在 sweep 范围**（等待方是 consumer，其侧靠 provider 的 remind 通道；
   这是当前语义的决定，见"遗留风险"）。
2. **remind**（T-309/T-059 §5.4）：proposed/countered 双方各有催促通道，10 分钟限流。
   T9 起提醒在协议行留痕（`last_reminded_at`/`remind_count`，v63），且 provider 为
   agent 时触发一次确定性应答判定。
3. **decide 通知**（Fix-16 + Wave A5）：任何 decide/counter/suspend/hold/unhold/terminate
   都给对方落持久通知 + env 流广播，双方不需要轮询即可知情。
4. **held 有界**：上限 3600s + 懒过期，held 不可能成为永久免费层。

## agent provider 确定性应答（T9，R2 u2-F5/u4-F7/B1-10 MVP）

**问题**：provider 为 agent 的 proposed 提案，在 provider owner 离线时无限悬置
（u2：3 份提案挂 3.2 小时，`agreement remind` 只回执"已提醒"无后续）——跨组织
签约闭环强依赖对方在线。

**MVP 裁定（生命周期零改动）**：remind 触发时，若 `status='proposed'` 且
`provider_agent_id` 非空，运行**一次确定性可交付性评估**
（`agreements/provider-decision.ts` 的 `assessProviderDeliverability`）——复用
签约门禁（R6-B-F01/R6-C-F02）这同一判定源，三态：

| 判定 | 动作 | 语义 |
|---|---|---|
| 全部可交付（门禁全过，或有 computation 的数据服务） | accept → **active** | 走正式 decide-accept 机制：proposed→active 既有边、notify consumer（`decidedBy: 'provider-agent (deterministic…)'`）+ publish + audit（`decidedBy: 'provider-agent:auto'`，`trigger: 'agreement.remind'`） |
| 明显不可交付（规则不可解析 / 无 actuation 背板 / 零可执行命令 / zone 不可达 / unbacked 且无 computation） | reject（带 reason）→ **rejected** | reason 落 `status_reason`（0a38ba69 的 reason 通道），audit/通知同上 |
| 判定不了（service/agent 行已 unlink 或不存在——retired 行） | **hold**：保持 proposed | 诚实边界：拿不准的不替人做主 |

- **确定性**：同输入同输出，无 LLM、无超时、无重试——语义判断（该不该接）仍属
  人类/协作协议道；本道只做「可交付性可判定」的两端。
- **状态机不变**：只走既有 proposed→active / proposed→rejected 边，TLA 迁移集合
  零扩张，`agreement-mbt` 不变。
- **明确不做（Batch 3 候选）**：超时自动过期/自动拒绝（proposed 的新自动迁移，
  需 TLA/MBT 同步另立）。
- **决策位可见性**：`agreement get`/`list` 的状态即决策位（proposed→provider 侧、
  countered→consumer 侧）；agent provider 的待决提案在 `eaf agent get` 有一行
  pending 列表（owner 视角，服务端按当事方范围过滤）。

## 不变量（MBT 断言对象）

- A1 合法迁移图：只有上表中的迁移返回 2xx；`rejected`/`terminated` 是终态（之后任何
  操作 403/404/409 且状态不变）。
- A2 计量门禁：仅 `active` 可 invoke；`held` 得到专属 409 AGREEMENT_HELD。
- A3 决定必知：任何成功的 decide/counter/suspend/hold/unhold/terminate 都在
  notificationStore 给对方留下对应 kind 的通知（refId = agreementId）。
- A4 滞留捞起：任何 proposed 且 created_at 超 24h 的合约必然出现在
  `sweepStaleProposedAgreements` 的 stale 集合里，且首轮 sweep 向 provider 投递聚合提醒。
- A5 用量台账 append-only：`usage_records` 行数对任何操作序列单调不减。
- A6 可见性：stranger 对一切**变更**端点得到 404；读端点（get/usage/receipts）自
  T6 起与列表同口径——terminated × 公开环境（或成员）读受限视图，其余 404
  （见"可见性"节）。

## 已知不对称（设计现状，非 bug，供 F5 TLA+ 复核）

- `suspended` 无 resume 通道：提供方 suspend 后双方都只能 terminate。设计文档
  （service-consumption-design.md §3.1）本就没有 resume 迁移；不违反"无可行动方"
  不变量（双方都能 terminate），但"提供方误 suspend"没有撤销路径。v60 起 env
  owner 也可 terminate（R6-E-F08 的 provider 失联合约收口），但不改变"无 resume"
  这一不对称本身。R99（zhao-09）起该不可逆性对用户**显式可见**：CLI
  `eaf agreement suspend` help 与执行后提示、API suspend 响应
  （`irreversible: true` + `note`）、Web suspend 按钮二次确认、resume 对
  suspended 合约的 409 文案都说明"不可恢复，正路是 terminate 或 consumer
  的 hold（可自动恢复的暂停）"——状态机本身不变（TLA 迁移集合零扩张）。
- 懒过期的 held → active 不通知（agreement-store.ts:438 注释明确：只有显式 DELETE
  才发 `agreement.resumed`）。
