/**
 * CLI PR 快道配置（R1 Batch 1 起）— `npm run test:fast` 时 cli 用本配置。
 *
 * cli 的既有套件全部是真 server e2e（tsx 子进程 + 临时 SQLite，见
 * src/test/helpers.ts bootServer），单文件秒级～十秒级，整体进快道会顶穿
 * 5 分钟预算。快道只收纯渲染/纯函数单测（无 server 启动）；e2e 套件留在
 * `npm test` 全量道（vitest.config.ts）照常门禁 —— 与 apps/server
 * vitest.fast.config.ts 的 HEAVY_FULL_APP_SUITES 同一「归属不是删除」纪律。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.render.vitest.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
