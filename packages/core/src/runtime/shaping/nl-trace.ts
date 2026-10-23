/**
 * NL 意图道 trajectory 接线 —— pure shaping (L2)，见 docs/architecture-runtime.md
 *
 * 训练数据缺口修复：server 侧 NL 解析（POST /api/agents/:id/command | /ask
 * 路由直调 agent，不经事件总线）此前不落任何 trajectory 记录。agent 在
 * 交互结束时发 NLInteractionTrace，这里把它接到 recorder 的
 * recordNLInteraction（recorder 再按 agentId 认领本次交互的 NL LLM 调用
 * ——prompt/rawResponse）。纯接线：无引擎状态、无 IO，与
 * registerAggregateOffers 同因（EngineRuntime 的尺寸门禁）落在 shaping。
 */

/** TrajectoryRecorder.recordNLInteraction 的结构面（避免反向 import L3）。 */
export interface NLTraceRecorderLike {
  recordNLInteraction(entry: {
    agentId: string;
    agentName?: string;
    lane: 'command' | 'ask';
    text: string;
    intentAction: string;
    parseSource: string;
    decision: string;
    decisionSource: string;
    reasoning?: string;
    executedCommands?: number;
    success?: boolean;
    /** R6-E-F09: invoke_flow 决策的执行回执。 */
    flowInvocation?: {
      flowId: string;
      status: string;
      runId?: string;
      runStatus?: string;
      reason?: string;
    };
  }): unknown;
}

/** CognitiveAgent.setNLInteractionListener 的结构面。 */
export interface NLTraceAgentLike {
  setNLInteractionListener(
    listener: ((trace: Parameters<NLTraceRecorderLike['recordNLInteraction']>[0]) => void) | undefined,
  ): void;
}

/**
 * 把一个 agent 的 NL 交互 trace 接到 trajectory recorder（无 recorder 时
 * 仍挂监听器，内部空操作——与 assembleLlmLogging 的口径一致：接线永远是
 * 单点，recorder 缺省由 recorder 侧判空）。
 */
export function wireNLInteractionTrace(
  agent: NLTraceAgentLike,
  recorder: NLTraceRecorderLike | null,
): void {
  agent.setNLInteractionListener(trace => {
    recorder?.recordNLInteraction(trace);
  });
}
