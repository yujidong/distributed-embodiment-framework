/**
 * ExternalChannelPanel — the world sidebar's 对外通道 tab (R59).
 *
 * Human-grade management for the ecosystem channels R55–R58 opened:
 *
 *   API 密钥  — mint environment/service-scoped keys for OUTSIDE callers
 *               (the plaintext appears exactly once, with a copy button);
 *               list own keys with health (lastUsedAt/expiry/revoked);
 *               revoke.
 *   事件源    — the subscription direction: register a poll source
 *               (url + interval + {field} mapping), watch its health
 *               (lastStatus/lastError/lastInjected), poll-now, disable.
 *
 * Both sections tolerate failure with inline notes (a 403 for strangers
 * shows the teaching text instead of crashing the tab). Builders/owners
 * only — the routes gate the same way.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Rss } from 'lucide-react';

import * as api from '../../api/client';
import type { EnvironmentDetail } from '../../api/types';
import { EmptyState } from '../ui/EmptyState';

interface ApiKeyView {
  id: string;
  name: string;
  envId: string;
  serviceId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface EventSourceView {
  id: string;
  envId: string;
  name: string;
  url: string;
  pollIntervalSec: number;
  enabled: boolean;
  mapping: Record<string, unknown>;
  lastPollAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastInjected: number;
  createdAt: string;
}

const MAPPING_PLACEHOLDER = `{
  "itemsPath": "items",
  "type": "{alertType}",
  "zoneId": "{zone}",
  "severity": "{level}",
  "description": "{text}",
  "dedupeBy": "{id}"
}`;

function clockTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ExternalChannelPanel({ world }: { world: EnvironmentDetail }) {
  const { t } = useTranslation('externalChannel');
  const isMember = world.myRole === 'owner' || world.myRole === 'builder';

  return (
    <div className="member-list">
      <h3>{t('title')}</h3>
      <p className="page-note">{t('intro')}</p>
      {!isMember && <p className="page-note page-note--error">{t('membersOnly')}</p>}
      <ApiKeysSection envId={world.id} disabled={!isMember} />
      <EventSourcesSection envId={world.id} disabled={!isMember} />
    </div>
  );
}

function ApiKeysSection({ envId, disabled }: { envId: string; disabled: boolean }) {
  const { t } = useTranslation('externalChannel');
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [ttlDays, setTtlDays] = useState('');
  const [minted, setMinted] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    api.listApiKeys(envId)
      .then(list => { setKeys(list.keys); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [envId]);
  useEffect(reload, [reload]);

  const create = async () => {
    if (name.trim().length === 0 || disabled) return;
    try {
      const created = await api.createApiKey(envId, {
        name: name.trim(),
        ...(ttlDays.trim().length > 0 && /^\d+$/.test(ttlDays.trim()) ? { ttlDays: Number(ttlDays.trim()) } : {}),
      });
      setMinted({ key: created.key, name: created.name });
      setCopied(false);
      setName('');
      setTtlDays('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.revokeApiKey(id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="blueprint-card">
      <h4>{t('apiKeys.title')}</h4>
      <p className="page-note">{t('apiKeys.hint')}</p>
      {error !== null && <p className="page-note page-note--error">{error}</p>}
      {minted !== null && (
        <div className="api-key-minted">
          <strong>{t('apiKeys.once')}（{minted.name}）</strong>
          <code className="api-key-minted__secret">{minted.key}</code>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              void navigator.clipboard?.writeText(minted.key).then(() => setCopied(true));
            }}
          >
            {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
          </button>
        </div>
      )}
      <div className="member-list__actions-row">
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder={t('apiKeys.namePlaceholder')}
          disabled={disabled}
        />
        <input
          value={ttlDays}
          onChange={event => setTtlDays(event.target.value)}
          placeholder={t('apiKeys.ttlPlaceholder')}
          className="external-row__narrow"
          disabled={disabled}
        />
        <button type="button" className="primary-button" onClick={() => void create()} disabled={disabled || name.trim().length === 0}>
          {t('apiKeys.mint')}
        </button>
      </div>
      {keys !== null && keys.length === 0 && <EmptyState compact icon={KeyRound} title={t('apiKeys.empty')} />}
      {keys !== null && keys.map(row => (
        <div key={row.id} className="resource-row">
          <div className="external-row__main">
            <span>{row.name}</span>
            <span className="external-row__dim">
              {row.serviceId !== null ? t('apiKeys.serviceScoped') : t('apiKeys.envScoped')}
              {' · '}{t('apiKeys.lastUsed')}: {clockTime(row.lastUsedAt)}
              {row.expiresAt !== null ? ` · ${t('apiKeys.expires')}: ${clockTime(row.expiresAt)}` : ''}
            </span>
            {row.revokedAt !== null && <span className="badge badge--readonly">{t('apiKeys.revoked')}</span>}
          </div>
          {row.revokedAt === null && (
            <button type="button" className="link-button" onClick={() => void revoke(row.id)} disabled={disabled}>
              {t('apiKeys.revoke')}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function EventSourcesSection({ envId, disabled }: { envId: string; disabled: boolean }) {
  const { t } = useTranslation('externalChannel');
  const [sources, setSources] = useState<EventSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [interval, setIntervalSec] = useState('60');
  const [mapping, setMapping] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.listEventSources(envId)
      .then(list => { setSources(list.sources); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [envId]);
  useEffect(reload, [reload]);

  const create = async () => {
    if (name.trim().length === 0 || url.trim().length === 0 || disabled) return;
    let parsedMapping: Record<string, unknown> = {};
    if (mapping.trim().length > 0) {
      try {
        parsedMapping = JSON.parse(mapping) as Record<string, unknown>;
      } catch {
        setError(t('sources.mappingInvalid'));
        return;
      }
    }
    setBusy(true);
    try {
      await api.createEventSource(envId, {
        name: name.trim(),
        url: url.trim(),
        pollIntervalSec: Number(interval) >= 10 ? Number(interval) : 60,
        mapping: parsedMapping,
      });
      setName(''); setUrl(''); setMapping('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'poll' | 'toggle' | 'delete', enabled?: boolean) => {
    setBusy(true);
    try {
      if (action === 'poll') await api.pollEventSource(id);
      if (action === 'toggle') await api.patchEventSource(id, { enabled: !(enabled ?? true) });
      if (action === 'delete') await api.deleteEventSource(id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusTone = useMemo(() => (status: string | null) => {
    if (status === 'ok') return 'badge--seed';
    if (status === 'error' || status === 'partial') return 'badge--readonly';
    return '';
  }, []);

  return (
    <section className="blueprint-card">
      <h4>{t('sources.title')}</h4>
      <p className="page-note">{t('sources.hint')}</p>
      {error !== null && <p className="page-note page-note--error">{error}</p>}
      <div className="member-list__actions-col">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('sources.namePlaceholder')} disabled={disabled} />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/alerts" disabled={disabled} />
        <div className="member-list__actions-row">
          <input
            value={interval}
            onChange={e => setIntervalSec(e.target.value)}
            placeholder="60"
            className="external-row__narrow"
            disabled={disabled}
          />
          <span className="page-note">{t('sources.intervalUnit')}</span>
        </div>
        <textarea
          value={mapping}
          onChange={e => setMapping(e.target.value)}
          placeholder={MAPPING_PLACEHOLDER}
          rows={6}
          className="mapping-editor"
          disabled={disabled}
        />
        <button type="button" className="primary-button" onClick={() => void create()} disabled={disabled || busy || name.trim().length === 0 || url.trim().length === 0}>
          {t('sources.register')}
        </button>
      </div>
      {sources !== null && sources.length === 0 && <EmptyState compact icon={Rss} title={t('sources.empty')} />}
      {sources !== null && sources.map(row => (
        <div key={row.id} className="resource-row">
          <div className="external-row__main">
            <span>{row.name}</span>
            <span className="external-row__dim">{row.url}</span>
            <span className="external-row__dim">
              {t('sources.every')} {row.pollIntervalSec}s · {t('sources.injected')} {row.lastInjected}
              {row.lastStatus !== null && <span className={`badge ${statusTone(row.lastStatus)}`}>{row.lastStatus}</span>}
              {row.lastError !== null && <span className="resource-row__dim external-row__warn">{row.lastError}</span>}
            </span>
          </div>
          <div className="external-row__actions">
            <button type="button" className="link-button" onClick={() => void act(row.id, 'poll')} disabled={disabled || busy}>
              {t('sources.pollNow')}
            </button>
            <button type="button" className="link-button" onClick={() => void act(row.id, 'toggle', row.enabled)} disabled={disabled || busy}>
              {row.enabled ? t('sources.disable') : t('sources.enable')}
            </button>
            <button type="button" className="link-button" onClick={() => void act(row.id, 'delete')} disabled={disabled || busy}>
              {t('sources.delete')}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
