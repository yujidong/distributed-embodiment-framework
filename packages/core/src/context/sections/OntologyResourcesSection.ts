/**
 * Ontology Resources Section
 *
 * Builds the Resource Ontology context for LLM consumption.
 * Formats Resource Ontology information for semantic understanding.
 *
 * Priority: 85 (after Resources, before Services)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';

/**
 * Ontology Resources Section
 *
 * Provides semantic understanding of resources through ontology information.
 * Only included when resources have ontology defined.
 */
export class OntologyResourcesSection extends BaseContextSection {
  readonly id = 'ontology-resources';
  readonly priority = 85;

  /**
   * Only include when at least one resource has ontology
   */
  shouldInclude(context: SectionContext): boolean {
    return context.resources.some(r => r.resourceOntology !== undefined);
  }

  /**
   * Build resource ontology content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Resource Ontology (Semantic Understanding)', ''];

    for (const resource of context.resources) {
      if (!resource.resourceOntology) {
        continue;
      }

      const onto = resource.resourceOntology;
      lines.push(`### ${resource.name} Semantic Profile`);

      // Ontology class
      lines.push(`- **Ontology Class**: ${onto.ontologyClass}`);

      // Semantic description
      if (onto.semanticDescription) {
        lines.push(`- **Purpose**: ${onto.semanticDescription.purpose || 'N/A'}`);
      }

      // Spatial context
      if (onto.spatialContext) {
        lines.push(`- **Spatial Context**: ${onto.spatialContext.location}`);
      }

      // Raw capabilities
      if (onto.rawCapabilities && onto.rawCapabilities.length > 0) {
        const capNames = onto.rawCapabilities.map(c => c.name).join(', ');
        lines.push(`- **Capabilities**: ${capNames}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
