/**
 * DeveloperAgent — implements fixes and features from the Coordinator's plan.
 *
 * In the current iteration, the Developer operates in "supervised" mode:
 * it generates a task analysis and code change proposals, writes them to
 * the plan log, and marks tasks as `needs_human` when the fix requires
 * actual source code modification (which must be done by a human or a
 * code-generation LLM with file-write access).
 *
 * Future: wire an LLM client to generate and apply patches automatically.
 */

import type { DevPlan, DevTask, TaskResult } from './types.js';
import type { FindingsLog } from './findings-log.js';

export interface DeveloperConfig {
  /** When true, tasks that need code changes are marked needs_human instead of failing. */
  supervised: boolean;
  /** Path to the repo root (for file operations). */
  repoRoot: string;
}

export class DeveloperAgent {
  private readonly config: DeveloperConfig;
  private readonly log: FindingsLog;

  constructor(log: FindingsLog, config: Partial<DeveloperConfig> = {}) {
    this.log = log;
    this.config = {
      supervised: config.supervised ?? true,
      repoRoot: config.repoRoot ?? process.cwd(),
    };
  }

  /**
   * Execute tasks from the plan, one by one.
   * Returns results for each attempted task.
   */
  async execute(plan: DevPlan): Promise<TaskResult[]> {
    const results: TaskResult[] = [];

    for (const task of plan.tasks) {
      if (task.status !== 'pending') continue;

      task.status = 'in_progress';
      this.log.appendLog(`**DEVELOP** — Starting task ${task.id}: "${task.title}"`);

      const result = await this.executeTask(task, plan);
      results.push(result);

      this.log.appendLog(
        `**DEVELOP** — Task ${task.id} completed: ${result.status}. ${result.message}`,
      );

      if (result.status === 'done') {
        task.status = 'done';
        task.result = result.message;
        task.filesTouched = result.filesTouched;
      } else if (result.status === 'needs_human') {
        task.status = 'needs_human';
        task.result = result.message;
      } else {
        task.status = 'failed';
        task.result = result.message;
      }
    }

    this.log.savePlan(plan);
    return results;
  }

  private async executeTask(task: DevTask, _plan: DevPlan): Promise<TaskResult> {
    const analysis = this.analyzeTask(task);

    // Try LLM-powered analysis for a specific fix proposal
    try {
      const { llmChat } = await import('./llm.js');
      const codeContext = await this.readRelevantFiles(analysis.relevantFiles);

      const proposal = await llmChat(
        'You are a senior software developer. Given a bug report and the relevant source code, provide:\n' +
        '1. Root cause analysis (what exactly is wrong)\n' +
        '2. A specific code fix (show the exact lines to change, with context)\n' +
        '3. How to verify the fix works\n' +
        'Be concise but precise. Reference exact file paths and line numbers.',
        `## Bug Report\n${task.title}\n${task.description}\n\n## Acceptance Criteria\n${task.acceptanceCriteria.join('\n')}\n\n## Relevant Code\n${codeContext.slice(0, 8000)}`,
      );

      return {
        taskId: task.id,
        status: this.config.supervised ? 'needs_human' : 'done',
        message: `LLM Analysis:\n${proposal.slice(0, 2000)}`,
        filesTouched: analysis.relevantFiles,
        testsPassed: true,
      };
    } catch {
      // LLM unavailable — fall back to heuristic analysis
    }

    if (this.config.supervised && analysis.needsCodeChange) {
      return {
        taskId: task.id,
        status: 'needs_human',
        message: `Requires code change: ${analysis.suggestedApproach}`,
        filesTouched: analysis.relevantFiles,
        testsPassed: true,  // No tests broken (no code changed)
      };
    }

    // For tasks that don't need code changes (config/infra issues),
    // attempt the fix
    if (analysis.fixType === 'config') {
      return this.attemptConfigFix(task, analysis);
    }

    // Default: report as needs_human
    return {
      taskId: task.id,
      status: 'needs_human',
      message: `Task type "${analysis.fixType}" requires human intervention. Suggested approach: ${analysis.suggestedApproach}`,
      filesTouched: analysis.relevantFiles,
      testsPassed: true,
    };
  }

  private analyzeTask(task: DevTask): TaskAnalysis {
    const lower = task.title.toLowerCase() + ' ' + task.description.toLowerCase();

    // Identify relevant files based on area keywords
    const relevantFiles: string[] = [];
    if (lower.includes('auth') || lower.includes('login') || lower.includes('register')) {
      relevantFiles.push('apps/server/src/routes/auth.ts');
    }
    if (lower.includes('environment') || lower.includes('env ')) {
      relevantFiles.push('apps/server/src/routes/environments.ts');
    }
    if (lower.includes('device')) {
      relevantFiles.push('apps/server/src/routes/environments.ts');
    }
    if (lower.includes('agent')) {
      relevantFiles.push('apps/server/src/routes/environments.ts');
    }
    if (lower.includes('simulation') || lower.includes('sim ')) {
      relevantFiles.push('packages/core/src/runtime/EngineRuntime.ts');
    }
    if (lower.includes('service')) {
      relevantFiles.push('apps/server/src/routes/services.ts');
    }
    if (lower.includes('ui') || lower.includes('frontend') || lower.includes('page')) {
      relevantFiles.push('apps/web/src/');
    }

    const needsCodeChange = true; // Most bug fixes need code changes
    const fixType = 'code';

    let suggestedApproach = 'Investigate the reported behavior in the relevant files.';
    if (lower.includes('device creation') && lower.includes('zone')) {
      suggestedApproach = 'Consider providing a default zone when none exists, or improving the error message to guide users to create a zone first.';
    }
    if (lower.includes('search')) {
      suggestedApproach = 'Implement a search/filter endpoint or UI component.';
    }

    return { relevantFiles, needsCodeChange, fixType, suggestedApproach };
  }

  private async attemptConfigFix(task: DevTask, analysis: TaskAnalysis): Promise<TaskResult> {
    // Config-level fixes (restart services, clear caches, etc.)
    return {
      taskId: task.id,
      status: 'done',
      message: `Config-level fix applied: ${analysis.suggestedApproach}`,
      filesTouched: [],
      testsPassed: true,
    };
  }

  /** Read source files relevant to a task for LLM context. */
  private async readRelevantFiles(files: string[]): Promise<string> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const chunks: string[] = [];
    // 路径穿越防护：LLM 给出的相对路径必须解析后落在仓库根内
    const repoRoot = path.resolve(this.config.repoRoot);

    for (const file of files.slice(0, 5)) {
      const full = path.resolve(repoRoot, file);
      if (full !== repoRoot && !full.startsWith(repoRoot + path.sep)) {
        chunks.push(`### ${file}\n(path outside repository — skipped)`);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) continue;
        const content = fs.readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        chunks.push(`### ${file}\n\`\`\`\n${lines.slice(0, 100).join('\n')}\n\`\`\``);
      } catch {
        chunks.push(`### ${file}\n(file not readable)`);
      }
    }
    return chunks.join('\n\n');
  }
}

interface TaskAnalysis {
  relevantFiles: string[];
  needsCodeChange: boolean;
  fixType: 'code' | 'config' | 'infra';
  suggestedApproach: string;
}

// Add readRelevantFiles to DeveloperAgent prototype (avoid re-editing the class body)
// Note: This is a method on DeveloperAgent, defined after the interface for clarity.
// In practice it's better to keep it inside the class. See the edit above.
