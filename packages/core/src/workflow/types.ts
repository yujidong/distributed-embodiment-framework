/**
 * Workflow Engine Type Definitions
 *
 * Business process execution for agents with workflow definition,
 * execution engine, and persistence in memory.
 */

/**
 * Workflow types matching the business needs
 */
export enum WorkflowType {
  DEVICE_CONTROL = 'device_control',
  TASK_DECOMPOSITION = 'task_decomposition',
  CODE_GENERATION = 'code_generation',
  TESTING = 'testing',
  DEPLOYMENT = 'deployment',
  MONITORING = 'monitoring',
  DIAGNOSTICS = 'diagnostics',
  COLLABORATION = 'collaboration',
  DATA_ANALYSIS = 'data_analysis',
  DECISION_MAKING = 'decision_making',
}

/**
 * Workflow execution status
 */
export enum WorkflowStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Workflow step types
 */
export enum StepType {
  ACTION = 'action',           // Execute an action
  CONDITION = 'condition',     // Branch based on condition
  LOOP = 'loop',               // Repeat steps
  PARALLEL = 'parallel',       // Execute steps in parallel
  DELAY = 'delay',             // Wait before next step
  INPUT = 'input',             // Request user input
  OUTPUT = 'output',           // Return output
}

/**
 * Workflow step definition
 */
export interface WorkflowStep {
  id: string;
  name: string;
  type: StepType;
  action: string;               // Action identifier or function name
  parameters: Record<string, any>;
  nextSteps?: string[];         // IDs of next steps
  condition?: string;           // Condition expression (for CONDITION type)
  loopCount?: number;           // Number of iterations (for LOOP type)
  delayMs?: number;             // Delay in milliseconds (for DELAY type)
  timeoutMs?: number;           // Step timeout
  required?: boolean;           // Whether step is required
  errorHandling?: 'continue' | 'stop' | 'retry';
  retryCount?: number;          // Number of retries on failure
}

/**
 * Workflow definition
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  type: WorkflowType;
  version: string;
  steps: WorkflowStep[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  metadata: WorkflowMetadata;
}

/**
 * Workflow metadata
 */
export interface WorkflowMetadata {
  author?: string;
  createdAt?: number;
  updatedAt?: number;
  tags: string[];
  dependencies?: string[];
  successRate?: number;
  averageDuration?: number;
  executionCount?: number;
  timeoutMs?: number;
  retryPolicy?: 'none' | 'linear' | 'exponential';
  maxRetries?: number;
}

/**
 * Workflow execution context
 */
export interface WorkflowContext {
  workflowId: string;
  executionId: string;
  input: Record<string, any>;
  output: Record<string, any>;
  variables: Record<string, any>;
  currentStepId?: string;
  status: WorkflowStatus;
  startedAt: number;
  completedAt?: number;
  error?: Error;
  stepsExecuted: string[];
  stepsSkipped: string[];
  logs: WorkflowLog[];
}

/**
 * Workflow log entry
 */
export interface WorkflowLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  stepId?: string;
  message: string;
  data?: any;
}

/**
 * Workflow execution result
 */
export interface WorkflowResult {
  success: boolean;
  output: Record<string, any>;
  context: WorkflowContext;
  executionTime: number;
  stepsExecuted: number;
  error?: Error;
}

/**
 * Workflow template reference
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  type: WorkflowType;
  category: string;
  requiredCapabilities: string[];
  inputExample: Record<string, any>;
}

/**
 * Workflow action handler
 */
export interface ActionHandler {
  (context: WorkflowContext, step: WorkflowStep): Promise<Record<string, any>>;
}
