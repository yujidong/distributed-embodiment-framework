/**
 * Formal Requirement Specification Model
 *
 * Defines interfaces for requirement specifications, test cases,
 * validation contexts, and validation results.
 *
 * This model provides a three-stage validation framework:
 * 1. Service Creation Validation
 * 2. Pre-Execution Validation
 * 3. Post-Execution Validation
 */

/**
 * Requirement Specification
 *
 * Formal specification of what a service must provide and how it should behave
 * Combines schema validation, test cases, and context requirements
 */
export interface RequirementSpec {
  // Identification
  id: string;
  name: string;
  version: string;
  description: string;
  category: RequirementCategory;

  // Schema-based validation (structural)
  schema: JSONSchema;

  // Behavioral validation (test cases)
  testCases: TestCase[];

  // Context requirements (when/where/how service can be used)
  contextRequirements: ValidationContext;

  // Semantic annotations (for matching)
  semanticAnnotations: SemanticRequirement;

  // Metadata
  createdAt: Date;
  createdBy: string; // Agent or user ID
  tags: string[];

  // Compliance level
  complianceLevel: 'strict' | 'moderate' | 'flexible';
}

/**
 * Requirement Categories
 */
export type RequirementCategory =
  | 'sensing'
  | 'acting'
  | 'processing'
  | 'communication'
  | 'collaboration'
  | 'composite';

/**
 * JSON Schema for structural validation
 * Standard JSON Schema draft 7 specification with IoT-specific extensions
 */
export interface JSONSchema {
  $schema?: string; // Best practice: Always specify version
  $id?: string;
  title: string;
  description?: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;

  // Validation keywords
  minimum?: number;
  maximum?: number;
  enum?: any[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;

  // IoT-specific extensions
  iotConstraints?: IOTConstraints;
}

/**
 * IoT-specific constraints
 */
export interface IOTConstraints {
  range?: { min: number; max: number; unit?: string };
  precision?: number;
  refreshRate?: { min: number; max: number; unit: string };
  accuracy?: { value: number; unit?: string };
}

/**
 * Test Case Definition
 * Defines expected behavior with concrete inputs and outputs
 */
export interface TestCase {
  id: string;
  name: string;
  description: string;

  // Input specification
  input: {
    parameters: Record<string, any>;
    preConditions?: Record<string, any>;
    context?: Partial<ValidationContext>;
  };

  // Expected output
  expectedOutput: {
    result?: any;
    postConditions?: Record<string, any>;
    effects?: EffectExpectation[];
  };

  // Execution constraints
  constraints: {
    maxExecutionTime?: number; // milliseconds
    maxCost?: number;
    requiredResources?: string[];
  };

  // Validation criteria
  validationCriteria: RequirementValidationCriterion[];

  // Priority and weight
  priority: 'critical' | 'high' | 'medium' | 'low';
  weight: number; // For scoring overall compliance
}

/**
 * Effect Expectation
 * Expected changes in the environment or device state
 */
export interface EffectExpectation {
  type: 'state-change' | 'value-change' | 'event-emission' | 'resource-consumption';
  target: string; // Device ID or resource ID
  property: string;
  expectedValue: any;
  tolerance?: {
    absolute?: number;
    relative?: number; // percentage
  };
}

/**
 * Requirement Validation Criterion
 * Single verifiable criterion for requirement validation
 */
export interface RequirementValidationCriterion {
  id: string;
  type: CriterionType;
  description: string;

  // How to verify
  verificationMethod: VerificationMethod;

  // Expected outcome
  expectedResult: any;

  // Tolerance (for numeric values)
  tolerance?: {
    absolute?: number;
    relative?: number; // percentage
  };

  // Severity
  severity: 'error' | 'warning' | 'info';
}

/**
 * Criterion types
 */
export type CriterionType =
  | 'value-equality'
  | 'range-check'
  | 'state-change'
  | 'timing-constraint'
  | 'resource-usage'
  | 'qos-metric'
  | 'custom';

/**
 * Verification method
 * Defines how to verify a criterion
 */
export interface VerificationMethod {
  type: 'automated' | 'manual' | 'hybrid';

  // For automated verification
  automatedCheck?: {
    type: 'function' | 'expression' | 'query';
    expression: string; // JavaScript expression or query
    evaluator?: string; // Evaluator module path
  };

  // For manual verification
  manualCheck?: {
    instructions: string;
    evidenceRequired?: string[];
  };

