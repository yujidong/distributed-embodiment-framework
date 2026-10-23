/**
 * AC Auto-Trigger Monitor
 *
 * Monitors environment and device states to automatically trigger Active Collaborations
 * when predefined conditions are met.
 *
 * Key Features:
 * 1. Continuous monitoring of environment parameters
 * 2. Device state change detection
 * 3. Automatic AC creation when triggers are met
 * 4. Integration with EnvironmentCenter event system
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { PhysicalParameter } from '@active-collaboration/shared';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { EventManager } from '../events/EventManager.js';
import { ACExecutor, type ACCollaborationConfig, type ACCollaborationGoal, type ACCSuccessCriterion, type ACExecutionResult } from '../execution/ACExecutor.js';
import { CollaborationManager } from '../management/CollaborationManager.js';
import { MessageType, MessagePriority } from '../management/index.js';
import type { Device } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * AC Trigger Condition
 */
const logger = createLogger('ACTriggerMonitor');

export interface ACTriggerCondition {
  id: string;
  name: string;
  description: string;

  // Condition type
  conditionType: 'environment-parameter' | 'device-state';

  // For environment-parameter triggers
  triggerParameter?: string;  // e.g., 'pm25', 'temperature'
  triggerOperator?: '>' | '<' | '>=' | '<=' | '==' | '!=';
  triggerValue?: number | boolean | string;

  // For device-state triggers
  deviceType?: string;
  stateProperty?: string;

  // AC configuration
  agentCapability: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  requiredCollaborators: string[];
  collaborationGoal: string;
}

/**
 * Triggered AC Record
 */
export interface TriggeredAC {
  id: string;
  triggerId: string;
  triggerName: string;
  triggeredAt: Date;
  status: 'triggered' | 'creating' | 'active' | 'completed' | 'failed';
  participantAgentIds: string[];
  leadAgentId?: string;
  executionResult?: ACExecutionResult;  // ACExecutionResult after execution
}

// ============================================================================
// Smart City AC Triggers
// ============================================================================

