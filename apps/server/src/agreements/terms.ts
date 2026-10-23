/**
 * Agreements service layer — terms (R21-W1 extraction from
 * routes/agreements.ts, pure move).
 *
 * Everything about agreement TERMS: closed-schema body parsing, the
 * effective-terms rule (T-059 §5.2), the drafting-boundary gates
 * (flow-service clause, read-clause-within-dataSchema), schema-field
 * helpers, quota-window math and the i18n notification digests. One module
 * so the propose/counter/invoke/read lanes cannot drift apart on what a
 * clause means.
 */

import { resolveFlowRunParams } from '@active-collaboration/core';
import type { UiLocale } from '@active-collaboration/shared';

import type { AgreementRoutesContext } from './context.js';
import {
  parseTerms,
  type AgreementAction,
  type AgreementAutoResetTerms,
  type AgreementReadTerms,
  type AgreementRow,
  type AgreementTerms,
  type AgreementTrigger,
} from '../db/agreement-store.js';
import { flowRowToDefinition } from '../db/flow-store.js';
import type { ServiceInstanceRow, ServiceStore } from '../db/service-store.js';
import { ApiError } from '../errors.js';
import { t } from '../i18n/index.js';

const TERM_KEYS: readonly (keyof AgreementTerms)[] = [
  'meteringUnit',
  'quotaPerWindow',
  'windowSec',
  'windowKind',
  'pricePerUnit',
  'priceUnit',
  'notes',
  'trigger',
  'action',
  'autoReset',
  'read',
  'targetZoneId',
  'delivery',
];

/** Wave-4a structured terms sub-shapes — closed, like the top-level terms. */
const TRIGGER_KEYS: readonly (keyof AgreementTrigger)[] = ['eventType', 'parameter', 'threshold', 'zoneId'];
const ACTION_KEYS = ['command', 'params'] as const;
/** T-070: the auto-reset clause — closed like trigger/action. */
const AUTO_RESET_KEYS: readonly (keyof AgreementAutoResetTerms)[] = ['afterSec', 'onEvent', 'action'];
/** R14 Wave-A: the data-read clause — closed like trigger/action. */
const READ_TERMS_KEYS: readonly (keyof AgreementReadTerms)[] = [
  'fields',
  'quotaPerWindow',
  'windowSec',
  'minFreshnessSec',
  'cadenceSec',
  'retentionSec',
];

/**
 * T-059 (§5.2): the terms that take effect for `row`. While countered, the
 * counter-offer is the version on the table; once accepted, the countered
 * terms were COPIED into terms_json (single enforcement column) — so every
 * non-counterred state reads terms_json and the two representations can
 * never disagree.
 */
export function effectiveTermsOf(row: AgreementRow): AgreementTerms {
  if (row.status === 'countered' && row.countered_terms_json !== null) {
    return parseTerms(row.countered_terms_json);
  }
  return parseTerms(row.terms_json);
}

/**
 * T-059 (§5.3): a compact human-readable diff of two terms objects — which
 * clauses were added / removed / changed. Nested clause objects (action/
 * read/trigger) compare by JSON; numbers render as `old → new`.
 */
export function termsDiff(original: AgreementTerms, countered: AgreementTerms): string[] {
  const notes: string[] = [];
  const keys = new Set([...Object.keys(original), ...Object.keys(countered)]);
  const render = (value: unknown): string =>
    typeof value === 'object' && value !== null ? 'structured clause' : JSON.stringify(value);
  for (const key of keys) {
    const before = (original as Record<string, unknown>)[key];
    const after = (countered as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before === undefined) notes.push(`added ${key}: ${render(after)}`);
    else if (after === undefined) notes.push(`removed ${key} (was ${render(before)})`);
    else notes.push(`changed ${key}: ${render(before)} → ${render(after)}`);
  }
  return notes;
}

/**
 * Mechanism D (design §5.3): flow-service terms are MACHINE-CHECKED at the
 * drafting boundary (propose + counter — the assertReadClauseWithinSchema
 * pattern): the structured action clause is REQUIRED with command 'run'
 * (a flow delivers one deterministic unit, not a command menu), and any
 * terms.action.params must satisfy the flow's declared inputs surface via
 * the SAME resolveFlowRunParams oracle the invoke path enforces with. A
 * contract that could never deliver is refused before it exists.
 */
