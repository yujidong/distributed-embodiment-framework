/**
 * Unit Tests for Model Health Monitoring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelHealthMonitor, quickHealthCheck, checkModelsAvailable } from './model-health';
import { ModelStrategy } from './ModelStrategy';
import { OpenAICompatibleProvider } from './providers/openai-compatible';

// Mock fetch globally with proper typing
const mockFetch = vi.fn();
global.fetch = mockFetch;

const TEST_BASE = 'http://localhost:8000/v1';

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ baseURL: TEST_BASE, model: 'test-model' });
}

describe('ModelHealthMonitor', () => {
  let strategy: ModelStrategy;
  let provider: OpenAICompatibleProvider;
  let monitor: ModelHealthMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new ModelStrategy();
    provider = makeProvider();
    monitor = new ModelHealthMonitor(strategy, provider);
  });

  afterEach(() => {
    monitor.stopMonitoring();
  });

  describe('discoverModels', () => {
    it('should discover available models from the backend', async () => {
      const mockModels = {
        object: 'list',
        data: [
          { id: 'qwen2.5-7b-instruct', object: 'model', created: 1704067200, owned_by: 'vllm' },
          { id: 'ac-decision-15b-v2', object: 'model', created: 1704153600, owned_by: 'vllm' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      const models = await monitor.discoverModels();

      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('qwen2.5-7b-instruct');
      expect(models[1].name).toBe('ac-decision-15b-v2');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(`${TEST_BASE}/models`, expect.anything());
    });

    it('should handle discovery errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const models = await monitor.discoverModels();

      expect(models).toHaveLength(0);
    });

    it('should initialize health status for discovered models', async () => {
      const mockModels = {
        object: 'list',
        data: [{ id: 'qwen2.5-7b-instruct', object: 'model' }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      await monitor.discoverModels();

      const health = monitor.getModelHealth('qwen2.5-7b-instruct');
      expect(health).toBeDefined();
      expect(health?.available).toBe(true);
      expect(health?.healthy).toBe(true);
    });
  });

  describe('checkModelHealth', () => {
    it('should check health of a specific model', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 't' } }],
          model: 'qwen2.5-7b-instruct',
        }),
      } as Response);

      const status = await monitor.checkModelHealth('qwen2.5-7b-instruct');

      expect(status.model).toBe('qwen2.5-7b-instruct');
      expect(status.available).toBe(true);
      expect(status.healthy).toBe(true);
      expect(status.loadTime).toBeGreaterThanOrEqual(0);
      expect(status.successCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_BASE}/chat/completions`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should handle model health check failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const status = await monitor.checkModelHealth('qwen2.5-7b-instruct');

      expect(status.available).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.errorCount).toBe(1);
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const status = await monitor.checkModelHealth('qwen2.5-7b-instruct');

      expect(status.available).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.errorCount).toBe(1);
    });
  });

  describe('checkAllModels', () => {
    it('should check health of all configured models', async () => {
      strategy.setAvailableModels(['qwen2.5-7b-instruct', 'ac-decision-15b-v2']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 't' } }],
            model: 'qwen2.5-7b-instruct',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 't' } }],
            model: 'ac-decision-15b-v2',
          }),
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
      strategy.setAvailableModels(['qwen2.5-7b-instruct']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 't' } }],
          model: 'qwen2.5-7b-instruct',
        }),
      } as Response);

      monitor.startMonitoring(5000);

      expect(monitor.isMonitoring()).toBe(true);

      monitor.stopMonitoring();
    });

    it('should not start monitoring twice', () => {
      strategy.setAvailableModels(['qwen2.5-7b-instruct']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 't' } }],
          model: 'qwen2.5-7b-instruct',
        }),
      } as Response);

      monitor.startMonitoring(5000);
      monitor.startMonitoring(3000);

      expect(monitor.isMonitoring()).toBe(true);

      monitor.stopMonitoring();
    });

    it('should stop monitoring', () => {
      strategy.setAvailableModels(['qwen2.5-7b-instruct']);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 't' } }],
          model: 'qwen2.5-7b-instruct',
        }),
      } as Response);

      monitor.startMonitoring(5000);
      monitor.stopMonitoring();

      expect(monitor.isMonitoring()).toBe(false);
    });
  });

  describe('getHealthSummary', () => {
    it('should return health summary', async () => {
      strategy.setAvailableModels(['qwen2.5-7b-instruct', 'ac-decision-15b-v2']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 't' } }],
            model: 'qwen2.5-7b-instruct',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 't' } }],
            model: 'ac-decision-15b-v2',
          }),
        } as Response);

      await monitor.checkModelHealth('qwen2.5-7b-instruct');
      await monitor.checkModelHealth('ac-decision-15b-v2');

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
    const provider = makeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [{ id: 'qwen2.5-7b-instruct', object: 'model' }],
      }),
    } as Response);

    const result = await quickHealthCheck(provider, 'qwen2.5-7b-instruct');

    expect(result).toBe(true);
  });

  it('should return false if model is not available', async () => {
    const provider = makeProvider();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [{ id: 'other-model', object: 'model' }],
      }),
    } as Response);

    const result = await quickHealthCheck(provider, 'qwen2.5-7b-instruct');

    expect(result).toBe(false);
  });

  it('should return false on network error', async () => {
    const provider = makeProvider();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await quickHealthCheck(provider, 'qwen2.5-7b-instruct');

    expect(result).toBe(false);
  });
});

describe('checkModelsAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should check availability of multiple models', async () => {
    const provider = makeProvider();

    // Mock fetch to return the same models list for each call
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'qwen2.5-7b-instruct', object: 'model' },
          { id: 'ac-decision-15b-v2', object: 'model' },
        ],
      }),
    } as Response);

    const results = await checkModelsAvailable(provider, [
      'qwen2.5-7b-instruct',
      'ac-decision-15b-v2',
      'missing-model',
    ]);

    expect(results.get('qwen2.5-7b-instruct')).toBe(true);
    expect(results.get('ac-decision-15b-v2')).toBe(true);
    expect(results.get('missing-model')).toBe(false);
  });
});
