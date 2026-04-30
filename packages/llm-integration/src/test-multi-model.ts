/**
 * Multi-Model LLM Integration Tests
 *
 * Tests for ModelStrategy, model selection, and task-aware routing
 */

import { ModelStrategy, TaskHelpers } from './ModelStrategy';
import { TaskType, TaskComplexity, DefaultModelConfigs } from './model-config';

async function runTests() {
  console.log('====================================');
  console.log('Multi-Model LLM Integration Tests');
  console.log('====================================\n');

  const timestamp = Date.now();

  // ========================================================================
  // Test 1: ModelStrategy Initialization
  // ========================================================================
  console.log(`[${timestamp}] Test 1: ModelStrategy Initialization`);

  try {
    const strategy = new ModelStrategy();
    const config = strategy.getConfig();

    console.log(`[${timestamp}] Task models:`, Object.keys(config.taskModels));
    console.log(`[${timestamp}] Fallback models:`, config.fallbackModels.length);
    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 2: Model Selection by Task Type
  // ========================================================================
  console.log(`[${timestamp}] Test 2: Model Selection by Task Type`);

  try {
    const strategy = new ModelStrategy();

    const controlSelection = strategy.selectModel(TaskType.CONTROL);
    console.log(`[${timestamp}] CONTROL task -> ${controlSelection.model}`);
    if (controlSelection.model !== 'llama3.2:3b') {
      throw new Error('Expected llama3.2:3b for CONTROL task');
    }

    const planningSelection = strategy.selectModel(TaskType.PLANNING);
    console.log(`[${timestamp}] PLANNING task -> ${planningSelection.model}`);
    // Note: Falls back to llama3.1:8b if llama3.1:70b not available
    if (planningSelection.model !== 'llama3.1:70b' && planningSelection.model !== 'llama3.1:8b') {
      throw new Error('Expected llama3.1:70b or llama3.1:8b for PLANNING task');
    }

    const reasoningSelection = strategy.selectModel(TaskType.REASONING);
    console.log(`[${timestamp}] REASONING task -> ${reasoningSelection.model}`);
    // Falls back if deepseek-r1:32b not available
    if (!reasoningSelection.model.includes('deepseek') && !reasoningSelection.model.includes('llama')) {
      throw new Error('Expected deepseek or llama model for REASONING task');
    }

    const codeSelection = strategy.selectModel(TaskType.CODE);
    console.log(`[${timestamp}] CODE task -> ${codeSelection.model}`);
    // Falls back if codellama:34b not available
    if (codeSelection.model !== 'codellama:34b' && !codeSelection.model.includes('codellama')) {
      throw new Error('Expected codellama for CODE task');
    }

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 3: Complexity-Based Model Selection
  // ========================================================================
  console.log(`[${timestamp}] Test 3: Complexity-Based Model Selection`);

  try {
    const strategy = new ModelStrategy();

    const simple = strategy.selectModel(TaskType.CHAT, TaskComplexity.SIMPLE);
    console.log(`[${timestamp}] SIMPLE complexity -> ${simple.model}`);

    const complex = strategy.selectModel(TaskType.CHAT, TaskComplexity.COMPLEX);
    console.log(`[${timestamp}] COMPLEX complexity -> ${complex.model}`);

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 4: Model Health Management
  // ========================================================================
  console.log(`[${timestamp}] Test 4: Model Health Management`);

  try {
    const strategy = new ModelStrategy();

    // Check initial health (should be healthy by default)
    const isHealthy = strategy.isModelHealthy('llama3.2:3b');
    console.log(`[${timestamp}] llama3.2:3b healthy: ${isHealthy}`);
    if (!isHealthy) {
      throw new Error('Expected model to be healthy by default');
    }

    // Mark as failed
    strategy.markModelFailed('llama3.2:3b');
    const stillHealthy = strategy.isModelHealthy('llama3.2:3b');
    console.log(`[${timestamp}] After failure, healthy: ${stillHealthy}`);
    if (stillHealthy) {
      throw new Error('Expected model to be unhealthy after failure');
    }

    // Mark as successful
    strategy.markModelSuccess('llama3.2:3b');
    const recovered = strategy.isModelHealthy('llama3.2:3b');
    console.log(`[${timestamp}] After success, healthy: ${recovered}`);
    if (!recovered) {
      throw new Error('Expected model to be healthy after success');
    }

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 5: Fallback Model Selection
  // ========================================================================
  console.log(`[${timestamp}] Test 5: Fallback Model Selection`);

  try {
    const strategy = new ModelStrategy();

    // Mark primary model as unhealthy
    strategy.markModelFailed('llama3.2:3b');

    // Should use fallback
    const selection = strategy.selectModel(TaskType.CONTROL);
    console.log(`[${timestamp}] With unhealthy primary, selected: ${selection.model}`);
    console.log(`[${timestamp}] Fallback: ${selection.fallback}`);

    if (!selection.fallback) {
      throw new Error('Expected fallback to be used');
    }

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 6: Available Models Management
  // ========================================================================
  console.log(`[${timestamp}] Test 6: Available Models Management`);

  try {
    const strategy = new ModelStrategy();

    const models = ['llama3.2:3b', 'llama3.1:8b', 'deepseek-r1:32b', 'codellama:34b'];
    strategy.setAvailableModels(models);

    const available = strategy.getAvailableModels();
    console.log(`[${timestamp}] Available models:`, available);

    if (available.length !== models.length) {
      throw new Error(`Expected ${models.length} available models`);
    }

    const isAvailable = strategy.isModelAvailable('llama3.2:3b');
    console.log(`[${timestamp}] llama3.2:3b available: ${isAvailable}`);
    if (!isAvailable) {
      throw new Error('Expected llama3.2:3b to be available');
    }

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 7: Usage Statistics
  // ========================================================================
  console.log(`[${timestamp}] Test 7: Usage Statistics`);

  try {
    const strategy = new ModelStrategy();

    // Simulate some usage
    strategy.markModelSuccess('llama3.2:3b');
    strategy.markModelSuccess('llama3.2:3b');
    strategy.markModelSuccess('llama3.2:3b');
    strategy.markModelFailed('llama3.2:3b');

    const stats = strategy.getUsageStats();
    const llamaStats = stats.get('llama3.2:3b');

    console.log(`[${timestamp}] llama3.2:3b stats:`, llamaStats);

    if (!llamaStats || llamaStats.count !== 3 || llamaStats.errors !== 1) {
      throw new Error('Usage stats not tracked correctly');
    }

    console.log(`[${timestamp}] Error rate: ${(llamaStats.errorRate * 100).toFixed(1)}%`);

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 8: Task Metadata Helper
  // ========================================================================
  console.log(`[${timestamp}] Test 8: Task Metadata Helper`);

  try {
    const controlTask = TaskHelpers.control();
    console.log(`[${timestamp}] Control task type: ${controlTask.type}, complexity: ${controlTask.complexity}`);

    const planningTask = TaskHelpers.planning({ estimatedTokens: 5000 });
    console.log(`[${timestamp}] Planning task type: ${planningTask.type}, complexity: ${planningTask.complexity}`);

    const codeTask = TaskHelpers.code();
    console.log(`[${timestamp}] Code task type: ${codeTask.type}, requiresCode: ${codeTask.requiresCodeGeneration}`);

    // Verify the helpers return correct types
    if (controlTask.type !== TaskType.CONTROL) {
      throw new Error('TaskHelpers.control() returned wrong type');
    }
    if (planningTask.type !== TaskType.PLANNING) {
      throw new Error('TaskHelpers.planning() returned wrong type');
    }
    if (codeTask.type !== TaskType.CODE) {
      throw new Error('TaskHelpers.code() returned wrong type');
    }

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 9: Model Configuration Presets
  // ========================================================================
  console.log(`[${timestamp}] Test 9: Model Configuration Presets`);

  try {
    // Verify DefaultModelConfigs exists and has expected properties
    if (!DefaultModelConfigs.OLLAMA || !DefaultModelConfigs.OLLAMA.taskModels) {
      throw new Error('DefaultModelConfigs.OLLAMA missing or malformed');
    }
    if (!DefaultModelConfigs.LIGHTWEIGHT || !DefaultModelConfigs.LIGHTWEIGHT.taskModels) {
      throw new Error('DefaultModelConfigs.LIGHTWEIGHT missing or malformed');
    }
    if (!DefaultModelConfigs.HIGH_PERFORMANCE || !DefaultModelConfigs.HIGH_PERFORMANCE.taskModels) {
      throw new Error('DefaultModelConfigs.HIGH_PERFORMANCE missing or malformed');
    }

    console.log(`[${timestamp}] OLLAMA config has ${Object.keys(DefaultModelConfigs.OLLAMA.taskModels).length} task types`);
    console.log(`[${timestamp}] LIGHTWEIGHT config has ${Object.keys(DefaultModelConfigs.LIGHTWEIGHT.taskModels).length} task types`);
    console.log(`[${timestamp}] HIGH_PERFORMANCE config has ${Object.keys(DefaultModelConfigs.HIGH_PERFORMANCE.taskModels).length} task types`);

    const lightweight = new ModelStrategy(DefaultModelConfigs.LIGHTWEIGHT);
    const selection = lightweight.selectModel(TaskType.CONTROL);
    console.log(`[${timestamp}] LIGHTWEIGHT CONTROL -> ${selection.model}`);

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  // ========================================================================
  // Test 10: Recommended Model Selection
  // ========================================================================
  console.log(`[${timestamp}] Test 10: Recommended Model Selection`);

  try {
    const strategy = new ModelStrategy();

    // Simulate high error rate for a model
    for (let i = 0; i < 10; i++) {
      strategy.markModelSuccess('llama3.2:3b');
    }
    for (let i = 0; i < 5; i++) {
      strategy.markModelFailed('llama3.2:3b');
    }

    const recommended = strategy.getRecommendedModel(TaskType.CONTROL);
    console.log(`[${timestamp}] Recommended model for CONTROL: ${recommended}`);

    // Should still recommend the task model unless error rate > 20%
    const stats = strategy.getUsageStats();
    const modelStats = stats.get('llama3.2:3b');
    console.log(`[${timestamp}] Error rate: ${modelStats ? (modelStats.errorRate * 100).toFixed(1) + '%' : 'N/A'}`);

    console.log(`[${timestamp}] Status: PASS\n`);
  } catch (error) {
    console.error(`[${timestamp}] Status: FAIL - ${error}\n`);
  }

  console.log('====================================');
  console.log('All Multi-Model Tests Completed');
  console.log('====================================');
}

// Run tests
runTests().catch(console.error);
