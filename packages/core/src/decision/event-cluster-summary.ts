/**
 * Event → SpatialClusterSummary shaping — pure mapping extracted from
 * DualTriggerACManager (R38-P2 file-budget ratchet; verbatim behavior).
 *
 * The direct Layer-2 path (urgent events / disabled Layer 1) converts a
 * SystemEvent into the cluster-summary shape the assessor consumes. The
 * T-203 event-context honesty contract (original eventType + parameter +
 * value in the summary sentence) lives here. The urgent-event predicate
 * (Layer-1 bypass check, R38-P5 extraction) lives here too.
 */

import { EventContextNormalizer } from '../context/EventContextNormalizer.js';
import type { EventSeverity } from '../cognition/capability-boundary.js';
import type { SystemEvent } from '../events/EventManager.js';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';

/**
 * Vague zone descriptions for the vague-spatial ablation (verbatim move
 * from DualTriggerACManager): precise zone ids → generic descriptions that
 * preserve spatial relationships without revealing zone purposes.
 */
const VAGUE_ZONE_MAP: Record<string, string> = {
  'living-room': 'common-area',
  'bedroom': 'private-room-a',
  'kitchen': 'utility-area',
  'bathroom': 'wet-room',
  'server-room': 'technical-room',
  'entrance-hall': 'transit-zone-a',
  'home-office': 'work-area',
  'balcony': 'exterior-zone',
  'utility-room': 'service-room',
  'garage': 'storage-zone',
  'corridor': 'transit-zone-b',
  'room-1': 'zone-a',
};

