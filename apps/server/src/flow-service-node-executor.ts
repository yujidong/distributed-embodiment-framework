/**
 * Flow SERVICE-node executor (R6-B-F03, usertest-r6 track-b F03) — the
 * cross-owner orchestration carrier.
 *
 * A flow action node may carry a `service` block (`{serviceId |
 * semanticType, action?}`) instead of a capability: the flow author then
 * ORCHESTRATES another tenant's published service. Orchestration declares
 * the dependency; it never grants the permission — execution requires the
 * flow author (the run's consumer identity) to hold an ACTIVE agreement on
 * the referenced service, and the call runs through the SAME unified
 * invocation core as manual invokes and trigger auto-exec
 * (executeAgreementInvocation): quota window, terms.action merge-override,
 * device-executable gate, command_log audit, metered UsageRecord,
 * settlement receipt, reputation scoring. Flow orchestration can never
 * bypass governance — that is the point of the design (手工合约 → DAG 化,
 * 治理语义不变).
 *
 * Wiring mirrors the T-035 agreement-trigger executor exactly: a
 * late-assigned RuntimeAttacher on the SimulationRegistry (server.ts wires
 * it once the agreement context exists; no simulation can run before the
 * server listens), attaching one FlowServiceInvoker per env-backed runtime.
 *
 * Failure semantics: every refusal (unknown flow attribution, unknown
 * service, no active agreement, held/expired, quota spent) is an HONEST
 * node failure on the flow run record with a teaching message that names
 * the signing move — never a silent skip, never an uncaught throw (the
 * FlowEngine's serial queue must drain).
 */

import { type EngineRuntime, type PlanNodeInvokeContext, type PlanNodeInvocation } from '@active-collaboration/core';
import type { PlanNode } from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import {
  consumptionQuotaStatus,
  executeAgreementInvocation,
  type AgreementRoutesContext,
} from './agreements/index.js';
import { parseTerms, type AgreementRow } from './db/agreement-store.js';
import type { ServiceInstanceRow } from './db/service-store.js';
import { ApiError } from './errors.js';
import type { RuntimeAttacher } from './sim-registry/types.js';

const logger = createLogger('FlowServiceNodeExecutor');

export class FlowServiceNodeExecutor implements RuntimeAttacher {
  constructor(private readonly ctx: AgreementRoutesContext) {}

  /** Registry seam: one agreement-mediated invoker per env-backed runtime. */
  attach(environmentId: string, runtime: EngineRuntime): void {
    runtime.setFlowServiceInvoker((node, context) =>
      this.invoke(environmentId, runtime, node, context),
    );
  }

