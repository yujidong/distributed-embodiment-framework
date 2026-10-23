/**
 * LivePanels 决策卡的认知六区块徽章（R40-A6）：
 * - 结构化 LLM 决策（携带 situation/uncertainty）渲染 情境徽章（类型·严重度，
 *   紧急度着色类）+ 不确定性百分比（悬浮带数据质量）；
 * - 规则路径决策（无六区块字段）不渲染任何徽章——优雅降级为只有 reasoning。
 * mock lib/echarts（LivePanels 内嵌图表钩子），与 livePanelsEscalation 同模式。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LivePanels } from '../components/LivePanels';
import i18n from '../i18n/config';
import { useECharts } from '../lib/echarts';
import { createEnvTimeseries, type EnvTimeseries } from '../lib/timeseries';
import { makeSnapshot } from './fixtures';
import type { EngineSnapshot } from '../api/types';

vi.mock('../lib/echarts', () => ({
  useECharts: vi.fn(() => () => undefined),
  chartPalette: () => ({
    text: '#fff',
    textDim: '#999',
    axisLine: '#333',
    splitLine: '#333',
    panelBg: '#111',
    border: '#333',
    accent: '#4cc2ff',
    ok: '#3fb950',
    danger: '#f2555a',
    actuator: '#f5a524',
    series: ['#f2555a', '#b07cf0', '#2dd4bf', '#4cc2ff', '#f5a524', '#3fb950'],
  }),
}));

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

const emptySeries: EnvTimeseries = createEnvTimeseries();

function snapshotWithDecisions(decisions: NonNullable<EngineSnapshot['recentDecisions']>): EngineSnapshot {
  return makeSnapshot({
    agents: [{ id: 'agent-1', name: 'Agent One', llmEnabled: false, eventsProcessed: 0, activeACCount: 0, activeCollaborations: [], managedZoneIds: [] } as unknown as EngineSnapshot['agents'][number]],
    recentDecisions: decisions,
  });
}

function decision(overrides: Partial<EngineSnapshot['recentDecisions'][number]>): EngineSnapshot['recentDecisions'][number] {
  return {
    agentId: 'agent-1',
    eventId: 'evt-1',
    eventType: 'temperature-spike',
    decision: 'handle_independently',
    decisionSource: 'llm',
    at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(useECharts).mockClear();
});

describe('LivePanels — 认知六区块徽章（R40-A6）', () => {
  it('结构化 LLM 决策渲染情境徽章（类型·严重度）与不确定性', () => {
    render(
      <LivePanels
        snapshot={snapshotWithDecisions([
          decision({
            situation: { type: 'emergency', severity: 4, confidence: 0.9 },
            uncertainty: { overall: 0.35, dataQuality: 0.8 },
          }),
        ])}
        envSeries={emptySeries}
      />,
    );

    const badge = screen.getByText(/紧急·4/);
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('decision-item__situation--emergency');

    const uncertainty = screen.getByText('?35%');
    expect(uncertainty).toBeTruthy();
    expect(uncertainty.getAttribute('title')).toContain('35%');
    expect(uncertainty.getAttribute('title')).toContain('80%');
  });

  it('规则路径决策（无六区块字段）不渲染任何认知徽章', () => {
    render(
      <LivePanels
        snapshot={snapshotWithDecisions([
          decision({ decisionSource: 'rule', reasoning: '缺少必需能力，推迟' }),
        ])}
        envSeries={emptySeries}
      />,
    );

    expect(screen.queryByText(/紧急|异常|机会|正常/)).toBeNull();
    expect(screen.queryByText(/%\s*$/)).toBeNull();
    expect(screen.getByText(/缺少必需能力/)).toBeTruthy();
  });
});
