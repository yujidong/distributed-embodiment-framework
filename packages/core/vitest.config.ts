/**
 * Vitest configuration — packages/core default suite (Wave-6)
 *
 * The RQ experiment suites under `tests/experiments/` are HEAVY (40+
 * minutes, gigabytes of log output) and are NOT part of the default
 * `npm test` run — they run on demand via `npm run test:experiments`
 * (see vitest.experiments.config.ts). Everything else (the test files
 * under src/) stays in the fast default suite.
 *
 * `vitest.setup.ts` lowers the shared logger to WARN so the suite's console
 * output stays readable (EAF_TEST_LOG_LEVEL=info restores the old noise).
 */

import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/experiments/**'],
    setupFiles: ['vitest.setup.ts'],
  },
});
