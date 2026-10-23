/**
 * Fault-injection helpers (P3d) — pure functions behind the 故障 panel:
 * form-state → FaultProfile serialization, and profile → badge derivation.
 * Kept component-free so the logic is unit-testable without a DOM.
 */

import type { FaultProfile } from '../api/types';
import i18n from '../i18n/config';

/** Editable form state of the 故障 panel (slider works in percent). */
export interface FaultFormState {
  offline: boolean;
  /** 0-100 (percent); mapped to failureRate 0-1. */
  failureRatePct: number;
  /** Raw text of the latency input (ms); '' = disabled. */
  latencyMsText: string;
  staleState: boolean;
}

export const EMPTY_FAULT_FORM: FaultFormState = {
  offline: false,
  failureRatePct: 0,
  latencyMsText: '',
  staleState: false,
};

/**
 * Serialize the form into a FaultProfile. Only meaningful fields are sent:
 * enabled toggles, a non-zero failure rate, a positive latency. Returns null
 * when the latency text is not a valid non-negative number (caller shows an
 * error), or when NOTHING is enabled (there is no fault to inject — the
 * caller should refuse to submit).
 */
export function serializeFaultForm(form: FaultFormState): FaultProfile | null {
  const profile: FaultProfile = {};
  if (form.offline) profile.offline = true;
  if (form.failureRatePct > 0) {
    profile.failureRate = Math.min(100, form.failureRatePct) / 100;
  }
  const latencyText = form.latencyMsText.trim();
  if (latencyText !== '') {
    const latency = Number(latencyText);
    if (!Number.isFinite(latency) || latency < 0) return null;
    if (latency > 0) profile.latencyMs = latency;
  }
  if (form.staleState) profile.staleState = true;
  return Object.keys(profile).length > 0 ? profile : null;
}

/** One display badge for an active fault (label already localized). */
export interface FaultBadge {
  key: string;
  label: string;
}

/**
 * Derive the badge list of an active fault profile:
 * 离线 / 间歇失败 30% / 延迟 500ms / 状态冻结. Empty profile → no badges.
 */
export function faultBadges(profile: FaultProfile): FaultBadge[] {
  const badges: FaultBadge[] = [];
  if (profile.offline) badges.push({ key: 'offline', label: i18n.t('faultsLib:offline') });
  if (profile.failureRate !== undefined && profile.failureRate > 0) {
    badges.push({
      key: 'failureRate',
      label: i18n.t('faultsLib:intermittent', { percent: Math.round(profile.failureRate * 100) }),
    });
  }
  if (profile.latencyMs !== undefined && profile.latencyMs > 0) {
    badges.push({ key: 'latencyMs', label: i18n.t('faultsLib:latency', { ms: profile.latencyMs }) });
  }
  if (profile.staleState) badges.push({ key: 'staleState', label: i18n.t('faultsLib:staleState') });
  return badges;
}

/** One-line summary of a fault profile (tooltips, event log). */
export function summarizeFaultProfile(profile: FaultProfile | null | undefined): string {
  if (!profile) return i18n.t('faultsLib:none');
  const labels = faultBadges(profile).map(b => b.label);
  return labels.length > 0 ? labels.join(i18n.t('llmMetricsLib:separator')) : i18n.t('faultsLib:none');
}
