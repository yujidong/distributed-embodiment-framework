/**
 * Workflow Engine Tests
 *
 * Tests for WorkflowEngine, workflow templates, and execution
 */

import { WorkflowEngine } from './WorkflowEngine.js';
import { WorkflowFactory } from './WorkflowTemplates.js';
import {
  WorkflowType,
  StepType,
  type WorkflowDefinition,
  type WorkflowContext,
  type WorkflowStep,
} from './types.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('test');



async function runTests() {
  logger.info('====================================');
  logger.info('Workflow Engine Tests');
  logger.info('====================================\n');

  const timestamp = Date.now();

  // ========================================================================
  // Test 1: WorkflowEngine Initialization
  // ========================================================================
  logger.info(`[${timestamp}] Test 1: WorkflowEngine Initialization`);

  try {
    const engine = new WorkflowEngine();
    const workflows = engine.listWorkflows();

    logger.info(`[${timestamp}] Initial workflows count: ${workflows.length}`);
    if (workflows.length !== 0) {
      throw new Error('Expected 0 workflows initially');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 2: Define and Retrieve Workflow
  // ========================================================================
  logger.info(`[${timestamp}] Test 2: Define and Retrieve Workflow`);

  try {
    const engine = new WorkflowEngine();

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Test Workflow',
      description: 'A simple test workflow',
      type: WorkflowType.DEVICE_CONTROL,
      steps: [
        {
          id: 'step1',
          name: 'First Step',
          type: StepType.ACTION,
          action: 'testAction',
          parameters: { test: true },
          required: true,
        },
      ],
      inputSchema: { test: 'string' },
      outputSchema: { result: 'boolean' },
      metadata: { tags: ['test'] },
    };

    const defined = engine.defineWorkflow(workflow);
    logger.info(`[${timestamp}] Workflow ID: ${defined.id}`);
    logger.info(`[${timestamp}] Workflow version: ${defined.version}`);

    const retrieved = engine.getWorkflow(defined.id);
    if (!retrieved || retrieved.id !== defined.id) {
      throw new Error('Failed to retrieve workflow');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 3: Workflow Execution with Action Handler
  // ========================================================================
  logger.info(`[${timestamp}] Test 3: Workflow Execution with Action Handler`);

  try {
    const engine = new WorkflowEngine();

    // Register action handler
    engine.registerAction('testAction', async (_context: WorkflowContext, _step: WorkflowStep) => {
      return { success: true, data: 'test result' };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Test Execution',
      description: 'Test workflow execution',
      type: WorkflowType.DEVICE_CONTROL,
      steps: [
        {
          id: 'step1',
          name: 'Test Step',
          type: StepType.ACTION,
          action: 'testAction',
          parameters: {},
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const result = await engine.execute(defined.id, {});

    logger.info(`[${timestamp}] Execution success: ${result.success}`);
    logger.info(`[${timestamp}] Steps executed: ${result.stepsExecuted}`);
    logger.info(`[${timestamp}] Output:`, result.output);

    if (!result.success) {
      throw new Error('Workflow execution failed');
    }
    if (result.stepsExecuted !== 1) {
      throw new Error(`Expected 1 step executed, got ${result.stepsExecuted}`);
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 4: Error Handling - Continue on Error
  // ========================================================================
  logger.info(`[${timestamp}] Test 4: Error Handling - Continue on Error`);

  try {
    const engine = new WorkflowEngine();

    engine.registerAction('failingAction', async () => {
      throw new Error('Intentional failure');
    });

    engine.registerAction('successAction', async () => {
      return { success: true };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Error Handling Test',
      description: 'Test error handling',
      type: WorkflowType.TESTING,
      steps: [
        {
          id: 'step1',
          name: 'Failing Step',
          type: StepType.ACTION,
          action: 'failingAction',
          parameters: {},
          required: false,
          errorHandling: 'continue',
        },
        {
          id: 'step2',
          name: 'Success Step',
          type: StepType.ACTION,
          action: 'successAction',
          parameters: {},
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const result = await engine.execute(defined.id, {});

    logger.info(`[${timestamp}] Execution success: ${result.success}`);
    logger.info(`[${timestamp}] Steps executed: ${result.stepsExecuted}`);
    logger.info(`[${timestamp}] Steps skipped: ${result.context.stepsSkipped.length}`);

    if (!result.success) {
      throw new Error('Workflow should succeed despite failing step');
    }
    if (result.context.stepsSkipped.length !== 1) {
      throw new Error('Expected 1 skipped step');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 5: Retry Logic
  // ========================================================================
  logger.info(`[${timestamp}] Test 5: Retry Logic`);

  try {
    const engine = new WorkflowEngine();

    let attempts = 0;
    engine.registerAction('retryAction', async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Not yet');
      }
      return { success: true, attempt: attempts };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Retry Test',
      description: 'Test retry logic',
      type: WorkflowType.DEPLOYMENT,
      steps: [
        {
          id: 'step1',
          name: 'Retry Step',
          type: StepType.ACTION,
          action: 'retryAction',
          parameters: {},
          required: true,
          errorHandling: 'retry',
          retryCount: 3,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const result = await engine.execute(defined.id, {});

    logger.info(`[${timestamp}] Execution success: ${result.success}`);
    logger.info(`[${timestamp}] Attempts made: ${attempts}`);

    if (!result.success) {
      throw new Error('Workflow should succeed after retries');
    }
    if (attempts !== 3) {
      throw new Error(`Expected 3 attempts, got ${attempts}`);
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 6: Loop Step Type
  // ========================================================================
  logger.info(`[${timestamp}] Test 6: Loop Step Type`);

  try {
    const engine = new WorkflowEngine();

    const iterations: number[] = [];
    engine.registerAction('loopAction', async (_context: WorkflowContext, step: WorkflowStep) => {
      const iteration = step.parameters.iteration as number;
      iterations.push(iteration);
      return { iteration };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Loop Test',
      description: 'Test loop step type',
      type: WorkflowType.MONITORING,
      steps: [
        {
          id: 'step1',
          name: 'Loop Step',
          type: StepType.LOOP,
          action: 'loopAction',
          parameters: {},
          loopCount: 5,
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const result = await engine.execute(defined.id, {});

    logger.info(`[${timestamp}] Execution success: ${result.success}`);
    logger.info(`[${timestamp}] Iterations: ${iterations.length}`);

    if (!result.success) {
      throw new Error('Loop workflow failed');
    }
    if (iterations.length !== 5) {
      throw new Error(`Expected 5 iterations, got ${iterations.length}`);
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 7: Delay Step Type
  // ========================================================================
  logger.info(`[${timestamp}] Test 7: Delay Step Type`);

  try {
    const engine = new WorkflowEngine();

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Delay Test',
      description: 'Test delay step type',
      type: WorkflowType.DIAGNOSTICS,
      steps: [
        {
          id: 'step1',
          name: 'Delay Step',
          type: StepType.DELAY,
          action: 'delay',
          parameters: {},
          delayMs: 100,
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const startTime = Date.now();
    const result = await engine.execute(defined.id, {});
    const duration = Date.now() - startTime;

    logger.info(`[${timestamp}] Execution success: ${result.success}`);
    logger.info(`[${timestamp}] Duration: ${duration}ms`);

    if (!result.success) {
      throw new Error('Delay workflow failed');
    }
    if (duration < 100) {
      throw new Error(`Expected delay >= 100ms, got ${duration}ms`);
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 8: Workflow Templates
  // ========================================================================
  logger.info(`[${timestamp}] Test 8: Workflow Templates`);

  try {
    const templates = WorkflowFactory.getAllTemplates();

    logger.info(`[${timestamp}] Available templates: ${templates.length}`);

    if (templates.length === 0) {
      throw new Error('No templates found');
    }

    for (const template of templates) {
      logger.info(`[${timestamp}] - ${template.name}: ${template.description}`);
    }

    const deviceControl = WorkflowFactory.getTemplate('DEVICE_CONTROL');
    if (!deviceControl) {
      throw new Error('DEVICE_CONTROL template not found');
    }
    logger.info(`[${timestamp}] DEVICE_CONTROL template found`);

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 9: WorkflowFactory - Device Control Workflow
  // ========================================================================
  logger.info(`[${timestamp}] Test 9: WorkflowFactory - Device Control Workflow`);

  try {
    const workflow = WorkflowFactory.createDeviceControlWorkflow({
      deviceId: 'test-device-1',
      action: 'setTemperature',
      value: 22,
    });

    logger.info(`[${timestamp}] Workflow name: ${workflow.name}`);
    logger.info(`[${timestamp}] Workflow type: ${workflow.type}`);
    logger.info(`[${timestamp}] Steps count: ${workflow.steps.length}`);

    if (workflow.steps.length !== 3) {
      throw new Error(`Expected 3 steps, got ${workflow.steps.length}`);
    }

    // Validate step sequence
    const stepIds = workflow.steps.map((s: WorkflowStep) => s.id);
    logger.info(`[${timestamp}] Step sequence: ${stepIds.join(' -> ')}`);

    if (stepIds[0] !== 'validate') {
      throw new Error('First step should be validate');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 10: WorkflowFactory - Task Decomposition Workflow
  // ========================================================================
  logger.info(`[${timestamp}] Test 10: WorkflowFactory - Task Decomposition Workflow`);

  try {
    const workflow = WorkflowFactory.createTaskDecompositionWorkflow({
      task: 'Design a smart home system',
      context: 'Home with 10 devices',
      complexity: 'complex',
    });

    logger.info(`[${timestamp}] Workflow name: ${workflow.name}`);
    logger.info(`[${timestamp}] Workflow type: ${workflow.type}`);
    logger.info(`[${timestamp}] Steps count: ${workflow.steps.length}`);

    if (workflow.type !== WorkflowType.TASK_DECOMPOSITION) {
      throw new Error('Wrong workflow type');
    }

    // Check for retry configuration
    const decomposeStep = workflow.steps.find((s: WorkflowStep) => s.id === 'decompose');
    if (!decomposeStep) {
      throw new Error('Decompose step not found');
    }
    logger.info(`[${timestamp}] Decompose step retry count: ${decomposeStep.retryCount}`);

    if (decomposeStep.retryCount !== 3) {
      throw new Error('Expected retryCount = 3');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 11: Event Handlers
  // ========================================================================
  logger.info(`[${timestamp}] Test 11: Event Handlers`);

  try {
    const engine = new WorkflowEngine();

    let stepCompleted = false;
    let workflowCompleted = false;

    engine.onStepComplete((_executionId, _stepId, _result) => {
      stepCompleted = true;
    });

    engine.onWorkflowComplete((_executionId, _result) => {
      workflowCompleted = true;
    });

    engine.registerAction('testAction', async () => {
      return { success: true };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Event Test',
      description: 'Test event handlers',
      type: WorkflowType.CODE_GENERATION,
      steps: [
        {
          id: 'step1',
          name: 'Test Step',
          type: StepType.ACTION,
          action: 'testAction',
          parameters: {},
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    await engine.execute(defined.id, {});

    logger.info(`[${timestamp}] Step completed event fired: ${stepCompleted}`);
    logger.info(`[${timestamp}] Workflow completed event fired: ${workflowCompleted}`);

    if (!stepCompleted) {
      throw new Error('Step complete event not fired');
    }
    if (!workflowCompleted) {
      throw new Error('Workflow complete event not fired');
    }

    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 12: Execution Management
  // ========================================================================
  logger.info(`[${timestamp}] Test 12: Execution Management`);

  try {
    const engine = new WorkflowEngine();

    engine.registerAction('slowAction', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { success: true };
    });

    const workflow: Omit<WorkflowDefinition, 'id' | 'version'> = {
      name: 'Execution Test',
      description: 'Test execution management',
      type: WorkflowType.COLLABORATION,
      steps: [
        {
          id: 'step1',
          name: 'Slow Step',
          type: StepType.ACTION,
          action: 'slowAction',
          parameters: {},
          required: true,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      metadata: { tags: [] },
    };

    const defined = engine.defineWorkflow(workflow);
    const promise = engine.execute(defined.id, {});

    // Check active executions
    const active = engine.getActiveExecutions();
    logger.info(`[${timestamp}] Active executions: ${active.length}`);

    if (active.length === 0) {
      throw new Error('Expected at least 1 active execution');
    }

    // Wait for completion
    await promise;

    logger.info(`[${timestamp}] Execution completed`);
    logger.info(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    logger.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  logger.info('====================================');
  logger.info('All Workflow Tests Completed');
  logger.info('====================================');
}

// Run tests
runTests().catch(console.error);
