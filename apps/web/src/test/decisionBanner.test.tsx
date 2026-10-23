/**
 * R74 decision-posture banner (EnvironmentsHomePage): a server running the
 * rule harness (decision.mode 'rule-test') shows the TEST-mode banner above
 * the world list; an LLM server shows nothing. Guards the platform stance
 * that rule-driven behavior is test-only, never a silent production default.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EnvironmentsHomePage } from '../pages/EnvironmentsHomePage';
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubServer(decision: {
  mode: 'llm' | 'llm-unreachable' | 'rule-test';
  model?: string;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/health')) {
        return jsonResponse({
          status: 'ok',
          version: 'test',
          uptimeSec: 1,
          worlds: { environments: 0, sims: { total: 0, running: 0 } },
          decision,
          checks: { database: 'ok' },
        });
      }
      return jsonResponse({ environments: [] });
    }),
  );
}

describe('decision-posture banner (R74)', () => {
  it('shows the TEST banner when the server runs the rule harness', async () => {
    stubServer({ mode: 'rule-test' });
    renderWithProviders(<EnvironmentsHomePage />);
    const banner = await screen.findByTestId('decision-mode-banner');
    expect(banner.textContent).toContain('决策引擎：规则模式（仅测试）');
    expect(banner.textContent).toContain('不代表生产级行为');
  });

  it('shows nothing extra when the server runs the LLM decision engine', async () => {
    stubServer({ mode: 'llm', model: 'ac-decision-v5' });
    renderWithProviders(<EnvironmentsHomePage />);
    // The world list settles (empty state) — and no banner anywhere.
    await screen.findByText('还没有你的环境');
    expect(screen.queryByTestId('decision-mode-banner')).toBeNull();
  });

  it('shows the DEGRADED banner when the configured LLM backend is unreachable', async () => {
    stubServer({ mode: 'llm-unreachable', model: 'ac-decision-v5' });
    renderWithProviders(<EnvironmentsHomePage />);
    const banner = await screen.findByTestId('decision-mode-banner');
    expect(banner.textContent).toContain('决策引擎：LLM 后端不可达（已降级）');
    expect(banner.textContent).toContain('ac-decision-v5');
    expect(banner.textContent).toContain('生产姿态受损');
    // Danger tone, not the quiet amber.
    expect(banner.className).toContain('decision-banner--unreachable');
  });
});
