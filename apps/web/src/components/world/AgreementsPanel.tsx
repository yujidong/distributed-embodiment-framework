/**
 * AgreementsPanel — the 合约 (agreement) sidebar tab (Fix-11 / Fix-17).
 *
 * Two mailboxes over GET /api/agreements?envId=&role=:
 * - 收件箱 (role=provider): agreements on services I provide — proposed rows
 *   carry 接受/拒绝 (decide), active rows 暂停 (suspend);
 * - 发件箱 (role=consumer): agreements I proposed/consume — active rows open
 *   the inline invoke form (action + JSON params, POST …/invocations).
 *
 * Every non-terminal row offers 终止 (terminate, either party); every row can
 * expand its usage ledger (GET …/usage, append-only metering evidence).
 * The server stays the lifecycle authority — the action gates in
 * lib/agreements only mirror its rules to avoid predictable 409s.
 *
 * UX-10: below the mailboxes, 环境合约 is the env-WIDE read-only overview
 * (?include=terminated) — every agreement visible to the caller, where
 * terminated rows of OTHER parties ride the T30 restricted view (agents +
 * outcome, no owner identities, no terms). No action buttons here.
 *
 * T-066 (surface 2): each row's 详情 button (and the notification replyHint
 * affordance, via store.selectedAgreementId) opens the AgreementDetail
 * negotiation view; the header surfaces the environment's aggregate
 * agreementTransparency.activeCount (T-060 — a count, never attributed).
 */

import { useCallback, useEffect, useState } from 'react';
import { Handshake, Receipt } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type {
  Agreement,
  AgreementListEntry,
  EnvironmentDetail,
  RestrictedAgreementView,
  UsageRecord,
} from '../../api/types';
import { isRestrictedAgreementView } from '../../api/types';
import {
  canDecide,
  canInvoke,
  canSuspend,
  canTerminate,
  counterpartyLabel,
  shortAgreementId,
  sortAgreementsForInbox,
  summarizeTerms,
} from '../../lib/agreements';
import { formatRelativeTime } from '../../lib/relativeTime';
import { useAppStore } from '../../store/useAppStore';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { useTranslation } from 'react-i18next';
import { AgreementDetail } from './AgreementDetail';

