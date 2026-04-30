/**
 * TaskPlanner - Planner Module for AC Workflow Optimization
 *
 * Based on research findings:
 * - Planner-Executor dual-module architecture
 * - Task complexity adaptive routing
 * - Structured prompts with clear role definitions
 * - Case-based enhancement (RAG-like planning)
 */

import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
/**
 * Task complexity levels
 * Determines execution routing strategy
 */
const logger = createLogger('TaskPlanner');

export enum TaskComplexity {
  SIMPLE = 'simple',       // Direct device operation, no LLM planning needed
  MEDIUM = 'medium',       // Single agent, uses resources
  COMPLEX = 'complex',     // Requires decomposition and/or collaboration
  UNCERTAIN = 'uncertain'  // LLM couldn't determine, default to careful handling
}

/**
 * Structured task plan output
 */
export interface TaskPlan {
  // Task understanding
  taskId: string;
  summary: string;
  intent: string;  // What the user wants to achieve

  // Classification
  actionType: 'observe' | 'control' | 'analyze' | 'coordinate';
  complexity: TaskComplexity;
  confidence: number;  // 0-1

  // Entity and scope
  entity: string | null;       // What is being acted upon (temperature, humidity, etc.)
  scope: 'device' | 'room' | 'zone' | 'environment';

  // Requirements
  requiredCapabilities: string[];
  requiredDataTypes: string[];

  // Capability Gap Analysis (for collaboration)
  missingCapabilities?: string[];  // Capabilities this agent lacks
  availableFromPeers?: Array<{
    agentId: string;
    agentName: string;
    capabilities: string[];
  }>;

  // Execution strategy
  executionStrategy: 'direct' | 'resource-based' | 'collaborative' | 'decomposed';
  subtasks?: SubTask[];

  // Context
  availableResources: string[];
  constraints: string[];

  // Metadata
  planningTime: number;
  reasoningTrace?: string;
}

/**
 * Subtask for decomposed tasks
 */
export interface SubTask {
  id: string;
  description: string;
  actionType: 'observe' | 'control' | 'analyze';
  requiredCapabilities: string[];
  dependencies: string[];  // IDs of subtasks this depends on
  priority: number;
}

/**
 * Planning context provided to the planner
 */
export interface PlanningContext {
  agentId: string;
  agentName: string;
  agentCapabilities: string[];

  // Available resources
  resources: Array<{
    id: string;
    name: string;
    type: string;
    capabilities: string[];
    location?: string;
  }>;

  // Agent's published services
  services?: Array<{
    id: string;
    name: string;
    category: string;
    capabilities: string[];
  }>;

  // Environment context
  environmentType?: string;
  environmentId?: string;

  // Peer agents available for collaboration
  peerAgents?: Array<{
    id: string;
    name: string;
    capabilities: string[];
  }>;

  // AC framework context
  acContext?: {
    availableAgents?: Array<{
      id: string;
      name: string;
      capabilities: string[];
    }>;
    collaborationEnabled?: boolean;
  };

  // Previous similar tasks (for case-based reasoning)
  similarCases?: Array<{
    task: string;
    solution: string;
    success: boolean;
  }>;

  // Full agent context for enhanced LLM decision making
  // Includes: self info, environment state, resources with states, services, peer agents
  fullContext?: any;
}

/**
 * TaskPlanner - Main planner class
 *
 * Implements the Planner part of Planner-Executor architecture:
 * 1. Task understanding with complexity assessment
 * 2. Decomposition planning for complex tasks
 * 3. Resource-aware planning
 * 4. Adaptive routing based on complexity
 */
export class TaskPlanner {
  private llmClient: LLMClient;

  // Complexity thresholds for routing decisions
  private static readonly COMPLEXITY_KEYWORDS = {
    simple: ['check', 'read', 'get', 'show', 'display', 'what is'],
    medium: ['adjust', 'change', 'turn', 'start', 'stop'],  // 'set' moved to simple for single-device ops
    complex: ['maintain', 'coordinate', 'optimize', 'balance', 'schedule',
              'monitor and control', 'ensure', 'manage', 'orchestrate']
  };

