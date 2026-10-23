/**
 * Workflow Templates - Predefined Workflows for Common Tasks
 *
 * Ready-to-use workflow templates for common agent operations.
 */

import { WorkflowType, StepType, WorkflowTemplate, WorkflowDefinition } from './types';

/**
 * Predefined workflow templates
 */
export const WorkflowTemplates: Record<string, WorkflowTemplate> = {
  // Device Control Workflow
  DEVICE_CONTROL: {
    id: 'device_control_template',
    name: 'Device Control',
    description: 'Control IoT devices with validation and error handling',
    type: WorkflowType.DEVICE_CONTROL,
    category: 'device',
    requiredCapabilities: ['device_control'],
    inputExample: {
      deviceId: 'temp-sensor-1',
      action: 'setTemperature',
      value: 22,
    },
  },

  // Task Decomposition Workflow
  TASK_DECOMPOSITION: {
    id: 'task_decomposition_template',
    name: 'Task Decomposition',
    description: 'Break down complex tasks into subtasks using LLM',
    type: WorkflowType.TASK_DECOMPOSITION,
    category: 'planning',
    requiredCapabilities: ['planning', 'llm'],
    inputExample: {
      task: 'Design a smart home automation system',
      context: 'Home with 10 devices',
    },
  },

  // Code Generation Workflow
  CODE_GENERATION: {
    id: 'code_generation_template',
    name: 'Code Generation',
    description: 'Generate TypeScript code with testing and validation',
    type: WorkflowType.CODE_GENERATION,
    category: 'development',
    requiredCapabilities: ['code_generation', 'testing'],
    inputExample: {
      prompt: 'Create a function to sort an array',
      language: 'typescript',
    },
  },

  // Testing Workflow
  TESTING: {
    id: 'testing_template',
    name: 'Testing Workflow',
    description: 'Run tests, validate results, and generate report',
    type: WorkflowType.TESTING,
    category: 'quality',
    requiredCapabilities: ['testing'],
    inputExample: {
      testType: 'unit',
      target: 'packages/core',
    },
  },

  // Deployment Workflow
  DEPLOYMENT: {
    id: 'deployment_template',
    name: 'Deployment Pipeline',
    description: 'Build, test, and deploy application updates',
    type: WorkflowType.DEPLOYMENT,
    category: 'deployment',
    requiredCapabilities: ['build', 'test', 'deploy'],
    inputExample: {
      target: 'packages/api',
      environment: 'production',
    },
  },

  // Monitoring Workflow
  MONITORING: {
    id: 'monitoring_template',
    name: 'Monitoring Workflow',
    description: 'Monitor device health and metrics continuously',
    type: WorkflowType.MONITORING,
    category: 'operations',
    requiredCapabilities: ['monitoring', 'diagnostics'],
    inputExample: {
      devices: ['temp-sensor-1', 'hvac-controller'],
      interval: 60000,
    },
  },

  // Diagnostics Workflow
  DIAGNOSTICS: {
    id: 'diagnostics_template',
    name: 'Diagnostics Workflow',
    description: 'Run diagnostics and identify issues',
    type: WorkflowType.DIAGNOSTICS,
    category: 'maintenance',
    requiredCapabilities: ['diagnostics', 'analysis'],
    inputExample: {
      target: 'device-123',
      diagnosticType: 'health_check',
    },
  },

  // Collaboration Workflow
  COLLABORATION: {
    id: 'collaboration_template',
    name: 'Agent Collaboration',
    description: 'Coordinate tasks between multiple agents',
    type: WorkflowType.COLLABORATION,
    category: 'coordination',
    requiredCapabilities: ['communication', 'coordination'],
    inputExample: {
      task: 'Optimize energy consumption',
      participants: ['agent-1', 'agent-2'],
    },
  },

  // Data Analysis Workflow
  DATA_ANALYSIS: {
    id: 'data_analysis_template',
    name: 'Data Analysis',
    description: 'Analyze sensor data and generate insights',
    type: WorkflowType.DATA_ANALYSIS,
    category: 'analytics',
    requiredCapabilities: ['analysis', 'reporting'],
    inputExample: {
      dataSource: 'temperature-sensor',
      timeRange: '24h',
      analysisType: 'average',
    },
  },

  // Decision Making Workflow
  DECISION_MAKING: {
    id: 'decision_making_template',
    name: 'Decision Making',
    description: 'Make autonomous decisions based on data and rules',
    type: WorkflowType.DECISION_MAKING,
    category: 'autonomy',
    requiredCapabilities: ['reasoning', 'decision'],
    inputExample: {
      decisionType: 'resource_allocation',
      context: 'High load detected',
    },
  },
};

