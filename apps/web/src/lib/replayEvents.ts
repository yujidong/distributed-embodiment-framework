/**
 * Replay event rendering (Fix-14 / Fix-17) — readable one-liners for the
 * three sim-timeline event kinds baked into replay scenarios
 * (apps/server/src/replay-service.ts):
 *
 * - `sim-decision` — a recorded agent decision (details: agentId, decision,
 *   decisionSource, reasoning, …);
 * - `zone-sample` — a periodic zone physics snapshot (details: parameters,
 *   occupancy);
 * - `device-state` — a device state change (details: deviceId, service).
 *
 * Their `details` payload is informational only (never physics-injected), so
 * everything here is defensive — unknown/missing fields degrade gracefully.
 *
 * i18n: pure-function module — strings are read from the global i18next
 * instance at call time so language switches propagate.
 */

import type { ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { localizedReasoning } from './decisionReasoning';
import { asRecord, str } from './eventLog';

const KIND_KEY: Record<string, string> = {
  'sim-decision': 'replayEventsLib:kindSimDecision',
  'zone-sample': 'replayEventsLib:kindZoneSample',
  'device-state': 'replayEventsLib:kindDeviceState',
};

export const REPLAY_EVENT_LABEL: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string' && KIND_KEY[prop]) {
        return i18n.t(KIND_KEY[prop]);
      }
      return undefined as unknown as string;
    },
  },
);

export function isReplayEventType(type: string): boolean {
  return type in KIND_KEY;
}

export function replayEventLabel(type: string): string {
  return KIND_KEY[type] ? i18n.t(KIND_KEY[type]) : type;
}

/**
 * UX-07: id → display-name maps a replay page can supply so lines render
 * agent/flow/event NAMES instead of raw ids. All maps optional — a miss (or
 * no maps at all) keeps the raw id, the pre-UX-07 behavior.
 */
export interface ReplayNameMaps {
  /** Agent id → display name. */
  agents?: Record<string, string>;
  /** Flow id → flow name (replay JSONs embed flows with their runtime ids). */
  flows?: Record<string, string>;
  /** Trigger-event id → readable label ("type · zone"). */
  events?: Record<string, string>;
  /**
   * R2-FEAT-12: zone id → display name — zone-sample/generic lines and the
   * share page's timeseries zone list render 病区A（ward-f0-r0）-style names
   * instead of bare ids (name 主 id 次 for non-technical readers).
   */
  zones?: Record<string, string>;
}

/**
 * Human-readable form of a trajectory decisionSource actor string:
 * 'engine:flow:<id>' → the flow's name, 'engine:agent:<id>' → the agent's
 * name; anything else ('engine', 'llm', 'rule', 'user:<id>', …) passes
 * through unchanged.
 */
export function replaySourceLabel(source: string, names?: ReplayNameMaps): string {
  const flowMatch = /^engine:flow:(.+)$/.exec(source);
  if (flowMatch) {
    const name = names?.flows?.[flowMatch[1]!] ?? flowMatch[1]!;
    return i18n.t('replayEventsLib:sourceFlow', { name });
  }
  const agentMatch = /^engine:agent:(.+)$/.exec(source);
  if (agentMatch) {
    return names?.agents?.[agentMatch[1]!] ?? agentMatch[1]!;
  }
  return source;
}

/** One readable line for a (replay) scenario event. */
export function formatReplayEvent(event: ScenarioEvent, names?: ReplayNameMaps): string {
  const details = asRecord(event.details);
  const time = event.atSimTimeSec !== undefined ? `t=${event.atSimTimeSec}s ` : '';
  switch (event.type) {
    case 'sim-decision': {
      const agentId = str(details.agentId) ?? '?';
      const agent = names?.agents?.[agentId] ?? agentId;
      const decision = str(details.decision) ?? '?';
      const rawSource = str(details.decisionSource);
      const source = rawSource !== undefined ? replaySourceLabel(rawSource, names) : undefined;
      // UX-07: execution receipts name their command + target device.
      const execution = asRecord(details.deviceExecution);
      const executionSuffix =
        str(details.kind) === 'device-execution' && str(execution.command) !== undefined
          ? i18n.t('replayEventsLib:lineExecutionSuffix', {
              command: str(execution.command),
              device: str(execution.deviceName) ?? str(execution.deviceId) ?? '?',
            })
          : '';
      // R15-D3: rule decisions localize from their structured code; LLM
      // reasoning passes through as raw text.
      const reasoning = localizedReasoning({
        reasoning: str(details.reasoning),
        reasoningCode: str(details.reasoningCode),
        reasoningParams:
          details.reasoningParams !== undefined &&
          typeof details.reasoningParams === 'object' &&
          !Array.isArray(details.reasoningParams)
            ? (details.reasoningParams as Record<string, string | number>)
            : undefined,
      });
      const sourceSuffix = source ? i18n.t('replayEventsLib:lineSimDecisionSource', { source }) : '';
      const reasoningSuffix = reasoning
        ? i18n.t('replayEventsLib:lineSimDecisionReasoning', { reasoning: short(reasoning) })
        : '';
      return i18n.t('replayEventsLib:lineSimDecision', {
        time,
        agent,
        decision: `${decision}${executionSuffix}`,
        source: sourceSuffix,
        reasoning: reasoningSuffix,
      });
    }
    case 'zone-sample': {
      const parameters = asRecord(details.parameters);
      const pairs =
        Object.entries(parameters)
          .map(([key, value]) => `${key}=${formatValue(value)}`)
          .join(', ') || i18n.t('replayEventsLib:lineZoneSampleEmpty');
      const occupancy =
        typeof details.occupancy === 'number'
          ? i18n.t('replayEventsLib:lineZoneSampleOccupancy', { count: details.occupancy })
          : '';
      return i18n.t('replayEventsLib:lineZoneSample', {
        time,
        // R2-FEAT-12: display name first, raw id only as the fallback.
        zone: replayZoneLabel(event.zoneId, names),
        pairs,
        occupancy,
      });
    }
    case 'device-state': {
      const device = str(details.deviceId) ?? '?';
      const service = str(details.service);
      const serviceSuffix = service
        ? i18n.t('replayEventsLib:lineDeviceStateService', { service })
        : '';
      return i18n.t('replayEventsLib:lineDeviceState', { time, device, service: serviceSuffix });
    }
    default: {
      const parameter = event.parameter ? ` ${event.parameter}` : '';
      const value = event.value !== undefined ? ` = ${formatValue(event.value)}` : '';
      return i18n
        .t('replayEventsLib:lineGeneric', {
          time,
          type: event.type,
          zone: replayZoneLabel(event.zoneId, names),
          parameter,
          value,
        })
        .trim();
    }
  }
}

/** R2-FEAT-12: zone id → display name when the caller supplied a zones map. */
export function replayZoneLabel(zoneId: string | undefined, names?: ReplayNameMaps): string | undefined {
  if (zoneId === undefined) return undefined;
  return names?.zones?.[zoneId] ?? zoneId;
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

function short(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
