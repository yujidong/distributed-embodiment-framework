# 升级策略（escalation）：pressure 公式与 authority 语义

> 2026-09-27。DOC-01（dorm-life D6 + lab-safety #8 复核裁定：设计意图，非 bug）。
> 唯一事实源是 `packages/core/src/cognition/capability-boundary.ts`——本文档
> 是它的解读，数字改动以代码为准。

## 公式

升级判定是「不确定性 × 风险 × 权限」的函数（认知架构 §7.5）：

```
pressure = (1 − confidence) × risk
escalate ⟺ pressure ≥ ESCALATION_PRESSURE_THRESHOLDS[authority]
```

- `confidence` = 模型自报的 `uncertainty.overall`（0 = 全盲，1 = 全知；
  与 schema 的 model_confidence 同向），clamp 到 [0,1]，非有限值按 0.5。
- `risk` = 情境严重度归一到 [0,1]：模型自报 `situation.severity / 5`，
  但当事件**真实 severity** 可得时（`eventSeverity`，从事件归一化），
  它被收进该档位的 risk 区间（见下表）——事件侧是 authoritative
  source，模型自报只在档内选点。事件 severity 不可得时退回纯自报
  （R45 前行为，向后兼容）。

## authority 分档阈值表

`ESCALATION_PRESSURE_THRESHOLDS`（capability-boundary.ts）：

| authority | 阈值 | 语义 |
|---|---|---|
| `full` | 0.4 | 无 must-escalate 区（含边界缺省）——默认 |
| `builder` | 0.3 | 能力边界有非空 must-escalate 区（见下） |
| `viewer` | 0.2 | 预留档，当前不从任何输入推导（见下） |

**authority 的推导**（`escalationAuthorityOf`）：同一轮 buildContext 派生的
能力边界活面上，`mustEscalate` 非空即 `builder`——must-escalate 区有两类
来源：T-036 权限排除（声明了 scope 外的能力），以及**声明了安全关键能力
但无在线设备背书**（想管但交付不了）。两者都是「该 agent 在部分领域权限
受限」，与模板角色无关；其余一律 `full`。刻意不从「无设备背书」推断
`viewer`：监控型 agent（弱区 ≠ 无权限）面对高危事件会恒定升级，通知噪音
的代价大于漏报——`viewer` 档保留给真正的角色面接入后再映射。

## severity band 表（risk 的上下界）

`EVENT_SEVERITY_RISK_BANDS`（R45-P0；`EventContextNormalizer` 的归一化词表）：

| 事件 severity | risk min | risk max | 设计锚点 |
|---|---|---|---|
| low | 0 | 0.2 | 自报 5 也压回 0.2 → pressure ≤ 0.18 < 0.4 不升 |
| normal | 0 | 0.3 | |
| medium | 0.1 | 0.4 | max 0.4 × 最低 confidence 可越 builder 阈值 0.3（设计） |
| high | 0.3 | 0.7 | 「应升」档：低置信下 risk 0.3–0.7 越阈 |
| urgent | 0.5 | 0.9 | |
| critical | 0.6 | 1.0 | 自报 2 + 低置信也抬到 0.6 → pressure 0.42 ≥ 0.4 升 |

档位标定对齐 devloop-r45 实测（v5 恒自报 severity 4-5、confidence 0.1-0.3
导致 22/22 全升级、含 6 条 low 级恢复通知）：low 封顶防误升，critical
抬底防漏升。既有报告口径「critical/high × 低不确定度」是**观测模式**，
不是设计承诺——medium band 在 builder 阈值下越阈是常量表写明的设计；
若产品判定「medium 不应升级」，把 medium band max 降到 < 0.3 是一处常量
调参（与 §7.5 模型标定复测合并评估），不是修 bug。

## 有序规则（`shouldEscalate`，确定性）

按序判定，命中即升级，reason 注明实现的是哪条设计触发：

1. `viewer` + risk ≥ 0.6（`ESCALATION_VIEWER_RISK_FLOOR`）→ 升级
   （权限受限者不可独自动作；当前无输入路径产出 viewer，规则保留）。
2. risk ≥ 0.8（severity ≥ 4）且 confidence < 0.5
   （`ESCALATION_SEVERE_LOW_CONFIDENCE`）→ 升级（§7.5 trigger 1：
   「看不清的紧急」）。
3. pressure ≥ 该 authority 的阈值 → 升级（通用 不确定性×风险 乘积，
   权限分档）。

另有一条旁路：模型主行动词本身是 `escalate` 时同样升级（
`evaluateDecisionEscalation`，Phase 1 把该词映射成 defer 后的消费方）。

## 调用点与效果

`evaluateDecisionEscalation` 只作用于有结构化决策面的认知决策
（preCheck/rule/triage/二元答案路径不评估——没有可用的严重度/置信输入）。
调用方是 DualTriggerACManager（决策循环两条入口：
`DualTriggerACManager.ts:933` 与 `:1179`，事件 severity 经
`eventSeverityOf` 从事件归一化传入）。命中 = assessment 标
`escalated: true` + `escalationCondition`，并把升级说明追加进
`llmAssessment.reasoning`（audit 面：不执行的理由必须可见）；**升级 =
只通知不执行**，调用方据此跳过一切执行分支。
