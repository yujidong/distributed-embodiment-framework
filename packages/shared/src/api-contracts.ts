/**
 * API Contracts
 *
 * This file defines the standardized data format contracts between frontend and backend.
 * All API endpoints should adhere to these contracts to ensure consistency and prevent integration issues.
 */

// ============================================================================
// Common Types
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  count: number;
  total?: number;
  page?: number;
  pageSize?: number;
}

// ============================================================================
// Authentication API
// ============================================================================

export namespace AuthAPI {
  export interface LoginRequest {
    email: string;
    password: string;
  }

  export interface LoginResponse {
    success: boolean;
    user: {
      id: string;
      email: string;
      name: string;
    };
    accessToken: string;
  }

  export interface RegisterRequest {
    email: string;
    password: string;
    name: string;
  }

  export interface RegisterResponse {
    success: boolean;
    user: {
      id: string;
      email: string;
      name: string;
    };
    accessToken?: string;
  }
}

// ============================================================================
// Scenario Templates API
// ============================================================================

export namespace ScenarioTemplatesAPI {
  export interface TemplateSummary {
    id: string;
    name: string;
    description: string;
    category: string;
    deviceCount: number;
    agentCount: number;
    tags?: string[];
    createdAt?: string;
  }

  export interface TemplateDevice {
    id: string;
    name: string;
    type: string;
    template: string;
    capabilities: string[];
    location?: {
      x?: number;
      y?: number;
      lat?: number;
      lng?: number;
      position?: string;
    };
    config?: Record<string, any>;
  }

  export interface TemplateAgent {
    id: string;
    name: string;
    description: string;
    type: string;
    template: string;
    capabilities: string[];
    config?: Record<string, any>;
  }

  export interface TemplateEnvironment {
    name?: string;
    description?: string;
    config?: Record<string, any>;
  }

  export interface TemplateDetail extends TemplateSummary {
    devices: TemplateDevice[];
    agents: TemplateAgent[];
    environment: TemplateEnvironment;
  }

  export interface ListTemplatesResponse {
    templates: TemplateSummary[];
    count: number;
  }

  export interface GetTemplateResponse extends TemplateDetail {}

  export interface LoadTemplateRequest {
    environmentName?: string;
  }

  export interface DeviceSummary {
    id: string;
    name: string;
    type: string;
    template: string;
    ownerId: string;
    environmentId: string;
    agentId?: string;
    capabilities: string[];
    status: string;
    createdAt: string;
  }

  export interface AgentSummary {
    id: string;
    name: string;
    description: string;
    type: string;
    template: string;
    ownerId: string;
    environmentId: string;
    capabilities: string[];
    status: string;
    createdAt: string;
  }

  export interface LoadTemplateResponse {
    message: string;
    scenario: {
      id: string;
      name: string;
    };
    environment: {
      id: string;
      name: string;
    };
    devices: {
      count: number;
      items: DeviceSummary[];
    };
    agents: {
      count: number;
      items: AgentSummary[];
    };
  }
}

// ============================================================================
// Device Templates API
// ============================================================================

export namespace DeviceTemplatesAPI {
  export interface TemplateSummary {
    id: string;
    name: string;
    description: string;
    type: string;
    category: string;
  }

  export interface TemplateDetail extends TemplateSummary {
    capabilities: string[];
    config: Record<string, any>;
    defaultState: Record<string, any>;
  }

  export interface ListTemplatesResponse {
    templates: TemplateSummary[];
    count: number;
  }

  export interface GetTemplateResponse extends TemplateDetail {}
}

// ============================================================================
// LLM Configurations API
// ============================================================================

export namespace LLMAPI {
  export interface ConfigSummary {
    id: string;
    provider: string;
    name: string;
    apiKeyMasked: string;
    apiEndpoint: string;
    isDefault: boolean;
    lastUsedAt: string;
    createdAt: string;
  }

  export interface CreateConfigRequest {
    provider: string;
    name: string;
    apiKey: string;
    apiEndpoint?: string;
    isDefault?: boolean;
  }

