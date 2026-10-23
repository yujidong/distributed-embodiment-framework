/**
 * Smoke tests: the app boots through the auth check — anonymous visitors are
 * routed to the login page; a valid session lands on the workbench (`/`) or
 * the environments home (`/environments`), which renders one card per
 * environment from the API. App renders routes, so tests mount it via
 * testUtils' renderWithProviders (MemoryRouter + a fresh QueryClient for the
 * TanStack Query server-state slices).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const USER = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

const ENVIRONMENTS = {
  environments: [
    {
      id: 'env-1',
      name: '苏州公寓',
      description: '两室一厅智能公寓',
      mapType: 'grid',
      visibility: 'public',
      owner: { id: 'system', displayName: 'system' },
      counts: { devices: 19, agents: 5, members: 1, services: 22 },
      myRole: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'env-2',
      name: '我的测试环境',
      description: '',
      mapType: 'grid',
      visibility: 'private',
      owner: { id: 'user-a', displayName: '小A' },
      counts: { devices: 2, agents: 1, members: 1, services: 0 },
      myRole: 'owner',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

const OVERVIEW = {
  user: USER,
  environments: [
    {
      id: 'env-2',
      name: '我的测试环境',
      mapType: 'grid',
      myRole: 'owner',
      myAgents: 1,
      myDevices: 2,
      myServices: 1,
      mySubscriptions: 1,
      runningSimulations: 0,
      runningSimulationIds: [],
      simulationCount: 0,
    },
  ],
  totals: {
    environments: 1,
    myAgents: 1,
    myDevices: 2,
    myServices: 1,
    mySubscriptions: 1,
    runningSimulations: 0,
    simulationCount: 0,
  },
  myServices: [
    {
      id: 'svc-1',
      envId: 'env-2',
      envName: '我的测试环境',
      name: '电表: energy-monitoring',
      semanticType: 'energy-monitoring',
      origin: 'derived',
    },
  ],
  mySubscriptions: [
    {
      id: 'svc-2',
      envId: 'env-2',
      envName: '我的测试环境',
      name: 'Brokerage',
      semanticType: 'energy-trading',
      provider: { agentId: 'a9', agentName: 'AgentB', ownerName: '小B' },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderApp(initialEntries: string[]) {
  return renderWithProviders(<App />, { initialEntries });
}

describe('App boot', () => {
  beforeEach(() => {
    useAppStore.setState({
      user: null,
      authChecked: false,
      simulationId: null,
      toasts: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the login page when there is no session', async () => {
    void i18n.changeLanguage('zh-CN');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') {
          return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401);
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderApp(['/']);

    expect(await screen.findByText('邮箱')).toBeTruthy();
    expect(screen.getByText('密码')).toBeTruthy();
    // Boot hit the session endpoint with cookies included.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/auth/me',
        expect.objectContaining({ credentials: 'include' }),
      );
    });
  });

  it('restores the session and renders environment cards', async () => {
    void i18n.changeLanguage('en-US');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') return jsonResponse(USER);
        if (url === '/api/environments' || url.startsWith('/api/environments?')) return jsonResponse(ENVIRONMENTS);
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderApp(['/environments']);

    // 我的 tab: only the env where I have a role.
    expect(await screen.findByText('我的测试环境')).toBeTruthy();
    expect(screen.getByText('小A')).toBeTruthy(); // header display name

    // 公开 tab: the public seed shows up with owner + counts + 加入.
    const publicTab = screen.getByText('Public');
    publicTab.click();
    expect(await screen.findByText('苏州公寓')).toBeTruthy();
    // R84 (R75-1/4): the owner line now carries the created time too — match
    // the owner prefix flexibly and pin the new suffix separately.
    expect(screen.getByText((content, element) =>
      element?.classList.contains('scenario-card__id') === true && content.startsWith('Owner: system'),
    )).toBeTruthy();
    expect(screen.getByText((content, element) =>
      element?.classList.contains('scenario-card__id') === true && content.includes('created'),
    )).toBeTruthy();
    expect(screen.getByText('19 devices')).toBeTruthy();
    expect(screen.getByText('Join')).toBeTruthy();
  });

  it('lands on the workbench (W5) and renders overview cards + sections', async () => {
    void i18n.changeLanguage('en-US');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') return jsonResponse(USER);
        if (url === '/api/me/overview') return jsonResponse(OVERVIEW);
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderApp(['/']);

    // Greeting + the env card from /me/overview (name appears in the card
    // link and again as the env label of the flat service rows).
    // Wide timeouts: under turbo full-run CPU contention the first render can
    // exceed RTL's 1s default (R46 flake — green standalone, red under load).
    expect(await screen.findByText("小A's workbench", {}, { timeout: 5000 })).toBeTruthy();
    expect((await screen.findAllByText('我的测试环境', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.getByText('2 My devices')).toBeTruthy();
    // Totals row + the two flat sections.
    expect(screen.getByText(/1 environment/)).toBeTruthy();
    expect(screen.getByText('Services I publish (1)')).toBeTruthy();
    expect(screen.getByText('Services I depend on (1)')).toBeTruthy();
    expect(screen.getByText('电表: energy-monitoring')).toBeTruthy();
    expect(screen.getByText(/AgentB \(小B\)/)).toBeTruthy();
    // The 浏览服务市场 hint + quick actions.
    expect(screen.getByText('Browse environments')).toBeTruthy();
  });
});
