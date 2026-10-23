/**
 * Event Context Normalizer
 *
 * Normalizes event payloads from various formats into a unified structure.
 * This solves the problem of inconsistent context access across different event types.
 *
 * Key Problem Solved:
 * - Some events use `payload.severity`
 * - Some events use `payload.context.severity`
 * - Some events use `payload.context.significance`
 * - This normalizer unifies all these into a consistent interface
 */

import type { SystemEvent } from '@active-collaboration/shared';
import { EventPriority } from '@active-collaboration/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Normalized severity levels
 */
export type NormalizedSeverity = 'low' | 'normal' | 'medium' | 'high' | 'urgent' | 'critical';

/**
 * Normalized trend direction
 */
export type NormalizedTrend = 'increasing' | 'decreasing' | 'stable' | 'volatile' | 'unknown';

/**
 * Normalized event context
 * Unified structure for all event types
 */
export interface NormalizedEventContext {
  // Event identification
  eventId: string;
  eventType: string;
  timestamp: Date;
  source: string;

  // Unified severity (normalized from various formats)
  severity: NormalizedSeverity;

  // Quick accessors
  isUrgent: boolean;
  isAnomaly: boolean;
  isEmergency: boolean;

  // Spatial context
  spatialContext: {
    location?: { x: number; y: number; z: number } | string;
    zone?: string;
    floor?: number;
    building?: string;
  };

  // Temporal context
  temporalContext: {
    isPeriodic: boolean;
    isScheduled: boolean;
    recurrencePattern?: string;
  };

  // State change (if applicable)
  stateChange?: {
    deviceId?: string;
    deviceType?: string;
    property?: string;
    oldValue?: any;
    newValue?: any;
    unit?: string;
  };

  // Anomaly context (if applicable)
  anomalyContext?: {
    isAnomaly: boolean;
    anomalyType?: string;
    confidence?: number;
    relatedMetrics?: string[];
  };

  // Trend context (if applicable)
  trendContext?: {
    direction: NormalizedTrend;
    rate?: number;
    predictedValue?: number;
    predictionConfidence?: number;
  };

  // Task context (if applicable - for AC triggering scenarios)
  taskContext?: {
    taskId?: string;
    taskTitle?: string;
    taskDescription?: string;
    taskType?: string;
    requiredCapabilities?: string[];
    parameters?: Record<string, any>;
    deadline?: Date;
    priority?: string;
  };

  // Raw payload for debugging
  rawPayload: any;
}

/**
 * Result of normalization with validation info
 */
export interface NormalizationResult {
  context: NormalizedEventContext;
  warnings: string[];
  originalFormat: 'flat' | 'nested-context' | 'mixed' | 'unknown';
}

// ============================================================================
// EventContextNormalizer
// ============================================================================

/**
 * Normalizes event payloads into a unified context structure
 */
export class EventContextNormalizer {
  /**
   * Normalize an event payload
   */
  normalize(event: SystemEvent): NormalizationResult {
    const payload = event.payload || {};
    const warnings: string[] = [];
    const originalFormat = this.detectFormat(payload);

    const context: NormalizedEventContext = {
      eventId: event.id,
      eventType: String(event.type),
      timestamp: event.timestamp || new Date(),
      source: event.source || payload.deviceId || 'unknown',

      // Unified severity
      severity: this.normalizeSeverity(payload, event.priority),
      isUrgent: false, // Will be set below
      isAnomaly: false, // Will be set below
      isEmergency: false, // Will be set below

      // Extracted contexts
      spatialContext: this.extractSpatialContext(payload, event),
      temporalContext: this.extractTemporalContext(payload),

      // Optional contexts
      stateChange: this.extractStateChange(payload),
      anomalyContext: this.extractAnomalyContext(payload),
      trendContext: this.extractTrendContext(payload),
      taskContext: this.extractTaskContext(payload),

      // Raw payload
      rawPayload: payload,
    };

    // Set quick accessors based on normalized severity
    context.isUrgent = this.checkIsUrgent(context.severity, payload);
    context.isAnomaly = context.anomalyContext?.isAnomaly ?? false;
    context.isEmergency = this.checkIsEmergency(context.severity, payload);

    // Generate warnings for potential issues
    if (originalFormat === 'unknown') {
      warnings.push('Event payload format not recognized, using fallback extraction');
    }
    if (!payload.context && !payload.severity && !payload.significance) {
      warnings.push('No severity/significance information found, using event priority as fallback');
    }

    return { context, warnings, originalFormat };
  }

  /**
   * Quick normalization without detailed result
   */
  normalizeQuick(event: SystemEvent): NormalizedEventContext {
    return this.normalize(event).context;
  }

  /**
   * Get severity directly from event (convenience method)
   */
  getSeverity(event: SystemEvent): NormalizedSeverity {
    return this.normalizeQuick(event).severity;
  }