  export interface ListConfigsResponse {
    configs: ConfigSummary[];
    count: number;
  }

  export interface CreateConfigResponse {
    config: ConfigSummary;
  }

  export interface TestChatRequest {
    provider: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
  }

  export interface UpdateConfigRequest {
    provider?: string;
    name?: string;
    apiKey?: string;
    apiEndpoint?: string;
    isDefault?: boolean;
  }

  export interface TestChatResponse {
    success: boolean;
    response?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }
}

// ============================================================================
// Environments API
// ============================================================================

export namespace EnvironmentsAPI {
  export interface EnvironmentLocation {
    latitude?: number;
    longitude?: number;
    address?: string;
    zone?: string;
  }

  export interface EnvironmentSummary {
    id: string;
    name: string;
    description: string;
    ownerId: string;
    createdAt: string;
    location?: EnvironmentLocation;
    deviceCount?: number;
    serviceCount?: number;
    parameters?: Record<string, any>;  // Environment parameters
  }

  export interface CreateEnvironmentRequest {
    name: string;
    description: string;
    ownerId: string;
    location?: EnvironmentLocation;
    initialParameters?: Record<string, any>;  // Initial parameter values
  }

  export interface ListEnvironmentsResponse {
    environments: EnvironmentSummary[];
    count: number;
  }

  export interface GetEnvironmentResponse extends EnvironmentSummary {}

  export interface CreateEnvironmentResponse {
    environment: EnvironmentSummary;
  }

  // New endpoints for parameters
  export interface GetEnvironmentParametersResponse {
    parameters: Record<string, any>;
    count: number;
  }

  export interface UpdateEnvironmentParametersRequest {
    parameters: Record<string, any>;
  }

  export interface UpdateEnvironmentParametersResponse {
    parameters: Record<string, any>;
    updated: string[];  // List of parameter keys that were updated
  }

  // Device-to-Environment mapping configuration
  export interface DeviceEnvironmentMapping {
    deviceId: string;
    deviceOutput: string;  // e.g., 'temperature', 'state'
    environmentParameter: string;  // e.g., 'temperature', 'airQuality'
    transform?: 'direct' | 'inverse' | 'scaled';  // How to transform the value
    scaleFactor?: number;  // For 'scaled' transform
    offset?: number;  // For 'scaled' or 'direct' transform
    enabled: boolean;  // Whether this mapping is active
  }

  export interface GetEnvironmentMappingsResponse {
    mappings: DeviceEnvironmentMapping[];
    count: number;
  }

  export interface CreateEnvironmentMappingRequest {
    mappings: DeviceEnvironmentMapping[];
  }

  export interface CreateEnvironmentMappingResponse {
    mappings: DeviceEnvironmentMapping[];
    message: string;
  }

  export interface UpdateEnvironmentMappingRequest {
    mappingId: string;
    updates: Partial<DeviceEnvironmentMapping>;
  }

  export interface UpdateEnvironmentMappingResponse {
    mapping: DeviceEnvironmentMapping;
    message: string;
  }

  export interface UpdateEnvironmentRequest {
    name?: string;
    description?: string;
    location?: EnvironmentLocation;
  }

  export interface EnvironmentMember {
    userId: string;
    userName: string;
    email: string;
    role: string;
    joinedAt: string;
  }

  export interface EnvironmentParameter {
    key: string;
    value: any;
    type: string;
    unit?: string;
    description?: string;
    updatedAt?: string;
  }

  export interface DeleteEnvironmentMappingResponse {
    message: string;
  }
}

// ============================================================================
// Devices API
// ============================================================================

export namespace DevicesAPI {
  export interface DeviceSummary {
    id: string;
    name: string;
    type: string;
    template: string;
    ownerId: string;
    environmentId: string;
    agentId?: string;
    capabilities: string[];
    status: string;
    createdAt: string;
  }

  export interface DeviceDetail extends DeviceSummary {
    state: Record<string, any>;
    location?: string;
    metadata?: Record<string, any>;
  }

