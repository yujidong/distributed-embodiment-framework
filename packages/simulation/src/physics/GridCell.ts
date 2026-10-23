/**
 * Grid Cell
 *
 * Represents a single cell in the spatial physics grid.
 * Each cell stores all physical parameters for that location.
 */

import { PhysicalParameter } from '../devices/types.js';

/**
 * Grid cell coordinates
 */
export interface GridCoordinates {
  x: number; // Grid X index
  y: number; // Grid Y index
  z: number; // Grid Z index (optional, for 3D)
}

/**
 * Grid cell state
 */
export interface GridCellState {
  // Environmental parameters
  temperature: number;
  humidity: number;
  light: number;
  airQuality: number;
  co2: number;
  pm25: number;
  motion: boolean;
  presence: boolean;

  // Material properties (for physics calculations)
  thermalMass?: number; // J/K (heat capacity)
  insulation?: number; // 0-1 (1 = perfectly insulated)
  ventilation?: number; // 0-1 (1 = fully ventilated)
}

/**
 * Grid cell with metadata
 */
export class GridCell {
  readonly coordinates: GridCoordinates;
  readonly position: { x: number; y: number; z: number }; // World position in meters
  readonly size: number; // Cell size in meters
  state: GridCellState;
  metadata?: Record<string, unknown>;

  // Neighboring cells (for diffusion calculations)
  neighbors: Map<string, GridCell> = new Map();

  // Effect accumulators (for device effects)
  temperatureEffect: number = 0; // Accumulated heating/cooling (W)
  humidityEffect: number = 0; // Accumulated humidity change (%)
  lightEffect: number = 0; // Accumulated light (lux)

  constructor(
    coordinates: GridCoordinates,
    position: { x: number; y: number; z: number },
    size: number,
    initialState?: Partial<GridCellState>
  ) {
    this.coordinates = coordinates;
    this.position = position;
    this.size = size;

    // Initialize state with defaults
    this.state = {
      temperature: initialState?.temperature ?? 22,
      humidity: initialState?.humidity ?? 50,
      light: initialState?.light ?? 500,
      airQuality: initialState?.airQuality ?? 50,
      co2: initialState?.co2 ?? 400,
      pm25: initialState?.pm25 ?? 10,
      motion: initialState?.motion ?? false,
      presence: initialState?.presence ?? false,
      thermalMass: initialState?.thermalMass,
      insulation: initialState?.insulation,
      ventilation: initialState?.ventilation,
    };
  }

  /**
   * Get parameter value
   */
  getParameter(parameter: PhysicalParameter): number | boolean {
    switch (parameter) {
      case 'temperature':
        return this.state.temperature;
      case 'humidity':
        return this.state.humidity;
      case 'light':
        return this.state.light;
      case 'air_quality':
        return this.state.airQuality;
      case 'co2':
        return this.state.co2;
      case 'pm2_5':
        return this.state.pm25;
      case 'motion':
        return this.state.motion;
      case 'presence':
        return this.state.presence;
      default:
        return 0;
    }
  }

  /**
   * Set parameter value
   */
  setParameter(parameter: PhysicalParameter, value: number | boolean): void {
    switch (parameter) {
      case 'temperature':
        this.state.temperature = value as number;
        break;
      case 'humidity':
        this.state.humidity = Math.max(0, Math.min(100, value as number));
        break;
      case 'light':
        this.state.light = Math.max(0, value as number);
        break;
      case 'air_quality':
        this.state.airQuality = Math.max(0, Math.min(100, value as number));
        break;
      case 'co2':
        this.state.co2 = Math.max(0, value as number);
        break;
      case 'pm2_5':
        this.state.pm25 = Math.max(0, value as number);
        break;
      case 'motion':
        this.state.motion = value as boolean;
        break;
      case 'presence':
        this.state.presence = value as boolean;
        break;
    }
  }

  /**
   * Add temperature effect (heating/cooling)
   * @param power - Power in Watts
   */
  addTemperatureEffect(power: number): void {
    this.temperatureEffect += power;
  }

  /**
   * Add humidity effect
   * @param delta - Humidity change in %
   */
  addHumidityEffect(delta: number): void {
    this.humidityEffect += delta;
  }

  /**
   * Add light effect
   * @param intensity - Light intensity in lux
   */
  addLightEffect(intensity: number): void {
    this.lightEffect += intensity;
  }

  /**
   * Apply accumulated effects and reset accumulators
   * @param deltaTime - Time delta in seconds
   */
  applyEffects(deltaTime: number): void {
    // Apply temperature effect (Q = P * t, ΔT = Q / mc)
    if (Math.abs(this.temperatureEffect) > 0.1) {
      const thermalMass = this.state.thermalMass || 123.1; // Default: 100m³ air
      const energyInput = this.temperatureEffect * deltaTime; // Joules
      const tempChange = energyInput / thermalMass; // °C
      this.state.temperature += tempChange;
      this.temperatureEffect = 0;
    }

    // Apply humidity effect (simplified linear)
    if (Math.abs(this.humidityEffect) > 0.1) {
      this.state.humidity = Math.max(0, Math.min(100, this.state.humidity + this.humidityEffect));
      this.humidityEffect = 0;
    }

    // Apply light effect (direct set for immediate effects)
    if (this.lightEffect > 0) {
      this.state.light = this.lightEffect;
      this.lightEffect = 0;
    }
  }

  /**
   * Calculate diffusion to/from neighbors
   * @param deltaTime - Time delta in seconds
   * @param diffusivity - Diffusion coefficient (0-1)
   */
  calculateDiffusion(deltaTime: number, diffusivity: number = 0.1): void {
    if (this.neighbors.size === 0) {
      return;
    }

    // Average temperature of neighbors
    let neighborTempSum = 0;
    let neighborCount = 0;

    for (const neighbor of this.neighbors.values()) {
      neighborTempSum += neighbor.state.temperature;
      neighborCount++;
    }

    if (neighborCount === 0) {
      return;
    }

    const avgNeighborTemp = neighborTempSum / neighborCount;
    const tempDifference = avgNeighborTemp - this.state.temperature;

    // Apply diffusion (Newton's law of cooling / heat equation)
    const tempChange = tempDifference * diffusivity * deltaTime;
    this.state.temperature += tempChange;
  }

  /**
   * Get cell ID (unique identifier)
   */
  getCellId(): string {
    return `${this.coordinates.x},${this.coordinates.y},${this.coordinates.z}`;
  }

  /**
   * Clone cell state
   */
  cloneState(): GridCellState {
    return { ...this.state };
  }
}
