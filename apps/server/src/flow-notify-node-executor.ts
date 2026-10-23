/**
 * Flow NOTIFY-node executor (FEAT-05, deterministic notify lane) — the
 * "通知到人" half of the deterministic lane that used to be approximated by
 * speaker play-alert.
 *
 * A flow node may carry a `notify` block (`{to: 'agent'|'role'|'owner',
 * target?, message}`) instead of a capability: the run then delivers the
 * message through the environment's notification pipeline (the same family
 * as policy-envelope escalations and handshake answers). Recipient
 * resolution: 'agent' → the agent's owner user (notifyHandshakeAnswer's
 * rule); 'role' → every env member with that role; 'owner' → the
 * environment owner. The delivered recipients + notification ids ride the
 * node result so the flow run ledger shows WHO was reached.
 *
 * Wiring mirrors the T-035 agreement-trigger executor exactly: a
 * late-assigned RuntimeAttacher on the SimulationRegistry (server.ts wires
 * it once the notification store exists; no simulation can run before the
 * server listens), attaching one FlowNotifyInvoker per env-backed runtime.
 *
 * Failure semantics: every refusal (unknown agent, unknown role target, an
 * empty role) is an HONEST node failure on the flow run record with a
 * teaching message — never a silent skip, never an uncaught throw (the
 * FlowEngine's serial queue must drain).
 */

import { type EngineRuntime, type PlanNodeInvokeContext, type PlanNodeInvocation } from '@active-collaboration/core';
import type { PlanNode } from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import type { EnvironmentStore } from './db/environment-store.js';
import type { FlowStore } from './db/flow-store.js';
import type { NotificationStore } from './db/notification-store.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';
import type { RuntimeAttacher } from './sim-registry/types.js';

const logger = createLogger('FlowNotifyNodeExecutor');

export interface FlowNotifyNodeExecutorDeps {
  envStore: EnvironmentStore;
  /** Optional so the lane stays usable without the inbox (tests, embedded). */
  notificationStore?: NotificationStore;
  /** Flow author lookup for the notification actor label (optional). */
  flowStore?: FlowStore;
}

export class FlowNotifyNodeExecutor implements RuntimeAttacher {
  constructor(private readonly deps: FlowNotifyNodeExecutorDeps) {}

  /** Registry seam: one notification-lane invoker per env-backed runtime. */
  attach(environmentId: string, runtime: EngineRuntime): void {
    runtime.setFlowNotifyInvoker((node, context) =>
      this.invoke(environmentId, node, context),
    );
  }

  private async invoke(
    environmentId: string,
    node: PlanNode,
    context?: PlanNodeInvokeContext,
  ): Promise<PlanNodeInvocation> {
    const spec = node.notify!;
    const fail = (error: string): PlanNodeInvocation => ({ success: false, error });
    const { envStore, notificationStore } = this.deps;

    if (notificationStore === undefined) {
      return fail(
        `flow node '${node.id}' notifies '${spec.to}' but this deployment has no notification ` +
          'store wired — the message cannot be delivered here',
      );
    }

    try {
      const env = envStore.getEnvironment(environmentId);
      if (env === undefined) {
        return fail(
          `flow node '${node.id}': environment '${environmentId}' is gone — the notification ` +
            'has nowhere to land (notify nodes are env-backed only)',
        );
      }

      // 1. Recipient resolution per `to` (validation taught the shape; the
      //    lane still verifies — the world may have changed since authoring).
      const recipients: string[] = [];
      if (spec.to === 'owner') {
        recipients.push(env.owner_id);
      } else if (spec.to === 'role') {
        const role = spec.target;
        if (role === undefined || !['owner', 'builder', 'viewer'].includes(role)) {
          return fail(
            `flow node '${node.id}' targets role '${role ?? '(none)'}' — env roles are ` +
              "owner/builder/viewer; fix the node's notify.target",
          );
        }
        for (const member of envStore.membersOf(environmentId)) {
          if (member.role === role) recipients.push(member.user_id);
        }
        // The env owner holds the 'owner' role implicitly (env_members rows
        // may not list them) — dedupe defensively.
        if (role === 'owner' && !recipients.includes(env.owner_id)) {
          recipients.push(env.owner_id);
        }
        if (recipients.length === 0) {
          return fail(
            `flow node '${node.id}': no member of environment '${environmentId}' holds role ` +
              `'${role}' — the message would silently reach nobody; add a member or retarget the node`,
          );
        }
      } else {
        const agentId = spec.target;
        const agent = agentId !== undefined ? envStore.getAgent(agentId) : undefined;
        if (agentId === undefined || agent === undefined) {
          return fail(
            `flow node '${node.id}' targets agent '${agentId ?? '(none)'}', which does not exist in ` +
              `environment '${environmentId}' — the flow declares a dependency on an agent that is gone ` +
              '(or never existed here); repoint the node at a live agent id',
          );
        }
        recipients.push(agent.owner_id);
      }

      // 2. Deliver through the shared pipeline. The actor is the flow author
      //    (the flow is the author's orchestration artifact); allowSelf —
      //    an automatic run's notify is no self-echo, and a notify node's
      //    whole point is delivery.
      const flowId = context?.flowId;
      const flow = flowId !== undefined ? this.deps.flowStore?.getById(flowId) : undefined;
      const actorId = flow?.created_by ?? env.owner_id;
      const flowName = flow?.name ?? flowId ?? '(unknown flow)';
      const delivered: Array<{ userId: string; notificationId: string }> = [];
      for (const userId of new Set(recipients)) {
        const row = notify(notificationStore, {
          recipientId: userId,
          actorId,
          envId: environmentId,
          kind: NOTIFICATION_KINDS.flowNotification,
          title: spec.message,
          body: {
            message: spec.message,
            flowId: flowId ?? null,
            flowName,
            nodeId: node.id,
            to: spec.to,
            ...(spec.target !== undefined ? { target: spec.target } : {}),
          },
          refId: flowId !== undefined ? `${flowId}:${node.id}` : node.id,
          allowSelf: true,
        });
        if (row !== null) delivered.push({ userId, notificationId: row.id });
      }
      if (delivered.length === 0) {
        return fail(
          `flow node '${node.id}': every recipient delivery was dropped by the notification ` +
            'pipeline (noise control) — the message reached nobody',
        );
      }
      return {
        success: true,
        result: {
          to: spec.to,
          ...(spec.target !== undefined ? { target: spec.target } : {}),
          recipients: delivered.map(d => d.userId),
          notificationIds: delivered.map(d => d.notificationId),
        },
      };
    } catch (error) {
      // A store fault is an honest node failure, never an engine fault (the
      // FlowEngine's serial queue must drain).
      logger.warn(
        `notify node '${node.id}' failed for env ${environmentId}:`,
        error instanceof Error ? error.message : error,
      );
      return fail(
        `flow node '${node.id}': notification delivery failed — ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