  export interface CreateDeviceRequest {
    name: string;
    type: string;
    template: string;
    ownerId: string;
    environmentId: string;
    capabilities: string[];
  }

  export interface ListDevicesResponse {
    devices: DeviceSummary[];
    count: number;
  }

  export interface GetDeviceResponse {
    device: DeviceDetail;
  }

  export interface CreateDeviceResponse {
    device: DeviceSummary;
  }

  export interface UpdateDeviceRequest {
    name?: string;
    type?: string;
    template?: string;
    capabilities?: string[];
    location?: string;
    metadata?: Record<string, any>;
  }
}

// ============================================================================
// Agents API
// ============================================================================

export namespace AgentsAPI {
  export interface AgentSummary {
    id: string;
    name: string;
    description: string;
    template: string;
    ownerId: string;
    environmentId: string;
    capabilities: string[];
    status: string;
    createdAt: string;
  }

  export interface CreateAgentRequest {
    name: string;
    description: string;
    template: string;
    ownerId: string;
    environmentId: string;
    capabilities: string[];
    deviceIds: string[];  // REQUIRED: At least one device must be assigned
  }

  export interface ListAgentsResponse {
    agents: AgentSummary[];
    count: number;
  }

  export interface GetAgentResponse {
    agent: AgentSummary;
  }

  export interface CreateAgentResponse {
    agent: AgentSummary;
  }

  export interface StartAgentResponse {
    message: string;
    agentId: string;
  }

  export interface StopAgentResponse {
    message: string;
    agentId: string;
  }

  export interface AssignDevicesRequest {
    devices: Array<{
      deviceId: string;
      deviceName: string;
      deviceType: string;
      permissions: string[];
    }>;
  }

  export interface AssignDevicesResponse {
    message: string;
    agentId: string;
    deviceCount: number;
  }

  export interface UpdateAgentRequest {
    name?: string;
    description?: string;
    template?: string;
    capabilities?: string[];
    deviceIds?: string[];
  }

  export interface AgentAutonomousConfig {
    enabled: boolean;
    triggers: AgentTrigger[];
    thresholds: AgentThreshold[];
    schedules: AgentSchedule[];
  }

  export interface AgentTrigger {
    id: string;
    name: string;
    type: string;
    condition: Record<string, any>;
    enabled: boolean;
  }

  export interface AgentThreshold {
    id: string;
    name: string;
    parameter: string;
    operator: string;
    value: number;
    action: string;
    enabled: boolean;
  }

  export interface AgentSchedule {
    id: string;
    name: string;
    cronExpression: string;
    action: string;
    enabled: boolean;
  }
}

// ============================================================================
// Active Collaborations API
// ============================================================================

export namespace ActiveCollaborationsAPI {
  export type CollaborationStatus =
    | 'initiated'
    | 'negotiating'
    | 'contracted'
    | 'executing'
    | 'validating'
    | 'completed'
    | 'failed';

  export type CollaborationPhase =
    | 'initiation'
    | 'forming'
    | 'negotiation'
    | 'contracting'
    | 'execution'
    | 'validation'
    | 'completion';

  // Trigger condition for AC activation
  export interface TriggerCondition {
    eventType?: string;  // Event type that triggers this AC
    resourceAffected?: string;  // Which resource/device is affected
    threshold?: {  // Threshold condition
      parameter: string;  // e.g., 'temperature', 'humidity'
      operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
      value: number | string;
    };
  }

  // Resource dependency that can be triggered
  export interface ResourceDependency {
    resourceType: string;  // e.g., 'temperature-control', 'emergency-response'
    triggerCondition: TriggerCondition;
    required: boolean;
    fallbackAction?: string;
  }

  // Workflow definition for AC
  export interface WorkflowDefinition {
    workflowId: string;
    name: string;
    description: string;
    dependencies: ResourceDependency[];
    negotiationStrategy: 'sequential' | 'parallel' | 'competitive';
  }

