/**
 * MemberImportDialog — batch roster import (Fix-37 classroom flow) for the
 * world sidebar's 成员 tab. The teacher pastes a roster (one email per line,
 * or a CSV row paste — lib/memberRoster parses both) and submits it to
 * POST /api/environments/:id/members:batch; the per-row outcome
 * (added / already_member / invited / not_found) is listed verbatim.
 * R15-D10: unregistered emails become pending invites — the student joins
 * automatically on registration; only malformed rows read not_found.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import type { MemberBatchResult, MemberBatchStatus } from '../../api/types';
import { parseRosterEmails } from '../../lib/memberRoster';
import { Button } from '../ui/Button';

export function MemberImportDialog({
  envId,
  onClose,
  onImported,
}: {
  envId: string;
  onClose: () => void;
  /** Called after a successful import (the member list needs a refetch). */
  onImported: () => void;
}) {
  const { t } = useTranslation('world');
  const [roster, setRoster] = useState('');
  const [role, setRole] = useState<'builder' | 'viewer'>('builder');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemberBatchResult | null>(null);

  const statusLabel = (status: MemberBatchStatus): string => {
    if (status === 'added') return t('memberManage.statusAdded');
    if (status === 'already_member') return t('memberManage.statusAlready');
    if (status === 'invited') return t('memberManage.statusInvited');
    return t('memberManage.statusNotFound');
  };

  const submit = async () => {
    if (busy) return;
    const emails = parseRosterEmails(roster);
    if (emails.length === 0) {
      setError(t('memberManage.empty'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = await api.batchAddMembers(envId, { emails, role });
      setResult(body);
      if (body.summary.added > 0) onImported();
    } catch (err) {
      setError(t('memberManage.failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <h3 className="dialog__title">{t('memberManage.importTitle')}</h3>
        <p className="page-note">{t('memberManage.importHint')}</p>
        <label className="dialog-field">
          {t('memberManage.rosterLabel')}
          <textarea
            className="dialog__textarea"
            rows={8}
            value={roster}
            placeholder={t('memberManage.importPlaceholder')}
            onChange={event => setRoster(event.target.value)}
          />
        </label>
        <label className="dialog-field">
          {t('memberManage.roleLabel')}
          <select
            value={role}
            onChange={event => setRole(event.target.value as 'builder' | 'viewer')}
          >
            <option value="builder">{t('memberManage.roleBuilder')}</option>
            <option value="viewer">{t('memberManage.roleViewer')}</option>
          </select>
        </label>
        {error && <p className="auth-card__error">{error}</p>}
        {result && (
          <div className="member-import__results">
            <p className="member-import__summary">
              {(result.summary.invited ?? 0) > 0
                ? t('memberManage.summaryWithInvited', {
                    total: result.summary.total,
                    added: result.summary.added,
                    skipped: result.summary.skipped,
                    failed: result.summary.failed,
                    invited: result.summary.invited ?? 0,
                  })
                : t('memberManage.summary', {
                    total: result.summary.total,
                    added: result.summary.added,
                    skipped: result.summary.skipped,
                    failed: result.summary.failed,
                  })}
            </p>
            <ul className="member-import__rows">
              {result.results.map(row => (
                <li
                  key={row.email}
                  className={`member-import__row member-import__row--${row.status}`}
                >
                  <span className="member-import__email">{row.email}</span>
                  <span className="badge">{statusLabel(row.status)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="dialog__actions">
          <Button variant="ghost" onClick={onClose}>
            {result ? t('memberManage.close') : t('memberManage.cancel')}
          </Button>
          {!result && (
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? t('memberManage.submitting') : t('memberManage.submit')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
