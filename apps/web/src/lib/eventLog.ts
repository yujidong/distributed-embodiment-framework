/**
 * Event log formatting — classify engine events into display families and
 * render a one-line human summary per event.
 *
 * Everything here is defensive by contract: the payload shapes vary per
 * emitter (several "collaboration" emitters use different field names) and
 * unknown future event types must still produce a readable line instead of
 * throwing. Unknown payloads fall back to a truncated JSON dump.
 *
 * i18n: this is a pure-function module (no React hook context), so we read
 * strings from the global i18next instance via `i18n.getFixedT`. The fixed-t
 * function is recomputed on every call so language changes take effect on the
 * next render — the React component that consumes `EventLogEntry` re-renders
 * on language change (react-i18next triggers it), at which point new entries
 * pick up the new language.
 */

import type { SystemEventDto } from '../api/types';
import { prefersChinese } from './locale';
import i18n from '../i18n/config';

export type EventFamily = 'device' | 'environment' | 'collaboration' | 'agent' | 'flow' | 'other';

export const EVENT_FAMILIES: readonly EventFamily[] = [
  'device',
  'environment',
  'collaboration',
  'agent',
  'flow',
  'other',
];

/**
 * Display label for a family in the active locale. Reads i18n at call time so
 * language switches take effect without reassigning a static record.
 */
export function familyLabel(family: EventFamily): string {
  return i18n.t(`eventLog:family.${family}`);
}

/**
 * Backward-compatible indexable record. Each property access forwards to
 * `familyLabel` so consumers using `FAMILY_LABELS[family]` see live
 * translations after a language change. (Kept as a Proxy because some callers
 * index it dynamically; if you can use `familyLabel(family)` directly, prefer
 * that.)
 */
export const FAMILY_LABELS: Record<EventFamily, string> = new Proxy(
  {} as Record<EventFamily, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && (EVENT_FAMILIES as readonly string[]).includes(prop)) {
        return familyLabel(prop as EventFamily);
      }
      return undefined as unknown as string;
    },
  },
);

/** One rendered row in the event log panel (keeps the raw event for reuse). */
export interface EventLogEntry {
  id: string;
  family: EventFamily;
  type: string;
  /** Display time (event timestamp when parseable, else receipt time). */
  at: string;
  summary: string;
  event: SystemEventDto;
}

/** Classify an event type string into a display family. */
export function eventFamily(type: string): EventFamily {
  if (type.startsWith('device.')) return 'device';
  if (type.startsWith('environment.') || type.startsWith('physics.')) return 'environment';
  if (
    type.startsWith('collaboration.') ||
    type.startsWith('requirement.') ||
    type.startsWith('service.')
  ) {
    return 'collaboration';
  }
  if (type.startsWith('agent.')) return 'agent';
  if (type.startsWith('flow.')) return 'flow';
  // AC lifecycle transitions ride on `custom` with customType AC_STATE_CHANGED.
  return 'other';
}

/** AC lifecycle custom events are shown with the collaboration family. */
export function familyOf(event: SystemEventDto): EventFamily {
  if (event.type === 'custom' && payloadCustomType(event.payload) === 'AC_STATE_CHANGED') {
    return 'collaboration';
  }
  return eventFamily(event.type);
}

