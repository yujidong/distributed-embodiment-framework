/**
 * Ontology Services Section
 *
 * Builds the Service Ontology context for LLM consumption.
 * Formats Service Ontology information for semantic understanding.
 *
 * Priority: 75 (after Services, before Peers)
 */

import { BaseContextSection, type SectionContext } from './ContextSection.js';
import type { ServiceInfo } from '../AgentContextBuilder.js';

/**
 * Ontology Services Section
 *
 * Provides semantic understanding of services through ontology information.
 * Includes both own services and services from peers.
 */
export class OntologyServicesSection extends BaseContextSection {
  readonly id = 'ontology-services';
  readonly priority = 75;

  /**
   * Only include when at least one service has ontology
   */
  shouldInclude(context: SectionContext): boolean {
    const allServices = [...context.services.own, ...context.services.fromPeers];
    return allServices.some(s => s.serviceOntology !== undefined);
  }

  /**
   * Build service ontology content for LLM
   */
  async build(context: SectionContext): Promise<string> {
    const lines: string[] = ['## Service Ontology (Business Capabilities)', ''];

    // Own services
    for (const service of context.services.own) {
      if (service.serviceOntology) {
        lines.push(this.formatServiceOntology(service, 'own'));
      }
    }

    // Peer services
    for (const service of context.services.fromPeers) {
      if (service.serviceOntology) {
        lines.push(this.formatServiceOntology(service, 'peer'));
      }
    }

    return lines.join('\n');
  }

  /**
   * Format a single service ontology
   */
  private formatServiceOntology(service: ServiceInfo, source: 'own' | 'peer'): string {
    const onto = service.serviceOntology!;
    const lines: string[] = [];

    const sourceLabel = source === 'own' ? 'Own' : 'Peer';
    lines.push(`### ${service.name} (${sourceLabel})`);

    // Service type and ontology class
    lines.push(`- **Service Type**: ${onto.serviceType}`);
    lines.push(`- **Ontology Class**: ${onto.ontologyClass}`);

    // Business capability
    if (onto.businessCapability) {
      lines.push(`- **Business Capability**: ${onto.businessCapability.name}`);
    }

    // Semantic context
    if (onto.semanticContext) {
      if (onto.semanticContext.applicableScenarios && onto.semanticContext.applicableScenarios.length > 0) {
        lines.push(`- **Applicable Scenarios**: ${onto.semanticContext.applicableScenarios.join(', ')}`);
      }
      if (onto.semanticContext.collaborationHints && onto.semanticContext.collaborationHints.length > 0) {
        lines.push(`- **Collaboration Hints**: ${onto.semanticContext.collaborationHints.join('; ')}`);
      }
    }

    // Dependencies
    if (onto.dependencies && onto.dependencies.length > 0) {
      const depTypes = onto.dependencies.map(d => d.type).join(', ');
      lines.push(`- **Dependencies**: ${depTypes}`);
    }

    lines.push('');
    return lines.join('\n');
  }
}
