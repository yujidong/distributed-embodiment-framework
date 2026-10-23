/**
 * R6-D-F01 (gamification S2) AchievementTimeline (world sidebar 成就 tab):
 * completed collaborations render from a stubbed GET
 * /api/environments/:id/digest (participants as agent names, honest outcome
 * badges, relative time, newest first as served), plus the empty state, the
 * env-owner providerUnavailableAgreements warning section (visible only when
 * the server returns entries), the digest category counts, and the error
 * state.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AchievementTimeline } from '../components/world/AchievementTimeline';
import type { EnvironmentDetail } from '../api/types';
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

function collab(overrides: Record<string, unknown> = {}) {
  return {
    agreementId: 'agr-1',
    collaborationId: null,
    source: 'ac',
    service: { id: 'svc-1', name: '温度控制' },
    consumer: { agentId: 'agent-a', agentName: '小温' },
    provider: { agentId: 'agent-b', agentName: '小控' },
    outcome: 'completed',
    terminatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    ...overrides,
  };
}

function digest(overrides: Record<string, unknown> = {}) {
  return {
    envId: 'env-1',
    date: '2026-09-13',
    since: '2026-09-13T00:00:00.000Z',
    until: '2026-09-13T19:00:00.000Z',
    generatedAt: '2026-09-13T19:00:00.000Z',
    frozen: true,
    title: '今日简报',
    categories: {
      proposals: { label: '已决提案', count: 2, entries: [] },
      agreements: { label: '合约变动', count: 1, entries: [] },
      devices: { label: '设备安装', count: 0, entries: [] },
      world: { label: '世界治理', count: 0, entries: [] },
    },
    completedCollaborations: [collab()],
    providerUnavailableAgreements: [],
    total: 3,
    ...overrides,
  };
}

const WORLD = { id: 'env-1' } as unknown as EnvironmentDetail;

function stubDigest(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/environments/env-1/digest') return jsonResponse(body, status);
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
    }),
  );
}

describe('AchievementTimeline (R6-D-F01)', () => {
  it('renders completed collaborations with participants, service, outcome and relative time', async () => {
    stubDigest(
      digest({
        completedCollaborations: [
          collab({ agreementId: 'agr-1', outcome: 'completed' }),
          collab({
            agreementId: 'agr-2',
            service: { id: 'svc-2', name: '照明调节' },
            consumer: { agentId: 'agent-c', agentName: '小照' },
            outcome: 'partial',
            terminatedAt: new Date(Date.now() - 30 * 60e3).toISOString(),
          }),
        ],
      }),
    );
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    expect(await screen.findByTestId('achievement-timeline')).toBeTruthy();
    const entries = await screen.findAllByTestId('achievement-entry');
    expect(entries).toHaveLength(2);
    // Newest first as served (the server orders; the panel does not re-sort).
    expect(entries[0].textContent).toContain('小温 消费了 小控 的「温度控制」');
    expect(entries[0].textContent).toContain('已完成');
    expect(entries[0].textContent).toContain('2 小时前');
    expect(entries[1].textContent).toContain('小照 消费了 小控 的「照明调节」');
    expect(entries[1].textContent).toContain('部分完成');
    expect(entries[1].textContent).toContain('30 分钟前');
    // The four digest category counts ride along (每日战报 line).
    expect(screen.getByTestId('achievement-categories').textContent).toBe(
      '已决提案 2 · 合约变动 1 · 设备安装 0 · 世界治理 0',
    );
    // No owner section without entries.
    expect(screen.queryByTestId('provider-unavailable-section')).toBeNull();

    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls).toEqual(['/api/environments/env-1/digest']);
  });

  it('presents cancelled collaborations honestly (not as a success)', async () => {
    stubDigest(
      digest({ completedCollaborations: [collab({ outcome: 'cancelled' })] }),
    );
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    const entry = await screen.findByTestId('achievement-entry');
    expect(entry.textContent).toContain('已取消');
    expect(entry.textContent).not.toContain('已完成');
  });

  it('falls back to placeholders for unlinked (deleted) references', async () => {
    stubDigest(
      digest({
        completedCollaborations: [
          collab({
            service: { id: null, name: null },
            provider: { agentId: null, agentName: null },
          }),
        ],
      }),
    );
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    const entry = await screen.findByTestId('achievement-entry');
    expect(entry.textContent).toContain('小温 消费了 未知 Agent 的「已删除的服务」');
  });

  it('shows the guidance empty state when nothing has completed yet', async () => {
    stubDigest(digest({ completedCollaborations: [], total: 0 }));
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    expect(
      await screen.findByText('当 Agent 们开始协作，完成的成果会出现在这里。'),
    ).toBeTruthy();
    expect(screen.queryByTestId('achievement-entry')).toBeNull();
    // Zero-activity digests skip the all-zero category line.
    expect(screen.queryByTestId('achievement-categories')).toBeNull();
  });

  it('shows the env-owner provider-unavailable warning section only when entries exist', async () => {
    stubDigest(
      digest({
        completedCollaborations: [],
        providerUnavailableAgreements: [
          {
            agreementId: 'agr-x',
            source: 'explicit',
            service: { id: null, name: '巡检服务' },
            consumer: { agentId: 'agent-c', agentName: '小巡' },
            provider: { agentId: null, agentName: null },
            reason: 'provider-unavailable',
            suspendedAt: new Date(Date.now() - 3600e3).toISOString(),
          },
        ],
      }),
    );
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    const section = await screen.findByTestId('provider-unavailable-section');
    expect(section.textContent).toContain('提供方失联的合约');
    expect(section.textContent).toContain('小巡 的合约（巡检服务）');
    expect(section.textContent).toContain('1 小时前');
    // The empty-state guidance still shows (no completed collaborations).
    expect(screen.getByText('当 Agent 们开始协作，完成的成果会出现在这里。')).toBeTruthy();
  });

  it('renders entries older than a week as absolute dates', async () => {
    const tenDaysAgo = Date.now() - 10 * 86400e3;
    stubDigest(
      digest({
        completedCollaborations: [
          collab({ terminatedAt: new Date(tenDaysAgo).toISOString() }),
        ],
      }),
    );
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    const entry = await screen.findByTestId('achievement-entry');
    expect(entry.textContent).toContain(new Date(tenDaysAgo).toLocaleDateString('zh-CN'));
  });

  it('shows the error state when the digest request fails', async () => {
    stubDigest({ error: { code: 'FORBIDDEN', message: 'not a member' } }, 403);
    renderWithProviders(<AchievementTimeline world={WORLD} />);

    expect(await screen.findByText(/加载失败/)).toBeTruthy();
  });
});
