/**
 * Simulated Data Source
 *
 * Generates realistic IoT data patterns for AC mechanism testing.
 * Supports:
 * - Time-based patterns (daily, weekly, seasonal)
 * - Event injection (anomalies, emergencies)
 * - Public dataset replay (CSV, JSON)
 * - Configurable scenarios
 */

import { EventManager, EventType, EventPriority, type SystemEvent } from '@active-collaboration/core';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

const logger = createLogger('SimulatedDataSource');

export interface SimulatedDataConfig {
  enabled: boolean;
  updateIntervalMs: number;
  location: {
    latitude: number;
    longitude: number;
    timezone: string;
    name: string;
  };
  // Scenario weights (probability of each event type)
  scenarioWeights: {
    weather: number;
    airQuality: number;
    energy: number;
    traffic: number;
    security: number;
    device: number;
  };
  // Anomaly injection rate (0-1)
  anomalyRate: number;
  // Enable time-based patterns
  useTimePatterns: boolean;
  // Dataset file path (optional)
  datasetPath?: string;
}

export interface WeatherReading {
  temperature: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  windDirection: number;
  condition: 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog';
  visibility: number;
  uvIndex: number;
  timestamp: Date;
}

export interface AirQualityReading {
  aqi: number;
  pm25: number;
  pm10: number;
  o3: number;
  no2: number;
  so2: number;
  co: number;
  timestamp: Date;
}

export interface EnergyReading {
  demand: number;
  supply: number;
  price: number;
  renewablePercentage: number;
  gridFrequency: number;
  timestamp: Date;
}

export interface TrafficReading {
  congestionLevel: number;
  incidentCount: number;
  averageSpeed: number;
  vehicleCount: number;
  timestamp: Date;
}

export interface DeviceReading {
  deviceId: string;
  deviceType: string;
  state: Record<string, unknown>;
  power: number;
  status: 'online' | 'offline' | 'warning' | 'error';
  timestamp: Date;
}

export interface SecurityEvent {
  type: 'motion' | 'intrusion' | 'access' | 'alarm' | 'camera';
  location: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string;
  timestamp: Date;
}

const DEFAULT_CONFIG: SimulatedDataConfig = {
  enabled: true,
  updateIntervalMs: 5000, // 5 seconds
  location: {
    latitude: 39.9042,
    longitude: 116.4074,
    timezone: 'Asia/Shanghai',
    name: 'Beijing',
  },
  scenarioWeights: {
    weather: 0.2,
    airQuality: 0.15,
    energy: 0.2,
    traffic: 0.15,
    security: 0.15,
    device: 0.15,
  },
  anomalyRate: 0.08, // 8% anomaly rate
  useTimePatterns: true,
};

// ============================================================================
// Time Pattern Helpers
// ============================================================================

/**
 * Get time-based factors that affect sensor readings
 */
function getTimeFactors(now: Date, timezone: string = 'Asia/Shanghai'): {
  hourOfDay: number;
  dayOfWeek: number;
  isWeekday: boolean;
  isRushHour: boolean;
  isNight: boolean;
  seasonFactor: number;
} {
  const hour = now.getHours();
  const dayOfWeek = now.getDay();

  return {
    hourOfDay: hour,
    dayOfWeek: dayOfWeek,
    isWeekday: dayOfWeek >= 1 && dayOfWeek <= 5,
    isRushHour: (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19),
    isNight: hour >= 22 || hour <= 6,
    seasonFactor: Math.sin((now.getMonth() / 12) * Math.PI * 2), // -1 to 1
  };
}

/**
 * Generate correlated noise
 */
function correlatedNoise(previous: number, volatility: number, min: number, max: number): number {
  const change = (Math.random() - 0.5) * 2 * volatility;
  let newValue = previous + change;
  newValue = Math.max(min, Math.min(max, newValue));
  return newValue;
}

// ============================================================================
// SimulatedDataSource Class
// ============================================================================

export class SimulatedDataSource {
  private config: SimulatedDataConfig;
  private eventManager: EventManager;
  private updateTimer: NodeJS.Timeout | null = null;

  // State for correlated data generation
  private state = {
    temperature: 20,
    humidity: 50,
    pressure: 1013,
    aqi: 50,
    energyDemand: 20000,
    energyPrice: 35,
    trafficCongestion: 30,
  };

