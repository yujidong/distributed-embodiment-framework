/**
 * D1 (DevLoop R28, T-085 / GO26-F04) — contended device-param contracts.
 *
 * Two or more ACTIVE agreements whose trigger clauses drive automation at the
 * same (deviceId, param) pair contend: when both triggers fire, the same
 * device knob is written twice and LAST-WRITER-WINS (the deterministic,
 * auditable semantics — the design ruling keeps it). The platform's job is to
 * make the contention VISIBLE (detect + warn, never block): the accept-time
 * response, the agreement detail, and the trigger-execution command_log all
 * name the OTHER agreement sharing the pair, so the parties can resolve it
 * commercially (renegotiate, terminate, or accept the race).
 *
 * The pair an agreement's automation targets:
 * - deviceId = the agreement's backing device (the device terms.action
 *   commands — flow-services have none and never contend);
 * - param = each key of terms.action.params; a PARAMETERLESS action (turn-on)
 *   still writes the device's state, so it contends as the whole-device pair
 *   (deviceId, '*') — two automations toggling one device's power are exactly
 *   the contention this surfaces, whatever commands they use.
 *
 * Only agreements that carry BOTH terms.trigger and terms.action participate:
 * without a trigger the agreement never auto-executes, and manual invokes are
 * deliberate consumer acts (no silent automation to contend with).
 */

import type { AgreementRoutesContext } from './context.js';
import { resolveBackingDevice } from './backing.js';
import { parseTerms, type AgreementRow, type AgreementStore, type AgreementTerms } from '../db/agreement-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { ServiceStore } from '../db/service-store.js';
import type { UserStore } from '../db/user-store.js';
import { ownerRefFor } from './view.js';

/**
 * The structural slices of AgreementRoutesContext the contention judgments
 * need — narrowed so non-agreement lanes (UX-16: the flow authoring
 * warnings) can reuse the same oracle without the full route context.
 * ActuationContext backs the per-agreement pair resolution; ContentionContext
 * adds the env-wide reads the cross-agreement views need.
 */
export type ActuationContext = {
  envStore: EnvironmentStore;
  serviceStore: Pick<ServiceStore, 'getService'>;
};

export type ContentionContext = ActuationContext & {
  agreementStore: Pick<AgreementStore, 'agreementsOfEnv'>;
  userStore: Pick<UserStore, 'findById'>;
};

/** The (deviceId, param) pair one agreement's automation writes. */
export interface ActuationPair {
  deviceId: string;
  param: string;
}

/** The paramless-action token: the automation writes the whole device state. */
export const WHOLE_DEVICE_PARAM = '*';

/**
 * The pairs an agreement's trigger automation targets. Empty when the
 * agreement has no trigger+action clauses, no backing device (flow-service),
 * or the backing device cannot be resolved (unbacked/ambiguous offers —
 * nothing to contend on yet).
 */
export function actuationPairsOf(
  ctx: ActuationContext,
  row: AgreementRow,
  terms: AgreementTerms = parseTerms(row.terms_json),
): ActuationPair[] {
  if (terms.trigger === undefined || terms.action === undefined) return [];
  let deviceId: string;
  try {
    deviceId = resolveBackingDevice(ctx, row);
  } catch {
    return [];
  }
  const params = terms.action.params !== undefined ? Object.keys(terms.action.params) : [];
  return params.length > 0
    ? params.map(param => ({ deviceId, param }))
    : [{ deviceId, param: WHOLE_DEVICE_PARAM }];
}

/** The lean contention marker the trigger executor rides on command_log rows. */
export interface ContentionMark {
  agreementId: string;
  deviceId: string;
  param: string;
}

/**
 * The API-facing contention view: the OTHER active agreement(s) whose
 * automation targets a pair THIS agreement also targets. Empty for
 * non-contending agreements (the field is then absent from responses —
 * nothing to warn about).
 */
