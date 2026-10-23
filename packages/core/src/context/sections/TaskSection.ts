/**
 * Task Section
 *
 * Builds the current task context for LLM consumption.
 * Only included when a task is provided.
 *
 * Priority: 60 (medium - task-specific context)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Task Section
 *
 * Provides the current task description for the agent.
 * Only included when a specific task is being processed.
 */
export class TaskSection extends BaseContextSection {
  readonly id = 'task';
  readonly priority = 60;

  /**
   * Only include when a task is provided
   */
  shouldInclude(context: SectionContext): boolean {
    return context.task !== undefined && context.task.length > 0;
  }

  /**
   * Build task content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = [
      '## Current Task',
      context.task || '',
      '',
    ];

    return lines.join('\n');
  }
}
