/**
 * Physics Simulation Module
 *
 * Provides physics-based simulation for IoT devices and environment.
 * Includes heat transfer models, state interpolation, and device effects.
 *
 * Architecture:
 * - PhysicsLayer: Coordinator between devices and physics
 * - SpatialPropagationEngine: Pure spatial effect propagation (device-agnostic)
 * - EffectSource: Abstract representation of physical effect sources
 * - HeatTransferModel: Thermal calculations
 * - StateInterpolator: Smooth state transitions
 */

// HeatTransferModel - Physics calculations for HVAC
export {
  HeatTransferModel,
  type HeatTransferConfig,
  type HeatTransferResult,
} from './HeatTransferModel.js';

// StateInterpolator - Smooth state transitions
export {
  StateInterpolator,
  type InterpolationConfig,
  type StateSnapshot,
  type StateHistory,
} from './StateInterpolator.js';

// EffectSource - Abstract effect source (device-agnostic)
export {
  EffectSourceRegistry,
  PhysicalEffectType,
  type EffectSource,
  type PhysicalFalloffType,
} from './EffectSource.js';

// SpatialPropagationEngine - Pure spatial effect propagation
export {
  SpatialPropagationEngine,
  type PropagationLocation,
  type PropagationResult,
} from './SpatialPropagationEngine.js';

// PhysicsLayer - Main physics orchestration (coordinator)
export {
  PhysicsLayer,
  type DevicePhysicsEffect,
  type PhysicsUpdateResult,
  type PhysicsLayerConfig,
  type StateChangeEvent,
} from './PhysicsLayer.js';

// Grid-based physics simulation
export {
  GridCell,
  type GridCoordinates,
  type GridCellState,
} from './GridCell.js';

export {
  SpatialGrid,
  type SpatialGridConfig,
} from './SpatialGrid.js';

export {
  GridPhysicsEngine,
  type GridPhysicsEngineConfig,
} from './GridPhysicsEngine.js';

// Thermal Comfort Model - PMV/PPD calculations (ASHRAE 55)
export {
  ThermalComfortModel,
  type ThermalComfortConfig,
  type ThermalComfortResult,
  type ThermalSensation,
} from './ThermalComfortModel.js';

// Airflow Model - Convection calculations
export {
  AirflowModel,
  type AirflowConfig,
  type AirflowState,
  type ConvectionResult,
  type HVACAirflowSource,
} from './AirflowModel.js';

// Zone Transfer Model - Inter-zone heat transfer
export {
  ZoneTransferModel,
  type ZoneConnection,
  type ZoneTransferResult,
  type ZoneTransferConfig,
} from './ZoneTransferModel.js';

// Humidity Model - Phase change and diffusion
export {
  HumidityModel,
  type HumidityConfig,
  type HumidityState,
  type CondensationResult,
} from './HumidityModel.js';

// Air Quality Model - Pollutant dispersion
export {
  AirQualityModel,
  type PollutantSource,
  type PollutantType,
  type AirQualityConfig,
  type AirQualityResult,
  type HealthRisk,
  type ExposureLevel,
} from './AirQualityModel.js';
