/**
 * Rich Service Capability Model
 * For precise LLM-based service matching and composition
 */

/**
 * Data flow direction of a service
 */
export type DataFlowDirection = 'input' | 'output' | 'bidirectional' | 'none';

/**
 * Operation complexity level
 */
export type OperationComplexity = 'simple' | 'composite' | 'conditional' | 'iterative';

/**
 * Operation type with semantic meaning
 */
export type OperationType =
  | 'read'           // Read data without modification
  | 'write'          // Modify state/data
  | 'transform'      // Convert data from one form to another
  | 'aggregate'      // Combine multiple inputs into one output
  | 'validate'       // Check if data meets criteria
  | 'filter'         // Select subset of data based on conditions
  | 'coordinate'     // Orchestrate multiple operations
  | 'analyze'        // Process data to extract insights
  | 'execute'        // Run a procedure/algorithm
  | 'monitor'        // Continuously observe and alert
  | 'synthesize';    // Create new capability from multiple resources

/**
 * Data type the service operates on
 */
export type DataType =
  | 'numeric'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'json'
  | 'timeseries'
  | 'geolocation'
  | 'binary'
  | 'mixed';

/**
 * Temporal characteristics
 */
export type TemporalCharacteristic =
  | 'instant'        // Single operation, no time dimension
  | 'discrete'       // One-time but may take time
  | 'continuous'     // Ongoing operation
  | 'scheduled'      // Runs at specific times
  | 'reactive'       // Triggered by events
  | 'historical';    // Operates on past data

/**
 * Rich service capability description
 */
export interface RichServiceCapability {
  // Core operation
  operationType: OperationType;
  dataFlow: DataFlowDirection;
  dataType: DataType;
  temporal: TemporalCharacteristic;

  // Semantic description for LLM
  description: string;
  canDo: string[];      // Explicit CAN statements
  cannotDo: string[];   // Explicit CANNOT statements

  // Composition and dependencies
  requires?: string[];  // What this capability needs
  provides?: string[];  // What this capability offers
  conflicts?: string[]; // What this capability conflicts with

  // Constraints and limits
  constraints?: CapabilityConstraint[];

  // Complexity
  complexity: OperationComplexity;

  // Examples for LLM understanding
  examples?: {
    input: any;
    output: any;
    scenario: string;
  }[];
}

/**
 * Capability constraints
 */
export interface CapabilityConstraint {
  type: 'range' | 'enum' | 'rate' | 'dependency' | 'permission';
  description: string;
  value?: any;
}

/**
 * Service composition template
 * For synthesizing new services from multiple resources
 */
export interface ServiceComposition {
  name: string;
  description: string;
  operationType: OperationType;

  // What resources are needed
  requiredCapabilities: string[];

  // How to combine them
  compositionLogic: 'sequential' | 'parallel' | 'conditional' | 'iterative' | 'reduce';

  // Transformation steps
  steps: CompositionStep[];

  // What the composed service provides
  providesCapabilities: string[];

  // Whether additional code is needed
  requiresImplementation: boolean;
  implementationHint?: string;
}

/**
 * A single composition step
 */
export interface CompositionStep {
  stepNumber: number;
  description: string;
  sourceCapability: string;
  operation: 'extract' | 'transform' | 'combine' | 'filter' | 'validate' | 'aggregate';
  outputVariable: string;
  condition?: string; // For conditional steps
}

/**
 * Service synthesis result
 */
export interface ServiceSynthesis {
  possible: boolean;
  synthesizedService?: {
    name: string;
    capabilities: RichServiceCapability[];
    compositionPlan: ServiceComposition;
    estimatedReliability: number; // 0-1
    requiresCodeGeneration: boolean;
  };
  reason?: string;
  missingCapabilities?: string[];
}
