/**
 * Unit Tests for Model Health Monitoring
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { ModelHealthMonitor, quickHealthCheck, checkModelsAvailable } from './model-health';
import { ModelStrategy } from './ModelStrategy';
import { OllamaProvider } from './providers/ollama';

// Mock fetch globally with proper typing
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ModelHealthMonitor', () => {
  let strategy: ModelStrategy;
  let provider: OllamaProvider;
  let monitor: ModelHealthMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new ModelStrategy();
    provider = new OllamaProvider();
    monitor = new ModelHealthMonitor(strategy, provider);
  });

  afterEach(() => {
    monitor.stopMonitoring();
  });

  describe('discoverModels', () => {
    it('should discover available models from Ollama', async () => {
      const mockModels = {
        models: [
          { name: 'llama3.2', size: 2000000000, modified_at: '2024-01-01', digest: 'abc123' },
          { name: 'qwen2.5:7b', size: 4700000000, modified_at: '2024-01-02', digest: 'def456' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      const models = await monitor.discoverModels();

      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('llama3.2');
      expect(models[1].name).toBe('qwen2.5:7b');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle discovery errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const models = await monitor.discoverModels();

      expect(models).toHaveLength(0);
    });

    it('should initialize health status for discovered models', async () => {
      const mockModels = {
        models: [{ name: 'llama3.2', size: 2000000000 }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      await monitor.discoverModels();

      const health = monitor.getModelHealth('llama3.2');
      expect(health).toBeDefined();
      expect(health?.available).toBe(true);
      expect(health?.healthy).toBe(true);
    });
  });

  describe('checkModelHealth', () => {
    it('should check health of a specific model', async () => {
      const startTime = Date.now();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'test' }),
      } as Response);

      const status = await monitor.checkModelHealth('llama3.2');

      expect(status.model).toBe('llama3.2');
      expect(status.available).toBe(true);
      expect(status.healthy).toBe(true);
      expect(status.loadTime).toBeGreaterThanOrEqual(0);
      expect(status.successCount).toBe(1);
    });

    it('should handle model health check failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const status = await monitor.checkModelHealth('llama3.2');

      expect(status.available).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.errorCount).toBe(1);
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const status = await monitor.checkModelHealth('llama3.2');

      expect(status.available).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.errorCount).toBe(1);
    });
  });

  describe('checkAllModels', () => {
    it('should check health of all configured models', async () => {
      strategy.setAvailableModels(['llama3.2', 'qwen2.5']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'test1' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'test2' }),
        } as Response);

      const statuses = await monitor.checkAllModels();

      expect(statuses).toHaveLength(2);
      expect(statuses[0].model).toBeDefined();
      expect(statuses[1].model).toBeDefined();
    });
  });

  describe('monitoring', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should start automated monitoring', () => {
      strategy.setAvailableModels(['llama3.2']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'test' }),
      } as Response);

      monitor.startMonitoring(5000);

      expect(monitor.isMonitoring()).toBe(true);

      monitor.stopMonitoring();
    });

    it('should not start monitoring twice', () => {
      strategy.setAvailableModels(['llama3.2']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'test' }),
      } as Response);

      monitor.startMonitoring(5000);
      monitor.startMonitoring(3000);

      expect(monitor.isMonitoring()).toBe(true);

      monitor.stopMonitoring();
    });

    it('should stop monitoring', () => {
      strategy.setAvailableModels(['llama3.2']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'test' }),
      } as Response);

      monitor.startMonitoring(5000);
      monitor.stopMonitoring();

      expect(monitor.isMonitoring()).toBe(false);
    });
  });

  describe('getHealthSummary', () => {
    it('should return health summary', async () => {
      strategy.setAvailableModels(['llama3.2', 'qwen2.5']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'test1' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'test2' }),
        } as Response);

      await monitor.checkModelHealth('llama3.2');
      await monitor.checkModelHealth('qwen2.5');

      const summary = monitor.getHealthSummary();

      expect(summary.total).toBe(2);
      expect(summary.healthy).toBe(2);
      expect(summary.unhealthy).toBe(0);
      expect(summary.averageLoadTime).toBeGreaterThanOrEqual(0);
      expect(summary.models).toHaveLength(2);
    });
  });
});

describe('quickHealthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true if model is available', async () => {
    const provider = new OllamaProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3.2' }],
      }),
    } as Response);

    const result = await quickHealthCheck(provider, 'llama3.2');

    expect(result).toBe(true);
  });

  it('should return false if model is not available', async () => {
    const provider = new OllamaProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'other-model' }],
      }),
    } as Response);

    const result = await quickHealthCheck(provider, 'llama3.2');

    expect(result).toBe(false);
  });

  it('should return false on network error', async () => {
    const provider = new OllamaProvider();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await quickHealthCheck(provider, 'llama3.2');

    expect(result).toBe(false);
  });
});

describe('checkModelsAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should check availability of multiple models', async () => {
    const provider = new OllamaProvider();

    // Mock fetch to return the same models list for each call
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2' },
          { name: 'qwen2.5' },
        ],
      }),
    } as Response);

    const results = await checkModelsAvailable(provider, ['llama3.2', 'qwen2.5', 'missing-model']);

    expect(results.get('llama3.2')).toBe(true);
    expect(results.get('qwen2.5')).toBe(true);
    expect(results.get('missing-model')).toBe(false);
  });
});