export const SMART_CITY_AC_TRIGGERS: ACTriggerCondition[] = [
  // ==========================================================================
  // AIR QUALITY TRIGGERS (10 triggers)
  // ==========================================================================
  {
    id: 'trigger-pm25-high',
    name: 'High PM2.5 Detected',
    description: 'PM2.5 exceeds safe threshold (50 µg/m³)',
    conditionType: 'environment-parameter',
    triggerParameter: 'pm2_5',
    triggerOperator: '>',
    triggerValue: 50,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic'],
    collaborationGoal: 'Reduce air pollution through traffic control and monitoring',
  },
  {
    id: 'trigger-pm25-critical',
    name: 'Critical PM2.5 Level',
    description: 'PM2.5 exceeds dangerous threshold (100 µg/m³)',
    conditionType: 'environment-parameter',
    triggerParameter: 'pm2_5',
    triggerOperator: '>',
    triggerValue: 100,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'traffic', 'public-safety', 'emergency'],
    collaborationGoal: 'Critical air pollution response - evacuate affected areas',
  },
  {
    id: 'trigger-aqi-very-high',
    name: 'Very High AQI Alert',
    description: 'AQI exceeds 150',
    conditionType: 'environment-parameter',
    triggerParameter: 'aqi',
    triggerOperator: '>',
    triggerValue: 150,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'traffic', 'public-safety'],
    collaborationGoal: 'Urgent air quality response - reduce emissions and alert public',
  },
  {
    id: 'trigger-aqi-hazardous',
    name: 'Hazardous AQI Level',
    description: 'AQI exceeds 300 (hazardous)',
    conditionType: 'environment-parameter',
    triggerParameter: 'aqi',
    triggerOperator: '>',
    triggerValue: 300,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'traffic', 'public-safety', 'emergency'],
    collaborationGoal: 'Hazardous air quality - initiate emergency protocols',
  },
  {
    id: 'trigger-pm10-high',
    name: 'High PM10 Detected',
    description: 'PM10 exceeds 80 µg/m³',
    conditionType: 'environment-parameter',
    triggerParameter: 'pm10',
    triggerOperator: '>',
    triggerValue: 80,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic'],
    collaborationGoal: 'Reduce particulate matter through traffic control',
  },
  {
    id: 'trigger-co-high',
    name: 'High Carbon Monoxide Detected',
    description: 'CO exceeds 10 ppm',
    conditionType: 'environment-parameter',
    triggerParameter: 'co',
    triggerOperator: '>',
    triggerValue: 10,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'emergency', 'public-safety'],
    collaborationGoal: 'CO leak response - ventilate area and evacuate',
  },
  {
    id: 'trigger-co2-high',
    name: 'High CO2 Level',
    description: 'CO2 exceeds 1000 ppm',
    conditionType: 'environment-parameter',
    triggerParameter: 'co2',
    triggerOperator: '>',
    triggerValue: 1000,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['environment', 'ventilation'],
    collaborationGoal: 'High CO2 detected - increase ventilation',
  },
  {
    id: 'trigger-no2-high',
    name: 'High NO2 Level',
    description: 'NO2 exceeds 40 ppb',
    conditionType: 'environment-parameter',
    triggerParameter: 'no2',
    triggerOperator: '>',
    triggerValue: 40,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic'],
    collaborationGoal: 'Reduce NO2 through traffic optimization',
  },
  {
    id: 'trigger-o3-high',
    name: 'High Ozone Level',
    description: 'O3 exceeds 70 ppb',
    conditionType: 'environment-parameter',
    triggerParameter: 'o3',
    triggerOperator: '>',
    triggerValue: 70,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic'],
    collaborationGoal: 'Reduce ozone through emission control',
  },
  {
    id: 'trigger-air-quality-rapid-drop',
    name: 'Air Quality Rapid Deterioration',
    description: 'AQI drops by more than 50 in 5 minutes',
    conditionType: 'environment-parameter',
    triggerParameter: 'aqi_rate_of_change',
    triggerOperator: '<',
    triggerValue: -50,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'emergency', 'public-safety'],
    collaborationGoal: 'Rapid air quality deterioration - emergency response',
  },

  // ==========================================================================
  // TRAFFIC TRIGGERS (12 triggers)
  // ==========================================================================
  {
    id: 'trigger-traffic-congestion',
    name: 'Severe Traffic Congestion',
    description: 'Traffic flow below 20 veh/hr',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_flow',
    triggerOperator: '<',
    triggerValue: 20,
    agentCapability: 'detect-congestion',
    priority: 'high',
    requiredCollaborators: ['traffic', 'transportation'],
    collaborationGoal: 'Reduce congestion by optimizing signals and routing',
  },
  {
    id: 'trigger-traffic-gridlock',
    name: 'Traffic Gridlock Detected',
    description: 'Traffic flow below 5 veh/hr (gridlock)',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_flow',
    triggerOperator: '<',
    triggerValue: 5,
    agentCapability: 'detect-congestion',
    priority: 'urgent',
    requiredCollaborators: ['traffic', 'transportation', 'emergency', 'public-safety'],
    collaborationGoal: 'Gridlock response - clear intersections and reroute traffic',
  },
  {
    id: 'trigger-traffic-speeding',
    name: 'Excessive Speeding Detected',
    description: 'Average speed exceeds 20 km/h over limit',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_speed_excess',
    triggerOperator: '>',
    triggerValue: 20,
    agentCapability: 'detect-speeding',
    priority: 'high',
    requiredCollaborators: ['traffic', 'public-safety'],
    collaborationGoal: 'Speeding response - increase enforcement and visibility',
  },
  {
    id: 'trigger-traffic-accident',
    name: 'Traffic Accident Detected',
    description: 'Accident detected from traffic pattern analysis',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_pattern_anomaly',
    triggerOperator: '>',
    triggerValue: 0.8,
    agentCapability: 'detect-incidents',
    priority: 'urgent',
    requiredCollaborators: ['traffic', 'emergency', 'public-safety', 'transportation'],
    collaborationGoal: 'Accident response - clear route and assist victims',
  },
  {
    id: 'trigger-parking-full',
    name: 'Parking Capacity Reached',
    description: 'Parking occupancy exceeds 95%',
    conditionType: 'environment-parameter',
    triggerParameter: 'parking_occupancy',
    triggerOperator: '>',
    triggerValue: 95,
    agentCapability: 'monitor-parking',
    priority: 'medium',
    requiredCollaborators: ['traffic', 'transportation'],
    collaborationGoal: 'Parking full - direct drivers to alternative locations',
  },
  {
    id: 'trigger-traffic-volume-surge',
    name: 'Unexpected Traffic Volume Surge',
    description: 'Traffic volume increases by 200% suddenly',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_volume_change',
    triggerOperator: '>',
    triggerValue: 200,
    agentCapability: 'detect-congestion',
    priority: 'high',
    requiredCollaborators: ['traffic', 'transportation', 'public-safety'],
    collaborationGoal: 'Traffic surge - manage overflow and redirect',
  },
  {
    id: 'trigger-traffic-signal-failure',
    name: 'Traffic Signal Failure Detected',
    description: 'Traffic signal malfunction detected',
    conditionType: 'device-state',
    deviceType: 'traffic-light-controller',
    stateProperty: 'malfunction',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-malfunction',
    priority: 'urgent',
    requiredCollaborators: ['traffic', 'emergency', 'maintenance'],
    collaborationGoal: 'Signal failure - deploy manual control and repair',
  },
  {
    id: 'trigger-bridge-overload',
    name: 'Bridge Weight Limit Exceeded',
    description: 'Bridge load exceeds safety limit',
    conditionType: 'environment-parameter',
    triggerParameter: 'bridge_load_ratio',
    triggerOperator: '>',
    triggerValue: 1.0,
    agentCapability: 'monitor-structure',
    priority: 'urgent',
    requiredCollaborators: ['traffic', 'emergency', 'maintenance'],
    collaborationGoal: 'Bridge overload - close bridge and redirect traffic',
  },
  {
    id: 'trigger-ev-charging-queue',
    name: 'EV Charging Station Queue Too Long',
    description: 'EV charging queue exceeds 10 vehicles',
    conditionType: 'environment-parameter',
    triggerParameter: 'ev_charging_queue_length',
    triggerOperator: '>',
    triggerValue: 10,
    agentCapability: 'monitor-charging',
    priority: 'medium',
    requiredCollaborators: ['traffic', 'energy', 'transportation'],
    collaborationGoal: 'EV charging queue - redirect to other stations',
  },
  {
    id: 'trigger-pedestrian-crowding',
    name: 'Pedestrian Overcrowding Detected',
    description: 'Pedestrian density exceeds safe level',
    conditionType: 'environment-parameter',
    triggerParameter: 'pedestrian_density',
    triggerOperator: '>',
    triggerValue: 3,
    agentCapability: 'detect-crowding',
    priority: 'high',
    requiredCollaborators: ['public-safety', 'traffic'],
    collaborationGoal: 'Pedestrian overcrowding - redirect flow and increase safety',
  },
  {
    id: 'trigger-bus-delay',
    name: 'Public Transit Delay Excessive',
    description: 'Bus delay exceeds 15 minutes',
    conditionType: 'environment-parameter',
    triggerParameter: 'bus_delay',
    triggerOperator: '>',
    triggerValue: 15,
    agentCapability: 'monitor-transit',
    priority: 'high',
    requiredCollaborators: ['transportation', 'traffic'],
    collaborationGoal: 'Transit delay - adjust signal priority for buses',
  },
  {
    id: 'trigger-cycle-path-blocked',
    name: 'Bicycle Path Blocked',
    description: 'Bicycle path obstruction detected',
    conditionType: 'device-state',
    deviceType: 'bicycle-sensor',
    stateProperty: 'path_blocked',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-obstruction',
    priority: 'medium',
    requiredCollaborators: ['traffic', 'maintenance'],
    collaborationGoal: 'Bike path blocked - clear obstruction and divert cyclists',
  },

  // ==========================================================================
  // WEATHER & ENVIRONMENT TRIGGERS (10 triggers)
  // ==========================================================================
  {
    id: 'trigger-heat-wave',
    name: 'Heat Wave Detected',
    description: 'Temperature exceeds 35°C',
    conditionType: 'environment-parameter',
    triggerParameter: 'temperature',
    triggerOperator: '>',
    triggerValue: 35,
    agentCapability: 'monitor-temperature',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic', 'energy'],
    collaborationGoal: 'Reduce heat island effect through traffic reduction and cooling',
  },
  {
    id: 'trigger-extreme-heat',
    name: 'Extreme Heat Emergency',
    description: 'Temperature exceeds 40°C',
    conditionType: 'environment-parameter',
    triggerParameter: 'temperature',
    triggerOperator: '>',
    triggerValue: 40,
    agentCapability: 'monitor-temperature',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'traffic', 'energy', 'public-safety', 'emergency'],
    collaborationGoal: 'Extreme heat - activate cooling centers and emergency response',
  },
  {
    id: 'extreme-cold',
    name: 'Extreme Cold Alert',
    description: 'Temperature drops below -10°C',
    conditionType: 'environment-parameter',
    triggerParameter: 'temperature',
    triggerOperator: '<',
    triggerValue: -10,
    agentCapability: 'monitor-temperature',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'energy', 'public-safety', 'emergency'],
    collaborationGoal: 'Extreme cold - activate warming centers and prevent pipe damage',
  },
  {
    id: 'trigger-high-humidity',
    name: 'Excessive Humidity Detected',
    description: 'Humidity exceeds 85%',
    conditionType: 'environment-parameter',
    triggerParameter: 'humidity',
    triggerOperator: '>',
    triggerValue: 85,
    agentCapability: 'monitor-humidity',
    priority: 'high',
    requiredCollaborators: ['environment', 'energy'],
    collaborationGoal: 'High humidity - increase dehumidification and cooling',
  },
  {
    id: 'trigger-heavy-rain',
    name: 'Heavy Rain Detected',
    description: 'Rainfall exceeds 50mm/hr',
    conditionType: 'environment-parameter',
    triggerParameter: 'rainfall',
    triggerOperator: '>',
    triggerValue: 50,
    agentCapability: 'detect-weather',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic', 'emergency'],
    collaborationGoal: 'Heavy rain - adjust speed limits and prepare for flooding',
  },
  {
    id: 'trigger-flood-warning',
    name: 'Flood Warning',
    description: 'Water level exceeds flood threshold',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_level',
    triggerOperator: '>',
    triggerValue: 2.5,
    agentCapability: 'detect-flooding',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'traffic', 'public-safety', 'environment'],
    collaborationGoal: 'Flood warning - evacuate areas and close roads',
  },
  {
    id: 'trigger-strong-wind',
    name: 'Strong Wind Alert',
    description: 'Wind speed exceeds 50 km/h',
    conditionType: 'environment-parameter',
    triggerParameter: 'wind_speed',
    triggerOperator: '>',
    triggerValue: 50,
    agentCapability: 'detect-weather',
    priority: 'high',
    requiredCollaborators: ['environment', 'traffic', 'public-safety'],
    collaborationGoal: 'Strong wind - secure loose objects and adjust traffic',
  },
  {
    id: 'trigger-lightning-detected',
    name: 'Lightning Strike Detected',
    description: 'Lightning activity within 5km',
    conditionType: 'environment-parameter',
    triggerParameter: 'lightning_distance',
    triggerOperator: '<',
    triggerValue: 5,
    agentCapability: 'detect-weather',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'public-safety', 'energy'],
    collaborationGoal: 'Lightning detected - prepare for potential fires and outages',
  },
  {
    id: 'trigger-low-visibility',
    name: 'Low Visibility Warning',
    description: 'Visibility below 100 meters (fog/smoke)',
    conditionType: 'environment-parameter',
    triggerParameter: 'visibility',
    triggerOperator: '<',
    triggerValue: 100,
    agentCapability: 'detect-weather',
    priority: 'urgent',
    requiredCollaborators: ['traffic', 'public-safety', 'emergency'],
    collaborationGoal: 'Low visibility - reduce speed limits and increase alerts',
  },
  {
    id: 'trigger-poor-air-quality-heat-combo',
    name: 'Combined Heat and Poor Air Quality',
    description: 'Temperature > 30°C AND AQI > 100',
    conditionType: 'environment-parameter',
    triggerParameter: 'heat_aqi_index',
    triggerOperator: '>',
    triggerValue: 130,
    agentCapability: 'detect-combined-conditions',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'traffic', 'public-safety', 'emergency', 'energy'],
    collaborationGoal: 'Combined heat and air quality emergency - multi-domain response',
  },

  // ==========================================================================
  // SAFETY & EMERGENCY TRIGGERS (12 triggers)
  // ==========================================================================
  {
    id: 'trigger-emergency-incident',
    name: 'Emergency Incident Detected',
    description: 'Fire alarm or emergency button activated',
    conditionType: 'device-state',
    deviceType: 'emergency-call-box',
    stateProperty: 'emergency_active',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-emergency',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'traffic', 'public-safety'],
    collaborationGoal: 'Coordinate emergency response',
  },
  {
    id: 'trigger-fire-detected',
    name: 'Fire Detected',
    description: 'Smoke or fire sensor activated',
    conditionType: 'device-state',
    deviceType: 'smoke-detector',
    stateProperty: 'alarm_active',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-fire',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'traffic', 'public-safety', 'environment'],
    collaborationGoal: 'Fire response - evacuate and dispatch fire services',
  },
  {
    id: 'trigger-gunshot-detected',
    name: 'Gunshot Detected',
    description: 'Acoustic sensor detected gunshot',
    conditionType: 'device-state',
    deviceType: 'gunshot-detector',
    stateProperty: 'gunshot_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-violence',
    priority: 'urgent',
    requiredCollaborators: ['public-safety', 'emergency', 'traffic'],
    collaborationGoal: 'Gunshot detected - dispatch law enforcement immediately',
  },
  {
    id: 'trigger-earthquake-detected',
    name: 'Earthquake Detected',
    description: 'Seismic activity exceeds magnitude 4.0',
    conditionType: 'environment-parameter',
    triggerParameter: 'seismic_magnitude',
    triggerOperator: '>',
    triggerValue: 4.0,
    agentCapability: 'detect-earthquake',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'traffic', 'public-safety', 'maintenance', 'environment'],
    collaborationGoal: 'Earthquake response - assess damage and coordinate rescue',
  },
  {
    id: 'trigger-gas-leak-detected',
    name: 'Gas Leak Detected',
    description: 'Gas sensor detects leak',
    conditionType: 'device-state',
    deviceType: 'gas-sensor',
    stateProperty: 'leak_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-hazard',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'public-safety', 'maintenance', 'environment'],
    collaborationGoal: 'Gas leak - evacuate area and shut off supply',
  },
  {
    id: 'trigger-crowd-crush-risk',
    name: 'Crowd Crush Risk Detected',
    description: 'Crowd density exceeds dangerous threshold',
    conditionType: 'environment-parameter',
    triggerParameter: 'crowd_density',
    triggerOperator: '>',
    triggerValue: 5,
    agentCapability: 'detect-crowding',
    priority: 'urgent',
    requiredCollaborators: ['public-safety', 'emergency', 'traffic'],
    collaborationGoal: 'Crowd crush risk - disperse crowd and prevent injury',
  },
  {
    id: 'trigger-suspicious-activity',
    name: 'Suspicious Activity Detected',
    description: 'AI detects suspicious behavior pattern',
    conditionType: 'environment-parameter',
    triggerParameter: 'suspicious_activity_score',
    triggerOperator: '>',
    triggerValue: 0.8,
    agentCapability: 'detect-threats',
    priority: 'high',
    requiredCollaborators: ['public-safety', 'emergency'],
    collaborationGoal: 'Suspicious activity - investigate and increase surveillance',
  },
  {
    id: 'trigger-noise-complaint',
    name: 'Excessive Noise Detected',
    description: 'Noise level exceeds 90 dB',
    conditionType: 'environment-parameter',
    triggerParameter: 'noise_level',
    triggerOperator: '>',
    triggerValue: 90,
    agentCapability: 'monitor-noise',
    priority: 'medium',
    requiredCollaborators: ['public-safety', 'environment'],
    collaborationGoal: 'Excessive noise - identify source and mitigate',
  },
  {
    id: 'trigger-vandalism-detected',
    name: 'Vandalism Detected',
    description: 'Camera detects property damage',
    conditionType: 'device-state',
    deviceType: 'surveillance-camera',
    stateProperty: 'vandalism_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-crime',
    priority: 'high',
    requiredCollaborators: ['public-safety', 'maintenance'],
    collaborationGoal: 'Vandalism detected - dispatch security and document damage',
  },
  {
    id: 'trigger-lost-child',
    name: 'Lost Child Reported',
    description: 'Lost child alert activated',
    conditionType: 'device-state',
    deviceType: 'emergency-call-box',
    stateProperty: 'lost_child_alert',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'search-and-rescue',
    priority: 'urgent',
    requiredCollaborators: ['public-safety', 'emergency', 'traffic'],
    collaborationGoal: 'Lost child - coordinate search and notify guardians',
  },
  {
    id: 'trigger-power-outage-detected',
    name: 'Power Outage Detected',
    description: 'Grid power drops to zero in area',
    conditionType: 'environment-parameter',
    triggerParameter: 'grid_power',
    triggerOperator: '==',
    triggerValue: 0,
    agentCapability: 'detect-outage',
    priority: 'urgent',
    requiredCollaborators: ['energy', 'emergency', 'public-safety', 'traffic'],
    collaborationGoal: 'Power outage - restore power and ensure public safety',
  },
  {
    id: 'trigger-water-main-break',
    name: 'Water Main Break Detected',
    description: 'Water pressure drops suddenly',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_pressure',
    triggerOperator: '<',
    triggerValue: 20,
    agentCapability: 'detect-leaks',
    priority: 'urgent',
    requiredCollaborators: ['maintenance', 'emergency', 'traffic', 'public-safety'],
    collaborationGoal: 'Water main break - shut off valve and repair',
  },

  // ==========================================================================
  // ENERGY TRIGGERS (6 triggers)
  // ==========================================================================
  {
    id: 'trigger-peak-load-detected',
    name: 'Peak Power Load Detected',
    description: 'Grid load exceeds 90% capacity',
    conditionType: 'environment-parameter',
    triggerParameter: 'grid_load_percent',
    triggerOperator: '>',
    triggerValue: 90,
    agentCapability: 'monitor-grid',
    priority: 'urgent',
    requiredCollaborators: ['energy', 'environment', 'traffic'],
    collaborationGoal: 'Peak load - activate demand response and reduce consumption',
  },
  {
    id: 'trigger-grid-frequency-anomaly',
    name: 'Grid Frequency Anomaly',
    description: 'Grid frequency deviates from 60Hz by more than 0.5Hz',
    conditionType: 'environment-parameter',
    triggerParameter: 'grid_frequency_deviation',
    triggerOperator: '>',
    triggerValue: 0.5,
    agentCapability: 'monitor-grid',
    priority: 'urgent',
    requiredCollaborators: ['energy', 'emergency'],
    collaborationGoal: 'Grid instability - activate backup and shed load',
  },
  {
    id: 'trigger-renewable-excess',
    name: 'Excess Renewable Energy',
    description: 'Renewable generation exceeds demand by 20%',
    conditionType: 'environment-parameter',
    triggerParameter: 'renewable_surplus',
    triggerOperator: '>',
    triggerValue: 20,
    agentCapability: 'monitor-generation',
    priority: 'medium',
    requiredCollaborators: ['energy', 'environment', 'transportation'],
    collaborationGoal: 'Excess renewables - charge storage and EVs',
  },
  {
    id: 'trigger-battery-low',
    name: 'Grid Battery Storage Low',
    description: 'Battery storage below 20%',
    conditionType: 'environment-parameter',
    triggerParameter: 'battery_storage_percent',
    triggerOperator: '<',
    triggerValue: 20,
    agentCapability: 'monitor-storage',
    priority: 'high',
    requiredCollaborators: ['energy', 'environment'],
    collaborationGoal: 'Low battery - conserve energy and prepare for outage',
  },
  {
    id: 'trigger-energy-theft-detected',
    name: 'Energy Theft Detected',
    description: 'Meter reading indicates possible theft',
    conditionType: 'environment-parameter',
    triggerParameter: 'energy_anomaly_score',
    triggerOperator: '>',
    triggerValue: 0.7,
    agentCapability: 'detect-theft',
    priority: 'high',
    requiredCollaborators: ['energy', 'public-safety'],
    collaborationGoal: 'Energy theft suspected - investigate and prevent',
  },
  {
    id: 'trigger-voltage-sag',
    name: 'Voltage Sag Detected',
    description: 'Voltage drops below 90% of nominal',
    conditionType: 'environment-parameter',
    triggerParameter: 'voltage_percent',
    triggerOperator: '<',
    triggerValue: 90,
    agentCapability: 'monitor-quality',
    priority: 'high',
    requiredCollaborators: ['energy', 'maintenance'],
    collaborationGoal: 'Voltage sag - investigate cause and stabilize',
  },

  // ==========================================================================
  // WATER & ENVIRONMENT TRIGGERS (6 triggers)
  // ==========================================================================
  {
    id: 'trigger-water-quality-poor',
    name: 'Poor Water Quality Detected',
    description: 'Water quality index below 50',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_quality_index',
    triggerOperator: '<',
    triggerValue: 50,
    agentCapability: 'monitor-water-quality',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'emergency', 'public-safety'],
    collaborationGoal: 'Poor water quality - issue boil water advisory and investigate',
  },
  {
    id: 'trigger-leak-detected',
    name: 'Water Leak Detected',
    description: 'Water loss exceeds 10% of flow',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_loss_percent',
    triggerOperator: '>',
    triggerValue: 10,
    agentCapability: 'detect-leaks',
    priority: 'high',
    requiredCollaborators: ['maintenance', 'environment'],
    collaborationGoal: 'Water leak - locate and repair',
  },
  {
    id: 'trigger-drought-warning',
    name: 'Drought Conditions Detected',
    description: 'Water reservoir below 30%',
    conditionType: 'environment-parameter',
    triggerParameter: 'reservoir_level_percent',
    triggerOperator: '<',
    triggerValue: 30,
    agentCapability: 'monitor-drought',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'public-safety', 'energy'],
    collaborationGoal: 'Drought - implement water restrictions and conservation',
  },
  {
    id: 'trigger-irrigation-failure',
    name: 'Irrigation System Failure',
    description: 'Irrigation flow detected when should be off',
    conditionType: 'device-state',
    deviceType: 'irrigation-controller',
    stateProperty: 'unauthorized_flow',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'monitor-irrigation',
    priority: 'high',
    requiredCollaborators: ['maintenance', 'environment'],
    collaborationGoal: 'Irrigation failure - shut off water and repair',
  },
  {
    id: 'trigger-waste-bin-full',
    name: 'Waste Bin Capacity Critical',
    description: 'Waste bin fill level exceeds 95%',
    conditionType: 'device-state',
    deviceType: 'smart-waste-bin',
    stateProperty: 'fill_level',
    triggerOperator: '>',
    triggerValue: 95,
    agentCapability: 'monitor-waste',
    priority: 'medium',
    requiredCollaborators: ['waste', 'transportation'],
    collaborationGoal: 'Waste bin full - schedule collection',
  },
  {
    id: 'trigger-street-light-failure',
    name: 'Street Light Failure Detected',
    description: 'Street light not operating during night',
    conditionType: 'device-state',
    deviceType: 'smart-street-light',
    stateProperty: 'malfunction',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'monitor-lighting',
    priority: 'high',
    requiredCollaborators: ['maintenance', 'public-safety'],
    collaborationGoal: 'Street light failure - repair for safety',
  },

  // ==========================================================================
  // MULTI-CONDITION COMPLEX TRIGGERS (4 triggers)
  // ==========================================================================
  {
    id: 'trigger-complex-storm',
    name: 'Complex Storm Conditions',
    description: 'High wind + heavy rain + lightning combined',
    conditionType: 'environment-parameter',
    triggerParameter: 'storm_severity_index',
    triggerOperator: '>',
    triggerValue: 8,
    agentCapability: 'detect-storm',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'traffic', 'public-safety', 'environment', 'energy'],
    collaborationGoal: 'Major storm - comprehensive emergency response across all domains',
  },
  {
    id: 'trigger-cascade-failure-risk',
    name: 'Cascade Failure Risk',
    description: 'Grid stress + high demand + low backup combined',
    conditionType: 'environment-parameter',
    triggerParameter: 'cascade_risk_score',
    triggerOperator: '>',
    triggerValue: 0.8,
    agentCapability: 'detect-cascade-risk',
    priority: 'urgent',
    requiredCollaborators: ['energy', 'emergency', 'public-safety', 'traffic', 'environment'],
    collaborationGoal: 'Cascade failure risk - shed load and activate emergency protocols',
  },
  {
    id: 'trigger-urban-heat-island',
    name: 'Urban Heat Island Emergency',
    description: 'Extreme heat + poor air quality + high energy demand',
    conditionType: 'environment-parameter',
    triggerParameter: 'urban_heat_index',
    triggerOperator: '>',
    triggerValue: 45,
    agentCapability: 'detect-heat-emergency',
    priority: 'urgent',
    requiredCollaborators: ['environment', 'energy', 'health', 'traffic', 'public-safety', 'emergency'],
    collaborationGoal: 'Urban heat island emergency - multi-faceted response for public health',
  },
  {
    id: 'trigger-mass-casualty-incident',
    name: 'Mass Casualty Incident',
    description: 'Multiple emergency incidents in short time',
    conditionType: 'environment-parameter',
    triggerParameter: 'emergency_incident_count',
    triggerOperator: '>',
    triggerValue: 5,
    agentCapability: 'coordinate-disaster',
    priority: 'urgent',
    requiredCollaborators: ['emergency', 'public-safety', 'traffic', 'health', 'environment'],
    collaborationGoal: 'Mass casualty - activate disaster response plan',
  },
];

