/**
 * ContextSection Interface
 *
 * Base interface for all context sections in the section-based context architecture.
 * This abstraction enables extensible, composable context building for LLM consumption.
 *
 * Design Principles:
 * 1. Each section represents a logical unit of context information
 * 2. Sections can be selectively included based on task needs
 * 3. Sections are ordered by priority (higher = more important)
 * 4. Sections can be extended without modifying existing code
 *
 * As per ONTOLOGY-CONTEXT-INTEGRATION.md
 */

import type { AgentInfo, DeviceStateInfo, ServiceInfo, PeerAgentInfo, EnvironmentState } from '../AgentContextBuilder.js';
import type { CombinedReasoningResult } from '../../ontology/OntologyReasoningEngine.js';

/**
 * Context passed to section builders
 *
 * Contains all the information sections need to build their content.
 * This interface is extensible - new properties can be added without breaking existing sections.
 *
 * P5: Added userId and environmentId for proper isolation
 */
export interface SectionContext {
  /** Agent self information */
  agent: AgentInfo;

  /** Environment state */
  environment: EnvironmentState;

  /** Available resources (devices) */
  resources: DeviceStateInfo[];

  /** Available services (own and from peers) */
  services: {
    own: ServiceInfo[];
    fromPeers: ServiceInfo[];
  };

  /** Peer agents information */
  peers: PeerAgentInfo[];

  /** P5: User ID for permission filtering */
  userId?: string;

  /** P5: Environment ID for isolation */
  environmentId?: string;

  /** Temporal context */
  temporal: {
    currentTime: Date;
    timeScale?: number;
  };

  /** Optional current task */
  task?: string;

  /** Optional ontology reasoning results */
  ontologyReasoning?: CombinedReasoningResult;

  /** Extensible metadata for additional context */
  metadata?: Record<string, any>;
}

/**
 * Base interface for all context sections
 *
 * Each section is responsible for:
 * 1. Determining if it should be included (shouldInclude)
 * 2. Building its content for LLM consumption (build)
 * 3. Providing metadata for debugging (getMetadata)
 *
 * Example implementation:
 * ```typescript
 * class MySection implements ContextSection {
 *   readonly id = 'my-section';
 *   readonly priority = 50;
 *
 *   shouldInclude(context: SectionContext): boolean {
 *     return context.resources.length > 0;
 *   }
 *
 *   async build(context: SectionContext): Promise<string> {
 *     return `## My Section\n- Resources: ${context.resources.length}`;
 *   }
 *
 *   getMetadata(): Record<string, any> {
 *     return { version: '1.0' };
 *   }
 * }
 * ```
 */
export interface ContextSection {
  /**
   * Section identifier
   * Used for debugging and section identification
   */
  readonly id: string;

  /**
   * Section priority for ordering
   * Higher priority sections appear first in the formatted context
   * Recommended ranges:
   * - 100-90: Core identity (agent, environment)
   * - 90-80: Resources and devices
   * - 80-70: Services
   * - 70-60: Peers and collaboration
   * - 60-50: Task and reasoning
   * - 50-40: Temporal and auxiliary
   */
  readonly priority: number;

  /**
   * Determine if this section should be included in the context
   *
   * @param context - The full section context
   * @returns true if the section should be included
   */
  shouldInclude(context: SectionContext): boolean;

  /**
   * Build the section content for LLM consumption
   *
   * @param context - The full section context
   * @returns Formatted string content for this section
   */
  build(context: SectionContext): Promise<string>;

  /**
   * Get section metadata for debugging
   *
   * @returns Metadata object with section information
   */
  getMetadata(): Record<string, any>;
}

/**
 * Base class for context sections
 *
 * Provides common functionality and default implementations.
 * Extend this class to create custom sections.
 */
export abstract class BaseContextSection implements ContextSection {
  abstract readonly id: string;
  abstract readonly priority: number;

  /**
   * Default implementation - always include
   * Override this method to implement conditional inclusion logic
   */
  shouldInclude(_context: SectionContext): boolean {
    return true;
  }

  /**
   * Build method must be implemented by subclasses
   */
  abstract build(context: SectionContext): Promise<string>;

  /**
   * Default metadata implementation
   * Override to provide additional metadata
   */
  getMetadata(): Record<string, any> {
    return {
      id: this.id,
      priority: this.priority,
    };
  }
}

/**
 * Helper function to sort sections by priority (descending)
 *
 * @param sections - Array of sections to sort
 * @returns New array sorted by priority (highest first)
 */
export function sortSectionsByPriority(sections: ContextSection[]): ContextSection[] {
  return [...sections].sort((a, b) => b.priority - a.priority);
}

/**
 * Helper function to build all applicable sections
 *
 * @param sections - Array of sections to potentially include
 * @param context - Section context to pass to each section
 * @returns Combined content from all applicable sections
 */
export async function buildSections(
  sections: ContextSection[],
  context: SectionContext
): Promise<string> {
  const sortedSections = sortSectionsByPriority(sections);
  const includedSections: string[] = [];

  for (const section of sortedSections) {
    if (section.shouldInclude(context)) {
      const content = await section.build(context);
      if (content && content.trim()) {
        includedSections.push(content);
      }
    }
  }

  return includedSections.join('\n---\n\n');
}
