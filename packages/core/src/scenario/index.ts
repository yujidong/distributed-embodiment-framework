/**
 * Scenario Module — versioned scenario JSON schema, loader, and types
 *
 * Public surface:
 * - `loadScenarioFile(json)` / `loadScenarioFromFile(path)` → `ScenarioDefinition`
 * - `ScenarioValidationError` for descriptive load failures
 * - `SCENARIO_JSON_SCHEMA` for tooling (editors, docs)
 * - The `Scenario*` types for consumers building scenarios programmatically
 * - Building tier (B-C): `BuildingIR` types, `compileBuildingIR` (IR →
 *   scenario JSON v1.0), `parseIfcToIR` (IFC/STEP → IR via web-ifc)
 * - Building tier (B-D): `recognizeFloorplan` / `buildFloorplanIR`
 *   (floor-plan image → IR via a multimodal LLM), scale calibration helpers,
 *   `createVisionClientFromEnv` (vision LLM client factory)
 */

export * from './scenario-types.js';
export {
  STANDARD_PHYSICAL_PARAMETERS,
  isStandardPhysicalParameter,
} from './standard-parameters.js';
export { SCENARIO_JSON_SCHEMA, createScenarioValidator } from './scenario-schema.js';
export {
  ScenarioValidationError,
  ScenarioFlowValidationError,
  loadScenarioFile,
  loadScenarioFromFile,
  classifyCapability,
  inferDeviceRole,
  type ScenarioLoadOptions,
} from './scenario-loader.js';

// Building tier (B-C): Building IR, IR→scenario compiler, IFC importer.
// The IFC parser lazy-loads web-ifc, so these exports cost nothing until
// `parseIfcToIR` is actually called.
export * from './building-ir.js';
export {
  BuildingCompileError,
  compileBuildingIR,
  type CompileOptions,
  type CompiledScenarioFile,
} from './building-compiler.js';
export {
  IfcParseError,
  parseIfcToIR,
  type IfcImportResult,
  type ParseIfcOptions,
} from './ifc-parser.js';

// Drawing vision importer (B-D): floor-plan image → IR via multimodal LLM,
// caller-confirmed scale calibration, and a pluggable CV preprocessor seam.
export {
  DEFAULT_VISION_TIMEOUT_MS,
  FLOORPLAN_RECOGNITION_SCHEMA,
  FloorplanVisionError,
  buildFloorplanIR,
  noopFloorplanPreprocessor,
  parseRecognition,
  pixelsPerMeterFromCalibration,
  recognizeFloorplan,
  resolveFloorplanScale,
  type CandidateRoomBox,
  type FloorplanIRInput,
  type FloorplanImage,
  type FloorplanPreprocessResult,
  type FloorplanPreprocessor,
  type FloorplanRecognition,
  type RecognizeFloorplanOptions,
  type RecognizedConnection,
  type RecognizedRoom,
  type ResolvedScale,
  type ScaleCalibrationSegment,
  type ScaleSuggestion,
  type VisionChatClient,
} from './floorplan-vision.js';
export {
  createVisionClientFromEnv,
  DEFAULT_VISION_MODEL,
  type VisionClientOptions,
} from './floorplan-vision-client.js';

// NL environment importer (UX wave-5): one-sentence description → IR via a
// text LLM (the NL function route), repeat/count collapse, synthesized
// geometry/circulation, device placements from the template vocabulary.
export {
  DEFAULT_NL_TIMEOUT_MS,
  NL_IMPORT_SCHEMA,
  NL_ZONE_TYPE_VOCABULARY,
  NLImportError,
  buildNLImportIR,
  buildNLImportSystemPrompt,
  parseNLRecognition,
  recognizeEnvironmentFromText,
  type BuildNLImportIROptions,
  type NLAgentSkeleton,
  type NLBuildResult,
  type NLDevicePlacement,
  type NLEnvironmentRecognition,
  type NLExpandedAgent,
  type NLExpandedDevice,
  type NLFloorPattern,
  type NLImportChatClient,
  type NLRoomPattern,
  type NLVocabulary,
  type RecognizeNLOptions,
} from './nl-import.js';
