/**
 * Collaboration Workflow Module
 *
 * Defines structured workflows for agent collaboration.
 * Replaces LLM-based decision making with rule-based workflows.
 */

import type { SystemEvent } from '@active-collaboration/shared';
import type { ServiceBroker, CollaborationServiceQuery, ServiceOffer } from '../service/index.js';
import type { ProviderInfo } from '../service/Service.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Resource dependency
 * Defines what resources/services an agent needs from others
 */
const logger = createLogger('CollaborationWorkflow');

export interface ResourceDependency {
  resourceType: string; // e.g., 'energy-monitoring', 'lighting-control'
  triggerCondition: TriggerCondition;
  required: boolean; // Whether this is required or optional
  fallbackAction?: string; // What to do if dependency not available
}

/**
 * Trigger condition
 * When a dependency should be activated
 */
export interface TriggerCondition {
  eventType?: string; // Event type that triggers this
  resourceAffected?: string; // Which resource is affected
  threshold?: { parameter: string; operator: string; value: number | string };
}

/**
 * Collaboration workflow definition
 * Scenario-specific collaboration patterns
 */
export interface CollaborationWorkflow {
  workflowId: string;
  name: string;
  description: string;
  dependencies: ResourceDependency[];
  negotiationStrategy: 'sequential' | 'parallel' | 'broadcast';
}

/**
 * Workflow execution context
 */
export interface CollaborationWorkflowContext {
  event: SystemEvent;
  affectedResources: string[]; // Resource IDs affected by the event
  availableServices: ServiceOffer[];
  establishedContracts: Map<string, Record<string, unknown>>; // Contract ID -> Contract
}

/**
 * Workflow execution result
 */
export interface CollaborationWorkflowResult {
  success: boolean;
  actionsTaken: string[];
  servicesRequested: string[];
  contractsEstablished: string[];
  errors: string[];
  targetAgents?: string[];
  resourceTypes?: string[];
}

/**
 * Collaboration Workflow Engine
 * Executes structured workflows for agent collaboration
 */
export class CollaborationWorkflowEngine {
  private serviceBroker: ServiceBroker;
  private workflows: Map<string, CollaborationWorkflow>;

  constructor(serviceBroker: ServiceBroker) {
    this.serviceBroker = serviceBroker;
    this.workflows = new Map();

    logger.info('[CollaborationWorkflowEngine] Initialized');
  }

  /**
   * Register a workflow
   */
  registerWorkflow(workflow: CollaborationWorkflow): void {
    this.workflows.set(workflow.workflowId, workflow);
    logger.info(`[CollaborationWorkflowEngine] Registered workflow: ${workflow.name}`);
  }

