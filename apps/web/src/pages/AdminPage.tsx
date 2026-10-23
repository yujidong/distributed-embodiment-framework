/**
 * AdminPage — /admin 平台管理面板 (invite-only alpha operations)
 *
 * Two cards over the ADMIN_EMAILS-gated API (the same endpoints the
 * `eaf admin` CLI drives):
 * - invite-code management: the full list (uses/status/expiry/creator), a
 *   mint form (maxUses default 1, expiresInDays blank = never), and a
 *   confirm-gated revoke. A freshly minted code is shown prominently for
 *   copying — the creation response is the only plaintext view.
 * - registered users: the account roster (email / displayName / registered
 *   at / isAdmin derived from ADMIN_EMAILS).
 *
 * The route is admin-only: a non-admin deep link gets a 403 state with a
 * way back to the workbench (the API would 403 anyway — this is the kind
 * copy). Loads once on mount; mint/revoke refresh the invite list in place.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Ticket, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import * as api from '../api/client';
import type { AdminUser, PlatformInvite } from '../api/types';
import { useAppStore } from '../store/useAppStore';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';

type InviteStatus = 'active' | 'exhausted' | 'expired' | 'revoked';

/** Same status precedence as the CLI's formatInvite. */
export function inviteStatus(invite: PlatformInvite, now = new Date().toISOString()): InviteStatus {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.expiresAt !== null && invite.expiresAt <= now) return 'expired';
  if (invite.usedCount >= invite.maxUses) return 'exhausted';
  return 'active';
}

