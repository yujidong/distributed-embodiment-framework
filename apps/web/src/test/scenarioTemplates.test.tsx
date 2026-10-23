/**
 * W1b scenario-template onboarding (EnvironmentsHomePage):
 * - the create dialog defaults to the new 模板 tab, listing the bundled
 *   templates as cards whose 创建 button one-click imports the template
 *   (GET /api/scenario-templates/:id → POST /api/environments);
 * - the empty-state 导入 starter-home button does the same one-click import
 *   directly, and falls back to the import dialog when the fetch fails.
 *
 * Driven against the real page with a stubbed fetch, same pattern as
 * environmentImport.test.tsx.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EnvironmentsHomePage } from '../pages/EnvironmentsHomePage';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

// Assertions use the zh-CN bundle; pin it like the other page tests.
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

const TEMPLATE_SUMMARY = {
  id: 'starter-home',
  name: 'Starter Home',
  description: '示例家居场景：客厅与卧室，含灯、空调与演示事件。',
  counts: { zones: 2, devices: 3, agents: 1, events: 1, derivedServices: 0 },
  mapType: 'grid',
};

const TEMPLATE_JSON = {
  version: '1.0',
  meta: { id: 'starter-home', name: 'Starter Home' },
  zones: [{ id: 'living' }],
  devices: [],
  agents: [],
  events: [],
};

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

/** Stub the API surface the page touches; records POST /api/environments. */
function stubTemplateFetch(options: { failTemplate?: boolean } = {}) {
  const posts: CapturedPost[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url === '/api/environments') {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return jsonResponse({ id: 'env-new' });
    }
    if (url === '/api/environments' || url.startsWith('/api/environments?')) return jsonResponse({ environments: [] });
    if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [TEMPLATE_SUMMARY] });
    if (url === '/api/scenario-templates/starter-home') {
      if (options.failTemplate) {
        return jsonResponse({ error: { code: 'TEMPLATE_NOT_FOUND', message: 'not found' } }, 404);
      }
      return jsonResponse(TEMPLATE_JSON);
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts, fetchMock };
}

describe('CreateEnvironmentDialog — 模板 tab (W1b)', () => {
  it('defaults to the 模板 tab and one-click creates an environment from a template card', async () => {
    const { posts, fetchMock } = stubTemplateFetch();
    renderWithProviders(<EnvironmentsHomePage />);

    // Empty mine-tab → the toolbar 新建环境 opens the dialog.
    (await screen.findByText('+ 新建环境')).click();

    // The 模板 tab is the default and its list loads — the request carries
    // the active i18n language so the server localizes name/description.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '模板' }).className).toContain('home-tab--active'),
    );
    await screen.findByText('Starter Home');
    const templateCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/scenario-templates?'),
    );
    expect(templateCalls).toHaveLength(1);
    expect(String(templateCalls[0]![0])).toContain('lang=zh-CN');
    screen.getByText('示例家居场景：客厅与卧室，含灯、空调与演示事件。');
    // R75/F10: the card now also shows the derived-service count.
    screen.getByText('2 区域 · 3 设备 · 1 Agent · 0 派生服务');
    screen.getByText('grid');
    // R2-FEAT-09: starter-home carries the「新手推荐」badge.
    screen.getByText('新手推荐');
    // R2-FEAT-09: the active lane shows its one-line plain-language hint.
    screen.getByText(/从现成的示例世界一键创建/);

    // The card's 创建 button fetches the template then posts it as an import.
    screen.getByRole('button', { name: '创建' }).click();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe('/api/environments');
    expect(posts[0].body.meta).toEqual(TEMPLATE_JSON.meta);
    expect(posts[0].body.zones).toEqual(TEMPLATE_JSON.zones);
    expect(posts[0].body.visibility).toBe('private');
  });

  it('R2-FEAT-04: the parameterized lane takes a custom environment name', async () => {
    const posts: CapturedPost[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (init?.method === 'POST' && url === '/api/environments') {
          posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
          return jsonResponse({ id: 'env-new' });
        }
        if (init?.method === 'POST' && url === '/api/scenario-templates/flex/instantiate') {
          return jsonResponse({ ...TEMPLATE_JSON, meta: { id: 'flex', name: 'Flex Building' } });
        }
        if (url === '/api/environments' || url.startsWith('/api/environments?')) {
          return jsonResponse({ environments: [] });
        }
        if (url.startsWith('/api/scenario-templates?')) {
          return jsonResponse({
            templates: [
              {
                ...TEMPLATE_SUMMARY,
                id: 'flex',
                name: 'Flex Building',
                vars: [{ name: 'floors', label: '楼层数', type: 'int', min: 1, max: 9, default: 3 }],
              },
            ],
          });
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    renderWithProviders(<EnvironmentsHomePage />);
    (await screen.findByText('+ 新建环境')).click();
    (await screen.findByRole('button', { name: '创建' })).click();

    // The param form opens with the env-name input defaulting to the
    // template name; overriding it lands on the created instance's meta.name.
    const nameInput = (await screen.findByLabelText('环境名称')) as HTMLInputElement;
    expect(nameInput.value).toBe('Flex Building');
    fireEvent.change(nameInput, { target: { value: '我的实验楼' } });
    screen.getByRole('button', { name: '创建' }).click();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0].body.meta as Record<string, unknown>).name).toBe('我的实验楼');
  });
});

describe('Empty-state 导入 starter-home (W1b)', () => {
  it('one-click creates starter-home without opening the dialog', async () => {
    const { posts } = stubTemplateFetch();
    renderWithProviders(<EnvironmentsHomePage />);

    (await screen.findByText('导入 starter-home')).click();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.meta).toEqual(TEMPLATE_JSON.meta);
    expect(posts[0].body.visibility).toBe('private');
    // The create dialog never opened.
    expect(screen.queryByText('新建环境', { selector: '.dialog__title' })).toBeNull();
  });

  it('falls back to the import dialog when the template fetch fails', async () => {
    const { posts } = stubTemplateFetch({ failTemplate: true });
    renderWithProviders(<EnvironmentsHomePage />);

    (await screen.findByText('导入 starter-home')).click();

    // Fallback: the import dialog opens (file import field visible) and the
    // inline error explains what happened; nothing was posted.
    await screen.findByLabelText(/从文件导入/);
    await screen.findByText(/一键导入失败/);
    expect(posts).toHaveLength(0);
  });
});
