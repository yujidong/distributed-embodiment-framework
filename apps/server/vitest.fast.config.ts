/**
 * F4-1 PR 快道配置（plan-r84）— `npm run test:fast` 时 server 用本配置。
 *
 * 与 vitest.config.ts（全量道，ci.yml 的 `npm test` 用）的唯一差别是
 * exclude 多了三类：
 *
 * - `*-mbt.vitest.test.ts`  重型 model-based testing（F1 状态机随机
 *   迁移序列，单文件分钟级）。它们在全量道与夜间道照常跑 —— 快道只是
 *   不等它们，不是删除覆盖。
 * - `*.flaky.vitest.test.ts`  flaky 隔离区约定（docs/ci.md）：确认
 *   偶发且未根治的测试文件改名带 `.flaky.` 段，快道跳过、全量道照跑，
 *   根治后改回原名。
 * - `HEAVY_FULL_APP_SUITES`（下）  实测 > 25s 的重启动成本组
 *   （plan-r84 Wave D），全量道与 nightly full-vitest 照常跑。
 *
 * LLM 夜间道不是 vitest 测试（是 scripts/eval/* 的 runner），无需在此排除。
 */
import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * plan-r84 Wave D（2026-09-04）：重启动成本组，移出快道。
 *
 * 快道压 5 分钟的最后手段：workers 已证明加不动（12 workers 只省 ~30s 且
 * flap，见下），瓶颈是每文件 full-app 启动的固定成本 × 文件数。这一组是
 * 2026-09-04 实测墙钟 > 25s 的 27 个文件（合计 ~1181s，约占全套件执行
 * 时间的 52%）——它们不是慢在断言，是慢在各自起几十次 full-app。
 * 阈值初版取 30s（16 文件），实测机器有外部负载时余量不足 30s，放宽到
 * 25s 换取 ~60s 的抗负载余量（2026-09-04 三次全量计时见 docs/ci.md）。
 *
 * 归属（不是删除覆盖）：ci.yml 的 PR 全量道（`npm test`）与 nightly.yml
 * 的 full-vitest job 都跑全量套件，这 27 个文件在那里照常门禁。契约类
 * 文件（openapi / nl-metamorphic / *.props 等）即使将来变慢也留在快道
 * ——快道的契约/属性/蜕变规则道覆盖不变。
 *
 * 维护规则：文件改名时同步本列表；新增套件实测 > 25s 时加入本列表
 * （在 nightly 复跑里有归属，见 nightly.yml full-vitest 注释）。
 */
const HEAVY_FULL_APP_SUITES = [
  'src/proposals.vitest.test.ts', // 92.3s
  'src/services.vitest.test.ts', // 89.8s
  'src/flows.vitest.test.ts', // 87.4s
  'src/agreements.vitest.test.ts', // 72.3s
  'src/env-objects.vitest.test.ts', // 56.6s
  'src/data-services.vitest.test.ts', // 53.4s
  'src/agreements-phase2.vitest.test.ts', // 52.6s
  'src/standing-asks.vitest.test.ts', // 52.0s
  'src/scenarios.vitest.test.ts', // 51.9s
  'src/environments.vitest.test.ts', // 50.7s
  'src/flow-services.vitest.test.ts', // 50.2s
  'src/perspective.vitest.test.ts', // 38.7s
  'src/simulations.vitest.test.ts', // 34.4s
  'src/env-delegations.vitest.test.ts', // 33.3s
  'src/geo.vitest.test.ts', // 30.9s
  'src/proposals-ownership-transfer.vitest.test.ts', // 30.6s
  'src/auth.vitest.test.ts', // 29.3s
  'src/members.vitest.test.ts', // 29.3s
  'src/classroom-ops.vitest.test.ts', // 29.3s
  'src/catalog.vitest.test.ts', // 29.2s
  'src/static-web.vitest.test.ts', // 27.4s
  'src/env-onboarding.vitest.test.ts', // 27.1s
  'src/flow-policy-envelope.vitest.test.ts', // 27.0s
  'src/notifications.vitest.test.ts', // 26.6s
  'src/shares.vitest.test.ts', // 26.4s
  'src/access-grants.vitest.test.ts', // 25.8s
  'src/external-invoke.vitest.test.ts', // 25.5s
  // UX-W3 导入道：IFC 解析器（web-ifc WASM 冷启动）+ 图纸/OSM 全 app 组装，
  // 快道 5s 默认超时必死（2026-10-03 实测 15/15 超时），全量道照常门禁。
  'src/environment-imports.vitest.test.ts',
  // UX-W3 模板参数化：13 个 full-app + 展开用例实测 ~98s（2026-10-05）。
  'src/scenario-template-instantiate.vitest.test.ts',
];

export default defineConfig({
  test: {
    // Windows 下快道用 forks pool（2026-09-11，证据见 docs/ci.md「Windows
    // teardown 段错误」）：threads pool 在全套件跑完、tinypool 销毁 worker
    // 的 teardown 阶段以 0xC0000005 段错误退出（7 跑约 6 崩，定位到最后
    // 一个测试文件全绿之后）；关掉所有测试侧的 better-sqlite3 句柄泄漏后
    // 仍 3/3 崩，而 --pool=forks 100% 稳定。vitest 官方本就不建议
    // worker_threads 跑 better-sqlite3 这类 native 模块。Linux CI 保持
    // threads（未观测到该崩溃，且更快）。maxWorkers/minWorkers 语义不变。
    pool: process.platform === 'win32' ? 'forks' : 'threads',
    // 与全量道同为 6 workers：实测 12 workers 只省 ~30s 墙钟（瓶颈是每个
    // 文件的 full-app 启动而非并发槽），却立即 flap 三个计时敏感文件
    // （hass-simulation / observability / quotas，2026-09-03 实测）——
    // 全量道注释里的并行饥饿约束在快道同样成立。
    maxWorkers: 6,
    minWorkers: 2,
    // 与全量道同款饥饿预算：forks pool 下每次 full-app 启动都是独立进程
    // spawn，机器负载高时 beforeEach 会饿过 10s 默认 hook 超时
    // （2026-10-05：device-templates 单套件独立复跑都超时；全量道
    // vitest.config.ts 的 60s 是 CI 4-vCPU 证据，快道按 30s 折中）。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    exclude: [
      ...defaultExclude,
      '**/*-mbt.vitest.test.ts',
      '**/*.flaky.vitest.test.ts',
      ...HEAVY_FULL_APP_SUITES,
    ],
  },
});