  // Statistics
  private stats = {
    totalEvents: 0,
    anomalyEvents: 0,
    weatherEvents: 0,
    airQualityEvents: 0,
    energyEvents: 0,
    trafficEvents: 0,
    securityEvents: 0,
    deviceEvents: 0,
  };

  // Dataset replay
  private dataset: any[] = [];
  private datasetIndex: number = 0;

  constructor(eventManager: EventManager, config: Partial<SimulatedDataConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventManager = eventManager;

    // Initialize state based on location
    this.initializeState();

    logger.info('Initialized');
    logger.info(`  Location: ${this.config.location.name}`);
    logger.info(`  Update interval: ${this.config.updateIntervalMs}ms`);
    logger.info(`  Anomaly rate: ${(this.config.anomalyRate * 100).toFixed(1)}%`);
  }

  /**
   * Initialize state based on location and time
   */
  private initializeState(): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);

    // Adjust initial temperature based on season
    this.state.temperature = 15 + factors.seasonFactor * 15;

    // Adjust initial energy demand based on time
    if (factors.isRushHour) {
      this.state.energyDemand = 30000;
      this.state.trafficCongestion = 70;
    } else if (factors.isNight) {
      this.state.energyDemand = 15000;
      this.state.trafficCongestion = 10;
    }
  }

  /**
   * Start continuous data generation
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Disabled, not starting');
      return;
    }

    logger.info('Starting data generation...');

    // Initial generation
    this.generateData();

    // Schedule periodic updates
    this.updateTimer = setInterval(() => {
      this.generateData();
    }, this.config.updateIntervalMs);
  }

  /**
   * Stop data generation
   */
  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    logger.info('Stopped');
  }

  /**
   * Generate data based on weighted scenario selection
   */
  private generateData(): void {
    const weights = this.config.scenarioWeights;
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    // Select event type based on weights
    if ((random -= weights.weather) < 0) {
      this.generateWeatherEvent();
    } else if ((random -= weights.airQuality) < 0) {
      this.generateAirQualityEvent();
    } else if ((random -= weights.energy) < 0) {
      this.generateEnergyEvent();
    } else if ((random -= weights.traffic) < 0) {
      this.generateTrafficEvent();
    } else if ((random -= weights.security) < 0) {
      this.generateSecurityEvent();
    } else {
      this.generateDeviceEvent();
    }
  }

  /**
   * Generate weather event with realistic patterns
   */
  generateWeatherEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    // Time-based temperature pattern
    // Higher during day, lower at night
    const hourFactor = Math.sin((factors.hourOfDay - 6) / 12 * Math.PI);
    const baseTemp = 20 + factors.seasonFactor * 15 + hourFactor * 5;

    // Update state with correlated noise
    this.state.temperature = correlatedNoise(
      isAnomaly ? baseTemp + 15 : baseTemp,
      2,
      -10, 45
    );
    this.state.humidity = correlatedNoise(this.state.humidity, 5, 20, 95);
    this.state.pressure = correlatedNoise(this.state.pressure, 2, 980, 1040);

    // Determine condition based on humidity and anomaly
    let condition: WeatherReading['condition'] = 'clear';
    if (isAnomaly) {
      condition = Math.random() > 0.5 ? 'storm' : 'fog';
    } else if (this.state.humidity > 80) {
      condition = Math.random() > 0.5 ? 'rain' : 'cloudy';
    } else if (this.state.humidity > 60) {
      condition = 'cloudy';
    }

    const reading: WeatherReading = {
      temperature: Math.round(this.state.temperature * 10) / 10,
      humidity: Math.round(this.state.humidity),
      pressure: Math.round(this.state.pressure),
      windSpeed: Math.round((isAnomaly ? 20 + Math.random() * 15 : 2 + Math.random() * 8) * 10) / 10,
      windDirection: Math.floor(Math.random() * 360),
      condition,
      visibility: condition === 'fog' ? 100 + Math.random() * 500 :
                 condition === 'storm' ? 500 + Math.random() * 2000 :
                 10000,
      uvIndex: factors.isNight ? 0 : Math.floor(1 + Math.random() * 10),
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (reading.temperature > 38) anomalies.push('extreme-heat');
    if (reading.temperature < -5) anomalies.push('extreme-cold');
    if (reading.condition === 'storm') anomalies.push('storm-warning');
    if (reading.windSpeed > 20) anomalies.push('high-wind');
    if (reading.visibility < 500) anomalies.push('low-visibility');

    // Determine severity for AC triggering
    const severity = anomalies.length > 0 ?
      (reading.temperature > 40 || reading.temperature < -10 ? 'critical' :
       reading.temperature > 38 || reading.temperature < -5 ? 'high' : 'medium')
      : 'normal';

    // Publish event with top-level urgency indicators for AC triggering
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:weather',
      payload: {
        dataType: 'weather',
        data: reading,
        anomalies,
        location: this.config.location.name,
        // Top-level urgency indicators for DualTriggerACManager
        severity,
        breach: anomalies.length > 0,
        temperature: reading.temperature,
      },
      priority: anomalies.length > 0 ? EventPriority.HIGH : EventPriority.NORMAL,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.weatherEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  /**
   * Generate air quality event with realistic patterns
   */
  generateAirQualityEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    // Air quality is worse during rush hour (traffic)
    let baseAqi = 50;
    if (factors.isRushHour) baseAqi = 80;
    if (factors.isWeekday && factors.hourOfDay >= 8 && factors.hourOfDay <= 18) {
      baseAqi += 20; // Work hours
    }

    // Update state
    this.state.aqi = correlatedNoise(
      isAnomaly ? baseAqi + 100 : baseAqi,
      10,
      10, 300
    );

    const reading: AirQualityReading = {
      aqi: Math.round(this.state.aqi),
      pm25: Math.round(this.state.aqi * 0.8),
      pm10: Math.round(this.state.aqi * 1.2),
      o3: Math.round(20 + Math.random() * 40),
      no2: Math.round(15 + Math.random() * 30),
      so2: Math.round(5 + Math.random() * 15),
      co: Math.round((0.3 + Math.random() * 0.5) * 100) / 100,
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (reading.aqi > 150) anomalies.push('unhealthy');
    if (reading.aqi > 200) anomalies.push('very-unhealthy');
    if (reading.pm25 > 75) anomalies.push('high-pm25');

    // Determine severity for AC triggering
    const severity = anomalies.length > 0 ?
      (reading.aqi > 200 ? 'critical' :
       reading.aqi > 150 ? 'high' : 'medium')
      : 'normal';

    // Publish event with top-level urgency indicators for AC triggering
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:air-quality',
      payload: {
        dataType: 'air-quality',
        data: reading,
        anomalies,
        location: this.config.location.name,
        // Top-level urgency indicators for DualTriggerACManager
        severity,
        breach: anomalies.length > 0,
        aqi: reading.aqi,
      },
      priority: anomalies.length > 0 ? EventPriority.HIGH : EventPriority.NORMAL,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.airQualityEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  /**
   * Generate energy grid event with realistic patterns
   */
  generateEnergyEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    // Energy demand patterns
    let baseDemand = 20000;
    if (factors.isRushHour) baseDemand = 35000;
    else if (factors.hourOfDay >= 9 && factors.hourOfDay <= 17) baseDemand = 28000;
    else if (factors.isNight) baseDemand = 15000;

    // Price correlates with demand
    let basePrice = 30;
    if (factors.isRushHour) basePrice = 55;
    if (isAnomaly) basePrice += 40;

    // Update state
    this.state.energyDemand = correlatedNoise(
      isAnomaly ? baseDemand * 1.3 : baseDemand,
      1000,
      10000, 50000
    );
    this.state.energyPrice = correlatedNoise(
      isAnomaly ? basePrice + 30 : basePrice,
      3,
      20, 120
    );

    const reading: EnergyReading = {
      demand: Math.round(this.state.energyDemand),
      supply: Math.round(this.state.energyDemand * (0.95 + Math.random() * 0.1)),
      price: Math.round(this.state.energyPrice * 100) / 100,
      renewablePercentage: Math.round(15 + Math.random() * 25),
      gridFrequency: Math.round((49.9 + Math.random() * 0.2) * 100) / 100,
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (reading.price > 60) anomalies.push('high-price');
    if (reading.price > 80) anomalies.push('peak-pricing');
    if (reading.demand > 40000) anomalies.push('high-demand');
    if (reading.gridFrequency < 49.8 || reading.gridFrequency > 50.2) {
      anomalies.push('frequency-imbalance');
    }

    // Publish event
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:energy',
      payload: {
        dataType: 'energy-grid',
        data: reading,
        anomalies,
        location: this.config.location.name,
      },
      priority: anomalies.length > 0 ? EventPriority.HIGH : EventPriority.NORMAL,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.energyEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  /**
   * Generate traffic event with realistic patterns
   */
  generateTrafficEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    // Traffic patterns
    let baseCongestion = 20;
    if (factors.isRushHour) baseCongestion = 70;
    else if (!factors.isWeekday) baseCongestion = 35;
    if (factors.isNight) baseCongestion = 10;

    // Update state
    this.state.trafficCongestion = correlatedNoise(
      isAnomaly ? 85 : baseCongestion,
      10,
      5, 100
    );

    const reading: TrafficReading = {
      congestionLevel: Math.round(this.state.trafficCongestion),
      incidentCount: isAnomaly ? Math.floor(3 + Math.random() * 5) : Math.floor(Math.random() * 2),
      averageSpeed: Math.round(80 - this.state.trafficCongestion * 0.6),
      vehicleCount: Math.round(1000 + (100 - this.state.trafficCongestion) * 20),
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (reading.congestionLevel > 70) anomalies.push('heavy-traffic');
    if (reading.incidentCount > 3) anomalies.push('multiple-incidents');
    if (reading.averageSpeed < 20) anomalies.push('gridlock');

    // Publish event
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:traffic',
      payload: {
        dataType: 'traffic',
        data: reading,
        anomalies,
        location: this.config.location.name,
      },
      priority: anomalies.length > 0 ? EventPriority.HIGH : EventPriority.NORMAL,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.trafficEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  /**
   * Generate security event
   */
  generateSecurityEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const factors = getTimeFactors(now, this.config.location.timezone);
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    // Security events more likely at night
    const eventTypes: SecurityEvent['type'][] = ['motion', 'intrusion', 'access', 'alarm', 'camera'];
    const locations = ['entrance', 'parking', 'corridor', 'server-room', 'storage', 'office-area'];

    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const severity: SecurityEvent['severity'] = isAnomaly ? 'high' :
      (Math.random() > 0.7 ? 'medium' : 'low');

    const event: SecurityEvent = {
      type: eventType,
      location: locations[Math.floor(Math.random() * locations.length)],
      severity,
      details: isAnomaly ?
        `Anomaly detected: unusual ${eventType} pattern in ${locations}` :
        `Normal ${eventType} event`,
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (event.severity === 'high' || event.severity === 'critical') {
      anomalies.push('security-alert');
    }
    if (event.type === 'intrusion') {
      anomalies.push('potential-intrusion');
    }
    if (factors.isNight && event.type === 'access') {
      anomalies.push('after-hours-access');
    }

    // Publish event with top-level urgency indicators for AC triggering
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:security',
      payload: {
        dataType: 'security',
        data: event,
        anomalies,
        location: event.location,
        // Top-level urgency indicators for DualTriggerACManager
        severity: event.severity,
        breach: event.severity === 'high' || event.severity === 'critical',
      },
      priority: anomalies.length > 0 ? EventPriority.URGENT : EventPriority.NORMAL,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.securityEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  /**
   * Generate device state event
   */
  generateDeviceEvent(forceAnomaly: boolean = false): void {
    const now = new Date();
    const isAnomaly = forceAnomaly || Math.random() < this.config.anomalyRate;

    const deviceTypes = [
      { type: 'temperature-sensor', state: { temperature: 22, unit: 'celsius' } },
      { type: 'hvac', state: { mode: 'cooling', targetTemp: 24, power: 1500 } },
      { type: 'smart-light', state: { on: true, brightness: 80, color: '#ffffff' } },
      { type: 'motion-sensor', state: { motionDetected: false, sensitivity: 'high' } },
      { type: 'smart-plug', state: { on: true, power: 45, voltage: 220 } },
      { type: 'camera', state: { recording: true, resolution: '1080p' } },
    ];

    const device = deviceTypes[Math.floor(Math.random() * deviceTypes.length)];
    const deviceId = `device-${Math.floor(Math.random() * 100)}`;

    // Modify state for anomaly
    let deviceState = { ...device.state };
    let status: DeviceReading['status'] = 'online';

    if (isAnomaly) {
      status = Math.random() > 0.5 ? 'error' : 'warning';
      if (device.type === 'temperature-sensor') {
        deviceState.temperature = 42; // Overheating
      } else if (device.type === 'hvac') {
        deviceState.power = 0; // Failed
        status = 'error';
      } else if (device.type === 'smart-plug') {
        deviceState.power = 5000; // Overload
        status = 'warning';
      }
    }

    const reading: DeviceReading = {
      deviceId,
      deviceType: device.type,
      state: deviceState,
      power: ((deviceState as unknown as Record<string, unknown>).power as number) || Math.random() * 100,
      status,
      timestamp: now,
    };

    // Detect anomalies
    const anomalies: string[] = [];
    if (status === 'error') anomalies.push('device-error');
    if (status === 'warning') anomalies.push('device-warning');
    if (reading.power > 1000) anomalies.push('high-power');

    // Publish event
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: `SimulatedDataSource:device:${deviceId}`,
      payload: {
        dataType: 'device',
        data: reading,
        anomalies,
        deviceId,
      },
      priority: anomalies.length > 0 ? EventPriority.HIGH : EventPriority.LOW,
      metadata: { simulated: true, anomaly: isAnomaly },
    });

    this.stats.deviceEvents++;
    this.stats.totalEvents++;
    if (isAnomaly) this.stats.anomalyEvents++;
  }

  // ==========================================================================
  // Burst Generation (for stress testing)
  // ==========================================================================

  /**
   * Generate burst of events for stress testing
   */
  generateBurst(count: number, anomalyRate: number = 0.2): void {
    const originalRate = this.config.anomalyRate;
    this.config.anomalyRate = anomalyRate;

    for (let i = 0; i < count; i++) {
      this.generateData();
    }

    this.config.anomalyRate = originalRate;
    logger.info(`Generated burst of ${count} events`);
  }

  /**
   * Generate specific scenario
   */
  generateScenario(scenario: 'heatwave' | 'cold-snap' | 'storm' | 'pollution' | 'blackout' | 'security-breach'): void {
    logger.info(`Generating scenario: ${scenario}`);

    switch (scenario) {
      case 'heatwave':
        this.state.temperature = 40 + Math.random() * 5;
        this.generateWeatherEvent(true);
        this.generateEnergyEvent(true);
        break;

      case 'cold-snap':
        this.state.temperature = -10 - Math.random() * 5;
        this.generateWeatherEvent(true);
        this.generateEnergyEvent(true);
        break;

      case 'storm':
        for (let i = 0; i < 5; i++) {
          this.generateWeatherEvent(true);
        }
        this.generateSecurityEvent(true);
        break;

      case 'pollution':
        this.state.aqi = 200 + Math.random() * 100;
        this.generateAirQualityEvent(true);
        break;

      case 'blackout':
        this.state.energyDemand = 50000;
        this.state.energyPrice = 100;
        this.generateEnergyEvent(true);
        for (let i = 0; i < 3; i++) {
          this.generateDeviceEvent(true);
        }
        break;

      case 'security-breach':
        for (let i = 0; i < 5; i++) {
          this.generateSecurityEvent(true);
        }
        break;
    }
  }

  // ==========================================================================
  // Dataset Replay
  // ==========================================================================

  /**
   * Load dataset from JSON array
   */
  loadDataset(data: any[]): void {
    this.dataset = data;
    this.datasetIndex = 0;
    logger.info(`Loaded ${data.length} records from dataset`);
  }

  /**
   * Replay next record from dataset
   */
  replayNext(): boolean {
    if (this.dataset.length === 0) {
      return false;
    }

    const record = this.dataset[this.datasetIndex];
    this.datasetIndex = (this.datasetIndex + 1) % this.dataset.length;

    // Publish as event
    this.eventManager.publish({
      type: EventType.DEVICE_STATE_CHANGE,
      source: 'SimulatedDataSource:dataset',
      payload: record,
      priority: EventPriority.NORMAL,
      metadata: { simulated: true, fromDataset: true },
    });

    this.stats.totalEvents++;
    return true;
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getStats() {
    return {
      ...this.stats,
      anomalyRate: this.stats.totalEvents > 0
        ? (this.stats.anomalyEvents / this.stats.totalEvents * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  getConfig(): SimulatedDataConfig {
    return { ...this.config };
  }

  /**
   * Set anomaly rate dynamically
   */
  setAnomalyRate(rate: number): void {
    this.config.anomalyRate = Math.max(0, Math.min(1, rate));
    logger.info(`Anomaly rate set to ${(this.config.anomalyRate * 100).toFixed(1)}%`);
  }

  /**
   * Enable or disable the data source
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`${enabled ? 'Enabled' : 'Disabled'}`);
  }
}

export default SimulatedDataSource;
