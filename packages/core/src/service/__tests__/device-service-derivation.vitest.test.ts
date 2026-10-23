/**
 * Device-service derivation unit tests (P1)
 *
 * The helper is the single source of truth for derived services, shared by
 * the runtime registry (one `<device name> Service` per device) and the
 * world-layer derivation sync (per-capability honest labels).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveDeviceService,
  deriveDeviceServiceActionType,
  deriveDeviceServiceDescription,
  deriveDeviceServiceName,
  deriveDeviceSemanticCapabilities,
  deviceResourceType,
  honestSemanticType,
  isSwitchingSurface,
  mapCapabilityTypeToParameterType,
  SEMANTIC_TYPE_SWITCHING,
} from '../device-service-derivation.js';

describe('device-service-derivation', () => {
  describe('runtime-face naming', () => {
    it('names the service `<device name> Service` (discovery consumers strip this suffix)', () => {
      expect(deriveDeviceServiceName('Lobby Ceiling Lights')).toBe('Lobby Ceiling Lights Service');
    });

    it('describes the service as provided by the device', () => {
      expect(deriveDeviceServiceDescription('Lobby Ceiling Lights')).toBe(
        'Service provided by device Lobby Ceiling Lights',
      );
    });
  });

  describe('deviceResourceType', () => {
    it('maps known device types to resource types', () => {
      expect(deviceResourceType('temperature-sensor')).toBe('sensor');
      expect(deviceResourceType('smart-light')).toBe('lighting');
      expect(deviceResourceType('hvac-unit')).toBe('hvac');
      expect(deviceResourceType('smart-lock')).toBe('security');
      expect(deviceResourceType('smart-plug')).toBe('power');
    });

    it('falls back to `device` for unknown or missing types', () => {
      expect(deviceResourceType('coffee-machine-3000')).toBe('device');
      expect(deviceResourceType(undefined)).toBe('device');
    });
  });

  describe('deriveDeviceServiceActionType', () => {
    it('derives observe/control/both from capability verbs', () => {
      expect(deriveDeviceServiceActionType([{ name: 'temperature', type: 'read' }])).toBe('observe');
      expect(deriveDeviceServiceActionType([{ name: 'set-temperature', type: 'write' }])).toBe('control');
      expect(deriveDeviceServiceActionType([
        { name: 'temperature', type: 'read' },
        { name: 'set-temperature', type: 'write' },
      ])).toBe('both');
      expect(deriveDeviceServiceActionType([])).toBe('observe');
    });
  });

  describe('deriveDeviceSemanticCapabilities', () => {
    it('derives device-type semantics without agent input (T-202)', () => {
      expect(deriveDeviceSemanticCapabilities({ name: 'Desk Lamp', type: 'smart-light' }))
        .toContain('lighting-control');
      const hvac = deriveDeviceSemanticCapabilities({ name: 'AC', type: 'hvac' });
      expect(hvac).toContain('hvac-control');
      expect(hvac).toContain('temperature-control');
    });

    it('derives semantics from device capability verbs', () => {
      const derived = deriveDeviceSemanticCapabilities({
        name: 'Meter',
        type: 'energy-meter',
        capabilities: [
          { name: 'temperature', type: 'read' },
          { name: 'set-threshold', type: 'write' },
        ],
      });
      expect(derived).toContain('monitoring');
      expect(derived).toContain('temperature-monitoring');
      expect(derived).toContain('control');
      expect(derived).toContain('actuation');
    });

    it('combines agent capabilities when provided (non-publication callers)', () => {
      const derived = deriveDeviceSemanticCapabilities(
        { name: 'Thermostat', type: 'thermostat' },
        ['control'],
      );
      expect(derived).toContain('cooling');
      expect(derived).toContain('heating');
      expect(derived).toContain('control');
    });
  });

  describe('mapCapabilityTypeToParameterType', () => {
    it('maps known verb types and falls back to string', () => {
      expect(mapCapabilityTypeToParameterType('number')).toBe('number');
      expect(mapCapabilityTypeToParameterType('boolean')).toBe('boolean');
      expect(mapCapabilityTypeToParameterType('read')).toBe('string');
      expect(mapCapabilityTypeToParameterType('unknown')).toBe('string');
      expect(mapCapabilityTypeToParameterType(undefined)).toBe('string');
    });
  });

  describe('deriveDeviceService', () => {
    it('derives the full runtime-face spec with device-only capabilities', () => {
      const spec = deriveDeviceService({
        name: 'Lobby Light',
        type: 'smart-light',
        capabilities: [
          { name: 'turn-on', type: 'execute' },
          { name: 'brightness', type: 'read' },
        ],
      });

      expect(spec.name).toBe('Lobby Light Service');
      expect(spec.description).toBe('Service provided by device Lobby Light');
      expect(spec.semanticType).toBe('lighting');
      expect(spec.category).toBe('lighting');
      expect(spec.actionType).toBe('both');
      // declared names first, then device-only semantic derivations, deduped
      expect(spec.capabilities).toEqual(['turn-on', 'brightness', 'lighting-control', 'control', 'actuation']);
      expect(spec.parameters).toEqual([
        { name: 'turn-on', type: 'string', required: false, description: 'turn-on parameter' },
        { name: 'brightness', type: 'string', required: false, description: 'brightness parameter' },
      ]);
    });
  });

  describe('world-face honest semantic labels (T-043)', () => {
    it('detects pure power-switching surfaces', () => {
      expect(isSwitchingSurface(['turn-on', 'turn-off'])).toBe(true);
      expect(isSwitchingSurface(['turn-on'])).toBe(true);
      expect(isSwitchingSurface(['turn-on', 'set-brightness'])).toBe(false);
      expect(isSwitchingSurface([])).toBe(false);
    });

    it('labels switching-only capabilities honestly', () => {
      expect(honestSemanticType('ventilation', ['turn-on', 'turn-off'])).toBe(SEMANTIC_TYPE_SWITCHING);
      expect(honestSemanticType('turn-on', ['turn-on'])).toBe('turn-on');
      expect(honestSemanticType('lighting-control', ['turn-on', 'set-brightness']))
        .toBe('lighting-control');
    });
  });
});
