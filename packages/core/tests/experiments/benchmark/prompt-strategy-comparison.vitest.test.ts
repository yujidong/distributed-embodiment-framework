/**
 * Prompt Strategy Comparison Experiment (RQ1.1)
 *
 * Research Question: How do different prompt engineering strategies affect
 * service composition quality and success rate?
 *
 * Hypothesis: Structured prompts with explicit capability mapping and QoS tiering
 * achieve higher success rates than simple prompt designs.
 *
 * Paper Section: Evaluation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import {
  TimeManager,
  PhysicalEnvironment,
  DeviceFactory,
  type SimulatedDevice,
} from '@active-collaboration/simulation';
import { CognitiveAgent } from '../../../src/agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../../src/environment/EnvironmentCenter.js';
import { AgentProfileFactory } from '../../../src/goal/index.js';
import { LLM_CONFIG, TIMEOUT_CONFIG, TEST_LOCATIONS, INITIAL_VALUES, generateWithLLM } from '../../utils/index.js';

/**
 * Prompt Strategy Definitions
 */
enum PromptStrategy {
  BASELINE = 'baseline',
  CAPABILITY_ANNOTATED = 'capability-annotated',
  QOS_TIERED = 'qos-tiered',
  ONTOLOGY_ENHANCED = 'ontology-enhanced',
  FEW_SHOT = 'few-shot',
}

interface PromptStrategyResult {
  strategy: PromptStrategy;
  successRate: number;
  parsingSuccessRate: number;
  avgCompositionTime: number;
  semanticMatchScore: number;
  capabilityCoverage: number;
  tasksTotal: number;
  tasksSuccessful: number;
}

/**
 * Task definitions for prompt strategy testing
 */
const PROMPT_STRATEGY_TASKS = [
  {
    id: 'task-temp-control-001',
    description: 'Maintain room temperature at 22 degrees Celsius',
    requiredCapabilities: ['temperature-sensing', 'hvac-control'],
    expectedComplexity: 'simple',
  },
  {
    id: 'task-energy-opt-001',
    description: 'Optimize energy consumption while maintaining comfort',
    requiredCapabilities: ['energy-monitoring', 'hvac-control', 'scheduling'],
    expectedComplexity: 'medium',
  },
  {
    id: 'task-emergency-001',
    description: 'Coordinate emergency response across multiple zones',
    requiredCapabilities: ['alert-system', 'communication', 'coordination', 'location-tracking'],
    expectedComplexity: 'complex',
  },
  {
    id: 'task-cross-domain-001',
    description: 'Integrate HVAC with security system for occupancy-based control',
    requiredCapabilities: ['hvac-control', 'security-monitoring', 'occupancy-sensing'],
    expectedComplexity: 'cross-domain',
  },
  {
    id: 'task-ambiguous-001',
    description: 'Make the environment comfortable for occupants',
    requiredCapabilities: [], // Ambiguous - requires semantic inference
    expectedComplexity: 'ambiguous',
  },
];

/**
 * Prompt templates for each strategy
 */