  private async invoke(
    environmentId: string,
    runtime: EngineRuntime,
    node: PlanNode,
    context?: PlanNodeInvokeContext,
  ): Promise<PlanNodeInvocation> {
    const spec = node.service!;
    const targetLabel = spec.serviceId ?? spec.semanticType ?? '(untargeted)';
    const fail = (error: string): PlanNodeInvocation => ({ success: false, error });

    // 1. Consumer identity: the FLOW AUTHOR (created_by), never the actor
    //    who happened to fire this run — the flow is the author's
    //    orchestration artifact; their agreement is what authorizes the call.
    const flowId = context?.flowId;
    const flow = flowId !== undefined ? this.ctx.flowStore?.getById(flowId) : undefined;
    const env = this.ctx.envStore.getEnvironment(environmentId);
    if (flow === undefined || env === undefined || flow.environment_id !== env.id) {
      return fail(
        `flow node '${node.id}' invokes service '${targetLabel}' but the invoking flow ` +
          `'${flowId ?? '(unknown)'}' has no attributable author in environment '${environmentId}' — ` +
          'service nodes are env-backed only (the consumer identity comes from the flow author)',
      );
    }
    const consumerUserId = flow.created_by ?? env.owner_id;

    // 2. Resolve the referenced service(s) against the env catalog.
    const services = this.resolveServices(environmentId, spec.serviceId, spec.semanticType);
    if (services.length === 0) {
      const known = this.ctx.serviceStore.servicesOf(environmentId);
      return fail(
        spec.serviceId !== undefined
          ? `flow node '${node.id}': service '${spec.serviceId}' does not exist in environment ` +
            `'${environmentId}' — the flow declares a dependency on a service that is gone (or never ` +
            'existed here); repoint the node at a live service id'
          : `flow node '${node.id}': no service of semantic type '${spec.semanticType}' is registered in ` +
            `environment '${environmentId}' (known types: ${[...new Set(known.map(s => s.semantic_type))].slice(0, 5).join(', ') || '(none)'}) — ` +
            'a provider must publish one before this node can run',
      );
    }

    // 3. The authorization boundary: an ACTIVE agreement where the flow
    //    author is the consumer, on one of the resolved services. Held rows
    //    are lazily settled first (the standing-asks pattern) so an expired
    //    hold never masks an active verdict.
    const serviceIds = new Set(services.map(service => service.id));
    const candidates = this.ctx.agreementStore
      .agreementsOfEnv(environmentId)
      .map(row => this.ctx.agreementStore.settleExpiredHold(row))
      .filter(row =>
        row.consumer_owner_id === consumerUserId &&
        row.service_id !== null &&
        serviceIds.has(row.service_id));
    const active = candidates
      .filter(row => row.status === 'active')
      .sort((a, b) => a.id.localeCompare(b.id)); // deterministic pick
    if (active.length === 0) {
      return fail(this.noAgreementError(node.id, targetLabel, services, candidates, consumerUserId));
    }
    const agreement = active[0]!;
    const terms = parseTerms(agreement.terms_json);

    // 4. Quota — the SHARED window gate (consumptionQuotaStatus), identical
    //    to the manual lane's 429 and the trigger lane's skip: a spent
    //    window refuses BEFORE execution, unmetered (manual-lane parity —
    //    the flow run record is the consumer-visible surface).
    const quota = consumptionQuotaStatus(terms, agreement, since =>
      this.ctx.agreementStore.countUsageSince(agreement.id, since),
    );
    if (quota !== null && quota.spent) {
      return fail(
        `flow node '${node.id}': agreement "${agreement.id}" quota exceeded (${quota.current}/${quota.limit} ` +
          `invocations in the current window) — the service call is refused until the window passes; ` +
          'quota terms bind flow orchestration exactly like manual invokes',
      );
    }

    // 5. Action resolution: the node's explicit action wins; otherwise the
    //    negotiated terms.action.command; flow-backed services fall back to
    //    'run' (their only action). terms enforcement below still 422s any
    //    action outside the negotiated clause.
    const service = agreement.service_id !== null
      ? this.ctx.serviceStore.getService(agreement.service_id)
      : undefined;
    const action = spec.action ?? terms.action?.command ??
      (service?.origin === 'flow' ? 'run' : undefined);
    if (action === undefined) {
      return fail(
        `flow node '${node.id}': no action declared and agreement "${agreement.id}" terms pin none — ` +
          'declare service.action on the node or negotiate terms.action into the agreement',
      );
    }

    // 6. Execute through the unified invocation core — the SAME metered,
    //    terms-enforced, audited path as manual invokes (T-035 sharing
    //    argument: lanes can never drift). node.params are the invocation
    //    params; terms.action.params merge-override still binds.
    try {
      const outcome = await executeAgreementInvocation(this.ctx, {
        agreement,
        terms,
        runtime,
        simulationId: runtime.id,
        action,
        ...(node.params !== undefined ? { params: node.params } : {}),
        actor: { userId: consumerUserId },
      });
      if (!outcome.success) {
        return {
          success: false,
          error: outcome.error ?? `service invocation of '${targetLabel}' failed`,
          ...(outcome.deviceId !== null ? { deviceId: outcome.deviceId } : {}),
        };
      }
      return {
        success: true,
        result: {
          agreementId: agreement.id,
          serviceId: agreement.service_id,
          action,
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          ...(outcome.flowRun !== undefined ? { flowRun: outcome.flowRun } : {}),
          usageId: outcome.usage.id,
          receiptId: outcome.receiptId,
        },
        ...(outcome.deviceId !== null ? { deviceId: outcome.deviceId } : {}),
      };
    } catch (error) {
      // Refusals from the shared core (terms violation, device-not-backed,
      // params rejected, …) are honest node failures — metered by the core
      // itself where it meters; the run record carries the teaching text.
      if (error instanceof ApiError) {
        return fail(`flow node '${node.id}': ${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Catalog resolution for the two ref shapes (exact id / semantic type). */
  private resolveServices(
    environmentId: string,
    serviceId: string | undefined,
    semanticType: string | undefined,
  ): ServiceInstanceRow[] {
    if (serviceId !== undefined) {
      const service = this.ctx.serviceStore.getService(serviceId);
      return service !== undefined && service.env_id === environmentId ? [service] : [];
    }
    if (semanticType !== undefined) {
      return this.ctx.serviceStore
        .servicesOf(environmentId)
        .filter(service => service.semantic_type === semanticType);
    }
    return [];
  }

  /**
   * The no-active-agreement teaching error. Distinguishes the near-miss
   * states so the author sees the exact move that unblocks the node:
   * held (resume it), negotiating (finish the handshake), access-grant-only
   * (grants cover data reads, NOT actuation), or nothing (sign one).
   */
  private noAgreementError(
    nodeId: string,
    targetLabel: string,
    services: ServiceInstanceRow[],
    candidates: AgreementRow[],
    consumerUserId: string,
  ): string {
    const held = candidates.find(row => row.status === 'held');
    if (held !== undefined) {
      return (
        `flow node '${nodeId}' invokes service '${targetLabel}' but agreement "${held.id}" is HELD ` +
        `(until ${held.hold_expires_at ?? '(no deadline recorded)'}) — resume it (DELETE /api/agreements/:id/hold) ` +
        'or wait for the hold to expire'
      );
    }
    const negotiating = candidates.find(
      row => row.status === 'proposed' || row.status === 'countered' || row.status === 'suspended',
    );
    if (negotiating !== undefined) {
      return (
        `flow node '${nodeId}' invokes service '${targetLabel}' but agreement "${negotiating.id}" is ` +
        `${negotiating.status}, not active — finish the negotiation (the provider's decide/counter move) ` +
        'before this node can run'
      );
    }
    // An access grant is the DATA-read authorization lane — it never
    // authorizes actuation. Say so when the author holds one, so "但我已经
    // 有授权了" confusion dies at the error message.
    const granted = services.find(service =>
      this.ctx.serviceStore.hasActiveAccessGrant(service.id, consumerUserId),
    );
    const grantNote = granted !== undefined
      ? ` (you DO hold an access grant on service '${granted.id}' — grants authorize data reads only, ` +
        'not actuation; an agreement is still required)'
      : '';
    return (
      `flow node '${nodeId}' invokes service '${targetLabel}' but the flow author holds NO active ` +
      `agreement for it${grantNote} — flow orchestration composes through contracts, it never grants ` +
      `permission: sign an agreement with the provider first (POST /api/services/${services[0]!.id}/agreements, ` +
      'provider accepts → active), then the node runs through the metered invoke lane'
    );
  }
}
