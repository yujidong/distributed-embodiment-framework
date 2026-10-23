/**
 * Agreements service layer — the agent PROVIDER's deterministic decision
 * lane (T9, R2 u2-F5 / u4-F7 / B1-10 MVP).
 *
 * The problem: a proposal whose provider is an AGENT used to hang in
 * `proposed` forever when the provider owner was offline — 3 proposals,
 * 3.2 hours, zero decisions, and `agreement remind` had no observable
 * effect on the decision either (the remind trace is the other half of T9).
 * Cross-org signing could not close without the other human at the
 * keyboard.
 *
 * The MVP ruling (lifecycle zero-change): when the provider side is an
 * agent (provider_agent_id set), a REMIND (or a future decision-cycle hook)
 * runs ONE deterministic deliverability assessment — the SAME judgment the
 * signing gates make at propose/counter/accept (R6-B-F01 / R6-C-F02), so
 * signing and deciding can never disagree about what "deliverable" means:
 *
 * - fully deliverable → accept — through the existing decide-accept
 *   mechanics (status edge proposed → active, audit + notifications), no
 *   new decision record kind, no new transition;
 * - clearly NOT deliverable (no resolvable offer rule, no actuation
 *   backing, zero executable commands, zone unreachable, unbacked without
 *   a computation) → reject with a reason (0a38ba69's reason channel);
 * - cannot judge (service/agent rows gone — retired/unlinked rows) → HOLD:
 *   the proposal stays `proposed`. 拿不准的不替人做主 — the honest boundary.
 *
 * Deliberately NOT here (Batch 3 / never): timeout auto-expiry (a new
 * automatic transition — TLA/MBT territory), and LLM judgment of whether
 * the provider SHOULD accept (semantic intent stays human/protocol-lane).
 * This module is pure rules: same input, same verdict, no model.
 */

import type { AgreementRoutesContext } from './context.js';
import { assertDeliverableAtSigning } from './signing-gates.js';
import { parseTerms, type AgreementRow } from '../db/agreement-store.js';
import { unbackedFlagsForEnv } from '../db/service-store.js';
import { ApiError } from '../errors.js';

/** The deterministic verdict for a pending agent-provider proposal. */
export type ProviderDecisionVerdict =
  | { action: 'accept' }
  | { action: 'reject'; reason: string }
  | { action: 'hold'; reason: string };

/** Party-provided reasons are capped at 500 (routes) — auto reasons too. */
const AUTO_REASON_MAX_LENGTH = 500;

const clip = (text: string): string =>
  text.length <= AUTO_REASON_MAX_LENGTH ? text : `${text.slice(0, AUTO_REASON_MAX_LENGTH - 1)}…`;

/**
 * The deterministic deliverability verdict for a proposed agreement whose
 * provider is an agent. Mirrors the PROPOSE gate exactly (the same
 * `unbackedFlagsForEnv` + computation escape + `assertDeliverableAtSigning`
 * the propose route runs), so "would propose succeed right now?" is the
 * whole question — no second judgment source can drift.
 */
export function assessProviderDeliverability(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
): ProviderDecisionVerdict {
  // Retired/unlinked rows (v60: service_id/provider_agent_id → NULL) cannot
  // be judged — the offer no longer exists in any form. HOLD, never guess.
  if (agreement.service_id === null || agreement.provider_agent_id === null) {
    return { action: 'hold', reason: 'service or provider agent is unlinked (retired row) — cannot judge deliverability' };
  }
  const service = ctx.serviceStore.getService(agreement.service_id);
  const agent = ctx.envStore.getAgent(agreement.provider_agent_id);
  if (service === undefined || agent === undefined) {
    return { action: 'hold', reason: 'service or provider agent row is gone — cannot judge deliverability' };
  }

  // The propose route's exact consumable escape: a registered computation
  // flips an unbacked offer into a deliverable data service (reads/streams
  // deliver frames), so the gate opens.
  // T31 (R3 u2-F-04): aggregates are excluded for the same reason the
  // propose route excludes them — their unbacked verdict now comes from the
  // rule lane, and the signing gates below own the refusal with the
  // aggregate-specific teaching (missing rule / missing actuation backing).
  const unbacked =
    (unbackedFlagsForEnv(ctx.envStore, [service]).get(service.id) ?? true) === true;
  const hasComputation = ctx.serviceStore.computationOf(service.id) !== undefined;

  // The signing gates — the ONE deliverability judgment, reused verbatim.
  // They throw 409/422 ApiErrors with teaching text; those messages ARE the
  // reject reason (the reason channel, deterministic by construction).
  if (unbacked && !hasComputation && service.origin !== 'aggregate') {
    return {
      action: 'reject',
      reason: clip(
        `auto-decline (agent provider, deterministic): service "${service.name}" has no backing device — ` +
        'nothing can be delivered through invoke/stream; the provider must bind a device holding the offer\u2019s ' +
        'capability (or register a computation to make it a readable data service) before this proposal can be accepted',
      ),
    };
  }
  try {
    assertDeliverableAtSigning(ctx, service, parseTerms(agreement.terms_json));
  } catch (error) {
    if (error instanceof ApiError) {
      return { action: 'reject', reason: clip(`auto-decline (agent provider, deterministic): ${error.message}`) };
    }
    throw error;
  }
  return { action: 'accept' };
}
