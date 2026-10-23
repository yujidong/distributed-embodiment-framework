/**
 * LivePanels 决策卡的升级标记（R40-A3，认知架构 §7.5 升级通道）：
 * escalated 决策渲染 ⚠ 徽章（悬浮带 escalationCondition），普通决策不渲染。
 * mock lib/echarts（LivePanels 内嵌 EnvSeriesPanel/EnergyPanel 的图表钩子）。
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

// useTranslation reads the active i18next bundle; pin to zh-CN so the badge
// assertion can be the exact Simplified-Chinese label.
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
    decision: 'defer',
    decisionSource: 'llm',
    at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(useECharts).mockClear();
});

describe('LivePanels — 升级徽章（R40-A3）', () => {
  it('escalated 决策渲染 ⚠ 徽章，悬浮携带 escalationCondition', () => {
    render(
      <LivePanels
        snapshot={snapshotWithDecisions([
          decision({
            escalated: true,
            escalationCondition: 'severity≥4 emergency with confidence=0.3<0.5',
          }),
        ])}
        envSeries={emptySeries}
      />,
    );

    const badge = screen.getByText(/已升级/);
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('⚠');
    expect(badge.getAttribute('title')).toBe('severity≥4 emergency with confidence=0.3<0.5');
  });

  it('escalated 但缺 escalationCondition 时悬浮回落到徽章文案本身', () => {
    render(
      <LivePanels
        snapshot={snapshotWithDecisions([decision({ escalated: true })])}
        envSeries={emptySeries}
      />,
    );
    expect(screen.getByText(/已升级/).getAttribute('title')).toBe('已升级');
  });

  it('普通决策不渲染升级徽章', () => {
    render(
      <LivePanels
        snapshot={snapshotWithDecisions([
          decision({ decision: 'handle_independently', reasoning: 'own hvac covers it' }),
        ])}
        envSeries={emptySeries}
      />,
    );
    expect(screen.queryByText(/已升级/)).toBeNull();
  });
});
