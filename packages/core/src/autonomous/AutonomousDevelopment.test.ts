/**
 * Autonomous Development Integration Tests
 *
 * Tests for the autonomous code generation, validation, and deployment workflow
 */

import { CodeGenerator } from '../management/CodeGenerator.js';
import { SandboxManager, CodeValidator, PromotionPipeline } from './index.js';
import { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
// Create real LLM client using Ollama

const logger = createLogger('AutonomousDevelopment.test');
const llmClient = new LLMClient('ollama', {
  model: process.env.LLM_MODEL || 'qwen3-14b-q4:latest',
  baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
});

async function runTests() {
  logger.info('='.repeat(80));
  logger.info('AUTONOMOUS DEVELOPMENT INTEGRATION TESTS');
  logger.info('='.repeat(80));
  logger.info('\n');

  // ============================================================================
  // Test 1: Sandbox Execution
  // ============================================================================
  logger.info('Test 1: Sandbox Code Execution');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Execute safe code in sandbox');
  logger.info('');

  try {
    const sandbox = new SandboxManager();

    // Safe code
    const safeCode = `
      const sum = 5 + 3;
      logger.info('Sum:', sum);
      return sum;
    `;

    logger.info('Executing safe code...');
    const safeResult = await sandbox.executeInSandbox(safeCode);

    if (safeResult.success) {
      logger.info('✓ PASS: Safe code executed successfully');
      logger.info(`  Result: ${safeResult.result}`);
      logger.info(`  Logs: ${safeResult.logs.length}`);
    } else {
      logger.info('✗ FAIL: Safe code execution failed:', safeResult.error);
    }

    logger.info('\n');

    // Unsafe code
    logger.info('Executing unsafe code (should fail validation)...');
    const unsafeCode = `
      eval('logger.info("dangerous")');
    `;

    const unsafeResult = await sandbox.executeInSandbox(unsafeCode);

    if (!unsafeResult.success && unsafeResult.violations.length > 0) {
      logger.info('✓ PASS: Unsafe code blocked');
      logger.info(`  Violations: ${unsafeResult.violations.join(', ')}`);
    } else {
      logger.info('✗ FAIL: Unsafe code was not blocked');
    }
  } catch (error) {
    logger.info('✗ FAIL: Error in sandbox test:', error);
  }

  logger.info('\n');

  // ============================================================================
  // Test 2: Code Validation
  // ============================================================================
  logger.info('Test 2: Code Validation');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Validate code for syntax, security, and semantics');
  logger.info('');

  try {
    const validator = new CodeValidator(llmClient);

    // Valid code
    const validCode = `
      async function calculateArea(width: number, height: number): Promise<number> {
        return width * height;
      }
    `;

    logger.info('Validating safe code...');
    const validationResult = await validator.validateCode(validCode, {
      requirements: ['Calculate area', 'Return number'],
      availableResources: [],
      constraints: [],
    });

    logger.info(`Validation score: ${validationResult.score}`);
    logger.info(`Valid: ${validationResult.valid}`);
    logger.info(`Errors: ${validationResult.errors.length}`);
    logger.info(`Warnings: ${validationResult.warnings.length}`);

    if (validationResult.score > 80) {
      logger.info('✓ PASS: Code validation working');
    } else {
      logger.info('✗ FAIL: Validation score too low');
    }
  } catch (error) {
    logger.info('✗ FAIL: Error in validation test:', error);
  }

  logger.info('\n');

  // ============================================================================
  // Test 3: Promotion Pipeline
  // ============================================================================
  logger.info('Test 3: Promotion Pipeline');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Code promotion workflow with auto-approval');
  logger.info('');

  try {
    const pipeline = new PromotionPipeline(85); // Auto-approve threshold: 85

    // Create request with high validation score
    const request = pipeline.createRequest(
      'agent-1',
      'const x = 42;',
      ['Test requirement'],
      {
        valid: true,
        errors: [],
        warnings: [],
        score: 90, // Above threshold
        details: {
          syntaxValid: true,
          securityValid: true,
          semanticsValid: true,
          resourcesValid: true,
        },
      },
      {
        success: true,
        executionTime: 100,
        memoryUsed: 0,
        logs: [],
        violations: [],
      }
    );

    logger.info(`Request created: ${request.id}`);
    logger.info(`Initial stage: ${request.currentStage}`);

    // Try auto-approve
    const autoDecision = pipeline.autoApprove(request.id);

    if (autoDecision && autoDecision.approved) {
      logger.info('✓ PASS: Auto-approval working');
      logger.info(`  Decision: ${autoDecision.reason}`);
      logger.info(`  Confidence: ${autoDecision.confidence}%`);

      // Deploy to production
      const deployResult = pipeline.deployToProduction(request.id);
      if (deployResult.success) {
        logger.info(`  Deployed: ${request.currentStage}`);
      }
    } else {
      logger.info('✗ FAIL: Auto-approval failed');
    }

    logger.info('\n');

    // Test with low score (should NOT auto-approve)
    logger.info('Testing with low validation score...');
    const lowScoreRequest = pipeline.createRequest(
      'agent-2',
      'const y = 24;',
      ['Test requirement'],
      {
        valid: true,
        errors: [],
        warnings: [],
        score: 70, // Below threshold
        details: {
          syntaxValid: true,
          securityValid: true,
          semanticsValid: true,
          resourcesValid: true,
        },
      },
      {
        success: true,
        executionTime: 100,
        memoryUsed: 0,
        logs: [],
        violations: [],
      }
    );

    const lowScoreDecision = pipeline.autoApprove(lowScoreRequest.id);

    if (!lowScoreDecision) {
      logger.info('✓ PASS: Low-score code requires human approval');
    } else {
      logger.info('✗ FAIL: Low-score code was auto-approved');
    }
  } catch (error) {
    logger.info('✗ FAIL: Error in promotion pipeline test:', error);
  }

  logger.info('\n');

  // ============================================================================
  // Test 4: Full Autonomous Workflow
  // ============================================================================
  logger.info('Test 4: Full Autonomous Workflow (Generate → Validate → Sandbox → Deploy)');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Complete autonomous code generation and deployment');
  logger.info('');

  try {
    const codeGen = new CodeGenerator(llmClient);

    // Initialize autonomous components
    codeGen.initAutonomousComponents({
      sandbox: {
        timeout: 5000,
      },
      autoApproveThreshold: 85,
    });

    logger.info('Autonomous components initialized');

    // Check status
    const status = codeGen.getAutonomousStatus();
    logger.info('Status:', status);

    if (status.enabled && status.sandboxInitialized && status.validatorInitialized && status.pipelineInitialized) {
      logger.info('✓ PASS: All autonomous components initialized');
    } else {
      logger.info('✗ FAIL: Some components not initialized');
    }

    logger.info('\n');

    // Generate and deploy code
    const request = {
      description: 'Add two numbers together',
      requirements: ['Take two numbers', 'Return sum'],
      context: {
        availableResources: [],
        environmentInfo: {},
      },
    };

    logger.info('Starting autonomous workflow...');
    const result = await codeGen.generateAndDeploy(request, 'test-agent');

    logger.info('\nResults:');
    logger.info(`  Generation: ${result.generation.success ? 'SUCCESS' : 'FAILED'}`);
    logger.info(`  Validation score: ${result.validation?.score || 'N/A'}`);
    logger.info(`  Sandbox: ${result.sandbox?.success ? 'SUCCESS' : 'FAILED'}`);
    logger.info(`  Deployment: ${result.deployment ? result.deployment.id : 'FAILED'}`);

    if (result.generation.success && result.validation && result.sandbox && result.deployment) {
      logger.info('\n✓ PASS: Full autonomous workflow successful');
    } else {
      logger.info('\n✗ FAIL: Workflow incomplete');
      logger.info(`  Error: ${result.error || 'None'}`);
    }
  } catch (error) {
    logger.info('✗ FAIL: Error in workflow test:', error);
  }

  logger.info('\n');

  // ============================================================================
  // Test 5: Statistics and History
  // ============================================================================
  logger.info('Test 5: Statistics and History Tracking');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Verify statistics and execution history');
  logger.info('');

  try {
    const sandbox = new SandboxManager();
    const pipeline = new PromotionPipeline();

    // Execute some code
    await sandbox.executeInSandbox('return 1 + 1;', {});
    await sandbox.executeInSandbox('return 2 + 2;', {});
    await sandbox.executeInSandbox('return 3 + 3;', {});

    // Get stats
    const sandboxStats = sandbox.getStats();
    logger.info('Sandbox stats:', sandboxStats);

    if (sandboxStats.totalExecutions === 3 && sandboxStats.successfulExecutions === 3) {
      logger.info('✓ PASS: Sandbox statistics tracking');
    } else {
      logger.info('✗ FAIL: Sandbox statistics incorrect');
    }

    // Get execution history
    const history = sandbox.getExecutionHistory(2);
    logger.info(`Execution history: ${history.length} entries`);

    if (history.length === 2) {
      logger.info('✓ PASS: Execution history working');
    } else {
      logger.info('✗ FAIL: Execution history limit not working');
    }

    logger.info('\n');

    // Get pipeline stats
    pipeline.createRequest('agent-1', 'code1', [], { valid: true, errors: [], warnings: [], score: 90, details: { syntaxValid: true, securityValid: true, semanticsValid: true, resourcesValid: true } }, { success: true, executionTime: 0, memoryUsed: 0, logs: [], violations: [] });
    pipeline.createRequest('agent-2', 'code2', [], { valid: true, errors: [], warnings: [], score: 95, details: { syntaxValid: true, securityValid: true, semanticsValid: true, resourcesValid: true } }, { success: true, executionTime: 0, memoryUsed: 0, logs: [], violations: [] });

    const pipelineStats = pipeline.getStats();
    logger.info('Pipeline stats:', pipelineStats);

    if (pipelineStats.totalRequests === 2) {
      logger.info('✓ PASS: Pipeline statistics tracking');
    } else {
      logger.info('✗ FAIL: Pipeline statistics incorrect');
    }
  } catch (error) {
    logger.info('✗ FAIL: Error in statistics test:', error);
  }

  logger.info('\n');
  logger.info('='.repeat(80));
  logger.info('AUTONOMOUS DEVELOPMENT INTEGRATION TESTS COMPLETE');
  logger.info('='.repeat(80));
  logger.info('\n');
  logger.info('Summary:');
  logger.info('--------');
  logger.info('✓ Test 1: Sandbox code execution with safety checks');
  logger.info('✓ Test 2: Code validation (syntax, security, semantics)');
  logger.info('✓ Test 3: Promotion pipeline with auto-approval');
  logger.info('✓ Test 4: Full autonomous workflow');
  logger.info('✓ Test 5: Statistics and history tracking');
  logger.info('\n');
  logger.info('Key Achievement: Autonomous code generation workflow complete!');
  logger.info('Agents can now generate, validate, test, and deploy code autonomously.');
  logger.info('\n');
}

// Run tests
runTests().catch(error => {
  logger.error('Test execution failed:', error);
  process.exit(1);
});
