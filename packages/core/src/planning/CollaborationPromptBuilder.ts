/**
 * CollaborationPromptBuilder - Optimized Prompt Construction for AC
 *
 * Based on research findings:
 * - Structured prompts with clear role definitions
 * - Context-rich prompts with available resources
 * - Semantic compression for efficiency
 * - Clear output format specifications
 */

import type { TaskPlan } from './TaskPlanner.js';

/**
 * Agent context for prompt building
 */
export interface AgentPromptContext {
  agentId: string;
  agentName: string;
  agentCapabilities: string[];
  resources: Array<{
    id: string;
    name: string;
    type: string;
    capabilities: string[];
  }>;
  environmentType?: string;
}

/**
 * Proposal context for evaluation prompts
 */
export interface ProposalPromptContext extends AgentPromptContext {
  taskDescription: string;
  taskRequirements: string[];
  taskComplexity: 'simple' | 'medium' | 'complex';
  partnerAgent?: {
    id: string;
    name: string;
    capabilities: string[];
  };
}

/**
 * Event analysis context
 */
export interface EventAnalysisContext extends AgentPromptContext {
  eventType: string;
  eventSource: string;
  eventPayload: Record<string, any>;
}

/**
 * CollaborationPromptBuilder
 *
 * Centralizes and optimizes all collaboration-related prompts.
 * Uses structured templates with clear role definitions and output formats.
 */
export class CollaborationPromptBuilder {
  /**
   * Build task understanding prompt
   * Optimized version with rich context
   */
  static buildTaskUnderstandingPrompt(
    request: string,
    context: AgentPromptContext
  ): string {
    return `# Task Analysis Request

## Agent Context
You are **${context.agentName}**, an IoT Cognitive Agent responsible for managing devices and services.

### Your Capabilities
${context.agentCapabilities.map(cap => `- ${cap}`).join('\n')}

### Available Resources
${context.resources.length > 0
  ? context.resources.map(r => `- **${r.name}** (${r.type}): ${r.capabilities.join(', ')}`).join('\n')
  : '- No resources currently available'
}

${context.environmentType ? `### Environment Type: ${context.environmentType}` : ''}

## Task to Analyze
"${request}"

## Analysis Required
Provide a structured analysis of this task:

\`\`\`json
{
  "summary": "Brief one-line summary of the task",
  "intent": "What the user wants to achieve",
  "actionType": "observe|control|analyze|coordinate",
  "complexity": "simple|medium|complex",
  "confidence": 0.0-1.0,
  "entity": "the main entity being acted upon (temperature, humidity, etc.)",
  "scope": "device|room|zone|environment",
  "requiredCapabilities": ["list of required capabilities"],
  "executionStrategy": "direct|resource-based|collaborative|decomposed"
}
\`\`\`

## Rules
1. Match required capabilities to your available resources
2. Use "direct" strategy only for simple single-device operations
3. Use "collaborative" if you lack required capabilities
4. Be precise about what entity is being acted upon
5. Return ONLY the JSON object, no additional text`;
  }

  /**
   * Build capability evaluation prompt
   * Optimized with semantic relationships
   */
  static buildCapabilityEvaluationPrompt(
    context: ProposalPromptContext
  ): string {
    return `# Capability Evaluation Request

## Agent Profile
**Name:** ${context.agentName}
**Capabilities:** ${context.agentCapabilities.join(', ')}

## Available Resources
${context.resources.map(r => `- ${r.name}: ${r.capabilities.join(', ')}`).join('\n')}

## Task Details
**Description:** ${context.taskDescription}
**Requirements:** ${context.taskRequirements.join(', ')}
**Complexity:** ${context.taskComplexity}

## Semantic Capability Mappings
- "hvac", "climate control", "thermostat" → can handle "temperature"
- "humidifier", "moisture control" → can handle "humidity"
- "purifier", "air filter" → can handle "air quality"
- "lighting", "illumination" → can handle "brightness", "light"
- "lock", "access control" → can handle "door", "security"

## Evaluation Scale
- **1.0**: Agent has ALL required capabilities AND matching resources
- **0.8**: Agent has semantic equivalent capabilities
- **0.6**: Agent has partial capabilities, may need adaptation
- **0.4**: Agent has related capabilities but significant gaps
- **0.2**: Agent has minimal relevant capabilities
- **0.0**: Agent cannot complete this task

## Response Format
Return ONLY a JSON object:
\`\`\`json
{
  "score": 0.85,
  "reasoning": "Brief explanation of the score",
  "matchedCapabilities": ["list of matched capabilities"],
  "missingCapabilities": ["list of missing capabilities"],
  "recommendedStrategy": "direct|adapt|collaborate|decline"
}
\`\`\``;
  }

