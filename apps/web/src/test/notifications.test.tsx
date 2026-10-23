/**
 * Notification UI tests (Fix-16 / Fix-17): the header bell's unread badge and
 * the inbox page (list, per-row 标记已读, 全部已读), driven by a stubbed
 * fetch against the real API client. Server state lives in TanStack Query
 * now, so everything mounts via testUtils' renderWithProviders (fresh
 * QueryClient + MemoryRouter); the bell poll itself is `refetchInterval`.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { NotificationBell } from '../components/NotificationBell';
import { NotificationsPage } from '../pages/NotificationsPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

// NotificationBell + NotificationsPage read the active i18next bundle; the
// assertions below mix Chinese strings (nav/badge) with English (the bell
// aria-label and the inbox actions). Pin to zh-CN so the Chinese assertions
// stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

const INBOX = {
  notifications: [
    {
      id: 'n-1',
      envId: 'env-1',
      kind: 'agreement.proposed',
      title: '有新的服务合约提案待你处理',
      body: { agreementId: 'ag-1' },
      refId: 'ag-1',
      readAt: null,
      createdAt: '2026-01-02T00:00:00Z',
    },
    {
      id: 'n-2',
      envId: 'env-1',
      kind: 'agreement.accepted',
      title: '你的服务合约已被接受',
      body: { agreementId: 'ag-2' },
      refId: 'ag-2',
      readAt: '2026-01-02T01:00:00Z',
      createdAt: '2026-01-02T00:30:00Z',
    },
    {
      // R68 ×N aggregation row: same-key repeats collapse into ONE row with
      // repeatCount — the 448-unread storm renders as a single badge.
      id: 'n-3',
      envId: 'env-1',
      kind: 'collaboration.proposal',
      title: '收到新的协作邀请',
      body: { collaborationId: 'ac-1' },
      refId: 'ac-1',
      readAt: null,
      repeatCount: 15,
      createdAt: '2026-01-02T00:45:00Z',
    },
  ],
  unreadCount: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ toasts: [] });
});

describe('NotificationBell', () => {
  it('shows the unread count badge and navigates to the inbox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ notifications: [], unreadCount: 3 })),
    );

    renderWithProviders(
      <Routes>
        <Route path="/" element={<NotificationBell />} />
        <Route path="/notifications" element={<p>通知收件箱</p>} />
      </Routes>,
    );

    const badge = await screen.findByTestId('notification-badge');
    expect(badge.textContent).toBe('3');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/notifications?unread=true&limit=1');

    screen.getByRole('button', { name: '通知' }).click();
    expect(await screen.findByText('通知收件箱')).toBeTruthy();
  });

  it('renders no badge when everything is read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ notifications: [], unreadCount: 0 })),
    );

    renderWithProviders(<NotificationBell />);

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });
});

describe('NotificationsPage', () => {
  function stubInbox() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        // T-030: the inbox is a paged query now — page 1 always asks for
        // its explicit page size (?limit=50).
        if (url === '/api/notifications?limit=50' && method === 'GET') return jsonResponse(INBOX);
        if (url === '/api/notifications/n-1/read' && method === 'POST') {
          return jsonResponse({ ...INBOX.notifications[0], readAt: '2026-01-02T02:00:00Z' });
        }
        if (url === '/api/notifications/read-all' && method === 'POST') {
          return jsonResponse({ marked: 1 });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  }

  it('lists the inbox and marks one notification read', async () => {
    stubInbox();
    renderWithProviders(<NotificationsPage />);

    expect(await screen.findByText('有新的服务合约提案待你处理')).toBeTruthy();
    expect(screen.getByText('你的服务合约已被接受')).toBeTruthy();
    expect(screen.getByText('未读 2 条')).toBeTruthy();
    // R68/R75-F5: the ×N aggregation badge — 15 repeats, ONE row.
    expect(screen.getByText('×15')).toBeTruthy();
    // The already-read row offers no 标记已读 (two unread rows do).
    expect(screen.getAllByText('标记已读').length).toBe(2);

    screen.getAllByText('标记已读')[0].click();
    await waitFor(() => {
      const readCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/notifications/n-1/read');
      expect(readCall).toBeTruthy();
    });
  });

  it('groups the inbox into 需要我处理 / 全部动态 tabs (B3)', async () => {
    stubInbox();
    renderWithProviders(<NotificationsPage />);

    // Default tab is 全部动态 — both rows show.
    expect(await screen.findByText('有新的服务合约提案待你处理')).toBeTruthy();
    expect(screen.getByText('你的服务合约已被接受')).toBeTruthy();

    // 需要我处理 keeps only the inbound request (agreement.proposed) and
    // carries the actionable-unread badge.
    const tab = screen.getByRole('button', { name: /需要我处理/ });
    expect(tab.textContent).toContain('1');
    fireEvent.click(tab);
    await waitFor(() => {
      expect(screen.queryByText('你的服务合约已被接受')).toBeNull();
    });
    expect(screen.getByText('有新的服务合约提案待你处理')).toBeTruthy();

    // Back to 全部动态 restores the full feed.
    fireEvent.click(screen.getByRole('button', { name: '全部动态' }));
    expect(screen.getByText('你的服务合约已被接受')).toBeTruthy();
  });

  it('marks everything read with the bulk action', async () => {
    stubInbox();
    renderWithProviders(<NotificationsPage />);

    // Wait for the inbox to load — 全部已读 stays disabled at 未读 0 条.
    await screen.findByText('有新的服务合约提案待你处理');
    screen.getByText('全部已读').click();
    await waitFor(() => {
      const bulkCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/notifications/read-all');
      expect(bulkCall).toBeTruthy();
    });
  });

  it('applies 标记已读 optimistically before the server responds', async () => {
    // The POST stays pending until the test releases it — any UI change
    // before that is the optimistic cache update, not a refetch.
    let releaseRead: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        // T-030: the inbox is a paged query now — page 1 always asks for
        // its explicit page size (?limit=50).
        if (url === '/api/notifications?limit=50' && method === 'GET') return jsonResponse(INBOX);
        if (url === '/api/notifications/n-1/read' && method === 'POST') {
          return new Promise<Response>(resolve => {
            releaseRead = resolve;
          });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderWithProviders(<NotificationsPage />);

    (await screen.findAllByText('标记已读'))[0].click();
    // Optimistic: the row flips to read and the counter drops while the POST
    // is still in flight (the stubbed GET would re-return unreadCount 2).
    expect(await screen.findByText('未读 1 条')).toBeTruthy();
    expect(screen.getAllByText('标记已读').length).toBe(1);

    // Release the mutation; the settled invalidate refetches from the server.
    releaseRead(jsonResponse({ ...INBOX.notifications[0], readAt: '2026-01-02T02:00:00Z' }));
    expect(await screen.findByText('未读 2 条')).toBeTruthy();
  });

  it('invalidates the bell unread-count query when a notification is read', async () => {
    // Bell + inbox share one QueryClient (as in the app shell): a read on the
    // page must re-poll the badge query via the ['notifications'] prefix.
    stubInbox();
    renderWithProviders(
      <>
        <NotificationBell />
        <NotificationsPage />
      </>,
    );

    // The bell's poll query fired once on mount.
    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(call => String(call[0]) === '/api/notifications?unread=true&limit=1'),
      ).toBe(true);
    });
    const pollsBefore = vi
      .mocked(fetch)
      .mock.calls.filter(call => String(call[0]) === '/api/notifications?unread=true&limit=1')
      .length;

    (await screen.findAllByText('标记已读'))[0].click();

    // After the mutation settles, the badge query refetches (invalidation).
    await waitFor(() => {
      const polls = vi
        .mocked(fetch)
        .mock.calls.filter(call => String(call[0]) === '/api/notifications?unread=true&limit=1')
        .length;
      expect(polls).toBeGreaterThan(pollsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // T-066 surface 1: replyHint → inline decide affordance
  // -------------------------------------------------------------------------

  it('renders replyHint as an inline decide affordance and deep-links the agreement', async () => {
    const countered = {
      id: 'n-3',
      envId: 'env-1',
      kind: 'agreement.countered',
      title: '提供方还价了，等你决定',
      body: {
        agreementId: 'ag-9',
        status: 'countered',
        replyHint: {
          endpoint: 'POST /api/agreements/ag-9/decide',
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      },
      refId: 'ag-9',
      readAt: null,
      createdAt: '2026-01-02T03:00:00Z',
    };
    const waiting = {
      id: 'n-4',
      envId: 'env-1',
      kind: 'agreement.proposed',
      title: '等对方处理的提案',
      body: {
        agreementId: 'ag-8',
        status: 'proposed',
        replyHint: {
          endpoint: 'POST /api/agreements/ag-8/decide',
          allowedDecisions: ['accept', 'reject'],
          yourMove: false,
        },
      },
      refId: 'ag-8',
      readAt: null,
      createdAt: '2026-01-02T03:30:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/notifications?limit=50' && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ notifications: [countered, waiting], unreadCount: 2 });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/" element={<NotificationsPage />} />
        <Route
          path="/environments/:envId"
          element={<p>环境页</p>}
        />
      </Routes>,
      { initialEntries: ['/'] },
    );

    // yourMove renders the decide affordance; the other side renders waiting.
    expect(await screen.findByText('← 该你操作了')).toBeTruthy();
    expect(screen.getByText('等待对方操作')).toBeTruthy();
    // R2-UX-10: 不再裸露 API 路径——行尾是产品语言的位置说明（两条合约行
    // 同一文案），原始 endpoint 只留在 title 调试面。
    expect(screen.queryByText('POST /api/agreements/ag-9/decide')).toBeNull();
    expect(screen.getAllByText('处理入口：环境 · 合约')).toHaveLength(2);

    // The direct action link focuses the agreement and opens the environment.
    screen.getByText('去处理').click();
    expect(useAppStore.getState().selectedAgreementId).toBe('ag-9');
    expect(await screen.findByText('环境页')).toBeTruthy();
    useAppStore.setState({ selectedAgreementId: null });
  });

  it('UX-W5: a proposal replyHint deep-links the governance inbox tab (?tab=governance)', async () => {
    const escalated = {
      id: 'n-5',
      envId: 'env-1',
      kind: 'proposal.escalated',
      title: '有提案待你裁决',
      body: {
        proposalId: 'p-9',
        status: 'escalated',
        replyHint: {
          endpoint: 'POST /api/proposals/p-9/decide',
          allowedDecisions: ['approved', 'rejected'],
          yourMove: true,
        },
      },
      refId: 'p-9',
      readAt: null,
      createdAt: '2026-01-02T04:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/notifications?limit=50' && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ notifications: [escalated], unreadCount: 1 });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    function EnvProbe() {
      const location = useLocation();
      return <p>环境页 {location.search}</p>;
    }
    renderWithProviders(
      <Routes>
        <Route path="/" element={<NotificationsPage />} />
        <Route path="/environments/:envId" element={<EnvProbe />} />
      </Routes>,
      { initialEntries: ['/'] },
    );

    expect(await screen.findByText('← 该你操作了')).toBeTruthy();
    // R2-UX-10: 提案 replyHint 的位置说明指向治理收件箱。
    expect(screen.getByText('处理入口：环境 · 治理收件箱')).toBeTruthy();
    screen.getByText('去处理').click();
    // The proposal decide affordance lands on the NEW governance inbox tab —
    // and does NOT arm the agreement detail focus.
    expect(await screen.findByText(/tab=governance/)).toBeTruthy();
    expect(useAppStore.getState().selectedAgreementId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T-030: load-older paging (?before= cursor, the activity feed contract)
  // -------------------------------------------------------------------------

  it('T-030: pages older notifications with the ?before= cursor (load-older)', async () => {
    // Page 1 is a FULL page (50 rows = NOTIFICATION_PAGE_SIZE) — the UI must
    // assume older rows exist behind the newest-200 clamp.
    const PAGE = 50;
    const base = Date.parse('2026-02-01T00:00:00Z');
    const page1Rows = Array.from({ length: PAGE }, (_, i) => ({
      id: `new-${i}`,
      envId: 'env-1',
      kind: 'proposal.applied',
      title: `新通知 ${i}`,
      body: {},
      refId: null,
      readAt: null,
      createdAt: new Date(base - i * 1000).toISOString(),
    }));
    const olderRows = [59, 58].map(sec => ({
      id: `old-${sec}`,
      envId: 'env-1',
      kind: 'proposal.applied',
      title: `更早的通知 ${sec}`,
      body: {},
      refId: null,
      readAt: null,
      // Strictly older than page 1's oldest row (base - 49s).
      createdAt: new Date(base - sec * 1000).toISOString(),
    }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url === '/api/notifications?limit=50') {
          return jsonResponse({ notifications: page1Rows, unreadCount: PAGE });
        }
        if (method === 'GET' && url.startsWith('/api/notifications?limit=50&before=')) {
          const cursor = decodeURIComponent(url.slice('/api/notifications?limit=50&before='.length));
          // The cursor is the createdAt of the LAST row of the previous page.
          expect(cursor).toBe(page1Rows[PAGE - 1].createdAt);
          return jsonResponse({
            notifications: olderRows.filter(row => row.createdAt < cursor),
            unreadCount: PAGE,
          });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    renderWithProviders(<NotificationsPage />);

    expect(await screen.findByText('新通知 0')).toBeTruthy();
    expect(screen.getByText('新通知 49')).toBeTruthy();
    expect(screen.queryByText('更早的通知 59')).toBeNull();

    // Full page → the load-older affordance; click pages via ?before=.
    const loadOlder = await screen.findByTestId('notifications-load-older');
    fireEvent.click(loadOlder);

    expect(await screen.findByText('更早的通知 59')).toBeTruthy();
    expect(screen.getByText('更早的通知 58')).toBeTruthy();

    // The short page ends the history — the affordance is replaced by the
    // end-of-history note.
    await waitFor(() => {
      expect(screen.queryByTestId('notifications-load-older')).toBeNull();
    });
    expect(screen.getByText('没有更早的通知了')).toBeTruthy();
  });

  it('T-030: a short first page shows no load-older affordance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          notifications: [INBOX.notifications[0]],
          unreadCount: 1,
        }),
      ),
    );

    renderWithProviders(<NotificationsPage />);

    expect(await screen.findByText('有新的服务合约提案待你处理')).toBeTruthy();
    expect(screen.queryByTestId('notifications-load-older')).toBeNull();
    expect(screen.getByText('没有更早的通知了')).toBeTruthy();
  });
});
