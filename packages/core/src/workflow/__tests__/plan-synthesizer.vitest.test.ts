/**
 * @vitest-environment node
 *
 * LLM plan synthesizer tests (P4-3, no LLM backend — mock LLMClient):
 *   - valid plan on the first try
 *   - invalid → repair loop → fixed plan (issues fed back to the model)
 *   - invalid twice → give up with issues (NEVER throws)
 *   - transport failure and non-JSON responses
 *   - provenance stamping (framework, not the model, sets metadata)
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { synthesizePlan, type PlanSynthesisContext } from '../plan-synthesizer.js';

const CONTEXT: PlanSynthesisContext = {
  agents: [
    { agentId: 'agent-sensor', capabilities: ['temperature-reading'] },
    { agentId: 'agent-hvac', capabilities: ['cooling', 'heating'] },
  ],
  zones: ['living-room'],
  recentEnvState: { 'living-room': { temperature: 33 } },
};

function validPlanJSON(): string {
  return JSON.stringify({
    id: 'plan-cool-living-room',
    goal: '客厅温度 33°，降温到 26°',
    nodes: [
      { id: 'sense', capability: 'temperature-reading' },
      {
        id: 'cool', capability: 'cooling',
        params: { targetTemperature: 26 },
        dependsOn: ['sense'],
        condition: 'living-room.temperature > 30',
      },
    ],
    metadata: { author: 'llm', model: 'claimed-by-model', createdAt: '2020-01-01T00:00:00.000Z' },
  });
}

/** Queue-based mock LLM client: one canned response (or error) per call. */
function mockClient(queue: Array<string | Error>): {
  client: LLMClient;
  quickChat: ReturnType<typeof vi.fn>;
} {
  const quickChat = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('mock queue exhausted');
    if (next instanceof Error) throw next;
    return { content: next, model: 'mock-model', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const client = { quickChat, getModel: () => 'mock-model' } as unknown as LLMClient;
  return { client, quickChat };
}

describe('synthesizePlan', () => {
  it('returns a valid authored plan on the first try', async () => {
    const { client, quickChat } = mockClient([validPlanJSON()]);

    const result = await synthesizePlan('客厅温度 33°，降温到 26°', CONTEXT, client);

    expect(quickChat).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.plan).toBeDefined();
    expect(result.plan!.nodes).toHaveLength(2);
    expect(result.assignments!.get('sense')).toBe('agent-sensor');
    expect(result.assignments!.get('cool')).toBe('agent-hvac');

    // Constrained decoding requested with the plan JSON schema.
    const [, , , format] = quickChat.mock.calls[0];
    expect(format).toMatchObject({ type: 'object', required: ['id', 'goal', 'nodes', 'metadata'] });
  });

  it('stamps provenance itself — model authorship claims are not trusted', async () => {
    const { client } = mockClient([validPlanJSON()]);
    const result = await synthesizePlan('goal', CONTEXT, client);

    expect(result.plan!.metadata.author).toBe('llm');
    expect(result.plan!.metadata.model).toBe('mock-model'); // not 'claimed-by-model'
    expect(result.plan!.metadata.createdAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('accepts markdown-fenced JSON (providers ignoring the schema)', async () => {
    const fenced = '```json\n' + validPlanJSON() + '\n```';
    const { client } = mockClient([fenced]);
    const result = await synthesizePlan('goal', CONTEXT, client);
    expect(result.plan).toBeDefined();
    expect(result.attempts).toBe(1);
  });

  it('feeds validation issues back for one repair and returns the fixed plan', async () => {
    const badPlan = JSON.stringify({
      id: 'p1', goal: 'g',
      nodes: [
        { id: 'sense', capability: 'quantum-teleportation' }, // UNSAT
        { id: 'cool', capability: 'cooling', dependsOn: ['ghost'] }, // bad ref
      ],
      metadata: { author: 'llm', createdAt: 'x' },
    });
    const { client, quickChat } = mockClient([badPlan, validPlanJSON()]);

    const result = await synthesizePlan('goal', CONTEXT, client);

    expect(quickChat).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.plan).toBeDefined();

    // The repair prompt carried the validation issues back to the model.
    const repairPrompt = quickChat.mock.calls[1][0] as string;
    expect(repairPrompt).toContain('UNSAT');
    expect(repairPrompt).toContain("unknown node 'ghost'");
  });

  it('gives up with issues after two invalid plans (never throws)', async () => {
    const badPlan = JSON.stringify({
      id: 'p1', goal: 'g',
      nodes: [{ id: 'x', capability: 'quantum-teleportation' }],
      metadata: { author: 'llm', createdAt: 'x' },
    });
    const { client, quickChat } = mockClient([badPlan, badPlan]);

    const result = await synthesizePlan('goal', CONTEXT, client);

    expect(quickChat).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.plan).toBeUndefined();
    expect(result.issues.some(i => i.message.includes('UNSAT'))).toBe(true);
    expect(result.rawResponses).toHaveLength(2);
  });

  it('repairs a non-JSON response once', async () => {
    const { client, quickChat } = mockClient(['I cannot make a plan for this.', validPlanJSON()]);
    const result = await synthesizePlan('goal', CONTEXT, client);

    expect(quickChat).toHaveBeenCalledTimes(2);
    expect(result.plan).toBeDefined();
    const repairPrompt = quickChat.mock.calls[1][0] as string;
    expect(repairPrompt).toContain('not valid JSON');
  });

  it('gives up immediately on transport failure with an error issue', async () => {
    const { client, quickChat } = mockClient([new Error('connection refused')]);
    const result = await synthesizePlan('goal', CONTEXT, client);

    expect(quickChat).toHaveBeenCalledTimes(1);
    expect(result.plan).toBeUndefined();
    expect(result.issues[0].message).toContain('connection refused');
  });

  it('fails honestly when the context has no agents (all capabilities UNSAT)', async () => {
    const { client } = mockClient([validPlanJSON(), validPlanJSON()]);
    const result = await synthesizePlan('goal', { agents: [] }, client);

    expect(result.plan).toBeUndefined();
    expect(result.issues.some(i => i.message.includes('UNSAT'))).toBe(true);
  });
});