  export interface ContractTerms {
    resourceAllocation?: Record<string, any>;
    timeline?: {
      startTime: string;
      endTime?: string;
      milestones?: Array<{ name: string; deadline: string }>;
    };
    qos?: {
      maxResponseTime?: number;
      minAvailability?: number;
      maxErrorRate?: number;
    };
    compensation?: {
      terms?: string;
      penalties?: string[];
    };
  }

  export interface TaskDefinition {
    name: string;
    description: string;
    type: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    objectives?: string[];
    constraints?: Record<string, any>;
    expectedOutcome?: string;
    triggerConditions?: TriggerCondition[];  // When to trigger this AC
  }

  export interface CollaborationSummary {
    id: string;
    name: string;
    description: string;
    status: CollaborationStatus;
    phase: CollaborationPhase;
    requesterAgentId: string;
    requesterAgentName: string;
    participantCount: number;
    createdAt: string;
    updatedAt?: string;
    workflowId?: string;  // Associated workflow
  }

  export interface CollaborationDetail extends CollaborationSummary {
    task: TaskDefinition;
    participants: Array<{
      agentId: string;
      agentName: string;
      role: 'requester' | 'collaborator';
      status: string;
    }>;
    contractTerms?: ContractTerms;
    phases: Array<{
      phase: CollaborationPhase;
      startTime: string;
      endTime?: string;
      duration?: number;
      status: string;
    }>;
    services: Array<{
      serviceId: string;
      serviceName: string;
      providerAgentId: string;
      status: string;
    }>;
    metrics?: {
      totalDuration?: number;
      negotiationTime?: number;
      executionTime?: number;
      messageCount?: number;
      success?: boolean;
    };
    workflow?: WorkflowDefinition;  // Workflow details
  }

  export interface CreateCollaborationRequest {
    name: string;
    description: string;
    requesterAgentId: string;
    collaboratorAgentIds: string[];
    task: TaskDefinition;
    contractTerms?: ContractTerms;
    workflow?: WorkflowDefinition;  // Optional workflow definition
    triggerConditions?: TriggerCondition[];  // When to auto-trigger this AC
  }

  export interface CreateCollaborationResponse {
    collaboration: CollaborationDetail;
    message: string;
  }

  export interface ListCollaborationsResponse {
    collaborations: CollaborationSummary[];
    count: number;
  }

  export interface CollaborationProposal {
    id: string;
    collaborationId: string;
    agentId: string;
    terms: Record<string, any>;
    status: string;
    createdAt: string;
  }

  export interface GetCollaborationResponse {
    collaboration: CollaborationDetail;
  }

  export interface ExecuteCollaborationRequest {
    collaborationId: string;
    parameters?: Record<string, any>;
  }

  export interface ExecuteCollaborationResponse {
    message: string;
    executionId: string;
  }
}

// ============================================================================
// Applications API
// ============================================================================

export namespace ApplicationsAPI {
  export interface ApplicationSummary {
    id: string;
    name: string;
    description: string;
    scenario: string;
    ownerId: string;
    agentCount: number;
    status: string;
    createdAt: string;
  }

  export interface ApplicationDetail extends ApplicationSummary {
    agents: Array<{
      agentId: string;
      agentName: string;
    }>;
    configuration: Record<string, any>;
  }

  export interface CreateApplicationRequest {
    name: string;
    description: string;
    agentIds: string[];
    scenario: string;
    configuration?: Record<string, any>;
  }

  export interface CreateApplicationResponse {
    application: ApplicationDetail;
  }

  export interface ListApplicationsResponse {
    applications: ApplicationSummary[];
    count: number;
  }

  export interface GetApplicationResponse {
    application: ApplicationDetail;
  }

  export interface ExecuteApplicationRequest {
    applicationId: string;
    parameters?: Record<string, any>;
  }

  export interface ExecuteApplicationResponse {
    message: string;
    executionId: string;
    status: string;
  }
}

// ============================================================================
// Maps API
// ============================================================================