export function assertFlowServiceTerms(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  terms: AgreementTerms,
): void {
  if (service.origin !== 'flow' || service.source_flow_id === null) return;
  if (terms.action === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'A flow-service agreement requires terms.action { command: "run" } — the flow executes as ' +
        'one deterministic unit; declare the clause (params optional, validated against the flow\'s inputs surface)',
    );
  }
  if (terms.action.command !== 'run') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `terms.action.command must be "run" on a flow-service (got "${terms.action.command}") — ` +
        'the backing flow defines the entire action surface; the clause only constrains run parameters',
    );
  }
  if (terms.action.params === undefined || ctx.flowStore === undefined) return;
  const flow = ctx.flowStore.getById(service.source_flow_id);
  if (flow === undefined || flow.inputs_json === null) return; // invoke-time 409 covers it
  const flowDef = flowRowToDefinition(
    flow,
    ctx.envStore.getEnvironment(service.env_id)?.owner_id,
  );
  const { issues } = resolveFlowRunParams(flowDef.inputs, terms.action.params);
  const errors = issues.filter(issue => issue.level === 'error');
  if (errors.length > 0) {
    throw new ApiError(
      422,
      'FLOW_PARAMS_INVALID',
      `Flow "${flow.name}" rejected terms.action.params: ${errors[0].message}`,
      errors.map(issue => issue.message),
      { issues: errors, flowId: flow.id },
    );
  }
}

/** interface.dataSchema field names of a service (empty when it carries none). */
export function dataSchemaFieldNames(service: ServiceInstanceRow): string[] {
  try {
    const iface = JSON.parse(service.interface_json) as { dataSchema?: { fields?: unknown } };
    const fields = iface?.dataSchema?.fields;
    if (!Array.isArray(fields)) return [];
    return fields
      .map(field => (typeof (field as { name?: unknown })?.name === 'string'
        ? (field as { name: string }).name
        : null))
      .filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

/**
 * T57c (R6, u4-F8): interface.dataSchema DECLARED units by field name — the
 * registration-time declaration an event metric's unit rides (event metrics
 * have no source path, so the zone/device unit derivation is empty for
 * them). Absent declaration → undefined (the caller renders null — never an
 * invented unit).
 */
export function dataSchemaUnits(service: ServiceInstanceRow): Record<string, string> {
  try {
    const iface = JSON.parse(service.interface_json) as { dataSchema?: { fields?: unknown } };
    const fields = iface?.dataSchema?.fields;
    if (!Array.isArray(fields)) return {};
    const units: Record<string, string> = {};
    for (const field of fields) {
      const name = (field as { name?: unknown })?.name;
      const unit = (field as { unit?: unknown })?.unit;
      if (typeof name === 'string' && typeof unit === 'string' && unit.length > 0) {
        units[name] = unit;
      }
    }
    return units;
  } catch {
    return {};
  }
}

/**
 * T-407 (R19, FM-F02): the CURRENT computation's output field names (the
 * metrics' `as` names — the keys every evaluated frame carries). Read terms
 * naming fields outside this set have drifted: the provider re-registered
 * the spec with renames and the agreed subset can no longer be served.
 * NB: the STORED spec hoists `metrics` to the top level (the registration
 * BODY nests them under `inputs`; parseComputationSpec normalizes).
 */
export function computationFieldNames(computation: { spec_json: string }): Set<string> {
  try {
    const spec = JSON.parse(computation.spec_json) as {
      metrics?: Array<{ as?: unknown }>;
      inputs?: { metrics?: Array<{ as?: unknown }> };
    };
    const metrics = Array.isArray(spec?.metrics)
      ? spec.metrics
      : Array.isArray(spec?.inputs?.metrics)
        ? spec.inputs.metrics
        : null;
    if (metrics === null) return new Set();
    return new Set(
      metrics
        .map(metric => (typeof metric?.as === 'string' ? metric.as : null))
        .filter((name): name is string => name !== null),
    );
  } catch {
    return new Set();
  }
}

/** T-407: the terms' field names the current computation no longer produces. */
export function fieldsAbsentFromComputation(
  fields: string[],
  computation: { spec_json: string },
): string[] {
  const current = computationFieldNames(computation);
  if (current.size === 0) return []; // unreadable spec — never a false drift
  return fields.filter(field => !current.has(field));
}

/**
 * R14 Wave-A §8 + T-059: propose-time (and counter-time) validation of
 * terms.read.fields against the service's dataSchema — the SAME closed
 * boundary for both drafting sides, extracted so they cannot drift.
 */
export function assertReadClauseWithinSchema(
  service: ServiceInstanceRow,
  computation: ReturnType<ServiceStore['computationOf']>,
  terms: AgreementTerms,
): void {
  if (terms.read?.fields === undefined) return;
  const dataSchemaFields = dataSchemaFieldNames(service);
  if (computation === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Service "${service.name}" has no registered computation — terms.read.fields cannot scope a read lane that does not exist ` +
        '(drop the read clause, or wait for the provider to register one: POST /api/services/:id/computation)',
    );
  }
  if (dataSchemaFields.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Service "${service.name}" carries no interface.dataSchema — the provider must register it with the computation ` +
        '(POST /api/services/:id/computation validates dataSchema == output fields)',
    );
  }
  const unknown = terms.read.fields.filter(field => !dataSchemaFields.includes(field));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `terms.read.fields names field(s) outside the service's dataSchema: ${unknown.map(f => `"${f}"`).join(', ')} — ` +
        `allowed: ${dataSchemaFields.join(', ')}`,
      undefined,
      { allowedFields: dataSchemaFields, requestedFields: terms.read.fields },
    );
  }
}