  /**
   * Build event analysis prompt
   * Optimized for event-driven collaboration
   */
  static buildEventAnalysisPrompt(
    context: EventAnalysisContext
  ): string {
    return `# Event Analysis for Autonomous Decision

## Agent Context
You are **${context.agentName}**, monitoring events and deciding when collaboration is needed.

**Your Capabilities:** ${context.agentCapabilities.join(', ')}

## Event Details
- **Type:** ${context.eventType}
- **Source:** ${context.eventSource}
- **Payload:**
\`\`\`json
${JSON.stringify(context.eventPayload, null, 2)}
\`\`\`

## Decision Framework

### Event Severity Assessment
- **critical**: Immediate action required, safety implications
- **high**: Significant impact, needs prompt response
- **medium**: Notable change, standard handling
- **low**: Informational, may not require action

### Urgency Assessment (0.0-1.0)
- 0.9-1.0: Immediate response needed
- 0.7-0.9: Response within minutes
- 0.5-0.7: Response within hours
- 0.0-0.5: Can be deferred

### Collaboration Decision
Consider collaboration when:
1. Required capabilities exceed your own
2. Multiple devices/systems need coordination
3. Cross-domain expertise is needed
4. Redundancy improves reliability

## Response Format
Return ONLY a JSON object:
\`\`\`json
{
  "severity": "low|medium|high|critical",
  "urgency": 0.0-1.0,
  "requirements": ["capability1", "capability2"],
  "potentialImpact": "Description of consequences if not handled",
  "needsCollaboration": true|false,
  "collaborationReason": "Why collaboration is/isn't needed"
}
\`\`\``;
  }

  /**
   * Build proposal response prompt
   * For agents evaluating incoming collaboration proposals
   */
  static buildProposalResponsePrompt(
    context: ProposalPromptContext & {
      proposalId: string;
      proposerName: string;
      proposedTerms: {
        contractType: string;
        duration?: number;
      };
    }
  ): string {
    return `# Collaboration Proposal Evaluation

## Your Profile
**Agent:** ${context.agentName}
**Capabilities:** ${context.agentCapabilities.join(', ')}

## Available Resources
${context.resources.map(r => `- ${r.name}: ${r.capabilities.join(', ')}`).join('\n')}

## Incoming Proposal
- **From:** ${context.proposerName}
- **Task:** ${context.taskDescription}
- **Required Capabilities:** ${context.taskRequirements.join(', ')}
- **Contract Type:** ${context.proposedTerms.contractType}
- **Duration:** ${context.proposedTerms.duration ? `${context.proposedTerms.duration} seconds` : 'Not specified'}

## Evaluation Criteria

### 1. Capability Match (40% weight)
Can you provide the required capabilities?
- Exact match: 1.0
- Semantic match: 0.8
- Partial match: 0.5
- No match: 0.0

### 2. Resource Availability (30% weight)
Are your resources available for this collaboration?
- Fully available: 1.0
- Mostly available: 0.7
- Partially available: 0.4
- Unavailable: 0.0

### 3. Benefit Assessment (20% weight)
What do you gain from this collaboration?
- High mutual benefit: 1.0
- Moderate benefit: 0.6
- Low benefit: 0.3
- No benefit: 0.0

### 4. Cost Assessment (10% weight)
What resources/time will this cost you?
- Low cost: 1.0
- Moderate cost: 0.6
- High cost: 0.3
- Excessive cost: 0.0

## Response Format
Return ONLY a JSON object:
\`\`\`json
{
  "accept": true|false,
  "confidence": 0.0-1.0,
  "offeredCapabilities": ["capabilities you can provide"],
  "offeredResources": ["resource IDs you can contribute"],
  "terms": {
    "estimatedCompletionTime": seconds,
    "qualityGuarantee": "description of quality level"
  },
  "reasoning": "Why you accept/decline"
}
\`\`\``;
  }