export function AgreementsPanel({ world }: { world: EnvironmentDetail }) {
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const selectedAgreementId = useAppStore(s => s.selectedAgreementId);
  const selectAgreement = useAppStore(s => s.selectAgreement);
  const { t } = useTranslation('agreements');

  const [inbox, setInbox] = useState<Agreement[] | null>(null);
  const [outbox, setOutbox] = useState<Agreement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UX-10: the env-wide read-only overview (?include=terminated) — "which
  // agreements exist in my environment". Its failures degrade to a note and
  // NEVER poison the mailbox error state above.
  const [overview, setOverview] = useState<AgreementListEntry[] | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const reloadOverview = useCallback(() => {
    api
      .listAgreements(world.id, { includeTerminated: true })
      .then(rows => {
        setOverview(rows);
        setOverviewError(null);
      })
      .catch(err => {
        setOverviewError(err instanceof Error ? err.message : String(err));
      });
  }, [world.id]);

  const reload = useCallback(async () => {
    try {
      const [provider, consumer] = await Promise.all([
        api.listAgreements(world.id, { role: 'provider' }),
        api.listAgreements(world.id, { role: 'consumer' }),
      ]);
      // Role-filtered lists are always the full party view (the restricted
      // lane only exists on role-less queries), hence the narrowing casts.
      setInbox(provider as Agreement[]);
      setOutbox(consumer as Agreement[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // Refresh the overview alongside (fire-and-forget; own error lane).
    reloadOverview();
  }, [world.id, reloadOverview]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<unknown>, failurePrefix: string) => {
    try {
      await action();
      await reload();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err);
      pushToast(`${failurePrefix}：${message}`);
    }
  };

  if (selectedAgreementId !== null) {
    return (
      <AgreementDetail
        world={world}
        agreementId={selectedAgreementId}
        onClose={() => selectAgreement(null)}
        onChanged={() => void reload()}
      />
    );
  }

  return (
    <div className="agreements-panel">
      <button className="world-sidebar__create" onClick={() => void reload()}>
        {t('refresh')}
      </button>
      {world.agreementTransparency !== undefined && (
        <p className="page-note" data-testid="agreement-transparency">
          {t('transparencyCount', { count: world.agreementTransparency.activeCount })}
        </p>
      )}
      {error && <p className="page-note page-note--error">{t('loadFailed', { error })}</p>}
      {inbox === null && outbox === null && !error && <p className="page-note">{t('loading')}</p>}
      {inbox !== null && (
        <AgreementSection
          title={t('inboxTitle')}
          emptyNote={t('inboxEmpty')}
          // R2-FEAT-03 统一口径：与治理收件箱同一「待裁决置顶 + 时间倒序」
          // ——server 列表是 created_at ASC，40 行收件箱的新待审批曾沉底。
          agreements={sortAgreementsForInbox(inbox, user?.id ?? null)}
          userId={user?.id ?? null}
          onAct={run}
        />
      )}
      {outbox !== null && (
        <AgreementSection
          title={t('outboxTitle')}
          emptyNote={t('outboxEmpty')}
          agreements={sortAgreementsForInbox(outbox, user?.id ?? null)}
          userId={user?.id ?? null}
          onAct={run}
        />
      )}
      <section className="workbench-section" data-testid="agreement-overview">
        <h4 className="workbench-section__title">
          {t('overviewTitle')}
          {overview !== null ? ` (${overview.length})` : ''}
        </h4>
        {overviewError !== null && (
          <p className="page-note">{t('overviewLoadFailed', { error: overviewError })}</p>
        )}
        {overview === null && overviewError === null && (
          <p className="page-note">{t('loading')}</p>
        )}
        {overview !== null && overview.length === 0 && (
          <EmptyState compact icon={Handshake} title={t('overviewEmpty')} />
        )}
        <div className="object-list">
          {(overview ?? []).map(entry =>
            isRestrictedAgreementView(entry) ? (
              <RestrictedOverviewRow key={entry.id} entry={entry} />
            ) : (
              <FullOverviewRow key={entry.id} agreement={entry} userId={user?.id ?? null} />
            ),
          )}
        </div>
      </section>
    </div>
  );
}

/** UX-10 overview row for a full (party) agreement — read-only, no actions. */
function FullOverviewRow({
  agreement,
  userId,
}: {
  agreement: Agreement;
  userId: string | null;
}) {
  const { t } = useTranslation('agreements');
  return (
    <div className="object-list__item agreement-row">
      <div className="agreement-row__main">
        <span className="object-list__name" title={agreement.service?.name ?? agreement.serviceId}>
          {agreement.service?.name ?? agreement.serviceId}
        </span>
        {agreement.service && <span className="chip">{agreement.service.semanticType}</span>}
        <span className="badge">{t(`status${agreement.status[0].toUpperCase()}${agreement.status.slice(1)}`)}</span>
        <span className="object-list__meta">{t('counterparty', { name: counterpartyLabel(agreement, userId) })}</span>
        <span className="object-list__meta">{summarizeTerms(agreement.terms)}</span>
      </div>
    </div>
  );
}

/**
 * UX-10 overview row for the T30 restricted view of a terminated agreement:
 * participants as AGENTS + outcome + time (no owner identities, no terms —
 * the server's anonymization 口径, never re-widened client-side).
 */
function RestrictedOverviewRow({ entry }: { entry: RestrictedAgreementView }) {
  const { t } = useTranslation('agreements');
  const outcomeKey =
    entry.outcome === 'success' || entry.outcome === 'failure' || entry.outcome === 'cancelled'
      ? entry.outcome
      : entry.outcome === 'ended-without-delivery'
        ? 'endedWithoutDelivery'
        : null;
  return (
    <div className="object-list__item agreement-row">
      <div className="agreement-row__main">
        <span className="object-list__name" title={entry.service.name ?? entry.id}>
          {entry.service.name ?? t('overviewServiceGone')}
        </span>
        <span className="badge">{t('statusTerminated')}</span>
        <span className="object-list__meta">
          {t('overviewParties', {
            consumer: entry.consumerAgentName ?? '—',
            provider: entry.providerAgentName ?? '—',
          })}
        </span>
        <span className="object-list__meta">
          {outcomeKey !== null ? t(`outcome${outcomeKey[0].toUpperCase()}${outcomeKey.slice(1)}`) : entry.outcome}
        </span>
        <span className="object-list__meta">{entry.terminatedAt}</span>
      </div>
    </div>
  );
}

function AgreementSection({
  title,
  emptyNote,
  agreements,
  userId,
  onAct,
}: {
  title: string;
  emptyNote: string;
  agreements: Agreement[];
  userId: string | null;
  onAct: (action: () => Promise<unknown>, failurePrefix: string) => Promise<void>;
}) {
  return (
    <section className="workbench-section">
      <h4 className="workbench-section__title">
        {title} ({agreements.length})
      </h4>
      {agreements.length === 0 && <EmptyState compact icon={Handshake} title={emptyNote} />}
      <div className="object-list">
        {agreements.map(agreement => (
          <AgreementRow
            key={agreement.id}
            agreement={agreement}
            userId={userId}
            onAct={onAct}
          />
        ))}
      </div>
    </section>
  );
}

function AgreementRow({
  agreement,
  userId,
  onAct,
}: {
  agreement: Agreement;
  userId: string | null;
  onAct: (action: () => Promise<unknown>, failurePrefix: string) => Promise<void>;
}) {
  const { t } = useTranslation('agreements');
  const selectAgreement = useAppStore(s => s.selectAgreement);
  const confirm = useConfirm();
  const [usage, setUsage] = useState<UsageRecord[] | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [invokeOpen, setInvokeOpen] = useState(false);

  const toggleUsage = async () => {
    if (usageOpen) {
      setUsageOpen(false);
      return;
    }
    setUsageOpen(true);
    if (usage !== null) return;
    await onAct(async () => {
      setUsage(await api.getAgreementUsage(agreement.id));
    }, t('ledgerFailed'));
  };

  return (
    <div className="object-list__item agreement-row">
      <div className="agreement-row__main">
        <span className="object-list__name" title={agreement.service?.name ?? agreement.serviceId}>
          {agreement.service?.name ?? agreement.serviceId}
        </span>
        {agreement.service && <span className="chip">{agreement.service.semanticType}</span>}
        <span className="badge">{t(`status${agreement.status[0].toUpperCase()}${agreement.status.slice(1)}`)}</span>
        <span className="object-list__meta">{t('counterparty', { name: counterpartyLabel(agreement, userId) })}</span>
        <span className="object-list__meta">{summarizeTerms(agreement.terms)}</span>
        {/* R2-FEAT-03: 重复 propose 的克隆行靠「相对时间 + 短 id」可区分
            （绝对 ISO 留在 title）。 */}
        <span className="object-list__meta" title={agreement.createdAt}>
          {formatRelativeTime(agreement.createdAt)}
        </span>
        <span className="object-list__meta agreement-row__id" title={agreement.id}>
          {shortAgreementId(agreement.id)}
        </span>
      </div>
      <div className="agreement-row__actions">
        {canDecide(agreement, userId) && (
          <>
            <button
              className="primary-button"
              onClick={() =>
                void onAct(() => api.decideAgreement(agreement.id, 'accept'), t('acceptFailed'))
              }
            >
              {t('accept')}
            </button>
            <button
              onClick={() =>
                void onAct(() => api.decideAgreement(agreement.id, 'reject'), t('rejectFailed'))
              }
            >
              {t('reject')}
            </button>
          </>
        )}
        {canSuspend(agreement, userId) && (
          <button
            onClick={() => {
              // R99 (zhao-09): suspend 不可逆——与 terminate 同款二次确认。
              void confirm({ body: t('suspendConfirm'), tone: 'warn' }).then(ok => {
                if (ok) void onAct(() => api.suspendAgreement(agreement.id), t('suspendFailed'));
              });
            }}
          >
            {t('suspend')}
          </button>
        )}
        {canInvoke(agreement, userId) && (
          <button onClick={() => setInvokeOpen(open => !open)}>
            {invokeOpen ? t('invokeHide') : t('invoke')}
          </button>
        )}
        {canTerminate(agreement, userId) && (
          <button
            className="danger-button"
            onClick={() => {
              // T9: 终止即终态（合约关系销毁）——二次确认。
              void confirm({ body: t('terminateConfirm'), tone: 'danger' }).then(ok => {
                if (ok) void onAct(() => api.terminateAgreement(agreement.id), t('terminateFailed'));
              });
            }}
          >
            {t('terminate')}
          </button>
        )}
        <button className="link-button" onClick={() => void toggleUsage()}>
          {usageOpen ? t('ledgerHide') : t('ledgerShow')}
        </button>
        <button
          className="link-button"
          data-testid="agreement-detail-open"
          onClick={() => selectAgreement(agreement.id)}
        >
          {t('detail')}
        </button>
      </div>
      {invokeOpen && <InvokeForm agreement={agreement} onDone={onAct} />}
      {usageOpen && <UsageLedger usage={usage} />}
    </div>
  );
}

function InvokeForm({
  agreement,
  onDone,
}: {
  agreement: Agreement;
  onDone: (action: () => Promise<unknown>, failurePrefix: string) => Promise<void>;
}) {
  const { t } = useTranslation('agreements');
  const [action, setAction] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = action.trim();
    if (!trimmed) {
      setResult(t('invokeActionRequired'));
      return;
    }
    let params: Record<string, unknown> | undefined;
    if (paramsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(paramsText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setResult(t('invokeParamsNotObject'));
          return;
        }
        params = parsed as Record<string, unknown>;
      } catch {
        setResult(t('invokeParamsInvalidJson'));
        return;
      }
    }
    await onDone(
      async () => {
        const outcome = await api.invokeAgreement(agreement.id, {
          action: trimmed,
          ...(params !== undefined ? { params } : {}),
        });
        setResult(
          outcome.success
            ? t('invokeSucceeded', { deviceId: outcome.deviceId })
            : t('invokeFailed', { error: outcome.error ?? 'command failed' }),
        );
      },
      t('invokeFailedPrefix'),
    );
  };

  return (
    <div className="agreement-invoke">
      <label>
        {t('invokeActionLabel')}
        <input
          value={action}
          placeholder={t('invokeActionPlaceholder')}
          onChange={event => setAction(event.target.value)}
        />
      </label>
      <label>
        {t('invokeParamsLabel')}
        <input
          value={paramsText}
          placeholder='{"brightness": 80}'
          onChange={event => setParamsText(event.target.value)}
        />
      </label>
      <button className="primary-button" onClick={() => void submit()}>
        {t('invokeSubmit')}
      </button>
      {result && <p className="page-note">{result}</p>}
    </div>
  );
}