  // Action type detection keywords
  private static readonly ACTION_TYPE_KEYWORDS = {
    observe: ['check', 'read', 'get', 'show', 'display', 'what', 'monitor', 'observe', 'measure', 'detect'],
    control: ['set', 'adjust', 'change', 'turn', 'start', 'stop', 'control', 'configure', 'update', 'modify'],
    analyze: ['analyze', 'compare', 'calculate', 'compute', 'evaluate', 'assess']
  };

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Main planning method
   * Analyzes task and produces execution plan
   * Uses single LLM call for all planning decisions (more efficient)
   */
  async plan(request: string, context: PlanningContext): Promise<TaskPlan> {
    const startTime = Date.now();
    logger.info(`Planning for: "${request}"`);

    // Use LLM for all planning - single call is efficient since generation speed depends on output tokens
    logger.info(`Using LLM for comprehensive task planning`);
    const llmPlan = await this.planWithLLM(request, context, TaskComplexity.SIMPLE);

    return {
      ...llmPlan,
      planningTime: Date.now() - startTime
    };
  }

  /**
   * Detect action type using LLM
   * More reliable than keyword matching for action type classification
   */
  private async detectActionTypeWithLLM(request: string): Promise<'observe' | 'control' | 'analyze' | 'coordinate'> {
    try {
      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: `You are an IoT Task Classifier. Your ONLY job is to classify task requests into exactly one of these categories:
- "observe": Reading/checking data WITHOUT changing device state
- "control": Changing device state or settings
- "analyze": Processing data, calculations, comparisons
- "coordinate": Multi-device or multi-agent orchestration

IMPORTANT: You MUST return ONLY the classification word. No explanations, no other text. Just one word.`
          },
          {
            role: 'user',
            content: `Classify this IoT task request. Return ONLY one word: "observe", "control", "analyze", or "coordinate".

Rules:
- "observe": Reading/checking data WITHOUT changing device state (check, read, get, show, monitor, what is)
- "control": Changing device state or settings (set, adjust, change, turn, start, stop, configure)
- "analyze": Processing data, calculations, comparisons (analyze, compare, calculate)
- "coordinate": Multi-device or multi-agent orchestration (maintain, optimize, balance)

Request: "${request}"

Return ONLY the classification word, nothing else.`
          }
        ],
        temperature: 0.1,
        maxTokens: 10
      });

      const result = response.content.toLowerCase().trim();
      logger.info(`LLM classified action type as: ${result}`);

      // Validate result
      const validTypes = ['observe', 'control', 'analyze', 'coordinate'];
      if (validTypes.includes(result)) {
        return result as 'observe' | 'control' | 'analyze' | 'coordinate';
      }

      // If LLM returns invalid response, throw error
      throw new Error(`Invalid action type from LLM: "${result}". Valid types: ${validTypes.join(', ')}`);
    } catch (error) {
      logger.error(`LLM action type detection failed:`, error);
      throw new Error(`TaskPlanner action type detection failed: ${error}. Request: "${request}"`);
    }
  }

  /**
   * Create plan for simple tasks using LLM for action type detection
   */
  private async createSimplePlanWithLLM(
    request: string,
    context: PlanningContext,
    startTime: number
  ): Promise<TaskPlan> {
    const entities = this.extractEntities(request);
    const entity = entities.length > 0 ? entities[0] : null;

    // Use LLM for action type detection (more reliable than keywords)
    const actionType = await this.detectActionTypeWithLLM(request);

    logger.info(`Detected action type: ${actionType} for entity: ${entity}`);

    // Map entity to capability
    const capabilityMap: Record<string, string[]> = {
      'temperature': ['temperature-sensor', 'temperature-monitoring'],
      'humidity': ['humidity-sensor', 'humidity-monitoring'],
      'hvac': ['hvac-control', 'climate-control'],
      'thermostat': ['thermostat-control', 'temperature-control'],
      'light': ['light-control', 'lighting'],
      'door': ['door-control', 'access-control'],
      'window': ['window-control', 'blind-control'],
      'camera': ['camera-feed', 'video-monitoring'],
      'motion': ['motion-sensor', 'presence-detection'],
      'energy': ['energy-monitoring', 'power-meter']
    };

    const requiredCapabilities = entity && capabilityMap[entity]
      ? capabilityMap[entity]
      : [actionType === 'observe' ? 'monitoring' : 'control'];

    return {
      taskId: `task-${Date.now()}`,
      summary: request,
      intent: request,
      actionType,
      complexity: TaskComplexity.SIMPLE,
      confidence: 0.9,
      entity,
      scope: 'device',
      requiredCapabilities,
      requiredDataTypes: ['numeric'],
      executionStrategy: 'direct',
      availableResources: context.resources.map(r => r.id),
      constraints: [],
      planningTime: Date.now() - startTime,
      reasoningTrace: 'LLM-based action type classification for simple task'
    };
  }

  /**
   * Quick complexity assessment using pattern matching
   * DEPRECATED: No longer used, kept for reference
   */
  private assessComplexityQuickly(request: string): TaskComplexity {
    const lowerRequest = request.toLowerCase();

    // Check for complex patterns first
    const complexMatches = TaskPlanner.COMPLEXITY_KEYWORDS.complex
      .filter(kw => lowerRequest.includes(kw)).length;

    if (complexMatches > 0) {
      return TaskComplexity.COMPLEX;
    }

    // Check for medium patterns
    const mediumMatches = TaskPlanner.COMPLEXITY_KEYWORDS.medium
      .filter(kw => lowerRequest.includes(kw)).length;

    // Single device operations with clear keywords are simple
    const entities = this.extractEntities(lowerRequest);

    // If it's a single entity with set/change/adjust, treat as simple for single-device ops
    if (entities.length === 1 && mediumMatches > 0) {
      // Single device control is simple
      return TaskComplexity.SIMPLE;
    }

    // Multiple entities with medium keywords = medium complexity
    if (entities.length > 1 && mediumMatches > 0) {
      return TaskComplexity.MEDIUM;
    }

    // Check for simple patterns
    const simpleMatches = TaskPlanner.COMPLEXITY_KEYWORDS.simple
      .filter(kw => lowerRequest.includes(kw)).length;

    if (simpleMatches > 0) {
      return TaskComplexity.SIMPLE;
    }

    // Default to medium for uncertain cases
    return TaskComplexity.MEDIUM;
  }

  /**
   * Detect action type from request using keyword matching
   * DEPRECATED: Use detectActionTypeWithLLM instead
   */
  private detectActionType(request: string): 'observe' | 'control' | 'analyze' | 'coordinate' {
    const lowerRequest = request.toLowerCase();

    // Count matches for each action type
    const observeMatches = TaskPlanner.ACTION_TYPE_KEYWORDS.observe
      .filter(kw => lowerRequest.includes(kw)).length;
    const controlMatches = TaskPlanner.ACTION_TYPE_KEYWORDS.control
      .filter(kw => lowerRequest.includes(kw)).length;
    const analyzeMatches = TaskPlanner.ACTION_TYPE_KEYWORDS.analyze
      .filter(kw => lowerRequest.includes(kw)).length;

    // CRITICAL: Control keywords take priority when present
    if (controlMatches > 0) {
      return 'control';
    }

    // Return the type with most matches for other cases
    if (analyzeMatches > observeMatches) {
      return 'analyze';
    }
    if (observeMatches > 0) {
      return 'observe';
    }

    // Default to observe for unclear cases
    return 'observe';
  }

  /**
   * Extract entities from request
   */
  private extractEntities(request: string): string[] {
    const entityPatterns = [
      'temperature', 'humidity', 'pressure', 'light', 'brightness',
      'hvac', 'thermostat', 'heating', 'cooling', 'ventilation',
      'door', 'window', 'lock', 'blind', 'curtain',
      'camera', 'motion', 'occupancy', 'presence',
      'energy', 'power', 'water', 'gas'
    ];

    const found: string[] = [];
    const lowerRequest = request.toLowerCase();

    for (const entity of entityPatterns) {
      if (lowerRequest.includes(entity) && !found.includes(entity)) {
        found.push(entity);
      }
    }

    return found;
  }

  /**
   * Create plan for simple tasks without LLM
   */
  private createSimplePlan(
    request: string,
    context: PlanningContext,
    startTime: number
  ): TaskPlan {
    const entities = this.extractEntities(request);
    const entity = entities.length > 0 ? entities[0] : null;
    const lowerRequest = request.toLowerCase();

    // Determine action type using improved keyword detection
    const actionType = this.detectActionType(request);

    logger.info(`Detected action type: ${actionType} for entity: ${entity}`);

    // Map entity to capability
    const capabilityMap: Record<string, string[]> = {
      'temperature': ['temperature-sensor', 'temperature-monitoring'],
      'humidity': ['humidity-sensor', 'humidity-monitoring'],
      'hvac': ['hvac-control', 'climate-control'],
      'thermostat': ['thermostat-control', 'temperature-control'],
      'light': ['light-control', 'lighting'],
      'door': ['door-control', 'access-control'],
      'window': ['window-control', 'blind-control'],
      'camera': ['camera-feed', 'video-monitoring'],
      'motion': ['motion-sensor', 'presence-detection'],
      'energy': ['energy-monitoring', 'power-meter']
    };

    const requiredCapabilities = entity && capabilityMap[entity]
      ? capabilityMap[entity]
      : [actionType === 'observe' ? 'monitoring' : 'control'];

    return {
      taskId: `task-${Date.now()}`,
      summary: request,
      intent: request,
      actionType,
      complexity: TaskComplexity.SIMPLE,
      confidence: 0.9,
      entity,
      scope: 'device',
      requiredCapabilities,
      requiredDataTypes: ['numeric'],
      executionStrategy: 'direct',
      availableResources: context.resources.map(r => r.id),
      constraints: [],
      planningTime: Date.now() - startTime,
      reasoningTrace: 'Quick pattern matching: simple task detected'
    };
  }

  /**
   * LLM-based deep planning for medium/complex tasks
   * Uses structured prompt with context
   */
  private async planWithLLM(
    request: string,
    context: PlanningContext,
    initialComplexity: TaskComplexity
  ): Promise<TaskPlan> {
    const systemPrompt = this.buildPlanningSystemPrompt(context);
    const userPrompt = this.buildPlanningUserPrompt(request, context, initialComplexity);

    try {
      const response = await this.llmClient.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,  // Lower temperature for more deterministic planning
        maxTokens: 800
      });

      // Parse structured response
      const plan = this.parsePlanningResponse(response.content, request, context);

      return plan;
    } catch (error) {
      logger.error('LLM planning failed:', error);
      // NO FALLBACK - throw error to expose the problem
      throw new Error(`TaskPlanner LLM planning failed: ${error}. Request: "${request}"`);
    }
  }

  /**
   * Build system prompt for planning
   * Clear role definition with structured output requirements
   */
  private buildPlanningSystemPrompt(context: PlanningContext): string {
    // If full context is available, use enhanced prompt with device states
    if (context.fullContext) {
      return this.buildEnhancedPlanningPrompt(context);
    }

    // Fallback to basic prompt
    const resourcesInfo = context.resources.map(r =>
  `- ${r.name} (${r.type}): capabilities=[${r.capabilities.join(', ')}]${r.location ? ` location=${r.location}` : ''}`
).join('\n');

    const servicesInfo = context.services && context.services.length > 0
      ? context.services.map(s => `- ${s.name}: ${s.category || 'No description'}`).join('\n')
      : 'No services registered';

    return `You are a Task Planner for an IoT Cognitive Agent in an Active Collaboration (AC) framework.

## AC Framework Overview
- **Cognitive Agents** are autonomous entities that can sense, reason, and act
- **Resources** are devices/APIs the agent can use (sensors, actuators, external services)
- **Services** are capabilities the agent exposes to other agents
- **Collaboration** happens when an agent cannot complete a task alone and needs help from other agents

## This Agent's Context
- **Agent ID**: ${context.agentId}
- **Agent Name**: ${context.agentName}
- **Agent Capabilities**: ${context.agentCapabilities.join(', ') || 'None'}
- **Environment**: ${context.environmentType || 'Unknown'}
- **Collaboration Enabled**: ${context.acContext?.collaborationEnabled !== false ? 'Yes' : 'No'}

## This Agent's Resources (What it can use)
${resourcesInfo || 'No resources available'}

## This Agent's Services (What it exposes to others)
${servicesInfo}

## Action Type Classification (CRITICAL)
- **observe**: Reading/checking data WITHOUT changing device state
  Examples: "check temperature", "read humidity", "get status", "show me"
- **control**: Changing device state or settings
  Examples: "set temperature to 22", "turn on light", "adjust HVAC"
- **analyze**: Processing data, calculations
  Examples: "analyze trends", "compare values", "calculate average"
- **coordinate**: Multi-device orchestration
  Examples: "maintain temperature", "optimize across zones"

## Execution Strategy Selection
- **direct**: Agent can execute using its own resources directly
- **resource-based**: Agent needs to synthesize from multiple resources
- **collaborative**: Agent needs to collaborate with other agents
- **decomposed**: Task needs to be broken into subtasks

## Output Format (CRITICAL)
Return ONLY a JSON object with these EXACT field names:
- actionType: "observe" | "control" | "analyze" | "coordinate"
- complexity: "simple" | "medium" | "complex"
- entity: main entity (temperature, hvac, humidity, light, etc.)
- requiredCapabilities: array of capability names
- executionStrategy: "direct" | "resource-based" | "collaborative" | "decomposed"

## Examples
Request: "Set the HVAC target temperature to 22 degrees"
{"actionType":"control","complexity":"simple","entity":"hvac","requiredCapabilities":["hvac-control"],"executionStrategy":"direct","summary":"Set HVAC target to 22°C","intent":"Change HVAC target","confidence":0.95,"scope":"device","requiredDataTypes":["numeric"],"constraints":[]}

Request: "Check the room temperature"
{"actionType":"observe","complexity":"simple","entity":"temperature","requiredCapabilities":["temperature-sensor"],"executionStrategy":"direct","summary":"Read temperature","intent":"Get temperature reading","confidence":0.95,"scope":"device","requiredDataTypes":["numeric"],"constraints":[]}

/no_think`;
  }

  /**
   * Build enhanced planning prompt with full context including device states
   */
  private buildEnhancedPlanningPrompt(context: PlanningContext): string {
    const fc = context.fullContext;

    // Format resources with their current states AND location AND ontology (CRITICAL for semantic reasoning)
    const resourcesInfo = fc.resources.slice(0, 5).map((r: any) => {
      const stateStr = Object.entries(r.currentState || {})
        .filter(([k, v]) => typeof v !== 'object')
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const locationStr = r.location ? ` @${r.location}` : '';
      const ontologyStr = r.ontology ? ` [${r.ontology}]` : '';
      return `${r.name}${locationStr}: [${r.capabilities.slice(0, 3).join(', ')}]${ontologyStr}${stateStr ? ` (${stateStr})` : ''}`;
    }).join('\n');

    // Format peer agents (simplified)
    const peerAgentsInfo = fc.peerAgents.slice(0, 5).map((a: any) => {
      return `${a.name}: [${a.capabilities.slice(0, 3).join(', ')}]`;
    }).join('\n');

    // Collect capabilities
    const ownCapabilities = new Set<string>();
    fc.resources.forEach((r: any) => {
      r.capabilities.forEach((c: string) => ownCapabilities.add(c));
    });

    const peerCapabilities = new Set<string>();
    fc.peerAgents.forEach((a: any) => {
      a.capabilities.forEach((c: string) => peerCapabilities.add(c));
    });

    // Build semantic context section if available
    const semanticInfo = fc.resources
      .filter((r: any) => r.semanticContext)
      .slice(0, 3)
      .map((r: any) => `  ${r.name}: ${r.semanticContext}`)
      .join('\n');

    const semanticSection = semanticInfo ? `
## Resource Semantic Context
${semanticInfo}
` : '';

    return `You are a Task Execution Planner. Given a task, output a JSON execution plan.

## Your Capabilities
${Array.from(ownCapabilities).join(', ') || 'None'}

## Your Available Resources (with locations)
${resourcesInfo || 'None'}
${semanticSection}
## Peer Agent Capabilities (for collaboration)
${peerAgentsInfo || 'None'}

## CRITICAL: Spatial Location Rules
When the user asks about a specific location (e.g., "temperature in the living room"):
1. You MUST select a resource located in that specific location
2. DO NOT use a sensor from a different location (e.g., bedroom sensor for living room query)
3. If no resource exists in the requested location, note this in the plan

## Task Classification Rules
1. actionType:
   - "observe" = reading/checking data (read, check, get, show, find, search)
   - "control" = changing state (set, turn, adjust, change, configure)
   - "analyze" = processing/evaluation (analyze, assess, evaluate, compare)
   - "coordinate" = multi-agent orchestration

2. executionStrategy:
   - "direct" = you have ALL required capabilities
   - "collaborative" = you lack some, but peers have them
   - "resource-based" = combine your multiple resources
   - "decomposed" = task too complex, needs subtasks

## Examples

Task: "Read the temperature in Lab A"
{"actionType":"observe","complexity":"simple","entity":"temperature","requiredCapabilities":["temperature-sensor"],"executionStrategy":"direct","summary":"Read Lab A temperature","intent":"Get temperature reading","confidence":0.95,"targetLocation":"Lab A"}

Task: "Find humidity sensors on campus"
{"actionType":"observe","complexity":"simple","entity":"humidity","requiredCapabilities":["humidity-sensor"],"missingCapabilities":["humidity-sensor"],"availableFromPeers":[{"agentId":"research-lab-agent","capabilities":["humidity-sensor"]}],"executionStrategy":"collaborative","summary":"Discover humidity sensors via environment","intent":"Find humidity sensor locations","confidence":0.9}

Task: "Assess if Lab A is suitable for moisture-sensitive experiment"
{"actionType":"analyze","complexity":"medium","entity":"environment","requiredCapabilities":["temperature-sensor","humidity-sensor","co2-sensor"],"missingCapabilities":["humidity-sensor"],"availableFromPeers":[{"agentId":"research-lab-agent","capabilities":["humidity-sensor"]}],"executionStrategy":"collaborative","summary":"Collect environmental data and assess suitability","intent":"Evaluate Lab A for experiment","confidence":0.85,"targetLocation":"Lab A"}

Task: "Reduce HVAC cooling due to power constraint"
{"actionType":"control","complexity":"medium","entity":"hvac","requiredCapabilities":["hvac-control"],"executionStrategy":"direct","summary":"Adjust HVAC settings for power reduction","intent":"Reduce power consumption","confidence":0.9}

## Output Rules
1. Output ONLY valid JSON, no other text
2. Required fields: actionType, complexity, entity, requiredCapabilities, executionStrategy
3. If you lack capabilities, add: missingCapabilities, availableFromPeers
4. If task mentions a location, add: targetLocation (the specific location requested)
5. Optional fields: summary, intent, confidence

/no_think`;
  }

  /**
   * Build user prompt with task and context
   * Includes AC framework context, agent capabilities, and task execution purpose
   */
  private buildPlanningUserPrompt(
    request: string,
    context: PlanningContext,
    initialComplexity: TaskComplexity
  ): string {
    // Compact format to reduce tokens
    let prompt = `Task:"${request}"|Complexity:${initialComplexity}
AC Context:direct=own caps|collaborative=need peers|resource-based=combine resources|decomposed=subtasks
`;

    // Add similar cases if available (case-based reasoning) - limit to 2
    if (context.similarCases && context.similarCases.length > 0) {
      prompt += `Similar:${context.similarCases.slice(0, 2).map(c =>
        `"${c.task.slice(0, 30)}"->${c.success ? 'OK' : 'FAIL'}`
      ).join('|')}
`;
    }

    prompt += `JSON only./no_think`;

    return prompt;
  }

  /**
   * Parse LLM response into TaskPlan
   */
  private parsePlanningResponse(
    response: string,
    originalRequest: string,
    context: PlanningContext
  ): TaskPlan {
    // Extract JSON from response - handle multiple formats
    let jsonStr: string | null = null;

    // Try to extract from markdown code block first
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // If no code block, try to find raw JSON (both objects and arrays)
    if (!jsonStr) {
      // Try JSON array first: starts with [ and ends with ]
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        // Validate it's actually valid JSON array
        try {
          JSON.parse(arrayMatch[0]);
          jsonStr = arrayMatch[0];
        } catch {
          // Not valid JSON array, try object
        }
      }
    }

    if (!jsonStr) {
      // Try JSON object: starts with { and ends with }
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
    }

    if (!jsonStr) {
      // NO FALLBACK - throw error to expose the problem
      throw new Error(`[TaskPlanner] No JSON found in LLM response. Response: "${response.substring(0, 200)}..."`);
    }

    try {
      let parsed = JSON.parse(jsonStr);

      // Handle LLM returning a JSON array instead of a single object
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          throw new Error('[TaskPlanner] LLM returned empty JSON array');
        }
        // Use the first element as the plan object, or wrap the array as a plan
        const first = parsed[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          // If first element looks like a plan (has recognizable fields), use it
          parsed = first;
        } else {
          // Wrap the array as a plan result
          parsed = { results: parsed, actionType: 'collaborate', complexity: 'complex' };
        }
      }

      // Handle LLM returning task description instead of execution plan
      // If LLM returned a "task" field but not actionType, try to infer
      if (!parsed.actionType && parsed.task) {
        logger.info('LLM returned task description, inferring execution plan...');
        return this.inferPlanFromTaskDescription(parsed, originalRequest, context);
      }

      // Handle alternative field names from LLM
      const normalized = {
        actionType: parsed.actionType || parsed.action_type || parsed.type,
        complexity: parsed.complexity || parsed.task_complexity,
        entity: parsed.entity || parsed.target_entity || parsed.target,
        requiredCapabilities: parsed.requiredCapabilities || parsed.capabilitiesRequired || parsed.required_capabilities || parsed.capabilities || [],
        executionStrategy: parsed.executionStrategy || parsed.execution_strategy || parsed.strategy,
        summary: parsed.summary || parsed.task_summary || parsed.description,
        intent: parsed.intent || parsed.user_intent || parsed.purpose,
        confidence: parsed.confidence || parsed.certainty || 0.8,
        scope: parsed.scope || 'device',
        requiredDataTypes: parsed.requiredDataTypes || parsed.data_types || ['numeric'],
        constraints: parsed.constraints || [],
        missingCapabilities: parsed.missingCapabilities || parsed.missing_capabilities || [],
        availableFromPeers: parsed.availableFromPeers || parsed.available_from_peers || []
      };

      // Map complexity string to enum
      let complexity: TaskComplexity;
      switch (normalized.complexity?.toLowerCase()) {
        case 'simple':
          complexity = TaskComplexity.SIMPLE;
          break;
        case 'medium':
          complexity = TaskComplexity.MEDIUM;
          break;
        case 'complex':
          complexity = TaskComplexity.COMPLEX;
          break;
        default:
          complexity = TaskComplexity.UNCERTAIN;
      }

      // Determine action type - use keyword detection as primary if LLM didn't provide it
      let actionType: 'observe' | 'control' | 'analyze' | 'coordinate';

      if (normalized.actionType) {
        try {
          actionType = this.validateActionType(normalized.actionType);
        } catch (e) {
          logger.warn(`LLM actionType invalid: ${normalized.actionType}, using keyword detection`);
          actionType = this.detectActionType(originalRequest);
        }
      } else {
        // LLM didn't provide actionType, use keyword detection
        logger.info(`LLM missing actionType, using keyword detection`);
        actionType = this.detectActionType(originalRequest);
      }

      // CRITICAL: Validate action type against keywords in request
      const keywordActionType = this.detectActionType(originalRequest);
      if (keywordActionType === 'control' && actionType !== 'control') {
        logger.warn(`Overriding LLM actionType "${actionType}" with keyword-detected "control"`);
        actionType = 'control';
      }

      // Also validate entity if missing
      let entity = normalized.entity || null;
      if (!entity) {
        const detectedEntities = this.extractEntities(originalRequest);
        if (detectedEntities.length > 0) {
          entity = detectedEntities[0];
          logger.info(`Auto-detected entity: ${entity}`);
        }
      }

      // Infer execution strategy if missing
      let executionStrategy = normalized.executionStrategy;
      if (!executionStrategy) {
        executionStrategy = this.inferExecutionStrategy(normalized.requiredCapabilities, context);
        logger.info(`Inferred executionStrategy: ${executionStrategy}`);
      }

      return {
        taskId: `task-${Date.now()}`,
        summary: normalized.summary || originalRequest,
        intent: normalized.intent || originalRequest,
        actionType,
        complexity,
        confidence: Math.min(1, Math.max(0, normalized.confidence)),
        entity,
        scope: normalized.scope,
        requiredCapabilities: normalized.requiredCapabilities,
        requiredDataTypes: normalized.requiredDataTypes,
        missingCapabilities: normalized.missingCapabilities,
        availableFromPeers: normalized.availableFromPeers,
        executionStrategy,
        availableResources: context.resources.map(r => r.id),
        constraints: normalized.constraints,
        planningTime: 0,
        reasoningTrace: `LLM planning with auto-correction. Original actionType: ${normalized.actionType || 'missing'}, final: ${actionType}`
      };
    } catch (parseError) {
      // NO FALLBACK - throw error to expose the problem
      throw new Error(`[TaskPlanner] JSON parse error: ${parseError}. Response: "${response.substring(0, 200)}..."`);
    }
  }

  /**
   * Infer execution plan from task description (when LLM returns wrong format)
   */
  private inferPlanFromTaskDescription(
    parsed: any,
    originalRequest: string,
    context: PlanningContext
  ): TaskPlan {
    // Extract what we can from the task description
    const task = parsed.task || originalRequest;
    let requiredCaps = parsed.requiredCapabilities || parsed.capabilitiesRequired || [];
    const missingCaps = parsed.missingCapabilities || [];

    // Infer action type from task
    const actionType = this.detectActionType(originalRequest);

    // Infer entity
    const entities = this.extractEntities(originalRequest);
    const entity = entities.length > 0 ? entities[0] : 'unknown';

    // If requiredCapabilities is empty, infer from task description
    if (requiredCaps.length === 0) {
      requiredCaps = this.inferCapabilitiesFromTask(originalRequest);
      logger.info(`Inferred capabilities from task: ${requiredCaps.join(', ')}`);
    }

    // Infer complexity
    const complexity = this.assessComplexityQuickly(originalRequest);

    // Infer execution strategy
    const executionStrategy = this.inferExecutionStrategy(requiredCaps, context);

    return {
      taskId: `task-${Date.now()}`,
      summary: task,
      intent: originalRequest,
      actionType,
      complexity,
      confidence: 0.6, // Lower confidence for inferred plans
      entity,
      scope: 'device',
      requiredCapabilities: requiredCaps,
      requiredDataTypes: ['numeric'],
      missingCapabilities: missingCaps,
      availableFromPeers: [],
      executionStrategy,
      availableResources: context.resources.map(r => r.id),
      constraints: [],
      planningTime: 0,
      reasoningTrace: `Inferred from task description. actionType: ${actionType}, strategy: ${executionStrategy}`
    };
  }

  /**
   * Infer required capabilities from task description based on keywords
   */
  private inferCapabilitiesFromTask(task: string): string[] {
    const capabilities: string[] = [];
    const taskLower = task.toLowerCase();

    // Sensor capabilities
    if (taskLower.includes('humidity')) {
      capabilities.push('humidity-sensor');
    }
    if (taskLower.includes('temperature')) {
      capabilities.push('temperature-sensor');
    }
    if (taskLower.includes('co2') || taskLower.includes('carbon dioxide')) {
      capabilities.push('co2-sensor');
    }
    if (taskLower.includes('occupancy') || taskLower.includes('people') || taskLower.includes('personnel')) {
      capabilities.push('occupancy-sensor');
    }
    if (taskLower.includes('light') || taskLower.includes('illumination')) {
      capabilities.push('light-sensor');
    }
    if (taskLower.includes('motion') || taskLower.includes('movement')) {
      capabilities.push('motion-sensor');
    }
    if (taskLower.includes('smoke') || taskLower.includes('fire')) {
      capabilities.push('smoke-sensor');
    }
    if (taskLower.includes('power') || taskLower.includes('energy')) {
      capabilities.push('power-meter');
    }

    // If no specific capabilities found, add a general one based on action type
    if (capabilities.length === 0) {
      if (taskLower.includes('environment') || taskLower.includes('condition')) {
        capabilities.push('environmental-sensor');
      } else {
        capabilities.push('general-sensor');
      }
    }

    return capabilities;
  }

  /**
   * Infer execution strategy based on required capabilities and available resources
   */
  private inferExecutionStrategy(
    requiredCapabilities: string[],
    context: PlanningContext
  ): 'direct' | 'resource-based' | 'collaborative' | 'decomposed' {
    if (!requiredCapabilities || requiredCapabilities.length === 0) {
      return 'direct';
    }

    // Check what capabilities we have
    const ownCapabilities = new Set<string>();
    context.resources.forEach(r => {
      r.capabilities.forEach(c => ownCapabilities.add(c));
    });

    // Check if we have all required capabilities
    const hasAll = requiredCapabilities.every(cap => {
      // Normalize capability names for comparison
      const normalizedCap = cap.toLowerCase().replace(/[-_]/g, '');
      return Array.from(ownCapabilities).some(own =>
        own.toLowerCase().replace(/[-_]/g, '').includes(normalizedCap) ||
        normalizedCap.includes(own.toLowerCase().replace(/[-_]/g, ''))
      );
    });

    if (hasAll) {
      return requiredCapabilities.length > 1 ? 'resource-based' : 'direct';
    }

    // Check if peers have the missing capabilities
    if (context.peerAgents && context.peerAgents.length > 0) {
      return 'collaborative';
    }

    return 'decomposed';
  }

  /**
   * Validate and normalize action type
   */
  private validateActionType(type: string): 'observe' | 'control' | 'analyze' | 'coordinate' {
    const validTypes = ['observe', 'control', 'analyze', 'coordinate'];
    const lowerType = type?.toLowerCase();

    if (validTypes.includes(lowerType)) {
      return lowerType as 'observe' | 'control' | 'analyze' | 'coordinate';
    }

    // Map common variations
    if (['read', 'monitor', 'check', 'get'].includes(lowerType)) {
      return 'observe';
    }
    if (['write', 'set', 'adjust', 'change'].includes(lowerType)) {
      return 'control';
    }
    if (['compute', 'calculate', 'process'].includes(lowerType)) {
      return 'analyze';
    }
    if (['manage', 'orchestrate', 'coordinate'].includes(lowerType)) {
      return 'coordinate';
    }

    // If we can't determine the type, throw an error - don't silently default
    throw new Error(`Unknown action type: ${type}. Cannot determine if this is observe, control, analyze, or coordinate.`);
  }
}

export default TaskPlanner;
