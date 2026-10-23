/**
 * R76-F3 guard — the agent chat transcript marks each entry's decision
 * SOURCE (wire field intent.parseSource): llm / rules / rules-llm-down.
 * The degradation case (rules-llm-down) must be distinguishable from a
 * production LLM answer at a glance (vision R74: explicit decision posture).
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentChatPanel } from '../components/AgentChatPanel';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function commandResponse(parseSource: 'llm' | 'rules' | 'rules-llm-down'): Response {
  return new Response(
    JSON.stringify({
      agentId: 'a1',
      simulationId: 'sim-1',
      intent: { action: 'set_parameter', rawText: 'x', parseSource },
      cognitiveDecision: {},
      decisionSource: parseSource === 'llm' ? 'llm' : 'rules',
      executionResult: { success: true, message: 'ok', actions: [] },
      naturalLanguageResponse: '已处理。',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function stubCommand(parseSource: 'llm' | 'rules' | 'rules-llm-down'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/agents/a1/command')) return commandResponse(parseSource);
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

async function sendCommand(): Promise<void> {
  renderWithProviders(
    <AgentChatPanel simulationId="sim-1" agents={[{ id: 'a1', name: 'Agent One' }]} />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '把大厅温度调到 22' } });
  fireEvent.submit(screen.getByRole('button', { name: '发送' }).closest('form')!);
  await screen.findByText('已处理。');
}

describe('AgentChatPanel decision-source badge (R76-F3)', () => {
  it('marks an LLM-parsed entry with the LLM chip', async () => {
    stubCommand('llm');
    await sendCommand();
    const chip = screen.getByTitle('本条由 LLM 解析与决策');
    expect(chip.textContent).toBe('LLM');
    expect(chip.className).toContain('agent-chat__source--llm');
  });

  it('marks a degraded entry distinctly (rules · LLM down)', async () => {
    stubCommand('rules-llm-down');
    await sendCommand();
    const chip = screen.getByText('规则 · LLM 降级');
    expect(chip.className).toContain('agent-chat__source--rules-llm-down');
  });

  it('marks a rule-lane entry with the rules chip', async () => {
    stubCommand('rules');
    await sendCommand();
    expect(screen.getByText('规则')).toBeDefined();
  });
});