export function vagueZoneDescription(zoneId: string): string {
  return VAGUE_ZONE_MAP[zoneId] ?? `zone-${zoneId.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
}

/**
 * Convert a SystemEvent into the SpatialClusterSummary the assessor's LLM
 * path consumes (verbatim extraction — see DualTriggerACManager history).
 * `useVagueSpatial` maps precise zone ids to vague descriptions (ablation).
 */
export function eventToClusterSummary(
  event: SystemEvent,
  useVagueSpatial = false,
  warnMissingZone?: (message: string) => void,
): SpatialClusterSummary {
  const payload = event.payload || {};

  // Determine significance based on payload data
  const isUrgent = payload.severity === 'high' || payload.severity === 'urgent' || payload.severity === 'critical' || payload.breach === true;
  const significance: 'low' | 'medium' | 'high' | 'urgent' = isUrgent ? 'high' : 'medium';

  // T-203 event context honesty: the summary is what the assessor's LLM
  // prompt renders verbatim — carry the ORIGINAL injected event type
  // (payload.eventType; the payload has it, shaping/events.ts) plus the
  // physical parameter and value, so a footfall-spike and a PM2.5=180
  // reading are no longer the same indistinguishable
  // "environment.param_changed … severity=high" sentence (RF-F08).
  const originType = typeof payload.eventType === 'string' ? payload.eventType : event.type;
  const summaryParts = [`Event ${originType} from ${event.source}`];
  if (payload.parameter !== undefined) {
    summaryParts.push(`parameter=${String(payload.parameter)}`);
  }
  if (payload.newValue !== undefined) {
    summaryParts.push(`newValue=${String(payload.newValue)}`);
  }
  if (payload.temperature !== undefined) {
    summaryParts.push(`temperature=${payload.temperature}`);
  }
  if (payload.threshold !== undefined) {
    summaryParts.push(`threshold=${payload.threshold}`);
  }
  if (payload.breach !== undefined) {
    summaryParts.push(`breach=${String(payload.breach)}`);
  }
  if (payload.severity !== undefined) {
    summaryParts.push(`severity=${String(payload.severity)}`);
  }

  // Extract zoneId from multiple sources to avoid 'unknown' fallback
  const extractedZoneId: string | undefined = payload.zoneId
    || event.metadata?.zoneId;

  if (!extractedZoneId && warnMissingZone !== undefined) {
    warnMissingZone(
      `zoneId missing in event payload and metadata. ` +
      `eventId=${event.id}, type=${event.type}, source=${event.source}`,
    );
  }

  const zoneId = extractedZoneId || 'unknown';

  return {
    clusterId: `event-${event.id}`,
    region: {
      id: useVagueSpatial ? vagueZoneDescription(zoneId) : zoneId,
      center: payload.location || payload.coordinates || { x: 0, y: 0 },
      radius: 10,
      type: 'zone',
    },
    timeWindow: new Date().toISOString(),
    significance,
    summary: summaryParts.join(', '),
    findings: [{
      eventType: event.type,
      count: 1,
      trend: payload.trend || (isUrgent ? 'increasing' : 'stable'),
      anomaly: isUrgent,
      // CRITICAL: Include both payload and metadata for task parameters
      details: {
        ...payload,
        ...(event.metadata || {}),
      },
    }],
    recommendation: isUrgent ? 'immediate_action' : 'evaluate_with_llm',
  };
}

/**
 * Urgent-event predicate (verbatim extraction of DualTriggerACManager's
 * isUrgentEvent, R38-P5 file-budget ratchet — return values pinned by the
 * manager suites): normalized urgency/emergency, domain rules (temperature
 * > 30, AQI > 100), high/urgent event priority; periodic readings are never
 * urgent. `log` receives the original debug lines (message + meta).
 */
export function isUrgentSystemEvent(
  event: SystemEvent,
  log: (message: string, meta?: unknown) => void,
): boolean {
  const payload = event.payload;
  if (!payload) {
    log('isUrgentEvent: No payload, not urgent');
    return false;
  }

  // Use EventContextNormalizer for unified context access
  const normalizer = new EventContextNormalizer();
  const normalized = normalizer.normalizeQuick(event);

  // Log normalized context for debugging
  log('isUrgentEvent checking:', {
    normalizedSeverity: normalized.severity,
    isUrgent: normalized.isUrgent,
    isEmergency: normalized.isEmergency,
    eventPriority: event.priority,
    originalFormat: normalizer.normalize(event).originalFormat,
  });

  // Check normalized urgency
  if (normalized.isUrgent) {
    log(`URGENT: normalized.severity=${normalized.severity}`);
    return true;
  }

  // Check for emergency flag (additional safety check)
  if (normalized.isEmergency) {
    log('URGENT: emergency detected');
    return true;
  }

  // Check for high temperature (domain-specific rule)
  const tempValue = (payload as Record<string, any>).temperature || (payload as Record<string, any>).stateChange?.newValue;
  if (typeof tempValue === 'number' && tempValue > 30) {
    log(`URGENT: temperature=${tempValue} > 30`);
    return true;
  }

  // Check for poor air quality (domain-specific rule)
  const aqi = (payload as Record<string, any>).aqi;
  if (typeof aqi === 'number' && aqi > 100) {
    log(`URGENT: aqi=${aqi} > 100`);
    return true;
  }

  // Check for high event priority (URGENT or HIGH)
  if (event.priority === 'urgent' || event.priority === 'high') {
    log(`URGENT: event.priority=${event.priority}`);
    return true;
  }

  // Normal periodic readings should not be urgent
  if (normalized.temporalContext.isPeriodic) {
    log('Not urgent: periodic event');
    return false;
  }

  log('Not urgent: no urgency indicators matched');
  return false;
}

/**
 * R40-A3 尺寸整理（verbatim move from DualTriggerACManager）：AggregatedEvent
 * → SpatialClusterSummary 的纯转换。
 */
export function aggregatedEventToClusterSummary(event: {
  id: string;
  firstOccurrence: Date;
  lastOccurrence: Date;
  count: number;
  eventType: string;
  significance: 'low' | 'medium' | 'high';
}): SpatialClusterSummary {
  return {
    clusterId: `agg-${event.id}`,
    region: {
      id: 'unknown',
      center: { x: 0, y: 0 },
      radius: 10,
      type: 'zone',
    },
    timeWindow: `${event.firstOccurrence.toISOString()} - ${event.lastOccurrence.toISOString()}`,
    significance: event.significance,
    summary: `${event.count} events of type ${event.eventType}`,
    findings: [{
      eventType: event.eventType,
      count: event.count,
      trend: 'stable',
      anomaly: event.significance === 'high',
    }],
    recommendation: event.significance === 'high' ? 'immediate_action' : 'evaluate_with_llm',
  };
}

/**
 * Extract the shared (agent-independent) event id from a SystemEvent
 * (verbatim move from DualTriggerACManager).
 *
 * EngineRuntime.ts suffixes per-agent event ids with `:${agentId}` and
 * stores the shared id in `event.metadata.eventId`. Fall back to the raw
 * `event.id` (stripped of any `:agentId` suffix) when metadata is absent.
 */
export function extractSharedEventId(event: SystemEvent): string {
  const meta = event.metadata as Record<string, unknown> | undefined;
  const metaEventId = meta?.eventId;
  if (typeof metaEventId === 'string' && metaEventId.length > 0) {
    return metaEventId;
  }
  const rawId = event.id ?? '';
  const colonIdx = rawId.lastIndexOf(':');
  // Only strip if the suffix looks like an agent id (non-empty, no whitespace).
  if (colonIdx > 0 && colonIdx < rawId.length - 1) {
    return rawId.slice(0, colonIdx);
  }
  return rawId;
}

/**
 * R45-P0：事件的**真实 severity**（EventContextNormalizer 归一化，覆盖
 * flat/nested-context/priority 各格式）——升级函数 risk 的 authoritative
 * source（evaluateDecisionEscalation 的第二入参；模型自报
 * situation.severity 只作档内 tie-breaker）。事件不可得或归一化失败时返回
 * undefined，升级回退到纯自报行为（向后兼容）。
 */
export function eventSeverityOf(event: SystemEvent | undefined): EventSeverity | undefined {
  if (event === undefined) return undefined;
  try {
    return new EventContextNormalizer().normalizeQuick(event).severity;
  } catch {
    return undefined;
  }
}