const STATUS_BADGE: Record<InviteStatus, string> = {
  active: 'badge badge--ok',
  exhausted: 'badge badge--warn',
  expired: 'badge badge--warn',
  revoked: 'badge badge--danger',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AdminPage() {
  const user = useAppStore(s => s.user);
  const confirm = useConfirm();
  const { t } = useTranslation('admin');

  const [invites, setInvites] = useState<PlatformInvite[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [maxUses, setMaxUses] = useState('1');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<PlatformInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingCode, setRevokingCode] = useState<string | null>(null);

  const isAdmin = user?.isAdmin === true;

  async function load() {
    setLoadError(null);
    try {
      const [inviteList, userList] = await Promise.all([
        api.listAdminInvites(),
        api.listAdminUsers(),
      ]);
      setInvites(inviteList);
      setUsers(userList);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    if (isAdmin) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="home-page">
        <div className="empty-state">
          <p className="empty-state__title">{t('forbiddenTitle')}</p>
          <p className="empty-state__note">{t('forbiddenNote')}</p>
          <div className="empty-state__actions">
            <Link className="link-button" to="/">
              {t('backToWorkbench')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  async function onMint(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    setCopied(false);
    const uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1) {
      setActionError(t('invites.mintFailed', { error: 'maxUses >= 1' }));
      return;
    }
    const days = expiresInDays.trim() === '' ? null : Number(expiresInDays);
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      setActionError(t('invites.mintFailed', { error: 'expiresInDays >= 1' }));
      return;
    }
    setMinting(true);
    try {
      const invite = await api.createAdminInvite({
        maxUses: uses,
        ...(days !== null ? { expiresInDays: days } : {}),
      });
      setMinted(invite);
      setInvites(await api.listAdminInvites());
    } catch (error) {
      setActionError(t('invites.mintFailed', { error: errorMessage(error) }));
    } finally {
      setMinting(false);
    }
  }

  async function onRevoke(invite: PlatformInvite) {
    setActionError(null);
    if (!(await confirm({ body: t('invites.revokeConfirm', { code: invite.code }), tone: 'danger' }))) return;
    setRevokingCode(invite.code);
    try {
      await api.revokeAdminInvite(invite.code);
      setInvites(await api.listAdminInvites());
    } catch (error) {
      setActionError(t('invites.revokeFailed', { error: errorMessage(error) }));
    } finally {
      setRevokingCode(null);
    }
  }

  async function onCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (non-secure context) — the code stays
      // on screen for manual selection.
    }
  }

  return (
    <div className="home-page admin-page">
      <div className="home-toolbar">
        <div>
          <h3 className="workbench__greeting">{t('title')}</h3>
          <p className="page-note workbench__tagline">{t('subtitle')}</p>
        </div>
      </div>

      {loadError !== null && (
        <div className="page-note page-note--error">
          <p>{t('loadFailed', { error: loadError })}</p>
          <button onClick={() => void load()}>{t('retry')}</button>
        </div>
      )}
      {actionError !== null && (
        <p className="page-note page-note--error">{actionError}</p>
      )}

      <section className="workbench-section">
        <h4 className="workbench-section__title">{t('invites.title')}</h4>

        <form className="admin-mint-form" onSubmit={onMint}>
          <fieldset disabled={minting}>
            <legend>{t('invites.mintTitle')}</legend>
            <label>
              {t('invites.maxUsesLabel')}
              <input
                type="number"
                min={1}
                step={1}
                value={maxUses}
                onChange={event => setMaxUses(event.target.value)}
              />
            </label>
            <label>
              {t('invites.expiresLabel')}
              <input
                type="number"
                min={1}
                step={1}
                value={expiresInDays}
                placeholder="—"
                onChange={event => setExpiresInDays(event.target.value)}
              />
            </label>
            <button className="primary-button" type="submit" disabled={minting}>
              {minting ? t('invites.minting') : t('invites.mint')}
            </button>
          </fieldset>
        </form>

        {minted !== null && (
          <p className="page-note admin-minted" data-testid="admin-minted-code">
            {t('invites.minted')} <code className="admin-minted__code">{minted.code}</code>{' '}
            <button type="button" className="link-button" onClick={() => void onCopy(minted.code)}>
              {copied ? t('invites.copied') : t('invites.copy')}
            </button>
          </p>
        )}

        {invites !== null && invites.length === 0 && (
          <EmptyState compact icon={Ticket} title={t('invites.empty')} />
        )}
        {invites !== null && invites.length > 0 && (
          <table className="device-table admin-table">
            <thead>
              <tr>
                <th>{t('invites.colCode')}</th>
                <th>{t('invites.colUses')}</th>
                <th>{t('invites.colStatus')}</th>
                <th>{t('invites.colExpires')}</th>
                <th>{t('invites.colCreatedBy')}</th>
                <th>{t('invites.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {invites.map(invite => {
                const status = inviteStatus(invite);
                return (
                  <tr key={invite.code}>
                    <td><code>{invite.code}</code></td>
                    <td>{invite.usedCount}/{invite.maxUses}</td>
                    <td>
                      <span className={STATUS_BADGE[status]}>
                        {t(`invites.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
                      </span>
                    </td>
                    <td>{invite.expiresAt ?? t('invites.never')}</td>
                    <td>{invite.createdBy}</td>
                    <td>
                      {status !== 'revoked' && (
                        <button
                          type="button"
                          className="link-button"
                          disabled={revokingCode === invite.code}
                          onClick={() => void onRevoke(invite)}
                        >
                          {t('invites.revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="workbench-section">
        <h4 className="workbench-section__title">
          {t('users.title', { count: users?.length ?? 0 })}
        </h4>
        {users !== null && users.length === 0 && (
          <EmptyState compact icon={Users} title={t('users.empty')} />
        )}
        {users !== null && users.length > 0 && (
          <table className="device-table admin-table">
            <thead>
              <tr>
                <th>{t('users.colEmail')}</th>
                <th>{t('users.colName')}</th>
                <th>{t('users.colCreatedAt')}</th>
                <th>{t('users.colRole')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(row => (
                <tr key={row.id}>
                  <td>{row.email}</td>
                  <td>{row.displayName}</td>
                  <td>{row.createdAt}</td>
                  <td>
                    <span className={row.isAdmin ? 'badge badge--user' : 'badge'}>
                      {row.isAdmin ? t('users.roleAdmin') : t('users.roleUser')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
