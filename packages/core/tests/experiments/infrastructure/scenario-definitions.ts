/**
 * Scenario Definitions for Sprint P13 Paper Experiments
 *
 * This module defines three IoT collaboration scenarios of increasing complexity
 * used to evaluate the active-collaboration framework in the paper experiments:
 *
 * 1. single-room   - A single room with one agent that can handle all events independently.
 * 2. apartment     - A multi-room apartment where agents must collaborate across zones.
 * 3. campus        - A large campus with many buildings, agents, and cross-zone collaboration.
 *
 * Each scenario includes complete ground truth for test events so that experiment
 * results can be evaluated automatically.
 */

import type { ScenarioDefinition, ScenarioType, ZoneDef, AgentDef } from './types.js';
import { generateDevicesForScenario, assignDevicesToAgents, ZONE_TYPE_MAPS } from './zone-device-generator.js';

// ---------------------------------------------------------------------------
// Scenario 1: single-room 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const singleRoomZones: ZoneDef[] = [
  {
    id: 'room-1',
    name: 'Room 1',
    dimensions: { widthM: 10, heightM: 10 },
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    adjacentZoneIds: [],
    zoneType: 'living-room',
  },
];

const singleRoomAgents: AgentDef[] = [
  {
    id: 'climate-agent',
    name: 'Climate Agent',
    owner: 'user-a',
    capabilities: [
      'temperature-monitoring',
      'cooling',
      'lighting-control',
      'motion-detection',
    ],
    managesZoneIds: ['room-1'],
    managesDeviceIds: [],
  },
  {
    id: 'safety-agent',
    name: 'Safety Agent',
    owner: 'user-b',
    capabilities: [
      'smoke-detection',
      'fire-suppression',
      'emergency-alert',
    ],
    managesZoneIds: ['room-1'],
    managesDeviceIds: [],
  },
  {
    id: 'air-quality-agent',
    name: 'Air Quality Agent',
    owner: 'user-c',
    capabilities: [
      'air-quality-monitoring',
      'co2-monitoring',
      'air-purification',
      'ventilation-control',
      'humidity-monitoring',
    ],
    managesZoneIds: ['room-1'],
    managesDeviceIds: [],
  },
];

const singleRoomDevices = generateDevicesForScenario(singleRoomZones, ZONE_TYPE_MAPS['single-room'], 'single-room');
assignDevicesToAgents(singleRoomAgents, singleRoomDevices);

// ---------------------------------------------------------------------------
// Scenario 2: apartment 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const apartmentZones: ZoneDef[] = [
  {
    id: 'living-room',
    name: 'Living Room',
    dimensions: { widthM: 6, heightM: 5 },
    bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
    adjacentZoneIds: ['bedroom', 'kitchen', 'balcony'],
    zoneType: 'living-room',
  },
  {
    id: 'bedroom',
    name: 'Bedroom',
    dimensions: { widthM: 6, heightM: 5 },
    bounds: { minX: 6, maxX: 12, minY: 0, maxY: 5 },
    adjacentZoneIds: ['living-room', 'bathroom'],
    zoneType: 'bedroom',
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    dimensions: { widthM: 6, heightM: 5 },
    bounds: { minX: 0, maxX: 6, minY: 5, maxY: 10 },
    adjacentZoneIds: ['living-room', 'server-room', 'entrance-hall'],
    zoneType: 'kitchen',
  },
  {
    id: 'bathroom',
    name: 'Bathroom',
    dimensions: { widthM: 6, heightM: 5 },
    bounds: { minX: 6, maxX: 12, minY: 5, maxY: 10 },
    adjacentZoneIds: ['bedroom', 'home-office'],
    zoneType: 'bathroom',
  },
  {
    id: 'server-room',
    name: 'Server Room',
    dimensions: { widthM: 6, heightM: 5 },
    bounds: { minX: 12, maxX: 18, minY: 5, maxY: 10 },
    adjacentZoneIds: ['kitchen'],
    zoneType: 'server-room',
  },
  {
    id: 'entrance-hall',
    name: 'Entrance Hall',
    dimensions: { widthM: 4, heightM: 3 },
    bounds: { minX: 0, maxX: 4, minY: 10, maxY: 13 },
    adjacentZoneIds: ['kitchen', 'home-office'],
    zoneType: 'entrance-hall',
  },
  {
    id: 'home-office',
    name: 'Home Office',
    dimensions: { widthM: 5, heightM: 5 },
    bounds: { minX: 12, maxX: 17, minY: 0, maxY: 5 },
    adjacentZoneIds: ['bedroom', 'bathroom'],
    zoneType: 'home-office',
  },
  {
    id: 'balcony',
    name: 'Balcony',
    dimensions: { widthM: 6, heightM: 2 },
    bounds: { minX: 0, maxX: 6, minY: -2, maxY: 0 },
    adjacentZoneIds: ['living-room'],
    zoneType: 'outdoor',
  },
  {
    id: 'utility-room',
    name: 'Utility Room',
    dimensions: { widthM: 3, heightM: 3 },
    bounds: { minX: 4, maxX: 7, minY: 10, maxY: 13 },
    adjacentZoneIds: ['entrance-hall', 'kitchen'],
    zoneType: 'utility-room',
  },
  {
    id: 'garage',
    name: 'Garage',
    dimensions: { widthM: 6, heightM: 6 },
    bounds: { minX: 7, maxX: 13, minY: 10, maxY: 16 },
    adjacentZoneIds: ['entrance-hall'],
    zoneType: 'garage',
  },
];

const apartmentAgents: AgentDef[] = [
  {
    id: 'env-monitor',
    owner: 'user-a',
    capabilities: ['temperature-monitoring', 'humidity-monitoring', 'air-quality-monitoring', 'light-level-monitoring'],
    managesZoneIds: ['living-room', 'bedroom', 'kitchen', 'home-office', 'bathroom', 'entrance-hall'],
    managesDeviceIds: [],
  },
  {
    id: 'climate-controller',
    owner: 'user-b',
    capabilities: [
      'cooling',
      'heating',
      'humidity-control',
      'air-purification',
    ],
    managesZoneIds: ['living-room', 'kitchen', 'server-room', 'bedroom', 'bathroom', 'home-office', 'garage', 'balcony'],
    managesDeviceIds: [],
  },
  {
    id: 'security-monitor',
    owner: 'user-c',
    capabilities: ['motion-detection', 'presence-detection', 'lighting-control', 'access-control', 'emergency-alert'],
    managesZoneIds: ['bathroom', 'server-room', 'entrance-hall', 'garage', 'living-room', 'bedroom'],
    managesDeviceIds: [],
  },
  {
    id: 'safety-agent',
    owner: 'user-d',
    capabilities: ['gas-detection', 'water-leak-detection', 'fire-detection', 'emergency-alert', 'air-purification'],
    managesZoneIds: ['kitchen', 'bathroom', 'utility-room', 'living-room'],
    managesDeviceIds: [],
  },
  {
    id: 'energy-agent',
    owner: 'user-e',
    capabilities: ['energy-monitoring', 'cost-optimization', 'load-balancing'],
    managesZoneIds: ['garage', 'utility-room', 'balcony'],
    managesDeviceIds: [],
  },
  {
    id: 'maintenance-agent',
    owner: 'user-f',
    capabilities: ['water-shutoff', 'equipment-monitoring', 'maintenance-scheduling'],
    managesZoneIds: ['utility-room', 'garage', 'balcony'],
    managesDeviceIds: [],
  },
];

const apartmentDevices = generateDevicesForScenario(apartmentZones, ZONE_TYPE_MAPS['apartment'], 'apartment');
assignDevicesToAgents(apartmentAgents, apartmentDevices);

// ---------------------------------------------------------------------------
// Scenario 3: campus 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const campusZones: ZoneDef[] = [
  {
    id: 'office-building-1',
    name: 'Office Building 1',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 0, maxX: 20, minY: 0, maxY: 15 },
    adjacentZoneIds: ['office-building-2', 'cafeteria'],
    zoneType: 'office',
  },
  {
    id: 'office-building-2',
    name: 'Office Building 2',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 20, maxX: 40, minY: 0, maxY: 15 },
    adjacentZoneIds: ['office-building-1', 'lab-building-1'],
    zoneType: 'office',
  },
  {
    id: 'office-building-3',
    name: 'Office Building 3',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 40, maxX: 60, minY: 0, maxY: 15 },
    adjacentZoneIds: ['lab-building-1', 'warehouse'],
    zoneType: 'office',
  },
  {
    id: 'lab-building-1',
    name: 'Lab Building 1',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 0, maxX: 20, minY: 15, maxY: 30 },
    adjacentZoneIds: ['office-building-1', 'office-building-2', 'lab-building-2'],
    zoneType: 'office',
  },
  {
    id: 'lab-building-2',
    name: 'Lab Building 2',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 20, maxX: 40, minY: 15, maxY: 30 },
    adjacentZoneIds: ['lab-building-1', 'office-building-3'],
    zoneType: 'office',
  },
  {
    id: 'server-facility',
    name: 'Server Facility',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 40, maxX: 60, minY: 15, maxY: 30 },
    adjacentZoneIds: ['lab-building-2', 'warehouse'],
    zoneType: 'server-room',
  },
  {
    id: 'warehouse',
    name: 'Warehouse',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 0, maxX: 20, minY: 30, maxY: 45 },
    adjacentZoneIds: ['lab-building-1', 'cafeteria'],
    zoneType: 'warehouse',
  },
  {
    id: 'cafeteria',
    name: 'Cafeteria',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 20, maxX: 40, minY: 30, maxY: 45 },
    adjacentZoneIds: ['office-building-2', 'warehouse', 'lobby'],
    zoneType: 'cafeteria',
  },
  {
    id: 'lobby',
    name: 'Lobby',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 40, maxX: 60, minY: 30, maxY: 45 },
    adjacentZoneIds: ['cafeteria', 'office-building-3', 'server-facility'],
    zoneType: 'reception',
  },
  {
    id: 'parking-lot',
    name: 'Parking Lot',
    dimensions: { widthM: 30, heightM: 20 },
    bounds: { minX: -30, maxX: 0, minY: 0, maxY: 20 },
    adjacentZoneIds: ['office-building-1', 'lecture-hall'],
    zoneType: 'parking',
  },
  {
    id: 'sports-field',
    name: 'Sports Field',
    dimensions: { widthM: 30, heightM: 25 },
    bounds: { minX: 60, maxX: 90, minY: 0, maxY: 25 },
    adjacentZoneIds: ['office-building-3', 'gym'],
    zoneType: 'outdoor',
  },
  {
    id: 'garden',
    name: 'Garden',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: -20, maxX: 0, minY: 30, maxY: 45 },
    adjacentZoneIds: ['warehouse', 'parking-lot'],
    zoneType: 'park',
  },
  {
    id: 'lecture-hall',
    name: 'Lecture Hall',
    dimensions: { widthM: 25, heightM: 20 },
    bounds: { minX: -30, maxX: -5, minY: 20, maxY: 40 },
    adjacentZoneIds: ['parking-lot', 'lab-building-1', 'library'],
    zoneType: 'office',
  },
  {
    id: 'gym',
    name: 'Gymnasium',
    dimensions: { widthM: 20, heightM: 20 },
    bounds: { minX: 60, maxX: 80, minY: 25, maxY: 45 },
    adjacentZoneIds: ['sports-field', 'server-facility'],
    zoneType: 'outdoor',
  },
  {
    id: 'library',
    name: 'Library',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: -5, maxX: 15, minY: 45, maxY: 60 },
    adjacentZoneIds: ['lecture-hall', 'cafeteria', 'dormitory'],
    zoneType: 'office',
  },
  {
    id: 'dormitory',
    name: 'Dormitory',
    dimensions: { widthM: 25, heightM: 15 },
    bounds: { minX: 15, maxX: 40, minY: 45, maxY: 60 },
    adjacentZoneIds: ['library', 'cafeteria'],
    zoneType: 'office',
  },
];

const campusAgents: AgentDef[] = [
  {
    id: 'office-manager',
    owner: 'user-a',
    capabilities: [
      'temperature-monitoring',
      'cooling',
      'heating',
      'lighting-control',
    ],
    managesZoneIds: ['office-building-1', 'office-building-2', 'office-building-3'],
    managesDeviceIds: [],
  },
  {
    id: 'lab-monitor',
    owner: 'user-b',
    capabilities: [
      'temperature-monitoring',
      'humidity-monitoring',
      'cooling',
      'heating',
    ],
    managesZoneIds: ['lab-building-1', 'lab-building-2'],
    managesDeviceIds: [],
  },
  {
    id: 'server-manager',
    owner: 'user-c',
    capabilities: [
      'temperature-monitoring',
      'cooling',
      'heating',
      'humidity-monitoring',
    ],
    managesZoneIds: ['server-facility'],
    managesDeviceIds: [],
  },
  {
    id: 'facility-monitor',
    owner: 'user-d',
    capabilities: [
      'temperature-monitoring',
      'humidity-monitoring',
      'motion-detection',
      'presence-detection',
    ],
    managesZoneIds: ['warehouse', 'cafeteria'],
    managesDeviceIds: [],
  },
  {
    id: 'security-agent',
    owner: 'user-e',
    capabilities: [
      'motion-detection',
      'presence-detection',
      'lighting-control',
    ],
    managesZoneIds: ['lobby', 'office-building-3'],
    managesDeviceIds: [],
  },
  {
    id: 'climate-coordinator',
    owner: 'user-f',
    capabilities: [
      'temperature-monitoring',
      'humidity-monitoring',
      'cooling',
      'heating',
      'humidity-control',
      'lighting-control',
    ],
    managesZoneIds: ['cafeteria', 'lobby'],
    managesDeviceIds: [],
  },
  {
    id: 'energy-agent',
    name: 'Energy Agent',
    owner: 'user-g',
    capabilities: [
      'energy-monitoring',
      'energy-generation',
      'load-balancing',
      'cost-optimization',
      'ev-charging',
    ],
    managesZoneIds: ['parking-lot', 'gym', 'dormitory'],
    managesDeviceIds: [],
  },
  {
    id: 'occupancy-agent',
    name: 'Occupancy Agent',
    owner: 'user-h',
    capabilities: [
      'occupancy-detection',
      'presence-detection',
      'co2-monitoring',
      'air-quality-monitoring',
      'ventilation-control',
    ],
    managesZoneIds: ['lecture-hall', 'gym', 'library'],
    managesDeviceIds: [],
  },
  {
    id: 'safety-agent',
    name: 'Safety Agent',
    owner: 'user-i',
    capabilities: [
      'smoke-detection',
      'fire-detection',
      'emergency-alert',
      'access-control',
      'lock-control',
    ],
    managesZoneIds: ['dormitory', 'parking-lot'],
    managesDeviceIds: [],
  },
  {
    id: 'maintenance-agent',
    name: 'Maintenance Agent',
    owner: 'user-j',
    capabilities: [
      'irrigation-control',
      'soil-moisture-monitoring',
      'equipment-monitoring',
      'maintenance-scheduling',
    ],
    managesZoneIds: ['garden', 'sports-field', 'library'],
    managesDeviceIds: [],
  },
];

const campusDevices = generateDevicesForScenario(campusZones, ZONE_TYPE_MAPS['campus'], 'campus');
assignDevicesToAgents(campusAgents, campusDevices);