  // For hybrid (automated + human review)
  hybridCheck?: {
    automatedPart: string;
    manualPart: string;
  };
}

/**
 * Validation Context
 * Defines the three-dimensional context for requirement validation
 */
export interface ValidationContext {
  // Physical context (where and when)
  physical: PhysicalContext;

  // Task context (why and what priority)
  task: RequirementTaskContext;

  // Service context (what's available and at what cost)
  service: RequirementServiceContext;
}

/**
 * Physical Context
 * Spatial and temporal constraints
 */
export interface PhysicalContext {
  // Location constraints
  location: {
    type: 'indoor' | 'outdoor' | 'mobile' | 'distributed';
    coordinates?: { latitude: number; longitude: number };
    area?: { radius: number; unit: string };
    environmentId?: string; // Environment Center ID
  };

  // Temporal constraints
  temporal: {
    validFrom?: Date;
    validUntil?: Date;
    timeOfDay?: {
      start?: string; // HH:MM format
      end?: string;
    };
    daysOfWeek?: string[]; // ['monday', 'tuesday', ...]
    timezone?: string;
  };

  // Environmental parameters
  environmental: {
    temperature?: { min: number; max: number; unit: string };
    humidity?: { min: number; max: number; unit: string };
    lighting?: { min: number; max: number; unit: string };
    noiseLevel?: { max: number; unit: string };
    airQuality?: { min: number; max: number };
  };
}

/**
 * Requirement Task Context
 * Why the service is needed and priority
 */
export interface RequirementTaskContext {
  taskId: string;

  // Task characteristics
  priority: 'low' | 'medium' | 'high' | 'urgent';
  urgency: 'immediate' | 'urgent' | 'normal' | 'low';

  // Dependencies
  dependencies: {
    taskIds: string[];
    services: string[];
    order: 'sequential' | 'parallel' | 'conditional';
  };

  // Deadline
  deadline?: {
    hardDeadline: Date;
    softDeadline?: Date;
    penalties?: {
      afterSoftDeadline: number; // cost per time unit
      afterHardDeadline: number;
    };
  };

  // Historical context
  history: {
    previousExecutions?: number;
    successRate?: number; // 0-1
    lastExecution?: Date;
    averageExecutionTime?: number; // milliseconds
  };

  // User preferences
  preferences: {
    costSensitivity?: 'low' | 'medium' | 'high';
    qualitySensitivity?: 'low' | 'medium' | 'high';
    latencySensitivity?: 'low' | 'medium' | 'high';
    preferredProviders?: string[];
    excludedProviders?: string[];
  };
}

/**
 * Requirement Service Context
 * Available services and their characteristics
 */
export interface RequirementServiceContext {
  // Available services
  availableServices: ServiceContextItem[];

  // QoS requirements
  qosRequirements: {
    maxLatency?: number;
    minAvailability?: number; // 0-1
    minReliability?: number; // 0-1
    maxCost?: number;
    preferredResponseTime?: number;
  };

  // Resource constraints
  resourceConstraints: {
    maxConcurrentUses?: number;
    exclusiveUse?: boolean;
    quota?: {
      limit: number;
      period: number; // milliseconds
    };
  };

  // Trust and reputation
  trustContext: {
    minReputation?: number; // 0-1
    requireVerification?: boolean;
    previousCollaborations?: PreviousCollaboration[];
  };
}

/**
 * Service Context Item
 * Snapshot of a service's current state
 */
export interface ServiceContextItem {
  serviceId: string;
  serviceType: string;
  providerId: string;

  // Current state
  currentLoad: number; // 0-1
  availability: number; // 0-1
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';

  // Capabilities
  capabilities: string[];
  categories: string[];

  // Performance metrics
  performance: {
    averageResponseTime?: number; // milliseconds
    successRate?: number; // 0-1
    throughput?: number;
  };

  // Cost
  cost: {
    monetary?: number;
    computational?: number;
    energy?: number;
  };
}

/**
 * Previous collaboration record
 */
export interface PreviousCollaboration {
  providerId: string;
  successCount: number;
  failureCount: number;
  averageQuality: number; // 0-1
}

/**
 * Validation Result
 * Comprehensive result of requirement validation
 */
export interface ValidationResult {
  // Identification
  validationId: string;
  requirementId: string;
  targetId: string; // Service ID, AC ID, or execution ID
  validationType: ValidationType;
  timestamp: Date;

