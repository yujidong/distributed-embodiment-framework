/**
 * B5 EvalReportPanel (console bottom-drawer 评估 tab): metric cards render
 * from a stubbed GET /api/simulations/:id/eval-report, plus the loading →
 * empty state when the run produced nothing to evaluate and the error state
 * on 404. Also covers the F3-2 trajectory-health cards and the plan-r81 B3
 * training-export download link (rendered only when the report carries an
 * environmentId).
 */

import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EvalReportPanel } from '../components/EvalReportPanel';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

// Assertions use the zh-CN bundle; pin it like the other panel tests.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REPORT = {
  simId: 'sim-1',
  scenarioId: 'demo',
  environmentId: 'env-1',
  source: 'registry',
  state: 'stopped',
  simTimeSec: 120,
  events: 3,
  decisions: {
    total: 4,
    correct: 3,
    unlabeled: 0,
    accuracy: 0.75,
    bySource: { rule: 3, llm: 1 },
  },
  handshakes: { initiated: 2, succeeded: 1, failed: 1, successRate: 0.5 },
  effectChecks: { attempts: 5, successes: 4, failures: 1, passRate: 0.8 },
  reputation: {
    totals: { attempts: 5, successes: 4, failures: 1 },
    agents: [{ agentId: 'a-1', attempts: 5, successes: 4, failures: 1 }],
  },
};

const EMPTY_REPORT = {
  ...REPORT,
  simTimeSec: 10,
  events: 0,
  decisions: { total: 0, correct: 0, unlabeled: 0, accuracy: null, bySource: {} },
  handshakes: { initiated: 0, succeeded: 0, failed: 0, successRate: null },
  effectChecks: { attempts: 0, successes: 0, failures: 0, passRate: null },
  reputation: { totals: { attempts: 0, successes: 0, failures: 0 }, agents: [] },
};

function stubReport(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/simulations/sim-1/eval-report') return jsonResponse(body, status);
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
    }),
  );
}

describe('EvalReportPanel (B5)', () => {
  it('renders the metric cards from the eval report', async () => {
    stubReport(REPORT);
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(await screen.findByText('决策准确率')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('3/4 条有标注且正确')).toBeTruthy();

    expect(screen.getByText('决策总数')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('3 个事件')).toBeTruthy();

    expect(screen.getByText('AC 握手成功率')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();

    expect(screen.getByText('效果回检通过率')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();

    expect(screen.getByText('声誉（成功/尝试）')).toBeTruthy();
    // bySource distribution badges.
    expect(screen.getByText('rule × 3')).toBeTruthy();
    expect(screen.getByText('llm × 1')).toBeTruthy();
    // Registry source badge + sim time.
    expect(screen.getByText('实时')).toBeTruthy();
    expect(screen.getByText('仿真时间 120s')).toBeTruthy();

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/simulations/sim-1/eval-report');
  });

  it('renders the per-agent metacognition block (R40-B2)', async () => {
    stubReport({
      ...REPORT,
      metaAgents: [
        {
          agentId: 'agent-1',
          agentName: '楼宇管家',
          calibrationScore: 0.82,
          decisionCount: 12,
          evaluatedDecisions: 9,
          successRate: 0.78,
          topUncalibratedActions: [
            { action: 'initiate_ac', count: 5, avgConfidence: 0.8, successRate: 0.2, gap: 0.6 },
          ],
          capabilityBoundary: { strong: ['temperature-control'], weak: ['security'], mustEscalate: ['fire'] },
          trustPartners: [{ partnerId: 'partner-12345678', trust: 0.64, interactions: 7 }],
        },
      ],
    });
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(await screen.findByText('元认知（按 Agent）')).toBeTruthy();
    expect(screen.getByText('楼宇管家')).toBeTruthy();
    expect(screen.getByText('校准分数 82%')).toBeTruthy();
    expect(screen.getByText('成功率 78%')).toBeTruthy();
    expect(screen.getByText('已评估 9/12 条决策')).toBeTruthy();
    expect(screen.getByText('必须升级: fire')).toBeTruthy();
    expect(screen.getByText('initiate_ac ×5')).toBeTruthy();
    expect(screen.getByText('partner- 0.64')).toBeTruthy();
  });

  it('shows the empty state when nothing has been evaluated yet', async () => {
    stubReport(EMPTY_REPORT);
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(
      await screen.findByText('暂无可评估的数据 —— 运行仿真并产生决策后，这里会显示指标。'),
    ).toBeTruthy();
  });

  it('shows the error state when the report request fails', async () => {
    stubReport({ error: { code: 'SIMULATION_NOT_FOUND', message: 'simulation not found' } }, 404);
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(await screen.findByText(/评估报告加载失败/)).toBeTruthy();
  });

  it('renders the F3-2 trajectory-health cards when the report carries them', async () => {
    stubReport({
      ...REPORT,
      trajectory: {
        llmFailures: 2,
        structuredOutput: { llm: 10, json: 8, fsm: 2, jsonRate: 0.8 },
        chain: { actionable: 6, withFeedback: 5, completeness: 5 / 6 },
      },
    });
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(await screen.findByText('链路完整率')).toBeTruthy();
    expect(screen.getByText('83%')).toBeTruthy();
    expect(screen.getByText('5/6')).toBeTruthy();

    expect(screen.getByText('结构化输出合规率')).toBeTruthy();
    expect(screen.getByText('8/10 条 JSON · FSM 兜底 2 条')).toBeTruthy();

    expect(screen.getByText('LLM 调用失败')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('共 10 条 LLM 决策')).toBeTruthy();
  });

  it('links the training-data export for the simulation (plan-r81 B3)', async () => {
    stubReport(REPORT);
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    const link = await screen.findByRole('link', { name: '导出训练数据（NDJSON）' });
    expect(link.getAttribute('href')).toBe('/api/environments/env-1/training-export?simId=sim-1');
    expect(link.getAttribute('download')).toBe('training-export-sim-1.ndjson');
    expect(
      screen.getByText('下载本仿真的决策/协作轨迹 + 环境时序、消费计量与声誉快照（限环境所有者）'),
    ).toBeTruthy();
  });

  it('hides the export entry when the report has no environmentId (legacy scenario sim)', async () => {
    const { environmentId: _omitted, ...legacyReport } = REPORT;
    stubReport(legacyReport);
    renderWithProviders(<EvalReportPanel simulationId="sim-1" />);

    expect(await screen.findByText('决策准确率')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '导出训练数据（NDJSON）' })).toBeNull();
  });
});
