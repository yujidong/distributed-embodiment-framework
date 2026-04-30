/**
 * Discovery Module
 *
 * Provides automatic device/service discovery and resource negotiation.
 */

// Auto Discovery
export {
  AutoDiscovery,
  type DiscoveryConfig,
  type DiscoveryEvent,
  type DiscoveryEventType,
  type DiscoveredResource,
  type DiscoveryScanResult,
} from './AutoDiscovery.js';

// Resource Negotiator
export {
  ResourceNegotiator,
  type NegotiationConfig,
  type NegotiationProposal,
  type NegotiationTerms,
  type NegotiationResult,
  type NegotiationPriority,
  type NegotiationStatus,
} from './ResourceNegotiator.js';
