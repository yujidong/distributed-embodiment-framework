/**
 * Alpha invite gate (EAF_INVITE_ONLY, schema v57) — AuthPage pins:
 *
 * 1. the invite-code field renders only when the PUBLIC /api/health probe
 *    reports auth.inviteOnly (the register form must not demand a code from
 *    an open deployment);
 * 2. submitting in invite mode forwards the code to the store's register
 *    action as the 4th argument (which maps the gate's 403/410 codes to
 *    localized teaching copy — the server-side suite covers the copy).
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthPage } from '../pages/AuthPage';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

const registerMock = vi.fn().mockResolvedValue(null);

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ register: registerMock, login: vi.fn() }),
  ),
}));

let inviteOnly = true;
vi.mock('../hooks/useEnvironments', () => ({
  usePublicHealth: () => ({ data: { auth: { inviteOnly } } }),
}));

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});
afterEach(() => {
  cleanup();
  registerMock.mockClear();
});

describe('AuthPage invite-code field (alpha gate)', () => {
  it('renders the invite field when /api/health reports inviteOnly', () => {
    inviteOnly = true;
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    // (label wraps the hint text too, so locate the input by placeholder)
    expect(screen.getByText('邀请码')).toBeTruthy();
    expect(screen.getByPlaceholderText('EAF-XXXXX-XXXXX')).toBeTruthy();
  });

  it('hides the invite field on an open deployment', () => {
    inviteOnly = false;
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByLabelText('显示名称')).toBeTruthy();
    expect(screen.queryByText('邀请码')).toBeNull();
  });

  it('submit forwards the invite code to the register action', async () => {
    inviteOnly = true;
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '小王' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'super-secret' } });
    fireEvent.change(screen.getByPlaceholderText('EAF-XXXXX-XXXXX'), { target: { value: 'EAF-ABCDE-23456' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));

    await screen.findByRole('button', { name: '注册并登录' });
    expect(registerMock).toHaveBeenCalledWith('小王', 'new@example.com', 'super-secret', 'EAF-ABCDE-23456');
  });

  // R2-UX-21a / UX-R2: the form is noValidate — empty submits render inline
  // Chinese field errors instead of the browser's English bubbles, and never
  // reach the store action.
  it('blocks an empty register submit with inline localized field errors (no native bubbles)', () => {
    inviteOnly = true;
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));

    expect(registerMock).not.toHaveBeenCalled();
    expect(screen.getByText('请填写显示名称。')).toBeTruthy();
    expect(screen.getByText('请填写邮箱。')).toBeTruthy();
    expect(screen.getByText('请填写密码。')).toBeTruthy();
    expect(screen.getByText(/邀请制内测需要邀请码/)).toBeTruthy();
  });

  it('flags a malformed email and a short register password inline', () => {
    inviteOnly = false;
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '小王' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));

    expect(registerMock).not.toHaveBeenCalled();
    expect(screen.getByText(/邮箱格式不正确/)).toBeTruthy();
    expect(screen.getByText('密码至少 8 位。')).toBeTruthy();
  });

  // R2-UX-21b: editing a field clears its inline error AND the stale submit
  // banner (the banner used to survive until the next submit/mode switch).
  it('clears the submit banner and the field error as the user edits', async () => {
    inviteOnly = false;
    registerMock.mockResolvedValueOnce('邮箱已被注册');
    renderWithProviders(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    // Trigger a field error, then fix the field — its error clears at once.
    // (Once an inline error renders inside the label, label-text queries no
    // longer match exactly — locate by placeholder like the invite field.)
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
    expect(screen.getByText('请填写显示名称。')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('例如：小王'), { target: { value: '小王' } });
    expect(screen.queryByText('请填写显示名称。')).toBeNull();

    // Server failure banner…
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'dup@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位'), { target: { value: 'super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
    await screen.findByText('邮箱已被注册');
    // …clears on the next edit instead of lingering.
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'fresh@example.com' } });
    expect(screen.queryByText('邮箱已被注册')).toBeNull();
  });
});