const PROMPT_TEMPLATES = {
  [PromptStrategy.BASELINE]: `
You are an IoT agent. Complete the following task:
Task: {{taskDescription}}
Available devices: {{deviceList}}
Respond with the actions to take.
`,

  [PromptStrategy.CAPABILITY_ANNOTATED]: `
You are an IoT agent with the following capabilities:
{{capabilityList}}

Task: {{taskDescription}}

Available devices with their capabilities:
{{deviceCapabilityMap}}

Analyze the task and determine which devices to use.
Respond in JSON format with your action plan.
`,

  [PromptStrategy.QOS_TIERED]: `
You are an IoT agent managing a smart environment.

=== DEVICE QUALITY TIERS ===
EXCELLENT (Primary): {{excellentDevices}}
GOOD (Secondary): {{goodDevices}}
FAIR (Backup): {{fairDevices}}

=== TASK ===
{{taskDescription}}

=== INSTRUCTIONS ===
1. Prefer EXCELLENT tier devices when available
2. Fall back to GOOD tier if EXCELLENT unavailable
3. Use FAIR tier only as last resort
4. Respond in JSON format with device selections and reasoning
`,

  [PromptStrategy.ONTOLOGY_ENHANCED]: `
You are an IoT agent operating under SAREF ontology.

=== ONTOLOGY RULES ===
- TemperatureSensor subclassOf Sensor
- HVACController subclassOf Actuator
- ComfortRequirement equivalentTo (TemperatureRequirement and HumidityRequirement)
- EnergyOptimization subclassOf Goal

=== SEMANTIC RELATIONSHIPS ===
{{semanticRelationships}}

=== TASK ===
{{taskDescription}}

=== AVAILABLE RESOURCES ===
{{resourceList}}

Apply semantic reasoning to complete the task.
Respond in JSON format.
`,

  [PromptStrategy.FEW_SHOT]: `
You are an IoT agent. Here are examples of successful task completions:

=== EXAMPLE 1 ===
Task: "Reduce temperature to 20 degrees"
Response: {
  "analysis": "Temperature adjustment required",
  "selectedDevice": "hvac-controller-001",
  "action": "setTargetTemperature",
  "parameters": {"targetTemperature": 20}
}

=== EXAMPLE 2 ===
Task: "Alert security team about motion detection"
Response: {
  "analysis": "Security alert needed",
  "selectedDevices": ["motion-sensor-001", "alert-system-001"],
  "action": "triggerAlert",
  "parameters": {"severity": "high", "recipients": ["security-team"]}
}

=== NOW COMPLETE THIS TASK ===
{{taskDescription}}

Available devices: {{deviceList}}
Respond in the same JSON format as the examples.
`,
};

// Shared test resources
let sharedLLMClient: LLMClient;
let selectedModel: string;

describe('Prompt Strategy Comparison Experiment (RQ1.1)', () => {
  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ1.1] Prompt Strategy Comparison Experiment');
    console.log('========================================\n');

    const initResult = await initializeLLM({
      preferredModels: LLM_CONFIG.preferredModels,
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    selectedModel = initResult.selectedModel;
    sharedLLMClient = new LLMClient('ollama', { model: selectedModel });

    console.log(`[RQ1.1] Using model: ${selectedModel}`);
  }, TIMEOUT_CONFIG.testTimeout);

  describe('Strategy Comparison', () => {
    const results: PromptStrategyResult[] = [];

    Object.values(PromptStrategy).forEach((strategy) => {
      it(`should test ${strategy} prompt strategy`, async () => {
        console.log(`\n[RQ1.1] Testing strategy: ${strategy}`);

        const strategyResult = await testPromptStrategy(strategy);
        results.push(strategyResult);

        console.log(`[RQ1.1] ${strategy} results:`);
        console.log(`  - Success Rate: ${(strategyResult.successRate * 100).toFixed(1)}%`);
        console.log(`  - Parsing Success: ${(strategyResult.parsingSuccessRate * 100).toFixed(1)}%`);
        console.log(`  - Avg Composition Time: ${strategyResult.avgCompositionTime.toFixed(0)}ms`);
        console.log(`  - Semantic Match Score: ${strategyResult.semanticMatchScore.toFixed(2)}`);
        console.log(`  - Capability Coverage: ${(strategyResult.capabilityCoverage * 100).toFixed(1)}%`);

        // Basic assertions
        expect(strategyResult.successRate).toBeGreaterThanOrEqual(0);
        expect(strategyResult.parsingSuccessRate).toBeGreaterThanOrEqual(0);
      }, TIMEOUT_CONFIG.testTimeout);
    });

    afterAll(() => {
      console.log('\n========================================');
      console.log('[RQ1.1] Prompt Strategy Comparison Summary');
      console.log('========================================\n');

      // Sort by success rate
      const sorted = [...results].sort((a, b) => b.successRate - a.successRate);

      console.log('| Strategy | Success Rate | Parsing | Time (ms) | Semantic | Coverage |');
      console.log('|----------|--------------|---------|-----------|----------|----------|');
      sorted.forEach((r) => {
        console.log(
          `| ${r.strategy.padEnd(20)} | ` +
          `${(r.successRate * 100).toFixed(1).padStart(6)}% | ` +
          `${(r.parsingSuccessRate * 100).toFixed(1).padStart(5)}% | ` +
          `${r.avgCompositionTime.toFixed(0).padStart(9)} | ` +
          `${r.semanticMatchScore.toFixed(2).padStart(8)} | ` +
          `${(r.capabilityCoverage * 100).toFixed(1).padStart(7)}% |`
        );
      });

      // Identify best strategy
      const best = sorted[0];
      console.log(`\n✅ Best Strategy: ${best.strategy} (${(best.successRate * 100).toFixed(1)}% success rate)`);

      // Calculate improvement over baseline
      const baseline = results.find((r) => r.strategy === PromptStrategy.BASELINE);
      if (baseline && best.strategy !== PromptStrategy.BASELINE) {
        const improvement = ((best.successRate - baseline.successRate) * 100).toFixed(1);
        console.log(`📈 Improvement over Baseline: +${improvement}pp`);
      }
    });
  });
});

