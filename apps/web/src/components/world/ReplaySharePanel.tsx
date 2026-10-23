/**
 * ReplaySharePanel (R15-B1) — the world sidebar's 分享 tab: freeze a time
 * window of the environment into an anonymous read-only share link.
 *
 * Creation is member-grade (server: env read access) but public-env-only —
 * the panel explains that instead of letting the request fail. The link is
 * absolute (location.origin + sharePath) so it can be copied straight into
 * an email or a demo-day slide.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import type { EnvironmentDetail } from '../../api/types';
import type { ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';

/** datetime-local value for `ms` before now, local timezone. */
function localInputValue(msAgo: number): string {
  const date = new Date(Date.now() - msAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ReplaySharePanel({ world }: { world: EnvironmentDetail }) {
  const { t } = useTranslation('share');
  const [from, setFrom] = useState(localInputValue(3_600_000));
  const [to, setTo] = useState(localInputValue(0));
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.CreateReplayShareResult | null>(null);
  const [copied, setCopied] = useState(false);

  const isPublic = world.visibility === 'public';
  const shareUrl = result ? `${window.location.origin}${result.sharePath}` : '';

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const created = await api.createReplayShare(world.id, {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        ...(name.trim() ? { name: name.trim() } : {}),
        expiresInDays,
      });
      setResult(created);
    } catch (e) {
      const apiError = e as ApiClientError;
      setError(
        apiError.code === 'ENV_NOT_PUBLIC'
          ? t('panel.privateRejected')
          : t('panel.failed', { message: apiError.message }),
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      // Clipboard may be blocked (insecure context) — the input below still
      // lets the user select and copy manually.
    }
  };

  return (
    <div className="detail-section replay-share-panel">
      <h3 className="side-panel__title">{t('panel.title')}</h3>
      <p className="replay-share-panel__intro">{t('panel.intro')}</p>

      {!isPublic && <p className="error-banner">{t('panel.needPublic')}</p>}

      <label className="replay-share-panel__field">
        {t('panel.windowFrom')}
        <input
          type="datetime-local"
          value={from}
          onChange={event => setFrom(event.target.value)}
        />
      </label>
      <label className="replay-share-panel__field">
        {t('panel.windowTo')}
        <input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} />
      </label>
      <div className="replay-share-panel__quick">
        <Button variant="ghost" onClick={() => { setFrom(localInputValue(3_600_000)); setTo(localInputValue(0)); }}>
          {t('panel.quickLastHour')}
        </Button>
        <Button variant="ghost" onClick={() => { setFrom(localInputValue(86_400_000)); setTo(localInputValue(0)); }}>
          {t('panel.quickLastDay')}
        </Button>
      </div>
      <label className="replay-share-panel__field">
        <input
          type="text"
          placeholder={t('panel.namePlaceholder')}
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </label>
      <label className="replay-share-panel__field replay-share-panel__expires">
        {t('panel.expiresLabel')}
        <input
          type="number"
          min={1}
          max={365}
          value={expiresInDays}
          onChange={event => setExpiresInDays(Number(event.target.value) || 30)}
        />
      </label>

      <Button variant="primary" disabled={busy || !isPublic} onClick={() => void create()}>
        {busy ? t('panel.creating') : t('panel.create')}
      </Button>

      {error && <p className="error-banner">{error}</p>}

      {result && (
        <div className="replay-share-panel__result">
          <h4>{t('panel.createdTitle')}</h4>
          <input type="text" readOnly value={shareUrl} onFocus={event => event.target.select()} />
          <div className="replay-share-panel__actions">
            <Button variant="ghost" onClick={() => void copy()}>
              {copied ? t('panel.copied') : t('panel.copy')}
            </Button>
            <a className="link-button" href={result.sharePath} target="_blank" rel="noreferrer">
              {t('panel.open')}
            </a>
            <span className="replay-share-panel__expiry">
              {t('panel.expires', { date: new Date(result.expiresAt).toLocaleString() })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
