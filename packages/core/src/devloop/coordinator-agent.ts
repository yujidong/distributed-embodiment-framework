/**
 * CoordinatorAgent — analyzes Explorer findings, creates development plans,
 * verifies Developer results, and maintains the persistent log.
 */

import type { Finding, DevPlan, DevTask, TaskResult, LoopState } from './types.js';
import type { FindingsLog } from './findings-log.js';

export class CoordinatorAgent {
  private readonly log: FindingsLog;
  private iterationNumber = 0;

  constructor(log: FindingsLog) {
    this.log = log;
  }

  /**
   * Phase 1: Analyze findings and create a development plan.
   * Uses LLM for deep analysis; falls back to heuristic grouping.
   */
  async analyzeAndPlan(findings: Finding[]): Promise<DevPlan> {
    this.iterationNumber++;
    const planId = `plan-${String(this.iterationNumber).padStart(3, '0')}`;

    // Try LLM-powered analysis first
    let tasks: DevTask[];
    let summary: string;

    try {
      const { llmJson } = await import('./llm.js');
      const findingsText = findings.map(f =>
        `ID:${f.id} [${f.category}/${f.severity}] ${f.area}: ${f.description} | Steps: ${f.steps.join('→')} | Actual: ${f.actual}`,
      ).join('\n');

      const llmResult = await llmJson<{
        summary: string;
        tasks: Array<{
          title: string;
          description: string;
          findingIds: string[];
          acceptanceCriteria: string[];
          priority: 'high' | 'medium' | 'low';
        }>;
      }>(
        'You are a technical project coordinator analyzing findings from an automated system explorer. Create actionable development tasks from these findings. Group related findings, prioritize by impact. For each task provide: title, description, source finding IDs, acceptance criteria. Respond as JSON.',
        `Findings from exploration:\n${findingsText}\n\nCreate a prioritized development plan:`,
      );

      tasks = llmResult.tasks.map((t, i) => ({
        id: `${planId}-T${String(i + 1).padStart(2, '0')}`,
        findingIds: t.findingIds,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        status: 'pending' as const,
        assignee: 'developer' as const,
      }));
      summary = llmResult.summary;
    } catch {
      // Fallback to heuristic
      const heuristic = this.heuristicPlan(findings, planId);
      tasks = heuristic.tasks;
      summary = heuristic.summary;
    }

    const plan: DevPlan = {
      id: planId,
      createdAt: new Date().toISOString(),
      iterationNumber: this.iterationNumber,
      tasks,
      summary,
    };

    this.log.savePlan(plan);
    this.log.appendLog(
      `**ANALYZE** — Received ${findings.length} findings. ` +
      `Created plan ${plan.id} with ${tasks.length} tasks.\n\n${summary}`,
    );

    for (const f of findings) {
      if (f.category === 'bug') {
        this.log.appendLesson(`[${f.area}] ${f.description} — always verify this area after changes`);
      }
      if (f.category === 'confusion') {
        this.log.appendLesson(`[${f.area}] UX confusion: ${f.description} — consider improving discoverability`);
      }
    }

    return plan;
  }

  private heuristicPlan(findings: Finding[], planId: string): { tasks: DevTask[]; summary: string } {
    const tasks: DevTask[] = [];
    const actionable = findings.filter(f =>
      f.category === 'bug' || f.category === 'limitation' || f.category === 'confusion',
    );
    const sorted = actionable.sort((a, b) => {
      const order = { blocker: 0, high: 1, medium: 2, low: 3 } as const;
      return order[a.severity] - order[b.severity];
    });
    const seen = new Set<string>();
    for (const f of sorted) {
      const key = `${f.area}:${f.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({
        id: `${planId}-T${String(tasks.length + 1).padStart(2, '0')}`,
        findingIds: [f.id],
        title: this.summarizeFinding(f),
        description: `${f.description}\n\nSteps: ${f.steps.join(' → ')}\nExpected: ${f.expected ?? 'N/A'}\nActual: ${f.actual}`,
        acceptanceCriteria: [`The issue "${f.description}" no longer occurs`],
        status: 'pending',
        assignee: 'developer',
      });
    }
    const summary = `Round ${this.iterationNumber}: ${sorted.length} actionable findings → ${tasks.length} tasks.`;
    return { tasks, summary };
  }

  /**
   * Phase 2: Verify a Developer's task result.
   */
  verifyResult(result: TaskResult, plan: DevPlan): boolean {
    const task = plan.tasks.find(t => t.id === result.taskId);
    if (!task) return false;

    task.status = result.status === 'done' ? 'done' : result.status;
    task.result = result.message;
    task.filesTouched = result.filesTouched;

    this.log.savePlan(plan);
    this.log.appendLog(
      `**VERIFY** — Task ${task.id} "${task.title}" → ${result.status}. ` +
      `${result.testsPassed ? 'Tests passed.' : 'Tests FAILED.'} ` +
      `Files: ${result.filesTouched.join(', ')}`,
    );

    if (!result.testsPassed) {
      this.log.appendLesson(
        `[${task.id}] Tests failed after fix — investigate test stability`,
      );
    }

    return result.status === 'done' && result.testsPassed;
  }

  /**
   * Determine whether the loop should continue.
   */
  shouldContinue(state: LoopState, latestSatisfaction: number): boolean {
    if (state.iteration >= 10) {
      this.log.appendLog('**LOOP END** — Maximum iterations reached.');
      return false;
    }
    if (latestSatisfaction >= 5) {
      this.log.appendLog('**LOOP END** — Explorer is fully satisfied! 🎉');
      return false;
    }
    return true;
  }

  /**
   * Generate the final report.
   */
  generateReport(state: LoopState, findings: Finding[], plans: DevPlan[], results: TaskResult[]): void {
    this.log.writeReport(state, findings, plans, results);
    this.log.appendLog('**REPORT** — Final report generated at data/devloop/report.md');
  }

  private summarizeFinding(f: Finding): string {
    const prefix = f.severity === 'blocker' ? '🔴' : f.severity === 'high' ? '🟠' : '🟡';
    return `${prefix} [${f.area}] ${f.description}`;
  }
}