/**
 * Wave-1a (陈工 R8): one-line terms digest for the agreement.proposed
 * notification body — quota/price as compact pairs, notes truncated so a
 * long brief cannot bloat the inbox row.
 */
export function summarizeTerms(terms: AgreementTerms, locale: UiLocale): string {
  const parts: string[] = [];
  if (terms.quotaPerWindow !== undefined && terms.windowSec !== undefined) {
    parts.push(
      `quota ${terms.quotaPerWindow}/${terms.windowSec}s` +
      (terms.windowKind === 'fixed' ? ' (fixed)' : ''),
    );
  }
  if (terms.pricePerUnit !== undefined) {
    parts.push(`price ${terms.pricePerUnit}${terms.priceUnit !== undefined ? ` ${terms.priceUnit}` : ''}`);
  }
  if (terms.trigger?.eventType !== undefined) {
    parts.push(`trigger ${terms.trigger.eventType}`);
  }
  // T-070: the auto-reset clause rides the notification's terms digest so
  // the counterparty sees "…and it un-pegs itself" in the same line.
  if (terms.autoReset !== undefined) {
    const firing = terms.autoReset.afterSec !== undefined
      ? `after ${terms.autoReset.afterSec}s`
      : terms.autoReset.onEvent?.eventType !== undefined
        ? `on ${terms.autoReset.onEvent.eventType}`
        : 'when armed';
    parts.push(`auto-reset ${terms.autoReset.action.command} ${firing}`);
  }
  if (terms.notes !== undefined) {
    const notes = terms.notes.length > 80 ? `${terms.notes.slice(0, 80)}…` : terms.notes;
    parts.push(`notes: ${notes}`);
  }
  return parts.length > 0 ? parts.join(' · ') : t(locale, 'chrome.notif.termsUnlimited');
}

/**
 * Wave-6 (Fix-20 遗留): start of the CURRENT quota window for an invoke.
 * 'sliding' (default) is the trailing windowSec seconds; 'fixed' anchors
 * tumbling windows at the agreement's (re)activation — invoke requires
 * status active and setStatus bumps updated_at on the transition, so
 * updated_at is exactly the moment the current active period began.
 */
export function quotaWindowStartIso(terms: AgreementTerms, agreement: AgreementRow): string {
  const windowMs = (terms.windowSec as number) * 1000;
  if (terms.windowKind === 'fixed') {
    const anchorMs = Date.parse(agreement.updated_at);
    const elapsed = Math.max(0, Date.now() - anchorMs);
    return new Date(anchorMs + Math.floor(elapsed / windowMs) * windowMs).toISOString();
  }
  return new Date(Date.now() - windowMs).toISOString();
}

/**
 * The read quota window: sliding by default; fixed anchors tumbling windows
 * at the agreement's (re)activation — windowKind is the TOP-LEVEL terms
 * knob, reused by the read clause (§6: 滑动/固定窗口沿用 windowKind).
 */
export function readWindowStartIso(terms: AgreementTerms, agreement: AgreementRow): string {
  const windowMs = (terms.read?.windowSec as number) * 1000;
  if (terms.windowKind === 'fixed') {
    const anchorMs = Date.parse(agreement.updated_at);
    const elapsed = Math.max(0, Date.now() - anchorMs);
    return new Date(anchorMs + Math.floor(elapsed / windowMs) * windowMs).toISOString();
  }
  return new Date(Date.now() - windowMs).toISOString();
}

