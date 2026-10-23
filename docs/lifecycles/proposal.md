# 提案（Proposal）生命周期状态机

> Wave F1-1（docs/plan-r84-verification-framework.md）。状态集合以
> `apps/server/src/db/proposal-store.ts:42-60`（`PROPOSAL_STATUSES`）为准，状态机驱动
> 逻辑全部在 `apps/server/src/proposal-service.ts`。配套的 model-based 测试
> `apps/server/src/proposal-mbt.vitest.test.ts` 把本图编码为可执行模型。
>
> 历史 bug 锚点：R33（同 env 提交管道串行化，proposal-service.ts:209-230）、
> R33/Care F2（escalated 滞留 → proposal remind 通道）、T-004（auto-apply 后 owner
> 无感 → proposal.auto_applied 通知）、Fix-18（auto-decide 的 verdict 必须穿透
> 自回声降噪到达作者）。

## 状态集合

| 状态 | 含义 | 终态 |
|---|---|---|
| `submitted` | create 时的初始占位（库层默认；service 实际以 `rule_check` 建行） | 否（瞬时） |
| `rule_check` | 确定性规则校验中 | 否（瞬时，submit 调用内完成） |
| `ai_review` | AI 语义审查中 | 否（瞬时，submit 调用内完成） |
| `escalated` | 等待 owner（或 zone-claim 委托方）裁决 | 否（**唯一可驻留的非终态**） |
| `approved` | 已批准、待 apply | 否（瞬时：approve 与 apply 在同一调用内接连发生） |
| `applied` | 已写入世界 | 否（可 revert） |
| `rejected` | 被拒（规则/AI/owner 任一关口） | **是** |
| `reverted` | applied 后被逆操作回滚 | **是** |

关键结构事实：**submit 是同步漏斗**——一次 `submit()` 调用必然以
`rejected` / `escalated` / `applied` 三者之一返回（proposal-service.ts:251-356），
`rule_check`/`ai_review`/`approved` 永不持久驻留。"pending 永久滞留"在漏斗内结构性
不可能；唯一可驻留的 `escalated` 恒有行动方（owner/委托方）且有通知 + remind 双通道。

## 迁移表

| 迁移 | 触发 | 守卫 | 副作用 |
|---|---|---|---|
| ∅ → rule_check | `POST /api/environments/:id/proposals` → `ProposalService.submit`（proposal-service.ts:241；同 env 串行管道 enqueue） | 作者须为 builder 及以上（路由 403） | publishProposal `submitted` |
| rule_check → rejected | 规则校验失败（proposal-service.ts:272） | — | notify 作者 `proposal.rejected`（allowSelf，Fix-18）；publish `rejected` |
| rule_check → ai_review | 规则通过（proposal-service.ts:280） | — | 无广播（内部漏斗步骤） |
| ai_review → escalated | 高风险标记 forceEscalate（proposal-service.ts:294，可带 AI advisory）；或 reviewer verdict=escalate（proposal-service.ts:347） | — | notify env owner `proposal.escalated`（replyHint 指向 decide）；zone-claim 且存在活跃委托时同时 notify 委托方（T-072，proposal-service.ts:798-825）；publish `escalated` |
| ai_review → rejected | reviewer verdict=reject（proposal-service.ts:340） | — | notify 作者 `proposal.rejected`；publish `rejected` |
| ai_review → approved → applied | reviewer allow（:350）或 zone-claim 自治低风险（:318，source='zone-claim'）或 no-LLM/超时低风险兜底（EscalatingReviewer，proposal-reviewer.ts:72-91，source='rule-fallback'/'review-timeout-auto-approve'） | zone-claim 自治守卫：riskLevel=low 且提案全部 zone 足迹被作者持有的活跃 claim 覆盖（仅 install-devices/inject-scenario/install-agents 足迹可判定，coversByZoneClaims，proposal-service.ts:918）；三条路径共用：apply 前**规则复检**（proposal-service.ts:444），世界已变则转 rejected | 写世界 + command_log（actor=作者，decidedBy=批准人/null）；notify 作者 `proposal.applied`；**reviewer_id 为空（无人工裁决）或委托裁决时另 notify owner `proposal.auto_applied`/`proposal.delegate-applied`（T-004，proposal-service.ts:864-892）**；publish `applied` |
| escalated → approved → applied | `POST /api/proposals/:id/decide {approved}`（routes/proposals.ts:214 → proposal-service.ts:364） | 非 escalated → 409 PROPOSAL_NOT_DECIDABLE；非 owner/非委托方 → 403（requireDecideAccess，routes/proposals.ts:452） | 同上（decidedBy=裁决人，decidedVia=owner/delegate） |
| escalated → rejected | 同上 `{rejected}` | 同上 | notify 作者 `proposal.rejected`；publish `rejected` |
| applied → reverted | `POST /api/proposals/:id/revert`（routes/proposals.ts:376 → proposal-service.ts:518） | 非 applied → 409 PROPOSAL_NOT_APPLIED；非作者且非 env owner → 403；install-zones 的 zone 已被占用 → 409 PROPOSAL_NOT_REVERTIBLE | 逆操作 apply 条目；command_log `revert:<kind>`；notify 作者 `proposal.reverted`（**作者自助 revert 时被自回声降噪丢弃**——设计使然）；publish `reverted` |
| escalated（不变） | `POST /api/proposals/:id/remind`（routes/proposals.ts:254） | 仅作者；10 分钟限流（429 带锚点） | notify owner（+委托方）`proposal.reminded`；**无状态迁移、无过期** |

