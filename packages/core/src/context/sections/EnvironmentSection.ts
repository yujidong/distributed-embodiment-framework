/**
 * Environment Section
 *
 * Builds the environment state context for LLM consumption.
 * Includes environment name, type, physical parameters, and zones.
 *
 * Priority: 95 (second highest - critical context)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Environment Section
 *
 * Provides information about the physical environment the agent operates in.
 * Includes physical state parameters and zone information.
 */
export class EnvironmentSection extends BaseContextSection {
  readonly id = 'environment';
  readonly priority = 95;

  /**
   * Always include environment section
   */
  shouldInclude(_context: SectionContext): boolean {
    return true;
  }

  /**
   * Build environment state content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const env = context.environment;
    const lines: string[] = ['## Environment State'];

    lines.push(`- **Environment Name**: ${env.name}`);
    lines.push(`- **Environment Type**: ${env.type}`);

    // Add physical state if available
    if (env.physicalState) {
      const physicalParams = Object.entries(env.physicalState)
        .filter(([_, v]) => typeof v !== 'object')
        .map(([k, v]) => `  - ${k}: ${v}`);

      if (physicalParams.length > 0) {
        lines.push(`- **Physical Parameters**:`);
        lines.push(physicalParams.join('\n'));
      }
    }

    // Add zones if available
    if (env.zones && env.zones.length > 0) {
      lines.push(`- **Zones**:`);
      for (const zone of env.zones) {
        lines.push(`  - ${zone.name}: ${JSON.stringify(zone.state)}`);
      }
    }

    lines.push(''); // Empty line at end
    return lines.join('\n');
  }
}
