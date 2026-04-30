/**
 * Vitest Configuration for LLM Integration Package
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.vitest.test.ts'],
    exclude: [
      'node_modules/',
      'dist/',
      'src/test.ts',
      'src/test-multi-model.ts',
      'src/OllamaModelUtility.test.ts',
      'src/model-health.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/test.ts',
        'src/test-multi-model.ts',
        'src/OllamaModelUtility.test.ts',
        'src/model-health.test.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
    testTimeout: 10000, // 10 second timeout for all tests
    hookTimeout: 10000, // 10 second timeout for hooks
    teardownTimeout: 5000, // 5 second timeout for cleanup
    reporters: ['verbose'],
    maxConcurrency: 5, // Limit concurrent tests to prevent resource exhaustion
    sequence: {
      hooks: 'stack', // Run hooks in stack order (beforeAll > beforeEach > afterEach > afterAll)
    },
    // Global setup and teardown
    setupFiles: [],
    // Improve test isolation
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    // Memory management
    logHeapUsage: true,
  },
});
