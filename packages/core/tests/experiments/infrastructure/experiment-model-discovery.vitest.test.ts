/**
 * Unit tests for ExperimentModelDiscovery's configurable suitability threshold.
 *
 * The backend model list is mocked via LLMInitializer.getAvailableModels, so
 * these run without a live backend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getAvailableModels = vi.hoisted(() => vi.fn());
vi.mock('@active-collaboration/llm-integration', () => ({
  LLMInitializer: { getAvailableModels },
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { ExperimentModelDiscovery } from './experiment-model-discovery.js';

const SMALL_MODEL_NAME = 'qwen2.5-1.5b-q4:latest';
const MEDIUM_MODEL_NAME = 'qwen2.5-7b-q4:latest';

const ENV_KEY = 'EXPERIMENT_MIN_MODEL_PARAMS_B';

describe('ExperimentModelDiscovery suitability threshold', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    getAvailableModels.mockResolvedValue([SMALL_MODEL_NAME, MEDIUM_MODEL_NAME]);
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('excludes models below 7B by default', async () => {
    const discovery = await ExperimentModelDiscovery.create();
    expect(discovery.getSuitableModelNames()).toEqual([MEDIUM_MODEL_NAME]);
  });

  it('honors an explicit minParamCount override', async () => {
    const discovery = await ExperimentModelDiscovery.create({ minParamCount: 1.5 });
    expect(discovery.getSuitableModelNames()).toEqual([
      SMALL_MODEL_NAME,
      MEDIUM_MODEL_NAME,
    ]);
  });

  it('honors the EXPERIMENT_MIN_MODEL_PARAMS_B env var', async () => {
    process.env[ENV_KEY] = '1.5';
    const discovery = await ExperimentModelDiscovery.create();
    expect(discovery.getSuitableModelNames()).toEqual([
      SMALL_MODEL_NAME,
      MEDIUM_MODEL_NAME,
    ]);
  });

  it('prefers the explicit option over the env var', async () => {
    process.env[ENV_KEY] = '1.5';
    const discovery = await ExperimentModelDiscovery.create({ minParamCount: 7 });
    expect(discovery.getSuitableModelNames()).toEqual([MEDIUM_MODEL_NAME]);
  });

  it('falls back to the default when the env var is invalid', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    const discovery = await ExperimentModelDiscovery.create();
    expect(discovery.getSuitableModelNames()).toEqual([MEDIUM_MODEL_NAME]);
  });
});