export function toLogEntry(event: SystemEventDto): EventLogEntry {
  return {
    id: event.id,
    family: familyOf(event),
    type: event.type,
    at: event.timestamp ?? new Date().toISOString(),
    summary: summarizeEvent(event),
    event,
  };
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

/** Status key → i18n key for flow.executed summaries. */
const FLOW_RUN_STATUS_KEY: Record<string, string> = {
  success: 'flowStatusSuccess',
  partial: 'flowStatusPartial',
  failed: 'flowStatusFailed',
};

export function summarizeEvent(event: SystemEventDto): string {
  const t = i18n.getFixedT(i18n.language, 'eventLog');
  const p = asRecord(event.payload);
  switch (event.type) {
    case 'device.state_change':
      return t('deviceStateChange', {
        label: deviceLabel(p),
        params: strArr(p.changedParameters).join(', ') || t('deviceStateChangeFallback'),
      });
    case 'device.operation_executed': {
      const command = str(p.commandName) ?? t('deviceOperationCommandFallback');
      const label = resultLabel(p, t);
      const reason = resultError(p);
      return t('deviceOperation', {
        label: deviceLabel(p),
        command,
        result: `${label}${reason ? ` (${short(reason, 50)})` : ''}`,
      });
    }
    case 'device.registered':
      return t('deviceRegistered', { label: deviceLabel(p) });
    case 'device.error':
      return t('deviceError', {
        label: deviceLabel(p),
        detail: short(str(p.error) ?? str(p.reason) ?? json(p)),
      });
    case 'device.fault_changed': {
      const profile = asRecord(p.profile);
      const labels: string[] = [];
      if (profile.offline === true) labels.push(t('faultOffline'));
      if (typeof profile.failureRate === 'number' && profile.failureRate > 0) {
        labels.push(t('faultIntermittent', { pct: Math.round(profile.failureRate * 100) }));
      }
      if (typeof profile.latencyMs === 'number' && profile.latencyMs > 0) {
        labels.push(t('faultLatency', { ms: profile.latencyMs }));
      }
      if (profile.staleState === true) labels.push(t('faultStaleState'));
      return labels.length > 0
        ? t('faultInjected', { label: deviceLabel(p), labels: labels.join(' · ') })
        : t('faultCleared', { label: deviceLabel(p) });
    }
    case 'environment.param_changed': {
      // Wave 6 F5: prefer the author-supplied humanNarrative over the
      // terse parameter line. Turns "环境参数 bao-an-industrial smoke = true"
      // into "宝安化工园储罐区 A 遭雷击起火，伴随苯系物泄漏...".
      // The wire DTO still carries zh/en as separate plain string fields
      // (resolveHumanNarrative in EngineRuntime); pick by active locale,
      // fall back to whichever side exists.
      const zh = str(p.humanNarrative);
      const en = str(p.humanNarrativeEn);
      const narrative = prefersChinese() ? (zh ?? en) : (en ?? zh);
      if (narrative) return short(narrative, 200);
      const zone = str(p.zoneId) ?? str(p.location) ?? '?';
      const param = str(p.parameter) ?? '?';
      return t('environmentParam', { zone, param, value: valueLabel(p.newValue) });
    }
    case 'collaboration.started': {
      const who = str(p.initiatorId) ?? str(p.initiator) ?? '?';
      const what = str(p.acName) ?? str(p.purpose) ?? str(p.triggerReason) ?? t('collaborationDefault');
      return t('collaborationStarted', { who, what: short(what) });
    }
    case 'collaboration.message': {
      const from = str(p.fromAgent) ?? str(p.initiatorId) ?? '?';
      const to = str(p.toAgent) ?? str(p.targetAgentId);
      const content = str(p.description) ?? str(p.content) ?? str(p.type) ?? '';
      const arrow = to ? ` → ${to}` : '';
      const key = str(p.type) === 'ac-proposal' ? 'collaborationProposalMessage' : 'collaborationMessage';
      return t(key, {
        from,
        arrow,
        content: content ? `: ${short(content)}` : '',
      });
    }
    case 'collaboration.proposal': {
      const proposal = asRecord(p.proposal);
      const from = str(proposal.initiatorId) ?? str(proposal.initiator) ?? str(p.initiatorId) ?? '?';
      const what = str(proposal.purpose) ?? str(proposal.description) ?? str(p.purpose) ?? '';
      return t('collaborationProposal', { from, what: what ? `: ${short(what)}` : '' });
    }
    case 'collaboration.response': {
      const from = str(p.responderId) ?? str(p.fromAgent) ?? '?';
      const response = str(p.response) ?? str(p.status) ?? '';
      // Surface the rejection / acceptance reasoning (Wave 6 F5).
      const reasoning = str(p.reasoning) ?? str(p.reason);
      return t('collaborationResponse', {
        from,
        response: response ? `: ${response}` : '',
      }) + (reasoning ? ` (${short(reasoning, 60)})` : '');
    }
    case 'collaboration.completed': {
      const id = shortId(str(p.collaborationId) ?? str(p.sessionId) ?? '?');
      const ok =
        typeof p.success === 'boolean'
          ? p.success
            ? t('collaborationOutcomeSuccess')
            : t('collaborationOutcomeFailure')
          : t('collaborationOutcomeCompleted');
      return t('collaborationCompleted', { id, outcome: ok });
    }
    case 'agent.state_change':
      return t('agentStateChange', {
        agentId: str(p.agentId) ?? '?',
        oldState: str(p.oldState) ?? '?',
        newState: str(p.newState) ?? '?',
      });
    case 'flow.triggered':
      return t('flowTriggered', {
        flowId: str(p.flowId) ?? '?',
        triggerKind: str(p.triggerKind) ?? '?',
      });
    case 'flow.executed': {
      const statusKey = FLOW_RUN_STATUS_KEY[str(p.status) ?? ''];
      const status = statusKey ? t(statusKey) : str(p.status) ?? t('flowStatusFallback');
      const summary = str(p.summary);
      return t('flowExecuted', {
        flowId: str(p.flowId) ?? '?',
        status,
        summary: summary ? `: ${short(summary, 60)}` : '',
      });
    }
    case 'custom': {
      if (payloadCustomType(p) === 'AC_STATE_CHANGED') {
        const id = shortId(str(p.collaborationId) ?? '?');
        return t('acStateChanged', {
          id,
          from: str(p.from) ?? '?',
          to: str(p.to) ?? '?',
          reason: reasonSuffix(p),
        });
      }
      return t('customEvent', { detail: short(json(p)) });
    }
    default:
      return `${event.type} ${short(json(p))}`.trim();
  }
}

// ---------------------------------------------------------------------------
// Defensive payload helpers (also used by the collaboration graph)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function payloadCustomType(payload: unknown): string | undefined {
  return str(asRecord(payload).customType);
}

