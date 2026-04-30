/**
 * ThresholdMonitor Unit Tests (TDD)
 *
 * Tests for threshold-based parameter monitoring and alerting.
 * These tests are written BEFORE implementation following TDD principles.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ThresholdMonitor, type MonitorStateLevel, type ThresholdCheckResult } from '../ThresholdMonitor.js';
import type { ThresholdMonitorConfig, TriggerAction, ThresholdLevel } from '../../config/types.js';

describe('ThresholdMonitor', () => {
  let monitor: ThresholdMonitor;
  let executedActions: { action: TriggerAction; level: string }[];

  beforeEach(() => {
    monitor = new ThresholdMonitor();
    executedActions = [];

    // Set up action executor mock
    monitor.setActionExecutor(async (action: TriggerAction, level: string) => {
      executedActions.push({ action, level });
      return { success: true, action };
    });
  });

  afterEach(() => {
    monitor.clearAllMonitors();
    vi.useRealTimers();
  });

  describe('addMonitor', () => {
    it('should add a valid threshold monitor', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      expect(() => monitor.addMonitor(config)).not.toThrow();
      expect(monitor.hasMonitor('monitor-1')).toBe(true);
    });

    it('should throw error when adding monitor with duplicate id', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Monitor 1',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
      };

      monitor.addMonitor(config);

      const duplicateConfig: ThresholdMonitorConfig = {
        ...config,
        name: 'Duplicate Monitor',
      };

      expect(() => monitor.addMonitor(duplicateConfig)).toThrow(/already exists/);
    });

    it('should add monitor with only warning threshold', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Warning Only',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'humidity',
        warningThreshold: {
          operator: '<',
          value: 20,
        },
      };

      expect(() => monitor.addMonitor(config)).not.toThrow();
    });

    it('should add monitor with only critical threshold', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Critical Only',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'pressure',
        criticalThreshold: {
          operator: '>=',
          value: 100,
        },
      };

      expect(() => monitor.addMonitor(config)).not.toThrow();
    });
  });

  describe('removeMonitor', () => {
    it('should remove an existing monitor', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Test Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
      };

      monitor.addMonitor(config);
      expect(monitor.hasMonitor('monitor-1')).toBe(true);

      monitor.removeMonitor('monitor-1');
      expect(monitor.hasMonitor('monitor-1')).toBe(false);
    });

    it('should return false when removing non-existent monitor', () => {
      const result = monitor.removeMonitor('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('checkValue', () => {
    it('should return normal state when value is within thresholds', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      const result = monitor.checkValue('monitor-1', 25);

      expect(result.state).toBe('normal');
      expect(result.triggered).toBe(false);
    });

    it('should return warning state when warning threshold is crossed', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      const result = monitor.checkValue('monitor-1', 35);

      expect(result.state).toBe('warning');
      expect(result.triggered).toBe(true);
      expect(result.triggeredLevel).toBe('warning');
    });

    it('should return critical state when critical threshold is crossed', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      const result = monitor.checkValue('monitor-1', 45);

      expect(result.state).toBe('critical');
      expect(result.triggered).toBe(true);
      expect(result.triggeredLevel).toBe('critical');
    });

    it('should not trigger for disabled monitor', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Disabled Monitor',
        enabled: false,
        deviceId: 'device-1',
        parameter: 'temperature',
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      const result = monitor.checkValue('monitor-1', 50);

      expect(result.triggered).toBe(false);
      expect(result.state).toBe('normal');
    });

    it('should support less than operator', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Low Battery',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'battery',
        warningThreshold: {
          operator: '<',
          value: 20,
        },
      };

      monitor.addMonitor(config);

      expect(monitor.checkValue('monitor-1', 15).state).toBe('warning');
      expect(monitor.checkValue('monitor-1', 25).state).toBe('normal');
    });

    it('should support greater than or equal operator', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Pressure Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'pressure',
        warningThreshold: {
          operator: '>=',
          value: 100,
        },
      };

      monitor.addMonitor(config);

      expect(monitor.checkValue('monitor-1', 100).state).toBe('warning');
      expect(monitor.checkValue('monitor-1', 99).state).toBe('normal');
    });

    it('should support less than or equal operator', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Min Temp',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        criticalThreshold: {
          operator: '<=',
          value: 0,
        },
      };

      monitor.addMonitor(config);

      expect(monitor.checkValue('monitor-1', 0).state).toBe('critical');
      expect(monitor.checkValue('monitor-1', -5).state).toBe('critical');
      expect(monitor.checkValue('monitor-1', 1).state).toBe('normal');
    });

    it('should support equality operator', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Status Check',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'status',
        criticalThreshold: {
          operator: '==',
          value: 'error' as unknown as number,
        },
      };

      monitor.addMonitor(config);

      expect(monitor.checkValue('monitor-1', 'error').state).toBe('critical');
      expect(monitor.checkValue('monitor-1', 'ok').state).toBe('normal');
    });
  });

  describe('executeActions', () => {
    it('should execute warning action when warning threshold crossed', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        warningAction: {
          type: 'notification',
          description: 'Temperature warning',
        },
      };

      monitor.addMonitor(config);
      await monitor.checkAndExecute('monitor-1', 35);

      expect(executedActions.length).toBe(1);
      expect(executedActions[0].level).toBe('warning');
      expect(executedActions[0].action.type).toBe('notification');
    });

    it('should execute critical action when critical threshold crossed', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
        criticalAction: {
          type: 'device-control',
          deviceId: 'cooling-system',
          command: 'turnOn',
        },
      };

      monitor.addMonitor(config);
      await monitor.checkAndExecute('monitor-1', 45);

      expect(executedActions.length).toBe(1);
      expect(executedActions[0].level).toBe('critical');
      expect(executedActions[0].action.command).toBe('turnOn');
    });

    it('should not execute action if no action defined for level', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        // No warning action defined
      };

      monitor.addMonitor(config);
      await monitor.checkAndExecute('monitor-1', 35);

      expect(executedActions.length).toBe(0);
    });
  });

  describe('hysteresis', () => {
    it('should not re-trigger when value oscillates within hysteresis', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        warningAction: {
          type: 'notification',
        },
        hysteresis: 2, // Value must drop 2 below threshold to reset
      };

      monitor.addMonitor(config);

      // First trigger at 35
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(1);

      // Drop to 29 (within hysteresis of 30-2=28)
      await monitor.checkAndExecute('monitor-1', 29);
      expect(executedActions.length).toBe(1); // No new action

      // Go back up to 32
      await monitor.checkAndExecute('monitor-1', 32);
      expect(executedActions.length).toBe(1); // Still no new action (still in warning)

      // Drop below hysteresis to 27
      await monitor.checkAndExecute('monitor-1', 27);
      expect(executedActions.length).toBe(1); // State cleared but no action

      // Go back up to trigger again
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(2); // New trigger!
    });
  });

  describe('duration requirement', () => {
    it('should not trigger if threshold not crossed for required duration', async () => {
      vi.useFakeTimers();

      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
          duration: 5000, // Must persist for 5 seconds
        },
        warningAction: {
          type: 'notification',
        },
      };

      monitor.addMonitor(config);

      // Check at threshold
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(0); // Not triggered yet

      // Advance 3 seconds (not enough)
      vi.advanceTimersByTime(3000);
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(0); // Still not triggered

      // Advance 3 more seconds (total 6 seconds)
      vi.advanceTimersByTime(3000);
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(1); // Now triggered!
    });

    it('should reset duration timer if value drops below threshold', async () => {
      vi.useFakeTimers();

      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
          duration: 5000,
        },
        warningAction: {
          type: 'notification',
        },
      };

      monitor.addMonitor(config);

      // Start at threshold
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(0);

      // Advance 3 seconds
      vi.advanceTimersByTime(3000);

      // Value drops below threshold
      await monitor.checkAndExecute('monitor-1', 25);
      expect(executedActions.length).toBe(0);

      // Value goes back up
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(0); // Duration timer reset

      // Advance only 3 more seconds (not enough since reset)
      vi.advanceTimersByTime(3000);
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(0); // Still not enough time

      // Advance 3 more seconds (total 6 from reset, but only 3 from last check)
      vi.advanceTimersByTime(3000);
      await monitor.checkAndExecute('monitor-1', 35);
      expect(executedActions.length).toBe(1); // Now triggered!
    });
  });

  describe('state transitions', () => {
    it('should track state transitions correctly', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      // Normal
      expect(monitor.getCurrentState('monitor-1')).toBe('normal');

      // Check warning
      monitor.checkValue('monitor-1', 35);
      expect(monitor.getCurrentState('monitor-1')).toBe('warning');

      // Check critical
      monitor.checkValue('monitor-1', 45);
      expect(monitor.getCurrentState('monitor-1')).toBe('critical');

      // Back to warning
      monitor.checkValue('monitor-1', 35);
      expect(monitor.getCurrentState('monitor-1')).toBe('warning');

      // Back to normal
      monitor.checkValue('monitor-1', 25);
      expect(monitor.getCurrentState('monitor-1')).toBe('normal');
    });

    it('should transition directly to critical from normal', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        criticalThreshold: {
          operator: '>',
          value: 40,
        },
      };

      monitor.addMonitor(config);

      // Direct to critical
      monitor.checkValue('monitor-1', 45);
      expect(monitor.getCurrentState('monitor-1')).toBe('critical');
    });
  });

  describe('enableMonitor / disableMonitor', () => {
    it('should toggle monitor enabled state', () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Test Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
      };

      monitor.addMonitor(config);
      expect(monitor.isMonitorEnabled('monitor-1')).toBe(true);

      monitor.disableMonitor('monitor-1');
      expect(monitor.isMonitorEnabled('monitor-1')).toBe(false);

      monitor.enableMonitor('monitor-1');
      expect(monitor.isMonitorEnabled('monitor-1')).toBe(true);
    });
  });

  describe('getMonitorStats', () => {
    it('should return statistics for a monitor', async () => {
      const config: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temperature Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        warningAction: {
          type: 'notification',
        },
      };

      monitor.addMonitor(config);

      // Check normal
      monitor.checkValue('monitor-1', 25);

      // Check warning (trigger - state transition from normal to warning)
      await monitor.checkAndExecute('monitor-1', 35);

      // Check warning again (no trigger - already in warning state)
      monitor.checkValue('monitor-1', 36);

      // Back to normal
      monitor.checkValue('monitor-1', 25);

      // Back to warning (trigger - state transition from normal to warning)
      await monitor.checkAndExecute('monitor-1', 38);

      const stats = monitor.getMonitorStats('monitor-1');

      expect(stats.totalChecks).toBe(5);
      expect(stats.warningTriggerCount).toBe(2); // Two state transitions to warning
      expect(stats.criticalTriggerCount).toBe(0);
      expect(stats.actionExecutionCount).toBe(2); // Two action executions
    });
  });

  describe('getActiveMonitors', () => {
    it('should return all enabled monitors', () => {
      const config1: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Monitor 1',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
      };

      const config2: ThresholdMonitorConfig = {
        id: 'monitor-2',
        name: 'Monitor 2',
        enabled: false,
        deviceId: 'device-2',
        parameter: 'humidity',
      };

      const config3: ThresholdMonitorConfig = {
        id: 'monitor-3',
        name: 'Monitor 3',
        enabled: true,
        deviceId: 'device-3',
        parameter: 'pressure',
      };

      monitor.addMonitor(config1);
      monitor.addMonitor(config2);
      monitor.addMonitor(config3);

      const activeMonitors = monitor.getActiveMonitors();

      expect(activeMonitors.length).toBe(2);
      expect(activeMonitors.find(m => m.id === 'monitor-1')).toBeDefined();
      expect(activeMonitors.find(m => m.id === 'monitor-3')).toBeDefined();
    });
  });

  describe('clearAllMonitors', () => {
    it('should remove all monitors', () => {
      const config1: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Monitor 1',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
      };

      const config2: ThresholdMonitorConfig = {
        id: 'monitor-2',
        name: 'Monitor 2',
        enabled: true,
        deviceId: 'device-2',
        parameter: 'humidity',
      };

      monitor.addMonitor(config1);
      monitor.addMonitor(config2);
      expect(monitor.getActiveMonitors().length).toBe(2);

      monitor.clearAllMonitors();
      expect(monitor.getActiveMonitors().length).toBe(0);
    });
  });

  describe('checkAllMonitors', () => {
    it('should check all monitors for a device', async () => {
      const config1: ThresholdMonitorConfig = {
        id: 'monitor-1',
        name: 'Temp Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
        warningAction: {
          type: 'notification',
          description: 'High temp',
        },
      };

      const config2: ThresholdMonitorConfig = {
        id: 'monitor-2',
        name: 'Humidity Monitor',
        enabled: true,
        deviceId: 'device-1',
        parameter: 'humidity',
        warningThreshold: {
          operator: '>',
          value: 70,
        },
        warningAction: {
          type: 'notification',
          description: 'High humidity',
        },
      };

      const config3: ThresholdMonitorConfig = {
        id: 'monitor-3',
        name: 'Other Device Monitor',
        enabled: true,
        deviceId: 'device-2',
        parameter: 'temperature',
        warningThreshold: {
          operator: '>',
          value: 30,
        },
      };

      monitor.addMonitor(config1);
      monitor.addMonitor(config2);
      monitor.addMonitor(config3);

      // Device state with both temp and humidity exceeding thresholds
      const deviceState = {
        temperature: 35,
        humidity: 75,
      };

      const results = await monitor.checkAllMonitorsForDevice('device-1', deviceState);

      // Should trigger both device-1 monitors, but not device-2
      expect(results.length).toBe(2);
      expect(results.find(r => r.monitorId === 'monitor-1')?.triggered).toBe(true);
      expect(results.find(r => r.monitorId === 'monitor-2')?.triggered).toBe(true);
      expect(executedActions.length).toBe(2);
    });
  });
});