每次用户可见的状态变化都由 `transition()`（proposal-service.ts:753）统一广播
（STREAM_ACTION_BY_STATUS，:97-104；内部步骤 rule_check/ai_review 不广播）。

## 监护机制

1. **escalated 通知 + replyHint**（notifyTransition，proposal-service.ts:771）：owner 收件箱
   即行动面。
2. **remind 通道**（R33/Care F2）：作者可催促，10 分钟限流；proposal **没有过期/自动拒绝**，
   escalated 可以无限期驻留（"无 SLA"是显式设计），但任何时候 owner/委托方都可 decide。
3. **T-004 自知情**：auto-apply（无人工裁决）必达 owner；owner 裁决的 apply 不再重复通知
   owner（裁决者自知）。
4. **R33 串行管道**：同一 env 的 submit 管线串行，后提交的提案必然看到先提交者的世界效果。

## 不变量（MBT 断言对象）

- P1 漏斗无滞留：submit 返回后状态 ∈ {rejected, escalated, applied}；
  `submitted`/`rule_check`/`ai_review`/`approved` 在任何观测点都不持久出现。
- P2 终态与准终态：rejected/reverted 后 decide/revert 均 409；applied 只能 revert，
  escalated 只能 decide。
- P3 裁决权：仅 owner（或 zone-claim 活跃委托方）可 decide（403 其余）；仅作者或
  env owner 可 revert（403 其余）。
- P4  verdict 必知：applied/rejected 必达作者（含 auto 路径，allowSelf 穿透自回声）；
  escalated 必达 owner。
- P5 auto-apply 必知 owner：reviewer_id 为空的 applied 必有 `proposal.auto_applied`
  达 owner（T-004 治理约定）。
- P6 审计闭环：applied ⇒ command_log 存在 apply 条目；reverted ⇒ 存在 `revert:<kind>` 条目。

## 与合约生命周期的对照

合约是双边市场行为（不过提案管道，agreements.ts:13-16 头注）；提案是单边世界变更
（过治理漏斗）。两者的"防滞留"结构对称：可驻留态（proposed/countered ↔ escalated）
都配"通知决定方 + 等待方 remind"双通道；合约多一个平台侧 stale sweep（R77-F5 的直接
教训），提案侧目前是"无 SLA、但不缺行动方"的显式设计。
