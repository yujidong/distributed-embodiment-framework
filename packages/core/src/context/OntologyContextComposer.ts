/**
 * Ontology Context Composer
 *
 * Central composer that aggregates ontology reasoning results and formats them
 * for LLM consumption. Coordinates between resources, services, and the reasoning engine.
 *
 * As per ONTOLOGY-CONTEXT-INTEGRATION.md
 */

import type { OntologyReasoningEngine, CombinedReasoningResult, InternalReasoningResult, PeerServiceReasoningResult } from '../ontology/OntologyReasoningEngine.js';
import type { DeviceStateInfo, ServiceInfo, PeerAgentInfo } from './AgentContextBuilder.js';
import type { ResourceOntology } from '../resource/Resource.js';
import type { ServiceOntology } from '../service/SemanticService.js';

/**
 * Ontology resource format for reasoning engine
 */
export interface OntologyResource {
  id: string;
  name: string;
  type: string;
  ontology?: ResourceOntology;
}

/**
 * Ontology service format for reasoning engine
 */
export interface OntologyService {
  id: string;
  name: string;
  ontology?: ServiceOntology;
}

/**
 * Result of ontology context composition
 */
export interface OntologyContextResult {
  /** Internal reasoning about own capabilities */
  internalReasoning?: InternalReasoningResult;

  /** External reasoning about peer services */
  externalReasoning?: PeerServiceReasoningResult;

  /** Combined reasoning result */
  combinedReasoning?: CombinedReasoningResult;

  /** Human-readable summary */
  summary: string;
}

/**
 * Ontology Context Composer
 *
 * Aggregates ontology reasoning and formats results for LLM consumption.
 * Used by AgentContextBuilder to enrich context with ontology information.
 */
export class OntologyContextComposer {
  private reasoningEngine: OntologyReasoningEngine;

  constructor(reasoningEngine: OntologyReasoningEngine) {
    this.reasoningEngine = reasoningEngine;
  }

  /**
   * Compose ontology context for a specific task
   *
   * Performs internal, external, and combined reasoning to provide
   * comprehensive ontology context for decision-making.
   *
   * @param task - The task description
   * @param resources - Available resources with ontology
   * @param services - Available services (own and from peers)
   * @param peers - Peer agents with their services
   * @returns Ontology context result with reasoning
   */
  async composeForTask(
    task: string,
    resources: DeviceStateInfo[],
    services: { own: ServiceInfo[]; fromPeers: ServiceInfo[] },
    peers: PeerAgentInfo[]
  ): Promise<OntologyContextResult> {
    // Convert to ontology format
    const ontologyResources = resources.map(r => this.toOntologyResource(r));

    // Get all services (own + from peers) for reasoning
    const allOwnServices = services.own.map(s => this.toOntologyService(s));
    const allPeerServices = this.extractPeerServices(peers);

    // 1. Perform internal reasoning about own capabilities
    const internalReasoning = await this.reasoningEngine.reasonAboutOwnCapabilities(
      task,
      ontologyResources,
      allOwnServices
    );

    // 2. Perform external reasoning about peer services
    const externalReasoning = await this.reasoningEngine.reasonAboutPeerServices(
      task,
      allPeerServices
    );

    // 3. Combined reasoning
    const combinedReasoning = await this.reasoningEngine.combinedReasoning(task, {
      resources: ontologyResources,
      peerServices: allPeerServices,
    });

    // Generate summary
    const summary = this.generateSummary(internalReasoning, externalReasoning, combinedReasoning);

    return {
      internalReasoning,
      externalReasoning,
      combinedReasoning,
      summary,
    };
  }

  /**
   * Format ontology context result for LLM consumption
   *
   * @param result - The ontology context result
   * @returns Formatted string for LLM
   */
  formatForLLM(result: OntologyContextResult): string {
    const lines: string[] = [];

    // Internal reasoning summary
    if (result.internalReasoning) {
      lines.push('### Internal Capability Analysis');
      lines.push(`- Can Handle: ${result.internalReasoning.canHandle ? 'Yes' : 'No'}`);
      if (result.internalReasoning.matchingResources.length > 0) {
        lines.push(`- Matching Resources: ${result.internalReasoning.matchingResources.map(r => r.name).join(', ')}`);
      }
      if (result.internalReasoning.missingCapabilities.length > 0) {
        lines.push(`- Missing Capabilities: ${result.internalReasoning.missingCapabilities.join(', ')}`);
      }
      lines.push('');
    }

    // External reasoning summary
    if (result.externalReasoning) {
      lines.push('### Collaboration Analysis');
      lines.push(`- Can Collaborate: ${result.externalReasoning.canCollaborate ? 'Yes' : 'No'}`);
      if (result.externalReasoning.compatibleServices.length > 0) {
        lines.push(`- Compatible Services: ${result.externalReasoning.compatibleServices.map(s => s.serviceName).join(', ')}`);
      }
      lines.push('');
    }

    // Combined reasoning
    if (result.combinedReasoning) {
      lines.push('### Recommended Strategy');
      lines.push(`- Strategy: ${result.combinedReasoning.recommendedStrategy}`);
      lines.push(`- Reasoning: ${result.combinedReasoning.reasoning}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Convert DeviceStateInfo to OntologyResource format
   */
  toOntologyResource(deviceInfo: DeviceStateInfo): OntologyResource {
    return {
      id: deviceInfo.id,
      name: deviceInfo.name,
      type: deviceInfo.type,
      ontology: deviceInfo.resourceOntology,
    };
  }

  /**
   * Convert ServiceInfo to OntologyService format
   */
  toOntologyService(serviceInfo: ServiceInfo): OntologyService {
    return {
      id: serviceInfo.id,
      name: serviceInfo.name,
      ontology: serviceInfo.serviceOntology,
    };
  }

  /**
   * Extract all services from peer agents
   */
  private extractPeerServices(peers: PeerAgentInfo[]): OntologyService[] {
    const services: OntologyService[] = [];

    for (const peer of peers) {
      for (const service of peer.services) {
        services.push(this.toOntologyService(service));
      }
    }

    return services;
  }

  /**
   * Generate human-readable summary of reasoning results
   */
  private generateSummary(
    internal?: InternalReasoningResult,
    external?: PeerServiceReasoningResult,
    combined?: CombinedReasoningResult
  ): string {
    const parts: string[] = [];

    if (internal) {
      if (internal.canHandle) {
        parts.push(`Can handle internally with ${internal.matchingResources.length} resource(s)`);
      } else {
        parts.push(`Cannot handle internally${internal.missingCapabilities.length > 0 ? ` (missing: ${internal.missingCapabilities.join(', ')})` : ''}`);
      }
    }

    if (external) {
      if (external.canCollaborate) {
        parts.push(`${external.compatibleServices.length} compatible peer service(s) available`);
      } else {
        parts.push('No compatible peer services');
      }
    }

    if (combined) {
      parts.push(`Recommended: ${combined.recommendedStrategy}`);
    }

    return parts.join('. ');
  }
}
