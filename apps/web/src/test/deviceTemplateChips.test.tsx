/**
 * UX-W3 device-template suggestions in DeviceForm: picking a template chip
 * prefills type + capabilities (the name stays blank since R2-FEAT-08) and
 * shows the template's description/effects note; when GET
 * /api/device-templates fails the picker honestly degrades to the built-in
 * fallback wordlist (free text stays). R2-FEAT-08 also scopes the capability
 * suggestion chips to the picked type's catalog capability set.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DeviceForm } from '../components/world/DeviceForm';
import type { EnvironmentDetail } from '../api/types';
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

const WORLD = {
  id: 'env-1',
  mapType: 'grid',
  zones: [{ id: 'zone-1', name: '一楼' }],
  devices: [],
  services: [],
} as unknown as EnvironmentDetail;

const HVAC_TEMPLATE = {
  id: 'hvac',
  name: '空调机组',
  type: 'hvac',
  category: 'building',
  description: '中央空调机组，制冷与温度调节',
  capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
  defaultBehaviors: ['periodic-report'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(options: { failTemplates?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/device-templates') {
        if (options.failTemplates) {
          return jsonResponse({ error: { code: 'HTTP_ERROR', message: 'down' } }, 500);
        }
        return jsonResponse({ templates: [HVAC_TEMPLATE] });
      }
      if (url.startsWith('/api/catalog')) return jsonResponse({ models: [] });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

async function openTemplatePicker() {
  renderWithProviders(<DeviceForm world={WORLD} device={null} onClose={() => {}} />);
  screen.getByText('从设备模板选择（自动带入类型与能力）…').click();
}

describe('DeviceForm — 设备模板候选 (UX-W3)', () => {
  it('picking a template chip prefills type and capabilities (name stays blank, R2-FEAT-08)', async () => {
    stubFetch();
    await openTemplatePicker();

    const chip = await screen.findByRole('button', { name: '空调机组' });
    chip.click();

    // Type prefilled; capabilities brought in as active chips. The NAME is
    // deliberately left for the user (R2-FEAT-08: the English/template name
    // used to autofill and read as「完成」) — the picked template's own name
    // stays visible in the note below.
    await waitFor(() => {
      expect((screen.getByPlaceholderText('选择下方建议，或直接输入') as HTMLInputElement).value).toBe('hvac');
    });
    expect((screen.getByPlaceholderText('如：客厅温湿度计') as HTMLInputElement).value).toBe('');
    screen.getByRole('button', { name: /temperature-control/ });
    screen.getByRole('button', { name: /cooling/ });
    // 默认效应说明：description + defaultBehaviors。
    screen.getByText(/中央空调机组，制冷与温度调节 · periodic-report/);
  });

  it('R2-FEAT-08: a picked type scopes the capability suggestion chips to that type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/device-templates') {
          // 收窄的事实源是模板注册表的 type → capabilities 分组（两个
          // hvac 模板的并集 = 模板带入的 4 项 + set-fan-speed）。
          return jsonResponse({
            templates: [
              HVAC_TEMPLATE,
              {
                id: 'hvac-fan',
                name: '风机盘管',
                type: 'hvac',
                description: 'fan coil',
                capabilities: ['set-fan-speed', 'turn-on'],
                defaultBehaviors: [],
              },
            ],
          });
        }
        if (url.startsWith('/api/catalog')) {
          // GET /api/catalog returns a BARE array (catalog.ts listActive map).
          return jsonResponse([
            { deviceType: 'hvac', capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off', 'set-fan-speed'] },
            { deviceType: 'light', capabilities: ['set-brightness'] },
          ]);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    await openTemplatePicker();
    (await screen.findByRole('button', { name: '空调机组' })).click();

    // The template's own capabilities became active chips; the suggestion
    // row keeps only the hvac remainder — another type's slug stays out.
    await screen.findByRole('button', { name: 'set-fan-speed' });
    expect(screen.queryByRole('button', { name: 'set-brightness' })).toBeNull();
    screen.getByText(/已按类型「hvac」收窄/);
  });

  it('degrades honestly to the fallback wordlist when the API fails', async () => {
    stubFetch({ failTemplates: true });
    await openTemplatePicker();

    await screen.findByText(/设备模板目录暂不可用，已回落到内置词表/);
    // The fallback wordlist still offers picks (DEPLOY_TYPES re-shaped).
    const chip = await screen.findByRole('button', { name: '智能照明' });
    chip.click();
    await waitFor(() => {
      expect((screen.getByPlaceholderText('选择下方建议，或直接输入') as HTMLInputElement).value).toBe(
        'smart-light',
      );
    });
    screen.getByRole('button', { name: /lighting/ });
  });
});
