/**
 * Unit Tests for ModelStrategy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelStrategy,
  TaskHelpers,
} from './ModelStrategy';
import {
  DefaultModelConfigs,
  TaskType,
  TaskComplexity,
} from './model-config';

describe('ModelStrategy', () => {
  let strategy: ModelStrategy;

  beforeEach(() => {
    strategy = new ModelStrategy();
  });

  describe('initialization', () => {
    it('should initialize with default configuration', () => {
      const config = strategy.getConfig();

      expect(config).toBeDefined();
      expect(config.taskModels).toBeDefined();
      expect(config.fallbackModels).toBeDefined();
      expect(config.availableModels).toEqual([]);
    });
  });

  describe('model selection for tasks', () => {
    beforeEach(() => {
      strategy.setAvailableModels([
        'llama3.2:3b',
        'llama3.1:8b',
        'llama3.1:70b',
        'codellama:34b',
        'nomic-embed-text',
      ]);
    });

    it('should select appropriate model for control tasks', () => {
      const result = strategy.selectModel(TaskType.CONTROL);

      expect(result.model).toBeTruthy();
      expect(result.fallback).toBe(false);
    });

    it('should select appropriate model for planning tasks', () => {
      const result = strategy.selectModel(TaskType.PLANNING);

      expect(result.model).toBeTruthy();
    });

    it('should use fallback when primary model has failed', () => {
      strategy.markModelFailed('llama3.2:3b');

      const result = strategy.selectModel(TaskType.CONTROL);

      expect(result.model).toBeTruthy();
      expect(result.fallback).toBe(true);
    });
  });

  describe('availability tracking', () => {
    it('should set available models', () => {
      const models = ['model1', 'model2', 'model3'];
      strategy.setAvailableModels(models);

      expect(strategy.getAvailableModels()).toEqual(models);
    });

    it('should check if model is available', () => {
      strategy.setAvailableModels(['model1', 'model2']);

      expect(strategy.isModelAvailable('model1')).toBe(true);
      expect(strategy.isModelAvailable('model3')).toBe(false);
    });
  });

  describe('health tracking', () => {
    it('should set model health status', () => {
      strategy.setModelHealth('model1', true);

      expect(strategy.isModelHealthy('model1')).toBe(true);
    });

    it('should mark model as failed', () => {
      strategy.markModelFailed('model1');

      expect(strategy.isModelHealthy('model1')).toBe(false);
    });
  });

  describe('recommended model selection', () => {
    beforeEach(() => {
      strategy.setAvailableModels(['llama3.2:3b', 'llama3.1:8b']);
    });

    it('should get recommended model for task type', () => {
      const model = strategy.getRecommendedModel(TaskType.CONTROL);

      expect(model).toBeTruthy();
    });
  });

  describe('task model updates', () => {
    it('should update model for task type', () => {
      // Create a fresh strategy instance
      const testStrategy = new ModelStrategy();

      // Get initial config
      const initialConfig = testStrategy.getConfig();
      expect(initialConfig.taskModels.control).toBe('llama3.2:3b');

      // Update model
      testStrategy.setTaskModel(TaskType.CONTROL, 'updated-model');

      // Verify updated config
      const updatedConfig = testStrategy.getConfig();
      expect(updatedConfig.taskModels.control).toBe('updated-model');
    });

    it('should use configured model in selection', () => {
      const testStrategy = new ModelStrategy();
      testStrategy.setAvailableModels(['llama3.2:3b']);

      const result = testStrategy.selectModel(TaskType.CONTROL);

      expect(result.model).toBe('llama3.2:3b');
      expect(result.fallback).toBe(false);
    });
  });

  describe('usage stats', () => {
    it('should track usage stats', () => {
      strategy.markModelSuccess('model1');
      strategy.markModelSuccess('model1');
      strategy.markModelFailed('model1');

      const stats = strategy.getUsageStats();

      expect(stats.get('model1')).toBeDefined();
    });
  });
});

describe('DefaultModelConfigs', () => {
  it('should have OLLAMA config', () => {
    expect(DefaultModelConfigs.OLLAMA).toBeDefined();
    expect(DefaultModelConfigs.OLLAMA.taskModels).toBeDefined();
    expect(DefaultModelConfigs.OLLAMA.fallbackModels).toBeDefined();
  });

  it('should have LIGHTWEIGHT config', () => {
    expect(DefaultModelConfigs.LIGHTWEIGHT).toBeDefined();
    expect(DefaultModelConfigs.LIGHTWEIGHT.taskModels.control).toBe('llama3.2:1b');
  });

  it('should have HIGH_PERFORMANCE config', () => {
    expect(DefaultModelConfigs.HIGH_PERFORMANCE).toBeDefined();
    expect(DefaultModelConfigs.HIGH_PERFORMANCE.taskModels.planning).toBe('llama3.1:70b');
  });
});
