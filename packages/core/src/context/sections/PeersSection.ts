/**
 * Peers Section
 *
 * Builds the peer agents context for LLM consumption.
 * Includes peer agent information, capabilities, and services.
 *
 * Priority: 70 (medium-high - collaboration context)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Peers Section
 *
 * Provides information about other agents available for collaboration.
 * Includes their capabilities and services they offer.
 */
export class PeersSection extends BaseContextSection {
  readonly id = 'peers';
  readonly priority = 70;

  /**
   * Only include when peers exist
   */
  shouldInclude(context: SectionContext): boolean {
    return context.peers.length > 0;
  }

  /**
   * Build peers content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Peer Agents (Available for Collaboration)', ''];

    for (const peer of context.peers) {
      lines.push(`### ${peer.name}`);
      lines.push(`- **Capabilities**: ${peer.capabilities.join(', ') || 'Unknown'}`);
      lines.push(`- **Status**: ${peer.status}`);
      lines.push(`- **Services**: ${peer.services.map(s => s.name).join(', ') || 'None'}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