/**
 * Test a specific prompt strategy
 */
async function testPromptStrategy(strategy: PromptStrategy): Promise<PromptStrategyResult> {
  const tasks = PROMPT_STRATEGY_TASKS;
  let successful = 0;
  let parsingSuccess = 0;
  let totalTime = 0;
  let semanticScore = 0;
  let capabilityCoverage = 0;

  for (const task of tasks) {
    const startTime = Date.now();

    try {
      // Create test environment
      const env = createTestEnvironment();
      const agent = createTestAgent(env.envCenter, strategy);

      // Generate prompt based on strategy
      const prompt = generatePrompt(strategy, task, agent);

      // Execute LLM call
      const response = await generateWithLLM(sharedLLMClient, prompt, {
        temperature: 0.3,
        maxTokens: 1000,
      });

      const elapsed = Date.now() - startTime;
      totalTime += elapsed;

      // Parse response
      const parseResult = parseResponse(response.content);
      if (parseResult.success) {
        parsingSuccess++;

        // Evaluate semantic match
        const semantic = evaluateSemanticMatch(parseResult.actions, task);
        semanticScore += semantic.score;

        // Evaluate capability coverage
        const coverage = evaluateCapabilityCoverage(parseResult.actions, task.requiredCapabilities);
        capabilityCoverage += coverage;

        // Determine overall success
        if (semantic.score >= 0.7 && coverage >= 0.7) {
          successful++;
        }
      }

      // Cleanup
      env.envCenter.stopPhysicsSimulation?.();

    } catch (error) {
      console.error(`[RQ1.1] Error testing ${strategy} on ${task.id}:`, error);
    }
  }

  return {
    strategy,
    successRate: successful / tasks.length,
    parsingSuccessRate: parsingSuccess / tasks.length,
    avgCompositionTime: totalTime / tasks.length,
    semanticMatchScore: semanticScore / tasks.length,
    capabilityCoverage: capabilityCoverage / tasks.length,
    tasksTotal: tasks.length,
    tasksSuccessful: successful,
  };
}

/**
 * Create test environment
 */
function createTestEnvironment() {
  const timeManager = new TimeManager({ timeScale: 1 });
  const physicalEnvironment = new PhysicalEnvironment(timeManager, {
    enablePhysics: true,
    physicsConfig: {
      updateInterval: 100,
      propagationSpeed: 0.5,
    },
  });

  const envCenter = new EnvironmentCenter({
    id: `test-env-${Date.now()}`,
    name: 'Prompt Strategy Test Environment',
    createdBy: 'experiment',
    createdAt: new Date(),
    updatedAt: new Date(),
    physicalEnvironment,
  });

  envCenter.startPhysicsSimulation?.();

  return { envCenter, physicalEnvironment, timeManager };
}

/**
 * Create test agent with specific strategy
 */
