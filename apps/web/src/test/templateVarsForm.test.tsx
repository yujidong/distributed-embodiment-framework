/**
 * UX-W3 template parameter form: the create dialog's 模板 tab opens a var
 * form for parameterized templates (summary.vars) — the raw inputs are
 * range-checked (lib/templateVars.ts), then POST …/instantiate expands the
 * template and the scenario JSON is imported through POST /api/environments.
 * Non-parameterized templates keep the one-click path.
 *
 * Page-level with a stubbed fetch, same pattern as scenarioTemplates.test.tsx.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EnvironmentsHomePage } from '../pages/EnvironmentsHomePage';
import i18n from '../i18n/config';
import { defaultTemplateVarInputs, validateTemplateVarInputs } from '../lib/templateVars';
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

// --- pure validation (lib/templateVars.ts) --------------------------------

const VARS = [
  { name: 'floors', label: '楼层数', type: 'int' as const, min: 2, max: 12, default: 5 },
  { name: 'roomsPerFloor', label: '每层房间数', type: 'int' as const, min: 2, max: 20, default: 8 },
];

describe('validateTemplateVarInputs', () => {
  it('prefills defaults and accepts in-range integers', () => {
    const inputs = defaultTemplateVarInputs(VARS);
    expect(inputs).toEqual({ floors: '5', roomsPerFloor: '8' });
    const result = validateTemplateVarInputs(VARS, { ...inputs, floors: '7' });
    expect(result).toEqual({ ok: true, values: { floors: 7, roomsPerFloor: 8 } });
  });

  it('rejects non-integers and out-of-range values with the failing var named', () => {
    expect(validateTemplateVarInputs(VARS, { floors: '2.5', roomsPerFloor: '8' })).toEqual({
      ok: false,
      errors: [{ name: 'floors', reason: 'notInt' }],
    });
    expect(validateTemplateVarInputs(VARS, { floors: '99', roomsPerFloor: '1' })).toEqual({
      ok: false,
      errors: [
        { name: 'floors', reason: 'outOfRange' },
        { name: 'roomsPerFloor', reason: 'outOfRange' },
      ],
    });
  });
});

// --- page-level: card → form → instantiate → create ------------------------

const FLEX_TEMPLATE = {
  id: 'teaching-building-flex',
  name: '教学楼（可定制）',
  description: '参数化教学楼模板。',
  counts: { zones: 40, devices: 40, agents: 1, events: 0, derivedServices: 40 },
  mapType: 'grid',
  vars: VARS,
};

const EXPANDED_SCENARIO = {
  version: '1.0',
  meta: { id: 'teaching-building-flex', name: '教学楼（可定制）' },
  zones: [{ id: 'z-f1' }],
  devices: [],
  agents: [],
  events: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch() {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
      if (method === 'POST' && url === '/api/environments') return jsonResponse({ id: 'env-new' });
      if (method === 'POST' && url === '/api/scenario-templates/teaching-building-flex/instantiate') {
        return jsonResponse(EXPANDED_SCENARIO);
      }
      if (url === '/api/environments' || url.startsWith('/api/environments?')) {
        return jsonResponse({ environments: [] });
      }
      if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [FLEX_TEMPLATE] });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  );
  return calls;
}

async function openTemplateTab() {
  renderWithProviders(<EnvironmentsHomePage />);
  (await screen.findByText('+ 新建环境')).click();
  await screen.findByText('教学楼（可定制）');
}

describe('CreateEnvironmentDialog — 参数化模板 (UX-W3)', () => {
  it('marks the parameterized card, opens the var form on 创建, and instantiates before import', async () => {
    const calls = stubFetch();
    await openTemplateTab();

    // The card carries the 可定制 badge; clicking 创建 opens the form (no GET yet).
    screen.getByText('可定制');
    screen.getByRole('button', { name: '创建' }).click();
    await screen.findByText('定制「教学楼（可定制）」的规模参数');
    expect(calls.filter(c => c.url.includes('instantiate'))).toHaveLength(0);

    // Defaults prefill; override 楼层数 to 7.
    const floorsInput = screen.getByLabelText('楼层数') as HTMLInputElement;
    expect(floorsInput.value).toBe('5');
    fireEvent.change(floorsInput, { target: { value: '7' } });

    screen.getByRole('button', { name: '创建' }).click();

    // instantiate carries the caller values; the EXPANDED scenario is imported.
    await waitFor(() => {
      const instantiate = calls.find(c => c.url.includes('instantiate'));
      expect(instantiate?.method).toBe('POST');
    });
    const instantiate = calls.find(c => c.url.includes('instantiate'))!;
    expect(instantiate.body).toEqual({ values: { floors: 7, roomsPerFloor: 8 } });
    await waitFor(() => {
      const create = calls.find(c => c.method === 'POST' && c.url === '/api/environments');
      expect(create?.body?.meta).toEqual(EXPANDED_SCENARIO.meta);
    });
    const create = calls.find(c => c.method === 'POST' && c.url === '/api/environments')!;
    expect(create.body?.visibility).toBe('private');
    // GET /:id is never used on the parameterized lane.
    expect(calls.filter(c => c.url === '/api/scenario-templates/teaching-building-flex')).toHaveLength(0);
  });

  it('blocks out-of-range values client-side (no instantiate call)', async () => {
    const calls = stubFetch();
    await openTemplateTab();
    screen.getByRole('button', { name: '创建' }).click();
    await screen.findByText('定制「教学楼（可定制）」的规模参数');

    fireEvent.change(screen.getByLabelText('楼层数'), { target: { value: '99' } });
    screen.getByRole('button', { name: '创建' }).click();

    await screen.findByText('「楼层数」需在 2–12 之间。');
    expect(calls.filter(c => c.url.includes('instantiate'))).toHaveLength(0);
    expect(calls.filter(c => c.method === 'POST' && c.url === '/api/environments')).toHaveLength(0);
  });

  it('返回 restores the card list', async () => {
    stubFetch();
    await openTemplateTab();
    screen.getByRole('button', { name: '创建' }).click();
    await screen.findByText('定制「教学楼（可定制）」的规模参数');
    screen.getByRole('button', { name: '返回' }).click();
    await screen.findByText('教学楼（可定制）');
  });
});
