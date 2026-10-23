/**
 * Requirement Specification Registry
 *
 * Central registry for managing requirement specifications.
 * Provides lookup by task type, service type, and semantic category.
 *
 * Registry Features:
 * - Register and retrieve requirement specifications
 * - Lookup by task type, service type, or ontology class
 * - Version management for requirement specs
 * - Export/Import for persistence
 */

import type { RequirementSpec, RequirementCategory } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Requirement Specification Registry class
 * Manages requirement specifications with multiple lookup strategies
 */
const logger = createLogger('RequirementSpecRegistry');

export class RequirementSpecRegistry {
  private specs: Map<string, RequirementSpec>;
  private byCategory: Map<RequirementCategory, Set<string>>;
  private byServiceType: Map<string, Set<string>>;
  private byOntologyClass: Map<string, Set<string>>;

  constructor() {
    this.specs = new Map();
    this.byCategory = new Map();
    this.byServiceType = new Map();
    this.byOntologyClass = new Map();
    logger.info('Initialized');
  }

  /**
   * Register a requirement specification
   *
   * @param spec - Requirement specification to register
   */
  register(spec: RequirementSpec): void {
    logger.info(`Registering requirement spec: ${spec.id} (${spec.name})`);

    // Store the spec
    this.specs.set(spec.id, spec);

    // Index by category
    if (!this.byCategory.has(spec.category)) {
      this.byCategory.set(spec.category, new Set());
    }
    this.byCategory.get(spec.category)!.add(spec.id);

    // Index by service type (extract from semantic annotations)
    const serviceType = spec.semanticAnnotations.ontologyClass;
    if (!this.byServiceType.has(serviceType)) {
      this.byServiceType.set(serviceType, new Set());
    }
    this.byServiceType.get(serviceType)!.add(spec.id);

    // Index by ontology class
    if (!this.byOntologyClass.has(serviceType)) {
      this.byOntologyClass.set(serviceType, new Set());
    }
    this.byOntologyClass.get(serviceType)!.add(spec.id);

    logger.info(`Registered spec ${spec.id}`);
  }

  /**
   * Get a requirement specification by ID
   *
   * @param id - Requirement specification ID
   * @returns Requirement specification or undefined
   */
  get(id: string): RequirementSpec | undefined {
    return this.specs.get(id);
  }

  /**
   * Find requirement specifications by category
   *
   * @param category - Requirement category
   * @returns Array of matching requirement specifications
   */
  findByCategory(category: RequirementCategory): RequirementSpec[] {
    const ids = this.byCategory.get(category);
    if (!ids) return [];

    return Array.from(ids).map(id => this.specs.get(id)!).filter(Boolean);
  }

  /**
   * Find requirement specifications by service type
   *
   * @param serviceType - Service type or ontology class
   * @returns Array of matching requirement specifications
   */
  findByServiceType(serviceType: string): RequirementSpec[] {
    const ids = this.byServiceType.get(serviceType);
    if (!ids) return [];

    return Array.from(ids).map(id => this.specs.get(id)!).filter(Boolean);
  }

  /**
   * Find requirement specifications by ontology class
   *
   * @param ontologyClass - Ontology class (e.g., 'ssn:Sensing', 'saref:TemperatureSensor')
   * @returns Array of matching requirement specifications
   */
  findByOntologyClass(ontologyClass: string): RequirementSpec[] {
    const ids = this.byOntologyClass.get(ontologyClass);
    if (!ids) return [];

    return Array.from(ids).map(id => this.specs.get(id)!).filter(Boolean);
  }

  /**
   * Search requirement specifications by natural language query
   *
   * @param query - Natural language search query
   * @returns Array of matching requirement specifications (sorted by relevance)
   */
  search(query: string): RequirementSpec[] {
    const lowerQuery = query.toLowerCase();

    // Score each spec by relevance
    const scored = Array.from(this.specs.values()).map(spec => {
      let score = 0;

      // Check name match
      if (spec.name.toLowerCase().includes(lowerQuery)) {
        score += 10;
      }

      // Check description match
      if (spec.description.toLowerCase().includes(lowerQuery)) {
        score += 5;
      }

      // Check tags match
      for (const tag of spec.tags) {
        if (tag.toLowerCase().includes(lowerQuery)) {
          score += 3;
        }
      }

      // Check natural language description
      if (spec.semanticAnnotations.naturalLanguageDescription.toLowerCase().includes(lowerQuery)) {
        score += 7;
      }

      // Check alternative terms
      for (const term of spec.semanticAnnotations.alternativeTerms) {
        if (term.toLowerCase().includes(lowerQuery)) {
          score += 2;
        }
      }

      return { spec, score };
    });

    // Sort by score descending and filter out zero-score results
    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.spec);
  }

  /**
   * List all registered requirement specifications
   *
   * @returns Array of all requirement specifications
   */
  list(): RequirementSpec[] {
    return Array.from(this.specs.values());
  }

  /**
   * Get registry statistics
   *
   * @returns Statistics about registered specs
   */
  getStats(): RegistryStats {
    const categoryCounts: Record<RequirementCategory, number> = {
      sensing: 0,
      acting: 0,
      processing: 0,
      communication: 0,
      collaboration: 0,
      composite: 0
    };

    for (const [category, ids] of this.byCategory.entries()) {
      categoryCounts[category] = ids.size;
    }

    return {
      totalSpecs: this.specs.size,
      categoryCounts,
      serviceTypeCount: this.byServiceType.size,
      ontologyClassCount: this.byOntologyClass.size
    };
  }

  /**
   * Remove a requirement specification
   *
   * @param id - Requirement specification ID to remove
   * @returns True if removed, false if not found
   */
  remove(id: string): boolean {
    const spec = this.specs.get(id);
    if (!spec) {
      return false;
    }

    // Remove from main storage
    this.specs.delete(id);

    // Remove from indexes
    this.byCategory.get(spec.category)?.delete(id);
    this.byServiceType.get(spec.semanticAnnotations.ontologyClass)?.delete(id);
    this.byOntologyClass.get(spec.semanticAnnotations.ontologyClass)?.delete(id);

    logger.info(`Removed spec: ${id}`);
    return true;
  }

  /**
   * Clear all requirement specifications
   */
  clear(): void {
    this.specs.clear();
    this.byCategory.clear();
    this.byServiceType.clear();
    this.byOntologyClass.clear();
    logger.info('Cleared all specs');
  }

  /**
   * Export registry to JSON
   *
   * @returns JSON string of all specs
   */
  export(): string {
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      specs: Array.from(this.specs.values())
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import registry from JSON
   *
   * @param json - JSON string of exported registry
   * @returns Number of specs imported
   */
  import(json: string): number {
    const data = JSON.parse(json);

    if (!data.specs || !Array.isArray(data.specs)) {
      throw new Error('Invalid import data format');
    }

    let count = 0;
    for (const spec of data.specs) {
      this.register(spec as RequirementSpec);
      count++;
    }

    logger.info(`Imported ${count} specs`);
    return count;
  }
}

/**
 * Registry statistics
 */
export interface RegistryStats {
  totalSpecs: number;
  categoryCounts: Record<RequirementCategory, number>;
  serviceTypeCount: number;
  ontologyClassCount: number;
}
