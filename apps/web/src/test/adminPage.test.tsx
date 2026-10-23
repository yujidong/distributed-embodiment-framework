/**
 * Admin page tests: the inviteStatus derivation (same precedence as the
 * CLI's formatInvite), the admin render path (invites table + users roster),
 * the mint flow (fresh code shown for copying), the confirm-gated revoke,
 * and the non-admin 403 state (no API calls, link back to the workbench).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n/config';
import { AdminPage, inviteStatus } from '../pages/AdminPage';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders, answerConfirm } from './testUtils';

const ADMIN = {
  id: 'user-admin',
  email: 'admin@example.com',
  displayName: 'Admin One',
  createdAt: '2026-01-01T00:00:00Z',
  isAdmin: true,
};

const MEMBER = {
  id: 'user-member',
  email: 'member@example.com',
  displayName: 'Member Two',
  createdAt: '2026-01-02T00:00:00Z',
  isAdmin: false,
};

const INVITE_ACTIVE = {
  code: 'EAF-AAAAA-BBBBB',
  maxUses: 3,
  usedCount: 1,
  createdBy: 'admin@example.com',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  revokedAt: null,
};

const INVITE_REVOKED = {
  ...INVITE_ACTIVE,
  code: 'EAF-CCCCC-DDDDD',
  revokedAt: '2026-01-03T00:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Fetch mock covering the admin endpoints; records calls for assertions. */
function stubAdminFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/admin/invites' && method === 'GET') {
      return jsonResponse({ invites: [INVITE_ACTIVE, INVITE_REVOKED] });
    }
    if (url === '/api/admin/users' && method === 'GET') {
      return jsonResponse({ users: [MEMBER, ADMIN] });
    }
    if (url === '/api/admin/invites' && method === 'POST') {
      return jsonResponse({ ...INVITE_ACTIVE, code: 'EAF-NEW00-CODE0', usedCount: 0 }, 201);
    }
    if (url.includes('/revoke') && method === 'POST') {
      return jsonResponse({ ...INVITE_ACTIVE, revokedAt: '2026-01-04T00:00:00Z' });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${method} ${url}` } }, 404);
  });
}

beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

describe('inviteStatus', () => {
  it('ranks revoked > expired > exhausted > active', () => {
    const now = '2026-06-01T00:00:00Z';
    expect(inviteStatus(INVITE_ACTIVE, now)).toBe('active');
    expect(inviteStatus({ ...INVITE_ACTIVE, usedCount: 3 }, now)).toBe('exhausted');
    expect(
      inviteStatus({ ...INVITE_ACTIVE, expiresAt: '2026-01-01T00:00:00Z' }, now),
    ).toBe('expired');
    expect(inviteStatus(INVITE_REVOKED, now)).toBe('revoked');
    // Revoked wins over an expired timestamp.
    expect(
      inviteStatus({ ...INVITE_REVOKED, expiresAt: '2026-01-01T00:00:00Z' }, now),
    ).toBe('revoked');
    // A future expiry is still active.
    expect(
      inviteStatus({ ...INVITE_ACTIVE, expiresAt: '2026-12-01T00:00:00Z' }, now),
    ).toBe('active');
  });
});

describe('AdminPage', () => {
  beforeEach(() => {
    useAppStore.setState({ user: ADMIN, authChecked: true, toasts: [], confirmRequest: null });
    vi.stubGlobal('fetch', stubAdminFetch());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the invite table and the user roster for an admin', async () => {
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText('Invite codes')).toBeTruthy();
    // The heading can render before the invite rows land (async fetch) —
    // await the row content too; a bare getByText races on loaded CI runners.
    expect(await screen.findByText('EAF-AAAAA-BBBBB')).toBeTruthy();
    expect(screen.getAllByText('1/3').length).toBe(2);
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('revoked')).toBeTruthy();
    expect(screen.getByText('Registered users (2)')).toBeTruthy();
    expect(screen.getByText('member@example.com')).toBeTruthy();
    // createdBy column ×2 invites + the roster row.
    expect(screen.getAllByText('admin@example.com').length).toBe(3);
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls).toContain('/api/admin/invites');
    expect(urls).toContain('/api/admin/users');
  });

  it('mints a code and shows it prominently for copying', async () => {
    const { container } = renderWithProviders(<AdminPage />);
    await screen.findByText('Invite codes');
    // Defaults (maxUses 1, no expiry) go straight through.
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByTestId('admin-minted-code')).toBeTruthy();
    expect(screen.getByText('EAF-NEW00-CODE0')).toBeTruthy();
    const post = vi
      .mocked(fetch)
      .mock.calls.find(call => String(call[0]) === '/api/admin/invites' && call[1]?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1]?.body))).toEqual({ maxUses: 1 });
  });

  it('revokes only after the confirm dialog', async () => {
    renderWithProviders(<AdminPage />);
    await screen.findByText('EAF-AAAAA-BBBBB');
    screen.getByText('Revoke').click();
    await answerConfirm(false);
    expect(
      vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/revoke')),
    ).toBe(false);

    screen.getByText('Revoke').click();
    await answerConfirm(true);
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(call =>
          String(call[0]).includes(`/api/admin/invites/${INVITE_ACTIVE.code}/revoke`),
        ),
      ).toBe(true);
    });
  });

  it('shows the 403 state to non-admins without calling the API', async () => {
    useAppStore.setState({ user: MEMBER });
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText('Admin access required')).toBeTruthy();
    expect(screen.getByText('Back to workbench')).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
