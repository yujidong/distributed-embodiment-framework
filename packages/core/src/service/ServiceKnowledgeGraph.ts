/**
 * Service Knowledge Graph
 *
 * Manages semantic relationships between services for Active Collaboration
 * Enables knowledge graph-based service discovery and matchmaking
 *
 * Active Collaboration Theory - Key Innovation:
 * - Services form a semantic knowledge graph (not just a registry)
 * - Graph-based discovery enables efficient semantic matching
 * - Supports emergent service choreography through local graph queries
 */

import { SemanticService, ServiceRelationship, ServiceRelationshipType } from './SemanticService.js';
import { ServiceOntologyManager } from './ontologies/ServiceOntology.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Knowledge graph node representing a service
 */
const logger = createLogger('ServiceKnowledgeGraph');

export interface KnowledgeGraphNode {
  serviceId: string;
  service: SemanticService;
  neighbors: Map<string, KnowledgeGraphEdge>; // neighborServiceId -> edge
}

/**
 * Knowledge graph edge representing a relationship
 */
export interface KnowledgeGraphEdge {
  sourceServiceId: string;
  targetServiceId: string;
  relationship: ServiceRelationship;
  weight: number; // Used for pathfinding and ranking
}

/**
 * Graph query result
 */
export interface GraphQueryResult {
  services: SemanticService[];
  paths: Array<{
    service: SemanticService;
    path: string[];
    score: number;
  }>;
  metadata: {
    totalServices: number;
    averageScore: number;
    queryExecutionTime: number;
  };
}

/**
 * Service Knowledge Graph
 * Implements a semantic knowledge graph for service discovery and matchmaking
 */
export class ServiceKnowledgeGraph {
  private nodes: Map<string, KnowledgeGraphNode>;
  private edges: Map<string, KnowledgeGraphEdge>; // edgeId -> edge
  private graphStats: {
    totalNodes: number;
    totalEdges: number;
    lastUpdate: Date;
  };

  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.graphStats = {
      totalNodes: 0,
      totalEdges: 0,
      lastUpdate: new Date(),
    };