function deviceLabel(p: Record<string, unknown>): string {
  return str(p.deviceName) ?? str(p.deviceId) ?? '?';
}

/**
 * Render a result label for a device operation. The fixed-t function is
 * passed in so this stays pure with respect to the active language at the
 * time of the `summarizeEvent` call.
 */
function resultLabel(p: Record<string, unknown>, t: (key: string) => string): string {
  const result = p.result;
  if (result === undefined) return t('resultExecuted');
  if (typeof result === 'boolean') return result ? t('resultSuccess') : t('resultFailure');
  if (typeof result === 'object' && result !== null) {
    const success = (result as Record<string, unknown>).success;
    if (typeof success === 'boolean') return success ? t('resultSuccess') : t('resultFailure');
  }
  return short(json(result));
}

/**
 * Extract the error/reason message from a failed device command result.
 * The DeviceCommandCoordinator populates `result.error` on failure; the
 * fault seam may also surface a reason. Returns undefined for success.
 */
function resultError(p: Record<string, unknown>): string | undefined {
  const result = p.result;
  if (typeof result !== 'object' || result === null) return undefined;
  const r = result as Record<string, unknown>;
  const success = r.success;
  if (success === true) return undefined;
  return str(r.error) ?? str(r.reason) ?? str(r.message);
}

function valueLabel(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 10) / 10);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  return json(value);
}

function reasonSuffix(p: Record<string, unknown>): string {
  const reason = str(p.reason);
  return reason ? ` (${short(reason, 40)})` : '';
}

function json(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function short(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}
