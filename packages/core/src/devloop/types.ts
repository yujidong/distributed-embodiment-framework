/**
 * DevLoop shared types — the three-agent self-improvement loop.
 * See docs/devloop-architecture.md for the full design.
 */

// ---------------------------------------------------------------------------
// Explorer findings
// ---------------------------------------------------------------------------

export type FindingCategory =
  | 'bug'           // 系统行为与预期不符
  | 'limitation'    // 系统无法做到探索者想做的事
  | 'confusion'     // 能做到但交互让人困惑
  | 'success'       // 成功完成的操作（正向记录）
  | 'idea';         // 探索者想到的新功能点子

export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker';

export interface Finding {
  id: string;
  timestamp: string;
  agent: 'explorer';
  category: FindingCategory;
  description: string;
  steps: string[];
  expected?: string;
  actual: string;
  severity: FindingSeverity;
  area: string;
  /** Explorer's satisfaction score for this area (1-5, 5 = fully satisfied). */
  satisfactionScore?: number;
}

// ---------------------------------------------------------------------------
// Coordinator plans
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped' | 'needs_human';

export interface DevTask {
  id: string;
  findingIds: string[];
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  assignee: 'developer';
  result?: string;
  filesTouched?: string[];
}

export interface DevPlan {
  id: string;
  createdAt: string;
  iterationNumber: number;
  tasks: DevTask[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Developer results
// ---------------------------------------------------------------------------

export interface TaskResult {
  taskId: string;
  status: 'done' | 'failed' | 'needs_human';
  message: string;
  filesTouched: string[];
  testsPassed: boolean;
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

export type LoopPhase =
  | 'explore'       // Explorer is exploring
  | 'analyze'       // Coordinator is analyzing findings
  | 'plan'          // Coordinator is creating a plan
  | 'develop'       // Developer is implementing
  | 'verify'        // Coordinator is verifying
  | 'retest'        // Explorer is re-testing
  | 'satisfied'     // Loop complete — Explorer satisfied
  | 'max_iterations'
  | 'error';

export interface LoopState {
  phase: LoopPhase;
  iteration: number;
  startedAt: string;
  lastPhaseAt: string;
  totalFindings: number;
  resolvedFindings: number;
  satisfactionTrend: number[];   // per-iteration average satisfaction (1-5)
}

// ---------------------------------------------------------------------------
// Agent messages (inter-agent communication)
// ---------------------------------------------------------------------------

export type AgentMessage =
  | { from: 'explorer'; to: 'coordinator'; type: 'findings'; findings: Finding[] }
  | { from: 'coordinator'; to: 'developer'; type: 'plan'; plan: DevPlan }
  | { from: 'developer'; to: 'coordinator'; type: 'task_result'; result: TaskResult }
  | { from: 'coordinator'; to: 'explorer'; type: 'retest'; resolvedTaskIds: string[] }
  | { from: 'explorer'; to: 'coordinator'; type: 'satisfaction'; score: number; notes: string }
  | { from: 'coordinator'; to: 'devloop'; type: 'phase_complete'; nextPhase: LoopPhase };
