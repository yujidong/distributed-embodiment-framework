/**
 * @vitest-environment node
 *
 * entity-map tests — pure mapping, no sockets. Pins the domain/device_class
 * → capability table (≥10 cases) and the semantic-command → HA-service-call
 * allowlist, including the "unknown command → null" safety floor.
 */

import { describe, expect, it } from 'vitest';

import { domainOf, makeCommandMapper, mapHassEntity, suggestedCapabilitiesFor } from './entity-map.js';

describe('mapHassEntity — domain/device_class → capabilities', () => {
  const cases: Array<{
    entityId: string;
    attributes?: Record<string, unknown>;
    deviceType: string;
    capabilities: string[];
  }> = [
    {
      entityId: 'climate.living_room_ac',
      deviceType: 'climate',
      capabilities: ['temperature-control', 'cooling', 'heating', 'temperature-monitoring'],
    },
    {
      entityId: 'light.living_room',
      deviceType: 'light',
      capabilities: ['lighting-control', 'brightness-control'],
    },
    {
      entityId: 'switch.air_purifier',
      deviceType: 'switch',
      capabilities: ['power-control'],
    },
    {
      entityId: 'fan.bedroom_fan',
      deviceType: 'fan',
      capabilities: ['ventilation'],
    },
    {
      entityId: 'humidifier.bedroom',
      deviceType: 'humidifier',
      capabilities: ['humidity-control'],
    },
    {
      entityId: 'cover.living_room_curtain',
      deviceType: 'cover',
      capabilities: ['curtain-control'],
    },
    {
      entityId: 'sensor.room_temp',
      attributes: { device_class: 'temperature' },
      deviceType: 'sensor',
      capabilities: ['temperature-monitoring'],
    },
    {
      entityId: 'sensor.room_humidity',
      attributes: { device_class: 'humidity' },
      deviceType: 'sensor',
      capabilities: ['humidity-monitoring'],
    },
    {
      entityId: 'sensor.room_pm25',
      attributes: { device_class: 'pm25' },
      deviceType: 'sensor',
      capabilities: ['pm25-monitoring'],
    },
    {
      entityId: 'sensor.room_co2',
      attributes: { device_class: 'co2' },
      deviceType: 'sensor',
      capabilities: ['co2-monitoring'],
    },
    {
      entityId: 'sensor.outdoor_lux',
      attributes: { device_class: 'illuminance' },
      deviceType: 'sensor',
      capabilities: ['light-monitoring'],
    },
    {
      entityId: 'sensor.plug_energy',
      attributes: { device_class: 'energy' },
      deviceType: 'sensor',
      capabilities: ['energy-monitoring'],
    },
    {
      entityId: 'binary_sensor.front_door',
      attributes: { device_class: 'door' },
      deviceType: 'binary_sensor',
      capabilities: ['contact-monitoring'],
    },
    {
      entityId: 'binary_sensor.hallway_motion',
      attributes: { device_class: 'motion' },
      deviceType: 'binary_sensor',
      capabilities: ['motion-detection'],
    },
    {
      entityId: 'binary_sensor.kitchen_smoke',
      attributes: { device_class: 'smoke' },
      deviceType: 'binary_sensor',
      capabilities: ['smoke-detection'],
    },
    // Fallbacks: unknown device_class and unknown domain stay readable.
    {
      entityId: 'sensor.mystery',
      attributes: { device_class: 'aqi_whatever' },
      deviceType: 'sensor',
      capabilities: ['sensor-monitoring'],
    },
    {
      entityId: 'vacuum.robbie',
      deviceType: 'vacuum',
      capabilities: ['vacuum-monitoring'],
    },
  ];

  for (const c of cases) {
    it(`${c.entityId} (${c.attributes?.device_class ?? 'domain'}) → ${c.capabilities.join('+')}`, () => {
      const mapping = mapHassEntity(c.entityId, c.attributes ?? {});
      expect(mapping.deviceType).toBe(c.deviceType);
      expect(mapping.capabilities).toEqual(c.capabilities);
    });
  }
});