function createTestAgent(envCenter: EnvironmentCenter, strategy: PromptStrategy): CognitiveAgent {
  const profile = AgentProfileFactory.createBalancedAgent();
  profile.id = `agent-${strategy}-${Date.now()}`;

  const agent = new CognitiveAgent({
    id: profile.id,
    name: `TestAgent-${strategy}`,
    description: `Agent for testing ${strategy} prompt strategy`,
    owner: 'experiment',
    environment: envCenter,
    llmClient: sharedLLMClient,
    agentProfile: profile,
    capabilities: ['temperature-sensing', 'hvac-control', 'energy-monitoring', 'scheduling', 'alert-system', 'communication', 'coordination', 'location-tracking', 'security-monitoring', 'occupancy-sensing'],
  });

  return agent;
}

/**
 * Generate prompt based on strategy
 */
function generatePrompt(
  strategy: PromptStrategy,
  task: typeof PROMPT_STRATEGY_TASKS[0],
  _agent: CognitiveAgent
): string {
  const template = PROMPT_TEMPLATES[strategy];

  // Replace placeholders based on strategy
  let prompt = template;

  prompt = prompt.replace('{{taskDescription}}', task.description);

  // Strategy-specific replacements
  switch (strategy) {
    case PromptStrategy.BASELINE:
      prompt = prompt.replace('{{deviceList}}', getDeviceList());
      break;

    case PromptStrategy.CAPABILITY_ANNOTATED:
      prompt = prompt.replace('{{capabilityList}}', getCapabilityList());
      prompt = prompt.replace('{{deviceCapabilityMap}}', getDeviceCapabilityMap());
      break;

    case PromptStrategy.QOS_TIERED:
      prompt = prompt.replace('{{excellentDevices}}', getDevicesByTier('excellent'));
      prompt = prompt.replace('{{goodDevices}}', getDevicesByTier('good'));
      prompt = prompt.replace('{{fairDevices}}', getDevicesByTier('fair'));
      break;

    case PromptStrategy.ONTOLOGY_ENHANCED:
      prompt = prompt.replace('{{semanticRelationships}}', getSemanticRelationships());
      prompt = prompt.replace('{{resourceList}}', getResourceList());
      break;

    case PromptStrategy.FEW_SHOT:
      prompt = prompt.replace('{{deviceList}}', getDeviceList());
      break;
  }

  return prompt;
}

function getDeviceList(): string {
  return [
    '- Temperature Sensor (living-room-temp)',
    '- HVAC Controller (hvac-main)',
    '- Motion Sensor (motion-entrance)',
    '- Smart Lock (lock-front-door)',
    '- Energy Meter (energy-meter-01)',
  ].join('\n');
}

function getCapabilityList(): string {
  return [
    '- temperature-sensing: Read temperature from sensors',
    '- hvac-control: Control HVAC systems',
    '- motion-detection: Detect motion events',
    '- lock-control: Control smart locks',
    '- energy-monitoring: Monitor energy consumption',
  ].join('\n');
}

function getDeviceCapabilityMap(): string {
  return [
    'living-room-temp: [temperature-sensing]',
    'hvac-main: [hvac-control, temperature-adjustment]',
    'motion-entrance: [motion-detection, occupancy-sensing]',
    'lock-front-door: [lock-control, security-monitoring]',
    'energy-meter-01: [energy-monitoring, consumption-tracking]',
  ].join('\n');
}

function getDevicesByTier(tier: string): string {
  const tiers: Record<string, string[]> = {
    excellent: ['hvac-main (newest, highest efficiency)', 'living-room-temp (calibrated)'],
    good: ['energy-meter-01', 'motion-entrance'],
    fair: ['lock-front-door (older model)'],
  };
  return tiers[tier]?.join(', ') || 'None available';
}

function getSemanticRelationships(): string {
  return [
    '- TemperatureSensor locatedIn LivingRoom',
    '- HVACController controls Climate Of LivingRoom',
    '- ComfortRequirement hasComponent TemperatureRequirement',
    '- EnergyOptimization conflictsWith ComfortMaximization',
  ].join('\n');
}

