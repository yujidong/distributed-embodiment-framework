/**
 * LLM Plan Synthesizer (P4-3) — the model AUTHORS a WorkflowPlan.
 *
 * Given a natural-language goal and a context snapshot (agents with their
 * capabilities, optional zones and recent environment state), prompt the
 * model to author a WorkflowPlan as JSON. Constrained decoding is requested
 * via ChatParams.format = PLAN_JSON_SCHEMA (providers that ignore `format`
 * are handled by the same validate-and-repair loop).
 *
 * Repair loop: the authored plan is statically validated (validatePlan —
 * shape, DAG semantics, capability satisfiability against the SAME agent
 * set shown in the prompt). On failure the issues are fed back to the model
 * for ONE repair attempt. A second failure gives up: no plan is returned and
 * the issues explain why. This function NEVER throws — LLM/parse faults
 * surface as issues.
 *
 * Provenance: whatever the model emits, the framework stamps
 * metadata = { author: 'llm', model, createdAt } itself — authorship claims
 * in model output are not trusted.
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { createLogger } from '@active-collaboration/shared';
import { untrustedBlock, untrustedJsonBlock } from '../security/prompt-sanitizer.js';
import {
  PLAN_JSON_SCHEMA,
  type PlanIssue,
  type WorkflowPlan,
} from './plan-schema.js';
import { validatePlan, type CapabilityIndex } from './plan-validator.js';

const logger = createLogger('PlanSynthesizer');

// ============================================================================
// Types
// ============================================================================

/** Agent capability snapshot shown to the model and used for validation. */
export interface PlanSynthesisAgent {
  agentId: string;
  capabilities: string[];
}

export interface PlanSynthesisContext {
  /** Agents (with capabilities) the plan may assign nodes to. */
  agents: PlanSynthesisAgent[];
  /** Optional zone ids for spatial grounding of conditions/params. */
  zones?: string[];
  /** Optional recent environment state (flat or nested) for condition authoring. */
  recentEnvState?: Record<string, unknown>;
}

export interface PlanSynthesisResult {
  /** The authored, statically-valid plan; undefined when synthesis gave up. */
  plan?: WorkflowPlan;
  /** Issues from the LAST validation pass (empty on first-try success). */
  issues: PlanIssue[];
  /** Number of LLM calls made (1 = first try, 2 = after one repair). */
  attempts: number;
  /** Raw model responses (trajectory/debugging). */
  rawResponses: string[];
  /** nodeId → agentId assignments from the successful validation pass. */
  assignments?: Map<string, string>;
}

/** Minimal structural view of the LLM client this module needs. */
type ChatClient = Pick<LLMClient, 'quickChat'> & { getModel?: () => string };

// ============================================================================
// Prompt construction
// ============================================================================

const SYSTEM_PROMPT = `You are a workflow planner for an IoT multi-agent system.
You AUTHOR a coordination workflow as JSON; the framework statically validates it and a deterministic executor runs it.

Rules:
- Output a single JSON object matching the WorkflowPlan schema and nothing else (no markdown, no prose).
- Each node needs a unique id and a capability from the AVAILABLE capabilities listed below — do not invent capabilities.
- Use dependsOn for ordering (the plan is a DAG — no cycles).
- Optional condition: "<path> <op> <literal>" with op in ==, !=, >, <, >=, <=, evaluated against the environment snapshot (e.g. "zone.temperature > 30").
- Optional onFail: { policy: 'abort' | 'retry' | 'compensate', retries?: number, compensateNodeId?: string }. A compensate node is itself a plan node referenced by compensateNodeId.
- Prefer 2-6 nodes. Assign nodes to agents only via assigneeAgentId when a specific agent is required; otherwise leave it to the validator.`;

function buildUserPrompt(goal: string, context: PlanSynthesisContext): string {
  // S1: the goal derives from event/task narratives and the env state may
  // carry event payload values — tenant-authored text rides the canonical
  // untrusted-block sanitizer, never raw.
  const agentLines = context.agents
    .map(a => `  - ${a.agentId}: [${a.capabilities.join(', ')}]`)
    .join('\n');
  const zonesLine = context.zones?.length ? `\nZONES: ${untrustedBlock('zones', context.zones.join(', '))}` : '';
  const envLine = context.recentEnvState && Object.keys(context.recentEnvState).length > 0
    ? `\nRECENT_ENV_STATE: ${untrustedJsonBlock('recent-env-state', context.recentEnvState)}`
    : '';

  return `GOAL: ${untrustedBlock('goal', goal)}

AVAILABLE_AGENTS (agentId: capabilities):
${agentLines || '  (none)'}${zonesLine}${envLine}

Author the WorkflowPlan JSON now. Use plan id 'plan-${uuidv4()}', metadata.author 'llm', metadata.createdAt '${new Date().toISOString()}'.`;
}

