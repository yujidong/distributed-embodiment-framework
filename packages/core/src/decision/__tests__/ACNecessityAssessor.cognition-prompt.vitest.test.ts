/**
 * Phase 2 — world-model projection in the decision prompt (§3/§4.1).
 *
 * Pins:
 *   1. LEGACY BYTE-IDENTITY: without `agentContext.cognition` the prompt
 *      contains no SITUATION/RECENT_EVENTS/PREVIOUS_DECISION/WORLD_CONTEXT
 *      section at all (agents on the legacy path see the pre-Phase-2
 *      prompt — determinism by default).
 *   2. With cognition attached, the prompt renders the pre-computed
 *      SITUATION hint, the bounded RECENT_EVENTS digest and the
 *      PREVIOUS_DECISION (+outcome) from working memory — inside the S1
 *      untrusted block (tenant-authored world data, never instructions).
 *   3. Determinism: identical cognition context → identical prompt bytes
 *      (prompt-cache collision = semantic collision).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';
import { assessSituation } from '../../cognition/situation-assessment.js';
import { buildAgentWorldModel } from '../../cognition/world-model-builder.js';
import { WorkingMemoryStore } from '../../cognition/working-memory.js';
import type { AgentCognitionContext } from '../../cognition/prompt-context.js';

const collabAnswer = JSON.stringify({ decision: 'collaborate', reasoning: 'partner needed' });

describe('Phase 2: world-model projection in the assessor prompt', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  const cluster = (): SpatialClusterSummary => ({
    clusterId: 'c1',
    region: { id: 'floor-1', center: { x: 0, y: 0 }, radius: 5, type: 'zone' },
    timeWindow: 'w',
    significance: 'medium',
    summary: 'temperature rising in floor-1',
    findings: [{
      eventType: 'temperature-spike',
      count: 1,
      trend: 'rising',
      anomaly: true,
      details: { requiredCapabilities: ['cooling'] },
    }],
    recommendation: 'evaluate_with_llm',
  });

  const ctx = (overrides: Partial<AgentContext> = {}): AgentContext => ({
    agentId: 'thermal-ops-1',
    agentName: 'ThermalOps',
    // access-control does NOT match the event's declared 'cooling' need
    // (the synonym-aware matcher links temperature-control↔cooling), so the
    // Type-A precheck finds a capability GAP and the decision reaches the
    // LLM lane where the prompt is observable.
    capabilities: ['access-control'],
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['floor-1'], // direct coverage + capability gap → LLM path
    ...overrides,
  });

  const promptFor = async (agentCtx: AgentContext): Promise<string> => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(collabAnswer);
    await assessor.assess(cluster(), agentCtx);
    expect(mockLLMClient.quickChat).toHaveBeenCalled();
    return (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
  };

  const cognition = (): { cognition: AgentCognitionContext; store: WorkingMemoryStore } => {
    const worldModel = buildAgentWorldModel({
      agentId: 'thermal-ops-1',
      capabilities: ['temperature-control'],
      devices: [{
        deviceId: 'hvac-101', type: 'hvac', zoneId: 'floor-1',
        state: { power: 'on' }, commands: ['set-temperature'],
      }],
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 31.5 }, adjacentZoneIds: ['floor-2'] }],
      goalStack: [{ goal: 'maintain_comfort', priority: 2 }],
      events: [
        { type: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', value: 30.5, simTimeSec: 43100 },
        { type: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', value: 31.5, simTimeSec: 43210 },
      ],
      simTimeSec: 43210,
    });
    const store = new WorkingMemoryStore();
    store.beginRound(buildAgentWorldModel({
      agentId: 'thermal-ops-1', capabilities: [], devices: [], zones: [], simTimeSec: 43100,
    }));
    store.recordDecision({ action: 'handle_independently', outcome: 'acted', atSimTimeSec: 43100 });
    const workingMemory = store.beginRound(worldModel);
    return { cognition: { worldModel, situation: assessSituation(worldModel), workingMemory }, store };
  };

  it('legacy path: no cognition attached → prompt has NO world-context section (byte-identical)', async () => {
    const prompt = await promptFor(ctx());
    expect(prompt).not.toContain('SITUATION:');
    expect(prompt).not.toContain('RECENT_EVENTS');
    expect(prompt).not.toContain('PREVIOUS_DECISION');
    expect(prompt).not.toContain('WORLD_CONTEXT');
  });

  it('cognition attached → SITUATION renders the pre-computed type/severity and evidence', async () => {
    const { cognition: cog } = cognition();
    expect(cog.situation.type).toBe('anomaly'); // sanity: 31.5 outside 18-28
    const prompt = await promptFor(ctx({ cognition: cog }));

    expect(prompt).toContain('WORLD_CONTEXT');
    expect(prompt).toMatch(/SITUATION: anomaly severity=3\/5 zones=\[floor-1\]/);
    expect(prompt).toContain('floor-1.temperature=31.5 outside expected [18, 28]');
  });

  it('cognition attached → RECENT_EVENTS renders the bounded digest with sim times', async () => {
    const { cognition: cog } = cognition();
    const prompt = await promptFor(ctx({ cognition: cog }));

    expect(prompt).toContain('RECENT_EVENTS (2):');
    expect(prompt).toContain('t=43100 temperature-spike zone=floor-1 param=temperature value=30.5');
    expect(prompt).toContain('t=43210 temperature-spike zone=floor-1 param=temperature value=31.5');
  });

  it('non-empty diff → CHANGES_SINCE_LAST_ROUND renders the working-memory diff line', async () => {
    const { cognition: cog } = cognition();
    // The helper's second round introduces zone floor-1 against an empty
    // previous model → one "now visible" change line.
    expect(cog.workingMemory!.situationChanges.length).toBeGreaterThan(0);
    const prompt = await promptFor(ctx({ cognition: cog }));

    expect(prompt).toContain('CHANGES_SINCE_LAST_ROUND: zone floor-1: now visible');
  });

  it('parameter delta renders as zone.param: a → b, comma-joined and capped', async () => {
    // Two consecutive real rounds: first sees temp 22, second sees 25.5 and
    // a new humidity param — the diff line must carry both entries.
    const base = { agentId: 'a', capabilities: [], devices: [] };
    const store = new WorkingMemoryStore();
    store.beginRound(buildAgentWorldModel({
      ...base,
      zones: [{ zoneId: 'living', parameters: { temperature: 22 }, adjacentZoneIds: [] }],
      simTimeSec: 100,
    }));
    const worldModel = buildAgentWorldModel({
      ...base,
      zones: [{ zoneId: 'living', parameters: { temperature: 25.5, humidity: 60 }, adjacentZoneIds: [] }],
      simTimeSec: 110,
    });
    const workingMemory = store.beginRound(worldModel);
    expect(workingMemory.situationChanges).toEqual([
      'zone living.temperature: 22 → 25.5',
      'zone living.humidity=60 (new)',
    ]);

    const prompt = await promptFor(ctx({
      cognition: { worldModel, situation: assessSituation(worldModel), workingMemory },
    }));
    expect(prompt).toContain(
      'CHANGES_SINCE_LAST_ROUND: zone living.temperature: 22 → 25.5, zone living.humidity=60 (new)',
    );
  });

  it('empty diff → no CHANGES_SINCE_LAST_ROUND line (legacy prompt bytes preserved)', async () => {
    // Identical consecutive rounds → situationChanges = [] → the line is
    // absent, exactly like the pre-C2 prompt.
    const base = { agentId: 'a', capabilities: [], devices: [] };
    const zones = [{ zoneId: 'z', parameters: { temperature: 22 }, adjacentZoneIds: [] }];
    const store = new WorkingMemoryStore();
    store.beginRound(buildAgentWorldModel({ ...base, zones, simTimeSec: 100 }));
    const worldModel = buildAgentWorldModel({ ...base, zones, simTimeSec: 110 });
    const workingMemory = store.beginRound(worldModel);
    expect(workingMemory.situationChanges).toEqual([]);

    const prompt = await promptFor(ctx({
      cognition: { worldModel, situation: assessSituation(worldModel), workingMemory },
    }));
    expect(prompt).not.toContain('CHANGES_SINCE_LAST_ROUND');
  });

  it('cognition attached → PREVIOUS_DECISION renders action → outcome from working memory', async () => {
    const { cognition: cog } = cognition();
    const prompt = await promptFor(ctx({ cognition: cog }));
    expect(prompt).toContain('PREVIOUS_DECISION: handle_independently → acted (at t=43100s)');
  });

  it('first cognitive round → PREVIOUS_DECISION: none (first cognitive round)', async () => {
    const worldModel = buildAgentWorldModel({
      agentId: 'a', capabilities: [], devices: [], zones: [], simTimeSec: 1,
    });
    const store = new WorkingMemoryStore();
    const prompt = await promptFor(ctx({
      cognition: { worldModel, situation: assessSituation(worldModel), workingMemory: store.beginRound(worldModel) },
    }));
    expect(prompt).toContain('PREVIOUS_DECISION: none (first cognitive round)');
  });

  it('normal situation renders the explicit no-anomaly sentence', async () => {
    const worldModel = buildAgentWorldModel({
      agentId: 'a', capabilities: [], devices: [],
      zones: [{ zoneId: 'z', parameters: { temperature: 22 }, adjacentZoneIds: [] }],
      simTimeSec: 1,
    });
    const prompt = await promptFor(ctx({
      cognition: { worldModel, situation: assessSituation(worldModel) },
    }));
    expect(prompt).toContain('SITUATION: normal severity=1/5 — no out-of-range parameters, faults or alarm events detected');
    expect(prompt).toContain('RECENT_EVENTS (0): none');
  });

  it('world context rides the S1 untrusted block (world data ≠ instructions)', async () => {
    const { cognition: cog } = cognition();
    const prompt = await promptFor(ctx({ cognition: cog }));
    const start = prompt.indexOf('WORLD_CONTEXT');
    const block = prompt.slice(start, prompt.indexOf('</untrusted>', start) + '</untrusted>'.length);
    expect(block).toContain('<untrusted name="world-context"');
    expect(block).toContain('SITUATION: anomaly');
  });

  it('deterministic: identical cognition context → identical prompt bytes', async () => {
    const first = await promptFor(ctx({ cognition: cognition().cognition }));
    const second = await promptFor(ctx({ cognition: cognition().cognition }));
    expect(first).toBe(second);
  });
});