export namespace MapsAPI {
  export interface MapData {
    id: string;
    name: string;
    type: 'floorplan' | 'geospatial';
    ownerId: string;
    environmentId: string;
    width?: number;
    height?: number;
    zones?: Array<{
      id: string;
      name: string;
      type: string;
      boundaries: Array<{ x: number; y: number }>;
      color?: string;
    }>;
    devices?: Array<{
      deviceId: string;
      x: number;
      y: number;
    }>;
    imageUrl?: string;
    createdAt: string;
  }

  export interface ImportMapRequest {
    name: string;
    type: 'floorplan' | 'geospatial';
    environmentId: string;
    imageData?: string; // base64
    imageUrl?: string;
    zones?: Array<{
      name: string;
      type: string;
      boundaries: Array<{ x: number; y: number }>;
      color?: string;
    }>;
  }

  export interface ImportMapResponse {
    map: MapData;
    message: string;
  }

  export interface UpdateZoneRequest {
    zoneId: string;
    name?: string;
    type?: string;
    boundaries?: Array<{ x: number; y: number }>;
    color?: string;
  }

  export interface UpdateZoneResponse {
    zone: {
      id: string;
      name: string;
      type: string;
      boundaries: Array<{ x: number; y: number }>;
      color?: string;
    };
    message: string;
  }

  export interface PlaceDeviceRequest {
    deviceId: string;
    x: number;
    y: number;
  }

  export interface PlaceDeviceResponse {
    message: string;
    device: {
      deviceId: string;
      x: number;
      y: number;
    };
  }

  export interface FloorPlan {
    id: string;
    environmentId: string;
    name: string;
    imageUrl: string;
    width: number;
    height: number;
    scale: number;
    createdAt: string;
    updatedAt: string;
  }

  export interface SaveFloorPlanRequest {
    name: string;
    imageUrl: string;
    width: number;
    height: number;
    scale: number;
  }

  export interface HeatmapData {
    deviceId: string;
    position: { x: number; y: number };
    value: number;
    timestamp: string;
  }
}

// ============================================================================
// AC Configuration Types
// ============================================================================

export interface ACConfig {
  environmentId: string;
  autoAcceptProposals: boolean;
  maxCollaborationDuration: number;
  minAgentCount: number;
  maxAgentCount: number;
  proposalEvaluationCriteria: {
    capabilityMatch: number;
    proximityBonus: number;
    historicalSuccess: number;
  };
}

export interface ACTriggerStats {
  totalTriggers: number;
  successfulTriggers: number;
  failedTriggers: number;
  averageResponseTime: number;
}

// ============================================================================
// Common Error Types
// ============================================================================

export interface ErrorResponse {
  error: string;
  statusCode?: number;
  details?: Record<string, any>;
}

// ============================================================================
// API Endpoint Registry
// ============================================================================

/**
 * Registry of all API endpoints with their paths and methods.
 * This serves as documentation and helps prevent typos in frontend code.
 */
