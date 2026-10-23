/**
 * R32 Lane A — slim AC-necessity hot-path prompt.
 *
 * Capacity-planning §1 measured the real per-event AC decision prompt at
 * 3443 input tokens (vs 608 for the trimmed corpus), dominated by the full
 * AVAILABLE_PARTNERS service list and the 50-zone ID roster. These tests
 * pin the slim prompt contract:
 *
 * A1 — default prompt renders a structured catalog DIGEST (R45-P4): a
 *      one-line per-domain CATALOG stats row plus a TOP-K SHORTLIST by
 *      capability/zone relevance (LLM_PARTNER_TOP_K, default 8), compact
 *      form `name(semanticType@zone)`; zone rosters are counts, not ID
 *      lists; the system preamble stays rule-complete but compressed.
 * A2 — partner summaries are cached per agent and invalidated by the
 *      service-topology signature (publish/unpublish/relocate recomputes).
 * A3 — the decision call caps generation at 256 tokens (~63-token outputs).
 * A4 — the prompt is deterministic for identical semantic inputs (service
 *      registration order must not change it), so the LLM response cache
 *      key — a hash of the actual prompt — collides exactly when the
 *      decision semantics collide.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

const collabAnswer = JSON.stringify({ decision: 'collaborate', reasoning: 'partner needed' });

describe('R32-A: slim AC necessity prompt', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  const cluster = (requiredCapabilities: string[] = ['cooling']): SpatialClusterSummary => ({
    clusterId: 'c1',
    region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 5, type: 'zone' },
    timeWindow: 'w',
    significance: 'medium',
    summary: 'Generic event requiring LLM evaluation for decision making',
    findings: [{
      eventType: 'odd-event',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: { requiredCapabilities },
    }],
    recommendation: 'evaluate_with_llm',
  });

  const ctx = (overrides: Partial<AgentContext> = {}): AgentContext => ({
    agentId: 'agent-1',
    agentName: 'AgentOne',
    capabilities: ['monitoring'],
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['zone-a'], // direct coverage + capability gap → LLM path
    ...overrides,
  });

  const service = (name: string, capabilities: string[], zone: string, provider = 'other-agent') => ({
    serviceName: `${name} Service`,
    capabilities,
    providerAgentId: provider,
    location: zone,
  });

  /** Drives one LLM-path assessment and returns the user prompt sent. */
  const promptFor = async (agentCtx: AgentContext, cl: SpatialClusterSummary = cluster()): Promise<string> => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(collabAnswer);
    await assessor.assess(cl, agentCtx);
    return (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
  };

  /** The AVAILABLE_PARTNERS section spans both untrusted blocks (catalog + shortlist). */
  const partnersSection = (prompt: string): string => {
    const start = prompt.indexOf('AVAILABLE_PARTNERS');
    expect(start).toBeGreaterThanOrEqual(0);
    const blockStart = prompt.indexOf('<untrusted name="partner-services"', start);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    const end = prompt.indexOf('</untrusted>', blockStart);
    return prompt.slice(start, end >= 0 ? end + '</untrusted>'.length : undefined);
  };

  it('A1: lists at most TOP-K (default 8) partners, most capability-relevant first', async () => {
    const services = [
      service('cooling-unit-1', ['cooling'], 'zone-b'),
      service('cooling-unit-2', ['temperature-control'], 'zone-b'),
      service('hvac-3', ['hvac-control'], 'zone-b'),
      ...Array.from({ length: 9 }, (_, i) => service(`irrelevant-${i}`, ['lighting-control'], 'zone-c')),
    ];
    const prompt = await promptFor(ctx({ discoverableServices: services }));

    const partners = partnersSection(prompt);
    expect(partners).toContain('top 8 of 12');
    // The three cooling/hvac-capable partners are listed first...
    expect(partners.indexOf('cooling-unit-1')).toBeLessThan(partners.indexOf('irrelevant-0'));
    expect(partners).toContain('cooling-unit-1');
    expect(partners).toContain('cooling-unit-2');
    expect(partners).toContain('hvac-3');
    // ...and the budget trims the alphabetically-last off-domain partners.
    expect(partners).not.toContain('irrelevant-8');
    expect(partners).not.toContain('irrelevant-7');
    expect(partners).not.toContain('irrelevant-6');
    expect(partners).not.toContain('irrelevant-5');
  });

  it('A1: the catalog stats line summarizes the WHOLE catalog in one row (P4)', async () => {
    const services = [
      service('cooling-unit-1', ['cooling'], 'zone-b'),
      service('cooling-unit-2', ['temperature-control'], 'zone-b'),
      service('light-1', ['lighting-control'], 'zone-c'),
      service('light-2', ['lighting-control'], 'zone-c'),
    ];
    const prompt = await promptFor(ctx({ discoverableServices: services }));
    const partners = partnersSection(prompt);
    expect(partners).toContain('<untrusted name="partner-catalog"');
    // Grouped per-domain counts: 2×temperature-control? no — semanticType is
    // the first declared capability: cooling ×1, temperature-control ×1,
    // lighting-control ×2 (count-desc then label-asc).
    expect(partners).toContain(
      'CATALOG: 4 services — 2 lighting-control, 1 cooling, 1 temperature-control',
    );
    expect(partners).toContain('SHORTLIST: top 4 of 4 by relevance');
  });

  it('A1: signable offers are marked and ranked ahead at equal relevance (P4)', async () => {
    const services = [
      { ...service('raw-pump', ['drainage-control'], 'zone-b'), origin: 'derived' as const },
      { ...service('campus-drainage', ['drainage-control'], 'zone-b'), origin: 'aggregate' as const, semanticType: 'drainage-control' },
    ];
    // Declared need both services cover equally → gap-relevance ties, and
    // the offer bonus decides: aggregate first, with the offer marker.
    const prompt = await promptFor(ctx({ discoverableServices: services }), cluster(['drainage-control']));
    const partners = partnersSection(prompt);
    expect(partners.indexOf('campus-drainage')).toBeLessThan(partners.indexOf('raw-pump'));
    expect(partners).toContain('campus-drainage(drainage-control@zone-b,offer)');
    expect(partners).toContain('CATALOG: 2 services (1 signable offer)');
  });

  it('A1: partner entries are compact name(semanticType@zone) — no capability rosters', async () => {
    const prompt = await promptFor(ctx({
      discoverableServices: [service('cooling-unit', ['cooling', 'temperature-control', 'power-management'], 'zone-a')],
    }));
    const partners = partnersSection(prompt);
    // semanticType is the single best descriptor, not the full capability list
    expect(partners).toMatch(/cooling-unit\(cooling@zone-a\)/);
    expect(partners).not.toContain('power-management');
  });

  it('A1: zone rosters are counts, not ID lists', async () => {
    const zones = Array.from({ length: 40 }, (_, i) => `zone-${i}`);
    const prompt = await promptFor(ctx({
      managedZoneIds: zones,
      // 'zone-a' (the event zone) must be covered so preCheck reaches the LLM
      actuatorZoneIds: ['zone-a', ...zones.slice(0, 7)],
    }));
    expect(prompt).toContain('Zones=40');
    expect(prompt).toContain('ACTUATORS: 8 zone(s)');
    expect(prompt).not.toMatch(/Zones=\[/);
    expect(prompt).not.toMatch(/ACTUATORS: \[/);
    // none of the individual zone IDs leak into the prompt
    expect(prompt).not.toContain('zone-13');
    expect(prompt).not.toContain('zone-27');
  });

  it('A1: system preamble is compressed but keeps every decision rule', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(collabAnswer);
    await assessor.assess(cluster(), ctx());
    const systemPrompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![1] as string;

    // Rule-complete: all five load-bearing rule markers survive.
    expect(systemPrompt).toContain('SENSOR-ONLY');
    expect(systemPrompt).toContain('COVERAGE=NONE');
    expect(systemPrompt).toContain('COVERAGE=DIRECT');
    expect(systemPrompt).toContain('INDEPENDENT');
    expect(systemPrompt).toContain('NOT actuating caps');
    expect(systemPrompt).toContain("NOT your capabilities");
    // Compressed preamble (1602 chars pre-R32); Phase 1 (cognitive
    // architecture §14.1) swaps the binary answer instruction for the full
    // CognitiveDecisionSchema instruction — the budget grows by that schema
    // block (~1.6k chars) and stays bounded: no prose expansion, just the
    // contract. The binary instruction survives ONLY on the triage lane.
    expect(systemPrompt.length).toBeLessThan(3200);
    // Structured-output instruction is the COGNITIVE one now.
    expect(systemPrompt).toContain('"actionPlan"');
    expect(systemPrompt).toContain('"situation"');
    expect(systemPrompt).toContain('"uncertainty"');
    expect(systemPrompt).toContain('handle_independently');
    expect(systemPrompt).toContain('initiate_ac');
    expect(systemPrompt).toContain('invoke_flow');
    // ...and the retired binary answer shape is gone from the big-model lane.
    expect(systemPrompt).not.toContain('"decision": "collaborate"');
  });

  it('A2: partner summaries are cached per agent and invalidated on topology change', async () => {
    const services = [
      service('cooling-a', ['cooling'], 'zone-a'),
      service('cooling-b', ['cooling'], 'zone-b'),
    ];
    (mockLLMClient.quickChat as Mock).mockResolvedValue(collabAnswer);
    const agentCtx = ctx({ discoverableServices: services });

    await assessor.assess(cluster(), agentCtx); // recompute
    await assessor.assess(cluster(), agentCtx); // reuse (same topology)
    expect(assessor.getPartnerCacheStats()).toEqual({ recomputes: 1, reuses: 1 });

    // Same services, different registration ORDER → same topology signature → reuse
    await assessor.assess(cluster(), ctx({ discoverableServices: [...services].reverse() }));
    expect(assessor.getPartnerCacheStats()).toEqual({ recomputes: 1, reuses: 2 });

    // Topology change (new service published) → recompute
    await assessor.assess(cluster(), ctx({
      discoverableServices: [...services, service('new-hvac', ['hvac-control'], 'zone-a')],
    }));
    expect(assessor.getPartnerCacheStats()).toEqual({ recomputes: 2, reuses: 2 });

    // A different agent has its own cache entry
    await assessor.assess(cluster(), ctx({ agentId: 'agent-2', agentName: 'Two', discoverableServices: services }));
    expect(assessor.getPartnerCacheStats()).toEqual({ recomputes: 3, reuses: 2 });
  });

  it('A4: registration order of identical topology yields byte-identical prompts (stable cache key)', async () => {
    const services = [
      service('cooling-a', ['cooling'], 'zone-a'),
      service('cooling-b', ['cooling'], 'zone-b'),
      service('cooling-c', ['cooling'], 'zone-c'),
      service('light-d', ['lighting-control'], 'zone-a'),
    ];
    const p1 = await promptFor(ctx({ discoverableServices: services }));
    const p2 = await promptFor(ctx({ discoverableServices: [...services].reverse() }));
    expect(p1).toBe(p2);
  });

  it('A3: the decision call caps generation and pins temperature 0', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(collabAnswer);
    await assessor.assess(cluster(), ctx());
    const call = (mockLLMClient.quickChat as Mock).mock.calls[0]!;
    // Phase 1 (§11.3/§14.1): the cognitive-schema output is budgeted
    // 250–450 tokens → 1024 cap (covers the budget plus verbose
    // non-thinking payloads, R5-F13; 2x lower worst-case decode than the
    // old 2048), and the decision endpoint samples at temperature 0
    // (R35 rec #2). Qwen3 thinking suppression rides along (guided-JSON
    // output).
    expect(call[4]).toEqual({
      maxTokens: 1024,
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: false },
    });
    // The constrained-decoding schema is the cognitive one.
    const format = call[3] as Record<string, unknown>;
    expect(format).toBeDefined();
    expect(JSON.stringify(format)).toContain('actionPlan');
  });

  it('conciseServiceMode (ablation) is unchanged: zone-filtered names, no ranking', async () => {
    const services = [
      service('in-zone', ['lighting-control'], 'zone-a'),
      service('out-zone', ['cooling'], 'zone-b'),
    ];
    const prompt = await promptFor(ctx({ conciseServiceMode: true, discoverableServices: services }));
    const partners = partnersSection(prompt);
    expect(partners).toContain('in-zone');
    expect(partners).not.toContain('out-zone');
    // concise mode keeps the raw service-name listing shape
    expect(partners).toContain('in-zone Service');
  });

  it('partner listing still rides the untrusted-block sanitizer (S1 invariant)', async () => {
    const prompt = await promptFor(ctx({
      discoverableServices: [service('cooling-a', ['cooling'], 'zone-a')],
    }));
    const partners = partnersSection(prompt);
    expect(partners).toContain('<untrusted name="partner-services"');
    expect(prompt).toContain('<untrusted name="event-summary"');
  });
});