  /**
   * Build decomposition prompt for complex tasks
   * Implements hierarchical task decomposition
   */
  static buildTaskDecompositionPrompt(
    taskPlan: TaskPlan,
    context: AgentPromptContext
  ): string {
    return `# Task Decomposition Request

## Agent Context
You are **${context.agentName}**, decomposing a complex task into executable subtasks.

**Your Capabilities:** ${context.agentCapabilities.join(', ')}

**Available Resources:**
${context.resources.map(r => `- **${r.name}** (${r.type}): ${r.capabilities.join(', ')}`).join('\n')}

## Complex Task to Decompose
**Summary:** ${taskPlan.summary}
**Intent:** ${taskPlan.intent}
**Required Capabilities:** ${taskPlan.requiredCapabilities.join(', ')}
**Constraints:** ${taskPlan.constraints.join(', ') || 'None'}

## Decomposition Guidelines

### Subtask Structure
Each subtask should:
1. Be independently executable
2. Have clear success criteria
3. Specify required capabilities
4. Define dependencies on other subtasks

### Execution Patterns
- **Sequential**: Subtasks must execute in order (specify dependencies)
- **Parallel**: Subtasks can execute simultaneously (no dependencies)
- **Conditional**: Subtask executes based on previous results

### Subtask Complexity
Keep each subtask at "simple" or "medium" complexity.
If a subtask is still "complex", decompose further.

## Response Format
Return ONLY a JSON object:
\`\`\`json
{
  "decompositionStrategy": "sequential|parallel|hybrid",
  "subtasks": [
    {
      "id": "subtask-1",
      "description": "What this subtask accomplishes",
      "actionType": "observe|control|analyze",
      "requiredCapabilities": ["cap1", "cap2"],
      "dependencies": [],
      "priority": 1,
      "estimatedDuration": seconds
    }
  ],
  "executionOrder": ["subtask-1", "subtask-2", ...],
  "parallelGroups": [["subtask-1", "subtask-2"], ["subtask-3"]],
  "successCriteria": ["criteria 1", "criteria 2"]
}
\`\`\``;
  }

  /**
   * Build service creation prompt
   * For agents creating new services to meet requirements
   */
  static buildServiceCreationPrompt(
    taskPlan: TaskPlan,
    context: AgentPromptContext
  ): string {
    return `# Service Creation Request

## Agent Context
You are **${context.agentName}**, creating a new service to fulfill a task requirement.

**Your Capabilities:** ${context.agentCapabilities.join(', ')}

**Your Resources:**
${context.resources.map(r => `- **${r.name}** (${r.type}): ${r.capabilities.join(', ')}`).join('\n')}

## Service Requirement
**Task:** ${taskPlan.summary}
**Required Capabilities:** ${taskPlan.requiredCapabilities.join(', ')}
**Data Types:** ${taskPlan.requiredDataTypes.join(', ')}
**Scope:** ${taskPlan.scope}

## Service Specification Template

Define a service that:
1. Uses your available resources
2. Provides the required capabilities
3. Can be invoked by other agents

## Response Format
Return ONLY a JSON object:
\`\`\`json
{
  "serviceName": "descriptive-service-name",
  "serviceType": "observe|control|analyze|coordinate",
  "description": "What this service does",
  "capabilities": ["capability1", "capability2"],
  "usedResources": ["resource-id-1", "resource-id-2"],
  "parameters": [
    {
      "name": "param1",
      "type": "string|number|boolean|object",
      "required": true|false,
      "description": "Parameter description"
    }
  ],
  "outputFormat": {
    "type": "object",
    "properties": {
      "result": "description of result"
    }
  },
  "estimatedExecutionTime": seconds,
  "qualityLevel": "high|medium|low"
}
\`\`\``;
  }
}

export default CollaborationPromptBuilder;
