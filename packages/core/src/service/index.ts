/**
 * Service Layer
 *
 * Top layer of Cognitive Agent architecture
 * Exposes agent capabilities externally through services
 * Provides structured service discovery, request, and contract management
 */

// Core service interfaces and base classes
export * from './Service.js';
export * from './ServiceRegistry.js';
export * from './ServicePublisher.js';
export * from './ServiceRequest.js';
export * from './ServiceValidator.js';
export * from './ServiceBroker.js';
export * from './CommandBridge.js';

// Semantic services (NEW for Active Collaboration Theory)
export * from './SemanticService.js';
export * from './ServiceKnowledgeGraph.js';
export * from './ontologies/ServiceOntology.js';

// Microservice architecture (NEW - Service as microservice abstraction)
export * from './ServiceCapability.js';
export * from './MicroserviceService.js';
export * from './ServiceContainer.js';
export * from './MicroserviceBuilder.js';

// Auto-generation (NEW for Declarative Configuration)
export * from './ServiceAutoGenerator.js';