// ============================================================================
// AC Trigger Monitor
// ============================================================================

export class ACTriggerMonitor {
  private environmentCenter: EnvironmentCenter;
  private triggers: ACTriggerCondition[];
  private triggeredACs: Map<string, TriggeredAC>;
  private monitoringInterval?: NodeJS.Timeout;
  private cooldownPeriod: number;  // ms
  private lastTriggerTimes: Map<string, number>;
  private acExecutor: ACExecutor;
  private collaborationManager: CollaborationManager;

  constructor(environmentCenter: EnvironmentCenter, options: {
    triggers?: ACTriggerCondition[];
    monitoringInterval?: number;
    cooldownPeriod?: number;
  } = {}) {
    this.environmentCenter = environmentCenter;
    this.triggers = options.triggers || SMART_CITY_AC_TRIGGERS;
    this.triggeredACs = new Map();
    this.lastTriggerTimes = new Map();
    this.cooldownPeriod = options.cooldownPeriod || 60000; // 1 minute default

    // Initialize AC execution components
    this.acExecutor = new ACExecutor();
    this.collaborationManager = new CollaborationManager();

    logger.info(`Initialized with ${this.triggers.length} triggers`);
    logger.info(`Cooldown period: ${this.cooldownPeriod}ms`);
    logger.info(`ACExecutor integrated for full AC execution`);
  }