export const APIEndpoints = {
  // Authentication
  AUTH_LOGIN: { method: 'POST', path: '/api/auth/login' },
  AUTH_REGISTER: { method: 'POST', path: '/api/auth/register' },
  AUTH_LOGOUT: { method: 'POST', path: '/api/auth/logout' },

  // Scenario Templates
  SCENARIOS_LIST: { method: 'GET', path: '/api/templates/scenarios' },
  SCENARIOS_GET: { method: 'GET', path: '/api/templates/scenarios/:id' },
  SCENARIOS_LOAD: { method: 'POST', path: '/api/templates/scenarios/:id/load' },

  // Device Templates
  DEVICE_TEMPLATES_LIST: { method: 'GET', path: '/api/device-templates' },
  DEVICE_TEMPLATES_GET: { method: 'GET', path: '/api/device-templates/:id' },

  // LLM Configurations
  LLM_CONFIGS_LIST: { method: 'GET', path: '/api/llm-configs' },
  LLM_CONFIGS_CREATE: { method: 'POST', path: '/api/llm-configs' },
  LLM_CONFIGS_DELETE: { method: 'DELETE', path: '/api/llm-configs/:id' },
  LLM_CONFIGS_SET_DEFAULT: { method: 'PATCH', path: '/api/llm-configs/:id/default' },
  LLM_TEST_CHAT: { method: 'POST', path: '/api/agents/test-chat' },

  // Environments
  ENVIRONMENTS_LIST: { method: 'GET', path: '/api/environments' },
  ENVIRONMENTS_GET: { method: 'GET', path: '/api/environments/:id' },
  ENVIRONMENTS_CREATE: { method: 'POST', path: '/api/environments' },
  ENVIRONMENTS_DELETE: { method: 'DELETE', path: '/api/environments/:id' },
  ENVIRONMENTS_GET_PARAMETERS: { method: 'GET', path: '/api/environments/:id/parameters' },
  ENVIRONMENTS_UPDATE_PARAMETERS: { method: 'PUT', path: '/api/environments/:id/parameters' },
  ENVIRONMENTS_GET_MAPPINGS: { method: 'GET', path: '/api/environments/:id/mappings' },
  ENVIRONMENTS_CREATE_MAPPINGS: { method: 'POST', path: '/api/environments/:id/mappings' },
  ENVIRONMENTS_UPDATE_MAPPING: { method: 'PUT', path: '/api/environments/:id/mappings/:mappingId' },
  ENVIRONMENTS_DELETE_MAPPING: { method: 'DELETE', path: '/api/environments/:id/mappings/:mappingId' },

  // Devices
  DEVICES_LIST: { method: 'GET', path: '/api/devices' },
  DEVICES_GET: { method: 'GET', path: '/api/devices/:id' },
  DEVICES_CREATE: { method: 'POST', path: '/api/devices' },
  DEVICES_DELETE: { method: 'DELETE', path: '/api/devices/:id' },

  // Agents
  AGENTS_LIST: { method: 'GET', path: '/api/agents' },
  AGENTS_GET: { method: 'GET', path: '/api/agents/:id' },
  AGENTS_CREATE: { method: 'POST', path: '/api/agents' },
  AGENTS_DELETE: { method: 'DELETE', path: '/api/agents/:id' },
  AGENTS_START: { method: 'POST', path: '/api/agents/:id/start' },
  AGENTS_STOP: { method: 'POST', path: '/api/agents/:id/stop' },
  AGENTS_ASSIGN_DEVICES: { method: 'PUT', path: '/api/agents/:id/resources' },

  // Active Collaborations
  COLLABORATIONS_LIST: { method: 'GET', path: '/api/collaborations' },
  COLLABORATIONS_GET: { method: 'GET', path: '/api/collaborations/:id' },
  COLLABORATIONS_CREATE: { method: 'POST', path: '/api/collaborations' },
  COLLABORATIONS_EXECUTE: { method: 'POST', path: '/api/collaborations/:id/execute' },
  COLLABORATIONS_DELETE: { method: 'DELETE', path: '/api/collaborations/:id' },

  // Applications
  APPLICATIONS_LIST: { method: 'GET', path: '/api/applications' },
  APPLICATIONS_GET: { method: 'GET', path: '/api/applications/:id' },
  APPLICATIONS_CREATE: { method: 'POST', path: '/api/applications' },
  APPLICATIONS_EXECUTE: { method: 'POST', path: '/api/applications/:id/execute' },
  APPLICATIONS_DELETE: { method: 'DELETE', path: '/api/applications/:id' },

  // Maps
  MAPS_IMPORT: { method: 'POST', path: '/api/maps/import' },
  MAPS_GET: { method: 'GET', path: '/api/maps/:id' },
  MAPS_UPDATE_ZONE: { method: 'PUT', path: '/api/maps/:mapId/zones/:zoneId' },
  MAPS_PLACE_DEVICE: { method: 'POST', path: '/api/maps/:mapId/devices' },
} as const;
