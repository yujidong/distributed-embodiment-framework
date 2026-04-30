/**
 * Task AC Analyzer
 *
 * Analyzes tasks to determine if Active Collaboration (AC) is needed.
 * This is the primary entry point for AC decisions in a Task-driven architecture.
 *
 * Design Philosophy:
 * - AC is triggered by explicit tasks, not by environmental events
 * - LLM analyzes task complexity and capability requirements
 * - Agent decides autonomously whether to collaborate
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import type { AgentProfile } from '../goal/index.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Task information for AC analysis
 */
const logger = createLogger('TaskACAnalyzer');

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  type?: string;
  requiredCapabilities?: string[];
  deadline?: Date;
  context?: Record<string, any>;
}

/**
 * AC Analysis Result
 */
export interface ACAnalysisResult {
  needsAC: boolean;
  reason: string;
  confidence: number;
  suggestedPartnerTypes?: string[];
  requiredCapabilities?: string[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  canHandleAlone: boolean;
  missingCapabilities: string[];
}

/**
 * Agent context for AC analysis
 */
export interface ACAgentContext {
  agentId: string;
  agentName: string;
  capabilities: string[];
  profile: AgentProfile;
  currentWorkload: number;
  availableResources: string[];
}

/**
 * Task AC Analyzer Configuration
 */
export interface TaskACAnalyzerConfig {
  /** Minimum complexity threshold to consider AC */
  complexityThreshold: 'simple' | 'moderate' | 'complex';
  /** Minimum confidence to trigger AC */
  confidenceThreshold: number;
  /** Whether to use LLM for analysis */
  useLLMAnalysis: boolean;
  /** Maximum concurrent ACs for an agent */
  maxConcurrentACs: number;
}

const DEFAULT_CONFIG: TaskACAnalyzerConfig = {
  complexityThreshold: 'moderate',
  confidenceThreshold: 0.6,
  useLLMAnalysis: true,
  maxConcurrentACs: 3,
};

/**
 * Task AC Analyzer
 *
 * Determines whether a task requires Active Collaboration based on:
 * 1. Task complexity
 * 2. Required capabilities vs agent capabilities
 * 3. Task type and priority
 * 4. LLM-based semantic analysis
 */
export class TaskACAnalyzer {
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;
  private config: TaskACAnalyzerConfig;
  private analysisCache: Map<string, ACAnalysisResult> = new Map();