/**
 * Workflow factory - Create workflows from templates
 */
export class WorkflowFactory {
  /**
   * Create a device control workflow
   */
  static createDeviceControlWorkflow(config: {
    deviceId: string;
    action: string;
    value: any;
  }): Omit<WorkflowDefinition, 'id' | 'version'> {
    return {
      name: `Control ${config.deviceId}`,
      description: `Execute ${config.action} on device ${config.deviceId}`,
      type: WorkflowType.DEVICE_CONTROL,
      steps: [
        {
          id: 'validate',
          name: 'Validate Request',
          type: StepType.ACTION,
          action: 'validateDeviceRequest',
          parameters: config,
          required: true,
        },
        {
          id: 'execute',
          name: 'Execute Command',
          type: StepType.ACTION,
          action: 'executeDeviceCommand',
          parameters: config,
          required: true,
          nextSteps: ['verify'],
        },
        {
          id: 'verify',
          name: 'Verify Result',
          type: StepType.ACTION,
          action: 'verifyDeviceResult',
          parameters: config,
          required: true,
          errorHandling: 'continue',
        },
      ],
      inputSchema: {
        deviceId: 'string',
        action: 'string',
        value: 'any',
      },
      outputSchema: {
        success: 'boolean',
        result: 'any',
      },
      metadata: {
        tags: ['device', 'control', 'iot'],
      },
    };
  }

  /**
   * Create a task decomposition workflow
   */
  static createTaskDecompositionWorkflow(config: {
    task: string;
    context?: string;
    complexity?: 'simple' | 'moderate' | 'complex';
  }): Omit<WorkflowDefinition, 'id' | 'version'> {
    return {
      name: `Decompose: ${config.task.substring(0, 50)}...`,
      description: `Break down task: ${config.task}`,
      type: WorkflowType.TASK_DECOMPOSITION,
      steps: [
        {
          id: 'analyze',
          name: 'Analyze Task',
          type: StepType.ACTION,
          action: 'analyzeTaskComplexity',
          parameters: config,
          required: true,
          nextSteps: ['decompose'],
        },
        {
          id: 'decompose',
          name: 'Decompose Task',
          type: StepType.ACTION,
          action: 'llmTaskDecomposition',
          parameters: config,
          required: true,
          retryCount: 3,
          nextSteps: ['validate'],
        },
        {
          id: 'validate',
          name: 'Validate Subtasks',
          type: StepType.ACTION,
          action: 'validateSubtasks',
          parameters: config,
          required: true,
        },
      ],
      inputSchema: {
        task: 'string',
        context: 'string',
        complexity: 'string',
      },
      outputSchema: {
        subtasks: 'array',
        dependencies: 'array',
      },
      metadata: {
        tags: ['planning', 'decomposition', 'ai'],
      },
    };
  }

  /**
   * Create a code generation workflow
   */
  static createCodeGenerationWorkflow(config: {
    prompt: string;
    language?: string;
    test?: boolean;
  }): Omit<WorkflowDefinition, 'id' | 'version'> {
    return {
      name: `Generate ${config.language || 'TypeScript'} Code`,
      description: `Generate code for: ${config.prompt.substring(0, 50)}...`,
      type: WorkflowType.CODE_GENERATION,
      steps: [
        {
          id: 'generate',
          name: 'Generate Code',
          type: StepType.ACTION,
          action: 'llmCodeGeneration',
          parameters: config,
          required: true,
          retryCount: 3,
          nextSteps: config.test ? ['test'] : ['output'],
        },
        {
          id: 'test',
          name: 'Test Code',
          type: StepType.ACTION,
          action: 'runCodeTests',
          parameters: config,
          required: false,
          errorHandling: 'continue',
          nextSteps: ['output'],
        },
        {
          id: 'output',
          name: 'Output Code',
          type: StepType.OUTPUT,
          action: 'generated_code',
          parameters: {},
        },
      ],
      inputSchema: {
        prompt: 'string',
        language: 'string',
        test: 'boolean',
      },
      outputSchema: {
        code: 'string',
        tests: 'array',
      },
      metadata: {
        tags: ['code', 'generation', 'ai'],
      },
    };
  }