  // Overall outcome
  outcome: ValidationOutcome;

  // Detailed scores
  scores: ValidationScores;

  // Test results
  testResults: TestResult[];

  // Violations and warnings
  violations: ValidationViolation[];
  warnings: ValidationWarning[];

  // Metrics
  metrics: ValidationMetrics;

  // Recommendation
  recommendation: ValidationRecommendation;

  // Supporting evidence
  evidence: ValidationEvidence[];
}

/**
 * Validation type
 */
export type ValidationType =
  | 'service-creation'
  | 'pre-execution'
  | 'post-execution';

/**
 * Validation outcome
 */
export type ValidationOutcome =
  | 'full-compliance'
  | 'partial-compliance'
  | 'non-compliance'
  | 'validation-error';

/**
 * Validation scores
 */
export interface ValidationScores {
  overall: number; // 0-1
  structural: number; // Schema compliance
  behavioral: number; // Test case pass rate
  contextual: number; // Context satisfaction
  semantic: number; // Semantic matching
}

/**
 * Test result
 */
export interface TestResult {
  testCaseId: string;
  testCaseName: string;
  passed: boolean;
  score: number; // 0-1

  // Actual vs expected
  actualOutput?: any;
  expectedOutput?: any;

  // Deviation analysis
  deviations: Deviation[];

  // Execution metrics
  executionTime?: number;
  resourceUsage?: Record<string, number>;
}

/**
 * Deviation
 */
export interface Deviation {
  type: 'value' | 'timing' | 'quality' | 'context' | 'state-change';
  description: string;
  severity: 'minor' | 'moderate' | 'major' | 'critical';
  actual: any;
  expected: any;
  tolerance?: number | { relative: number; absolute: number };
}

/**
 * Validation violation
 */
export interface ValidationViolation {
  ruleId: string;
  ruleType: 'schema' | 'test-case' | 'context' | 'semantic';
  severity: 'error' | 'warning';
  message: string;

  // Location of violation
  location: {
    component: string;
    path?: string; // JSON path or code reference
  };

  // Suggested fix
  suggestion?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning';

  // Conditions that triggered warning
  conditions: Record<string, any>;

  // Recommendations
  recommendations: string[];
}

/**
 * Validation metrics
 */
export interface ValidationMetrics {
  // Performance metrics
  validationTime: number; // milliseconds
  testExecutionTime: number;

  // Coverage metrics
  testCoverage: number; // percentage
  contextCoverage: number; // percentage

  // Quality metrics
  confidence: number; // 0-1
  completeness: number; // 0-1
}

/**
 * Validation recommendation
 */
export interface ValidationRecommendation {
  decision: 'approve' | 'conditional-approve' | 'reject' | 'need-review';
  confidence: number; // 0-1
  reasoning: string;

  // Conditions for conditional approval
  conditions?: string[];

  // Alternative actions
  alternatives?: AlternativeAction[];
}

/**
 * Alternative action
 */
export interface AlternativeAction {
  action: string;
  description: string;
  expectedOutcome: string;
  tradeoffs: string[];
}

/**
 * Validation evidence
 */
export interface ValidationEvidence {
  type: 'log' | 'metric' | 'snapshot' | 'assertion';
  data: any;
  timestamp: Date;
  source: string;
}

/**
 * Semantic Requirement
 * Ontology-based semantic matching requirements
 */
export interface SemanticRequirement {
  // Ontology class (SSN/SAREF based)
  ontologyClass: string;

  // Semantic capabilities
  semanticCapabilities: SemanticCapability[];

  // Relationships to other requirements
  relationships?: SemanticRelationship[];

  // Natural language description (for LLM matching)
  naturalLanguageDescription: string;

  // Alternative terms (for fuzzy matching)
  alternativeTerms: string[];
}

/**
 * Semantic capability
 */
export interface SemanticCapability {
  capability: string;
  category: 'sensing' | 'acting' | 'processing' | 'communication';

  // Parameter constraints
  parameters?: {
    name: string;
    type: string;
    constraints?: Record<string, any>;
  }[];

  // Required precision/accuracy
  accuracy?: {
    min: number;
    preferred: number;
    unit?: string;
  };
}

/**
 * Semantic relationship
 */
export interface SemanticRelationship {
  type: 'equivalent-to' | 'sub-class-of' | 'part-of' | 'precedes' | 'complements';
  target: string; // Ontology class or capability
  strength: number; // 0-1
}
