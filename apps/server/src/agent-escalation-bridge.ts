/**
 * Agent escalation bridge (R40-A3, 认知架构 §7.5 升级通道——server 半边)
 *
 * 核心侧 DualTriggerACManager 评估 shouldEscalate（高严重度 × 低置信 ×
 * 能力边界外）→ EngineRuntime 在世界事件流上发布 AGENT_ESCALATION（升级 =
 * 只通知不执行，任何设备命令都不发）。本桥订阅该事件，把环境 owner 的
 * 通知落进 notifications 表（kind `agent.escalated`，与 NL emergency 通道
 * 共用的类型）——"门铃"语义与 AcAgreementBridge 完全一致：server 订阅
 * runtime 的事件总线，无 core → server 依赖。
 *
 * 噪音控制：dedupeUnread + refId（默认事件 id）——同一事件的重复升级在
 * owner 读过之前只响一次。
 */

import { EventType, type EngineRuntime, type SystemEvent } from '@active-collaboration/core';

import type { EnvironmentStore } from './db/environment-store.js';
import type { NotificationStore } from './db/notification-store.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';

export interface AgentEscalationBridgeDeps {
  envStore: EnvironmentStore;
  /** Optional so the bridge stays usable without the inbox (tests, embedded)。 */
  notificationStore?: NotificationStore;
}

export class AgentEscalationBridge {
  constructor(private readonly deps: AgentEscalationBridgeDeps) {}

  /** Subscribe an environment-backed runtime; subscriptions die with stop(). */
  attach(envId: string, runtime: EngineRuntime): void {
    runtime.subscribe(event => this.onAgentEscalation(envId, event), EventType.AGENT_ESCALATION);
  }

  private onAgentEscalation(envId: string, event: SystemEvent): void {
    const { envStore, notificationStore } = this.deps;
    if (notificationStore === undefined) return;
    const payload = event.payload as {
      agentId?: unknown;
      eventId?: unknown;
      eventType?: unknown;
      decision?: unknown;
      severity?: unknown;
      confidence?: unknown;
      reason?: unknown;
      zoneId?: unknown;
    } | undefined;
    if (payload === null || typeof payload !== 'object') return;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
    if (agentId === undefined) return; // 没有主语的升级无法行动

    try {
      const env = envStore.getEnvironment(envId);
      if (env === undefined) return; // 已删除的环境——无事可做
      const agent = envStore.getAgent(agentId);
      const agentName = agent?.name ?? agentId;
      notify(notificationStore, {
        recipientId: env.owner_id,
        // actor 用 agent 归属的 owner：升级是 agent 的自主行为，不是某个
        // 用户触发。allowSelf——owner 拥有的 agent 升级对 owner 不是自回声
        // （owner 并没有触发它，与平台代决的提案裁决同一语义）。
        actorId: agent?.owner_id ?? env.owner_id,
        envId,
        kind: NOTIFICATION_KINDS.agentEscalated,
        title: `Agent「${agentName}」升级了决策（只通知，未执行）`,
        body: {
          summary:
            `Agent "${agentName}" 判定情境超出自身能力/置信边界，已升级给你。` +
            `按安全语义该决策没有执行任何设备命令。` +
            (typeof payload.reason === 'string' && payload.reason.length > 0
              ? `原因：${payload.reason}`
              : ''),
          agentId,
          ...(typeof payload.eventId === 'string' ? { eventId: payload.eventId } : {}),
          ...(typeof payload.eventType === 'string' ? { eventType: payload.eventType } : {}),
          ...(typeof payload.zoneId === 'string' ? { zoneId: payload.zoneId } : {}),
          ...(typeof payload.decision === 'string' ? { decision: payload.decision } : {}),
          ...(typeof payload.severity === 'number' ? { severity: payload.severity } : {}),
          ...(typeof payload.confidence === 'number' ? { confidence: payload.confidence } : {}),
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
        },
        // 同一事件的重复升级在 owner 读过之前去重（门铃再响规则）。
        refId: typeof payload.eventId === 'string' ? payload.eventId : agentId,
        dedupeUnread: true,
        allowSelf: true,
      });
    } catch (error) {
      // 通知失败绝不打断 runtime——升级事件本身已落世界事件流与决策记录。
      console.warn(
        `AgentEscalationBridge: notification for env ${envId} agent ${agentId} failed (non-fatal):`,
        error,
      );
    }
  }
}
