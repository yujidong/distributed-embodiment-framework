/**
 * UX-W3 floorplan import wizard (CreateEnvironmentDialog, 图纸导入 tab):
 * - a 503 FLOORPLAN_VISION_UNAVAILABLE shows the teaching state pointing at
 *   the no-LLM IFC / OSM lanes (and the buttons actually switch tabs);
 * - a 400 carrying the LLM-read scale suggestion offers「采用并重试」, which
 *   re-calls the lane with that pixelsPerMeter (the server never applies it
 *   silently — the UI echoes it back explicitly).
 *
 * Page-level with a stubbed fetch, same pattern as environmentImport.test.tsx.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

const PNG_FILE = new File([new Uint8Array([137, 80, 78, 71])], 'plan.png', { type: 'image/png' });

interface FloorplanCall {
  body: Record<string, unknown>;
}

/** Stub the API surface; the floorplan lane answers per `floorplanResponse`. */
function stubFetch(floorplanResponse: () => Response) {
  const floorplanCalls: FloorplanCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url === '/api/environments/import-floorplan') {
        floorplanCalls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return floorplanResponse();
      }
      if (url === '/api/environments' || url.startsWith('/api/environments?')) {
        return jsonResponse({ environments: [] });
      }
      if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [] });
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    }),
  );
  return floorplanCalls;
}

async function openFloorplanTab() {
  renderWithProviders(<EnvironmentsHomePage />);
  (await screen.findByText('+ 新建环境')).click();
  (await screen.findByRole('button', { name: '图纸导入' })).click();
  fireEvent.change(await screen.findByLabelText(/户型图/), { target: { files: [PNG_FILE] } });
  await screen.findByText('已选择：plan.png');
  fireEvent.change(screen.getByLabelText(/建筑 ID/), { target: { value: 'bldg-a' } });
}

describe('CreateEnvironmentDialog — 图纸导入 (UX-W3)', () => {
  it('503 → teaching state; the IFC/OSM buttons switch lanes', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'FLOORPLAN_VISION_UNAVAILABLE',
            message: 'no vision backend configured',
          },
        },
        503,
      ),
    );
    await openFloorplanTab();

    screen.getByRole('button', { name: '识别并生成草案' }).click();

    await screen.findByText('图纸识别需要视觉 LLM');
    screen.getByText(/no vision backend configured/);

    // The teaching state routes to a no-LLM lane.
    screen.getByRole('button', { name: '改用 OSM 导入' }).click();
    await screen.findByText('地名');
  });

  it('400 with an LLM-read scale suggestion → 采用并重试 re-calls with pixelsPerMeter', async () => {
    let attempts = 0;
    const calls = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(
          {
            error: {
              code: 'BAD_REQUEST',
              message:
                'a scale is required — the LLM read a scale off the drawing: 42.5 px/m; ' +
                'verify it against the drawing, then retry with "pixelsPerMeter": 42.5 to accept',
            },
          },
          400,
        );
      }
      return jsonResponse({
        draft: { version: '1.0', meta: { id: 'x', name: 'A 楼' }, zones: [], devices: [], agents: [] },
        warnings: [],
      });
    });
    await openFloorplanTab();

    screen.getByRole('button', { name: '识别并生成草案' }).click();

    // The suggestion line appears (not applied silently)…
    await screen.findByText(/LLM 从图面读出比例尺建议 42\.5 px\/m/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.pixelsPerMeter).toBeUndefined();

    // …and adopting it re-calls the lane with the scale echoed explicitly.
    screen.getByRole('button', { name: '采用并重试' }).click();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body.pixelsPerMeter).toBe(42.5);
    // Success → the shared draft review step.
    await screen.findByText(/草案「A 楼」/);
  });
});
