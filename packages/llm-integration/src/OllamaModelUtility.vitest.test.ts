/**
 * Unit Tests for OllamaModelUtility
 *
 * Note: These tests require a running Ollama instance to pass.
 * They are integration tests rather than pure unit tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaModelUtility } from './OllamaModelUtility';

describe('OllamaModelUtility', () => {
  let utility: OllamaModelUtility;

  beforeAll(() => {
    utility = new OllamaModelUtility({ baseURL: 'http://localhost:11434' });
  });

  describe('initialization', () => {
    it('should initialize with default baseURL', () => {
      const defaultUtility = new OllamaModelUtility();

      expect(defaultUtility).toBeDefined();
    });

    it('should initialize with custom baseURL', () => {
      const customUtility = new OllamaModelUtility({
        baseURL: 'http://custom:11434',
      });

      expect(customUtility).toBeDefined();
    });

    it('should initialize with custom timeout', () => {
      const customUtility = new OllamaModelUtility({
        timeout: 60000,
      });

      expect(customUtility).toBeDefined();
    });
  });

  describe('healthCheck', () => {
    it('should check Ollama health', async () => {
      const isHealthy = await utility.healthCheck();

      // Result depends on whether Ollama is running
      expect(typeof isHealthy).toBe('boolean');
    });
  });

  describe('listModels', () => {
    it('should return list of available models', async () => {
      const models = await utility.listModels();

      // Array should be returned (empty or with models)
      expect(Array.isArray(models)).toBe(true);
    });
  });

  describe('getAvailableModelsList', () => {
    it('should return list of available models with descriptions', () => {
      const models = utility.getAvailableModelsList();

      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('name');
      expect(models[0]).toHaveProperty('description');
    });

    it('should include popular models', () => {
      const models = utility.getAvailableModelsList();
      const modelNames = models.map((m) => m.name);

      expect(modelNames).toContain('llama3.2');
      expect(modelNames).toContain('qwen2.5');
      expect(modelNames).toContain('mistral');
    });

    it('should include size information for some models', () => {
      const models = utility.getAvailableModelsList();

      const llama = models.find((m) => m.name === 'llama3.2');
      expect(llama?.size).toBeDefined();
    });
  });
});

describe('OllamaModelUtility without Ollama', () => {
  describe('getAvailableModelsList', () => {
    it('should work without Ollama running', () => {
      const utility = new OllamaModelUtility();

      const models = utility.getAvailableModelsList();

      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('name');
      expect(models[0]).toHaveProperty('description');
    });
  });
});
