/**
 * SandboxPanel (R40-B3): the living-world fork surface —
 * - lists the env's sandboxes (status/owner/time) and offers 停止 for an
 *   active fork with a simulation;
 * - 采纳流配置 opens the adopt form: valid flow JSON posts an adopt-config
 *   proposal with the fork reference; invalid JSON is refused client-side;
 * - 分叉沙盒 posts {fromCheckpoint:true} (the P2F §10.1 cheap fork).
 * Requests stubbed at the fetch boundary (same pattern as
 * appOverviewGovernance.test.tsx).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, Sandbox } from '../api/types';
import { SandboxPanel } from '../components/world/SandboxPanel';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

function makeWorld(): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    visibility: 'private',
    owner: { id: 'u-owner', displayName: '王老师' },
    zones: [],
    events: [],
    devices: [],
    agents: [],
    services: [],
    members: [],
    myRole: 'owner',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as EnvironmentDetail;
}

function makeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: 'sbx-11112222',
    envId: 'env-1',
    owner: { id: 'u-owner', displayName: '王老师' },
    forkBase: {},
    lineage: {} as Sandbox['lineage'],
    status: 'active',
    simulationId: 'sim-sbx-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  } as Sandbox;
}

const calls: Array<{ url: string; method: string; body?: unknown }> = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(sandboxes: () => Sandbox[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/environments/env-1/sandboxes' && method === 'GET') {
        return jsonResponse({ sandboxes: sandboxes() });
      }
      if (url === '/api/environments/env-1/sandboxes' && method === 'POST') {
        return jsonResponse(makeSandbox(), 201);
      }
      const stop = url.match(/^\/api\/sandboxes\/([\w-]+)\/stop$/);
      if (stop && method === 'POST') {
        return jsonResponse({ id: stop[1], status: 'stopped' });
      }
      if (url === '/api/environments/env-1/proposals' && method === 'POST') {
        return jsonResponse({ id: 'prop-9', status: 'escalated' }, 201);
      }
      return jsonResponse({ error: 'unmatched', url }, 500);
    }),
  );
}

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SandboxPanel（R40-B3）', () => {
  it('lists sandboxes; an active fork offers 停止 and posts to /stop', async () => {
    stubFetch(() => [makeSandbox()]);
    renderWithProviders(<SandboxPanel world={makeWorld()} />);
    expect(await screen.findByText('sbx-1111')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/sandboxes/sbx-11112222/stop' && c.method === 'POST')).toBe(true);
    });
  });

  it('adopt: valid flow JSON submits an adopt-config proposal with the fork reference', async () => {
    stubFetch(() => [makeSandbox()]);
    renderWithProviders(<SandboxPanel world={makeWorld()} />);
    await screen.findByText('sbx-1111');
    fireEvent.click(screen.getByRole('button', { name: '采纳流配置…' }));
    const textarea = screen.getByPlaceholderText('流定义 JSON：{"name": "...", "trigger": {...}, "plan": {...}}');
    fireEvent.change(textarea, { target: { value: '{"name":"night-setback","trigger":{"kind":"schedule"},"plan":{"nodes":[]}}' } });
    fireEvent.click(screen.getByRole('button', { name: '提交采纳提案' }));
    await waitFor(() => {
      const adopt = calls.find(c => c.url === '/api/environments/env-1/proposals' && c.method === 'POST');
      expect(adopt).toBeDefined();
      expect(adopt!.body).toMatchObject({
        kind: 'adopt-config',
        payload: { sourceFork: { forkId: 'sbx-11112222', envId: 'env-1' } },
      });
    });
  });

  it('adopt: invalid JSON is refused client-side (no proposal request)', async () => {
    stubFetch(() => [makeSandbox()]);
    renderWithProviders(<SandboxPanel world={makeWorld()} />);
    await screen.findByText('sbx-1111');
    fireEvent.click(screen.getByRole('button', { name: '采纳流配置…' }));
    fireEvent.change(screen.getByPlaceholderText(/流定义 JSON/), { target: { value: 'not-json' } });
    fireEvent.click(screen.getByRole('button', { name: '提交采纳提案' }));
    // Client-side gate fires before any request: give the (absent) async
    // path a beat, then assert no proposal POST ever happened.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls.some(c => c.method === 'POST' && c.url === '/api/environments/env-1/proposals')).toBe(false);
  });

  it('fork button posts fromCheckpoint:true (P2F cheap fork)', async () => {
    stubFetch(() => []);
    renderWithProviders(<SandboxPanel world={makeWorld()} />);
    await screen.findByText('还没有沙盒。分叉一个来试验你的改动。');
    fireEvent.click(screen.getByRole('button', { name: '分叉沙盒（检查点）' }));
    await waitFor(() => {
      const fork = calls.find(c => c.url === '/api/environments/env-1/sandboxes' && c.method === 'POST');
      expect(fork).toBeDefined();
      expect(fork!.body).toEqual({ fromCheckpoint: true });
    });
  });
});