    logger.info('Initialized');
  }

  /**
   * Add a service to the knowledge graph
   * @param service - Semantic service to add
   */
  addService(service: SemanticService): void {
    logger.info(`Adding service: ${service.id}`);

    const node: KnowledgeGraphNode = {
      serviceId: service.id,
      service,
      neighbors: new Map(),
    };

    this.nodes.set(service.id, node);
    this.updateStats();

    // Auto-discover and add relationships based on semantic compatibility
    this.discoverRelationships(service);
  }

  /**
   * Remove a service from the knowledge graph
   * @param serviceId - Service ID to remove
   */
  removeService(serviceId: string): void {
    logger.info(`Removing service: ${serviceId}`);

    // Remove all edges connected to this node
    const node = this.nodes.get(serviceId);
    if (node) {
      for (const [neighborId] of node.neighbors) {
        const edgeId = this.getEdgeId(serviceId, neighborId);
        this.edges.delete(edgeId);
      }
    }

    // Remove the node
    this.nodes.delete(serviceId);
    this.updateStats();
  }

  /**
   * Add a semantic relationship between services
   * @param sourceServiceId - Source service ID
   * @param targetServiceId - Target service ID
   * @param relationshipType - Type of relationship
   * @param strength - Relationship strength (0-1)
   */
  addServiceRelationship(
    sourceServiceId: string,
    targetServiceId: string,
    relationshipType: ServiceRelationshipType,
    strength: number = 0.5
  ): void {
    const sourceNode = this.nodes.get(sourceServiceId);
    const targetNode = this.nodes.get(targetServiceId);

    if (!sourceNode || !targetNode) {
      logger.error(`Cannot add relationship: one or both services not found`
      );
      return;
    }

    // Create edge
    const edge: KnowledgeGraphEdge = {
      sourceServiceId,
      targetServiceId,
      relationship: {
        id: `rel_${sourceServiceId}_${targetServiceId}_${Date.now()}`,
        sourceServiceId,
        targetServiceId,
        relationshipType,
        strength,
        timestamp: new Date(),
      },
      weight: strength,
    };

    const edgeId = this.getEdgeId(sourceServiceId, targetServiceId);
    this.edges.set(edgeId, edge);

    // Add to source node's neighbors
    sourceNode.neighbors.set(targetServiceId, edge);

    // Add reverse relationship for undirected relationships
    if (
      relationshipType === ServiceRelationshipType.COMPOSES_WITH ||
      relationshipType === ServiceRelationshipType.PARALLEL ||
      relationshipType === ServiceRelationshipType.SEMANTICALLY_SIMILAR ||
      relationshipType === ServiceRelationshipType.SHARES_CONTEXT
    ) {
      const reverseEdge: KnowledgeGraphEdge = {
        sourceServiceId: targetServiceId,
        targetServiceId: sourceServiceId,
        relationship: {
          ...edge.relationship,
          id: `rel_${targetServiceId}_${sourceServiceId}_${Date.now()}`,
        },
        weight: strength,
      };

      const reverseEdgeId = this.getEdgeId(targetServiceId, sourceServiceId);
      this.edges.set(reverseEdgeId, reverseEdge);
      targetNode.neighbors.set(sourceServiceId, reverseEdge);
    }

    logger.info(`Added relationship: ${sourceServiceId} --[${relationshipType}]--> ${targetServiceId}`
    );
  }

  /**
   * Find composable services based on semantic requirements
   * Core function for Active Collaboration - enables semantic service discovery
   * @param requiredCapabilities - Required capabilities (semantic description)
   * @param options - Query options
   * @returns Query results with matching services and paths
   */
  findComposableServices(
    requiredCapabilities: string,
    options?: {
      maxResults?: number;
      minCompatibilityScore?: number;
      location?: string;
      ontologyClass?: string;
    }
  ): GraphQueryResult {
    const startTime = Date.now();

    logger.info(`Finding composable services for: ${requiredCapabilities}`
    );

    const matchingServices: SemanticService[] = [];
    const paths: Array<{
      service: SemanticService;
      path: string[];
      score: number;
    }> = [];

    // Parse required capabilities
    const keywords = this.extractKeywords(requiredCapabilities);

    // Search through all services
    for (const [serviceId, node] of this.nodes) {
      const service = node.service;

      // Skip unavailable services
      if (!service.isAvailable()) {
        continue;
      }

      // Calculate semantic match score
      const matchScore = this.calculateSemanticMatchScore(
        service,
        keywords,
        options
      );

      if (matchScore >= (options?.minCompatibilityScore || 0.5)) {
        matchingServices.push(service);
        paths.push({
          service,
          path: [serviceId], // Direct match
          score: matchScore,
        });
      }
    }

    // Sort by score (descending)
    paths.sort((a, b) => b.score - a.score);

    // Limit results
    const maxResults = options?.maxResults || 20;
    const limitedPaths = paths.slice(0, maxResults);

    const executionTime = Date.now() - startTime;

    const result: GraphQueryResult = {
      services: matchingServices.slice(0, maxResults),
      paths: limitedPaths,
      metadata: {
        totalServices: matchingServices.length,
        averageScore:
          matchingServices.length > 0
            ? paths.reduce((sum, p) => sum + p.score, 0) / paths.length
            : 0,
        queryExecutionTime: executionTime,
      },
    };

    logger.info(`Found ${result.services.length} matching services in ${executionTime}ms`
    );

    return result;
  }

  /**
   * Find services by semantic type
   * @param ontologyClass - Ontology class to filter by
   * @returns Services matching the ontology class
   */
  findBySemanticType(ontologyClass: string): SemanticService[] {
    logger.info(`Finding services by ontology class: ${ontologyClass}`
    );

    const matching: SemanticService[] = [];

    for (const node of this.nodes.values()) {
      if (node.service.ontologyClass === ontologyClass) {
        matching.push(node.service);
      }
    }

    logger.info(`Found ${matching.length} services`);

    return matching;
  }

  /**
   * Discover semantic relationships between services automatically
   * @param service - Service to discover relationships for
   */
  private discoverRelationships(service: SemanticService): void {
    logger.info(`Discovering relationships for service: ${service.id}`
    );

    for (const [otherServiceId, otherNode] of this.nodes) {
      // Skip self
      if (otherServiceId === service.id) {
        continue;
      }

      const otherService = otherNode.service;

      // Calculate semantic compatibility
      const compatibility = ServiceOntologyManager.calculateSemanticCompatibility(
        service,
        otherService
      );

      // Add relationship if compatible
      if (compatibility.compatible && compatibility.compatibilityScore > 0.6) {
        this.addServiceRelationship(
          service.id,
          otherServiceId,
          ServiceRelationshipType.SEMANTICALLY_SIMILAR,
          compatibility.compatibilityScore
        );
      }
    }
  }

  /**
   * Calculate semantic match score for a service
   * @param service - Service to evaluate
   * @param keywords - Keywords from requirements
   * @param options - Query options
   * @returns Match score (0-1)
   */
  private calculateSemanticMatchScore(
    service: SemanticService,
    keywords: string[],
    options?: {
      location?: string;
      ontologyClass?: string;
    }
  ): number {
    let score = 0;

    // Check ontology class match
    if (options?.ontologyClass) {
      if (service.ontologyClass === options.ontologyClass) {
        score += 0.5;
      }
    }

    // Check location match
    if (options?.location) {
      if (service.location === options.location) {
        score += 0.3;
      }
    }

    // Check keyword matches in service metadata
    const serviceText = [
      service.name,
      service.description,
      service.category,
      service.ontologyClass,
    ].join(' ').toLowerCase();

    for (const keyword of keywords) {
      if (serviceText.includes(keyword.toLowerCase())) {
        score += 0.1;
      }
    }

    // Normalize to 0-1 range
    return Math.min(1, score);
  }

  /**
   * Extract keywords from a semantic description
   * @param description - Semantic description
   * @returns Array of keywords
   */
  private extractKeywords(description: string): string[] {
    // Simple keyword extraction (can be enhanced with NLP)
    return description
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3) // Filter short words
      .filter((word) => !['the', 'and', 'for', 'with', 'from'].includes(word)); // Filter stop words
  }

  /**
   * Get edge ID from two service IDs
   * @param serviceId1 - First service ID
   * @param serviceId2 - Second service ID
   * @returns Edge ID
   */
  private getEdgeId(serviceId1: string, serviceId2: string): string {
    return `edge_${serviceId1}_${serviceId2}`;
  }

  /**
   * Update graph statistics
   */
  private updateStats(): void {
    this.graphStats = {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size / 2, // Divide by 2 for undirected edges
      lastUpdate: new Date(),
    };
  }

  /**
   * Get graph statistics
   * @returns Graph statistics
   */
  getStats(): {
    totalNodes: number;
    totalEdges: number;
    lastUpdate: Date;
    averageDegree: number;
  } {
    const totalDegree = Array.from(this.nodes.values()).reduce(
      (sum, node) => sum + node.neighbors.size,
      0
    );

    return {
      ...this.graphStats,
      averageDegree:
        this.graphStats.totalNodes > 0
          ? totalDegree / this.graphStats.totalNodes
          : 0,
    };
  }

  /**
   * Clear the knowledge graph
   */
  clear(): void {
    logger.info('Clearing graph');
    this.nodes.clear();
    this.edges.clear();
    this.updateStats();
  }

  /**
   * Export graph as adjacency list (for debugging/visualization)
   * @returns Adjacency list representation
   */
  exportAdjacencyList(): Record<string, string[]> {
    const adjacencyList: Record<string, string[]> = {};

    for (const [serviceId, node] of this.nodes) {
      adjacencyList[serviceId] = Array.from(node.neighbors.keys());
    }

    return adjacencyList;
  }
}
