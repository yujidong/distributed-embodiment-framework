--------------------------- MODULE CollabProtocol ----------------------------
(***************************************************************************)
(* Wave F5（docs/plan-r84-verification-framework.md）：                     *)
(* 「合约 + 提案 + 同意」协作协议的形式化规约。                              *)
(*                                                                         *)
(* 唯一事实源（本 spec 从它们倒推）：                                       *)
(*   - docs/lifecycles/agreement.md（apps/server/src/routes/agreements.ts） *)
(*   - docs/lifecycles/proposal.md（apps/server/src/proposal-service.ts）   *)
(*   - docs/design-consent-semantics.md                                     *)
(*                                                                         *)
(* 建模范围：单环境内 1 provider + 1 consumer + env owner（+ zone-claim     *)
(* 裁决委托方）三方/四方，合约与提案两条生命周期在同一 Next 下任意交错。     *)
(*                                                                         *)
(* 抽象决策（有意为之）：                                                   *)
(*   - 提案的 submit 同步漏斗（submitted/rule_check/ai_review/approved 四    *)
(*     个瞬态）折叠为单个 Submit 动作，非确定地落到 rejected/escalated/      *)
(*     applied 之一——与 proposal.md "P1 漏斗无滞留" 同构：瞬态在任何观测点   *)
(*     都不持久出现，故模型里不分配状态。apply 前的规则复检（世界已变则转    *)
(*     rejected）折叠进非确定性 outcome。                                   *)
(*   - remind（T-309/T-059，10 分钟限流）是无状态迁移的催促通道，建模为      *)
(*     有界计数（纯建模边界，协议里限流不限总次数）；它对安全性/活性结论     *)
(*     均无影响，保留只为让 trace 可读。                                    *)
(*   - 通知投递（A3/P4/P5）只建模改变"谁知情"的两条：auto-apply 与           *)
(*     delegate-apply 必达 owner（T-004/T-072），见 ownerAutoNotified。      *)
(*     其余通知不改变状态机行为，略。                                       *)
(*   - revert 的 "install-zones 已被占用 → 409" 折叠为 Revert 的非确定性     *)
(*     可用性（owner/作者总能试，成败不影响协议级结论）。                   *)
(*                                                                         *)
(* 已知不对称（docs/lifecycles/agreement.md §已知不对称，特意在模型中       *)
(* 保留并让 TLC 复核，见 README 的 findings）：                              *)
(*   (i)  suspended 无 resume 通道：suspend 后双方只剩 terminate。模型用     *)
(*        不变量 StrictActionable（在 CollabProtocolAsym.cfg 中启用，预期    *)
(*        违反）定量刻画：suspended 是唯一没有"非 terminate 前进动作"的      *)
(*        状态。宽松定义（terminate 恒可用 ⇒ 无无主状态）由                  *)
(*        ActionabilityExhaustive 覆盖。                                    *)
(*   (ii) countered 不在 stale sweep 范围（agreement-stale.ts 只捞           *)
(*        proposed）：模型中 StaleSweep 的使能条件刻意只含 proposed。        *)
(*        countered 的兜底是 provider 的 remind 通道，无平台侧兜底——        *)
(*        这反映在活性属性上：ProposedResolved 有 sweep 保证，countered      *)
(*        的解决只能依赖 consumer 终会响应的公平性假设。                    *)
(*   (iii) held 懒过期回 active 不发通知：HoldExpire 与 ConsumerUnhold 同    *)
(*        效（状态机层面），通知差异不建模。                                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxAg,      \* 合约实例数上界（终态后允许重新 propose，限深保证状态有限）
    MaxPr,      \* 提案实例数上界（同上）
    MaxRemind,  \* remind 次数上界（纯建模边界）
    MaxUsage,   \* invoke 计量次数上界（纯建模边界）
    MaxDeleg    \* 委托授予/撤销次数上界（纯建模边界）

VARIABLES
    \* ---- 合约侧（agreement.md） ----
    ag,                 \* none|proposed|countered|active|held|suspended|rejected|terminated
    agCount,            \* 已创建的合约数（含已终结）
    staleReminded,      \* 24h stale sweep 是否已对本合约聚合提醒过 provider
    reminds,            \* 本合约已用 remind 次数（建模边界）
    usage,              \* usage_records 行数（append-only，A5）
    privacyViolation,   \* 计量门禁违例标志：非 active 状态被计量即置 TRUE（永不应为 TRUE）
    agWasTerminal,      \* 历史标志：合约曾进入终态（用于"终态不可逆"不变量）
    \* ---- 提案侧（proposal.md） ----
    pr,                 \* none|escalated|applied|rejected|reverted（漏斗瞬态已折叠）
    prCount,            \* 已提交的提案数
    prKind,             \* none|normal|zoneClaim
    delegationActive,   \* zone-claims scope 当前是否有生效委托（T-072）
    delegChanges,       \* 委托变更次数（建模边界）
    decidedBy,          \* none|owner|delegate（当前提案的裁决来源）
    ownerAutoNotified,  \* 无人工裁决/委托裁决的 applied 是否已通知 owner（T-004）
    prWasTerminal       \* 历史标志：提案曾进入终态

vars == <<ag, agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal,
          pr, prCount, prKind, delegationActive, delegChanges, decidedBy,
          ownerAutoNotified, prWasTerminal>>

agVars == <<ag, agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
prVars == <<pr, prCount, prKind, delegationActive, delegChanges, decidedBy,
            ownerAutoNotified, prWasTerminal>>

AgTerminal == {"rejected", "terminated"}
PrTerminal == {"rejected", "reverted"}

----------------------------------------------------------------------------
Init ==
    /\ ag = "none"          /\ agCount = 0      /\ staleReminded = FALSE
    /\ reminds = 0          /\ usage = 0        /\ privacyViolation = FALSE
    /\ agWasTerminal = FALSE
    /\ pr = "none"          /\ prCount = 0      /\ prKind = "none"
    /\ delegationActive = FALSE                 /\ delegChanges = 0
    /\ decidedBy = "none"   /\ ownerAutoNotified = FALSE
    /\ prWasTerminal = FALSE

----------------------------------------------------------------------------
(* ============================ 合约生命周期 ============================ *)

\* consumer 提议（agreements.ts:130）。终态后允许重提（限深 MaxAg）。
Propose ==
    /\ ag \in {"none"} \cup AgTerminal
    /\ agCount < MaxAg
    /\ ag' = "proposed" /\ agCount' = agCount + 1
    /\ staleReminded' = FALSE /\ reminds' = 0
    \* 新实例：终态历史标志重置（TerminalIrreversible 是按实例断言的）
    /\ agWasTerminal' = FALSE
    /\ UNCHANGED <<usage, privacyViolation>> /\ UNCHANGED prVars

\* provider 决定（proposed 态，agreements.ts:350,432）
ProviderDecideAccept ==
    /\ ag = "proposed" /\ ag' = "active"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

ProviderDecideReject ==
    /\ ag = "proposed" /\ ag' = "rejected" /\ agWasTerminal' = TRUE
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation>>
    /\ UNCHANGED prVars

\* provider 还价（agreements.ts:527）。谈判深度 1：仅从 proposed 进 countered，
\* countered 上再次 counter → 409（本模型中该动作根本不便能）。
ProviderCounter ==
    /\ ag = "proposed" /\ ag' = "countered"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

\* countered 态 decide 权转移给 consumer（T-059："ball is in the consumer's court"）
ConsumerDecideAccept ==
    /\ ag = "countered" /\ ag' = "active"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

ConsumerDecideReject ==
    /\ ag = "countered" /\ ag' = "rejected" /\ agWasTerminal' = TRUE
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation>>
    /\ UNCHANGED prVars

ProviderSuspend ==    \* agreements.ts:706，仅 active
    /\ ag = "active" /\ ag' = "suspended"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

ConsumerHold ==       \* agreements.ts:754，仅 active，durationSec<=3600
    /\ ag = "active" /\ ag' = "held"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

ConsumerUnhold ==     \* DELETE hold（agreements.ts:831），显式 resume
    /\ ag = "held" /\ ag' = "active"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

\* 懒过期（settleExpiredHold，agreement-store.ts:438）：系统动作，无通知。
\* held 有界（<=3600s）⇒ 系统终将执行，见活性 HeldBounded。
HoldExpire ==
    /\ ag = "held" /\ ag' = "active"
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

\* 任一方终止（agreements.ts:870）：任意非终态 → terminated。
\* 这是"无无主状态"宽松定义成立的根因：terminate 恒可用。
TerminateByProvider ==
    /\ ag \notin AgTerminal \cup {"none"}
    /\ ag' = "terminated" /\ agWasTerminal' = TRUE
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation>>
    /\ UNCHANGED prVars

TerminateByConsumer ==
    /\ ag \notin AgTerminal \cup {"none"}
    /\ ag' = "terminated" /\ agWasTerminal' = TRUE
    /\ UNCHANGED <<agCount, staleReminded, reminds, usage, privacyViolation>>
    /\ UNCHANGED prVars

\* 等待方催促（T-309，agreements.ts:622）：proposed→consumer 催 provider；
\* countered→provider 催 consumer（T-059 对称化）。无状态迁移。
ConsumerRemind ==
    /\ ag = "proposed" /\ reminds < MaxRemind /\ reminds' = reminds + 1
    /\ UNCHANGED <<ag, agCount, staleReminded, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

ProviderRemind ==
    /\ ag = "countered" /\ reminds < MaxRemind /\ reminds' = reminds + 1
    /\ UNCHANGED <<ag, agCount, staleReminded, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

\* 24h stale sweep（agreement-stale.ts:48，boot + 每小时，R77-F5 的兜底）。
\* 已知不对称 (ii)：使能条件刻意只含 proposed，不含 countered。
StaleSweep ==
    /\ ag = "proposed" /\ ~staleReminded /\ staleReminded' = TRUE
    /\ UNCHANGED <<ag, agCount, reminds, usage, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

\* consumer 消费尝试：任何状态下都可尝试（server 在非 active 态以 409 拒绝，
\* held 得专属 AGREEMENT_HELD）。仅 active 且未超建模上界时真正计量（A2 门禁）。
\* privacyViolation 是"非 active 却被计量"的违例标志——协议正确时永不可达，
\* 由不变量 DevicePrivacy 钉死（回归绊线：任何门禁守卫被改坏都会触发）。
InvokeAttempt ==
    /\ IF ag = "active" /\ usage < MaxUsage
       THEN usage' = usage + 1
       ELSE UNCHANGED usage
    /\ UNCHANGED <<ag, agCount, staleReminded, reminds, privacyViolation, agWasTerminal>>
    /\ UNCHANGED prVars

----------------------------------------------------------------------------
(* ============================ 提案生命周期 ============================ *)

\* submit 同步漏斗（proposal-service.ts:241-356）：一次调用必然以
\* rejected / escalated / applied 之一返回。zone-claim 自治（:318）、
\* no-LLM 低风险兜底（rule-fallback / review-timeout-auto-approve）与
\* AI allow（:350）共用 "autoApply" 出口；supervised 足迹强制升级
\* （forceEscalate）与 reviewer escalate 共用 "escalate" 出口。
Submit ==
    /\ pr \in {"none"} \cup PrTerminal
    /\ prCount < MaxPr
    /\ \E kind \in {"normal", "zoneClaim"} :
        \E outcome \in {"ruleReject", "aiReject", "autoApply", "escalate"} :
            /\ prKind' = kind /\ prCount' = prCount + 1
            /\ CASE outcome = "ruleReject" ->   \* 规则关拒（:272）
                        /\ pr' = "rejected" /\ prWasTerminal' = TRUE
                        /\ decidedBy' = "none" /\ ownerAutoNotified' = FALSE
                 [] outcome = "aiReject" ->     \* AI 关拒（:340）
                        /\ pr' = "rejected" /\ prWasTerminal' = TRUE
                        /\ decidedBy' = "none" /\ ownerAutoNotified' = FALSE
                 [] outcome = "autoApply" ->    \* 无人工裁决的 apply
                        /\ pr' = "applied" /\ decidedBy' = "none"
                        \* T-004/P5：auto-apply 必达 owner
                        /\ ownerAutoNotified' = TRUE
                        \* 新实例：终态历史标志重置
                        /\ prWasTerminal' = FALSE
                 [] outcome = "escalate" ->     \* 升给 owner（+委托方，T-072）
                        /\ pr' = "escalated" /\ decidedBy' = "none"
                        /\ ownerAutoNotified' = FALSE
                        /\ prWasTerminal' = FALSE
    /\ UNCHANGED <<delegationActive, delegChanges>>
    /\ UNCHANGED agVars

\* owner 裁决（routes/proposals.ts:214 → proposal-service.ts:364）
OwnerDecideApprove ==
    /\ pr = "escalated"
    /\ pr' = "applied" /\ decidedBy' = "owner"
    /\ UNCHANGED <<prCount, prKind, delegationActive, delegChanges,
                   ownerAutoNotified, prWasTerminal>>
    /\ UNCHANGED agVars

OwnerDecideReject ==
    /\ pr = "escalated"
    /\ pr' = "rejected" /\ decidedBy' = "owner" /\ prWasTerminal' = TRUE
    /\ UNCHANGED <<prCount, prKind, delegationActive, delegChanges, ownerAutoNotified>>
    /\ UNCHANGED agVars

\* 委托方裁决（T-072）：仅限 escalated 的 zone-claim 且委托生效中。
\* 委托裁决的 apply 另通知 owner（proposal.delegate-applied，:864-892）。
DelegateDecideApprove ==
    /\ pr = "escalated" /\ prKind = "zoneClaim" /\ delegationActive
    /\ pr' = "applied" /\ decidedBy' = "delegate" /\ ownerAutoNotified' = TRUE
    /\ UNCHANGED <<prCount, prKind, delegationActive, delegChanges, prWasTerminal>>
    /\ UNCHANGED agVars

DelegateDecideReject ==
    /\ pr = "escalated" /\ prKind = "zoneClaim" /\ delegationActive
    /\ pr' = "rejected" /\ decidedBy' = "delegate" /\ prWasTerminal' = TRUE
    /\ UNCHANGED <<prCount, prKind, delegationActive, delegChanges, ownerAutoNotified>>
    /\ UNCHANGED agVars

\* revert（proposal-service.ts:518）：作者或 env owner；applied 是唯一可 revert 态。
Revert ==
    /\ pr = "applied"
    /\ pr' = "reverted" /\ prWasTerminal' = TRUE
    /\ UNCHANGED <<prCount, prKind, delegationActive, delegChanges, decidedBy,
                   ownerAutoNotified>>
    /\ UNCHANGED agVars

\* 委托生命周期（T-072）：owner 授予/撤销 zone-claims scope。
\* 边界（§3.4）：supervised-zone 同意权不随此通道委托——本模型不出现该通道。
DelegationGrant ==
    /\ ~delegationActive /\ delegChanges < MaxDeleg
    /\ delegationActive' = TRUE /\ delegChanges' = delegChanges + 1
    /\ UNCHANGED <<pr, prCount, prKind, decidedBy, ownerAutoNotified, prWasTerminal>>
    /\ UNCHANGED agVars

DelegationRevoke ==
    /\ delegationActive /\ delegChanges < MaxDeleg
    /\ delegationActive' = FALSE /\ delegChanges' = delegChanges + 1
    /\ UNCHANGED <<pr, prCount, prKind, decidedBy, ownerAutoNotified, prWasTerminal>>
    /\ UNCHANGED agVars

----------------------------------------------------------------------------
Next ==
    \/ Propose
    \/ ProviderDecideAccept \/ ProviderDecideReject \/ ProviderCounter
    \/ ConsumerDecideAccept \/ ConsumerDecideReject
    \/ ProviderSuspend \/ ConsumerHold \/ ConsumerUnhold \/ HoldExpire
    \/ TerminateByProvider \/ TerminateByConsumer
    \/ ConsumerRemind \/ ProviderRemind \/ StaleSweep \/ InvokeAttempt
    \/ Submit \/ OwnerDecideApprove \/ OwnerDecideReject
    \/ DelegateDecideApprove \/ DelegateDecideReject \/ Revert
    \/ DelegationGrant \/ DelegationRevoke

(***************************************************************************)
(* 公平性假设（活性成立的前提，逐条对应实现里的平台/人类响应性）：           *)
(*   - StaleSweep / HoldExpire 是系统动作：server 的每小时 sweep 与 held     *)
(*     懒过期机制保证它们持续使能时终将执行 → 弱公平合理。                  *)
(*   - 各 Decide 动作的弱公平 = "被通知到的决定方最终会响应"——这是对人类     *)
(*     行为的假设，不是平台能单独保证的。协议层能做的是通知 + replyHint +   *)
(*     remind + sweep 让"轮到谁"永远可见（监护机制 §4）。提案侧显式"无       *)
(*     SLA"：EscalatedResolved 只在该假设下成立，无公平性时 TLC 会给出      *)
(*     escalated 永久驻留的反例（见 CollabProtocolNoFairness.cfg 的实跑     *)
(*     记录，这正是 proposal.md "escalated 可无限期驻留"的显式设计）。      *)
(***************************************************************************)
Fairness ==
    /\ WF_vars(StaleSweep) /\ WF_vars(HoldExpire)
    /\ WF_vars(ProviderDecideAccept) /\ WF_vars(ProviderDecideReject)
    /\ WF_vars(ConsumerDecideAccept) /\ WF_vars(ConsumerDecideReject)
    /\ WF_vars(OwnerDecideApprove) /\ WF_vars(OwnerDecideReject)
    /\ WF_vars(DelegateDecideApprove) /\ WF_vars(DelegateDecideReject)

Spec == Init /\ [][Next]_vars /\ Fairness
SpecNoFairness == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* ============================== 不变量 ============================== *)

TypeOK ==
    /\ ag \in {"none", "proposed", "countered", "active", "held", "suspended",
               "rejected", "terminated"}
    /\ agCount \in 0..MaxAg /\ reminds \in 0..MaxRemind /\ usage \in 0..MaxUsage
    /\ staleReminded \in BOOLEAN /\ privacyViolation \in BOOLEAN
    /\ agWasTerminal \in BOOLEAN
    /\ pr \in {"none", "escalated", "applied", "rejected", "reverted"}
    /\ prCount \in 0..MaxPr /\ prKind \in {"none", "normal", "zoneClaim"}
    /\ delegationActive \in BOOLEAN /\ delegChanges \in 0..MaxDeleg
    /\ decidedBy \in {"none", "owner", "delegate"}
    /\ ownerAutoNotified \in BOOLEAN /\ prWasTerminal \in BOOLEAN

\* 安全不变量 (a)：设备私有性——consumer 仅在合约 active 时可被计量（invoke）。
\* 任何交错下（含 held/suspended/countered/终态）非 active 计量不可达。
DevicePrivacy == privacyViolation = FALSE

\* 安全不变量 (c)：终态不可逆——进过终态的实例永远停留在终态集合内。
TerminalIrreversible ==
    /\ (agWasTerminal => ag \in AgTerminal)
    /\ (prWasTerminal => pr \in PrTerminal)

\* 安全不变量 (b) 宽松形：可行动性表穷尽——任何可达的合约/提案状态都在
\* "可行动方"表内（含 terminate 恒可用这条兜底）。TLC 验证的是表无遗漏。
ActionabilityExhaustive ==
    /\ ag \in {"none", "proposed", "countered", "active", "held", "suspended",
               "rejected", "terminated"}
       \* none: consumer 可 propose；proposed: provider decide/counter/terminate,
       \*   consumer remind/terminate，系统 sweep；countered: consumer
       \*   decide/terminate，provider remind/terminate；active: 双方各有动作；
       \*   held: consumer unhold/terminate + 系统懒过期；
       \*   suspended: 双方仅 terminate（已知不对称 (i)，见 StrictActionable）
    /\ pr \in {"none", "escalated", "applied", "rejected", "reverted"}
       \* escalated: owner（+委托方）恒可 decide——"无 SLA 但不缺行动方"；
       \* applied: 作者/owner 可 revert；其余终态

\* 安全不变量 (b) 严格形（已知不对称 (i) 的定量刻画）：每个驻留态都有
\* "非 terminate 的前进动作或平台兜底"。suspended 不满足——在
\* CollabProtocolAsym.cfg 中启用，TLC 预期给出违反 trace，证明 suspended
\* 是唯一不符合严格定义的态（设计现状，非 bug，见 README findings）。
StrictActionable == ag /= "suspended"

\* P5/T-004：无人工裁决（auto）或委托裁决的 applied，owner 必已知情。
AutoApplyOwnerKnows ==
    (pr = "applied" /\ decidedBy \in {"none", "delegate"}) => ownerAutoNotified

\* P3/§3.4：委托方只能裁决 zone-claim 提案（supervised 同意权不委托）。
DelegateScoped == decidedBy = "delegate" => prKind = "zoneClaim"

----------------------------------------------------------------------------
(* ============================== 活性 ============================== *)

\* proposed 最终被决定，或至少被 24h stale sweep 聚合提醒（R77-F5 闭环）。
\* 注：countered 刻意没有等价的平台兜底（已知不对称 (ii)）——它只能依赖
\* ConsumerDecide 的公平性假设。
ProposedResolved ==
    (ag = "proposed") ~> (ag \in {"active", "rejected", "terminated"} \/ staleReminded)

\* escalated 提案最终被裁决（仅在"owner/委托方终会响应"的公平性假设下；
\* 提案侧无 SLA 是显式设计）。
EscalatedResolved == (pr = "escalated") ~> (pr \in {"applied", "rejected"})

\* held 有界：最终回 active 或被终止（懒过期 + unhold + terminate）。
HeldBounded == (ag = "held") ~> (ag \in {"active", "terminated"})

=============================================================================
