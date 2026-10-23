/**
 * Temporal Section
 *
 * Builds the temporal context for LLM consumption.
 * Includes current time and time scale information.
 *
 * Priority: 40 (lower - auxiliary information)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Temporal Section
 *
 * Provides time-related context information.
 * Always included as temporal context is relevant for decision-making.
 */
export class TemporalSection extends BaseContextSection {
  readonly id = 'temporal';
  readonly priority = 40;

  /**
   * Always include temporal section
   */
  shouldInclude(_context: SectionContext): boolean {
    return true;
  }

  /**
   * Build temporal content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Temporal Information'];

    lines.push(`- **Current Time**: ${context.temporal.currentTime.toISOString()}`);

    if (context.temporal.timeScale) {
      lines.push(`- **Time Scale**: ${context.temporal.timeScale}x`);
    }

    lines.push(''); // Empty line at end
    return lines.join('\n');
  }
}
