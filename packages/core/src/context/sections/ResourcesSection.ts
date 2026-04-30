/**
 * Resources Section
 *
 * Builds the resources (devices) context for LLM consumption.
 * Includes device information, capabilities, states, and availability.
 *
 * Priority: 90 (high - core resources)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Resources Section
 *
 * Provides information about available resources (devices) the agent can use.
 * Only included when resources exist.
 */
export class ResourcesSection extends BaseContextSection {
  readonly id = 'resources';
  readonly priority = 90;

  /**
   * Only include when resources exist
   */
  shouldInclude(context: SectionContext): boolean {
    return context.resources.length > 0;
  }

  /**
   * Build resources content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Available Resources (Devices)'];
    lines.push('You can directly control the following devices:');
    lines.push('');

    for (const resource of context.resources) {
      lines.push(`### ${resource.name} (${resource.type})`);
      lines.push(`- **ID**: ${resource.id}`);
      lines.push(`- **Location**: ${resource.location || 'Unknown'}`);
      lines.push(`- **Capabilities**: ${resource.capabilities.join(', ')}`);
      lines.push(`- **Current State**: ${JSON.stringify(resource.currentState)}`);
      lines.push(`- **Online**: ${resource.isOnline ? 'Yes' : 'No'}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
