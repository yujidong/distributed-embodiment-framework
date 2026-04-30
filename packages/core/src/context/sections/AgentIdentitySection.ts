/**
 * Agent Identity Section
 *
 * Builds the agent identity context for LLM consumption.
 * Includes agent name, ID, role, capabilities, and status.
 *
 * Priority: 100 (highest - core identity information)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Agent Identity Section
 *
 * Provides core identity information about the agent.
 * This section is always included as it represents the most fundamental context.
 */
export class AgentIdentitySection extends BaseContextSection {
  readonly id = 'agent-identity';
  readonly priority = 100;

  /**
   * Always include agent identity section
   */
  shouldInclude(_context: SectionContext): boolean {
    return true;
  }

  /**
   * Build agent identity content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const agent = context.agent;
    const role = (agent.metadata?.role as string) || 'general';

    const lines: string[] = [
      '## Agent Identity',
      `- **Name**: ${agent.name}`,
      `- **ID**: ${agent.id}`,
      `- **Role**: ${role}`,
      `- **Capabilities**: ${agent.capabilities.join(', ') || 'None'}`,
      `- **Status**: ${agent.status}`,
      '',
    ];

    return lines.join('\n');
  }
}