  constructor(
    llmClient: LLMClient,
    environment: EnvironmentCenter,
    config?: Partial<TaskACAnalyzerConfig>
  ) {
    this.llmClient = llmClient;
    this.environment = environment;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze a task to determine if AC is needed
   */
  async analyzeTask(
    task: TaskInfo,
    agentContext: ACAgentContext
  ): Promise<ACAnalysisResult> {
    logger.info(`Analyzing task: ${task.title}`);

    // Check cache first
    const cacheKey = `${task.id}-${agentContext.agentId}`;
    if (this.analysisCache.has(cacheKey)) {
      logger.info(`Using cached analysis for task ${task.id}`);
      return this.analysisCache.get(cacheKey)!;
    }

    // Step 1: Quick rule-based check
    const quickCheck = this.quickCheck(task, agentContext);
    if (quickCheck.needsAC === false && quickCheck.confidence > 0.8) {
      logger.info(`Quick check determined no AC needed`);
      return quickCheck;
    }

    // Step 2: Capability gap analysis
    const capabilityAnalysis = this.analyzeCapabilities(task, agentContext);
    if (capabilityAnalysis.missingCapabilities.length > 0) {
      logger.info(`Missing capabilities detected: ${capabilityAnalysis.missingCapabilities.join(', ')}`);
      // If missing capabilities, AC is definitely needed
      this.analysisCache.set(cacheKey, capabilityAnalysis);
      return capabilityAnalysis;
    }

    // Step 3: LLM-based analysis for complex decisions
    if (this.config.useLLMAnalysis) {
      const llmAnalysis = await this.llmAnalyze(task, agentContext);
      this.analysisCache.set(cacheKey, llmAnalysis);
      return llmAnalysis;
    }

    // Default to quick check result
    this.analysisCache.set(cacheKey, quickCheck);
    return quickCheck;
  }

  /**
   * Quick rule-based check for obvious cases
   */
  private quickCheck(
    task: TaskInfo,
    agentContext: ACAgentContext
  ): ACAnalysisResult {
    // Check if agent is overloaded
    if (agentContext.currentWorkload >= this.config.maxConcurrentACs) {
      return {
        needsAC: false,
        reason: 'Agent at maximum workload capacity',
        confidence: 0.9,
        estimatedComplexity: 'simple',
        canHandleAlone: false,
        missingCapabilities: [],
      };
    }

    // Simple tasks typically don't need AC
    if (task.priority === 'low' && !task.requiredCapabilities?.length) {
      return {
        needsAC: false,
        reason: 'Low priority simple task, no collaboration needed',
        confidence: 0.8,
        estimatedComplexity: 'simple',
        canHandleAlone: true,
        missingCapabilities: [],
      };
    }

    // Tasks with explicit collaboration requirement
    if (task.type === 'collaboration' || task.type === 'coordination') {
      return {
        needsAC: true,
        reason: 'Task type explicitly requires collaboration',
        confidence: 0.95,
        estimatedComplexity: 'moderate',
        canHandleAlone: false,
        missingCapabilities: [],
        suggestedPartnerTypes: ['coordinator', 'collaborator'],
      };
    }

    // Urgent tasks may need multiple agents for faster response
    if (task.priority === 'urgent') {
      return {
        needsAC: true,
        reason: 'Urgent task may benefit from parallel execution',
        confidence: 0.7,
        estimatedComplexity: 'moderate',
        canHandleAlone: true,
        missingCapabilities: [],
      };
    }

    // Indeterminate - needs LLM analysis
    return {
      needsAC: false,
      reason: 'Requires LLM analysis for determination',
      confidence: 0.5,
      estimatedComplexity: 'moderate',
      canHandleAlone: true,
      missingCapabilities: [],
    };
  }

  /**
   * Analyze capability gaps between task requirements and agent capabilities
   */
  private analyzeCapabilities(
    task: TaskInfo,
    agentContext: ACAgentContext
  ): ACAnalysisResult {
    const requiredCapabilities = task.requiredCapabilities || [];
    const agentCapabilities = agentContext.capabilities || [];

    // Find missing capabilities
    const missingCapabilities = requiredCapabilities.filter(
      (req) => !agentCapabilities.some(
        (cap) => cap.toLowerCase().includes(req.toLowerCase())
      )
    );

    // If no capabilities are missing, agent can potentially handle alone
    if (missingCapabilities.length === 0) {
      return {
        needsAC: false,
        reason: 'Agent has all required capabilities',
        confidence: 0.8,
        estimatedComplexity: this.estimateComplexity(task),
        canHandleAlone: true,
        missingCapabilities: [],
      };
    }

    // Missing capabilities mean AC is needed
    // Determine what kind of partners would have these capabilities
    const suggestedPartnerTypes = this.inferPartnerTypes(missingCapabilities);

    return {
      needsAC: true,
      reason: `Missing capabilities: ${missingCapabilities.join(', ')}`,
      confidence: 0.9,
      estimatedComplexity: this.estimateComplexity(task),
      canHandleAlone: false,
      missingCapabilities,
      requiredCapabilities,
      suggestedPartnerTypes,
    };
  }

  /**
   * Use LLM to analyze task complexity and AC necessity
   */
  private async llmAnalyze(
    task: TaskInfo,
    agentContext: ACAgentContext
  ): Promise<ACAnalysisResult> {
    const prompt = this.buildAnalysisPrompt(task, agentContext);

    try {
      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: `You are an AI system that analyzes tasks to determine if Active Collaboration (multiple agents working together) is needed.

Respond in JSON format with these fields:
{
  "needsAC": boolean,
  "reason": "explanation for the decision",
  "confidence": number between 0-1,
  "estimatedComplexity": "simple" | "moderate" | "complex",
  "canHandleAlone": boolean,
  "suggestedPartnerTypes": ["types of agents that could help"],
  "analysis": "brief analysis of the task"
}

Guidelines:
- AC is needed when: task requires diverse expertise, benefits from parallel work, needs validation, or exceeds single agent capacity
- AC is NOT needed when: task is straightforward, agent has all capabilities, or collaboration overhead outweighs benefits
- Consider task priority, complexity, and time constraints`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          needsAC: parsed.needsAC ?? false,
          reason: parsed.reason ?? 'LLM analysis completed',
          confidence: parsed.confidence ?? 0.7,
          estimatedComplexity: parsed.estimatedComplexity ?? 'moderate',
          canHandleAlone: parsed.canHandleAlone ?? true,
          missingCapabilities: [],
          suggestedPartnerTypes: parsed.suggestedPartnerTypes,
        };
      }
    } catch (error) {
      logger.error('LLM analysis failed:', error);
    }