/**
 * The consumption-quota gate BOTH invoke lanes share (manual route → 429,
 * trigger auto-invoke → metered skip): one function so the two lanes can
 * never drift on what "window spent" means. Returns null when the terms set
 * no quota (missing terms mean "unlimited", principle 6); otherwise the
 * current window's DELIVERED-consumption count (T-205: the count callback is
 * the store's countUsageSince — outcome='success' only, probes and failures
 * never burn quota) and whether the window is spent.
 */
export interface ConsumptionQuotaStatus {
  limit: number;
  current: number;
  spent: boolean;
}

export function consumptionQuotaStatus(
  terms: AgreementTerms,
  agreement: AgreementRow,
  countSuccessSince: (sinceIso: string) => number,
): ConsumptionQuotaStatus | null {
  if (terms.quotaPerWindow === undefined || terms.windowSec === undefined) return null;
  const current = countSuccessSince(quotaWindowStartIso(terms, agreement));
  return { limit: terms.quotaPerWindow, current, spent: current >= terms.quotaPerWindow };
}

/**
 * Validate the all-optional terms body (§3.1): known keys only, each
 * type-checked; absent fields mean "unlimited" (principle 6). Price fields
 * are unit-neutral strings the core never interprets. `trigger`/`action`
 * (Wave-4a) are closed sub-objects — contract data only, nothing executes
 * on them automatically (usage/invoke are unaffected).
 */
export function parseTermsBody(raw: unknown): AgreementTerms {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms" must be an object when provided');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!TERM_KEYS.includes(key as keyof AgreementTerms)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "terms.${key}" is not a known term (allowed: ${TERM_KEYS.join(', ')})`,
      );
    }
  }
  const terms: AgreementTerms = {};
  const stringTerm = (key: 'meteringUnit' | 'pricePerUnit' | 'priceUnit' | 'notes'): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'string') {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "terms.${key}" must be a string`);
    }
    terms[key] = input[key] as string;
  };
  const numberTerm = (key: 'quotaPerWindow' | 'windowSec'): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key] as number) || (input[key] as number) <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "terms.${key}" must be a number > 0`);
    }
    terms[key] = input[key] as number;
  };
  stringTerm('meteringUnit');
  stringTerm('pricePerUnit');
  stringTerm('priceUnit');
  stringTerm('notes');
  numberTerm('quotaPerWindow');
  numberTerm('windowSec');
  if (input.windowKind !== undefined) {
    if (input.windowKind !== 'sliding' && input.windowKind !== 'fixed') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.windowKind" must be "sliding" | "fixed"');
    }
    terms.windowKind = input.windowKind;
  }
  const trigger = triggerTerm(input.trigger);
  if (trigger !== undefined) terms.trigger = trigger;
  const action = actionTerm(input.action);
  if (action !== undefined) terms.action = action;
  const autoReset = autoResetTerm(input.autoReset, trigger !== undefined && action !== undefined);
  if (autoReset !== undefined) terms.autoReset = autoReset;
  const read = readTerm(input.read);
  if (read !== undefined) terms.read = read;
  // R6-C-F02: the physical-target claim + its delivery exemption.
  if (input.targetZoneId !== undefined) {
    if (typeof input.targetZoneId !== 'string' || input.targetZoneId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.targetZoneId" must be a non-empty string');
    }
    terms.targetZoneId = input.targetZoneId;
  }
  if (input.delivery !== undefined) {
    if (input.delivery !== 'propagation') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "terms.delivery" must be "propagation" — the declared exemption for system-level ' +
          'delivery (central HVAC / district loops) that reaches the target zone beyond declared zone adjacency',
      );
    }
    terms.delivery = input.delivery;
  }
  return terms;
}

/**
 * R14 Wave-A (§6): validate the optional data-read clause — a closed
 * sub-object (unknown keys 400, like the top-level terms and trigger/action).
 * fields is a string[] (cross-checked against the service's dataSchema at
 * propose time when a computation exists); the numeric terms are > 0.
 * cadenceSec/retentionSec are declarative (throttle anchor / contract echo).
 */
