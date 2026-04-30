/**
 * Ontology Reasoning Section
 *
 * Builds the Ontology Reasoning results context for LLM consumption.
 * Formats reasoning analysis for decision-making support.
 *
 * Priority: 50 (lower - optional analysis)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Ontology Reasoning Section
 *
 * Provides reasoning analysis results for LLM consumption.
 * Only included when ontology reasoning has been performed.
 */
export class OntologyReasoningSection extends BaseContextSection {
  readonly id = 'ontology-reasoning';
  readonly priority = 50;

  /**
   * Only include when ontology reasoning is available
   */
  shouldInclude(context: SectionContext): boolean {
    return context.ontologyReasoning !== undefined;
  }

  /**
   * Build ontology reasoning content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const reasoning = context.ontologyReasoning;
    if (!reasoning) {
      return '';
    }

    const lines: string[] = ['## Ontology Reasoning Analysis', ''];

    // Internal capability analysis
    lines.push('### Internal Capability Analysis');
    const canHandle = reasoning.internalReasoning?.canHandle ?? reasoning.canHandleInternally;
    lines.push(`- **Can Handle Internally**: ${canHandle ? 'Yes' : 'No'}`);

    if (reasoning.internalReasoning?.matchingResources && reasoning.internalReasoning.matchingResources.length > 0) {
      const resourceIds = reasoning.internalReasoning.matchingResources.map(r => r.name || r.id).join(', ');
      lines.push(`- **Matching Resources**: ${resourceIds}`);
    }
    lines.push('');

    // Collaboration analysis
    lines.push('### Collaboration Analysis');
    const canCollaborate = reasoning.externalReasoning?.compatibleServices &&
      reasoning.externalReasoning.compatibleServices.length > 0;
    lines.push(`- **Can Collaborate**: ${canCollaborate ? 'Yes' : 'No'}`);

    if (reasoning.externalReasoning?.compatibleServices && reasoning.externalReasoning.compatibleServices.length > 0) {
      const serviceNames = reasoning.externalReasoning.compatibleServices.map(s => s.serviceName).join(', ');
      lines.push(`- **Compatible Services**: ${serviceNames}`);
    }
    lines.push('');

    // Recommended strategy
    const combinedReasoning = (reasoning as unknown as { combinedReasoning?: { recommendedStrategy?: string; confidence?: number } }).combinedReasoning;
    if (reasoning.recommendedStrategy || combinedReasoning?.recommendedStrategy) {
      lines.push('### Recommended Strategy');
      const strategy = reasoning.recommendedStrategy || combinedReasoning?.recommendedStrategy;
      lines.push(`- **Strategy**: ${strategy}`);

      const confidence = combinedReasoning?.confidence;
      if (confidence !== undefined) {
        lines.push(`- **Confidence**: ${(confidence * 100).toFixed(0)}%`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