  /**
   * Check if event is urgent (convenience method)
   */
  isUrgent(event: SystemEvent): boolean {
    return this.normalizeQuick(event).isUrgent;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Detect the format of the payload
   */
  private detectFormat(payload: any): 'flat' | 'nested-context' | 'mixed' | 'unknown' {
    const hasFlatSeverity = 'severity' in payload;
    const hasContext = 'context' in payload && typeof payload.context === 'object';

    if (hasFlatSeverity && hasContext) return 'mixed';
    if (hasContext) return 'nested-context';
    if (hasFlatSeverity) return 'flat';
    return 'unknown';
  }

  /**
   * Normalize severity from various formats
   */
  private normalizeSeverity(payload: any, eventPriority?: EventPriority): NormalizedSeverity {
    const ctx = payload.context || {};

    // Priority 1: context.severity (most common for benchmark tests)
    if (ctx.severity) {
      return this.mapSeverity(ctx.severity);
    }

    // Priority 2: context.significance (standard DeviceStateUpdate format)
    if (ctx.significance) {
      return this.mapSignificance(ctx.significance);
    }

    // Priority 3: payload.severity (flat format)
    if (payload.severity) {
      return this.mapSeverity(payload.severity);
    }

    // Priority 4: Check emergency flags
    if (ctx.emergency || payload.emergency) {
      return 'critical';
    }

    // Priority 5: Check anomaly flags
    if (ctx.anomaly || payload.anomaly) {
      return 'high';
    }

    // Priority 6: Check breach flags
    if (ctx.breach || payload.breach) {
      return 'urgent';
    }

    // Fallback: Use event priority
    if (eventPriority) {
      return this.mapEventPriority(eventPriority);
    }

    // Default
    return 'normal';
  }

  /**
   * Map various severity strings to normalized severity
   */
  private mapSeverity(value: string): NormalizedSeverity {
    const mapping: Record<string, NormalizedSeverity> = {
      'low': 'low',
      'normal': 'normal',
      'medium': 'medium',
      'warning': 'high',
      'high': 'high',
      'urgent': 'urgent',
      'critical': 'critical',
      'emergency': 'critical',
      'anomaly': 'high',
    };
    return mapping[value.toLowerCase()] || 'normal';
  }

  /**
   * Map significance to severity
   */
  private mapSignificance(value: string): NormalizedSeverity {
    const mapping: Record<string, NormalizedSeverity> = {
      'normal': 'normal',
      'warning': 'high',
      'critical': 'critical',
    };
    return mapping[value.toLowerCase()] || 'normal';
  }

  /**
   * Map EventPriority to NormalizedSeverity
   */
  private mapEventPriority(priority: EventPriority): NormalizedSeverity {
    const mapping: Record<EventPriority, NormalizedSeverity> = {
      [EventPriority.LOW]: 'low',
      [EventPriority.NORMAL]: 'normal',
      [EventPriority.HIGH]: 'high',
      [EventPriority.URGENT]: 'urgent',
    };
    return mapping[priority] || 'normal';
  }

  /**
   * Check if the event is urgent based on normalized severity and payload
   */
  private checkIsUrgent(severity: NormalizedSeverity, payload: any): boolean {
    // Check severity level
    const urgentSeverities: NormalizedSeverity[] = ['high', 'urgent', 'critical'];
    if (urgentSeverities.includes(severity)) {
      return true;
    }

    // Check additional urgency indicators
    const ctx = payload.context || {};

    // Emergency flag
    if (ctx.emergency === true || payload.emergency === true) {
      return true;
    }

    // Breach flag
    if (ctx.breach === true || payload.breach === true) {
      return true;
    }

    // Anomaly with high confidence
    if (ctx.anomaly === true && ctx.anomalyConfidence && ctx.anomalyConfidence > 0.8) {
      return true;
    }

    return false;
  }

  /**
   * Check if the event is an emergency
   */
  private checkIsEmergency(severity: NormalizedSeverity, payload: any): boolean {
    if (severity === 'critical' || severity === 'urgent') {
      return true;
    }

    const ctx = payload.context || {};
    return ctx.emergency === true || payload.emergency === true;
  }

  /**
   * Extract spatial context from payload
   */
  private extractSpatialContext(
    payload: any,
    event: SystemEvent
  ): NormalizedEventContext['spatialContext'] {
    const ctx = payload.context || {};

    // Try various location formats
    let location: NormalizedEventContext['spatialContext']['location'];

    // Format 1: coordinates object
    if (ctx.location?.coordinates || payload.location?.coordinates) {
      const coords = ctx.location?.coordinates || payload.location?.coordinates;
      location = {
        x: coords.x ?? coords[0],
        y: coords.y ?? coords[1],
        z: coords.z ?? coords[2] ?? 0,
      };
    }
    // Format 2: direct x,y,z
    else if (ctx.x !== undefined || payload.x !== undefined) {
      location = {
        x: ctx.x ?? payload.x,
        y: ctx.y ?? payload.y,
        z: ctx.z ?? payload.z ?? 0,
      };
    }
    // Format 3: location string
    else if (ctx.location || payload.location) {
      location = ctx.location || payload.location;
    }
    // Format 4: from event metadata
    else if (event.metadata?.location) {
      location = event.metadata.location;
    }

    return {
      location,
      zone: ctx.zone || ctx.location?.zone || payload.zone,
      floor: ctx.floor || ctx.location?.floor || payload.floor,
      building: ctx.building || ctx.location?.building || payload.building,
    };
  }

  /**
   * Extract temporal context from payload
   */
  private extractTemporalContext(
    payload: any
  ): NormalizedEventContext['temporalContext'] {
    const ctx = payload.context || {};

    return {
      isPeriodic: ctx.periodic === true || payload.periodic === true,
      isScheduled: ctx.scheduled === true || payload.scheduled === true,
      recurrencePattern: ctx.recurrencePattern || payload.recurrencePattern,
    };
  }

  /**
   * Extract state change information
   */
  private extractStateChange(
    payload: any
  ): NormalizedEventContext['stateChange'] | undefined {
    // Check for stateChange object
    if (payload.stateChange) {
      return {
        deviceId: payload.deviceId,
        deviceType: payload.deviceType,
        property: payload.stateChange.property,
        oldValue: payload.stateChange.oldValue,
        newValue: payload.stateChange.newValue,
        unit: payload.stateChange.unit,
      };
    }

    // Check for direct state properties
    if (payload.deviceId && payload.property !== undefined) {
      return {
        deviceId: payload.deviceId,
        deviceType: payload.deviceType,
        property: payload.property,
        oldValue: payload.oldValue,
        newValue: payload.newValue,
        unit: payload.unit,
      };
    }

    return undefined;
  }

  /**
   * Extract anomaly context
   */
  private extractAnomalyContext(
    payload: any
  ): NormalizedEventContext['anomalyContext'] | undefined {
    const ctx = payload.context || {};

    const isAnomaly = ctx.anomaly === true || payload.anomaly === true;
    if (!isAnomaly && !ctx.anomalyType && !payload.anomalyType) {
      return undefined;
    }

    return {
      isAnomaly,
      anomalyType: ctx.anomalyType || payload.anomalyType,
      confidence: ctx.anomalyConfidence || payload.anomalyConfidence,
      relatedMetrics: ctx.relatedMetrics || payload.relatedMetrics,
    };
  }

  /**
   * Extract trend context
   */
  private extractTrendContext(
    payload: any
  ): NormalizedEventContext['trendContext'] | undefined {
    const ctx = payload.context || {};
    const trend = ctx.trend || payload.trend;

    if (!trend) {
      return undefined;
    }

    return {
      direction: this.mapTrend(trend),
      rate: ctx.trendRate || payload.trendRate,
      predictedValue: ctx.predictedValue || payload.predictedValue,
      predictionConfidence: ctx.predictionConfidence || payload.predictionConfidence,
    };
  }

  /**
   * Map trend string to normalized trend
   */
  private mapTrend(value: string): NormalizedTrend {
    const mapping: Record<string, NormalizedTrend> = {
      'increasing': 'increasing',
      'rising': 'increasing',
      'up': 'increasing',
      'decreasing': 'decreasing',
      'falling': 'decreasing',
      'down': 'decreasing',
      'stable': 'stable',
      'steady': 'stable',
      'constant': 'stable',
      'volatile': 'volatile',
      'fluctuating': 'volatile',
      'unknown': 'unknown',
    };
    return mapping[value.toLowerCase()] || 'unknown';
  }

  /**
   * Extract task context (for AC triggering scenarios)
   */
  private extractTaskContext(
    payload: any
  ): NormalizedEventContext['taskContext'] | undefined {
    // Check for explicit task information
    if (!payload.taskTitle && !payload.taskType && !payload.requiredCapabilities) {
      return undefined;
    }

    return {
      taskId: payload.taskId,
      taskTitle: payload.taskTitle,
      taskDescription: payload.taskDescription || payload.description,
      taskType: payload.taskType || payload.type,
      requiredCapabilities: payload.requiredCapabilities || [],
      parameters: payload.parameters,
      deadline: payload.deadline ? new Date(payload.deadline) : undefined,
      priority: payload.priority,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Default normalizer instance
 */
export const eventContextNormalizer = new EventContextNormalizer();

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Normalize an event (convenience function)
 */
export function normalizeEvent(event: SystemEvent): NormalizedEventContext {
  return eventContextNormalizer.normalizeQuick(event);
}

/**
 * Get severity from event (convenience function)
 */
export function getEventSeverity(event: SystemEvent): NormalizedSeverity {
  return eventContextNormalizer.getSeverity(event);
}

/**
 * Check if event is urgent (convenience function)
 */
export function isEventUrgent(event: SystemEvent): boolean {
  return eventContextNormalizer.isUrgent(event);
}