// ---------------------------------------------------------------------------
// Scenario 4: factory 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const factoryZones: ZoneDef[] = [
  {
    id: 'production-line-1',
    name: 'Production Line 1',
    dimensions: { widthM: 30, heightM: 20 },
    bounds: { minX: 0, maxX: 30, minY: 0, maxY: 20 },
    adjacentZoneIds: ['production-line-2', 'assembly-area', 'warehouse-1'],
    zoneType: 'production-line',
  },
  {
    id: 'production-line-2',
    name: 'Production Line 2',
    dimensions: { widthM: 30, heightM: 20 },
    bounds: { minX: 30, maxX: 60, minY: 0, maxY: 20 },
    adjacentZoneIds: ['production-line-1', 'production-line-3', 'quality-lab'],
    zoneType: 'production-line',
  },
  {
    id: 'production-line-3',
    name: 'Production Line 3',
    dimensions: { widthM: 30, heightM: 20 },
    bounds: { minX: 60, maxX: 90, minY: 0, maxY: 20 },
    adjacentZoneIds: ['production-line-2', 'painting-booth'],
    zoneType: 'production-line',
  },
  {
    id: 'warehouse-1',
    name: 'Raw Material Warehouse',
    dimensions: { widthM: 25, heightM: 20 },
    bounds: { minX: 0, maxX: 25, minY: 20, maxY: 40 },
    adjacentZoneIds: ['production-line-1', 'loading-dock', 'chemical-storage'],
    zoneType: 'warehouse',
  },
  {
    id: 'warehouse-2',
    name: 'Finished Goods Warehouse',
    dimensions: { widthM: 25, heightM: 20 },
    bounds: { minX: 65, maxX: 90, minY: 20, maxY: 40 },
    adjacentZoneIds: ['painting-booth', 'loading-dock', 'break-room'],
    zoneType: 'warehouse',
  },
  {
    id: 'quality-lab',
    name: 'Quality Control Lab',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 25, maxX: 45, minY: 20, maxY: 35 },
    adjacentZoneIds: ['production-line-2', 'assembly-area', 'server-room'],
    zoneType: 'lab-medical',
  },
  {
    id: 'server-room',
    name: 'Factory Server Room',
    dimensions: { widthM: 15, heightM: 15 },
    bounds: { minX: 45, maxX: 60, minY: 20, maxY: 35 },
    adjacentZoneIds: ['quality-lab', 'control-room', 'assembly-area'],
    zoneType: 'server-room',
  },
  {
    id: 'assembly-area',
    name: 'Assembly Area',
    dimensions: { widthM: 25, heightM: 20 },
    bounds: { minX: 0, maxX: 25, minY: 40, maxY: 60 },
    adjacentZoneIds: ['production-line-1', 'warehouse-1', 'welding-bay'],
    zoneType: 'production-line',
  },
  {
    id: 'painting-booth',
    name: 'Painting Booth',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 60, maxX: 80, minY: 20, maxY: 35 },
    adjacentZoneIds: ['production-line-3', 'warehouse-2'],
    zoneType: 'production-line',
  },
  {
    id: 'welding-bay',
    name: 'Welding Bay',
    dimensions: { widthM: 20, heightM: 20 },
    bounds: { minX: 25, maxX: 45, minY: 40, maxY: 60 },
    adjacentZoneIds: ['assembly-area', 'chemical-storage', 'control-room'],
    zoneType: 'production-line',
  },
  {
    id: 'chemical-storage',
    name: 'Chemical Storage',
    dimensions: { widthM: 20, heightM: 20 },
    bounds: { minX: 0, maxX: 20, minY: 60, maxY: 80 },
    adjacentZoneIds: ['warehouse-1', 'welding-bay'],
    zoneType: 'utility-room',
  },
  {
    id: 'loading-dock',
    name: 'Loading Dock',
    dimensions: { widthM: 40, heightM: 10 },
    bounds: { minX: 25, maxX: 65, minY: 40, maxY: 50 },
    adjacentZoneIds: ['warehouse-1', 'warehouse-2', 'control-room'],
    zoneType: 'warehouse',
  },
  {
    id: 'break-room',
    name: 'Break Room',
    dimensions: { widthM: 15, heightM: 10 },
    bounds: { minX: 75, maxX: 90, minY: 40, maxY: 50 },
    adjacentZoneIds: ['warehouse-2'],
    zoneType: 'reception',
  },
  {
    id: 'control-room',
    name: 'Control Room',
    dimensions: { widthM: 20, heightM: 15 },
    bounds: { minX: 45, maxX: 65, minY: 50, maxY: 65 },
    adjacentZoneIds: ['server-room', 'loading-dock', 'welding-bay'],
    zoneType: 'control-room',
  },
  {
    id: 'ev-charging',
    name: 'EV Charging Station',
    dimensions: { widthM: 25, heightM: 15 },
    bounds: { minX: 65, maxX: 90, minY: 50, maxY: 65 },
    adjacentZoneIds: ['warehouse-2', 'break-room'],
    zoneType: 'parking',
  },
];

const factoryAgents: AgentDef[] = [
  {
    id: 'production-manager',
    owner: 'user-a',
    capabilities: [
      'temperature-monitoring', 'cooling', 'heating',
      'vibration-monitoring', 'equipment-monitoring', 'robot-control',
    ],
    managesZoneIds: ['production-line-1', 'production-line-2', 'production-line-3', 'assembly-area'],
    managesDeviceIds: [],
  },
  {
    id: 'quality-agent',
    owner: 'user-b',
    capabilities: [
      'temperature-monitoring', 'humidity-monitoring', 'lighting-control',
      'quality-inspection', 'calibration',
    ],
    managesZoneIds: ['quality-lab'],
    managesDeviceIds: [],
  },
  {
    id: 'safety-agent',
    owner: 'user-c',
    capabilities: [
      'smoke-detection', 'fire-detection', 'gas-detection', 'chemical-monitoring',
      'emergency-alert', 'access-control', 'lock-control', 'fume-monitoring',
    ],
    managesZoneIds: ['chemical-storage', 'welding-bay', 'painting-booth'],
    managesDeviceIds: [],
  },
  {
    id: 'logistics-agent',
    owner: 'user-d',
    capabilities: [
      'temperature-monitoring', 'humidity-monitoring', 'motion-detection',
      'presence-detection', 'inventory-management',
    ],
    managesZoneIds: ['warehouse-1', 'warehouse-2', 'loading-dock'],
    managesDeviceIds: [],
  },
  {
    id: 'energy-agent',
    owner: 'user-e',
    capabilities: [
      'energy-monitoring', 'load-balancing', 'cost-optimization', 'ev-charging',
    ],
    managesZoneIds: ['ev-charging', 'break-room'],
    managesDeviceIds: [],
  },
  {
    id: 'maintenance-agent',
    owner: 'user-f',
    capabilities: [
      'vibration-monitoring', 'equipment-monitoring', 'maintenance-scheduling',
      'ventilation-control', 'air-purification',
    ],
    managesZoneIds: ['server-room', 'control-room'],
    managesDeviceIds: [],
  },
  {
    id: 'climate-agent',
    owner: 'user-g',
    capabilities: [
      'cooling', 'heating',
      'humidity-control', 'ventilation-control',
    ],
    managesZoneIds: ['painting-booth', 'welding-bay', 'assembly-area'],
    managesDeviceIds: [],
  },
  {
    id: 'security-agent',
    owner: 'user-h',
    capabilities: [
      'motion-detection', 'presence-detection', 'access-control',
      'lock-control', 'lighting-control', 'occupancy-detection',
    ],
    managesZoneIds: ['loading-dock', 'control-room', 'break-room'],
    managesDeviceIds: [],
  },
];

const factoryDevices = generateDevicesForScenario(factoryZones, ZONE_TYPE_MAPS['factory'], 'factory');
assignDevicesToAgents(factoryAgents, factoryDevices);

// ---------------------------------------------------------------------------
// Scenario 5: hospital 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const hospitalZones: ZoneDef[] = [
  { id: 'patient-room-1', name: 'Patient Room 1', dimensions: { widthM: 6, heightM: 5 }, bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 }, adjacentZoneIds: ['patient-room-2', 'corridor-1'], zoneType: 'patient-room' },
  { id: 'patient-room-2', name: 'Patient Room 2', dimensions: { widthM: 6, heightM: 5 }, bounds: { minX: 6, maxX: 12, minY: 0, maxY: 5 }, adjacentZoneIds: ['patient-room-1', 'patient-room-3', 'corridor-1'], zoneType: 'patient-room' },
  { id: 'patient-room-3', name: 'Patient Room 3', dimensions: { widthM: 6, heightM: 5 }, bounds: { minX: 12, maxX: 18, minY: 0, maxY: 5 }, adjacentZoneIds: ['patient-room-2', 'patient-room-4', 'corridor-1'], zoneType: 'patient-room' },
  { id: 'patient-room-4', name: 'Patient Room 4', dimensions: { widthM: 6, heightM: 5 }, bounds: { minX: 18, maxX: 24, minY: 0, maxY: 5 }, adjacentZoneIds: ['patient-room-3', 'corridor-1'], zoneType: 'patient-room' },
  { id: 'corridor-1', name: 'Main Corridor', dimensions: { widthM: 24, heightM: 3 }, bounds: { minX: 0, maxX: 24, minY: 5, maxY: 8 }, adjacentZoneIds: ['patient-room-1', 'patient-room-2', 'patient-room-3', 'patient-room-4', 'icu-1', 'nurse-station'], zoneType: 'corridor' },
  { id: 'icu-1', name: 'ICU Ward 1', dimensions: { widthM: 12, heightM: 8 }, bounds: { minX: 0, maxX: 12, minY: 8, maxY: 16 }, adjacentZoneIds: ['corridor-1', 'operating-room-1', 'nurse-station'], zoneType: 'icu-ward' },
  { id: 'icu-2', name: 'ICU Ward 2', dimensions: { widthM: 12, heightM: 8 }, bounds: { minX: 12, maxX: 24, minY: 8, maxY: 16 }, adjacentZoneIds: ['corridor-1', 'operating-room-2', 'nurse-station'], zoneType: 'icu-ward' },
  { id: 'operating-room-1', name: 'Operating Room 1', dimensions: { widthM: 10, heightM: 8 }, bounds: { minX: 0, maxX: 10, minY: 16, maxY: 24 }, adjacentZoneIds: ['icu-1', 'utility-room'], zoneType: 'operating-room' },
  { id: 'operating-room-2', name: 'Operating Room 2', dimensions: { widthM: 10, heightM: 8 }, bounds: { minX: 14, maxX: 24, minY: 16, maxY: 24 }, adjacentZoneIds: ['icu-2', 'pharmacy'], zoneType: 'operating-room' },
  { id: 'nurse-station', name: 'Nurse Station', dimensions: { widthM: 8, heightM: 5 }, bounds: { minX: 24, maxX: 32, minY: 5, maxY: 10 }, adjacentZoneIds: ['corridor-1', 'icu-1', 'icu-2', 'pharmacy'], zoneType: 'nurse-station' },
  { id: 'pharmacy', name: 'Pharmacy', dimensions: { widthM: 8, heightM: 6 }, bounds: { minX: 24, maxX: 32, minY: 10, maxY: 16 }, adjacentZoneIds: ['nurse-station', 'operating-room-2', 'laboratory'], zoneType: 'pharmacy' },
  { id: 'laboratory', name: 'Laboratory', dimensions: { widthM: 8, heightM: 8 }, bounds: { minX: 24, maxX: 32, minY: 16, maxY: 24 }, adjacentZoneIds: ['pharmacy', 'radiology'], zoneType: 'lab-medical' },
  { id: 'radiology', name: 'Radiology', dimensions: { widthM: 10, heightM: 8 }, bounds: { minX: 32, maxX: 42, minY: 16, maxY: 24 }, adjacentZoneIds: ['laboratory', 'emergency-dept'], zoneType: 'lab-medical' },
  { id: 'emergency-dept', name: 'Emergency Department', dimensions: { widthM: 12, heightM: 10 }, bounds: { minX: 32, maxX: 44, minY: 6, maxY: 16 }, adjacentZoneIds: ['radiology', 'reception'], zoneType: 'reception' },
  { id: 'reception', name: 'Reception', dimensions: { widthM: 12, heightM: 6 }, bounds: { minX: 32, maxX: 44, minY: 0, maxY: 6 }, adjacentZoneIds: ['emergency-dept', 'waiting-area'], zoneType: 'reception' },
  { id: 'waiting-area', name: 'Waiting Area', dimensions: { widthM: 10, heightM: 6 }, bounds: { minX: 44, maxX: 54, minY: 0, maxY: 6 }, adjacentZoneIds: ['reception', 'cafeteria'], zoneType: 'waiting-area' },
  { id: 'cafeteria', name: 'Hospital Cafeteria', dimensions: { widthM: 10, heightM: 8 }, bounds: { minX: 44, maxX: 54, minY: 6, maxY: 14 }, adjacentZoneIds: ['waiting-area', 'parking'], zoneType: 'cafeteria' },
  { id: 'server-room', name: 'Hospital Server Room', dimensions: { widthM: 8, heightM: 6 }, bounds: { minX: 10, maxX: 18, minY: 24, maxY: 30 }, adjacentZoneIds: ['operating-room-1', 'utility-room'], zoneType: 'server-room' },
  { id: 'utility-room', name: 'Utility Room', dimensions: { widthM: 10, heightM: 6 }, bounds: { minX: 0, maxX: 10, minY: 24, maxY: 30 }, adjacentZoneIds: ['operating-room-1', 'server-room'], zoneType: 'utility-room' },
  { id: 'parking', name: 'Parking & Helipad', dimensions: { widthM: 15, heightM: 10 }, bounds: { minX: 44, maxX: 59, minY: 14, maxY: 24 }, adjacentZoneIds: ['cafeteria', 'emergency-dept'], zoneType: 'parking' },
];

const hospitalAgents: AgentDef[] = [
  {
    id: 'patient-care-agent',
    owner: 'user-a',
    capabilities: ['temperature-monitoring', 'cooling', 'heating', 'humidity-monitoring'],
    managesZoneIds: ['patient-room-1', 'patient-room-2', 'patient-room-3', 'patient-room-4', 'corridor-1'],
    managesDeviceIds: [],
  },
  {
    id: 'icu-agent',
    owner: 'user-b',
    capabilities: ['temperature-monitoring', 'cooling', 'heating', 'humidity-monitoring', 'oxygen-monitoring', 'critical-care-monitoring'],
    managesZoneIds: ['icu-1', 'icu-2'],
    managesDeviceIds: [],
  },
  {
    id: 'or-agent',
    owner: 'user-c',
    capabilities: ['temperature-monitoring', 'humidity-monitoring', 'cooling', 'heating', 'air-filtration', 'ventilation-control'],
    managesZoneIds: ['operating-room-1', 'operating-room-2'],
    managesDeviceIds: [],
  },
  {
    id: 'pharmacy-agent',
    owner: 'user-d',
    capabilities: ['temperature-monitoring', 'humidity-monitoring', 'access-control', 'lock-control', 'medication-tracking'],
    managesZoneIds: ['pharmacy'],
    managesDeviceIds: [],
  },
  {
    id: 'lab-agent',
    owner: 'user-e',
    capabilities: ['temperature-monitoring', 'cooling', 'equipment-monitoring'],
    managesZoneIds: ['laboratory', 'radiology'],
    managesDeviceIds: [],
  },
  {
    id: 'safety-agent',
    owner: 'user-f',
    capabilities: ['smoke-detection', 'fire-detection', 'emergency-alert', 'water-leak-detection'],
    managesZoneIds: ['cafeteria', 'server-room', 'utility-room'],
    managesDeviceIds: [],
  },
  {
    id: 'energy-agent',
    owner: 'user-g',
    capabilities: ['energy-monitoring', 'power-monitoring', 'load-balancing', 'cost-optimization'],
    managesZoneIds: ['parking', 'utility-room'],
    managesDeviceIds: [],
  },
  {
    id: 'security-agent',
    owner: 'user-h',
    capabilities: ['motion-detection', 'presence-detection', 'occupancy-detection', 'lighting-control', 'access-control'],
    managesZoneIds: ['reception', 'waiting-area', 'parking', 'emergency-dept'],
    managesDeviceIds: [],
  },
  {
    id: 'facility-agent',
    owner: 'user-i',
    capabilities: ['temperature-monitoring', 'humidity-monitoring', 'cooling', 'heating', 'humidity-control'],
    managesZoneIds: ['nurse-station', 'cafeteria', 'emergency-dept'],
    managesDeviceIds: [],
  },
  {
    id: 'air-quality-agent',
    owner: 'user-j',
    capabilities: ['air-quality-monitoring', 'co2-monitoring', 'ventilation-control', 'air-filtration'],
    managesZoneIds: ['waiting-area', 'patient-room-4', 'corridor-1'],
    managesDeviceIds: [],
  },
];

const hospitalDevices = generateDevicesForScenario(hospitalZones, ZONE_TYPE_MAPS['hospital'], 'hospital');
assignDevicesToAgents(hospitalAgents, hospitalDevices);