  /**
   * Evaluate event and execute appropriate workflow
   * Returns workflow execution result
   *
   * Collaboration Strategy (Self-First):
   * 1. Check if agent has own service that can satisfy the need
   * 2. If not, try to create a service from own resources
   * 3. If not possible, discover and request external services
   */
  async executeWorkflow(
    workflowId: string,
    event: SystemEvent,
    context: Partial<CollaborationWorkflowContext> = {}
  ): Promise<CollaborationWorkflowResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return {
        success: false,
        actionsTaken: [],
        servicesRequested: [],
        contractsEstablished: [],
        errors: [`Workflow not found: ${workflowId}`],
      };
    }

    logger.info(`[CollaborationWorkflowEngine] Executing workflow: ${workflow.name}`);

    const result: CollaborationWorkflowResult = {
      success: false,
      actionsTaken: [],
      servicesRequested: [],
      contractsEstablished: [],
      errors: [],
    };

    // Track target agents and resource types for E2E testing
    const targetAgents: string[] = [];
    const resourceTypes: string[] = [];

    try {
      // Determine which dependencies are triggered by this event
      const triggeredDependencies = this.evaluateTriggers(workflow.dependencies, event, context);

      logger.info(`[CollaborationWorkflowEngine] Triggered ${triggeredDependencies.length} dependencies`);

      if (triggeredDependencies.length === 0) {
        result.success = true;
        result.actionsTaken.push('No dependencies triggered');
        return result;
      }

      // For each triggered dependency, try to satisfy it
      for (const dependency of triggeredDependencies) {
        try {
          const requestId = event.source; // Agent ID

          // STEP 1: Check if agent has own services that can satisfy this need
          logger.info(`[CollaborationWorkflowEngine] STEP 1: Checking own services for ${dependency.resourceType}`);
          const ownServiceResult = await this.tryOwnService(dependency, requestId, context);

          if (ownServiceResult.satisfied) {
            result.actionsTaken.push(`Self-serviced: ${dependency.resourceType}`);
            result.servicesRequested.push(ownServiceResult.serviceId || 'self-service');
            result.success = true;
            targetAgents.push(requestId); // Self-collaboration
            resourceTypes.push(dependency.resourceType);
            logger.info(`[CollaborationWorkflowEngine] ✓ Satisfied ${dependency.resourceType} with own service`);
            continue;
          }

          // STEP 2: Try to create a service from own resources
          logger.info(`[CollaborationWorkflowEngine] STEP 2: Trying to create service from resources for ${dependency.resourceType}`);
          const createServiceResult = await this.tryCreateServiceFromResources(dependency, requestId, context);

          if (createServiceResult.satisfied) {
            result.actionsTaken.push(`Created service: ${dependency.resourceType}`);
            result.servicesRequested.push(createServiceResult.serviceId || 'created-service');
            result.success = true;
            targetAgents.push(requestId); // Self-collaboration
            resourceTypes.push(dependency.resourceType);
            logger.info(`[CollaborationWorkflowEngine] ✓ Created ${dependency.resourceType} from resources`);
            continue;
          }

          // STEP 3: Discover external services
          logger.info(`[CollaborationWorkflowEngine] STEP 3: Discovering external services for ${dependency.resourceType}`);
          const query: CollaborationServiceQuery = {
            serviceType: dependency.resourceType,
            requiredCapabilities: [dependency.resourceType],
            constraints: {
              excludedProviders: [], // DON'T exclude self - we already tried self-service
            },
          };

          const discovery = await this.serviceBroker.discoverServices(query);

          logger.info(`[CollaborationWorkflowEngine] Discovery result for ${dependency.resourceType}:`, {
            offersCount: discovery.offers.length,
            offers: discovery.offers.map(o => ({ serviceId: o.serviceId, providerId: o.providerId, serviceName: o.serviceName })),
          });

          if (discovery.offers.length === 0) {
            if (dependency.required) {
              result.errors.push(`Required service not available: ${dependency.resourceType}`);
              if (dependency.fallbackAction) {
                result.actionsTaken.push(`Fallback: ${dependency.fallbackAction}`);
              }
            } else {
              result.actionsTaken.push(`Optional service not available: ${dependency.resourceType}`);
            }
            continue;
          }

          // Select best offer (prefer self if available, then others)
          const selectedOffer = this.serviceBroker.selectBestOffer(discovery);

          if (!selectedOffer) {
            result.errors.push(`No suitable offer for: ${dependency.resourceType}`);
            continue;
          }

          // Request the service
          const requestResult = await this.serviceBroker.requestService(
            selectedOffer,
            query,
            requestId
          );

          if (requestResult.success) {
            result.servicesRequested.push(selectedOffer.serviceId);
            if (requestResult.contract) {
              result.contractsEstablished.push(requestResult.contract.contractId);
              result.actionsTaken.push(`Contract established: ${requestResult.contract.contractId}`);
            }
            // Track target agent and resource type for E2E testing
            targetAgents.push(selectedOffer.providerId);
            resourceTypes.push(dependency.resourceType);
          } else {
            result.errors.push(`Service request failed: ${requestResult.error}`);
          }
        } catch (error) {
          result.errors.push(`Dependency processing error: ${error}`);
        }
      }

      // Consider workflow successful if at least one service was requested or no required dependencies failed
      const requiredDependencies = triggeredDependencies.filter(d => d.required);
      const requiredFailed = requiredDependencies.filter(d =>
        result.errors.some(e => e.includes(d.resourceType))
      );

      result.success = requiredFailed.length === 0 && result.actionsTaken.length > 0;

    } catch (error) {
      result.errors.push(`Workflow execution error: ${error}`);
    }

    // Add target agents and resource types for E2E testing
    result.targetAgents = targetAgents;
    result.resourceTypes = resourceTypes;

    return result;
  }

  /**
   * Try to satisfy dependency with agent's own services
   */
  private async tryOwnService(
    dependency: ResourceDependency,
    agentId: string,
    _context: Partial<CollaborationWorkflowContext>
  ): Promise<{ satisfied: boolean; serviceId?: string }> {
    try {
      // Query services including own services
      const query: CollaborationServiceQuery = {
        serviceType: dependency.resourceType,
        requiredCapabilities: [dependency.resourceType],
        constraints: {
          // Only look at own services
          allowedProviders: [agentId],
        },
      };

      const discovery = await this.serviceBroker.discoverServices(query);

      if (discovery.offers.length > 0) {
        const ownService = discovery.offers[0];
        logger.info(`[CollaborationWorkflowEngine] Found own service: ${ownService.serviceId}`);
        return { satisfied: true, serviceId: ownService.serviceId };
      }

      return { satisfied: false };
    } catch (error) {
      logger.error(`[CollaborationWorkflowEngine] Error checking own services:`, error);
      return { satisfied: false };
    }
  }

  /**
   * Try to create a service from agent's own resources
   */
  private async tryCreateServiceFromResources(
    dependency: ResourceDependency,
    agentId: string,
    _context: Partial<CollaborationWorkflowContext>
  ): Promise<{ satisfied: boolean; serviceId?: string }> {
    try {
      // Get all services from this agent
      const allServices = this.serviceBroker['environment'].discoverServices({});

      // ARCHITECTURE FIX (Sprint 11): Use service metadata instead of accessing ResourceManager
      // Find services owned by this agent using getProviderInfo().providerAgentId
      // This follows the same pattern as ServiceBroker.ts (Sprint 10)
      const agentServices = allServices.filter(s => {
        // Use service.getProviderInfo() to get the provider agent ID
        // This is the correct approach per architecture: use service metadata,
        // NOT direct access to agent's private ResourceManager
        const sRecord = s as unknown as Record<string, unknown>;
        const providerInfo: ProviderInfo | undefined = typeof sRecord.getProviderInfo === 'function'
          ? (sRecord.getProviderInfo as () => ProviderInfo)()
          : undefined;
        const providerAgentId = providerInfo?.providerAgentId;

        // Check if this service is owned by the requesting agent
        return providerAgentId === agentId;
      });

      // Check if any of this agent's resources can be composed to provide the needed service
      // For example: if need "hvac-control" but have "hvac-controller" device
      const canComposeService = agentServices.some(s => {
        const resourceType = this.mapServiceToResourceType(s as unknown as Record<string, unknown>);
        // Check if this resource is semantically related to what we need
        return this.isResourceCompatible(resourceType, dependency.resourceType);
      });

      if (canComposeService) {
        // Create a dynamic service ID
        const dynamicServiceId = `dynamic-${agentId}-${dependency.resourceType}-${Date.now()}`;
        logger.info(`[CollaborationWorkflowEngine] Can compose service ${dependency.resourceType} from resources`);
        return { satisfied: true, serviceId: dynamicServiceId };
      }

      return { satisfied: false };
    } catch (error) {
      logger.error(`[CollaborationWorkflowEngine] Error creating service from resources:`, error);
      return { satisfied: false };
    }
  }

  /**
   * Map service to resource type
   */
  private mapServiceToResourceType(service: Record<string, unknown>): string {
    // Use service category as resource type
    const category = typeof service.category === 'string' ? service.category : '';
    const type = typeof service.type === 'string' ? service.type : '';
    return category || type || 'unknown';
  }

  /**
   * Check if resource types are compatible for service composition
   */
  private isResourceCompatible(availableType: string, requestedType: string): boolean {
    // Direct match
    if (availableType === requestedType) {
      return true;
    }

    // Semantic compatibility mappings
    const compatibilityMap: Record<string, string[]> = {
      'hvac-control': ['hvac-controller', 'thermostat', 'temperature-control'],
      'temperature-sensor': ['temp-sensor', 'temperature-sensor', 'thermometer'],
      'lighting-control': ['light-controller', 'smart-light', 'light-switch'],
      'door-status': ['door-sensor', 'door-lock', 'door-controller'],
      'camera-feed': ['camera', 'ip-camera', 'webcam'],
      'motion-sensor': ['motion-detector', 'pir-sensor'],
      'energy-monitoring': ['energy-meter', 'power-meter', 'smart-plug'],
      'vital-signs-data': ['vital-signs-monitor', 'heart-rate-monitor', 'bp-monitor'],
      'patient-allergy-data': ['allergy-database', 'patient-records'],
      'equipment-availability': ['equipment-tracker', 'device-inventory'],
      'production-line-data': ['production-line', 'manufacturing-equipment'],
      'quality-sensor-data': ['quality-sensor', 'inspection-sensor'],
      'technician-availability': ['technician-tracker', 'staff-scheduler'],
    };

    // Check if availableType is in the compatibility list for requestedType
    if (compatibilityMap[requestedType]) {
      return compatibilityMap[requestedType].some(t => availableType.includes(t) || t.includes(availableType));
    }

    // Check reverse mapping
    for (const [key, values] of Object.entries(compatibilityMap)) {
      if (values.includes(availableType) && key === requestedType) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluate which dependencies are triggered by an event
   */
  private evaluateTriggers(
    dependencies: ResourceDependency[],
    event: SystemEvent,
    context: Partial<CollaborationWorkflowContext>
  ): ResourceDependency[] {
    const triggered: ResourceDependency[] = [];

    for (const dependency of dependencies) {
      const condition = dependency.triggerCondition;

      // Check if event type matches
      if (condition.eventType && event.type !== condition.eventType) {
        continue;
      }

      // Check if specific resource is affected
      if (condition.resourceAffected) {
        const affectedResources = context.affectedResources || [];
        if (!affectedResources.includes(condition.resourceAffected)) {
          continue;
        }
      }

      // Check threshold condition
      if (condition.threshold) {
        const { parameter, operator, value } = condition.threshold;
        const payload = event.payload as Record<string, unknown>;
        const eventValue = payload[parameter] as number;

        let thresholdMet = false;
        const numericValue = value as number;
        switch (operator) {
          case '>':
            thresholdMet = eventValue > numericValue;
            break;
          case '<':
            thresholdMet = eventValue < numericValue;
            break;
          case '>=':
            thresholdMet = eventValue >= numericValue;
            break;
          case '<=':
            thresholdMet = eventValue <= numericValue;
            break;
          case '==':
            thresholdMet = eventValue === value;
            break;
          case '!=':
            thresholdMet = eventValue !== value;
            break;
        }

        if (!thresholdMet) {
          continue;
        }
      }

      // All conditions met
      triggered.push(dependency);
    }

    return triggered;
  }

  /**
   * Create a workflow from a simple definition
   */
  createWorkflow(
    workflowId: string,
    name: string,
    dependencies: Array<{
      resourceType: string;
      eventType?: string;
      threshold?: { parameter: string; operator: string; value: number | string };
      required?: boolean;
      fallbackAction?: string;
    }>
  ): CollaborationWorkflow {
    const workflow: CollaborationWorkflow = {
      workflowId,
      name,
      description: `Workflow for ${name}`,
      dependencies: dependencies.map(dep => ({
        resourceType: dep.resourceType,
        triggerCondition: {
          eventType: dep.eventType,
          threshold: dep.threshold,
        },
        required: dep.required !== false,
        fallbackAction: dep.fallbackAction,
      })),
      negotiationStrategy: 'sequential',
    };

    this.registerWorkflow(workflow);
    return workflow;
  }
}
