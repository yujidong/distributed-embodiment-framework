/**
 * Home Assistant deployment-center helpers (P3b) — the pure logic behind the
 * deploy tab's HA sections (status card, device-binding editor, safety console,
 * command test) and the global E-stop banner. DOM-free so every derivation is
 * unit-testable; the components stay thin wiring over these functions.
 *
 * i18n: this is a pure-function module (no React hook context), so we read
 * strings from the global i18next instance via `i18n.getFixedT`. The fixed-t
 * function is recomputed on every call so language changes take effect on the
 * next render — React components that consume these derivations re-render on
 * language change (react-i18next triggers it), at which point new values pick
 * up the new language. The indexable label records are exposed as Proxies that
 * forward each property access to a live i18n read (mirrors lib/eventLog's
 * FAMILY_LABELS).
 */

import type {
  DeviceCommandResult,
  HassAuditDecision,
  HassEntitySummary,
  HassEstopState,
  HassPolicy,
  HassStatus,
  PolicyEffect,
  SimulationListEntry,
  WorldDevice,
} from '../api/types';
import i18n from '../i18n/config';

// ---------------------------------------------------------------------------
// Status card (HA connection)
// ---------------------------------------------------------------------------

export const HASS_STATES = ['unconfigured', 'disconnected', 'connecting', 'ready'] as const;
export type HassState = (typeof HASS_STATES)[number];

/**
 * Display label for a HA state in the active locale. Reads i18n at call time
 * so language switches take effect without reassigning a static record.
 */
export function hassStateLabel(state: HassStatus['state']): string {
  return i18n.t(`hass:state.${state}`);
}

/**
 * Backward-compatible indexable record. Each property access forwards to
 * `hassStateLabel` so consumers using `HASS_STATE_LABEL[state]` see live
 * translations after a language change.
 */
export const HASS_STATE_LABEL: Record<HassStatus['state'], string> = new Proxy(
  {} as Record<HassStatus['state'], string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && (HASS_STATES as readonly string[]).includes(prop)) {
        return hassStateLabel(prop as HassStatus['state']);
      }
      return undefined as unknown as string;
    },
  },
);

/** Friendly note when the server lacks HASS_URL/HASS_TOKEN (live i18n read). */
export function hassUnconfiguredHint(): string {
  return i18n.t('hass:unconfiguredHint');
}

/**
 * Backward-compatible alias: components used to import this as a plain string
 * constant. It now reads i18n at call time via a function call. Callers should
 * invoke `hassUnconfiguredHint()` (or use the `hass:unconfiguredHint` key from
 * a `useTranslation` hook) and treat this export as a function.
 */
export const HASS_UNCONFIGURED_HINT = hassUnconfiguredHint;

/** Always shown above the binding table: rebinding never touches a live sim. */
export function bindingChangeHint(): string {
  return i18n.t('hass:bindingChangeHint');
}

export const BINDING_CHANGE_HINT = bindingChangeHint;

// ---------------------------------------------------------------------------
// Device bindings
// ---------------------------------------------------------------------------

export type BindingKind = 'sim' | 'hass' | 'other';

export function bindingKind(binding: string): BindingKind {
  if (binding.startsWith('sim://')) return 'sim';
  if (binding.startsWith('hass://')) return 'hass';
  return 'other';
}

export const BINDING_KINDS: readonly BindingKind[] = ['sim', 'hass', 'other'];

/** Display label for a binding kind in the active locale. */
export function bindingKindLabel(kind: BindingKind): string {
  return i18n.t(`hass:bindingKind.${kind}`);
}

export const BINDING_KIND_LABEL: Record<BindingKind, string> = new Proxy(
  {} as Record<BindingKind, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && (BINDING_KINDS as readonly string[]).includes(prop)) {
        return bindingKindLabel(prop as BindingKind);
      }
      return undefined as unknown as string;
    },
  },
);

/** The PATCH payload value that binds a device to one HA entity. */
export function hassBindingUri(entityId: string): string {
  return `hass://${entityId}`;
}

/** Devices of a world bound to a real HA entity (command-test device picker). */
export function hassBoundDevices(devices: readonly WorldDevice[]): WorldDevice[] {
  return devices.filter(device => bindingKind(device.binding) === 'hass');
}

// ---------------------------------------------------------------------------
// Entity picker
// ---------------------------------------------------------------------------

/** Distinct domains present in the entity list (sorted, for the filter dropdown). */
export function entityDomains(entities: readonly HassEntitySummary[]): string[] {
  return [...new Set(entities.map(entity => entity.domain))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export interface EntityPickerFilters {
  q?: string;
  domain?: string | null;
}

/**
 * Client-side picker filtering (the whole list is fetched once): substring on
 * entity id / friendly name (case-insensitive) plus an exact domain filter.
 */
export function filterHassEntities(
  entities: readonly HassEntitySummary[],
  filters: EntityPickerFilters,
): HassEntitySummary[] {
  const needle = filters.q?.trim().toLowerCase() ?? '';
  return entities.filter(entity => {
    if (filters.domain && entity.domain !== filters.domain) return false;
    if (needle.length === 0) return true;
    return (
      entity.entityId.toLowerCase().includes(needle) ||
      entity.friendlyName.toLowerCase().includes(needle)
    );
  });
}

// ---------------------------------------------------------------------------
// Safety policies
// ---------------------------------------------------------------------------

export const POLICY_EFFECTS: readonly PolicyEffect[] = ['allow', 'confirm', 'deny'];

/** Display label for a policy effect in the active locale. */
export function policyEffectLabel(effect: PolicyEffect): string {
  return i18n.t(`hass:policyEffect.${effect}`);
}

export const POLICY_EFFECT_LABEL: Record<PolicyEffect, string> = new Proxy(
  {} as Record<PolicyEffect, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && (POLICY_EFFECTS as readonly string[]).includes(prop)) {
        return policyEffectLabel(prop as PolicyEffect);
      }
      return undefined as unknown as string;
    },
  },
);

