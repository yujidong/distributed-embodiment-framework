/**
 * B2 scenario-file import (CreateEnvironmentDialog, import mode): picking a
 * local .json file fills the scenario-JSON textarea (still editable before
 * submit), and a file that fails to read surfaces the inline error.
 *
 * Driven against the real page with a stubbed fetch (empty environment list
 * → open the create dialog from the toolbar and switch to the 导入场景 JSON
 * tab; W1b made 模板 the default tab), same pattern as
 * notifications.test.tsx.
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

const SCENARIO_JSON = '{"version":"1.0","meta":{"id":"demo","name":"demo"}}';

function makeFile(content: string | Error): File {
  const file = new File(
    [content instanceof Error ? '' : content],
    'scenario.json',
    { type: 'application/json' },
  );
  // jsdom's File lacks .text(); the app calls it, so stub it deterministically.
  Object.defineProperty(file, 'text', {
    value: content instanceof Error ? () => Promise.reject(content) : () => Promise.resolve(content),
  });
  return file;
}

async function openImportDialog() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // The dialog's default 模板 tab fires this on open — answer it too.
      if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [] });
      return jsonResponse({ environments: [] });
    }),
  );
  renderWithProviders(<EnvironmentsHomePage />);
  (await screen.findByText('+ 新建环境')).click();
  (await screen.findByRole('button', { name: '导入场景 JSON' })).click();
  return {
    fileInput: await screen.findByLabelText(/从文件导入/),
    textarea: screen.getByPlaceholderText(/"version":"1\.0"/) as HTMLTextAreaElement,
  };
}

describe('CreateEnvironmentDialog — file import (B2)', () => {
  it('loads the picked .json file into the scenario textarea', async () => {
    const { fileInput, textarea } = await openImportDialog();

    fireEvent.change(fileInput, { target: { files: [makeFile(SCENARIO_JSON)] } });

    await waitFor(() => expect(textarea.value).toBe(SCENARIO_JSON));
    // The text stays editable — the submit path is unchanged (JSON.parse on
    // the textarea content).
    fireEvent.change(textarea, { target: { value: '{"version":"1.0"}' } });
    expect(textarea.value).toBe('{"version":"1.0"}');
  });

  it('shows an inline error when the file cannot be read', async () => {
    const { fileInput } = await openImportDialog();

    fireEvent.change(fileInput, { target: { files: [makeFile(new Error('boom'))] } });

    expect(await screen.findByText('文件读取失败，请重试或手动粘贴 JSON。')).toBeTruthy();
  });

  it('does nothing when the picker is cancelled (no file)', async () => {
    const { fileInput, textarea } = await openImportDialog();

    fireEvent.change(fileInput, { target: { files: [] } });

    expect(textarea.value).toBe('');
    expect(screen.queryByText('文件读取失败，请重试或手动粘贴 JSON。')).toBeNull();
  });

  it('R2-UX-25: a validation 400 folds the first issue into the headline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (init?.method === 'POST' && url === '/api/environments') {
          return jsonResponse(
            {
              error: {
                code: 'SCENARIO_VALIDATION_FAILED',
                message: 'Scenario validation failed',
                issues: ['/zones: must be array', '/meta: must be object'],
              },
            },
            400,
          );
        }
        if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [] });
        return jsonResponse({ environments: [] });
      }),
    );
    renderWithProviders(<EnvironmentsHomePage />);
    (await screen.findByText('+ 新建环境')).click();
    (await screen.findByRole('button', { name: '导入场景 JSON' })).click();
    const textarea = (await screen.findByPlaceholderText(/"version":"1\.0"/)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"version":"1.0"}' } });
    screen.getByRole('button', { name: '导入' }).click();

    // 首行即见首条 issue（此前只有一句笼统的 "Scenario validation failed"），
    // 完整列表仍在下方逐条渲染。
    await screen.findByText(/SCENARIO_VALIDATION_FAILED: Scenario validation failed — \/zones: must be array/);
    screen.getByText('/meta: must be object');
  });
});
