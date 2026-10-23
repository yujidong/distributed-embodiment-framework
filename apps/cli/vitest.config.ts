import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    // Each test file boots the real apps/server (tsx subprocess, temp SQLite
    // DB) — allow generous timeouts and run files serially in one fork.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
