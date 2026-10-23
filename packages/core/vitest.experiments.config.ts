/**
 * Vitest configuration — packages/core experiment suites (Wave-6)
 *
 * `npm run test:experiments` — the RQ research experiment suites under
 * `tests/experiments/` (40+ minutes, LLM-backed in places; excluded from
 * the default `npm test`, see vitest.config.ts). Logger output is left at
 * the default level on purpose: the experiment runners' logs are part of
 * their artifacts (tests/experiment-results/).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/experiments/**/*.vitest.test.ts'],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