// ---------------------------------------------------------------------------
// Scenario 6: smart-city 鈥?Zone, Agent, and Device generation
// ---------------------------------------------------------------------------
const smartCityZones: ZoneDef[] = [
  // --- Residential ---
  { id: 'residential-a', name: 'Residential Block A', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 }, adjacentZoneIds: ['residential-b', 'park'], zoneType: 'city-block' },
  { id: 'residential-b', name: 'Residential Block B', bounds: { minX: 10, maxX: 20, minY: 0, maxY: 10 }, adjacentZoneIds: ['residential-a', 'residential-c', 'shopping-mall'], zoneType: 'city-block' },
  { id: 'residential-c', name: 'Residential Block C', bounds: { minX: 20, maxX: 30, minY: 0, maxY: 10 }, adjacentZoneIds: ['residential-b', 'park'], zoneType: 'city-block' },
  { id: 'park', name: 'Central Park', bounds: { minX: 0, maxX: 15, minY: 10, maxY: 20 }, adjacentZoneIds: ['residential-a', 'residential-c', 'shopping-mall', 'city-hall'], zoneType: 'park' },
  // --- Commercial ---
  { id: 'shopping-mall', name: 'Shopping Mall', bounds: { minX: 15, maxX: 25, minY: 10, maxY: 20 }, adjacentZoneIds: ['park', 'residential-b', 'office-tower-a', 'bank'], zoneType: 'reception' },
  { id: 'office-tower-a', name: 'Office Tower A', bounds: { minX: 25, maxX: 35, minY: 10, maxY: 20 }, adjacentZoneIds: ['shopping-mall', 'office-tower-b', 'bank'], zoneType: 'office' },
  { id: 'office-tower-b', name: 'Office Tower B', bounds: { minX: 35, maxX: 45, minY: 10, maxY: 20 }, adjacentZoneIds: ['office-tower-a', 'highway-junction'], zoneType: 'office' },
  { id: 'bank', name: 'Bank District', bounds: { minX: 25, maxX: 35, minY: 20, maxY: 30 }, adjacentZoneIds: ['shopping-mall', 'office-tower-a', 'police-station', 'city-hall'], zoneType: 'reception' },
  // --- Industrial ---
  { id: 'factory-zone', name: 'Factory Zone', bounds: { minX: 0, maxX: 15, minY: 20, maxY: 30 }, adjacentZoneIds: ['park', 'warehouse-district', 'city-hall'], zoneType: 'production-line' },
  { id: 'warehouse-district', name: 'Warehouse District', bounds: { minX: 15, maxX: 25, minY: 20, maxY: 30 }, adjacentZoneIds: ['factory-zone', 'logistics-hub', 'bank'], zoneType: 'warehouse' },
  { id: 'logistics-hub', name: 'Logistics Hub', bounds: { minX: 15, maxX: 25, minY: 30, maxY: 40 }, adjacentZoneIds: ['warehouse-district', 'data-center', 'airport-terminal'], zoneType: 'warehouse' },
  // --- Medical ---
  { id: 'hospital-district', name: 'Hospital District', bounds: { minX: 0, maxX: 10, minY: 30, maxY: 40 }, adjacentZoneIds: ['factory-zone', 'emergency-center'], zoneType: 'patient-room' },
  { id: 'emergency-center', name: 'Emergency Center', bounds: { minX: 10, maxX: 20, minY: 30, maxY: 40 }, adjacentZoneIds: ['hospital-district', 'logistics-hub', 'fire-station'], zoneType: 'emergency-services' },
  // --- Municipal ---
  { id: 'city-hall', name: 'City Hall', bounds: { minX: 0, maxX: 10, minY: 40, maxY: 50 }, adjacentZoneIds: ['factory-zone', 'bank', 'fire-station'], zoneType: 'office' },
  { id: 'fire-station', name: 'Fire Station', bounds: { minX: 10, maxX: 20, minY: 40, maxY: 50 }, adjacentZoneIds: ['city-hall', 'emergency-center', 'police-station'], zoneType: 'emergency-services' },
  { id: 'police-station', name: 'Police Station', bounds: { minX: 20, maxX: 30, minY: 40, maxY: 50 }, adjacentZoneIds: ['fire-station', 'bank', 'bus-depot'], zoneType: 'office' },
  // --- Infrastructure ---
  { id: 'power-plant', name: 'Power Plant', bounds: { minX: 30, maxX: 40, minY: 30, maxY: 40 }, adjacentZoneIds: ['logistics-hub', 'data-center', 'bus-depot'], zoneType: 'control-room' },
  { id: 'water-treatment', name: 'Water Treatment', bounds: { minX: 30, maxX: 40, minY: 40, maxY: 50 }, adjacentZoneIds: ['power-plant', 'bus-depot', 'highway-junction'], zoneType: 'utility-room' },
  { id: 'data-center', name: 'Data Center', bounds: { minX: 25, maxX: 35, minY: 30, maxY: 40 }, adjacentZoneIds: ['logistics-hub', 'power-plant', 'police-station'], zoneType: 'server-room' },
  // --- Transport ---
  { id: 'main-station', name: 'Main Station', bounds: { minX: 35, maxX: 45, minY: 20, maxY: 30 }, adjacentZoneIds: ['office-tower-b', 'highway-junction', 'power-plant'], zoneType: 'transport-hub' },
  { id: 'bus-depot', name: 'Bus Depot', bounds: { minX: 30, maxX: 40, minY: 40, maxY: 50 }, adjacentZoneIds: ['police-station', 'power-plant', 'water-treatment'], zoneType: 'transport-hub' },
  { id: 'parking-garage', name: 'Parking Garage', bounds: { minX: 40, maxX: 50, minY: 30, maxY: 40 }, adjacentZoneIds: ['power-plant', 'main-station', 'airport-terminal'], zoneType: 'parking' },
  { id: 'highway-junction', name: 'Highway Junction', bounds: { minX: 40, maxX: 50, minY: 20, maxY: 30 }, adjacentZoneIds: ['office-tower-b', 'main-station', 'water-treatment', 'parking-garage'], zoneType: 'outdoor' },
  { id: 'airport-terminal', name: 'Airport Terminal', bounds: { minX: 40, maxX: 50, minY: 40, maxY: 50 }, adjacentZoneIds: ['parking-garage', 'bus-depot', 'water-treatment'], zoneType: 'transport-hub' },
];

const smartCityAgents: AgentDef[] = [
  {
    id: 'residential-manager', owner: 'City Residential Authority',
    capabilities: ['temperature-reading', 'cooling', 'heating', 'motion-detection', 'occupancy-counting', 'energy-monitoring', 'irrigation-control'],
    managesZoneIds: ['residential-a', 'residential-b', 'residential-c', 'park'],
    managesDeviceIds: [],
  },
  {
    id: 'commercial-hvac', owner: 'Commercial Properties LLC',
    capabilities: ['temperature-reading', 'cooling', 'occupancy-counting', 'energy-monitoring', 'security-monitoring', 'access-control'],
    managesZoneIds: ['shopping-mall', 'office-tower-a', 'office-tower-b', 'bank'],
    managesDeviceIds: [],
  },
  {
    id: 'industrial-safety', owner: 'Industrial Safety Board',
    capabilities: ['gas-detection', 'air-quality-monitoring', 'noise-monitoring', 'temperature-reading', 'ventilation-control', 'air-filtration', 'inventory-tracking', 'humidity-reading'],
    managesZoneIds: ['factory-zone', 'warehouse-district'],
    managesDeviceIds: [],
  },
  {
    id: 'energy-grid', owner: 'City Power Authority',
    capabilities: ['power-monitoring', 'load-balancing', 'temperature-reading', 'generator-control', 'load-shedding', 'ups-monitoring', 'cooling-control'],
    managesZoneIds: ['power-plant', 'data-center'],
    managesDeviceIds: [],
  },
  {
    id: 'water-management', owner: 'City Water Authority',
    capabilities: ['water-quality-monitoring', 'flow-monitoring', 'pump-control'],
    managesZoneIds: ['water-treatment'],
    managesDeviceIds: [],
  },
  {
    id: 'transport-coordinator', owner: 'City Transport Authority',
    capabilities: ['video-surveillance', 'occupancy-counting', 'cooling', 'gps-tracking', 'fleet-management', 'fuel-monitoring', 'slot-detection', 'lighting-control', 'traffic-monitoring', 'speed-detection', 'license-plate-recognition'],
    managesZoneIds: ['main-station', 'bus-depot', 'parking-garage', 'highway-junction', 'airport-terminal'],
    managesDeviceIds: [],
  },
  {
    id: 'emergency-services', owner: 'City Emergency Authority',
    capabilities: ['emergency-alert', 'dispatch', 'fire-alert', 'temperature-reading'],
    managesZoneIds: ['fire-station', 'emergency-center'],
    managesDeviceIds: [],
  },
  {
    id: 'environmental-monitor', owner: 'City Environmental Agency',
    capabilities: ['air-quality-monitoring', 'pm25-reading', 'temperature-reading', 'noise-monitoring', 'oxygen-monitoring'],
    managesZoneIds: ['hospital-district'],
    managesDeviceIds: [],
  },
  {
    id: 'security-network', owner: 'City Security Authority',
    capabilities: ['video-surveillance', 'facial-recognition', 'access-control', 'alarm', 'baggage-tracking'],
    managesZoneIds: ['police-station'],
    managesDeviceIds: [],
  },
  {
    id: 'municipal-services', owner: 'City Hall',
    capabilities: ['temperature-reading', 'lighting-control'],
    managesZoneIds: ['city-hall'],
    managesDeviceIds: [],
  },
  {
    id: 'logistics-agent', owner: 'City Logistics Authority',
    capabilities: ['gps-tracking', 'fleet-management', 'temperature-reading'],
    managesZoneIds: ['logistics-hub'],
    managesDeviceIds: [],
  },
  {
    id: 'weather-agent', owner: 'City Weather Service',
    capabilities: ['temperature-reading', 'air-quality-monitoring', 'moisture-reading'],
    managesZoneIds: [],
    managesDeviceIds: [],
  },
];

const smartCityDevices = generateDevicesForScenario(smartCityZones, ZONE_TYPE_MAPS['smart-city'], 'smart-city');
assignDevicesToAgents(smartCityAgents, smartCityDevices);

// ===========================================================================
// SCENARIOS 鈥?References the pre-generated zones, devices, and agents
// ===========================================================================