  /**
   * Create a monitoring workflow
   */
  static createMonitoringWorkflow(config: {
    devices: string[];
    interval?: number;
    duration?: number;
  }): Omit<WorkflowDefinition, 'id' | 'version'> {
    return {
      name: `Monitor ${config.devices.length} Devices`,
      description: 'Continuously monitor device health and metrics',
      type: WorkflowType.MONITORING,
      steps: [
        {
          id: 'check',
          name: 'Check Device Health',
          type: StepType.LOOP,
          action: 'checkDeviceHealth',
          parameters: config,
          loopCount: config.duration ? Math.floor(config.duration / (config.interval || 60000)) : 10,
          nextSteps: ['analyze'],
        },
        {
          id: 'analyze',
          name: 'Analyze Metrics',
          type: StepType.ACTION,
          action: 'analyzeDeviceMetrics',
          parameters: config,
          required: false,
          errorHandling: 'continue',
        },
      ],
      inputSchema: {
        devices: 'array',
        interval: 'number',
        duration: 'number',
      },
      outputSchema: {
        healthReports: 'array',
        anomalies: 'array',
      },
      metadata: {
        tags: ['monitoring', 'health', 'operations'],
      },
    };
  }

  /**
   * Create a diagnostics workflow
   */
  static createDiagnosticsWorkflow(config: {
    target: string;
    diagnosticType: 'health_check' | 'performance' | 'connectivity';
  }): Omit<WorkflowDefinition, 'id' | 'version'> {
    return {
      name: `Diagnostics: ${config.target}`,
      description: `Run ${config.diagnosticType} diagnostics on ${config.target}`,
      type: WorkflowType.DIAGNOSTICS,
      steps: [
        {
          id: 'collect',
          name: 'Collect Information',
          type: StepType.ACTION,
          action: 'collectDiagnosticInfo',
          parameters: config,
          required: true,
          nextSteps: ['analyze'],
        },
        {
          id: 'analyze',
          name: 'Analyze Results',
          type: StepType.ACTION,
          action: 'analyzeDiagnostics',
          parameters: config,
          required: true,
          nextSteps: ['report'],
        },
        {
          id: 'report',
          name: 'Generate Report',
          type: StepType.ACTION,
          action: 'generateDiagnosticReport',
          parameters: config,
          required: true,
        },
      ],
      inputSchema: {
        target: 'string',
        diagnosticType: 'string',
      },
      outputSchema: {
        diagnostics: 'object',
        recommendations: 'array',
      },
      metadata: {
        tags: ['diagnostics', 'maintenance', 'health'],
      },
    };
  }

  /**
   * Get all templates
   */
  static getAllTemplates(): WorkflowTemplate[] {
    return Object.values(WorkflowTemplates);
  }

  /**
   * Get template by ID
   */
  static getTemplate(id: string): WorkflowTemplate | null {
    return WorkflowTemplates[id] || null;
  }

  /**
   * Get templates by type
   */
  static getTemplatesByType(type: WorkflowType): WorkflowTemplate[] {
    return Object.values(WorkflowTemplates).filter((t) => t.type === type);
  }

  /**
   * Get templates by category
   */
  static getTemplatesByCategory(category: string): WorkflowTemplate[] {
    return Object.values(WorkflowTemplates).filter((t) => t.category === category);
  }
}

/**
 * Re-exports
 */
export * from './types';
export { WorkflowEngine } from './WorkflowEngine';