describe('makeCommandMapper — semantic command → HA service call', () => {
  it('maps universal on/off/toggle verbs onto the entity domain', () => {
    const mapper = makeCommandMapper('switch');
    expect(mapper('turn-on')).toEqual({ domain: 'switch', service: 'turn_on' });
    expect(mapper('turn-off')).toEqual({ domain: 'switch', service: 'turn_off' });
    expect(mapper('toggle')).toEqual({ domain: 'switch', service: 'toggle' });
    // camelCase/underscore spellings normalize to the same call
    expect(mapper('turnOn')).toEqual({ domain: 'switch', service: 'turn_on' });
    expect(mapper('turn_off')).toEqual({ domain: 'switch', service: 'turn_off' });
  });

  it('maps set-temperature on climate to climate.set_temperature', () => {
    const mapper = makeCommandMapper('climate');
    expect(mapper('set-temperature', { targetTemperature: 24 })).toEqual({
      domain: 'climate',
      service: 'set_temperature',
      service_data: { temperature: 24 },
    });
    // accepted param aliases
    expect(mapper('set-temperature', { temperature: 20 })).toMatchObject({
      service_data: { temperature: 20 },
    });
    expect(mapper('set-temperature', { value: '22' })).toMatchObject({
      service_data: { temperature: 22 },
    });
  });

  it('maps set-brightness on light to light.turn_on with brightness_pct', () => {
    const mapper = makeCommandMapper('light');
    expect(mapper('set-brightness', { brightness: 80 })).toEqual({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness_pct: 80 },
    });
    // 0–1 fraction and 0–255 conventions scale to percent
    expect(mapper('set-brightness', { brightness: 0.5 })).toMatchObject({
      service_data: { brightness_pct: 50 },
    });
    expect(mapper('set-brightness', { brightness: 255 })).toMatchObject({
      service_data: { brightness_pct: 100 },
    });
  });

  it('maps curtain commands on cover entities', () => {
    const mapper = makeCommandMapper('cover');
    expect(mapper('set-curtain', { position: 40 })).toEqual({
      domain: 'cover',
      service: 'set_cover_position',
      service_data: { position: 40 },
    });
    expect(mapper('open-curtain')).toEqual({ domain: 'cover', service: 'open_cover' });
    expect(mapper('close-curtain')).toEqual({ domain: 'cover', service: 'close_cover' });
  });

  it('maps humidity/fan domain commands', () => {
    expect(makeCommandMapper('humidifier')('set-humidity', { humidity: 45 })).toEqual({
      domain: 'humidifier',
      service: 'set_humidity',
      service_data: { humidity: 45 },
    });
    expect(makeCommandMapper('fan')('set-speed', { speed: 60 })).toEqual({
      domain: 'fan',
      service: 'set_percentage',
      service_data: { percentage: 60 },
    });
  });

  it('returns null for commands outside the allowlist (safety floor)', () => {
    // Domain-mismatched command
    expect(makeCommandMapper('light')('set-temperature', { targetTemperature: 24 })).toBeNull();
    // Completely unknown command
    expect(makeCommandMapper('climate')('self-destruct')).toBeNull();
    expect(makeCommandMapper('vacuum')('set-temperature', { value: 1 })).toBeNull();
    // Missing required params → null, never a malformed service call
    expect(makeCommandMapper('climate')('set-temperature')).toBeNull();
    expect(makeCommandMapper('climate')('set-temperature', {})).toBeNull();
    expect(makeCommandMapper('light')('set-brightness', {})).toBeNull();
  });

  it('domainOf splits the entity id prefix', () => {
    expect(domainOf('light.living_room')).toBe('light');
    expect(domainOf('binary_sensor.front_door')).toBe('binary_sensor');
  });
});

describe('suggestedCapabilitiesFor — platform-vocabulary capabilities (Fix-18, R7 F-02)', () => {
  it('control domains add the verb capabilities the command derivation recognizes', () => {
    // Semantic capabilities stay; the control verbs join them.
    expect(suggestedCapabilitiesFor('light.living_room')).toEqual([
      'lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness',
    ]);
    expect(suggestedCapabilitiesFor('climate.living_room_ac')).toEqual([
      'temperature-control', 'cooling', 'heating', 'temperature-monitoring',
      'turn-on', 'turn-off', 'set-temperature', 'set-mode',
    ]);
    expect(suggestedCapabilitiesFor('switch.air_purifier')).toEqual([
      'power-control', 'turn-on', 'turn-off',
    ]);
    expect(suggestedCapabilitiesFor('cover.living_room_curtain')).toEqual([
      'curtain-control', 'turn-on', 'turn-off', 'set-curtain',
    ]);
    expect(suggestedCapabilitiesFor('humidifier.bedroom')).toEqual([
      'humidity-control', 'turn-on', 'turn-off', 'set-humidity',
    ]);
    expect(suggestedCapabilitiesFor('fan.bedroom_fan')).toEqual([
      'ventilation', 'turn-on', 'turn-off', 'set-fan-speed',
    ]);
  });

  it('monitoring-only entities suggest no control verbs', () => {
    expect(suggestedCapabilitiesFor('sensor.room_temp', { device_class: 'temperature' }))
      .toEqual(['temperature-monitoring']);
    expect(suggestedCapabilitiesFor('vacuum.robbie')).toEqual(['vacuum-monitoring']);
  });

  it('every suggested control verb maps to an HA service call (no dead suggestions)', () => {
    for (const entityId of ['light.living_room', 'climate.living_room_ac', 'cover.living_room_curtain']) {
      const mapper = makeCommandMapper(domainOf(entityId));
      const suggested = suggestedCapabilitiesFor(entityId);
      // The semantic class names (…-control/…-monitoring) are NOT commands;
      // every verb in the suggestion must reach HA.
      for (const capability of suggested) {
        if (!/^(turn|set|toggle)/.test(capability)) continue;
        expect(mapper(capability, { brightness: 50, targetTemperature: 22, mode: 'cooling', position: 40 }),
          `${entityId}: ${capability}`).not.toBeNull();
      }
    }
  });
});
