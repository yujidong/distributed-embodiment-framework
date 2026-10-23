/**
 * DevLoop — the main orchestration loop for the three-agent self-improvement system.
 *
 *   ExplorerAgent   → explores the platform with zero prior knowledge
 *   CoordinatorAgent → analyzes findings, plans, verifies, logs
 *   DeveloperAgent  → implements fixes/features
 *
 * The loop runs:
 *   EXPLORE → ANALYZE → PLAN → DEVELOP → VERIFY → RETEST → (loop)
 * until the Explorer's satisfaction reaches 5/5 or max iterations.
 */

import { ExplorerAgent } from './explorer-agent.js';
import { CoordinatorAgent } from './coordinator-agent.js';
import { DeveloperAgent } from './developer-agent.js';
import { FindingsLog } from './findings-log.js';
import type { Finding, DevPlan, TaskResult, LoopState, LoopPhase } from './types.js';

export interface DevLoopConfig {
  frontendUrl: string;
  apiUrl: string;
  maxIterations: number;
  /** Delay between phases (ms) — gives humans time to observe. */
  phaseDelayMs: number;
  /** Developer mode: supervised (default) or autonomous (requires LLM). */
  developerMode: 'supervised' | 'autonomous';
  /** Base directory for persistent logs. */
  logDir: string;
}

export class DevLoop {
  private readonly config: DevLoopConfig;
  private readonly explorer: ExplorerAgent;
  private readonly coordinator: CoordinatorAgent;
  private readonly developer: DeveloperAgent;
  private readonly log: FindingsLog;
  private state: LoopState;

  constructor(config: Partial<DevLoopConfig> = {}) {
    this.config = {
      frontendUrl: config.frontendUrl ?? 'http://localhost:5173',
      apiUrl: config.apiUrl ?? 'http://127.0.0.1:8100',
      maxIterations: config.maxIterations ?? 5,
      phaseDelayMs: config.phaseDelayMs ?? 1000,
      developerMode: config.developerMode ?? 'supervised',
      logDir: config.logDir ?? 'data/devloop',
    };

    this.log = new FindingsLog(this.config.logDir);
    this.explorer = new ExplorerAgent({
      frontendUrl: this.config.frontendUrl,
      apiUrl: this.config.apiUrl,
    });
    this.coordinator = new CoordinatorAgent(this.log);
    this.developer = new DeveloperAgent(this.log, {
      supervised: this.config.developerMode === 'supervised',
    });

    this.state = {
      phase: 'explore',
      iteration: 0,
      startedAt: new Date().toISOString(),
      lastPhaseAt: new Date().toISOString(),
      totalFindings: 0,
      resolvedFindings: 0,
      satisfactionTrend: [],
    };
  }

  /**
   * Run the full loop until done.
   */
  async run(): Promise<LoopState> {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║       DevLoop — Three-Agent Self-Improvement      ║');
    console.log('║  Explorer → Coordinator → Developer → Verify     ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`\nConfig: API=${this.config.apiUrl}, max=${this.config.maxIterations} iterations\n`);

    this.log.appendLog('=== DevLoop started ===');
    let allFindings: Finding[] = [];
    let allPlans: DevPlan[] = [];
    let allResults: TaskResult[] = [];

    try {
      while (this.shouldContinue()) {
        this.state.iteration++;
        console.log(`\n${'═'.repeat(50)}\n  ITERATION ${this.state.iteration}\n${'═'.repeat(50)}`);

        // ---- Phase 1: EXPLORE ----
        await this.setPhase('explore');
        console.log('\n🔍 [Explorer] Exploring the system...');
        const round = await this.explorer.explore(this.state.iteration);
        allFindings.push(...round.findings);
        this.state.totalFindings = allFindings.length;
        this.state.satisfactionTrend.push(round.satisfactionScore);

        for (const f of round.findings) {
          this.log.appendFinding(f);
        }
        console.log(`   → ${round.findings.length} findings, satisfaction: ${round.satisfactionScore}/5`);
        console.log(`   → ${round.notes}`);

        // ---- Phase 2: ANALYZE + PLAN ----
        await this.setPhase('analyze');
        console.log('\n📋 [Coordinator] Analyzing findings and creating plan...');
        const plan = await this.coordinator.analyzeAndPlan(round.findings);
        allPlans.push(plan);
        console.log(`   → Plan ${plan.id}: ${plan.tasks.length} tasks`);
        for (const t of plan.tasks) {
          console.log(`     ${t.status === 'pending' ? '⏳' : t.status === 'done' ? '✅' : '⚠️'} ${t.title}`);
        }

        // ---- Phase 3: DEVELOP ----
        await this.setPhase('develop');
        console.log('\n🛠️  [Developer] Executing tasks...');
        const results = await this.developer.execute(plan);
        allResults.push(...results);
        const done = results.filter(r => r.status === 'done').length;
        const needsHuman = results.filter(r => r.status === 'needs_human').length;
        console.log(`   → ${done} done, ${needsHuman} need human, ${results.length - done - needsHuman} failed`);

        // ---- Phase 4: VERIFY ----
        await this.setPhase('verify');
        console.log('\n✅ [Coordinator] Verifying results...');
        for (const result of results) {
          this.coordinator.verifyResult(result, plan);
        }

        // ---- Phase 5: RETEST ----
        if (done > 0) {
          await this.setPhase('retest');
          console.log('\n🔄 [Explorer] Re-testing...');
          const retest = await this.explorer.retest(round.findings);
          this.state.resolvedFindings += retest.resolved.length;
          console.log(`   → ${retest.resolved.length} resolved, ${retest.unresolved.length} still open`);
        }

        // ---- Check exit condition ----
        if (round.satisfactionScore >= 5) {
          await this.setPhase('satisfied');
          console.log('\n🎉 Explorer is fully satisfied! Loop complete.');
          break;
        }

        if (this.state.iteration >= this.config.maxIterations) {
          await this.setPhase('max_iterations');
          console.log(`\n⏹️  Max iterations (${this.config.maxIterations}) reached.`);
          break;
        }

        // Brief pause between iterations
        await this.delay(this.config.phaseDelayMs);
      }
    } catch (error) {
      this.state.phase = 'error';
      console.error(`\n❌ DevLoop error:`, error);
      this.log.appendLog(`**ERROR** — ${error instanceof Error ? error.message : String(error)}`);
    }

    // ---- Final report ----
    console.log('\n📝 Generating final report...');
    this.coordinator.generateReport(this.state, allFindings, allPlans, allResults);
    console.log(`   → ${this.config.logDir}/report.md`);

    return this.state;
  }

  private shouldContinue(): boolean {
    return this.state.phase !== 'error' &&
           this.state.iteration < this.config.maxIterations;
  }

  private async setPhase(phase: LoopPhase): Promise<void> {
    this.state.phase = phase;
    this.state.lastPhaseAt = new Date().toISOString();
    await this.delay(Math.min(this.config.phaseDelayMs, 500));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runDevLoop(config: Partial<DevLoopConfig> = {}): Promise<LoopState> {
  const loop = new DevLoop(config);
  return loop.run();
}
