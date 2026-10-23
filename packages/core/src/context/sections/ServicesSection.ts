/**
 * Services Section
 *
 * Builds the services context for LLM consumption.
 * Includes own services and services available from peers.
 *
 * Priority: 80 (high - service availability)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Services Section
 *
 * Provides information about available services - both own and from peers.
 * Enables collaboration by exposing service capabilities.
 */
export class ServicesSection extends BaseContextSection {
  readonly id = 'services';
  readonly priority = 80;

  /**
   * Only include when any services exist (own or from peers)
   */
  shouldInclude(context: SectionContext): boolean {
    return context.services.own.length > 0 || context.services.fromPeers.length > 0;
  }

  /**
   * Build services content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Available Services'];

    // Own services
    if (context.services.own.length > 0) {
      lines.push('');
      lines.push('**Your Services**:');
      for (const service of context.services.own) {
        const description = service.description || service.category;
        lines.push(`- ${service.name}: ${description}`);
      }
    }

    // Services from peers
    if (context.services.fromPeers.length > 0) {
      lines.push('');
      lines.push('**Services from Other Agents** (available via collaboration):');
      for (const service of context.services.fromPeers) {
        const description = service.description || service.category;
        lines.push(`- ${service.name} (from ${service.providerAgentName}): ${description}`);
      }
    }

    lines.push(''); // Empty line at end
    return lines.join('\n');
  }
}
