# formal/ — 协作协议形式化规约（Wave F5）

> 「合约 + 提案 + 同意」协作协议的 TLA+ 规约与 TLC 模型检查记录。
> 计划锚点：docs/plan-r84-verification-framework.md §Wave F5。
> 状态机事实源：docs/lifecycles/agreement.md、docs/lifecycles/proposal.md
> （F1 从 `apps/server/src/routes/agreements.ts`、`proposal-service.ts` 反推）。

## 文件

| 文件 | 说明 |
|---|---|
| `CollabProtocol.tla` | 纯 TLA+ spec：单环境 1 provider + 1 consumer + owner（+ zone-claim 委托方），合约与提案生命周期任意交错。抽象决策与已知不对称的建模方式都写在模块头注释里。 |
| `CollabProtocol.cfg` | 主配置：6 条安全不变量 + 3 条活性（公平性假设下）。 |
| `CollabProtocolAsym.cfg` | 不对称演示：`StrictActionable` 预期违反，trace 是"suspended 无 resume"的最小见证。 |
| `CollabProtocolNoFairness.cfg` | 无公平性对照：`EscalatedResolved` 预期违反，定量证明"escalated 无 SLA"的显式设计。 |
| `tools/tla2tools.jar` | TLC（v1.7.1，最后一个兼容 Java 8 的发行版）。**不入库**（.gitignore 排除 `formal/tools/`），重下：`curl -sSL -o formal/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.1/tla2tools.jar` |

## 复现

```bash
# 需要 Java 8+（本机验证：Temurin 1.8.0_472）
cd formal
java -jar tools/tla2tools.jar -config CollabProtocol.cfg           CollabProtocol.tla
java -jar tools/tla2tools.jar -config CollabProtocolAsym.cfg       CollabProtocol.tla
java -jar tools/tla2tools.jar -config CollabProtocolNoFairness.cfg CollabProtocol.tla
```

有限状态界（纯建模边界，不改变协议结构）：`MaxAg=2, MaxPr=2, MaxRemind=2,
MaxUsage=2, MaxDeleg=2`——终态后允许重提/重交一轮，足以覆盖"terminate 后
重新协商"类路径。

## TLC 实跑结果（2026-09-04，TLC2 2.16 / tla2tools v1.7.1）

| 配置 | 结果 | 状态数 |
|---|---|---|
| 主配置 | **全部通过**：6 不变量（TypeOK / DevicePrivacy / TerminalIrreversible / ActionabilityExhaustive / AutoApplyOwnerKnows / DelegateScoped）+ 3 活性（ProposedResolved / EscalatedResolved / HeldBounded）均成立，无反例 | 165,195 生成 / 21,483 去重，深度 17，3 个活性分支全部检完 |
| Asym | **预期违反** `StrictActionable`，4 步最小 trace：`∅ → proposed →(provider accept) active →(provider suspend) suspended` | 81 生成 / 42 去重 |
| NoFairness | **预期违反** `EscalatedResolved`：提案 escalated 后 owner/委托方永不裁决，行为以 stuttering 收尾——escalated 永久驻留 | 165,195 生成 / 21,483 去重 |

## Findings

**没有发现新的协议缺陷。** 模型检查在本抽象层级确认了现有设计的三条安全
性质在所有交错下成立，并把两条已知不对称从"文档断言"升级为"机器验证的
定量刻画"：

1. **设备私有性（安全 a）成立**：`InvokeAttempt` 在任何状态下都使能（模拟
   consumer 任意时刻尝试调用），仅 `active` 才计量；`held`/`suspended`/
   谈判态/终态下的尝试全部被拒（对应实现里的 409 / AGREEMENT_HELD）。
   21,483 个可达状态中无一计量违例。此不变量是回归绊线：守卫改坏即红。
2. **无无主状态（安全 b）按宽松定义成立，按严格定义恰有一处例外**：
   `terminate` 在任意非终态对双方恒可用 ⇒ 任何驻留态都有可行动方，
   `ActionabilityExhaustive` 通过。严格形 `StrictActionable`（每态须有"非
   terminate 的前进动作或平台兜底"）**恰好只在 `suspended` 被违反**——
   TLC trace 给出 4 步最小见证。结论：**suspended 无 resume 通道符合
   "terminate 恒可用"的宽松定义，但它是全协议唯一没有撤销路径的驻留态**。
   与 agreement.md"已知不对称"的判断一致（设计现状，非 bug）；
   "提供方误 suspend 无法撤销"仍是产品层面可再议的点。
3. **终态不可逆（安全 c）成立**：rejected/terminated（合约）与
   rejected/reverted（提案）之后无任何迁出，按实例断言（`agWasTerminal`/
   `prWasTerminal` 在重提/重交时重置）。
4. **活性成立且边界清晰**：
   - `ProposedResolved` 由平台兜底保证：只要 sweep 机制在跑（系统动作的
     弱公平），proposed 不可能静默滞留——R77-F5 类 bug 在本模型中结构性
     不可能。**countered 刻意没有等价兜底**（sweep 只捞 proposed）：它的
     解决依赖"consumer 终会响应"的公平性假设 + provider 的 remind 通道，
     无平台侧最后一道防线。这是设计决定，但模型把它显式化了。
   - `EscalatedResolved` **只在决定方响应性假设下成立**：NoFairness 对照
     跑给出反例（escalated → stuttering 永久驻留）。这与 proposal.md
     "无 SLA 是显式设计"吻合——模型确认协议层不存在结构性死锁，驻留的
     唯一原因是人（owner/委托方）不行动，而协议已提供通知 + remind 双通道。
   - `HeldBounded` 由懒过期（系统动作弱公平）保证：held 不可能成为永久
     免费层（D3/T-080 的设计目标被机器确认）。
5. **同意语义**：`DelegateScoped`（委托方只能裁决 zone-claim，
   supervised-zone 同意权不委托）与 `AutoApplyOwnerKnows`（auto-apply /
   delegate-apply 必达 owner，T-004/T-072）在所有交错下成立。

**抽象层级的免责**：spec 折叠了 submit 漏斗瞬态、通知投递细节、限流窗口
与 revert 的 409 分支（见模块头注释）。这些折叠保持状态机骨架与 F1 的
MBT 模型同构，但不覆盖折叠点内部的缺陷（如"懒过期不通知"这类通知层
问题不在本 spec 的断言面上）。

## 与 F1 MBT 的对齐（F5-2）

spec 的状态集合逐字取自 `AGREEMENT_STATUSES` / `PROPOSAL_STATUSES`
（agreement-store.ts:52-60、proposal-store.ts:51-60），迁移表对应
`apps/server/src/agreement-mbt.vitest.test.ts` / `proposal-mbt.vitest.test.ts`
的可执行模型。分工：MBT 在真实实现上随机踩迁移守卫与副作用；TLA+ 在抽象
协议上穷举交错验证全局性质（私有性、无主状态、活性）。两者断言面互补，
状态机骨架必须保持同构——任何一边的迁移表变更都应触发另一边同步。