function readTerm(raw: unknown): AgreementReadTerms | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.read" must be an object when provided');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!READ_TERMS_KEYS.includes(key as keyof AgreementReadTerms)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "terms.read.${key}" is not a known read term (allowed: ${READ_TERMS_KEYS.join(', ')})`,
      );
    }
  }
  const read: AgreementReadTerms = {};
  if (input.fields !== undefined) {
    if (
      !Array.isArray(input.fields) || input.fields.length === 0 ||
      input.fields.some(field => typeof field !== 'string' || field.length === 0)
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "terms.read.fields" must be a non-empty array of dataSchema field names',
      );
    }
    read.fields = input.fields as string[];
  }
  const numberTerm = (key: 'quotaPerWindow' | 'windowSec' | 'minFreshnessSec' | 'cadenceSec' | 'retentionSec'): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key] as number) || (input[key] as number) <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "terms.read.${key}" must be a number > 0`);
    }
    read[key] = input[key] as number;
  };
  numberTerm('quotaPerWindow');
  numberTerm('windowSec');
  numberTerm('minFreshnessSec');
  numberTerm('cadenceSec');
  numberTerm('retentionSec');
  return read;
}

/**
 * Wave-4a: validate the optional structured trigger condition — a closed
 * sub-object (unknown keys 400, like the top-level terms). All fields are
 * optional; the trigger is contract data only, nothing executes on it yet.
 * T-070: reused for terms.autoReset.onEvent (`where` names the field path).
 */
function triggerTerm(raw: unknown, where = 'terms.trigger'): AgreementTerms['trigger'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}" must be an object when provided`);
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!TRIGGER_KEYS.includes(key as keyof AgreementTrigger)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "${where}.${key}" is not a known trigger field (allowed: ${TRIGGER_KEYS.join(', ')})`,
      );
    }
  }
  const trigger: NonNullable<AgreementTerms['trigger']> = {};
  const stringField = (key: 'eventType' | 'parameter' | 'zoneId'): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'string') {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}.${key}" must be a string`);
    }
    trigger[key] = input[key] as string;
  };
  stringField('eventType');
  stringField('parameter');
  stringField('zoneId');
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold)) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}.threshold" must be a finite number`);
    }
    trigger.threshold = input.threshold;
  }
  return trigger;
}

/**
 * Wave-4a: validate the optional expected action — `{ command, params? }`.
 * `command` is required when `action` is present (an action without a
 * command names nothing); `params` is an optional plain object.
 */
function actionTerm(raw: unknown): AgreementTerms['action'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.action" must be an object when provided');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(ACTION_KEYS as readonly string[]).includes(key)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "terms.action.${key}" is not a known action field (allowed: ${ACTION_KEYS.join(', ')})`,
      );
    }
  }
  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.action.command" must be a non-empty string');
  }
  if (input.params !== undefined && (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params))) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.action.params" must be an object when provided');
  }
  return {
    command: input.command.trim(),
    ...(input.params !== undefined ? { params: input.params as Record<string, unknown> } : {}),
  };
}

/**
 * T-070 (R22, FM-F05): validate the optional auto-reset clause — closed
 * sub-object like trigger/action. `action` is REQUIRED (the platform never
 * guesses what "reset" means); at least one of `afterSec` (SIM seconds) or
 * `onEvent` must be present (a reset that can never fire names nothing);
 * and the clause rides the TRIGGER automation, so terms.trigger +
 * terms.action must both exist (an autoReset without them is contract data
 * nothing could ever execute — refused at the boundary instead).
 */
function autoResetTerm(raw: unknown, hasTriggerAction: boolean): AgreementAutoResetTerms | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.autoReset" must be an object when provided');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!AUTO_RESET_KEYS.includes(key as keyof AgreementAutoResetTerms)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "terms.autoReset.${key}" is not a known auto-reset field (allowed: ${AUTO_RESET_KEYS.join(', ')})`,
      );
    }
  }
  if (!hasTriggerAction) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'terms.autoReset is the TRIGGER automation\'s reset clause — terms.trigger and terms.action must both be ' +
        'present alongside it (it arms only from a trigger-driven invocation of the agreed action)',
    );
  }
  const action = actionTerm(input.action);
  if (action === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "terms.autoReset.action" { command, params? } is required — the clause must say what reset means ' +
        '(e.g. turn-off, or set-brightness with brightness 0); the platform never guesses an inverse',
    );
  }
  let afterSec: number | undefined;
  if (input.afterSec !== undefined) {
    if (typeof input.afterSec !== 'number' || !Number.isFinite(input.afterSec) || input.afterSec <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "terms.autoReset.afterSec" must be a number > 0 (SIM seconds)');
    }
    afterSec = input.afterSec;
  }
  const onEvent = triggerTerm(input.onEvent, 'terms.autoReset.onEvent');
  if (afterSec === undefined && onEvent === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'terms.autoReset needs a firing condition — afterSec (SIM-second countdown) and/or onEvent (matching clause); ' +
        'a reset clause that can never fire names nothing',
    );
  }
  return {
    ...(afterSec !== undefined ? { afterSec } : {}),
    ...(onEvent !== undefined ? { onEvent } : {}),
    action,
  };
}
