/**
 * Zone-Type Device Deployment Generator
 *
 * Sprint P27 — Generates devices for scenarios based on zone type kits.
 * Each zone type (patient-room, office, warehouse, etc.) has a standard
 * set of devices that are automatically deployed at calculated positions
 * within the zone bounds.
 *
 * Usage:
 *   import { generateDevicesForScenario, assignDevicesToAgents } from './zone-device-generator.js';
 *
 *   const devices = generateDevicesForScenario(zones, ZONE_TYPE_MAPS['hospital'], 'hospital');
 *   assignDevicesToAgents(agents, devices);
 */

import type { ZoneDef, DeviceDef, AgentDef, Position3D } from './types.js';

// ---------------------------------------------------------------------------
// Device kit types
// ---------------------------------------------------------------------------

type PlacementStrategy = 'center' | 'corners' | 'walls' | 'distributed';

interface DeviceKitEntry {
  /** Short prefix for device IDs (e.g., "temp", "hvac"). */
  idPrefix: string;
  /** Name pattern; {zone} replaced with zone name, {i} with index. */
  namePattern: string;
  /** Device classification. */
  type: 'sensor' | 'actuator' | 'hybrid';
  /** Device sub-type (e.g., 'temperature', 'hvac'). */
  subType: string;
  /** Capabilities this device provides. */
  capabilities: string[];
  /** How to place this device within the zone. */
  placement: PlacementStrategy;
  /** Default height above floor (meters). */
  height: number;
}

interface ZoneTypeDeviceKit {
  devices: DeviceKitEntry[];
}

// ---------------------------------------------------------------------------
// Zone type device kits (25 types)
// ---------------------------------------------------------------------------

