/**
 * Server test defaults — R67 review finding.
 *
 * Every suite boots a FULL app instance (registry, timers, physics). At the
 * default worker count (≈ CPU count, 32 here) the parallel instances starve
 * each other's timers and HTTP listeners, and timing-sensitive acceptance
 * tests (world-hibernate's frozen-vs-continuous twin comparison) flap —
 * everything passes in isolation or under a bounded pool. Six workers keeps
 * the full run under ~5 minutes while staying reliable; single-file runs
 * are unaffected.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows 下用 forks pool：threads pool 在全套件跑完后的 worker
    // teardown 阶段以 0xC0000005 段错误退出（native better-sqlite3 +
    // worker_threads 的组合，vitest 官方不建议；2026-09-11 证据见
    // docs/ci.md「Windows teardown 段错误」与 vitest.fast.config.ts
    // 的同款注释）。Linux CI 保持 threads。
    pool: process.platform === 'win32' ? 'forks' : 'threads',
    // CI 上降到 3：hosted runner 是 4 vCPU / 16GB，threads pool 共享一个
    // 16GB 堆——6 workers × 全 app 实例把堆推满后 GC 死亡螺旋（2026-09-29
    // nightly：vitest 一小时零输出后 exit 1，无测试摘要，最后日志是一个
    // 刚 boot 的 runtime；同提交在 6 workers 的 push CI 上通过，纯内存
    // 压力差异）。3 workers 的墙钟损失远小于一次死亡螺旋。
    maxWorkers: process.env.CI ? 3 : 6,
    minWorkers: 2,
    // Nightly full-vitest runs on a 4-vCPU hosted runner where 6 workers
    // oversubscribe the CPU: a beforeEach that boots a full app (registry,
    // migrations replay, scenario import) can starve past vitest's 10s
    // default hook timeout (2026-09 nightly: agreements-phase2 / services
    // migration tests died with "Hook timed out in 10000ms" while passing
    // locally and in the fast lane). 60s: 30s still starved afterEach
    // CLEANUP hooks when suites ran 16+ wall-minutes under load
    // (2026-09-29 nightly: agreements R99 / flows Fix-44a / services v4 all
    // died in teardown, not in the test body).
    hookTimeout: 60_000,
    // Same starvation one level down: on the 4-vCPU hosted runner 6 workers
    // oversubscribe the CPU and whole suites cascade past the 5s default
    // test timeout (2026-09-29 push CI: 84 tests across auth/hass/quotas/
    // twin-sync etc. all died with "Test timed out in 5000ms" while the
    // same commit passed the nightly and locally). 30s matches hookTimeout;
    // suites that need less can still override per-test.
    testTimeout: 30_000,
  },
});