/**
 * Add-rule validation: the pattern must be non-empty and whitespace-free and
 * use a supported syntax — an exact entity id, '*' (everything), or a prefix
 * wildcard like 'light.*'.
 */
export function policyPatternError(pattern: string): string | null {
  const t = i18n.getFixedT(i18n.language, 'hass');
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return t('policyPatternError.empty');
  if (/\s/.test(trimmed)) return t('policyPatternError.whitespace');
  if (trimmed === '*') return null;
  const star = trimmed.indexOf('*');
  if (star === -1) return null; // exact entity id
  if (star === trimmed.length - 1 && trimmed.endsWith('.*') && trimmed.length > 2) {
    return null; // prefix wildcard ('light.*')
  }
  return t('policyPatternError.syntax');
}

/** Scope column: global for global rows, this env for the open world, else the env id. */
export function policyScopeLabel(policy: HassPolicy, currentEnvId: string): string {
  const t = i18n.getFixedT(i18n.language, 'hass');
  if (policy.envId === null) return t('policyScope.global');
  return policy.envId === currentEnvId ? t('policyScope.currentEnv') : policy.envId;
}

// ---------------------------------------------------------------------------
// Pending approvals + audit feed
// ---------------------------------------------------------------------------

/** Compact one-line JSON for the pending params column (truncated). */
export function compactJson(value: unknown, maxLength = 48): string {
  const json = JSON.stringify(value) ?? '';
  return json.length > maxLength ? `${json.slice(0, maxLength - 1)}…` : json;
}

export const AUDIT_DECISIONS: readonly HassAuditDecision[] = [
  'allowed',
  'blocked',
  'pending',
  'approved',
  'rejected',
  'estopped',
  'rate-limited',
];

/** Display label for an audit decision in the active locale. */
export function auditDecisionLabel(decision: HassAuditDecision): string {
  return i18n.t(`hass:auditDecision.${decision}`);
}

export const AUDIT_DECISION_LABEL: Record<HassAuditDecision, string> = new Proxy(
  {} as Record<HassAuditDecision, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && (AUDIT_DECISIONS as readonly string[]).includes(prop)) {
        return auditDecisionLabel(prop as HassAuditDecision);
      }
      return undefined as unknown as string;
    },
  },
);

export type AuditDecisionTone = 'ok' | 'warn' | 'danger';

/** Badge tone per audit decision (drives the badge--ok/warn/danger classes). */
export function auditDecisionTone(decision: HassAuditDecision): AuditDecisionTone {
  switch (decision) {
    case 'allowed':
    case 'approved':
      return 'ok';
    case 'pending':
    case 'rate-limited':
      return 'warn';
    case 'blocked':
    case 'rejected':
    case 'estopped':
      return 'danger';
  }
}

/** HH:MM:SS clock time for audit/pending timestamps (falls back to the raw string). */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // G4: 跟随 i18n 语言（原硬编码 'zh-CN'）。
  return date.toLocaleTimeString(i18n.language, { hour12: false });
}

// ---------------------------------------------------------------------------
// Command test (manual actuation)
// ---------------------------------------------------------------------------

/** The caller's RUNNING simulations of one environment (command-test sim picker). */
export function runningSimulationsOf(
  simulations: readonly SimulationListEntry[],
  envId: string,
): SimulationListEntry[] {
  return simulations.filter(sim => sim.environmentId === envId && sim.state === 'running');
}

/**
 * Parse the optional params JSON input: blank → no params; otherwise it must
 * be a JSON object (arrays/scalars rejected with an error in the active locale).
 */
export function parseParamsJson(text: string): {
  params?: Record<string, unknown>;
  error?: string;
} {
  const t = i18n.getFixedT(i18n.language, 'hass');
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: t('paramsJsonError.parse') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: t('paramsJsonError.notObject') };
  }
  return { params: parsed as Record<string, unknown> };
}

export type CommandFeedbackKind = 'pending' | 'ok' | 'error';

export interface CommandFeedback {
  kind: CommandFeedbackKind;
  text: string;
}

/**
 * Manual-actuation feedback: a gate-parked command (HTTP 202, `pending`) is a
 * soft-block — it surfaces as an approval notice, NOT an error.
 */
export function commandFeedback(result: DeviceCommandResult): CommandFeedback {
  const t = i18n.getFixedT(i18n.language, 'hass');
  if (result.pending === true) {
    return {
      kind: 'pending',
      text: `${t('commandFeedback.pending')}${result.pendingId !== undefined ? ` (#${result.pendingId})` : ''}`,
    };
  }
  if (result.success) return { kind: 'ok', text: t('commandFeedback.ok') };
  return { kind: 'error', text: result.error ?? t('commandFeedback.errorFallback') };
}

// ---------------------------------------------------------------------------
// Global E-stop banner
// ---------------------------------------------------------------------------

export interface EstopBannerModel {
  visible: boolean;
  text: string;
}

/** Banner derivation: hidden unless the emergency stop is engaged. */
export function estopBannerModel(state: HassEstopState | null): EstopBannerModel {
  const t = i18n.getFixedT(i18n.language, 'hass');
  if (state === null || !state.active) return { visible: false, text: '' };
  return {
    visible: true,
    text: t('estopBanner', { by: state.by ?? t('estopByFallback') }),
  };
}