  /**
   * Start monitoring for trigger conditions
   */
  start(monitoringInterval: number = 5000): void {
    logger.info(`Starting continuous monitoring (interval: ${monitoringInterval}ms)`);

    // Subscribe to environment parameter change events
    this.subscribeToEvents();

    // Start periodic monitoring
    this.monitoringInterval = setInterval(async () => {
      await this.evaluateAllTriggers();
    }, monitoringInterval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    logger.info('Stopping monitoring');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    // Unsubscribe from events (if event manager supports it)
    // TODO: Implement unsubscribe when EventManager supports it
  }

  /**
   * Subscribe to environment and device events
   */
  private subscribeToEvents(): void {
    const eventManager = (this.environmentCenter as unknown as { eventManager: EventManager }).eventManager;
    if (!eventManager) {
      logger.warn('No event manager available');
      return;
    }

    // Subscribe to environment parameter changes
    eventManager.subscribe({
      subscriberId: 'ac-trigger-monitor',
      eventType: EventType.ENVIRONMENT_PARAM_CHANGED,
      handler: async () => {
        await this.evaluateAllTriggers();
      },
      priority: EventPriority.HIGH,
    });

    // Subscribe to device state changes
    eventManager.subscribe({
      subscriberId: 'ac-trigger-monitor',
      eventType: EventType.DEVICE_STATE_CHANGE,
      handler: async () => {
        await this.evaluateAllTriggers();
      },
      priority: EventPriority.HIGH,
    });

    logger.info('Subscribed to environment and device events');
  }

  /**
   * Evaluate all trigger conditions
   */
  private async evaluateAllTriggers(): Promise<void> {
    for (const trigger of this.triggers) {
      // Check cooldown
      const lastTriggerTime = this.lastTriggerTimes.get(trigger.id);
      if (lastTriggerTime && Date.now() - lastTriggerTime < this.cooldownPeriod) {
        continue; // Still in cooldown period
      }

      const shouldTrigger = await this.evaluateTrigger(trigger);

      if (shouldTrigger) {
        logger.info(`\n[ACTriggerMonitor] *** TRIGGER DETECTED: ${trigger.name} ***`);
        logger.info(`Priority: ${trigger.priority}`);
        logger.info(`Description: ${trigger.description}`);

        await this.handleTriggeredAC(trigger);

        // Update last trigger time
        this.lastTriggerTimes.set(trigger.id, Date.now());
      }
    }
  }

  /**
   * Evaluate a single trigger condition
   */
  private async evaluateTrigger(trigger: ACTriggerCondition): Promise<boolean> {
    try {
      switch (trigger.conditionType) {
        case 'environment-parameter':
          return this.evaluateEnvironmentTrigger(trigger);

        case 'device-state':
          return this.evaluateDeviceStateTrigger(trigger);

        default:
          return false;
      }
    } catch (error) {
      logger.error(`Error evaluating trigger ${trigger.id}:`, error);
      return false;
    }
  }

  /**
   * Evaluate environment parameter trigger
   */
  private evaluateEnvironmentTrigger(trigger: ACTriggerCondition): boolean {
    const physicalEnv = (this.environmentCenter as unknown as Record<string, unknown>).physicalEnvironment as Record<string, unknown> | undefined;
    if (!physicalEnv || typeof physicalEnv.getParameterValue !== 'function') {
      return false;
    }

    // Get parameter value at a test location (center of environment)
    const testLocation = { x: 250, y: 250 };
    const currentValue = (physicalEnv.getParameterValue as (param: string, loc: { x: number; y: number }) => unknown)(trigger.triggerParameter as string, testLocation);

    if (currentValue === undefined || currentValue === null) {
      return false;
    }

    // Evaluate condition
    const triggerValue = trigger.triggerValue as number;
    if (triggerValue === undefined) {
      return false;
    }
    const numericValue = typeof currentValue === 'boolean' ? (currentValue ? 1 : 0) : Number(currentValue);

    switch (trigger.triggerOperator) {
      case '>':
        return numericValue > triggerValue;
      case '<':
        return numericValue < triggerValue;
      case '>=':
        return numericValue >= triggerValue;
      case '<=':
        return numericValue <= triggerValue;
      case '==':
        return numericValue == triggerValue;
      case '!=':
        return numericValue != triggerValue;
      default:
        return false;
    }
  }

  /**
   * Evaluate device state trigger
   */
  private evaluateDeviceStateTrigger(trigger: ACTriggerCondition): boolean {
    const devices = this.environmentCenter.listDevices();
    const triggerValue = trigger.triggerValue;

    if (triggerValue === undefined) {
      return false;
    }

    // Convert trigger value to number for comparison
    const numericTriggerValue = typeof triggerValue === 'boolean' ? (triggerValue ? 1 : 0) : Number(triggerValue);

    for (const device of devices) {
      // Check device type
      if (trigger.deviceType && device.type !== trigger.deviceType) {
        continue;
      }

      // Check device state
      const deviceState = (device as unknown as Record<string, unknown>).state as Record<string, unknown> | undefined;
      if (!deviceState) {
        continue;
      }

      const currentValue = deviceState[trigger.stateProperty as string];

      if (currentValue === undefined || currentValue === null) {
        continue;
      }

      // Convert to numeric value for comparison
      const numericValue = typeof currentValue === 'boolean' ? (currentValue ? 1 : 0) : Number(currentValue);

      // Evaluate condition
      switch (trigger.triggerOperator) {
        case '>':
          if (numericValue > numericTriggerValue) return true;
          break;
        case '<':
          if (numericValue < numericTriggerValue) return true;
          break;
        case '>=':
          if (numericValue >= numericTriggerValue) return true;
          break;
        case '<=':
          if (numericValue <= numericTriggerValue) return true;
          break;
        case '==':
          if (numericValue == numericTriggerValue) return true;
          break;
        case '!=':
          if (numericValue != numericTriggerValue) return true;
          break;
      }
    }

    return false;
  }

  /**
   * Handle triggered AC
   * Automatically creates and initiates AC collaboration
   * NOW INTEGRATED WITH ACEXECUTOR FOR FULL EXECUTION
   */
  private async handleTriggeredAC(trigger: ACTriggerCondition): Promise<void> {
    try {
      // Find agents with required capabilities
      const agents = this.findAgentsForTrigger(trigger);

      if (agents.length < 2) {
        logger.warn(`Not enough agents for trigger ${trigger.name} (found: ${agents.length})`);
        return;
      }

      // Create triggered AC record
      const triggeredAC: TriggeredAC = {
        id: uuidv4(),
        triggerId: trigger.id,
        triggerName: trigger.name,
        triggeredAt: new Date(),
        status: 'triggered',
        participantAgentIds: agents.map(a => a.id),
        leadAgentId: agents[0].id,
      };

      this.triggeredACs.set(triggeredAC.id, triggeredAC);

      logger.info(`Creating AC: ${triggeredAC.id}`);
      logger.info(`Participant agents: ${agents.length}`);
      logger.info(`Lead agent: ${agents[0].name}`);

      // Step 1: Send collaboration requests via MessageBroker (agents will use LLM to decide)
      const leadAgent = agents[0];
      const collaborationMessage = this.buildCollaborationMessage(trigger, agents);

      logger.info(`Lead agent ${leadAgent.name} initiating collaboration...`);

      // Send collaboration requests to all participant agents
      for (const agent of agents) {
        if (agent.id !== leadAgent.id) {
          try {
            await leadAgent.communicateWithAgent(
              agent.id,
              collaborationMessage,
              MessageType.REQUEST,
              MessagePriority.HIGH
            );
            logger.info(`Collaboration request to ${agent.name}: ✓ Sent`);
          } catch (error) {
            logger.info(`Collaboration request to ${agent.name}: ✗ Failed - ${error}`);
          }
        }
      }

      triggeredAC.status = 'active';
      logger.info(`*** AC ACTIVATED: ${trigger.name} ***`);
      logger.info(`Agents are now collaborating via MessageBroker`);

      // Step 2: Execute AC using ACExecutor for FULL EXECUTION
      logger.info(`\n[ACTriggerMonitor] ========== STARTING AC EXECUTION ==========`);
      logger.info(`Now calling ACExecutor to execute actual tasks...`);

      // Build AC collaboration config for ACExecutor
      const acConfig = await this.buildACExecutionConfig(trigger, agents, triggeredAC);

      // Execute the collaboration with ACExecutor
      const executionResult = await this.acExecutor.executeCollaboration(acConfig, {
        maxDuration: 120000,  // 2 minutes max
        taskTimeout: 30000,   // 30 seconds per task
        verboseLogging: true,
      });

      // Store execution result
      triggeredAC.executionResult = executionResult;
      triggeredAC.status = executionResult.success ? 'completed' : 'failed';

      logger.info(`\n[ACTriggerMonitor] ========== AC EXECUTION COMPLETE ==========`);
      logger.info(`Success: ${executionResult.success}`);
      logger.info(`Goals achieved: ${executionResult.goalsAchieved.length}/${acConfig.goals.length}`);
      logger.info(`Device operations: ${executionResult.deviceOperations.length}`);
      logger.info(`Environment effects: ${executionResult.environmentEffects.length}`);
      logger.info(`Duration: ${executionResult.duration}ms`);

      // Update triggered AC status
      this.triggeredACs.set(triggeredAC.id, triggeredAC);

    } catch (error) {
      logger.error(`Error handling triggered AC:`, error);
    }
  }

  /**
   * Build AC execution config from trigger and agents
   * This converts trigger info into a format ACExecutor can use
   */
  private async buildACExecutionConfig(
    trigger: ACTriggerCondition,
    agents: CognitiveAgent[],
    triggeredAC: TriggeredAC
  ): Promise<ACCollaborationConfig> {
    // Find relevant devices for this collaboration
    const devices = this.findDevicesForTrigger(trigger);
    const deviceIds = devices.map(d => d.id);

    // Build goals based on trigger type
    const goals: ACCollaborationGoal[] = [];

    // Create a main goal based on trigger's collaboration goal
    const mainGoal: ACCollaborationGoal = {
      id: `goal-${trigger.id}-main`,
      description: trigger.collaborationGoal,
      targetDevices: deviceIds,
      targetAgents: agents.map(a => a.id),
      requiredCapabilities: trigger.requiredCollaborators.map(c => c.toLowerCase()),
      successCriteria: this.buildSuccessCriteria(trigger),
      priority: trigger.priority,
    };
    goals.push(mainGoal);

    return {
      id: triggeredAC.id,
      name: trigger.name,
      description: trigger.description,
      environment: this.environmentCenter,
      participantAgentIds: agents.map(a => a.id),
      collaborationManager: this.collaborationManager,
      goals,
      maxDuration: 120000,  // 2 minutes
      timeout: 30000,       // 30 seconds per task
    };
  }

  /**
   * Build success criteria from trigger
   */
  private buildSuccessCriteria(trigger: ACTriggerCondition): ACCSuccessCriterion[] {
    const criteria: ACCSuccessCriterion[] = [];

    // For environment parameter triggers, success means parameter is now within safe range
    if (trigger.conditionType === 'environment-parameter' && trigger.triggerParameter) {
      criteria.push({
        type: 'environment-parameter',
        target: trigger.triggerParameter,
        condition: trigger.triggerOperator === '>' ? `<${trigger.triggerValue}` : `>${trigger.triggerValue}`,
        threshold: trigger.triggerValue as number,
        operator: trigger.triggerOperator === '>' ? '<' : '>',
      });
    }

    // Add task completion criterion
    criteria.push({
      type: 'task-completion',
      target: 'collaboration',
      condition: 'completed',
    });

    return criteria;
  }

  /**
   * Find devices relevant to the trigger
   */
  private findDevicesForTrigger(trigger: ACTriggerCondition): Device[] {
    const allDevices = this.environmentCenter.listDevices();

    // For now, return all devices that might be relevant based on trigger type
    // In production, this would be more intelligent
    const relevantDevices = allDevices.filter(device => {
      const deviceType = ((device as unknown as Record<string, unknown>).type as string || '').toLowerCase();

      // Match device types to trigger types
      if (trigger.triggerParameter?.includes('pm2_5') || trigger.triggerParameter?.includes('aqi')) {
        return deviceType.includes('air') || deviceType.includes('purifier') ||
               deviceType.includes('traffic') || deviceType.includes('vms');
      }
      if (trigger.triggerParameter?.includes('temperature')) {
        return deviceType.includes('hvac') || deviceType.includes('ac') ||
               deviceType.includes('temperature') || deviceType.includes('heater');
      }
      if (trigger.triggerParameter?.includes('water')) {
        return deviceType.includes('water') || deviceType.includes('pump') ||
               deviceType.includes('barrier');
      }

      // Default: include all devices
      return true;
    });

    logger.info(`Found ${relevantDevices.length} relevant devices for trigger`);
    return relevantDevices;
  }

  /**
   * Find agents capable of handling the trigger
   */
  private findAgentsForTrigger(trigger: ACTriggerCondition): CognitiveAgent[] {
    const allAgents = this.environmentCenter.listAgents();
    const foundAgents: CognitiveAgent[] = [];

    // Find lead agent with detection capability
    for (const agent of allAgents) {
      if (agent.capabilities && agent.capabilities.some(c => String(c) === trigger.agentCapability)) {
        foundAgents.push(agent as unknown as CognitiveAgent);
        break; // Found lead agent
      }
    }

    // Find collaborating agents
    for (const collaboratorType of trigger.requiredCollaborators) {
      for (const agent of allAgents) {
        const agentName = agent.name.toLowerCase();
        const agentType = collaboratorType.toLowerCase();

        // Check if agent matches collaborator type
        if (
          agentName.includes(agentType) ||
          (agent as unknown as Record<string, unknown>).type === collaboratorType ||
          (agent.capabilities && agent.capabilities.some(c => String(c).toLowerCase().includes(agentType)))
        ) {
          const agentObj = agent as unknown as CognitiveAgent;
          if (!foundAgents.find(a => a.id === agentObj.id)) {
            foundAgents.push(agentObj);
            break;
          }
        }
      }
    }

    return foundAgents;
  }

  /**
   * Build collaboration message for trigger
   */
  private buildCollaborationMessage(trigger: ACTriggerCondition, agents: CognitiveAgent[]): string {
    const agentList = agents.map(a => a.name).join(', ');
    return `AUTO-TRIGGERED AC: ${trigger.name}

Description: ${trigger.description}
Priority: ${trigger.priority}
Goal: ${trigger.collaborationGoal}

Participants: ${agentList}

This collaboration was automatically triggered by environmental conditions.
Agents should coordinate their actions to achieve the stated goal.`;
  }

  /**
   * Get all triggered ACs
   */
  getTriggeredACs(): TriggeredAC[] {
    return Array.from(this.triggeredACs.values());
  }

  /**
   * Get triggered ACs by status
   */
  getTriggeredACsByStatus(status: TriggeredAC['status']): TriggeredAC[] {
    return Array.from(this.triggeredACs.values()).filter(ac => ac.status === status);
  }

  /**
   * Add custom trigger
   */
  addTrigger(trigger: ACTriggerCondition): void {
    this.triggers.push(trigger);
    logger.info(`Added trigger: ${trigger.name}`);
  }

  /**
   * Remove trigger
   */
  removeTrigger(triggerId: string): void {
    const index = this.triggers.findIndex(t => t.id === triggerId);
    if (index !== -1) {
      this.triggers.splice(index, 1);
      logger.info(`Removed trigger: ${triggerId}`);
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalTriggers: number;
    activeTriggeredACs: number;
    totalTriggeredACs: number;
    lastEvaluation?: Date;
  } {
    return {
      totalTriggers: this.triggers.length,
      activeTriggeredACs: this.getTriggeredACsByStatus('active').length,
      totalTriggeredACs: this.triggeredACs.size,
    };
  }
}

// SMART_CITY_AC_TRIGGERS is already exported at the declaration site

