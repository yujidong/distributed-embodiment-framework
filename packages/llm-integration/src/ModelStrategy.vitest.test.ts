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
        'Qwen/Qwen2.5-1.5B-Instruct',
        'Qwen/Qwen2.5-7B-Instruct',
        'Qwen/Qwen2.5-14B-Instruct',
        'Qwen/Qwen2.5-Coder-14B-Instruct',
        'text-embedding-v3',
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
      strategy.markModelFailed('Qwen/Qwen2.5-1.5B-Instruct');

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
      strategy.setAvailableModels(['Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-7B-Instruct']);
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
      expect(initialConfig.taskModels.control).toBe('Qwen/Qwen2.5-1.5B-Instruct');

      // Update model
      testStrategy.setTaskModel(TaskType.CONTROL, 'updated-model');

      // Verify updated config
      const updatedConfig = testStrategy.getConfig();
      expect(updatedConfig.taskModels.control).toBe('updated-model');
    });

    it('should use configured model in selection', () => {
      const testStrategy = new ModelStrategy();
      testStrategy.setAvailableModels(['Qwen/Qwen2.5-1.5B-Instruct']);

      const result = testStrategy.selectModel(TaskType.CONTROL);

      expect(result.model).toBe('Qwen/Qwen2.5-1.5B-Instruct');
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
  it('should have LOCAL config', () => {
    expect(DefaultModelConfigs.LOCAL).toBeDefined();
    expect(DefaultModelConfigs.LOCAL.taskModels).toBeDefined();
    expect(DefaultModelConfigs.LOCAL.fallbackModels).toBeDefined();
  });

  it('should have LIGHTWEIGHT config', () => {
    expect(DefaultModelConfigs.LIGHTWEIGHT).toBeDefined();
    expect(DefaultModelConfigs.LIGHTWEIGHT.taskModels.control).toBe('Qwen/Qwen2.5-0.5B-Instruct');
  });

  it('should have HIGH_PERFORMANCE config', () => {
    expect(DefaultModelConfigs.HIGH_PERFORMANCE).toBeDefined();
    expect(DefaultModelConfigs.HIGH_PERFORMANCE.taskModels.planning).toBe('Qwen/Qwen2.5-72B-Instruct');
  });
});
