/**
 * Context Sections Index
 *
 * Exports all context sections for the section-based context architecture.
 */

// Base types
export {
  type ContextSection,
  type SectionContext,
  BaseContextSection,
  sortSectionsByPriority,
  buildSections,
} from './ContextSection.js';

// Basic sections
export { AgentIdentitySection } from './AgentIdentitySection.js';
export { EnvironmentSection } from './EnvironmentSection.js';
export { ResourcesSection } from './ResourcesSection.js';
export { ServicesSection } from './ServicesSection.js';
export { PeersSection } from './PeersSection.js';
export { TemporalSection } from './TemporalSection.js';
export { TaskSection } from './TaskSection.js';

// Ontology sections
export { OntologyResourcesSection } from './OntologyResourcesSection.js';
export { OntologyServicesSection } from './OntologyServicesSection.js';
export { OntologyReasoningSection } from './OntologyReasoningSection.js';
