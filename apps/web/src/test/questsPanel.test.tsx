/**
 * R6-D-M1 (gamification §2) QuestsPanel (world sidebar 关卡 tab): the L1-L6
 * quest backbone rendered from a stubbed GET /api/environments/:id/quest-state
 * — progress line + bar, per-quest achieved/locked/current badges, the current
 * quest's guidance line with a jump button to the target sidebar tab, the
 * all-done state, and the error state. Same pattern as
 * achievementTimeline.test.tsx.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { QuestsPanel } from '../components/world/QuestsPanel';
import type { EnvironmentDetail, QuestHint, QuestId, QuestState, QuestStatus } from '../api/types';
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

function quest(id: QuestId, achieved: boolean, locked: boolean, hint: QuestHint): QuestStatus {
  return { id, achieved, locked, hint };
}

const PARTIAL: QuestState = {
  quests: [
    quest('L1', true, false, 'import-building'),
    quest('L2', false, false, 'install-blueprint'),
    quest('L3', false, true, 'bind-agent'),
    quest('L4', false, true, 'install-collab-pair'),
    quest('L5', false, true, 'complete-agreement'),
    quest('L6', false, true, 'compose-flow'),
  ],
  current: 'L2',
};

const ALL_DONE: QuestState = {
  quests: PARTIAL.quests.map(q => ({ ...q, achieved: true })),
  current: null,
};

const WORLD = { id: 'env-1' } as unknown as EnvironmentDetail;

function stubQuestState(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/environments/env-1/quest-state') return jsonResponse(body, status);
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
    }),
  );
}

describe('QuestsPanel (R6-D-M1)', () => {
  it('renders the six quests with progress, badges, and the current quest guidance', async () => {
    stubQuestState(PARTIAL);
    const onTabChange = vi.fn();
    renderWithProviders(<QuestsPanel world={WORLD} onTabChange={onTabChange} />);

    expect(await screen.findByTestId('quest-panel')).toBeTruthy();
    expect(screen.getByTestId('quest-progress').textContent).toBe('关卡进度 1/6');

    // L1 achieved, L2 current, L3-L6 locked.
    expect(screen.getByTestId('quest-L1').textContent).toContain('已达成');
    expect(screen.getByTestId('quest-L1').textContent).toContain('L1 · 安家');
    expect(screen.getByTestId('quest-L2').textContent).toContain('当前');
    for (const id of ['L3', 'L4', 'L5', 'L6']) {
      expect(screen.getByTestId(`quest-${id}`).textContent).toContain('未解锁');
    }

    // The current quest shows its guidance line + a jump button (L2 → 蓝图 tab).
    const guidance = screen.getByTestId('quest-guidance');
    expect(guidance.textContent).toContain('去「蓝图」页安装一张带设备的应用卡。');
    screen.getByText('去完成 →').click();
    expect(onTabChange).toHaveBeenCalledWith('blueprints');

    // Exactly one fetch, to the quest-state endpoint.
    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls).toEqual(['/api/environments/env-1/quest-state']);
  });

  it('shows the all-done state when every quest is achieved', async () => {
    stubQuestState(ALL_DONE);
    renderWithProviders(<QuestsPanel world={WORLD} onTabChange={vi.fn()} />);

    expect(await screen.findByTestId('quest-panel')).toBeTruthy();
    expect(screen.getByTestId('quest-progress').textContent).toBe('关卡进度 6/6');
    expect(screen.getByText('全部关卡已达成——这个世界活了。')).toBeTruthy();
    // No current quest → no guidance block.
    expect(screen.queryByTestId('quest-guidance')).toBeNull();
  });

  it('shows the error state when the quest-state request fails', async () => {
    stubQuestState({ error: { code: 'FORBIDDEN', message: 'not a member' } }, 403);
    renderWithProviders(<QuestsPanel world={WORLD} />);

    expect(await screen.findByText(/加载关卡状态失败/)).toBeTruthy();
  });
});