export const SCENARIOS: Record<ScenarioType, ScenarioDefinition> = {
  // ---------------------------------------------------------------------------
  // Scenario 1: single-room
  // A single 10m x 10m room with one agent that owns all capabilities.
  // ---------------------------------------------------------------------------
  'single-room': {
    id: 'single-room',
    type: 'single-room',
    name: 'Single Room',
    description:
      'A single room with temperature, lighting, motion, and smoke sensors. ' +
      'Two agents (climate + safety) must collaborate on fire and smoke events.',
    zones: singleRoomZones,
    devices: singleRoomDevices,
    agents: singleRoomAgents,
    events: [
      {
        id: 'evt-sr-1',
        type: 'temperature-anomaly',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { temperature: 36, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'room-1',
          targetValue: 24,
          tolerance: 2,
          shouldChange: true,
        },
      },
      {
        id: 'evt-sr-2',
        type: 'presence-detected',
        zoneId: 'room-1',
        location: { x: 3, y: 3 },
        payload: { motion: true },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'room-1',
          shouldChange: true,
        },
      },
      {
        id: 'evt-sr-3',
        type: 'temperature-normal',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { temperature: 23 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'room-1',
          shouldChange: false,
        },
      },
      // Event 4: Smoke detected 鈥?climate-agent detects temperature rise but
      // lacks fire-suppression and emergency-alert capabilities.
      // Must collaborate with safety-agent who has those capabilities.
      {
        id: 'evt-sr-4',
        type: 'smoke-detected',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { smoke: true, temperature: 48 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['fire-suppression', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['fire-suppression', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'smoke',
          location: 'room-1',
          shouldChange: true,
        },
      },
      // Event 5: Rapid temperature rise 鈥?suggests fire risk beyond normal
      // HVAC control. climate-agent can cool but needs safety-agent to
      // assess fire risk and activate suppression if needed.
      {
        id: 'evt-sr-5',
        type: 'temperature-rise',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { temperature: 42, rate: 5, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['smoke-detection', 'fire-suppression'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['smoke-detection', 'fire-suppression'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'room-1',
          targetValue: 24,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 6: High CO2 level 鈥?climate-agent detects stale air but lacks
      // air-purification and ventilation-control capabilities. Must collaborate
      // with air-quality-agent who has those capabilities.
      {
        id: 'evt-sr-6',
        type: 'co2-anomaly',
        zoneId: 'room-1',
        location: { x: 7, y: 3 },
        payload: { co2: 1200, threshold: 1000 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification', 'ventilation-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'air-quality-agent',
        correctPartnerCapabilities: ['air-purification', 'ventilation-control'],
        expectedOutcome: {
          parameter: 'co2',
          location: 'room-1',
          targetValue: 600,
          tolerance: 200,
          shouldChange: true,
        },
      },
      // Event 7: Humidity rise 鈥?climate-agent can adjust HVAC for basic
      // dehumidification but needs air-quality-agent's humidity-monitoring
      // and ventilation expertise.
      {
        id: 'evt-sr-7',
        type: 'humidity-anomaly',
        zoneId: 'room-1',
        location: { x: 3, y: 7 },
        payload: { humidity: 78, threshold: 65 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-monitoring', 'ventilation-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'air-quality-agent',
        correctPartnerCapabilities: ['humidity-monitoring', 'ventilation-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'room-1',
          targetValue: 50,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 8: Normal CO2 reading 鈥?should be ignored.
      {
        id: 'evt-sr-8',
        type: 'co2-normal',
        zoneId: 'room-1',
        location: { x: 7, y: 3 },
        payload: { co2: 450 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'co2',
          location: 'room-1',
          shouldChange: false,
        },
      },
      // Event 9: Occupancy change 鈥?climate-agent handles lighting independently.
      {
        id: 'evt-sr-9',
        type: 'occupancy-change',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { occupancy: 3, previous: 1 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'room-1',
          shouldChange: true,
        },
      },
      // Event 10: Air quality degradation 鈥?climate-agent detects symptoms
      // (high temp + stale air) but needs air-quality-agent's purification
      // capability to address the root cause.
      {
        id: 'evt-sr-10',
        type: 'air-quality-degradation',
        zoneId: 'room-1',
        location: { x: 5, y: 5 },
        payload: { aqi: 150, threshold: 100, temperature: 30 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification', 'air-quality-monitoring'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'air-quality-agent',
        correctPartnerCapabilities: ['air-purification', 'air-quality-monitoring'],
        expectedOutcome: {
          parameter: 'aqi',
          location: 'room-1',
          targetValue: 50,
          tolerance: 30,
          shouldChange: true,
        },
      },
    ],
  },


  // Scenario 2: apartment
  // Ten rooms with six agents that must collaborate for cross-zone events.
  // ---------------------------------------------------------------------------
  'apartment': {
    id: 'apartment',
    type: 'apartment',
    name: 'Apartment',
    description:
      'A ten-room smart apartment with six specialized agents covering climate, security, ' +
      'safety, energy, maintenance, and environment monitoring. Tests cross-zone collaboration, ' +
      'propagation awareness, and multi-domain event handling.',
    zones: apartmentZones,
    devices: apartmentDevices,
    agents: apartmentAgents,
    events: [
      {
        id: 'evt-apt-1',
        type: 'temperature-anomaly',
        zoneId: 'living-room',
        location: { x: 3, y: 2.5 },
        payload: { temperature: 36, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'living-room',
          targetValue: 24,
          tolerance: 2,
          shouldChange: true,
        },
      },
      {
        id: 'evt-apt-2',
        type: 'temperature-anomaly-critical',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { temperature: 40, threshold: 35, critical: true },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'server-room',
          affectedZoneIds: ['kitchen'],
          reason: 'server-room is adjacent to kitchen; heat may propagate',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'server-room',
          targetValue: 22,
          tolerance: 2,
          shouldChange: true,
        },
      },
      {
        id: 'evt-apt-3',
        type: 'humidity-anomaly',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { humidity: 85, threshold: 70 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'bedroom',
          targetValue: 50,
          tolerance: 10,
          shouldChange: true,
        },
      },
      {
        id: 'evt-apt-4',
        type: 'presence-detected',
        zoneId: 'bathroom',
        location: { x: 9, y: 7.5 },
        payload: { motion: true, timeOfDay: 'night' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'bathroom',
          shouldChange: true,
        },
      },
      {
        id: 'evt-apt-5',
        type: 'temperature-normal',
        zoneId: 'living-room',
        location: { x: 3, y: 2.5 },
        payload: { temperature: 23 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'living-room',
          shouldChange: false,
        },
      },
      {
        id: 'evt-apt-6',
        type: 'fire-detected',
        zoneId: 'kitchen',
        location: { x: 3, y: 7.5 },
        payload: { temperature: 55, smoke: true, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'kitchen',
          targetValue: 24,
          tolerance: 5,
          shouldChange: true,
        },
      },
      // Event 7: CO alarm in kitchen 鈥?safety-agent detects gas but needs
      // climate-controller to shut HVAC and prevent gas spread to living-room.
      {
        id: 'evt-apt-7',
        type: 'gas-leak',
        zoneId: 'kitchen',
        location: { x: 5, y: 8 },
        payload: { co: 150, threshold: 50 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'kitchen',
          affectedZoneIds: ['living-room'],
          reason: 'kitchen is adjacent to living-room; HVAC can circulate gas',
        },
        expectedOutcome: {
          parameter: 'co',
          location: 'kitchen',
          targetValue: 0,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 8: Water leak in bathroom 鈥?safety-agent detects leak but needs
      // maintenance-agent to activate water shutoff.
      {
        id: 'evt-apt-8',
        type: 'water-leak',
        zoneId: 'bathroom',
        location: { x: 10, y: 8 },
        payload: { leakDetected: true, severity: 'moderate' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['water-shutoff'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'maintenance-agent',
        correctPartnerCapabilities: ['water-shutoff'],
        expectedOutcome: {
          parameter: 'water',
          location: 'bathroom',
          shouldChange: true,
        },
      },
      // Event 9: Energy spike → overheating — energy-agent detects abnormal consumption
      // causing temperature rise, needs climate-controller to cool the garage.
      {
        id: 'evt-apt-9',
        type: 'temperature-rise',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { temperature: 35, threshold: 28, cause: 'energy_anomaly', consumption: 8500 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'garage',
          targetValue: 22,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 10: High CO2 in home-office 鈥?env-monitor detects poor air but
      // needs climate-controller for ventilation control.
      {
        id: 'evt-apt-10',
        type: 'co2-anomaly',
        zoneId: 'home-office',
        location: { x: 15, y: 3 },
        payload: { co2: 1300, threshold: 1000 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['air-purification'],
        expectedOutcome: {
          parameter: 'co2',
          location: 'home-office',
          targetValue: 600,
          tolerance: 200,
          shouldChange: true,
        },
      },
      // Event 11: Scheduled cleaning 鈥?maintenance-agent handles independently.
      {
        id: 'evt-apt-11',
        type: 'scheduled-maintenance',
        zoneId: 'utility-room',
        location: { x: 5.5, y: 11.5 },
        payload: { task: 'filter-replacement', schedule: 'monthly' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['maintenance-scheduling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'maintenance',
          location: 'utility-room',
          shouldChange: true,
        },
      },
      // Event 12: Minor humidity fluctuation 鈥?within tolerance, should be ignored.
      {
        id: 'evt-apt-12',
        type: 'humidity-normal',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { humidity: 48 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'humidity',
          location: 'bedroom',
          shouldChange: false,
        },
      },
      // Event 13: Balcony temperature affects living-room 鈥?env-monitor detects
      // cold air from adjacent balcony affecting living-room, needs climate-controller.
      {
        id: 'evt-apt-13',
        type: 'temperature-drop',
        zoneId: 'balcony',
        location: { x: 3, y: -1 },
        payload: { temperature: 5, previousTemp: 18 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['heating'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['heating'],
        propagationAwareness: {
          sourceZoneId: 'balcony',
          affectedZoneIds: ['living-room'],
          reason: 'balcony is adjacent to living-room; cold air can infiltrate',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'living-room',
          targetValue: 22,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 14: Night intrusion attempt 鈥?security-monitor detects motion at
      // entrance at night, needs safety-agent for emergency alert.
      {
        id: 'evt-apt-14',
        type: 'intrusion-detected',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { motion: true, timeOfDay: 'night', authorized: false },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['emergency-alert'],
        expectedOutcome: {
          parameter: 'security',
          location: 'entrance-hall',
          shouldChange: true,
          validationMode: 'task_completion',
        },
      },
      // Event 15: Morning blinds schedule 鈥?maintenance-agent handles independently.
      {
        id: 'evt-apt-15',
        type: 'scheduled-task',
        zoneId: 'living-room',
        location: { x: 3, y: 2.5 },
        payload: { task: 'blinds-open', timeOfDay: 'morning' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['maintenance-scheduling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'living-room',
          shouldChange: true,
        },
      },
      // Broadcast Event 1: Fire alarm broadcast — critical emergency in living-room.
      // Agents with fire-suppression or emergency-alert capabilities should initiate AC;
      // other agents should defer to fire-capable agents.
      {
        id: 'evt-apt-broadcast-1',
        type: 'fire-alarm-broadcast',
        zoneId: 'living-room',
        location: { x: 3, y: 2 },
        payload: { smoke: true, temperature: 55, source: 'fire-alarm-system' },
        severity: 'critical',
        eventCategory: 'agent-directed',
        requiresCollaboration: true,
        requiredCapabilities: ['fire-suppression', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        expectedOutcome: {
          parameter: 'smoke',
          location: 'living-room',
          targetValue: 0,
          shouldChange: true,
        },
      },
      // Broadcast Event 2: Security alert broadcast — high-severity intrusion alert
      // in entrance-hall. Agents with security-monitoring capability should respond.
      {
        id: 'evt-apt-broadcast-2',
        type: 'security-alert-broadcast',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { intrusion: true, source: 'security-system', alertLevel: 'high' },
        severity: 'high',
        eventCategory: 'agent-directed',
        requiresCollaboration: true,
        requiredCapabilities: ['security-monitoring'],
        correctDecision: 'initiate_ac',
        expectedOutcome: {
          parameter: 'security',
          location: 'entrance-hall',
          shouldChange: true,
          validationMode: 'task_completion',
        },
      },
      // Broadcast Event 3: HVAC system alert — medium-severity maintenance broadcast.
      // Non-HVAC agents should ignore; HVAC-capable agents should handle.
      {
        id: 'evt-apt-broadcast-3',
        type: 'hvac-system-alert',
        zoneId: 'living-room',
        location: { x: 3, y: 2.5 },
        payload: { system: 'hvac', alert: 'maintenance-required', component: 'compressor' },
        severity: 'medium',
        eventCategory: 'agent-directed',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'maintenance',
          location: 'living-room',
          shouldChange: true,
        },
      },
      // Event 16: Air quality degradation in living-room — env-monitor detects high
      // PM2.5/VOC, needs climate-controller to activate air purifier.
      {
        id: 'evt-apt-16',
        type: 'air-quality-anomaly',
        zoneId: 'living-room',
        location: { x: 3, y: 2.5 },
        payload: { pm25: 75, voc: 300, threshold: { pm25: 50, voc: 200 } },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['air-purification'],
        expectedOutcome: {
          parameter: 'pm25',
          location: 'living-room',
          targetValue: 30,
          tolerance: 20,
          shouldChange: true,
        },
      },
      // Event 17: Low humidity in bedroom — env-monitor detects dry air (winter),
      // needs climate-controller to activate humidifier.
      {
        id: 'evt-apt-17',
        type: 'humidity-low',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { humidity: 25, threshold: 30 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'bedroom',
          targetValue: 45,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 18: Intrusion at entrance — security-monitor detects unauthorized motion
      // at night, turns on lights via own devices (handle independently).
      {
        id: 'evt-apt-18',
        type: 'presence-detected',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { motion: true, timeOfDay: 'night', authorized: false },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'entrance-hall',
          shouldChange: true,
        },
      },
      // Event 19: Fire detected in kitchen — safety-agent detects fire, needs
      // security-monitor to activate speakers for emergency evacuation broadcast.
      {
        id: 'evt-apt-19',
        type: 'fire-detected',
        zoneId: 'kitchen',
        location: { x: 3, y: 7.5 },
        payload: { smoke: true, temperature: 45, source: 'smoke-detector' },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-monitor',
        correctPartnerCapabilities: ['emergency-alert'],
        propagationAwareness: {
          sourceZoneId: 'kitchen',
          affectedZoneIds: ['living-room', 'entrance-hall'],
          reason: 'fire in kitchen may spread to living-room and entrance-hall',
        },
        expectedOutcome: {
          parameter: 'security',
          location: 'kitchen',
          shouldChange: true,
          validationMode: 'task_completion',
        },
      },
      // Event 20: High humidity in bathroom — env-monitor detects high humidity after
      // shower, needs climate-controller to activate exhaust fan.
      {
        id: 'evt-apt-20',
        type: 'humidity-anomaly',
        zoneId: 'bathroom',
        location: { x: 10, y: 8 },
        payload: { humidity: 90, threshold: 70 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'bathroom',
          targetValue: 55,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // ---------------------------------------------------------------
      // Type C events: propagation coverage + capability gap
      // These events are placed in zones ADJACENT to zones where
      // actuator-having agents have actuators, with required capabilities
      // the agent LACKS — creating coverage=0.5 (propagation), gap≠∅.
      // ---------------------------------------------------------------
      // Event 21: Security threat on balcony — climate-controller has actuators in
      // living-room (adjacent to balcony, propagation coverage) but lacks
      // security-monitoring capability → Type C for climate-controller.
      {
        id: 'evt-apt-21',
        type: 'intrusion-detected',
        zoneId: 'balcony',
        location: { x: 3, y: -1 },
        payload: { motion: true, timeOfDay: 'night', authorized: false },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['security-monitoring', 'access-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-monitor',
        correctPartnerCapabilities: ['access-control'],
        expectedOutcome: {
          parameter: 'security',
          location: 'balcony',
          shouldChange: true,
          validationMode: 'task_completion',
        },
      },
      // Event 22: Gas leak in home-office — safety-agent has actuators in
      // bathroom (adjacent to home-office) but also has gas-detection.
      // For security-monitor: has actuators in bathroom/server-room (adjacent to
      // home-office? home-office adjacent to bedroom, bathroom. security-monitor
      // manages bathroom → propagation. But security-monitor lacks gas-detection → Type C.
      {
        id: 'evt-apt-22',
        type: 'gas-leak',
        zoneId: 'home-office',
        location: { x: 15, y: 3 },
        payload: { co: 80, threshold: 50, source: 'heater' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['gas-detection', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['gas-detection', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'co',
          location: 'home-office',
          targetValue: 0,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 23: Temperature anomaly in entrance-hall — climate-controller has actuators
      // in kitchen (adjacent to entrance-hall, propagation coverage) but lacks
      // security-monitoring. Uses security-related capabilities to create gap for Type C.
      {
        id: 'evt-apt-23',
        type: 'temperature-anomaly',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { temperature: 33, threshold: 28 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['security-monitoring', 'cooling'],
        correctDecision: 'initiate_ac',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'entrance-hall',
          targetValue: 22,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 24: Water leak in utility-room — safety-agent has actuators in kitchen
      // (adjacent to utility-room, propagation) but lacks water-shutoff → Type C.
      {
        id: 'evt-apt-24',
        type: 'water-leak',
        zoneId: 'utility-room',
        location: { x: 5.5, y: 11.5 },
        payload: { leakDetected: true, severity: 'moderate' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['water-shutoff'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'maintenance-agent',
        correctPartnerCapabilities: ['water-shutoff'],
        expectedOutcome: {
          parameter: 'water',
          location: 'utility-room',
          shouldChange: true,
        },
      },
      // Event 25: Fire detected in server-room — security-monitor has actuators in
      // server-room (direct coverage) → Type B for security-monitor. But for
      // climate-controller: has actuators in kitchen (adjacent to server-room),
      // lacks fire-suppression → Type C for climate-controller.
      {
        id: 'evt-apt-25',
        type: 'fire-detected',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { smoke: true, temperature: 50, source: 'server-overheat' },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['fire-suppression', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['fire-suppression', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'smoke',
          location: 'server-room',
          targetValue: 0,
          shouldChange: true,
        },
      },
      // Event 26: Air quality anomaly in bedroom — climate-controller has actuators in
      // bedroom (direct) → Type B. For safety-agent: has actuators in kitchen (NOT
      // adjacent to bedroom — kitchen adj = living-room, server-room, entrance-hall).
      // For security-monitor: has actuators in bedroom (direct) but lacks air-purification.
      // Let's use a zone that gives propagation: security-monitor has actuators in
      // living-room (adjacent to bedroom) → Type C for events requiring
      // capabilities security-monitor lacks in bedroom.
      {
        id: 'evt-apt-26',
        type: 'air-quality-anomaly',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { pm25: 80, voc: 400, threshold: { pm25: 50, voc: 200 } },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['air-purification'],
        expectedOutcome: {
          parameter: 'pm25',
          location: 'bedroom',
          targetValue: 30,
          tolerance: 20,
          shouldChange: true,
        },
      },
      // ---------------------------------------------------------------
      // Type E events: no coverage + no capability gap
      // Agent has ALL required capabilities but event is in a zone with
      // zero coverage (not direct, not propagation) → Type E, initiate_ac.
      // ---------------------------------------------------------------
      // Event 27: Temperature anomaly in garage — climate-controller has
      // cooling capability but garage is NOT in its managedZoneIds and
      // garage is only adjacent to entrance-hall (NOT managed by climate-controller).
      // So coverage=0, gap=empty → Type E for climate-controller.
      {
        id: 'evt-apt-27',
        type: 'temperature-anomaly',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { temperature: 32, threshold: 28 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-controller',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'garage',
          targetValue: 22,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 28: Gas leak in garage — safety-agent has gas-detection + emergency-alert
      // but garage is NOT in safety-agent's managedZoneIds (kitchen, bathroom, utility-room,
      // living-room). Garage is only adjacent to entrance-hall, which is NOT managed by
      // safety-agent. So coverage=0, gap=empty → Type E for safety-agent.
      {
        id: 'evt-apt-28',
        type: 'gas-leak',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { co: 70, threshold: 50, source: 'vehicle' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['gas-detection', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['gas-detection', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'co',
          location: 'garage',
          targetValue: 0,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 29: Lighting required in balcony — security-monitor has lighting-control
      // but balcony is NOT in its managedZoneIds. Balcony is adjacent to living-room.
      // Security-monitor DOES manage living-room, so if it has actuators there,
      // balcony would be propagation coverage (0.5) for security-monitor.
      // Need a different approach: use utility-room + maintenance-agent.
      // maintenance-agent has water-shutoff, equipment-monitoring. For utility-room:
      // maintenance-agent manages utility-room → direct coverage. Not Type E.
      // Let's use energy-agent + balcony: energy-agent has energy-monitoring,
      // cost-optimization, load-balancing but NOT in balcony's zones.
      // Balcony not adjacent to garage or utility-room → unreachable.
      // But required capabilities need to match energy-agent's caps.
      {
        id: 'evt-apt-29',
        type: 'energy-spike',
        zoneId: 'balcony',
        location: { x: 3, y: -1 },
        payload: { consumption: 12000, threshold: 8000, source: 'outdoor-heater' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['energy-monitoring', 'cost-optimization'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'energy-agent',
        correctPartnerCapabilities: ['energy-monitoring', 'cost-optimization'],
        expectedOutcome: {
          parameter: 'energy',
          location: 'balcony',
          shouldChange: true,
        },
      },
      // Event 30: Fire suppression needed in garage — safety-agent has fire-detection +
      // emergency-alert but garage is unreachable (coverage=0 for safety-agent).
      // Required caps are a subset of safety-agent → gap empty, coverage=0 → Type E.
      {
        id: 'evt-apt-30',
        type: 'fire-detected',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { smoke: true, temperature: 45, source: 'electrical-fault' },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['fire-detection', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['fire-detection', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'smoke',
          location: 'garage',
          targetValue: 0,
          shouldChange: true,
        },
      },
      // Event 31: Equipment malfunction in balcony — maintenance-agent has
      // equipment-monitoring but balcony is unreachable. Balcony adj = living-room.
      // maintenance-agent manages utility-room, garage → not adjacent to balcony.
      // coverage=0, gap=empty → Type E for maintenance-agent.
      {
        id: 'evt-apt-31',
        type: 'equipment-malfunction',
        zoneId: 'balcony',
        location: { x: 3, y: -1 },
        payload: { equipment: 'weather-station', status: 'offline', error: 'sensor_failure' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['equipment-monitoring'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'maintenance-agent',
        correctPartnerCapabilities: ['equipment-monitoring'],
        expectedOutcome: {
          parameter: 'maintenance',
          location: 'balcony',
          shouldChange: true,
        },
      },
      // ---------------------------------------------------------------
      // Type A events: agent has full coverage + all required capabilities
      // These events test the agent's ability to correctly decide NOT to
      // collaborate when it can handle the event independently.
      // ---------------------------------------------------------------
      // Ignore events in zones WITHOUT env-monitor (server-room, garage,
      // utility-room) → ALL managing agents have actuator coverage and
      // zero capability gap → 100% Type A pairs.
      // Event 32: Server-room temperature normal — climate-controller and
      // security-monitor both have actuators here, no action needed.
      {
        id: 'evt-apt-32',
        type: 'temperature-normal',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { temperature: 21 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'server-room',
          shouldChange: false,
        },
      },
      // Event 33: Garage all clear — no issues detected.
      {
        id: 'evt-apt-33',
        type: 'all-clear',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { status: 'normal', motion: false },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'security',
          location: 'garage',
          shouldChange: false,
          validationMode: 'task_completion',
        },
      },
      // Event 34: Bedroom temperature normal — all 3 managing agents
      // (env-monitor, climate-controller, security-monitor) have actuator
      // coverage in bedroom → 100% Type A pairs.
      {
        id: 'evt-apt-34',
        type: 'temperature-normal',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { temperature: 22 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'bedroom',
          shouldChange: false,
        },
      },
      // Event 35: Server-room environmental normal — air quality, humidity fine.
      {
        id: 'evt-apt-35',
        type: 'environmental-normal',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { temperature: 20, humidity: 45, aqi: 30 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'environment',
          location: 'server-room',
          shouldChange: false,
        },
      },
      // Event 36: Garage energy consumption normal.
      {
        id: 'evt-apt-36',
        type: 'energy-normal',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { consumption: 2400, threshold: 8000 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'energy',
          location: 'garage',
          shouldChange: false,
          validationMode: 'task_completion',
        },
      },
      // Event 37: Entrance-hall light level normal — both managing agents
      // (env-monitor, security-monitor) have actuator coverage → 100% Type A.
      {
        id: 'evt-apt-37',
        type: 'light-level-normal',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { lightLevel: 200, threshold: 100 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'entrance-hall',
          shouldChange: false,
        },
      },
      // Event 38: Garage security status normal — no intrusion.
      {
        id: 'evt-apt-38',
        type: 'security-normal',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { intrusion: false, access: 'secured', motion: false },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'security',
          location: 'garage',
          shouldChange: false,
          validationMode: 'task_completion',
        },
      },
      // ---------------------------------------------------------------
      // Handle-independently events: specific required capabilities that
      // match exactly one managing agent (Type A for that agent,
      // Type B/D for others).
      // ---------------------------------------------------------------
      // Event 39: Server-room temperature rise — climate-controller has
      // cooling + server-room actuator coverage → Type A.
      // security-monitor lacks cooling → Type B.
      {
        id: 'evt-apt-39',
        type: 'temperature-anomaly',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { temperature: 32, threshold: 28 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'server-room',
          targetValue: 22,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 40: Home-office humidity high — climate-controller has
      // humidity-control + home-office coverage → Type A.
      // env-monitor lacks humidity-control, sensor-only → Type D → initiate_ac.
      {
        id: 'evt-apt-40',
        type: 'humidity-anomaly',
        zoneId: 'home-office',
        location: { x: 15, y: 3 },
        payload: { humidity: 75, threshold: 65 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'humidity',
          location: 'home-office',
          targetValue: 50,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 41: Night lighting in entrance-hall — security-monitor has
      // lighting-control + entrance-hall coverage → Type A.
      // env-monitor lacks lighting-control, sensor-only → Type D → initiate_ac.
      {
        id: 'evt-apt-41',
        type: 'lighting-needed',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { lightLevel: 5, threshold: 50, timeOfDay: 'night' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'entrance-hall',
          shouldChange: true,
        },
      },
      // Event 42: Home-office temperature low — climate-controller has
      // heating + home-office coverage → Type A.
      // env-monitor lacks heating → Type D → initiate_ac.
      {
        id: 'evt-apt-42',
        type: 'temperature-drop',
        zoneId: 'home-office',
        location: { x: 15, y: 3 },
        payload: { temperature: 16, threshold: 20 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['heating'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'home-office',
          targetValue: 22,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 43: Server-room air purification needed — climate-controller has
      // air-purification + server-room coverage → Type A.
      // security-monitor lacks air-purification → Type B.
      {
        id: 'evt-apt-43',
        type: 'air-quality-anomaly',
        zoneId: 'server-room',
        location: { x: 15, y: 7.5 },
        payload: { pm25: 65, voc: 250, threshold: { pm25: 50, voc: 200 } },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'pm25',
          location: 'server-room',
          targetValue: 30,
          tolerance: 20,
          shouldChange: true,
        },
      },
      // Event 44: Entrance-hall access control — security-monitor has
      // access-control + entrance-hall coverage → Type A.
      // env-monitor lacks access-control → Type D → initiate_ac.
      {
        id: 'evt-apt-44',
        type: 'access-request',
        zoneId: 'entrance-hall',
        location: { x: 2, y: 12 },
        payload: { requestType: 'entry', userId: 'resident-1', authorized: true },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['access-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'access',
          location: 'entrance-hall',
          shouldChange: true,
        },
      },
      // Event 45: Bedroom temperature rise — climate-controller has
      // cooling + bedroom coverage → Type A.
      // env-monitor lacks these → Type D → initiate_ac.
      // security-monitor lacks these → Type B → initiate_ac.
      {
        id: 'evt-apt-45',
        type: 'temperature-anomaly',
        zoneId: 'bedroom',
        location: { x: 9, y: 2.5 },
        payload: { temperature: 29, threshold: 26 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'bedroom',
          targetValue: 23,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 46: Garage lighting needed — security-monitor has
      // lighting-control + garage coverage → Type A.
      // energy-agent, maintenance-agent lack lighting-control → Type B.
      {
        id: 'evt-apt-46',
        type: 'lighting-needed',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { lightLevel: 10, threshold: 50, trigger: 'vehicle-approach' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'garage',
          shouldChange: true,
        },
      },
      // Event 47: Garage equipment diagnostic — maintenance-agent has
      // equipment-monitoring + garage coverage → Type A.
      // security-monitor, energy-agent lack equipment-monitoring → Type B.
      {
        id: 'evt-apt-47',
        type: 'equipment-diagnostic',
        zoneId: 'garage',
        location: { x: 10, y: 13 },
        payload: { equipment: 'garage-door-motor', diagnostic: 'routine' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['equipment-monitoring'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'maintenance',
          location: 'garage',
          shouldChange: true,
        },
      },
      // Event 48: Home-office air quality normal — both managing agents
      // (env-monitor, climate-controller) have actuator coverage → 100% Type A.
      {
        id: 'evt-apt-48',
        type: 'air-quality-normal',
        zoneId: 'home-office',
        location: { x: 15, y: 3 },
        payload: { aqi: 35, pm25: 20, co2: 500 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'aqi',
          location: 'home-office',
          shouldChange: false,
        },
      },
    ],
  },


  // Scenario 3: campus
  // Sixteen buildings across a campus with ten specialised agents. Cross-building
  // collaboration and propagation awareness are critical evaluation axes.
  // ---------------------------------------------------------------------------
  'campus': {
    id: 'campus',
    type: 'campus',
    name: 'Campus',
    description:
      'A campus with sixteen buildings (three office buildings, two lab buildings, a server facility, ' +
      'a warehouse, a cafeteria, a lobby, a parking lot, a sports field, a garden, a lecture hall, ' +
      'a gym, a library, and a dormitory) managed by ten agents. Tests cross-building ' +
      'collaboration, propagation awareness, multi-domain event handling, and energy management.',
    zones: campusZones,
    devices: campusDevices,
    agents: campusAgents,
    events: [
      // Event 1: Simple temperature anomaly in office-building-1
      // office-manager has full HVAC control -- can handle independently.
      {
        id: 'evt-campus-1',
        type: 'temperature-anomaly',
        zoneId: 'office-building-1',
        location: { x: 10, y: 7.5 },
        payload: { temperature: 36, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'office-building-1',
          targetValue: 24,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 2: Cross-zone collaboration -- temperature spike in server-facility.
      // server-manager detects it and has HVAC, but let us test when server-manager
      // detects and facility-monitor does NOT have HVAC. Instead, the lab-monitor
      // is adjacent and should be contacted for propagation awareness.
      {
        id: 'evt-campus-2',
        type: 'temperature-anomaly-critical',
        zoneId: 'server-facility',
        location: { x: 50, y: 22.5 },
        payload: { temperature: 42, threshold: 35, critical: true },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        propagationAwareness: {
          sourceZoneId: 'server-facility',
          affectedZoneIds: ['lab-building-2'],
          reason:
            'server-facility is adjacent to lab-building-2; ' +
            'critical heat may propagate into the lab environment',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'server-facility',
          targetValue: 20,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 3: Cross-zone collaboration -- warehouse temperature rises but
      // facility-monitor only has monitoring, not control. Must collaborate with
      // climate-coordinator who has HVAC in cafeteria (adjacent zone with control).
      {
        id: 'evt-campus-3',
        type: 'temperature-anomaly',
        zoneId: 'warehouse',
        location: { x: 10, y: 37.5 },
        payload: { temperature: 38, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'warehouse',
          targetValue: 24,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 4: Propagation awareness -- heater running in lab-building-1
      // could affect server-facility. lab-monitor should be aware that
      // server-facility is connected via lab-building-2.
      {
        id: 'evt-campus-4',
        type: 'temperature-anomaly',
        zoneId: 'lab-building-1',
        location: { x: 10, y: 22.5 },
        payload: { temperature: 37, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        propagationAwareness: {
          sourceZoneId: 'lab-building-1',
          affectedZoneIds: ['lab-building-2', 'server-facility'],
          reason:
            'lab-building-1 is adjacent to lab-building-2, which is adjacent to server-facility; ' +
            'sustained heat in the lab could propagate to the server facility',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'lab-building-1',
          targetValue: 24,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 5: Complex multi-capability event -- cafeteria fire (smoke + high temp).
      // facility-monitor detects but needs cooling.
      // Must collaborate with climate-coordinator who has those capabilities.
      {
        id: 'evt-campus-5',
        type: 'fire-detected',
        zoneId: 'cafeteria',
        location: { x: 30, y: 37.5 },
        payload: { temperature: 52, smoke: true, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'temperature',
          location: 'cafeteria',
          targetValue: 24,
          tolerance: 5,
          shouldChange: true,
        },
      },
      // Event 6: Normal temperature in office-building-2 -- should be ignored.
      {
        id: 'evt-campus-6',
        type: 'temperature-normal',
        zoneId: 'office-building-2',
        location: { x: 30, y: 7.5 },
        payload: { temperature: 22 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'office-building-2',
          shouldChange: false,
        },
      },
      // Event 7: Lobby motion detected at night -- security-agent handles independently.
      {
        id: 'evt-campus-7',
        type: 'presence-detected',
        zoneId: 'lobby',
        location: { x: 50, y: 37.5 },
        payload: { motion: true, timeOfDay: 'night' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'light',
          location: 'lobby',
          shouldChange: true,
        },
      },
      // Event 8: Humidity anomaly in lab-building-2 -- lab-monitor has humidity-monitoring
      // but not humidity-control. Must collaborate with climate-coordinator who has
      // humidity-control capability.
      {
        id: 'evt-campus-8',
        type: 'humidity-anomaly',
        zoneId: 'lab-building-2',
        location: { x: 30, y: 22.5 },
        payload: { humidity: 88, threshold: 70 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'lab-building-2',
          targetValue: 50,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 9: Office-building-3 temperature anomaly -- office-manager can handle
      // independently (has full HVAC control). No collaboration needed.
      {
        id: 'evt-campus-9',
        type: 'temperature-anomaly',
        zoneId: 'office-building-3',
        location: { x: 50, y: 7.5 },
        payload: { temperature: 37, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'office-building-3',
          targetValue: 24,
          tolerance: 2,
          shouldChange: true,
        },
      },
      // Event 10: Normal humidity in warehouse -- should be ignored.
      {
        id: 'evt-campus-10',
        type: 'humidity-normal',
        zoneId: 'warehouse',
        location: { x: 10, y: 37.5 },
        payload: { humidity: 45 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'humidity',
          location: 'warehouse',
          shouldChange: false,
        },
      },
      // Event 11: Humidity spike in server-facility 鈥?server-manager has
      // humidity-monitoring but NOT humidity-control. Must collaborate with
      // climate-coordinator who has humidity-control capability.
      {
        id: 'evt-campus-11',
        type: 'humidity-anomaly',
        zoneId: 'server-facility',
        location: { x: 50, y: 22.5 },
        payload: { humidity: 85, threshold: 70 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['humidity-control'],
        propagationAwareness: {
          sourceZoneId: 'server-facility',
          affectedZoneIds: ['warehouse'],
          reason:
            'server-facility is adjacent to warehouse; ' +
            'high humidity could damage warehouse stored goods',
        },
        expectedOutcome: {
          parameter: 'humidity',
          location: 'server-facility',
          targetValue: 45,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 12: Fire detected in lobby 鈥?security-agent has motion-detection
      // and lighting-control but NOT cooling. Must
      // collaborate with climate-coordinator who manages lobby's HVAC.
      {
        id: 'evt-campus-12',
        type: 'fire-detected',
        zoneId: 'lobby',
        location: { x: 50, y: 37.5 },
        payload: { temperature: 58, smoke: true, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'lobby',
          affectedZoneIds: ['cafeteria'],
          reason:
            'lobby is adjacent to cafeteria; fire heat and smoke may spread ' +
            'to the cafeteria through shared ventilation',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'lobby',
          targetValue: 24,
          tolerance: 5,
          shouldChange: true,
        },
      },
      // Event 13: Temperature anomaly in cafeteria 鈥?facility-monitor only has
      // monitoring capabilities (temperature-monitoring, humidity-monitoring),
      // no control. Must collaborate with climate-coordinator who has HVAC.
      {
        id: 'evt-campus-13',
        type: 'temperature-anomaly',
        zoneId: 'cafeteria',
        location: { x: 30, y: 37.5 },
        payload: { temperature: 39, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'cafeteria',
          affectedZoneIds: ['warehouse'],
          reason:
            'cafeteria is adjacent to warehouse; sustained heat could affect ' +
            'temperature-sensitive goods in storage',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'cafeteria',
          targetValue: 24,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // --- New events (P23) ---
      // Event 14: Energy spike in parking lot 鈥?energy-agent detects abnormal
      // consumption from EV chargers, needs climate-coordinator to reduce HVAC
      // load in adjacent buildings to prevent overload.
      {
        id: 'evt-campus-14',
        type: 'energy-anomaly',
        zoneId: 'parking-lot',
        location: { x: -15, y: 10 },
        payload: { consumption: 45000, threshold: 30000, unit: 'watts' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'office-manager',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'energy',
          location: 'parking-lot',
          targetValue: 28000,
          tolerance: 5000,
          shouldChange: true,
        },
      },
      // Event 15: High CO2 in lecture hall 鈥?occupancy-agent detects poor air
      // quality but lacks HVAC control. Must collaborate with office-manager
      // who has cooling/heating in adjacent buildings.
      {
        id: 'evt-campus-15',
        type: 'co2-anomaly',
        zoneId: 'lecture-hall',
        location: { x: -17.5, y: 30 },
        payload: { co2: 1500, threshold: 1000 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'office-manager',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: {
          parameter: 'co2',
          location: 'lecture-hall',
          targetValue: 600,
          tolerance: 200,
          shouldChange: true,
        },
      },
      // Event 16: Smoke in dormitory 鈥?safety-agent detects smoke but has no
      // cooling/heating. Must collaborate with climate-coordinator
      // for ventilation, with propagation to library.
      {
        id: 'evt-campus-16',
        type: 'fire-detected',
        zoneId: 'dormitory',
        location: { x: 27.5, y: 52.5 },
        payload: { temperature: 48, smoke: true, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'dormitory',
          affectedZoneIds: ['library', 'cafeteria'],
          reason:
            'dormitory is adjacent to library and cafeteria; smoke could spread ' +
            'through shared ventilation shafts',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'dormitory',
          targetValue: 24,
          tolerance: 5,
          shouldChange: true,
        },
      },
      // Event 17: Intrusion in parking lot 鈥?safety-agent detects unauthorized
      // motion at night, needs security-agent for lobby monitoring.
      {
        id: 'evt-campus-17',
        type: 'intrusion-detected',
        zoneId: 'parking-lot',
        location: { x: -15, y: 10 },
        payload: { motion: true, timeOfDay: 'night', authorized: false },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['lighting-control', 'presence-detection'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-agent',
        correctPartnerCapabilities: ['lighting-control', 'presence-detection'],
        expectedOutcome: {
          parameter: 'security',
          location: 'parking-lot',
          shouldChange: true,
        },
      },
      // Event 18: Garden soil moisture low 鈥?maintenance-agent detects dry soil
        // but this is a scheduled irrigation event, handle independently.
      {
        id: 'evt-campus-18',
        type: 'soil-moisture-low',
        zoneId: 'garden',
        location: { x: -10, y: 37.5 },
        payload: { moisture: 25, threshold: 40 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['irrigation-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'moisture',
          location: 'garden',
          targetValue: 55,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 19: Sports field noise exceeding limits 鈥?maintenance-agent detects
      // noise but cannot control it. This is informational, should be ignored.
      {
        id: 'evt-campus-19',
        type: 'noise-anomaly',
        zoneId: 'sports-field',
        location: { x: 75, y: 12.5 },
        payload: { noise: 85, threshold: 70, unit: 'dB' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'noise',
          location: 'sports-field',
          shouldChange: false,
        },
      },
      // Event 20: Lecture hall over-occupied 鈥?occupancy-agent detects crowd
      // exceeding capacity, needs safety-agent for emergency access control.
      {
        id: 'evt-campus-20',
        type: 'occupancy-exceeded',
        zoneId: 'lecture-hall',
        location: { x: -17.5, y: 30 },
        payload: { occupancy: 350, capacity: 300 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['access-control', 'lock-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['access-control', 'lock-control'],
        expectedOutcome: {
          parameter: 'occupancy',
          location: 'lecture-hall',
          targetValue: 280,
          tolerance: 30,
          shouldChange: true,
        },
      },
      // Event 21: Gym temperature anomaly 鈥?energy-agent detects high energy
      // from HVAC overuse, needs office-manager for cross-building HVAC coordination.
      {
        id: 'evt-campus-21',
        type: 'temperature-anomaly',
        zoneId: 'gym',
        location: { x: 70, y: 35 },
        payload: { temperature: 35, threshold: 30 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'office-manager',
        correctPartnerCapabilities: ['cooling'],
        propagationAwareness: {
          sourceZoneId: 'gym',
          affectedZoneIds: ['server-facility'],
          reason:
            'gym is adjacent to server-facility; increased HVAC load could ' +
            'affect server cooling capacity',
        },
        expectedOutcome: {
          parameter: 'temperature',
          location: 'gym',
          targetValue: 22,
          tolerance: 3,
          shouldChange: true,
        },
      },
      // Event 22: Library humidity threatens book collection 鈥?maintenance-agent
      // detects high humidity but lacks humidity-control. Must collaborate with
      // climate-coordinator who has humidity-control.
      {
        id: 'evt-campus-22',
        type: 'humidity-anomaly',
        zoneId: 'library',
        location: { x: 5, y: 52.5 },
        payload: { humidity: 72, threshold: 60 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['humidity-control'],
        propagationAwareness: {
          sourceZoneId: 'library',
          affectedZoneIds: ['dormitory'],
          reason:
            'library is adjacent to dormitory; high humidity indicates ' +
            'regional moisture issue that may affect dormitory',
        },
        expectedOutcome: {
          parameter: 'humidity',
          location: 'library',
          targetValue: 45,
          tolerance: 10,
          shouldChange: true,
        },
      },
      // Event 23: Dormitory energy consumption spike 鈥?energy-agent detects
      // abnormal usage, needs safety-agent to check for electrical hazard.
      {
        id: 'evt-campus-23',
        type: 'energy-anomaly',
        zoneId: 'dormitory',
        location: { x: 27.5, y: 52.5 },
        payload: { consumption: 28000, threshold: 15000, unit: 'watts' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['fire-detection', 'emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['fire-detection', 'emergency-alert'],
        expectedOutcome: {
          parameter: 'energy',
          location: 'dormitory',
          targetValue: 12000,
          tolerance: 3000,
          shouldChange: true,
        },
      },
      // Event 24: Scheduled maintenance for garden 鈥?maintenance-agent handles
      // the sprinkler system check independently.
      {
        id: 'evt-campus-24',
        type: 'scheduled-maintenance',
        zoneId: 'garden',
        location: { x: -10, y: 37.5 },
        payload: { task: 'sprinkler-check', schedule: 'weekly' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['maintenance-scheduling'],
        correctDecision: 'handle_independently',
        expectedOutcome: {
          parameter: 'maintenance',
          location: 'garden',
          shouldChange: true,
        },
      },
      // Event 25: Normal temperature in dormitory 鈥?should be ignored.
      {
        id: 'evt-campus-25',
        type: 'temperature-normal',
        zoneId: 'dormitory',
        location: { x: 27.5, y: 52.5 },
        payload: { temperature: 22 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: {
          parameter: 'temperature',
          location: 'dormitory',
          shouldChange: false,
        },
      },
      // Event 26: Parking lot motion detected at night - security-agent activates lights
      {
        id: 'evt-campus-light-1',
        type: 'motion-detected',
        zoneId: 'parking-lot',
        location: { x: -15, y: 10 },
        payload: { motion: true, timeOfDay: 'night', illuminance: 5, threshold: 50 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-agent',
        correctPartnerCapabilities: ['lighting-control'],
        expectedOutcome: {
          parameter: 'illuminance',
          location: 'parking-lot',
          targetValue: 100,
          tolerance: 30,
          shouldChange: true,
        },
      },
      // Event 27: Poor air quality in cafeteria - facility-monitor detects, needs occupancy-agent ventilation
      {
        id: 'evt-campus-air-1',
        type: 'air-quality-anomaly',
        zoneId: 'cafeteria',
        location: { x: 30, y: 37.5 },
        payload: { pm25: 80, voc: 350, threshold: { pm25: 50, voc: 200 } },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'occupancy-agent',
        correctPartnerCapabilities: ['ventilation-control'],
        expectedOutcome: {
          parameter: 'pm25',
          location: 'cafeteria',
          targetValue: 30,
          tolerance: 20,
          shouldChange: true,
        },
      },
      // Event 28: Fire alarm in dormitory - safety-agent triggers emergency broadcast via speakers
      {
        id: 'evt-campus-emergency-1',
        type: 'fire-detected',
        zoneId: 'dormitory',
        location: { x: 25, y: 50 },
        payload: { smoke: true, temperature: 55, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['emergency-alert'],
        propagationAwareness: {
          sourceZoneId: 'dormitory',
          affectedZoneIds: ['library', 'cafeteria'],
          reason: 'Dormitory fire may spread to adjacent library and cafeteria',
        },
        expectedOutcome: {
          parameter: 'alert',
          location: 'dormitory',
          shouldChange: true,
        },
      },
      // Event 29: Low humidity in lecture hall during winter - needs climate-coordinator humidity-control
      {
        id: 'evt-campus-humidity-1',
        type: 'humidity-anomaly',
        zoneId: 'lecture-hall',
        location: { x: -20, y: 30 },
        payload: { humidity: 20, threshold: 30, direction: 'low' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-coordinator',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'lecture-hall',
          targetValue: 45,
          tolerance: 10,
          shouldChange: true,
        },
      },
    ],
  },


  // Scenario 4: factory
  // A smart factory with 15 zones, 8 agents, covering production lines,
  // warehouses, quality control, and safety systems.
  // ---------------------------------------------------------------------------
  'factory': {
    id: 'factory',
    type: 'factory',
    name: 'Smart Factory',
    description:
      'A smart factory with 15 zones including three production lines, two warehouses, ' +
      'a quality-control lab, server room, assembly area, painting booth, welding bay, ' +
      'chemical storage, loading dock, break room, and control room. Managed by eight ' +
      'specialized agents covering production, safety, quality, logistics, energy, and maintenance.',
    zones: factoryZones,
    devices: factoryDevices,
    agents: factoryAgents,
    events: [
      // Event 1: PL1 overheating 鈥?production-manager handles with HVAC
      {
        id: 'evt-factory-1',
        type: 'temperature-anomaly',
        zoneId: 'production-line-1',
        location: { x: 15, y: 10 },
        payload: { temperature: 42, threshold: 35 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'temperature', location: 'production-line-1', targetValue: 25, tolerance: 3, shouldChange: true },
      },
      // Event 2: Chemical leak 鈥?safety-agent detects, needs climate-agent ventilation
      {
        id: 'evt-factory-2',
        type: 'chemical-leak',
        zoneId: 'chemical-storage',
        location: { x: 10, y: 70 },
        payload: { chemical: 'solvent', concentration: 150, threshold: 50 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['ventilation-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['ventilation-control'],
        propagationAwareness: {
          sourceZoneId: 'chemical-storage',
          affectedZoneIds: ['warehouse-1', 'welding-bay'],
          reason: 'chemical-storage adjacent to warehouse-1 and welding-bay; fumes could spread',
        },
        expectedOutcome: { parameter: 'concentration', location: 'chemical-storage', targetValue: 0, tolerance: 10, shouldChange: true },
      },
      // Event 3: Server room overheating 鈥?maintenance-agent detects, has HVAC control
      {
        id: 'evt-factory-3',
        type: 'temperature-anomaly-critical',
        zoneId: 'server-room',
        location: { x: 52.5, y: 27.5 },
        payload: { temperature: 45, threshold: 30, critical: true },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        propagationAwareness: {
          sourceZoneId: 'server-room',
          affectedZoneIds: ['quality-lab', 'control-room'],
          reason: 'server-room adjacent to quality-lab and control-room; heat may propagate',
        },
        expectedOutcome: { parameter: 'temperature', location: 'server-room', targetValue: 20, tolerance: 2, shouldChange: true },
      },
      // Event 4: Painting VOC瓒呮爣 鈥?safety-agent detects gas, needs climate-agent ventilation
      {
        id: 'evt-factory-4',
        type: 'voc-anomaly',
        zoneId: 'painting-booth',
        location: { x: 70, y: 27.5 },
        payload: { voc: 200, threshold: 100 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['ventilation-control', 'air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['ventilation-control', 'air-purification'],
        expectedOutcome: { parameter: 'voc', location: 'painting-booth', targetValue: 50, tolerance: 30, shouldChange: true },
      },
      // Event 5: WH1 humidity threatens raw materials 鈥?logistics-agent detects, needs climate-agent humidity-control
      {
        id: 'evt-factory-5',
        type: 'humidity-anomaly',
        zoneId: 'warehouse-1',
        location: { x: 12.5, y: 30 },
        payload: { humidity: 80, threshold: 60 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['humidity-control'],
        propagationAwareness: {
          sourceZoneId: 'warehouse-1',
          affectedZoneIds: ['production-line-1'],
          reason: 'warehouse-1 adjacent to production-line-1; humidity could damage raw materials entering production',
        },
        expectedOutcome: { parameter: 'humidity', location: 'warehouse-1', targetValue: 45, tolerance: 10, shouldChange: true },
      },
      // Event 6: Assembly robot malfunction 鈥?production-manager detects vibration, handles independently
      {
        id: 'evt-factory-6',
        type: 'equipment-malfunction',
        zoneId: 'assembly-area',
        location: { x: 15, y: 50 },
        payload: { vibration: 8.5, threshold: 5.0, equipmentId: 'robot-arm-1' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['robot-control', 'equipment-monitoring'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'vibration', location: 'assembly-area', targetValue: 2, tolerance: 1, shouldChange: true },
      },
      // Event 7: PL2 normal temperature 鈥?ignore
      {
        id: 'evt-factory-7',
        type: 'temperature-normal',
        zoneId: 'production-line-2',
        location: { x: 45, y: 10 },
        payload: { temperature: 24 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: { parameter: 'temperature', location: 'production-line-2', shouldChange: false },
      },
      // Event 8: EV charger energy overload 鈥?energy-agent detects, needs production-manager to reduce PL load
      {
        id: 'evt-factory-8',
        type: 'energy-anomaly',
        zoneId: 'ev-charging',
        location: { x: 77.5, y: 57.5 },
        payload: { consumption: 85000, threshold: 50000, unit: 'watts' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['equipment-monitoring'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'production-manager',
        correctPartnerCapabilities: ['equipment-monitoring'],
        expectedOutcome: { parameter: 'energy', location: 'ev-charging', targetValue: 45000, tolerance: 10000, shouldChange: true },
      },
      // Event 9: Welding fumes瓒呮爣 鈥?safety-agent detects, has ventilation control
      {
        id: 'evt-factory-9',
        type: 'fume-anomaly',
        zoneId: 'welding-bay',
        location: { x: 35, y: 50 },
        payload: { particulateMatter: 150, threshold: 50 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['ventilation-control'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'particulateMatter', location: 'welding-bay', targetValue: 30, tolerance: 15, shouldChange: true },
      },
      // Event 10: Quality lab temperature affects calibration 鈥?quality-agent detects but lacks HVAC
      {
        id: 'evt-factory-10',
        type: 'temperature-anomaly',
        zoneId: 'quality-lab',
        location: { x: 35, y: 27.5 },
        payload: { temperature: 30, threshold: 25 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'maintenance-agent',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: { parameter: 'temperature', location: 'quality-lab', targetValue: 22, tolerance: 2, shouldChange: true },
      },
      // Event 11: Server room smoke 鈥?maintenance-agent detects, needs safety-agent emergency-alert
      {
        id: 'evt-factory-11',
        type: 'fire-detected',
        zoneId: 'server-room',
        location: { x: 52.5, y: 27.5 },
        payload: { temperature: 55, smoke: true, threshold: 30 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert', 'fire-detection'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['emergency-alert', 'fire-detection'],
        propagationAwareness: {
          sourceZoneId: 'server-room',
          affectedZoneIds: ['quality-lab', 'control-room'],
          reason: 'server-room adjacent to quality-lab and control-room; fire could spread through cable ducts',
        },
        expectedOutcome: { parameter: 'temperature', location: 'server-room', targetValue: 20, tolerance: 5, shouldChange: true },
      },
      // Event 12: Loading dock motion at night 鈥?logistics-agent detects, needs security-agent
      {
        id: 'evt-factory-12',
        type: 'intrusion-detected',
        zoneId: 'loading-dock',
        location: { x: 45, y: 45 },
        payload: { motion: true, timeOfDay: 'night', authorized: false },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['access-control', 'lighting-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-agent',
        correctPartnerCapabilities: ['access-control', 'lighting-control'],
        expectedOutcome: { parameter: 'security', location: 'loading-dock', shouldChange: true },
      },
      // Event 13: WH2 normal temperature 鈥?ignore
      {
        id: 'evt-factory-13',
        type: 'temperature-normal',
        zoneId: 'warehouse-2',
        location: { x: 77.5, y: 30 },
        payload: { temperature: 20 },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: { parameter: 'temperature', location: 'warehouse-2', shouldChange: false },
      },
      // Event 14: PL3 vibration anomaly 鈥?production-manager handles
      {
        id: 'evt-factory-14',
        type: 'equipment-malfunction',
        zoneId: 'production-line-3',
        location: { x: 75, y: 10 },
        payload: { vibration: 7.2, threshold: 5.0, equipmentId: 'conveyor-3' },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['equipment-monitoring', 'vibration-monitoring'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'vibration', location: 'production-line-3', targetValue: 2, tolerance: 1.5, shouldChange: true },
      },
      // Event 15: PL2 energy spike 鈥?production-manager detects, needs energy-agent analysis
      {
        id: 'evt-factory-15',
        type: 'energy-anomaly',
        zoneId: 'production-line-2',
        location: { x: 45, y: 10 },
        payload: { consumption: 120000, threshold: 80000, unit: 'watts' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['energy-monitoring', 'load-balancing'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'energy-agent',
        correctPartnerCapabilities: ['energy-monitoring', 'load-balancing'],
        expectedOutcome: { parameter: 'energy', location: 'production-line-2', targetValue: 75000, tolerance: 10000, shouldChange: true },
      },
      // Event 16: Chemical storage humidity 鈥?safety-agent handles independently
      {
        id: 'evt-factory-16',
        type: 'humidity-anomaly',
        zoneId: 'chemical-storage',
        location: { x: 10, y: 70 },
        payload: { humidity: 65, threshold: 55 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['chemical-monitoring'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'humidity', location: 'chemical-storage', shouldChange: true },
      },
      // Event 17: Control room temperature 鈥?maintenance-agent handles
      {
        id: 'evt-factory-17',
        type: 'temperature-anomaly',
        zoneId: 'control-room',
        location: { x: 55, y: 57.5 },
        payload: { temperature: 28, threshold: 25 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['cooling'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'temperature', location: 'control-room', targetValue: 22, tolerance: 2, shouldChange: true },
      },
      // Event 18: Break room CO2 鈥?energy-agent detects but has no ventilation, needs climate-agent
      {
        id: 'evt-factory-18',
        type: 'co2-anomaly',
        zoneId: 'break-room',
        location: { x: 82.5, y: 45 },
        payload: { co2: 1200, threshold: 1000 },
        severity: 'medium',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['ventilation-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['ventilation-control'],
        expectedOutcome: { parameter: 'co2', location: 'break-room', targetValue: 600, tolerance: 200, shouldChange: true },
      },
      // Event 19: Scheduled maintenance for PL1 鈥?production-manager handles
      {
        id: 'evt-factory-19',
        type: 'scheduled-maintenance',
        zoneId: 'production-line-1',
        location: { x: 15, y: 10 },
        payload: { task: 'bearing-replacement', schedule: 'quarterly' },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: ['maintenance-scheduling'],
        correctDecision: 'handle_independently',
        expectedOutcome: { parameter: 'maintenance', location: 'production-line-1', shouldChange: true },
      },
      // Event 20: PL1 fire 鈥?production-manager detects heat, needs safety-agent for fire suppression
      {
        id: 'evt-factory-20',
        type: 'fire-detected',
        zoneId: 'production-line-1',
        location: { x: 15, y: 10 },
        payload: { temperature: 65, smoke: true, threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert', 'fire-detection', 'smoke-detection'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['emergency-alert', 'fire-detection', 'smoke-detection'],
        propagationAwareness: {
          sourceZoneId: 'production-line-1',
          affectedZoneIds: ['warehouse-1', 'assembly-area'],
          reason: 'production-line-1 adjacent to warehouse-1 and assembly-area; fire could spread rapidly',
        },
        expectedOutcome: { parameter: 'temperature', location: 'production-line-1', targetValue: 25, tolerance: 5, shouldChange: true },
      },
      // Event 21: Painting booth temperature 鈥?safety-agent detects but has no HVAC, needs production-manager
      {
        id: 'evt-factory-21',
        type: 'temperature-anomaly',
        zoneId: 'painting-booth',
        location: { x: 70, y: 27.5 },
        payload: { temperature: 38, threshold: 30 },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['cooling'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['cooling'],
        expectedOutcome: { parameter: 'temperature', location: 'painting-booth', targetValue: 22, tolerance: 3, shouldChange: true },
      },
      // Event 22: WH1 normal motion (daytime) 鈥?ignore
      {
        id: 'evt-factory-22',
        type: 'presence-detected',
        zoneId: 'warehouse-1',
        location: { x: 5, y: 25 },
        payload: { motion: true, timeOfDay: 'daytime', authorized: true },
        severity: 'low',
        eventCategory: 'device-originated',
        requiresCollaboration: false,
        requiredCapabilities: [],
        correctDecision: 'ignore',
        expectedOutcome: { parameter: 'motion', location: 'warehouse-1', shouldChange: false },
      },
      // Event 23: Warehouse-1 motion at night - logistics-agent detects, needs security-agent lighting
      {
        id: 'evt-factory-light-1',
        type: 'motion-detected',
        zoneId: 'warehouse-1',
        location: { x: 12, y: 30 },
        payload: { motion: true, timeOfDay: 'night', illuminance: 2, authorized: false },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['lighting-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'security-agent',
        correctPartnerCapabilities: ['lighting-control'],
        expectedOutcome: {
          parameter: 'illuminance',
          location: 'warehouse-1',
          targetValue: 150,
          tolerance: 50,
          shouldChange: true,
        },
      },
      // Event 24: Painting booth VOC spike - safety-agent detects fumes, needs maintenance-agent air-purification
      {
        id: 'evt-factory-air-1',
        type: 'air-quality-anomaly',
        zoneId: 'painting-booth',
        location: { x: 70, y: 27.5 },
        payload: { pm25: 120, voc: 600, threshold: { pm25: 50, voc: 200 } },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['air-purification'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'maintenance-agent',
        correctPartnerCapabilities: ['air-purification'],
        expectedOutcome: {
          parameter: 'pm25',
          location: 'painting-booth',
          targetValue: 35,
          tolerance: 15,
          shouldChange: true,
        },
      },
      // Event 25: Chemical storage fire alarm - safety-agent triggers emergency broadcast
      {
        id: 'evt-factory-emergency-1',
        type: 'fire-detected',
        zoneId: 'chemical-storage',
        location: { x: 10, y: 70 },
        payload: { smoke: true, temperature: 65, chemical: 'solvent-vapor', threshold: 35 },
        severity: 'critical',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['emergency-alert'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'safety-agent',
        correctPartnerCapabilities: ['emergency-alert'],
        propagationAwareness: {
          sourceZoneId: 'chemical-storage',
          affectedZoneIds: ['warehouse-1', 'welding-bay'],
          reason: 'Chemical storage fire may spread to adjacent warehouse-1 and welding-bay',
        },
        expectedOutcome: {
          parameter: 'alert',
          location: 'chemical-storage',
          shouldChange: true,
        },
      },
      // Event 26: Server room high humidity - maintenance-agent detects, needs climate-agent humidity-control
      {
        id: 'evt-factory-humidity-1',
        type: 'humidity-anomaly',
        zoneId: 'server-room',
        location: { x: 52, y: 27.5 },
        payload: { humidity: 75, threshold: 55, direction: 'high' },
        severity: 'high',
        eventCategory: 'device-originated',
        requiresCollaboration: true,
        requiredCapabilities: ['humidity-control'],
        correctDecision: 'initiate_ac',
        correctPartnerId: 'climate-agent',
        correctPartnerCapabilities: ['humidity-control'],
        expectedOutcome: {
          parameter: 'humidity',
          location: 'server-room',
          targetValue: 45,
          tolerance: 10,
          shouldChange: true,
        },
      },
    ],
  },


  // Scenario 5: hospital
  // A smart hospital with 20 zones, 10 agents, covering patient rooms,
  // ICUs, operating rooms, pharmacy, labs, and utility systems.
  // ---------------------------------------------------------------------------
  'hospital': {
    id: 'hospital',
    type: 'hospital',
    name: 'Smart Hospital',
    description:
      'A smart hospital with 20 zones including four patient rooms, two ICUs, two operating rooms, ' +
      'a pharmacy, laboratory, radiology, emergency department, reception, waiting area, cafeteria, ' +
      'server room, utility room, parking, and a helipad. Managed by ten specialized agents covering ' +
      'patient care, safety, facility management, energy, security, and medical equipment.',
    zones: hospitalZones,
    devices: hospitalDevices,
    agents: hospitalAgents,
    events: [
      // Event 1: PR1 overheating 鈥?patient-care-agent handles
      { id: 'evt-hosp-1', type: 'temperature-anomaly', zoneId: 'patient-room-1', location: { x: 3, y: 2.5 }, payload: { temperature: 30, threshold: 26 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['cooling'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'temperature', location: 'patient-room-1', targetValue: 22, tolerance: 2, shouldChange: true } },
      // Event 2: ICU1 oxygen drop 鈥?icu-agent detects, needs safety-agent emergency-alert
      { id: 'evt-hosp-2', type: 'oxygen-anomaly', zoneId: 'icu-1', location: { x: 6, y: 12 }, payload: { oxygenLevel: 18, threshold: 20 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert'], correctDecision: 'initiate_ac', correctPartnerId: 'safety-agent', correctPartnerCapabilities: ['emergency-alert'], expectedOutcome: { parameter: 'oxygen', location: 'icu-1', targetValue: 21, tolerance: 1, shouldChange: true } },
      // Event 3: OR1 humidity too high 鈥?or-agent detects but needs facility-agent humidity-control
      { id: 'evt-hosp-3', type: 'humidity-anomaly', zoneId: 'operating-room-1', location: { x: 5, y: 20 }, payload: { humidity: 70, threshold: 55 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['humidity-control'], correctDecision: 'initiate_ac', correctPartnerId: 'facility-agent', correctPartnerCapabilities: ['humidity-control'], expectedOutcome: { parameter: 'humidity', location: 'operating-room-1', targetValue: 45, tolerance: 5, shouldChange: true } },
      // Event 4: Pharmacy temperature spike 鈥?pharmacy-agent detects but lacks HVAC, needs lab-agent
      { id: 'evt-hosp-4', type: 'temperature-anomaly', zoneId: 'pharmacy', location: { x: 28, y: 13 }, payload: { temperature: 28, threshold: 22 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'lab-agent', correctPartnerCapabilities: ['cooling'], propagationAwareness: { sourceZoneId: 'pharmacy', affectedZoneIds: ['operating-room-2', 'laboratory'], reason: 'pharmacy adjacent to OR2 and laboratory; temperature-sensitive medications at risk' }, expectedOutcome: { parameter: 'temperature', location: 'pharmacy', targetValue: 20, tolerance: 2, shouldChange: true } },
      // Event 5: Server room fire 鈥?safety-agent detects, needs security-agent to evacuate
      { id: 'evt-hosp-5', type: 'fire-detected', zoneId: 'server-room', location: { x: 14, y: 27 }, payload: { temperature: 55, smoke: true, threshold: 35 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert'], correctDecision: 'initiate_ac', correctPartnerId: 'safety-agent', correctPartnerCapabilities: ['emergency-alert'], propagationAwareness: { sourceZoneId: 'server-room', affectedZoneIds: ['operating-room-1', 'utility-room'], reason: 'server-room adjacent to OR1 and utility-room; fire could spread through HVAC ducts' }, expectedOutcome: { parameter: 'temperature', location: 'server-room', targetValue: 20, tolerance: 5, shouldChange: true } },
      // Event 6: Waiting area CO2 high 鈥?air-quality-agent detects but needs facility-agent HVAC
      { id: 'evt-hosp-6', type: 'co2-anomaly', zoneId: 'waiting-area', location: { x: 49, y: 3 }, payload: { co2: 1500, threshold: 1000 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'facility-agent', correctPartnerCapabilities: ['cooling'], expectedOutcome: { parameter: 'co2', location: 'waiting-area', targetValue: 600, tolerance: 200, shouldChange: true } },
      // Event 7: ED normal temperature 鈥?ignore
      { id: 'evt-hosp-7', type: 'temperature-normal', zoneId: 'emergency-dept', location: { x: 38, y: 11 }, payload: { temperature: 22 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'temperature', location: 'emergency-dept', shouldChange: false } },
      // Event 8: ICU2 temperature critical 鈥?icu-agent handles independently
      { id: 'evt-hosp-8', type: 'temperature-anomaly-critical', zoneId: 'icu-2', location: { x: 18, y: 12 }, payload: { temperature: 30, threshold: 24, critical: true }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['cooling'], correctDecision: 'handle_independently', propagationAwareness: { sourceZoneId: 'icu-2', affectedZoneIds: ['icu-1', 'operating-room-2'], reason: 'ICU2 adjacent to ICU1 and OR2; critical temperature could affect sterile environments' }, expectedOutcome: { parameter: 'temperature', location: 'icu-2', targetValue: 20, tolerance: 2, shouldChange: true } },
      // Event 9: Cafeteria smoke 鈥?safety-agent handles independently
      { id: 'evt-hosp-9', type: 'smoke-detected', zoneId: 'cafeteria', location: { x: 49, y: 10 }, payload: { smoke: true, temperature: 38 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['smoke-detection', 'fire-detection'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'smoke', location: 'cafeteria', shouldChange: true } },
      // Event 10: Utility room water leak 鈥?safety-agent detects, needs energy-agent for power safety
      { id: 'evt-hosp-10', type: 'water-leak', zoneId: 'utility-room', location: { x: 5, y: 27 }, payload: { leakDetected: true, severity: 'moderate' }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['power-monitoring', 'energy-monitoring'], correctDecision: 'initiate_ac', correctPartnerId: 'energy-agent', correctPartnerCapabilities: ['power-monitoring', 'energy-monitoring'], expectedOutcome: { parameter: 'water', location: 'utility-room', shouldChange: true } },
      // Event 11: Parking energy overload 鈥?energy-agent detects, needs safety-agent for fire risk
      { id: 'evt-hosp-11', type: 'energy-anomaly', zoneId: 'parking', location: { x: 51, y: 19 }, payload: { consumption: 120000, threshold: 60000, unit: 'watts' }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['fire-detection', 'emergency-alert'], correctDecision: 'initiate_ac', correctPartnerId: 'safety-agent', correctPartnerCapabilities: ['fire-detection', 'emergency-alert'], expectedOutcome: { parameter: 'energy', location: 'parking', targetValue: 55000, tolerance: 10000, shouldChange: true } },
      // Event 12: OR2 normal temperature 鈥?ignore
      { id: 'evt-hosp-12', type: 'temperature-normal', zoneId: 'operating-room-2', location: { x: 19, y: 20 }, payload: { temperature: 20 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'temperature', location: 'operating-room-2', shouldChange: false } },
      // Event 13: PR2 humidity anomaly 鈥?patient-care-agent handles
      { id: 'evt-hosp-13', type: 'humidity-anomaly', zoneId: 'patient-room-2', location: { x: 9, y: 2.5 }, payload: { humidity: 70, threshold: 60 }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['humidity-monitoring'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'humidity', location: 'patient-room-2', shouldChange: true } },
      // Event 14: Radiology energy spike 鈥?lab-agent detects, needs energy-agent analysis
      { id: 'evt-hosp-14', type: 'energy-anomaly', zoneId: 'radiology', location: { x: 37, y: 20 }, payload: { consumption: 85000, threshold: 50000, unit: 'watts' }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['energy-monitoring', 'load-balancing'], correctDecision: 'initiate_ac', correctPartnerId: 'energy-agent', correctPartnerCapabilities: ['energy-monitoring', 'load-balancing'], expectedOutcome: { parameter: 'energy', location: 'radiology', targetValue: 45000, tolerance: 10000, shouldChange: true } },
      // Event 15: ICU1 humidity rise 鈥?icu-agent detects, needs facility-agent humidity-control
      { id: 'evt-hosp-15', type: 'humidity-anomaly', zoneId: 'icu-1', location: { x: 6, y: 12 }, payload: { humidity: 75, threshold: 60 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['humidity-control'], correctDecision: 'initiate_ac', correctPartnerId: 'facility-agent', correctPartnerCapabilities: ['humidity-control'], expectedOutcome: { parameter: 'humidity', location: 'icu-1', targetValue: 45, tolerance: 10, shouldChange: true } },
      // Event 16: Lab temperature 鈥?lab-agent handles
      { id: 'evt-hosp-16', type: 'temperature-anomaly', zoneId: 'laboratory', location: { x: 28, y: 20 }, payload: { temperature: 28, threshold: 24 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['cooling'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'temperature', location: 'laboratory', targetValue: 20, tolerance: 2, shouldChange: true } },
      // Event 17: Pharmacy unauthorized access 鈥?pharmacy-agent detects, needs security-agent
      { id: 'evt-hosp-17', type: 'intrusion-detected', zoneId: 'pharmacy', location: { x: 24, y: 13 }, payload: { motion: true, timeOfDay: 'night', authorized: false }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['access-control', 'lighting-control'], correctDecision: 'initiate_ac', correctPartnerId: 'security-agent', correctPartnerCapabilities: ['access-control', 'lighting-control'], expectedOutcome: { parameter: 'security', location: 'pharmacy', shouldChange: true } },
      // Event 18: Nurse station normal temperature 鈥?ignore
      { id: 'evt-hosp-18', type: 'temperature-normal', zoneId: 'nurse-station', location: { x: 28, y: 7.5 }, payload: { temperature: 22 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'temperature', location: 'nurse-station', shouldChange: false } },
      // Event 19: PR4 CO2 high 鈥?air-quality-agent detects, needs patient-care-agent HVAC
      { id: 'evt-hosp-19', type: 'co2-anomaly', zoneId: 'patient-room-4', location: { x: 21, y: 2.5 }, payload: { co2: 1300, threshold: 1000 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'patient-care-agent', correctPartnerCapabilities: ['cooling'], expectedOutcome: { parameter: 'co2', location: 'patient-room-4', targetValue: 600, tolerance: 200, shouldChange: true } },
      // Event 20: ED fire detected 鈥?security-agent detects, needs safety-agent
      { id: 'evt-hosp-20', type: 'fire-detected', zoneId: 'emergency-dept', location: { x: 38, y: 11 }, payload: { temperature: 60, smoke: true, threshold: 35 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'fire-detection'], correctDecision: 'initiate_ac', correctPartnerId: 'safety-agent', correctPartnerCapabilities: ['emergency-alert', 'fire-detection'], propagationAwareness: { sourceZoneId: 'emergency-dept', affectedZoneIds: ['radiology', 'reception'], reason: 'ED adjacent to radiology and reception; fire in ED blocks emergency access' }, expectedOutcome: { parameter: 'temperature', location: 'emergency-dept', targetValue: 22, tolerance: 5, shouldChange: true } },
      // Event 21: Waiting area over-occupied 鈥?security-agent detects, needs air-quality-agent ventilation
      { id: 'evt-hosp-21', type: 'occupancy-exceeded', zoneId: 'waiting-area', location: { x: 49, y: 3 }, payload: { occupancy: 80, capacity: 50 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['ventilation-control', 'air-filtration'], correctDecision: 'initiate_ac', correctPartnerId: 'air-quality-agent', correctPartnerCapabilities: ['ventilation-control', 'air-filtration'], expectedOutcome: { parameter: 'occupancy', location: 'waiting-area', targetValue: 45, tolerance: 10, shouldChange: true } },
      // Event 22: PR3 temperature 鈥?patient-care-agent handles
      { id: 'evt-hosp-22', type: 'temperature-anomaly', zoneId: 'patient-room-3', location: { x: 15, y: 2.5 }, payload: { temperature: 28, threshold: 26 }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['cooling'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'temperature', location: 'patient-room-3', targetValue: 22, tolerance: 2, shouldChange: true } },
      // Event 23: ICU2 oxygen drop 鈥?icu-agent handles independently (has oxygen-monitoring)
      { id: 'evt-hosp-23', type: 'oxygen-anomaly', zoneId: 'icu-2', location: { x: 18, y: 12 }, payload: { oxygenLevel: 19.5, threshold: 20 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['oxygen-monitoring', 'critical-care-monitoring'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'oxygen', location: 'icu-2', targetValue: 21, tolerance: 0.5, shouldChange: true } },
      // Event 24: Corridor motion (night) 鈥?security-agent handles
      { id: 'evt-hosp-24', type: 'presence-detected', zoneId: 'corridor-1', location: { x: 12, y: 6.5 }, payload: { motion: true, timeOfDay: 'night' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['lighting-control'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'light', location: 'corridor-1', shouldChange: true } },
      // Event 25: Reception normal motion 鈥?ignore
      { id: 'evt-hosp-25', type: 'presence-detected', zoneId: 'reception', location: { x: 38, y: 3 }, payload: { motion: true, timeOfDay: 'daytime', authorized: true }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'motion', location: 'reception', shouldChange: false } },
      // Event 26: Parking area motion at night - security-agent activates lights
      { id: 'evt-hosp-light-1', type: 'motion-detected', zoneId: 'parking', location: { x: 48, y: 19 }, payload: { motion: true, timeOfDay: 'night', illuminance: 3, authorized: false }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['lighting-control'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'illuminance', location: 'parking', targetValue: 80, tolerance: 20, shouldChange: true } },
      // Event 27: Waiting area poor air quality - security-agent detects, needs air-quality-agent ventilation
      { id: 'evt-hosp-air-1', type: 'air-quality-anomaly', zoneId: 'waiting-area', location: { x: 49, y: 3 }, payload: { pm25: 75, voc: 280, co2: 1200, threshold: { pm25: 50, voc: 200 } }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['ventilation-control', 'air-filtration'], correctDecision: 'initiate_ac', correctPartnerId: 'air-quality-agent', correctPartnerCapabilities: ['ventilation-control', 'air-filtration'], expectedOutcome: { parameter: 'pm25', location: 'waiting-area', targetValue: 25, tolerance: 15, shouldChange: true } },
      // Event 28: Server room fire alarm - safety-agent triggers emergency broadcast and evacuation alert
      { id: 'evt-hosp-emergency-1', type: 'fire-detected', zoneId: 'server-room', location: { x: 14, y: 27 }, payload: { smoke: true, temperature: 58, threshold: 40 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert'], correctDecision: 'initiate_ac', correctPartnerId: 'safety-agent', correctPartnerCapabilities: ['emergency-alert'], propagationAwareness: { sourceZoneId: 'server-room', affectedZoneIds: ['operating-room-1', 'utility-room'], reason: 'Server room fire adjacent to operating room 1 and utility room; smoke may affect surgical area' }, expectedOutcome: { parameter: 'alert', location: 'server-room', shouldChange: true } },
      // Event 29: Cafeteria high humidity - safety-agent detects, needs facility-agent humidity-control
      { id: 'evt-hosp-humidity-1', type: 'humidity-anomaly', zoneId: 'cafeteria', location: { x: 49, y: 10 }, payload: { humidity: 78, threshold: 60, direction: 'high' }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['humidity-control'], correctDecision: 'initiate_ac', correctPartnerId: 'facility-agent', correctPartnerCapabilities: ['humidity-control'], expectedOutcome: { parameter: 'humidity', location: 'cafeteria', targetValue: 50, tolerance: 10, shouldChange: true } },
    ],
  },


  // Scenario 6: smart-city
  // A smart city with 25 zones, 12 agents, covering residential, commercial,
  // industrial, medical, municipal, infrastructure, and transport districts.
  // Exercises city-scale collaboration: multi-domain cascading events,
  // cross-district propagation, and large-scale resource coordination.
  'smart-city': {
    id: 'smart-city',
    zones: smartCityZones,
    devices: smartCityDevices,
    agents: smartCityAgents,
    events: [
      // Event 1: City-wide heat wave 鈥?residential-manager detects, needs commercial-hvac for extra cooling (AC)
      { id: 'evt-sc-1', type: 'heat-wave', zoneId: 'residential-a', location: { x: 5, y: 5 }, payload: { temperature: 42, threshold: 35, duration: '48h' }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling', 'load-balancing'], correctDecision: 'initiate_ac', correctPartnerId: 'energy-grid', correctPartnerCapabilities: ['load-balancing', 'load-shedding'], propagationAwareness: { sourceZoneId: 'residential-a', affectedZoneIds: ['residential-b', 'residential-c', 'park'], reason: 'Heat wave affects entire residential district simultaneously' }, expectedOutcome: { parameter: 'temperature', location: 'residential-a', targetValue: 26, tolerance: 3, shouldChange: true } },
      // Event 2: Factory chemical spill 鈥?industrial-safety detects, needs emergency-services (AC, cascade)
      { id: 'evt-sc-2', type: 'chemical-spill', zoneId: 'factory-zone', location: { x: 8, y: 25 }, payload: { chemical: 'ammonia', concentration: 150, threshold: 25 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'dispatch', 'ventilation-control'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['emergency-alert', 'dispatch'], propagationAwareness: { sourceZoneId: 'factory-zone', affectedZoneIds: ['warehouse-district', 'park'], reason: 'Ammonia gas drifts toward warehouse and park areas' }, expectedOutcome: { parameter: 'concentration', location: 'factory-zone', targetValue: 10, tolerance: 10, shouldChange: true } },
      // Event 3: Power plant overload 鈥?energy-grid detects, needs transport-coordinator to reduce load (AC)
      { id: 'evt-sc-3', type: 'power-overload', zoneId: 'power-plant', location: { x: 35, y: 35 }, payload: { load: 98, capacity: 100, margin: 2 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['load-shedding', 'cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'commercial-hvac', correctPartnerCapabilities: ['cooling'], propagationAwareness: { sourceZoneId: 'power-plant', affectedZoneIds: ['data-center', 'main-station'], reason: 'Power overload threatens data center and station operations' }, expectedOutcome: { parameter: 'load', location: 'power-plant', targetValue: 85, tolerance: 5, shouldChange: true } },
      // Event 4: Water main break 鈥?water-management detects, needs transport-coordinator for road closure (AC, propagation)
      { id: 'evt-sc-4', type: 'water-main-break', zoneId: 'water-treatment', location: { x: 35, y: 45 }, payload: { flowRate: 500, normalRate: 50, pressure: 0.2 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['traffic-monitoring', 'pump-control'], correctDecision: 'initiate_ac', correctPartnerId: 'transport-coordinator', correctPartnerCapabilities: ['traffic-monitoring', 'speed-detection'], propagationAwareness: { sourceZoneId: 'water-treatment', affectedZoneIds: ['highway-junction', 'bus-depot'], reason: 'Flooding affects highway junction and bus depot access roads' }, expectedOutcome: { parameter: 'flowRate', location: 'water-treatment', targetValue: 60, tolerance: 20, shouldChange: true } },
      // Event 5: Hospital emergency surge 鈥?environmental-monitor detects, needs emergency-services (AC)
      { id: 'evt-sc-5', type: 'emergency-surge', zoneId: 'hospital-district', location: { x: 5, y: 35 }, payload: { patientInflux: 50, capacity: 30, triageLevel: 'mass-casualty' }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'dispatch'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['emergency-alert', 'dispatch'], expectedOutcome: { parameter: 'patientCount', location: 'hospital-district', targetValue: 30, tolerance: 5, shouldChange: true } },
      // Event 6: Air quality alert 鈥?environmental-monitor detects, needs industrial-safety to reduce emissions (AC)
      { id: 'evt-sc-6', type: 'air-quality-alert', zoneId: 'park', location: { x: 10, y: 15 }, payload: { pm25: 180, threshold: 50, aqi: 320 }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['ventilation-control', 'air-filtration'], correctDecision: 'initiate_ac', correctPartnerId: 'industrial-safety', correctPartnerCapabilities: ['ventilation-control', 'air-filtration'], propagationAwareness: { sourceZoneId: 'park', affectedZoneIds: ['residential-a', 'residential-b', 'factory-zone'], reason: 'Air pollution from factory zone drifts across residential and park areas' }, expectedOutcome: { parameter: 'pm25', location: 'park', targetValue: 40, tolerance: 15, shouldChange: true } },
      // Event 7: DC cooling failure 鈥?energy-grid detects, needs transport-coordinator (AC)
      { id: 'evt-sc-7', type: 'cooling-failure', zoneId: 'data-center', location: { x: 30, y: 35 }, payload: { temperature: 45, threshold: 30, serverStatus: 'critical' }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'commercial-hvac', correctPartnerCapabilities: ['cooling'], expectedOutcome: { parameter: 'temperature', location: 'data-center', targetValue: 22, tolerance: 5, shouldChange: true } },
      // Event 8: Parking garage fire 鈥?transport-coordinator detects, needs emergency-services (AC)
      { id: 'evt-sc-8', type: 'fire-detected', zoneId: 'parking-garage', location: { x: 45, y: 35 }, payload: { temperature: 70, smoke: true }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['fire-alert', 'dispatch'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['fire-alert', 'dispatch'], propagationAwareness: { sourceZoneId: 'parking-garage', affectedZoneIds: ['power-plant', 'airport-terminal'], reason: 'Parking garage fire threatens adjacent power plant and airport' }, expectedOutcome: { parameter: 'temperature', location: 'parking-garage', targetValue: 25, tolerance: 10, shouldChange: true } },
      // Event 9: Highway accident 鈥?transport-coordinator detects, needs emergency-services (AC)
      { id: 'evt-sc-9', type: 'traffic-accident', zoneId: 'highway-junction', location: { x: 45, y: 25 }, payload: { vehicles: 5, injuries: 3, lanesBlocked: 2 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'dispatch'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['emergency-alert', 'dispatch'], expectedOutcome: { parameter: 'lanesBlocked', location: 'highway-junction', targetValue: 0, tolerance: 0, shouldChange: true } },
      // Event 10: Office energy spike 鈥?commercial-hvac detects, needs energy-grid (AC)
      { id: 'evt-sc-10', type: 'energy-spike', zoneId: 'office-tower-a', location: { x: 30, y: 15 }, payload: { consumption: 450, normal: 200, duration: '30min' }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['power-monitoring', 'load-balancing'], correctDecision: 'initiate_ac', correctPartnerId: 'energy-grid', correctPartnerCapabilities: ['power-monitoring', 'load-balancing'], expectedOutcome: { parameter: 'consumption', location: 'office-tower-a', targetValue: 220, tolerance: 30, shouldChange: true } },
      // Event 11: Warehouse flood 鈥?industrial-safety detects, needs logistics-agent (AC)
      { id: 'evt-sc-11', type: 'water-leak', zoneId: 'warehouse-district', location: { x: 20, y: 25 }, payload: { waterLevel: 5, threshold: 1 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['gps-tracking', 'fleet-management'], correctDecision: 'initiate_ac', correctPartnerId: 'logistics-agent', correctPartnerCapabilities: ['gps-tracking', 'fleet-management'], expectedOutcome: { parameter: 'waterLevel', location: 'warehouse-district', targetValue: 0, tolerance: 0.5, shouldChange: true } },
      // Event 12: Airport security breach 鈥?transport-coordinator detects, needs security-network (AC)
      { id: 'evt-sc-12', type: 'security-breach', zoneId: 'airport-terminal', location: { x: 47, y: 45 }, payload: { unauthorizedAccess: true, zone: 'restricted' }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['access-control', 'alarm', 'video-surveillance'], correctDecision: 'initiate_ac', correctPartnerId: 'security-network', correctPartnerCapabilities: ['access-control', 'alarm'], expectedOutcome: { parameter: 'breach', location: 'airport-terminal', shouldChange: true } },
      // Event 13: Mall overcrowding 鈥?commercial-hvac detects, needs transport-coordinator for crowd control (AC)
      { id: 'evt-sc-13', type: 'occupancy-exceeded', zoneId: 'shopping-mall', location: { x: 20, y: 15 }, payload: { occupancy: 5000, capacity: 3000 }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['traffic-monitoring', 'cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'transport-coordinator', correctPartnerCapabilities: ['traffic-monitoring', 'slot-detection'], expectedOutcome: { parameter: 'occupancy', location: 'shopping-mall', targetValue: 2900, tolerance: 200, shouldChange: true } },
      // Event 14: Bank alarm 鈥?commercial-hvac detects, needs security-network (AC)
      { id: 'evt-sc-14', type: 'intrusion-detected', zoneId: 'bank', location: { x: 28, y: 25 }, payload: { vaultBreach: true, motionDetected: true }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['access-control', 'alarm', 'video-surveillance'], correctDecision: 'initiate_ac', correctPartnerId: 'security-network', correctPartnerCapabilities: ['access-control', 'alarm', 'video-surveillance'], expectedOutcome: { parameter: 'breach', location: 'bank', shouldChange: true } },
      // Event 15: City hall HVAC 鈥?municipal-services detects, needs commercial-hvac (AC)
      { id: 'evt-sc-15', type: 'temperature-anomaly', zoneId: 'city-hall', location: { x: 5, y: 45 }, payload: { temperature: 32, threshold: 26 }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['cooling'], correctDecision: 'initiate_ac', correctPartnerId: 'commercial-hvac', correctPartnerCapabilities: ['cooling'], expectedOutcome: { parameter: 'temperature', location: 'city-hall', targetValue: 22, tolerance: 2, shouldChange: true } },
      // Event 16: Bus depot 鈥?routine fleet check 鈥?transport-coordinator handles independently
      { id: 'evt-sc-16', type: 'fleet-status', zoneId: 'bus-depot', location: { x: 35, y: 45 }, payload: { buses: 40, operational: 38, maintenance: 2 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['fleet-management'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'fleet', location: 'bus-depot', shouldChange: false } },
      // Event 17: Park normal irrigation 鈥?residential-manager handles
      { id: 'evt-sc-17', type: 'irrigation-scheduled', zoneId: 'park', location: { x: 8, y: 18 }, payload: { moisture: 35, threshold: 40 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['irrigation-control'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'moisture', location: 'park', targetValue: 50, tolerance: 10, shouldChange: true } },
      // Event 18: Mild weather change 鈥?ignore
      { id: 'evt-sc-18', type: 'temperature-change', zoneId: 'residential-b', location: { x: 15, y: 5 }, payload: { temperature: 24, prevTemperature: 22, trend: 'warming' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'temperature', location: 'residential-b', shouldChange: false } },
      // Event 19: Normal traffic flow 鈥?ignore
      { id: 'evt-sc-19', type: 'traffic-status', zoneId: 'highway-junction', location: { x: 45, y: 25 }, payload: { flowRate: 1200, normal: 1500, congestion: 'low' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'flow', location: 'highway-junction', shouldChange: false } },
      // Event 20: Warehouse normal humidity 鈥?industrial-safety handles independently
      { id: 'evt-sc-20', type: 'humidity-normal', zoneId: 'warehouse-district', location: { x: 20, y: 28 }, payload: { humidity: 55, range: [30, 70] }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['humidity-reading'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'humidity', location: 'warehouse-district', shouldChange: false } },
      // Event 21: Normal factory noise 鈥?ignore
      { id: 'evt-sc-21', type: 'noise-normal', zoneId: 'factory-zone', location: { x: 5, y: 22 }, payload: { noiseLevel: 65, threshold: 85 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'noise', location: 'factory-zone', shouldChange: false } },
      // Event 22: Data center normal UPS 鈥?energy-grid handles independently
      { id: 'evt-sc-22', type: 'ups-status', zoneId: 'data-center', location: { x: 30, y: 35 }, payload: { batteryLevel: 95, status: 'normal' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['ups-monitoring'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'battery', location: 'data-center', shouldChange: false } },
      // Event 23: EC normal temperature 鈥?ignore
      { id: 'evt-sc-23', type: 'temperature-normal', zoneId: 'emergency-center', location: { x: 15, y: 35 }, payload: { temperature: 22, range: [18, 26] }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: [], correctDecision: 'ignore', expectedOutcome: { parameter: 'temperature', location: 'emergency-center', shouldChange: false } },
      // Event 24: Airport normal operations 鈥?transport-coordinator handles
      { id: 'evt-sc-24', type: 'operations-status', zoneId: 'airport-terminal', location: { x: 45, y: 45 }, payload: { flights: 120, delays: 3, onTime: true }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['occupancy-counting'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'operations', location: 'airport-terminal', shouldChange: false } },
      // Event 25: Generator maintenance scheduled 鈥?energy-grid handles independently
      { id: 'evt-sc-25', type: 'maintenance-scheduled', zoneId: 'power-plant', location: { x: 37, y: 38 }, payload: { generator: 'G3', nextMaintenance: '2025-06-01' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['generator-control'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'maintenance', location: 'power-plant', shouldChange: false } },
      // Event 26: Residential-B motion night 鈥?residential-manager handles
      { id: 'evt-sc-26', type: 'motion-detected', zoneId: 'residential-b', location: { x: 15, y: 5 }, payload: { motion: true, timeOfDay: 'night', authorized: false }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['motion-detection'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'alert', location: 'residential-b', shouldChange: true } },
      // Event 27: Water pH normal 鈥?water-management handles
      { id: 'evt-sc-27', type: 'water-quality', zoneId: 'water-treatment', location: { x: 35, y: 45 }, payload: { ph: 7.2, turbidity: 0.5, status: 'normal' }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['water-quality-monitoring'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'quality', location: 'water-treatment', shouldChange: false } },
      // Event 28: Police station camera routine 鈥?security-network handles
      { id: 'evt-sc-28', type: 'surveillance-routine', zoneId: 'police-station', location: { x: 25, y: 45 }, payload: { cameras: 12, active: 12, alerts: 0 }, severity: 'low', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['video-surveillance'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'surveillance', location: 'police-station', shouldChange: false } },
      // Event 29: Parking garage motion at night - transport-coordinator activates lighting
      { id: 'evt-sc-light-1', type: 'motion-detected', zoneId: 'parking-garage', location: { x: 45, y: 35 }, payload: { motion: true, timeOfDay: 'night', illuminance: 5, authorized: false }, severity: 'medium', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['lighting-control'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'illuminance', location: 'parking-garage', targetValue: 120, tolerance: 30, shouldChange: true } },
      // Event 30: Factory zone toxic fumes - industrial-safety detects, needs emergency-services evacuation alert
      { id: 'evt-sc-air-1', type: 'air-quality-anomaly', zoneId: 'factory-zone', location: { x: 8, y: 25 }, payload: { pm25: 200, voc: 800, toxicGas: 'benzene', threshold: { pm25: 50, voc: 200 } }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'air-filtration'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['emergency-alert', 'dispatch'], propagationAwareness: { sourceZoneId: 'factory-zone', affectedZoneIds: ['warehouse-district', 'park', 'hospital-district'], reason: 'Toxic fumes from factory drift toward warehouse, park, and hospital district' }, expectedOutcome: { parameter: 'pm25', location: 'factory-zone', targetValue: 40, tolerance: 15, shouldChange: true } },
      // Event 31: Fire station receives alarm from warehouse - emergency-services dispatches and triggers city-wide alert
      { id: 'evt-sc-emergency-1', type: 'fire-detected', zoneId: 'warehouse-district', location: { x: 20, y: 25 }, payload: { smoke: true, temperature: 72, fireSpread: 'rapid' }, severity: 'critical', eventCategory: 'device-originated', requiresCollaboration: true, requiredCapabilities: ['emergency-alert', 'dispatch'], correctDecision: 'initiate_ac', correctPartnerId: 'emergency-services', correctPartnerCapabilities: ['emergency-alert', 'dispatch'], propagationAwareness: { sourceZoneId: 'warehouse-district', affectedZoneIds: ['factory-zone', 'logistics-hub', 'bank'], reason: 'Warehouse fire spreads to factory zone and logistics hub; smoke affects bank district' }, expectedOutcome: { parameter: 'alert', location: 'warehouse-district', shouldChange: true } },
      // Event 32: Residential block high humidity after storm - residential-manager detects, needs municipal-services
      { id: 'evt-sc-humidity-1', type: 'humidity-anomaly', zoneId: 'residential-a', location: { x: 5, y: 5 }, payload: { humidity: 88, threshold: 65, direction: 'high', cause: 'storm-flooding' }, severity: 'high', eventCategory: 'device-originated', requiresCollaboration: false, requiredCapabilities: ['motion-detection', 'occupancy-counting'], correctDecision: 'handle_independently', expectedOutcome: { parameter: 'humidity', location: 'residential-a', shouldChange: true } },
    ],
  },
};