    // Fallback to capability analysis
    return this.analyzeCapabilities(task, agentContext);
  }

  /**
   * Build the analysis prompt for LLM
   */
  private buildAnalysisPrompt(task: TaskInfo, agentContext: ACAgentContext): string {
    return `
Task Analysis Request:

TASK:
- Title: ${task.title}
- Description: ${task.description}
- Priority: ${task.priority}
- Type: ${task.type || 'general'}
- Required Capabilities: ${task.requiredCapabilities?.join(', ') || 'not specified'}
- Deadline: ${task.deadline?.toISOString() || 'not specified'}

AGENT:
- Name: ${agentContext.agentName}
- Capabilities: ${agentContext.capabilities.join(', ')}
- Current Workload: ${agentContext.currentWorkload} active tasks
- Profile Role: ${agentContext.profile.role}
- Profile Traits: proactivity=${agentContext.profile.traits?.proactivity}, socialPreference=${agentContext.profile.traits?.socialPreference}

Analyze whether this task requires Active Collaboration (AC).
Consider:
1. Does the task complexity justify multiple agents?
2. Does the agent have the necessary capabilities?
3. Would collaboration improve quality or speed?
4. Is the task suitable for the agent's traits?
`;
  }

  /**
   * Estimate task complexity based on available information
   */
  private estimateComplexity(task: TaskInfo): 'simple' | 'moderate' | 'complex' {
    let score = 0;

    // Priority contributes to complexity
    if (task.priority === 'urgent') score += 2;
    else if (task.priority === 'high') score += 1;

    // Required capabilities add complexity
    score += (task.requiredCapabilities?.length || 0) * 0.5;

    // Description length as proxy for complexity
    if (task.description.length > 500) score += 1;
    if (task.description.length > 1000) score += 1;

    // Deadline pressure
    if (task.deadline) {
      const timeUntilDeadline = task.deadline.getTime() - Date.now();
      if (timeUntilDeadline < 3600000) score += 2; // Less than 1 hour
      else if (timeUntilDeadline < 86400000) score += 1; // Less than 1 day
    }

    if (score >= 4) return 'complex';
    if (score >= 2) return 'moderate';
    return 'simple';
  }

  /**
   * Infer partner types from missing capabilities
   */
  private inferPartnerTypes(missingCapabilities: string[]): string[] {
    const partnerTypeMap: Record<string, string[]> = {
      'temperature': ['environment-monitor', 'hvac-controller'],
      'hvac': ['hvac-controller', 'climate-optimizer'],
      'security': ['security-guard', 'access-controller'],
      'motion': ['security-guard', 'occupancy-tracker'],
      'energy': ['energy-optimizer', 'power-manager'],
      'lighting': ['lighting-controller', 'ambiance-manager'],
      'data': ['data-analyst', 'report-generator'],
      'coordination': ['coordinator', 'orchestrator'],
    };

    const types = new Set<string>();
    for (const cap of missingCapabilities) {
      const lowerCap = cap.toLowerCase();
      for (const [key, values] of Object.entries(partnerTypeMap)) {
        if (lowerCap.includes(key)) {
          values.forEach((v) => types.add(v));
        }
      }
    }

    return Array.from(types);
  }

  /**
   * Clear the analysis cache
   */
  clearCache(): void {
    this.analysisCache.clear();
  }
}
