/**
 * Route guard tests (Batch R): the old store-`view` guardView logic now lives
 * in the router —
 * - anonymous visitors hitting a protected route land on /login;
 * - a successful login bounces back to the originally requested route;
 * - an authenticated visitor on /login is sent to the workbench;
 * - legacy `?env=<id>` share links redirect to /environments/:envId (still
 *   anonymously readable for public environments);
 * - unknown routes render the 404 page.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
  ],
};

/** Minimal-but-plausible environment detail for the world route. */
const WORLD_DETAIL = {
  id: 'env-1',
  name: '苏州公寓',
  description: '两室一厅智能公寓',
  mapType: 'grid',
  mapCenter: null,
  mapZoom: null,
  visibility: 'public',
  owner: { id: 'system', displayName: 'system' },
  myRole: null,
  viewerNotice: null,
  members: [],
  zones: [],
  devices: [],
  agents: [],
  services: [],
  events: [],
  guide: null,
  mySubscriptions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const OVERVIEW = {
  user: USER,
  environments: [],
  totals: {
    environments: 0,
    myAgents: 0,
    myDevices: 0,
    myServices: 0,
    mySubscriptions: 0,
    runningSimulations: 0,
  },
  myServices: [],
  mySubscriptions: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderAt(entry: string) {
  return renderWithProviders(<App />, { initialEntries: [entry] });
}

describe('route guards', () => {
  beforeEach(() => {
    useAppStore.setState({
      user: null,
      authChecked: false,
      simulationId: null,
      world: null,
      worldLoading: false,
      worldError: null,
      toasts: [],
    });
    // reactflow (world map canvas) measures via ResizeObserver; jsdom has
    // none — a no-op stub keeps the canvas mountable.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('redirects anonymous visitors from protected routes to /login', async () => {
    void i18n.changeLanguage('zh-CN');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401),
      ),
    );

    renderAt('/');
    expect(await screen.findByText('邮箱', undefined, { timeout: 5000 })).toBeTruthy();

    cleanup();
    useAppStore.setState({ user: null, authChecked: false });

    renderAt('/environments');
    expect(await screen.findByText('密码', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('sends a fresh login back to the originally requested route', async () => {
    void i18n.changeLanguage('en-US');
    let loggedIn = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/auth/login' && method === 'POST') {
          loggedIn = true;
          return jsonResponse({ token: 't' });
        }
        if (url === '/api/auth/me') {
          return loggedIn
            ? jsonResponse(USER)
            : jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401);
        }
        if (url === '/api/environments' || url.startsWith('/api/environments?')) return jsonResponse(ENVIRONMENTS);
        if (url.startsWith('/api/notifications')) {
          return jsonResponse({ notifications: [], unreadCount: 0 });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    const { container } = renderAt('/environments');

    // Guard bounced us to /login; sign in through the form.
    const email = await screen.findByPlaceholderText('you@example.com', {}, { timeout: 5000 });
    const password = container.querySelector('input[type="password"]');
    expect(password).toBeTruthy();
    fireEvent.change(email, { target: { value: 'a@example.com' } });
    fireEvent.change(password!, { target: { value: 'secret123' } });
    // jsdom does not fire form submit on a submit-button click.
    fireEvent.submit(container.querySelector('form')!);

    // Back on /environments with the list loaded — not on the workbench.
    // (苏州公寓 is public but not mine, so it shows under the 公开 tab.)
    (await screen.findByText('Public', undefined, { timeout: 5000 })).click();
    expect(await screen.findByText('苏州公寓', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => {
      expect(
        // R15-D2: the home fetches the full visible set (mine + public).
        vi.mocked(fetch).mock.calls.some(call => String(call[0]).startsWith('/api/environments')),
      ).toBe(true);
    });
  });

  it('redirects an authenticated visitor from /login to the workbench', async () => {
    void i18n.changeLanguage('en-US');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') return jsonResponse(USER);
        if (url === '/api/me/overview') return jsonResponse(OVERVIEW);
        if (url.startsWith('/api/notifications')) {
          return jsonResponse({ notifications: [], unreadCount: 0 });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderAt('/login');
    expect(await screen.findByText("小A's workbench", undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('redirects legacy ?env= share links to the world route (anonymous OK)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') {
          return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401);
        }
        if (url === '/api/environments/env-1') return jsonResponse(WORLD_DETAIL);
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderAt('/?env=env-1');

    // The redirect landed on /environments/env-1: the world loader fired and
    // the detail header renders the environment name.
    // Wide timeouts: flaky under turbo full-run CPU contention (R45/R46;
    // F4 实测本文件的其余 findBy 默认 1s 超时同样 flap，2026-09-03 统一
    // 加宽) — the loader chains exceed RTL's 1s default when all workspaces
    // test in parallel; always green standalone.
    await waitFor(
      () => {
        expect(
          vi.mocked(fetch).mock.calls.some(call => String(call[0]) === '/api/environments/env-1'),
        ).toBe(true);
      },
      { timeout: 5000 },
    );
    expect((await screen.findAllByText('苏州公寓', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  });

  it('renders the 404 page for unknown routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401),
      ),
    );

    renderAt('/no-such-page');
    void i18n.changeLanguage('zh-CN');
    expect(await screen.findByText('页面不存在', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('回工作台')).toBeTruthy();
  });
});
