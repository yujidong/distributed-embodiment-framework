/**
 * UX-W5 NL one-sentence import wizard (CreateEnvironmentDialog, 一句话建环境
 * tab):
 * - an example chip fills the textarea; submit calls the NL lane and the
 *   draft lands in the shared review step;
 * - a 503 NL_IMPORT_UNAVAILABLE shows the teaching state pointing at the
 *   LLM-free IFC / OSM lanes;
 * - a 422 NL_IMPORT_NO_BUILDING keeps the server's example phrasings inline.
 *
 * Page-level with a stubbed fetch, same pattern as importWizards.test.tsx.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
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

interface NlCall {
  body: Record<string, unknown>;
}

/** Stub the API surface; the NL lane answers per `nlResponse`. */
function stubFetch(nlResponse: () => Response) {
  const nlCalls: NlCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url === '/api/environments/import-nl') {
        nlCalls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return nlResponse();
      }
      if (url === '/api/environments' || url.startsWith('/api/environments?')) {
        return jsonResponse({ environments: [] });
      }
      if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [] });
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    }),
  );
  return nlCalls;
}

async function openNlTab() {
  renderWithProviders(<EnvironmentsHomePage />);
  (await screen.findByText('+ 新建环境')).click();
  (await screen.findByRole('button', { name: '一句话建环境' })).click();
}

describe('CreateEnvironmentDialog — 一句话建环境 (UX-W5)', () => {
  it('example chip fills the textarea; submit → NL lane → shared draft review', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        draft: {
          version: '1.0',
          meta: { id: 'yi-yuan', name: '医院' },
          zones: [
            { id: 'ward-1-f0', name: '病房 1', type: 'ward', floor: 0 },
            { id: 'nurse-station-f0', name: '护士站', type: 'nurse-station', floor: 0 },
          ],
          devices: [],
          agents: [],
        },
        warnings: ['geometry auto-synthesized'],
      }),
    );
    await openNlTab();

    // The submit is disabled until there is text; the chip fills it.
    expect(screen.getByRole('button', { name: '生成草案' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感' }));
    fireEvent.click(screen.getByRole('button', { name: '生成草案' }));

    await screen.findByText(/草案「医院」/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toBe('我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感');
    // Zone-type vocabulary renders translated (UX-W5 additions).
    screen.getByText('病房');
    screen.getByText('护士站');
    // Process warnings ride the review step.
    screen.getByText(/geometry auto-synthesized/);
  });

  it('503 → teaching state; the IFC/OSM buttons switch lanes', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'NL_IMPORT_UNAVAILABLE', message: 'no LLM backend configured' } },
        503,
      ),
    );
    await openNlTab();

    fireEvent.change(screen.getByLabelText(/用一句话描述/), {
      target: { value: '2 层商场，一层餐饮一层零售' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成草案' }));

    await screen.findByText('一句话建环境需要文本 LLM');
    screen.getByText(/no LLM backend configured/);
    screen.getByRole('button', { name: '改用 OSM 导入' }).click();
    await screen.findByText('地名');
  });

  it('422 → the server example phrasings stay inline', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'NL_IMPORT_NO_BUILDING',
            message: 'no building cues — examples: "我要一个 3 层医院，每层 8 个病房"',
          },
        },
        422,
      ),
    );
    await openNlTab();

    fireEvent.change(screen.getByLabelText(/用一句话描述/), {
      target: { value: '今天天气怎么样' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成草案' }));

    await screen.findByText(/NL_IMPORT_NO_BUILDING: no building cues — examples: "我要一个 3 层医院，每层 8 个病房"/);
  });
});