export function contentionsOf(
  ctx: ContentionContext,
  row: AgreementRow,
): Array<ContentionMark & {
  providerAgentId: string;
  providerAgentName: string | null;
  provider: ReturnType<typeof ownerRefFor>;
  serviceId: string;
}> {
  const own = actuationPairsOf(ctx, row);
  if (own.length === 0) return [];
  const ownKeys = new Set(own.map(pair => `${pair.deviceId}\u0000${pair.param}`));
  const contentions: Array<ContentionMark & {
    providerAgentId: string;
    providerAgentName: string | null;
    provider: ReturnType<typeof ownerRefFor>;
    serviceId: string;
  }> = [];
  for (const other of ctx.agreementStore.agreementsOfEnv(row.env_id)) {
    if (other.id === row.id || other.status !== 'active') continue;
    // v60: retired rows are unlinked and never active — the type just can't
    // prove it; a null ref can never contend (nothing left to actuate).
    if (other.provider_agent_id === null || other.service_id === null) continue;
    const otherTerms = parseTerms(other.terms_json);
    for (const pair of actuationPairsOf(ctx, other, otherTerms)) {
      if (!ownKeys.has(`${pair.deviceId}\u0000${pair.param}`)) continue;
      const providerAgent = ctx.envStore.getAgent(other.provider_agent_id);
      contentions.push({
        agreementId: other.id,
        deviceId: pair.deviceId,
        param: pair.param,
        providerAgentId: other.provider_agent_id,
        providerAgentName: providerAgent?.name ?? null,
        provider: ownerRefFor(ctx, other.provider_owner_id),
        serviceId: other.service_id,
      });
      break; // one row per other agreement — the first shared pair names it
    }
  }
  return contentions;
}

/**
 * Attach the D1 contentions array to an agreement response payload when (and
 * only when) the agreement contends. Absent field = no contention (the C4
 * drift-hint pattern: computed at the route boundary, never persisted).
 */
export function withContentions<T extends Record<string, unknown>>(
  ctx: ContentionContext,
  row: AgreementRow,
  payload: T,
): T & { contentions: ReturnType<typeof contentionsOf> } | T {
  const contentions = contentionsOf(ctx, row);
  return contentions.length > 0 ? { ...payload, contentions } : payload;
}

/**
 * UX-16 (pm-dev-backlog, energy-carbon D7): the LIST-face contention
 * summary — the detail GET carries the full withContentions view, but the
 * list used to say nothing, so a contended contract was invisible until
 * opened. One pass over the env's active agreements: each contending row
 * gets the count of DISTINCT other agreements sharing one of its
 * (deviceId, param) pairs plus the shared-pair count. Rows absent from the
 * map contend nothing (the field stays absent on the wire — the
 * withContentions discipline).
 */
export interface ContentionSummary {
  /** Distinct OTHER active agreements sharing at least one actuation pair. */
  count: number;
  /** Total shared (deviceId, param) pairs across those agreements. */
  pairs: number;
}

export function contentionSummaryOfEnv(
  ctx: ContentionContext,
  envId: string,
): Map<string, ContentionSummary> {
  const contenders: Array<{ id: string; keys: Set<string> }> = [];
  for (const row of ctx.agreementStore.agreementsOfEnv(envId)) {
    if (row.status !== 'active') continue;
    // v60: retired rows are unlinked and never active — a null ref can
    // never contend (same guard as contentionsOf).
    if (row.provider_agent_id === null || row.service_id === null) continue;
    const pairs = actuationPairsOf(ctx, row);
    if (pairs.length === 0) continue;
    contenders.push({
      id: row.id,
      keys: new Set(pairs.map(pair => `${pair.deviceId} ${pair.param}`)),
    });
  }
  const summaries = new Map<string, ContentionSummary>();
  const bump = (id: string, sharedPairs: number): void => {
    const summary = summaries.get(id) ?? { count: 0, pairs: 0 };
    summary.count++;
    summary.pairs += sharedPairs;
    summaries.set(id, summary);
  };
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      let shared = 0;
      for (const key of contenders[i].keys) {
        if (contenders[j].keys.has(key)) shared++;
      }
      if (shared === 0) continue;
      bump(contenders[i].id, shared);
      bump(contenders[j].id, shared);
    }
  }
  return summaries;
}