function UsageLedger({ usage }: { usage: UsageRecord[] | null }) {
  const { t } = useTranslation('agreements');
  if (usage === null) return <p className="page-note">{t('ledgerLoading')}</p>;
  if (usage.length === 0) return <EmptyState compact icon={Receipt} title={t('ledgerEmpty')} />;
  // UX-04: the origin (v58) + source lane (v67) + metering sim (FEAT-08
  // v66) columns — the API carried origin since v58 but the ledger never
  // showed it; pre-column rows render '—' (honest absence, no backfill).
  const sourceLabel = (source: string | undefined): string =>
    source === 'manual'
      ? t('ledgerSourceManual')
      : source === 'autoTrigger'
        ? t('ledgerSourceAutoTrigger')
        : source === 'autoReset'
          ? t('ledgerSourceAutoReset')
          : '—';
  return (
    <table className="device-table agreement-usage">
      <thead>
        <tr>
          <th>{t('ledgerTHTime')}</th>
          <th>{t('ledgerTHKind')}</th>
          <th>{t('ledgerTHAction')}</th>
          <th>{t('ledgerTHQuantity')}</th>
          <th>{t('ledgerTHOutcome')}</th>
          <th>{t('ledgerTHOrigin')}</th>
          <th>{t('ledgerTHSource')}</th>
          <th>{t('ledgerTHSim')}</th>
        </tr>
      </thead>
      <tbody>
        {usage.map(record => (
          <tr key={record.id}>
            <td>{record.startedAt}</td>
            <td>{record.kind}</td>
            <td>{record.action ?? '—'}</td>
            <td>
              {record.quantity} {record.unit}
            </td>
            <td>
              {record.outcome === 'success' ? t('ledgerOutcomeSuccess') : t('ledgerOutcomeFailure')}
            </td>
            <td>{record.origin ?? '—'}</td>
            <td>{sourceLabel(record.source)}</td>
            <td>{record.simulationId ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