function getResourceList(): string {
  return [
    '- Resource: living-room-temp (Type: TemperatureSensor, State: active)',
    '- Resource: hvac-main (Type: HVACController, State: idle)',
    '- Resource: energy-meter-01 (Type: EnergyMeter, State: monitoring)',
  ].join('\n');
}

interface ParsedResponse {
  success: boolean;
  actions: Array<{
    device?: string;
    action?: string;
    parameters?: Record<string, any>;
    analysis?: string;
  }>;
  rawResponse: string;
}

function parseResponse(response: string): ParsedResponse {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Normalize to actions array
      const actions = [];
      if (parsed.selectedDevice || parsed.selectedDevices) {
        actions.push({
          device: parsed.selectedDevice || parsed.selectedDevices,
          action: parsed.action,
          parameters: parsed.parameters,
          analysis: parsed.analysis,
        });
      }
      if (Array.isArray(parsed.actions)) {
        actions.push(...parsed.actions);
      }
      if (parsed.steps) {
        actions.push(...parsed.steps);
      }

      return { success: true, actions, rawResponse: response };
    }

    // Try to parse as action list
    const actionPatterns = response.match(/(?:use|select|activate|control|set)\s+(\w+)/gi);
    if (actionPatterns) {
      const actions = actionPatterns.map((p) => ({
        action: p,
      }));
      return { success: true, actions, rawResponse: response };
    }

    return { success: false, actions: [], rawResponse: response };
  } catch {
    return { success: false, actions: [], rawResponse: response };
  }
}

interface SemanticEvaluation {
  score: number;
  reasons: string[];
}

function evaluateSemanticMatch(
  actions: ParsedResponse['actions'],
  task: typeof PROMPT_STRATEGY_TASKS[0]
): SemanticEvaluation {
  const reasons: string[] = [];
  let score = 0;

  // Check if actions relate to task domain
  const taskKeywords = extractKeywords(task.description);
  const actionKeywords = actions.flatMap((a) =>
    extractKeywords(`${a.action || ''} ${a.analysis || ''} ${JSON.stringify(a.parameters || {})}`)
  );

  // Calculate keyword overlap
  const overlap = taskKeywords.filter((k) => actionKeywords.includes(k));
  const overlapRatio = overlap.length / Math.max(taskKeywords.length, 1);
  score += overlapRatio * 0.5;
  if (overlapRatio > 0.3) reasons.push(`Keywords matched: ${overlap.join(', ')}`);

  // Check capability relevance
  if (task.requiredCapabilities.length > 0) {
    const actionText = JSON.stringify(actions).toLowerCase();
    const matchedCaps = task.requiredCapabilities.filter((cap) =>
      actionText.includes(cap.toLowerCase().replace('-', ' '))
    );
    const capRatio = matchedCaps.length / task.requiredCapabilities.length;
    score += capRatio * 0.3;
    if (capRatio > 0.5) reasons.push(`Capabilities addressed: ${matchedCaps.join(', ')}`);
  }

  // Check for structured response
  if (actions.some((a) => a.device && a.action)) {
    score += 0.2;
    reasons.push('Structured action format detected');
  }

  return { score: Math.min(score, 1), reasons };
}

function evaluateCapabilityCoverage(
  actions: ParsedResponse['actions'],
  requiredCapabilities: string[]
): number {
  if (requiredCapabilities.length === 0) {
    // For ambiguous tasks, check if agent made reasonable inferences
    return actions.length > 0 ? 0.8 : 0.2;
  }

  const actionText = JSON.stringify(actions).toLowerCase();
  const covered = requiredCapabilities.filter((cap) =>
    actionText.includes(cap.toLowerCase().replace('-', ' '))
  );

  return covered.length / requiredCapabilities.length;
}

function extractKeywords(text: string): string[] {
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'to', 'for', 'and', 'or', 'with', 'at', 'in', 'on'];
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2 && !stopWords.includes(word));
}
