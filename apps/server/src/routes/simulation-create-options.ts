/**
 * Simulation routes — create/parsing helpers (extraction, R101 arch-guard
 * size ceiling; the R21-W1 service-layer pattern applied to the route
 * tail). Pure request-shaping: sim-create `options` validation, triage
 * option validation, and the trajectory/query helper functions. No route
 * state, no IO — behavior verbatim from routes/simulations.ts.
 */

import { ApiError } from '../errors.js';
import {
  LLM_PRESETS,
  type CreateSimulationOptions,
} from '../simulation-registry.js';

export function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * T-005: guidance attached to an EMPTY /trajectory response. Rule-only sims
 * record no agent decisions, which used to look like "nothing happened" —
 * point the caller at the sim-side timeline endpoint where the physical
 * record of the run lives.
 */
export function emptyTrajectoryNote(simId: string): string {
  return 'No trajectory records for this simulation (rule-only sims record no agent decisions) — ' +
    `the sim-side timeline (zone samples + device state changes) is at GET /api/simulations/${simId}/timeline`;
}

export function parseCreateOptions(raw: unknown): CreateSimulationOptions {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "options" must be an object');
  }
  const input = raw as Record<string, unknown>;
  const options: CreateSimulationOptions = {};

  if (input.llmClient !== undefined) {
    if (typeof input.llmClient !== 'string' || !LLM_PRESETS.includes(input.llmClient as never)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `options.llmClient must be one of ${LLM_PRESETS.map(p => `"${p}"`).join(' | ')}, ` +
        `got ${JSON.stringify(input.llmClient)}`,
      );
    }
    options.llmClient = input.llmClient as CreateSimulationOptions['llmClient'];
  }
  if (input.llmModel !== undefined) {
    if (typeof input.llmModel !== 'string' || input.llmModel.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'options.llmModel must be a non-empty string');
    }
    options.llmModel = input.llmModel;
  }
  if (input.llmSystemPrompt !== undefined) {
    if (typeof input.llmSystemPrompt !== 'string' || input.llmSystemPrompt.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'options.llmSystemPrompt must be a non-empty string');
    }
    options.llmSystemPrompt = input.llmSystemPrompt;
  }
  // Wave A2: AC mode for A/B comparison demos.
  if (input.acMode !== undefined) {
    if (typeof input.acMode !== 'string' || !['enabled', 'disabled', 'shadow'].includes(input.acMode)) {
      throw new ApiError(400, 'BAD_REQUEST', 'options.acMode must be "enabled" | "disabled" | "shadow"');
    }
    options.acMode = input.acMode as CreateSimulationOptions['acMode'];
  }
  // T-051: sim-level actuation toggle (false = decision-only runs). The
  // per-agent precedence (this option > agents[].decisionPolicy > default
  // true) resolves inside the runtime.
  if (input.autoActuateIndependent !== undefined) {
    if (typeof input.autoActuateIndependent !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', `options.autoActuateIndependent must be a boolean, got ${JSON.stringify(input.autoActuateIndependent)}`);
    }
    options.autoActuateIndependent = input.autoActuateIndependent;
  }
  if (input.trajectoryDir !== undefined) {
    if (typeof input.trajectoryDir !== 'string' || input.trajectoryDir.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'options.trajectoryDir must be a non-empty string');
    }
    options.trajectoryDir = input.trajectoryDir;
  }
  if (input.tickMs !== undefined) {
    if (typeof input.tickMs !== 'number' || !Number.isFinite(input.tickMs) || input.tickMs <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', `options.tickMs must be a number > 0, got ${JSON.stringify(input.tickMs)}`);
    }
    options.tickMs = input.tickMs;
  }
  // Living-worlds P1: advancement scheduling — 'tick' (default, the
  // historical fixed-interval timer) | 'lazy' (due-moment driven; design
  // §8). Lazy sims evolve bit-identically to tick runs (advanceTo) while
  // doing no engine work between due moments.
  if (input.scheduling !== undefined) {
    if (
      typeof input.scheduling !== 'string' ||
      !['tick', 'lazy'].includes(input.scheduling)
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `options.scheduling must be "tick" | "lazy", got ${JSON.stringify(input.scheduling)} ` +
          '("tick" = fixed-interval timer, the default; "lazy" = due-moment driven advancement)',
      );
    }
    options.scheduling = input.scheduling as CreateSimulationOptions['scheduling'];
  }
  if (input.triage !== undefined) {
    options.triage = parseTriageOption(input.triage);
  }

  // TASK-004 (DevLoop): reject unknown option keys instead of silently
  // dropping them — the Explorer's "I asked for speed:10 and got speed:1"
  // finding. List what IS accepted so the caller can self-correct.
  const known = new Set(['llmClient', 'llmModel', 'llmSystemPrompt', 'acMode', 'autoActuateIndependent', 'trajectoryDir', 'tickMs', 'scheduling', 'triage']);
  const unknown = Object.keys(input).filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Unknown options field${unknown.length > 1 ? 's' : ''}: ${unknown.map(k => `"${k}"`).join(', ')}. ` +
        `Accepted: ${[...known].map(k => `"${k}"`).join(', ')}. ` +
        'Note: speed is set at start time (POST /api/simulations/:id/start {speed}), not in options.',
    );
  }
  return options;
}

/** Validate options.triage (P4-2 small-model triage). */
export function parseTriageOption(raw: unknown): CreateSimulationOptions['triage'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'options.triage must be an object');
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', 'options.triage.enabled must be a boolean');
  }
  const triage: NonNullable<CreateSimulationOptions['triage']> = { enabled: input.enabled };
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'options.triage.model must be a non-empty string');
    }
    triage.model = input.model;
  }
  if (input.mode !== undefined) {
    if (input.mode !== 'shadow' && input.mode !== 'enforce') {
      throw new ApiError(400, 'BAD_REQUEST', `options.triage.mode must be "shadow" | "enforce", got ${JSON.stringify(input.mode)}`);
    }
    triage.mode = input.mode;
  }
  if (input.trustIndependent !== undefined) {
    if (typeof input.trustIndependent !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', 'options.triage.trustIndependent must be a boolean');
    }
    triage.trustIndependent = input.trustIndependent;
  }
  return triage;
}
