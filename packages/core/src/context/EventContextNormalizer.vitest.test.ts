/**
 * Tests for EventContextNormalizer
 *
 * Tests the normalization of various event payload formats into unified context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EventContextNormalizer,
  normalizeEvent,
  getEventSeverity,
  isEventUrgent,
  type NormalizedEventContext,
  type NormalizationResult,
} from './EventContextNormalizer.js';
import { EventType, EventPriority, type SystemEvent } from '@active-collaboration/shared';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a mock SystemEvent
 */
function createMockEvent(
  payload: any,
  type: EventType = EventType.DEVICE_STATE_UPDATE,
  priority: EventPriority = EventPriority.NORMAL
): SystemEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    source: 'test-source',
    timestamp: new Date(),
    priority,
    payload,
    metadata: {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EventContextNormalizer', () => {
  let normalizer: EventContextNormalizer;

  beforeEach(() => {
    normalizer = new EventContextNormalizer();
  });

  describe('Format Detection', () => {
    it('should detect flat format (severity at root)', () => {
      const event = createMockEvent({ severity: 'high' });
      const result = normalizer.normalize(event);
      expect(result.originalFormat).toBe('flat');
    });

    it('should detect nested-context format (severity in context)', () => {
      const event = createMockEvent({ context: { severity: 'high' } });
      const result = normalizer.normalize(event);
      expect(result.originalFormat).toBe('nested-context');
    });

    it('should detect mixed format (both flat and nested)', () => {
      const event = createMockEvent({
        severity: 'low',
        context: { severity: 'high' }
      });
      const result = normalizer.normalize(event);
      expect(result.originalFormat).toBe('mixed');
    });

    it('should detect unknown format (no severity info)', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.originalFormat).toBe('unknown');
    });
  });

  describe('Severity Normalization', () => {
    it('should normalize flat severity: low', () => {
      const event = createMockEvent({ severity: 'low' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('low');
    });

    it('should normalize flat severity: high', () => {
      const event = createMockEvent({ severity: 'high' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('high');
    });

    it('should normalize flat severity: urgent', () => {
      const event = createMockEvent({ severity: 'urgent' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('urgent');
    });

    it('should normalize flat severity: critical', () => {
      const event = createMockEvent({ severity: 'critical' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('critical');
    });

    it('should prioritize context.severity over flat severity', () => {
      const event = createMockEvent({
        severity: 'low',
        context: { severity: 'critical' }
      });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('critical');
    });

    it('should normalize significance: warning to high', () => {
      const event = createMockEvent({ context: { significance: 'warning' } });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('high');
    });

    it('should normalize significance: critical to critical', () => {
      const event = createMockEvent({ context: { significance: 'critical' } });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('critical');
    });

    it('should normalize significance: normal to normal', () => {
      const event = createMockEvent({ context: { significance: 'normal' } });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });

    it('should default to normal when no severity info', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });

    it('should infer severity from emergency flag', () => {
      const event = createMockEvent({ emergency: true });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('critical');
    });

    it('should infer severity from anomaly flag', () => {
      const event = createMockEvent({ context: { anomaly: true } });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('high');
    });
  });

  describe('Urgency Detection', () => {
    it('should mark high severity as urgent', () => {
      const event = createMockEvent({ severity: 'high' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(true);
    });

    it('should mark urgent severity as urgent', () => {
      const event = createMockEvent({ severity: 'urgent' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(true);
    });

    it('should mark critical severity as urgent', () => {
      const event = createMockEvent({ severity: 'critical' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(true);
    });

    it('should mark low severity as not urgent', () => {
      const event = createMockEvent({ severity: 'low' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(false);
    });

    it('should mark normal severity as not urgent', () => {
      const event = createMockEvent({ severity: 'normal' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(false);
    });

    it('should mark medium severity as not urgent', () => {
      const event = createMockEvent({ severity: 'medium' });
      const result = normalizer.normalize(event);
      expect(result.context.isUrgent).toBe(false);
    });
  });

  describe('State Change Extraction', () => {
    it('should extract state change from payload', () => {
      const event = createMockEvent({
        deviceId: 'sensor-1',
        deviceType: 'temperature-sensor',
        stateChange: {
          property: 'temperature',
          oldValue: 25,
          newValue: 30,
          unit: '°C',
        },
      });
      const result = normalizer.normalize(event);

      expect(result.context.stateChange).toBeDefined();
      expect(result.context.stateChange?.deviceId).toBe('sensor-1');
      expect(result.context.stateChange?.property).toBe('temperature');
      expect(result.context.stateChange?.oldValue).toBe(25);
      expect(result.context.stateChange?.newValue).toBe(30);
    });

    it('should return undefined when no state change', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.context.stateChange).toBeUndefined();
    });
  });

  describe('Spatial Context Extraction', () => {
    it('should extract location from context', () => {
      const event = createMockEvent({
        context: {
          location: {
            coordinates: { x: 10, y: 20, z: 0 },
            zone: 'living-room',
            floor: 1,
          },
        },
      });
      const result = normalizer.normalize(event);

      expect(result.context.spatialContext.location).toEqual({ x: 10, y: 20, z: 0 });
      expect(result.context.spatialContext.zone).toBe('living-room');
      expect(result.context.spatialContext.floor).toBe(1);
    });

    it('should extract location from payload root', () => {
      const event = createMockEvent({
        location: 'kitchen',
      });
      const result = normalizer.normalize(event);

      expect(result.context.spatialContext.location).toBe('kitchen');
    });
  });

  describe('Anomaly Context Extraction', () => {
    it('should extract anomaly context', () => {
      const event = createMockEvent({
        context: {
          anomaly: true,
          anomalyType: 'temperature_spike',
          anomalyConfidence: 0.95,
        },
      });
      const result = normalizer.normalize(event);

      expect(result.context.anomalyContext).toBeDefined();
      expect(result.context.anomalyContext?.isAnomaly).toBe(true);
      expect(result.context.anomalyContext?.anomalyType).toBe('temperature_spike');
      expect(result.context.anomalyContext?.confidence).toBe(0.95);
    });

    it('should return undefined when no anomaly info', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.context.anomalyContext).toBeUndefined();
    });
  });

  describe('Trend Context Extraction', () => {
    it('should extract trend context', () => {
      const event = createMockEvent({
        context: {
          trend: 'increasing',
          trendRate: 2.5,
          predictedValue: 35,
        },
      });
      const result = normalizer.normalize(event);

      expect(result.context.trendContext).toBeDefined();
      expect(result.context.trendContext?.direction).toBe('increasing');
      expect(result.context.trendContext?.rate).toBe(2.5);
      expect(result.context.trendContext?.predictedValue).toBe(35);
    });

    it('should normalize trend aliases', () => {
      const event = createMockEvent({ context: { trend: 'rising' } });
      const result = normalizer.normalize(event);
      expect(result.context.trendContext?.direction).toBe('increasing');

      const event2 = createMockEvent({ context: { trend: 'falling' } });
      const result2 = normalizer.normalize(event2);
      expect(result2.context.trendContext?.direction).toBe('decreasing');
    });

    it('should return undefined when no trend info', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.context.trendContext).toBeUndefined();
    });
  });

  describe('Task Context Extraction', () => {
    it('should extract task context', () => {
      const event = createMockEvent({
        taskId: 'task-1',
        taskTitle: 'Control Temperature',
        taskDescription: 'Reduce temperature to 22°C',
        taskType: 'climate-control',
        requiredCapabilities: ['temperature-control', 'hvac-control'],
        parameters: { targetTemp: 22 },
      });
      const result = normalizer.normalize(event);

      expect(result.context.taskContext).toBeDefined();
      expect(result.context.taskContext?.taskId).toBe('task-1');
      expect(result.context.taskContext?.taskTitle).toBe('Control Temperature');
      expect(result.context.taskContext?.requiredCapabilities).toEqual(['temperature-control', 'hvac-control']);
    });

    it('should return undefined when no task info', () => {
      const event = createMockEvent({ deviceId: 'device-1' });
      const result = normalizer.normalize(event);
      expect(result.context.taskContext).toBeUndefined();
    });
  });

  describe('Event Priority Integration', () => {
    it('should use event priority as fallback', () => {
      const event = createMockEvent({}, EventType.DEVICE_STATE_UPDATE, EventPriority.HIGH);
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('high');
    });

    it('should prioritize payload severity over event priority', () => {
      const event = createMockEvent(
        { severity: 'critical' },
        EventType.DEVICE_STATE_UPDATE,
        EventPriority.LOW
      );
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('critical');
    });
  });

  describe('Convenience Functions', () => {
    it('normalizeEvent should work', () => {
      const event = createMockEvent({ severity: 'high' });
      const context = normalizeEvent(event);
      expect(context.severity).toBe('high');
    });

    it('getEventSeverity should work', () => {
      const event = createMockEvent({ severity: 'urgent' });
      expect(getEventSeverity(event)).toBe('urgent');
    });

    it('isEventUrgent should work', () => {
      const urgentEvent = createMockEvent({ severity: 'critical' });
      const normalEvent = createMockEvent({ severity: 'normal' });

      expect(isEventUrgent(urgentEvent)).toBe(true);
      expect(isEventUrgent(normalEvent)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null payload', () => {
      const event = createMockEvent(null);
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });

    it('should handle undefined payload', () => {
      const event = createMockEvent(undefined);
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });

    it('should handle empty payload', () => {
      const event = createMockEvent({});
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });

    it('should handle case-insensitive severity', () => {
      const event = createMockEvent({ severity: 'HIGH' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('high');
    });

    it('should handle unknown severity values', () => {
      const event = createMockEvent({ severity: 'unknown-value' });
      const result = normalizer.normalize(event);
      expect(result.context.severity).toBe('normal');
    });
  });
});