function buildRepairPrompt(
  goal: string,
  context: PlanSynthesisContext,
  previousResponse: string,
  issues: PlanIssue[],
): string {
  const issueLines = issues
    .map(i => `  - [${i.level}]${i.nodeId ? ` node '${i.nodeId}':` : ''} ${i.message}`)
    .join('\n');

  return `${buildUserPrompt(goal, context)}

Your previous plan FAILED static validation:
${issueLines}

Previous response:
${previousResponse.substring(0, 2000)}

Fix ALL errors and output the corrected WorkflowPlan JSON only.`;
}

// ============================================================================
// Response parsing (mirrors ACNecessityAssessor's extractJSON tolerance)
// ============================================================================

/** Extract a JSON object from a model response (handles markdown fences). */
function extractJSON(content: string): string {
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return content.substring(firstBrace, lastBrace + 1);
  }
  return content.trim();
}

// ============================================================================
// synthesizePlan
// ============================================================================

/**
 * Author a WorkflowPlan for a goal via the LLM, with one repair attempt.
 * NEVER throws.
 */
export async function synthesizePlan(
  goal: string,
  context: PlanSynthesisContext,
  llmClient: ChatClient,
): Promise<PlanSynthesisResult> {
  const rawResponses: string[] = [];
  const capabilityIndex: CapabilityIndex = new Map(
    context.agents.map(a => [a.agentId, a.capabilities]),
  );

  let prompt = buildUserPrompt(goal, context);
  let attempts = 0;
  let lastIssues: PlanIssue[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;

    let responseText: string;
    try {
      const response = await llmClient.quickChat(prompt, SYSTEM_PROMPT, undefined, PLAN_JSON_SCHEMA);
      responseText = typeof response === 'string' ? response : response.content;
    } catch (error) {
      lastIssues = [{
        level: 'error',
        message: `LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
      }];
      logger.warn(`synthesizePlan attempt ${attempt}: LLM call failed:`, lastIssues[0].message);
      // A transport failure is not repairable by feedback — give up now.
      break;
    }

    rawResponses.push(responseText);

    // Parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJSON(responseText));
    } catch (error) {
      lastIssues = [{
        level: 'error',
        message: `response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }];
      logger.warn(`synthesizePlan attempt ${attempt}: JSON parse failed`);
      prompt = buildRepairPrompt(goal, context, responseText, lastIssues);
      continue;
    }

    // Framework stamps provenance — model claims are not trusted.
    if (parsed !== null && typeof parsed === 'object') {
      const candidate = parsed as Record<string, unknown>;
      candidate.metadata = {
        author: 'llm',
        ...(typeof llmClient.getModel === 'function' ? { model: llmClient.getModel() } : {}),
        createdAt: new Date().toISOString(),
      };
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
        candidate.id = `plan-${uuidv4()}`;
      }
    }

    // Static validation (shape + DAG + satisfiability + conditions).
    const validation = validatePlan(parsed, capabilityIndex);
    if (validation.valid) {
      logger.info(`synthesizePlan: valid plan authored on attempt ${attempt} (${(parsed as WorkflowPlan).nodes.length} nodes)`);
      return {
        plan: parsed as WorkflowPlan,
        issues: validation.issues.filter(i => i.level === 'warning'),
        attempts,
        rawResponses,
        assignments: validation.assignments,
      };
    }

    lastIssues = validation.issues;
    logger.warn(`synthesizePlan attempt ${attempt}: validation failed with ${lastIssues.filter(i => i.level === 'error').length} errors`);
    prompt = buildRepairPrompt(goal, context, responseText, lastIssues);
  }

  logger.warn(`synthesizePlan: giving up after ${attempts} attempt(s)`);
  return { issues: lastIssues, attempts, rawResponses };
}