const ZONE_TYPE_KITS: Record<string, ZoneTypeDeviceKit> = {
  // --- Residential ---
  'living-room': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling', 'heating'], placement: 'center', height: 0 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'walls', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'distributed', height: 1.2 },
      { idPrefix: 'purifier', namePattern: '{zone} Air Purifier', type: 'actuator', subType: 'air-purifier', capabilities: ['set-mode', 'set-fan-speed', 'turn-on', 'turn-off'], placement: 'center', height: 0 },
      { idPrefix: 'humidifier', namePattern: '{zone} Humidifier', type: 'actuator', subType: 'humidifier', capabilities: ['set-target-humidity', 'set-mode', 'turn-on', 'turn-off'], placement: 'walls', height: 0.3 },
      { idPrefix: 'speaker', namePattern: '{zone} Speaker', type: 'actuator', subType: 'speaker', capabilities: ['set-volume', 'play-alert', 'stop', 'turn-on', 'turn-off'], placement: 'walls', height: 2 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection', 'occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'plug', namePattern: '{zone} Smart Plug', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.3 },
    ],
  },
  'bedroom': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'humidifier', namePattern: '{zone} Humidifier', type: 'actuator', subType: 'humidifier', capabilities: ['set-target-humidity', 'set-mode', 'turn-on', 'turn-off'], placement: 'walls', height: 0.3 },
      { idPrefix: 'dehumidifier', namePattern: '{zone} Dehumidifier', type: 'actuator', subType: 'dehumidifier', capabilities: ['set-target-humidity', 'set-mode', 'turn-on', 'turn-off'], placement: 'walls', height: 0.3 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection'], placement: 'corners', height: 2.5 },
      { idPrefix: 'plug', namePattern: '{zone} Smart Plug', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.3 },
    ],
  },
  'bathroom': {
    devices: [
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection'], placement: 'corners', height: 2.5 },
      { idPrefix: 'leak', namePattern: '{zone} Water Leak', type: 'sensor', subType: 'water-leak', capabilities: ['water-leak-detection'], placement: 'walls', height: 0 },
      { idPrefix: 'exhaust', namePattern: '{zone} Exhaust Fan', type: 'actuator', subType: 'exhaust-fan', capabilities: ['set-speed', 'turn-on', 'turn-off'], placement: 'walls', height: 2.5 },
      { idPrefix: 'dehumidifier', namePattern: '{zone} Dehumidifier', type: 'actuator', subType: 'dehumidifier', capabilities: ['set-target-humidity', 'set-mode', 'turn-on', 'turn-off'], placement: 'walls', height: 0.3 },
      { idPrefix: 'valve', namePattern: '{zone} Water Valve', type: 'actuator', subType: 'water-valve', capabilities: ['water-shutoff', 'turn-on', 'turn-off'], placement: 'walls', height: 0 },
    ],
  },
  'kitchen': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'co', namePattern: '{zone} CO Detector', type: 'sensor', subType: 'gas', capabilities: ['gas-detection', 'co-detection'], placement: 'walls', height: 1.5 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection', 'fire-detection'], placement: 'walls', height: 2.5 },
      { idPrefix: 'sprinkler', namePattern: '{zone} Sprinkler', type: 'actuator', subType: 'sprinkler', capabilities: ['fire-suppression', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'plug', namePattern: '{zone} Smart Plug', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.3 },
    ],
  },
  'home-office': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'walls', height: 0 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'distributed', height: 1.2 },
    ],
  },
  'entrance-hall': {
    devices: [
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection', 'occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'speaker', namePattern: '{zone} Speaker', type: 'actuator', subType: 'speaker', capabilities: ['set-volume', 'play-alert', 'stop', 'turn-on', 'turn-off'], placement: 'walls', height: 2 },
      { idPrefix: 'lock', namePattern: '{zone} Smart Lock', type: 'actuator', subType: 'lock', capabilities: ['access-control'], placement: 'walls', height: 1 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling', 'heating'], placement: 'center', height: 0 },
    ],
  },
  'garage': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling', 'heating'], placement: 'center', height: 0 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection'], placement: 'corners', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 1 },
      { idPrefix: 'plug', namePattern: '{zone} Smart Plug', type: 'actuator', subType: 'smart-plug', capabilities: ['energy-monitoring', 'energy-control', 'turn-on', 'turn-off'], placement: 'walls', height: 0.3 },
      { idPrefix: 'sprinkler', namePattern: '{zone} Sprinkler', type: 'actuator', subType: 'sprinkler', capabilities: ['fire-suppression', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
    ],
  },
  // --- Medical ---
  'patient-room': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'call', namePattern: '{zone} Call Button', type: 'sensor', subType: 'call-button', capabilities: ['nurse-call'], placement: 'walls', height: 0.8 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'walls', height: 1.2 },
    ],
  },
  'icu-ward': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'oxygen', namePattern: '{zone} Oxygen Monitor', type: 'sensor', subType: 'oxygen', capabilities: ['oxygen-monitoring'], placement: 'walls', height: 1.5 },
      { idPrefix: 'pressure', namePattern: '{zone} Pressure Sensor', type: 'sensor', subType: 'pressure', capabilities: ['pressure-monitoring'], placement: 'walls', height: 1 },
      { idPrefix: 'monitor', namePattern: '{zone} Patient Monitor', type: 'sensor', subType: 'monitor', capabilities: ['critical-care-monitoring', 'patient-monitoring'], placement: 'distributed', height: 1 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
    ],
  },
  'operating-room': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'filter', namePattern: '{zone} Air Filter', type: 'actuator', subType: 'air-purifier', capabilities: ['set-mode', 'set-fan-speed', 'turn-on', 'turn-off'], placement: 'walls', height: 2 },
      { idPrefix: 'light', namePattern: '{zone} Surgical Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'pressure', namePattern: '{zone} Pressure Sensor', type: 'sensor', subType: 'pressure', capabilities: ['pressure-monitoring'], placement: 'walls', height: 1 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection'], placement: 'walls', height: 2.5 },
    ],
  },
  'corridor': {
    devices: [
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'distributed', height: 2.5 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection', 'occupancy-counting'], placement: 'distributed', height: 2.5 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection'], placement: 'walls', height: 2.5 },
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
    ],
  },
  'nurse-station': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'panel', namePattern: '{zone} Call Panel', type: 'sensor', subType: 'call-panel', capabilities: ['nurse-call', 'alert-monitoring'], placement: 'walls', height: 1.2 },
    ],
  },
  'pharmacy': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'lock', namePattern: '{zone} Smart Lock', type: 'actuator', subType: 'lock', capabilities: ['access-control', 'security-monitoring'], placement: 'walls', height: 1 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
    ],
  },
  'lab-medical': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'fume', namePattern: '{zone} Fume Hood', type: 'actuator', subType: 'exhaust-fan', capabilities: ['set-speed', 'turn-on', 'turn-off'], placement: 'walls', height: 1.5 },
    ],
  },
  'reception': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'walls', height: 1.2 },
    ],
  },
  'waiting-area': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'walls', height: 1.2 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
    ],
  },
  // --- Commercial / Campus ---
  'office': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection', 'occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'walls', height: 1.2 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'distributed', height: 2.5 },
    ],
  },
  'server-room': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection'], placement: 'walls', height: 2.5 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'ups', namePattern: '{zone} UPS Monitor', type: 'sensor', subType: 'energy', capabilities: ['power-monitoring', 'ups-monitoring'], placement: 'walls', height: 0.5 },
      { idPrefix: 'sprinkler', namePattern: '{zone} Fire Suppression', type: 'actuator', subType: 'sprinkler', capabilities: ['fire-suppression', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
    ],
  },
  'cafeteria': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection'], placement: 'walls', height: 2.5 },
      { idPrefix: 'co2', namePattern: '{zone} CO2 Sensor', type: 'sensor', subType: 'co2', capabilities: ['co2-reading', 'air-quality-monitoring'], placement: 'walls', height: 1.2 },
    ],
  },
  // --- Industrial ---
  'production-line': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'distributed', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'vibration', namePattern: '{zone} Vibration Sensor', type: 'sensor', subType: 'vibration', capabilities: ['vibration-monitoring', 'predictive-maintenance'], placement: 'distributed', height: 0 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring', 'power-monitoring'], placement: 'walls', height: 0.5 },
      { idPrefix: 'noise', namePattern: '{zone} Noise Sensor', type: 'sensor', subType: 'noise', capabilities: ['noise-monitoring'], placement: 'corners', height: 2 },
      { idPrefix: 'robot', namePattern: '{zone} Robot Controller', type: 'actuator', subType: 'robot', capabilities: ['robot-control', 'automation'], placement: 'center', height: 0.5 },
    ],
  },
  'warehouse': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'humidity', namePattern: '{zone} Humidity', type: 'sensor', subType: 'humidity', capabilities: ['humidity-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection'], placement: 'corners', height: 2.5 },
      { idPrefix: 'rfid', namePattern: '{zone} RFID Reader', type: 'sensor', subType: 'rfid', capabilities: ['inventory-tracking'], placement: 'walls', height: 1 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.5 },
    ],
  },
  'control-room': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 2.5 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.5 },
    ],
  },
  'utility-room': {
    devices: [
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring', 'power-monitoring'], placement: 'walls', height: 0.5 },
      { idPrefix: 'leak', namePattern: '{zone} Water Leak', type: 'sensor', subType: 'water-leak', capabilities: ['water-leak-detection'], placement: 'walls', height: 0 },
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'valve', namePattern: '{zone} Water Valve', type: 'actuator', subType: 'water-valve', capabilities: ['water-shutoff', 'turn-on', 'turn-off'], placement: 'walls', height: 0 },
    ],
  },
  'parking': {
    devices: [
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'distributed', height: 3 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting', 'slot-detection'], placement: 'distributed', height: 2.5 },
      { idPrefix: 'ev', namePattern: '{zone} EV Charger', type: 'actuator', subType: 'ev-charger', capabilities: ['ev-charging', 'energy-monitoring'], placement: 'walls', height: 0.5 },
    ],
  },
  // --- Outdoor / City ---
  'park': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'soil', namePattern: '{zone} Soil Moisture', type: 'sensor', subType: 'moisture', capabilities: ['moisture-reading'], placement: 'distributed', height: 0 },
      { idPrefix: 'sprinkler', namePattern: '{zone} Sprinkler', type: 'actuator', subType: 'irrigation', capabilities: ['irrigation-control'], placement: 'distributed', height: 0 },
      { idPrefix: 'airq', namePattern: '{zone} Air Quality', type: 'sensor', subType: 'air-quality', capabilities: ['air-quality-monitoring', 'pm25-reading'], placement: 'center', height: 2 },
    ],
  },
  'city-block': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'motion', namePattern: '{zone} Motion Sensor', type: 'sensor', subType: 'motion', capabilities: ['motion-detection', 'occupancy-counting'], placement: 'corners', height: 2.5 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.5 },
      { idPrefix: 'airq', namePattern: '{zone} Air Quality', type: 'sensor', subType: 'air-quality', capabilities: ['air-quality-monitoring', 'pm25-reading'], placement: 'center', height: 2 },
    ],
  },
  'transport-hub': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'cctv', namePattern: '{zone} CCTV', type: 'sensor', subType: 'camera', capabilities: ['video-surveillance'], placement: 'corners', height: 3 },
      { idPrefix: 'occupancy', namePattern: '{zone} Occupancy', type: 'sensor', subType: 'occupancy', capabilities: ['occupancy-counting'], placement: 'distributed', height: 2.5 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'center', height: 3 },
    ],
  },
  'emergency-services': {
    devices: [
      { idPrefix: 'alert', namePattern: '{zone} Alert System', type: 'actuator', subType: 'alert', capabilities: ['emergency-alert', 'dispatch'], placement: 'center', height: 1.5 },
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'smoke', namePattern: '{zone} Smoke Detector', type: 'sensor', subType: 'smoke', capabilities: ['smoke-detection', 'fire-detection'], placement: 'walls', height: 2.5 },
    ],
  },
  'outdoor': {
    devices: [
      { idPrefix: 'temp', namePattern: '{zone} Temperature', type: 'sensor', subType: 'temperature', capabilities: ['temperature-reading'], placement: 'center', height: 1.5 },
      { idPrefix: 'airq', namePattern: '{zone} Air Quality', type: 'sensor', subType: 'air-quality', capabilities: ['air-quality-monitoring'], placement: 'center', height: 2 },
      { idPrefix: 'noise', namePattern: '{zone} Noise Sensor', type: 'sensor', subType: 'noise', capabilities: ['noise-monitoring'], placement: 'center', height: 2 },
      { idPrefix: 'light', namePattern: '{zone} Light', type: 'actuator', subType: 'light', capabilities: ['set-brightness', 'set-color', 'turn-on', 'turn-off'], placement: 'corners', height: 4 },
      { idPrefix: 'hvac', namePattern: '{zone} HVAC', type: 'actuator', subType: 'hvac', capabilities: ['set-temperature', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off', 'heating', 'cooling'], placement: 'center', height: 0 },
      { idPrefix: 'energy', namePattern: '{zone} Energy Meter', type: 'sensor', subType: 'energy', capabilities: ['energy-monitoring'], placement: 'walls', height: 0.5 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Zone type maps for each scenario
// ---------------------------------------------------------------------------

export const ZONE_TYPE_MAPS: Record<string, Record<string, string>> = {
  'single-room': {
    'room-1': 'living-room',
  },
  'apartment': {
    'living-room': 'living-room',
    'bedroom': 'bedroom',
    'kitchen': 'kitchen',
    'bathroom': 'bathroom',
    'server-room': 'server-room',
    'entrance-hall': 'entrance-hall',
    'home-office': 'home-office',
    'garage': 'garage',
    'balcony': 'outdoor',
    'corridor': 'corridor',
  },
  'campus': {
    'office-building-1': 'office',
    'office-building-2': 'office',
    'office-building-3': 'office',
    'gym': 'outdoor',
    'production-building': 'production-line',
    'server-facility': 'server-room',
    'hospital-wing': 'patient-room',
    'warehouse': 'warehouse',
    'parking-lot': 'parking',
    'sports-field': 'outdoor',
    'garden': 'park',
    'lecture-hall': 'office',
    'library': 'office',
    'dormitory': 'office',
    'cafeteria': 'cafeteria',
    'corridor': 'corridor',
  },
  'factory': {
    'production-line-1': 'production-line',
    'production-line-2': 'production-line',
    'production-line-3': 'production-line',
    'warehouse-1': 'warehouse',
    'warehouse-2': 'warehouse',
    'quality-lab': 'lab-medical',
    'server-room': 'server-room',
    'assembly-area': 'production-line',
    'painting-booth': 'production-line',
    'welding-bay': 'production-line',
    'chemical-storage': 'utility-room',
    'loading-dock': 'warehouse',
    'break-room': 'reception',
    'control-room': 'control-room',
    'ev-charging': 'parking',
  },
  'hospital': {
    'patient-room-1': 'patient-room',
    'patient-room-2': 'patient-room',
    'patient-room-3': 'patient-room',
    'patient-room-4': 'patient-room',
    'corridor-1': 'corridor',
    'icu-1': 'icu-ward',
    'icu-2': 'icu-ward',
    'operating-room-1': 'operating-room',
    'operating-room-2': 'operating-room',
    'nurse-station': 'nurse-station',
    'pharmacy': 'pharmacy',
    'laboratory': 'lab-medical',
    'radiology': 'lab-medical',
    'emergency-dept': 'reception',
    'reception': 'reception',
    'waiting-area': 'waiting-area',
    'cafeteria': 'cafeteria',
    'server-room': 'server-room',
    'utility-room': 'utility-room',
    'parking': 'parking',
  },
  'smart-city': {
    'residential-a': 'city-block',
    'residential-b': 'city-block',
    'residential-c': 'city-block',
    'park': 'park',
    'shopping-mall': 'reception',
    'office-tower-a': 'office',
    'office-tower-b': 'office',
    'bank': 'reception',
    'factory-zone': 'production-line',
    'warehouse-district': 'warehouse',
    'logistics-hub': 'warehouse',
    'hospital-district': 'patient-room',
    'emergency-center': 'emergency-services',
    'city-hall': 'office',
    'fire-station': 'emergency-services',
    'police-station': 'office',
    'power-plant': 'control-room',
    'water-treatment': 'utility-room',
    'data-center': 'server-room',
    'main-station': 'transport-hub',
    'bus-depot': 'transport-hub',
    'parking-garage': 'parking',
    'highway-junction': 'outdoor',
    'airport-terminal': 'transport-hub',
  },
};

// ---------------------------------------------------------------------------
// Zone abbreviation helper
// ---------------------------------------------------------------------------

function getZoneAbbreviation(zoneId: string): string {
  // Common abbreviations for readability
  const known: Record<string, string> = {
    'room-1': 'sr',
    'living-room': 'living',
    'bedroom': 'bed',
    'kitchen': 'kitchen',
    'bathroom': 'bath',
    'server-room': 'sr',
    'entrance-hall': 'entrance',
    'home-office': 'ho',
    'garage': 'garage',
    'balcony': 'balc',
    'corridor': 'corr',
    'corridor-1': 'corr',
    // Campus
    'office-building-1': 'ob1', 'office-building-2': 'ob2', 'office-building-3': 'ob3',
    'lab-building-1': 'lb1', 'lab-building-2': 'lb2',
    'gym': 'gym', 'production-building': 'pb', 'lobby': 'lob',
    'server-facility': 'sf', 'hospital-wing': 'hw', 'warehouse': 'wh',
    'parking-lot': 'pl', 'sports-field': 'sf2', 'garden': 'garden',
    'lecture-hall': 'lh', 'library': 'lib', 'dormitory': 'dorm', 'cafeteria': 'cafe',
    // Factory
    'production-line-1': 'pl1', 'production-line-2': 'pl2', 'production-line-3': 'pl3',
    'warehouse-1': 'wh1', 'warehouse-2': 'wh2', 'quality-lab': 'ql',
    'assembly-area': 'aa', 'painting-booth': 'pb2', 'welding-bay': 'wb',
    'chemical-storage': 'cs', 'loading-dock': 'ld', 'break-room': 'br',
    'control-room': 'cr', 'ev-charging': 'ev',
    // Hospital
    'patient-room-1': 'pr1', 'patient-room-2': 'pr2', 'patient-room-3': 'pr3', 'patient-room-4': 'pr4',
    'icu-1': 'icu1', 'icu-2': 'icu2',
    'operating-room-1': 'or1', 'operating-room-2': 'or2',
    'nurse-station': 'ns', 'pharmacy': 'rx', 'laboratory': 'lab',
    'radiology': 'rad', 'emergency-dept': 'ed',
    'reception': 'recv', 'waiting-area': 'wa',
    'utility-room': 'ut',
    // Smart-city
    'residential-a': 'ra', 'residential-b': 'rb', 'residential-c': 'rc',
    'park': 'park', 'shopping-mall': 'mall',
    'office-tower-a': 'ota', 'office-tower-b': 'otb',
    'bank': 'bank', 'factory-zone': 'fz',
    'warehouse-district': 'wd', 'logistics-hub': 'lh2',
    'hospital-district': 'hd', 'emergency-center': 'ec',
    'city-hall': 'ch', 'fire-station': 'fs',
    'police-station': 'ps', 'power-plant': 'pp',
    'water-treatment': 'wt', 'data-center': 'dc',
    'main-station': 'ms', 'bus-depot': 'bd',
    'parking-garage': 'pg', 'highway-junction': 'hj',
    'airport-terminal': 'at',
  };
  return known[zoneId] ?? zoneId.replace(/[^a-z0-9]/g, '').slice(0, 6);
}

// ---------------------------------------------------------------------------
// Position calculation
// ---------------------------------------------------------------------------

function calculatePositions(
  zone: ZoneDef,
  placement: PlacementStrategy,
  height: number,
): Position3D[] {
  const { minX, maxX, minY, maxY } = zone.bounds;
  const padX = (maxX - minX) * 0.1;
  const padY = (maxY - minY) * 0.1;
  const loX = minX + padX;
  const hiX = maxX - padX;
  const loY = minY + padY;
  const hiY = maxY - padY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  switch (placement) {
    case 'center':
      return [{ x: round2(cx), y: round2(cy), z: height }];

    case 'corners':
      return [
        { x: round2(loX), y: round2(loY), z: height },
        { x: round2(hiX), y: round2(loY), z: height },
        { x: round2(loX), y: round2(hiY), z: height },
        { x: round2(hiX), y: round2(hiY), z: height },
      ];

    case 'walls': {
      // 4 positions: midpoint of each wall
      return [
        { x: round2(cx), y: round2(loY), z: height },   // bottom wall
        { x: round2(cx), y: round2(hiY), z: height },   // top wall
        { x: round2(loX), y: round2(cy), z: height },   // left wall
        { x: round2(hiX), y: round2(cy), z: height },   // right wall
      ];
    }

    case 'distributed': {
      // 2 positions: offset from center
      const dx = (hiX - loX) * 0.25;
      const dy = (hiY - loY) * 0.25;
      return [
        { x: round2(cx - dx), y: round2(cy - dy), z: height },
        { x: round2(cx + dx), y: round2(cy + dy), z: height },
      ];
    }

    default:
      return [{ x: round2(cx), y: round2(cy), z: height }];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Core generator function
// ---------------------------------------------------------------------------

export function generateDevicesForScenario(
  zones: ZoneDef[],
  zoneTypeMap: Record<string, string>,
  scenarioId: string,
): DeviceDef[] {
  const devices: DeviceDef[] = [];

  for (const zone of zones) {
    const zoneType = zone.zoneType ?? zoneTypeMap[zone.id];
    if (!zoneType) continue;

    const kit = ZONE_TYPE_KITS[zoneType];
    if (!kit) continue;

    const zoneAbbr = getZoneAbbreviation(zone.id);

    for (const entry of kit.devices) {
      const positions = calculatePositions(zone, entry.placement, entry.height);
      // Use first position for single-device entries, all positions for multi
      const isMultiDevice = entry.placement === 'corners' || entry.placement === 'walls' || entry.placement === 'distributed';

      if (isMultiDevice) {
        for (let i = 0; i < positions.length; i++) {
          devices.push({
            id: `dev-${zoneAbbr}-${entry.idPrefix}-${i + 1}`,
            name: entry.namePattern.replace('{zone}', zone.name).replace('{i}', String(i + 1)),
            type: entry.type,
            subType: entry.subType,
            zoneId: zone.id,
            location: positions[i],
            capabilities: [...entry.capabilities],
          });
        }
      } else {
        devices.push({
          id: `dev-${zoneAbbr}-${entry.idPrefix}-1`,
          name: entry.namePattern.replace('{zone}', zone.name),
          type: entry.type,
          subType: entry.subType,
          zoneId: zone.id,
          location: positions[0],
          capabilities: [...entry.capabilities],
        });
      }
    }
  }

  return devices;
}

// ---------------------------------------------------------------------------
// Agent device assignment
// ---------------------------------------------------------------------------

export function assignDevicesToAgents(
  agents: AgentDef[],
  devices: DeviceDef[],
): void {
  for (const agent of agents) {
    const assigned: string[] = [];
    for (const device of devices) {
      if (!agent.managesZoneIds.includes(device.zoneId)) continue;

      // Check capability overlap
      const hasOverlap = device.capabilities.some(dc =>
        agent.capabilities.some(ac => capabilityMatch(ac, dc)),
      );
      if (hasOverlap) {
        assigned.push(device.id);
      }
    }
    agent.managesDeviceIds = assigned;
  }
}

function capabilityMatch(agentCap: string, deviceCap: string): boolean {
  const a = agentCap.toLowerCase();
  const d = deviceCap.toLowerCase();
  // Direct match or substring match
  return a === d || a.includes(d) || d.includes(a) || shareKeyword(a, d);
}

const KEYWORD_GROUPS: string[][] = [
  ['temperature', 'temp', 'thermal'],
  ['humidity', 'moisture'],
  ['hvac', 'cooling', 'heating', 'climate'],
  ['light', 'lighting', 'brightness'],
  ['motion', 'movement', 'presence', 'occupancy'],
  ['energy', 'power', 'electricity'],
  ['smoke', 'fire', 'suppression'],
  ['security', 'access', 'lock', 'alarm', 'alert', 'emergency'],
  ['air', 'ventilation', 'purifier', 'filtration', 'co2'],
  ['water', 'leak', 'moisture'],
  ['gas', 'detection', 'co-'],
  ['oxygen', 'medical', 'patient', 'monitoring', 'critical-care'],
  ['noise', 'sound'],
  ['vibration', 'maintenance'],
  ['camera', 'video', 'surveillance', 'cctv'],
];

function shareKeyword(a: string, d: string): boolean {
  for (const group of KEYWORD_GROUPS) {
    if (group.some(k => a.includes(k)) && group.some(k => d.includes(k))) {
      return true;
    }
  }
  return false;
}
