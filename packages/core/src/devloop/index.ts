/**
 * DevLoop module — three-agent self-improvement loop.
 * See docs/devloop-architecture.md for the full design.
 */

export { ExplorerAgent, type ExplorerConfig, type ExploreRound } from './explorer-agent.js';
export { CoordinatorAgent } from './coordinator-agent.js';
export { DeveloperAgent, type DeveloperConfig } from './developer-agent.js';
export { FindingsLog } from './findings-log.js';
export { DevLoop, runDevLoop, type DevLoopConfig } from './devloop.js';
export type {
  Finding, FindingCategory, FindingSeverity,
  DevTask, DevPlan, TaskResult, TaskStatus,
  LoopState, LoopPhase, AgentMessage,
} from './types.js';
