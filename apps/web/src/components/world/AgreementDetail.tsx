/**
 * AgreementDetail — the 合约 tab's agreement detail view (T-066 surface 2).
 *
 * Opens from a list row's 详情 button or from a notification's replyHint
 * affordance (store.selectedAgreementId). Loads the authoritative row via
 * GET /api/agreements/:id and renders the full negotiation surface:
 *
 * - status incl. `countered` + the termsEnforced badge (legacy contracts
 *   without structured clauses say so — the unrestricted hole is explicit);
 * - 原始条款 vs 还价条款 vs 生效条款 with a readable clause-level diff
 *   (lib/agreements.termsDiffLines mirrors the server's counter
 *   notification diff);
 * - actions per state + role: counter (provider, proposed), decide
 *   accept/reject (provider on proposed, CONSUMER on countered — T-059),
 *   remind (the waiting side; 429 REMIND_RATE_LIMITED renders its
 *   retryAfterSec), suspend (provider, active), terminate (either party).
 *
 * The server stays the lifecycle authority — every gate here only mirrors
 * its rules to avoid predictable 403/409s.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FileDiff, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { Agreement, AgreementTerms, EnvironmentDetail } from '../../api/types';
import {
  canCounter,
  canDecide,
  canRemind,
  canSuspend,
  canTerminate,
  counterpartyLabel,
  deciderSide,
  effectiveTermsOf,
  summarizeTerms,
  termsDiffLines,
} from '../../lib/agreements';
import { canReadAgreement } from '../../lib/dataRead';
import { useAppStore } from '../../store/useAppStore';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { DetailSection } from './DetailSection';
import { AgreementReadPanel } from './AgreementReadPanel';
import { Icon } from '../ui/Icon';

export function AgreementDetail({
  world,
  agreementId,
  onClose,
  onChanged,
}: {
  world: EnvironmentDetail;
  agreementId: string;
  onClose: () => void;
  /** Notify the owning panel to refetch its lists after a mutation. */
  onChanged: () => void;
}) {
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { t } = useTranslation('agreementDetail');
  // Shared lifecycle button copy lives in the `agreements` namespace (rows).
  const { t: ta } = useTranslation('agreements');

  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const reload = useCallback(async () => {
    try {
      setAgreement(await api.getAgreement(agreementId));
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNotFound(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [agreementId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<unknown>, failurePrefix: string) => {
    try {
      await action();
      await reload();
      onChanged();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err);
      pushToast(`${failurePrefix}：${message}`);
    }
  };

  if (notFound) {
    return (
      <div className="object-detail">
        <button className="link-button" onClick={onClose}>
          <Icon icon={ArrowLeft} size={14} /> {t('back')}
        </button>
        <p className="page-note page-note--error">{t('notFound')}</p>
      </div>
    );
  }
  if (agreement === null && error === null) return <p className="page-note">{t('loading')}</p>;
  if (agreement === null) {
    return (
      <div className="object-detail">
        <button className="link-button" onClick={onClose}>
          <Icon icon={ArrowLeft} size={14} /> {t('back')}
        </button>
        <p className="page-note page-note--error">{t('loadFailed', { error })}</p>
      </div>
    );
  }

  const userId = user?.id ?? null;
  const countered = agreement.counteredTerms ?? null;
  const diff = countered !== null ? termsDiffLines(agreement.terms, countered) : [];
  const decider = deciderSide(agreement);

  return (
    <div className="object-detail agreement-detail">
      <button className="link-button" onClick={onClose}>
        <Icon icon={ArrowLeft} size={14} /> {t('back')}
      </button>
      <h4 className="object-detail__name" data-testid="agreement-detail-name">
        {agreement.service?.name ?? agreement.serviceId}
      </h4>
      {agreement.service && <span className="chip">{agreement.service.semanticType}</span>}
      <span className={`badge ${agreement.status === 'countered' ? 'badge--warn' : ''}`}>
        {t(
          `agreements:status${agreement.status.charAt(0).toUpperCase()}${agreement.status.slice(1)}`,
        )}
      </span>
      <span
        className={`badge ${agreement.termsEnforced ? 'badge--ok' : 'badge--danger'}`}
        title={agreement.termsEnforced ? t('enforcedOnHint') : t('enforcedOffHint')}
        data-testid="agreement-terms-enforced"
      >
        {agreement.termsEnforced ? t('enforcedOn') : t('enforcedOff')}
      </span>
      <div className="object-detail__row">
        <span className="object-detail__label">{t('counterparty')}</span>
        {counterpartyLabel(agreement, userId)}
      </div>
      <div className="object-detail__row">
        <span className="object-detail__label">{t('providerAgent')}</span>
        {agreement.providerAgentName ?? agreement.providerAgentId}
      </div>
      <div className="object-detail__row">
        <span className="object-detail__label">{t('consumerAgent')}</span>
        {agreement.consumerAgentName ?? agreement.consumerAgentId ?? t('none')}
      </div>
      {/* R102 (wang-18): the reason channel — a recorded reason verbatim,
          未记录原因 otherwise (never a bare null). */}
      {(agreement.status === 'rejected' ||
        agreement.status === 'suspended' ||
        agreement.status === 'terminated') && (
        <div className="object-detail__row" data-testid="agreement-status-reason">
          <span className="object-detail__label">{t('statusReason')}</span>
          {agreement.statusReason ?? t('statusReasonNone')}
        </div>
      )}
      <div className="object-detail__row">
        <span className="object-detail__label">{t('createdAt')}</span>
        {agreement.createdAt}
      </div>
      {decider !== null && (
        <p className="page-note" data-testid="agreement-decider-note">
          {t('deciderNote', { side: t(decider === 'provider' ? 'sideProvider' : 'sideConsumer') })}
        </p>
      )}

      <DetailSection title={t('termsOriginal')}>
        <TermsTable terms={agreement.terms} />
      </DetailSection>
      {countered !== null && (
        <DetailSection title={t('termsCountered')}>
          <TermsTable terms={countered} />
          <div className="terms-diff" data-testid="agreement-terms-diff">
            <p className="terms-diff__title">{t('diffTitle')}</p>
            {diff.length === 0 && <EmptyState compact icon={FileDiff} title={t('diffEmpty')} />}
            {diff.map(line => (
              <div key={line.key} className={`terms-diff__line terms-diff__line--${line.change}`}>
                {line.change === 'added' && t('diffAdded', { key: line.key, value: line.after })}
                {line.change === 'removed' &&
                  t('diffRemoved', { key: line.key, value: line.before })}
                {line.change === 'changed' &&
                  t('diffChanged', { key: line.key, before: line.before, after: line.after })}
              </div>
            ))}
          </div>
        </DetailSection>
      )}
      <DetailSection title={t('termsEffective')}>
        <p className="page-note">{summarizeTerms(effectiveTermsOf(agreement))}</p>
        <TermsTable terms={effectiveTermsOf(agreement)} />
      </DetailSection>

      {/* R98: the callable action surface — the semantic type name is not
          necessarily a command; show what the backing device really executes
          BEFORE the first invoke fails. */}
      {agreement.callableActions !== undefined && (
        <DetailSection title={t('callableActions')}>
          {agreement.callableActions === null ? (
            <p className="page-note">{t('callableActionsUnbacked')}</p>
          ) : agreement.callableActions.length === 0 ? (
            <p className="page-note">{t('callableActionsNone')}</p>
          ) : (
            <p className="page-note" data-testid="agreement-callable-actions">
              {agreement.callableActions.join(', ')}
            </p>
          )}
          <p className="page-note">{t('callableActionsHint')}</p>
        </DetailSection>
      )}

      <RemindBlock agreement={agreement} userId={userId} />

      <div className="object-detail__actions">
        {canDecide(agreement, userId) && (
          <>
            <button
              className="primary-button"
              title={agreement.status === 'countered' ? t('decideAcceptCounteredHint') : undefined}
              onClick={() => void run(() => api.decideAgreement(agreement.id, 'accept'), t('acceptFailed'))}
            >
              {ta('accept')}
            </button>
            <button
              onClick={() => void run(() => api.decideAgreement(agreement.id, 'reject'), t('rejectFailed'))}
            >
              {ta('reject')}
            </button>
          </>
        )}
        {canSuspend(agreement, userId) && (
          <button
            onClick={() => {
              // R99 (zhao-09): suspend 不可逆——与 terminate 同款二次确认。
              void confirm({ body: ta('suspendConfirm'), tone: 'warn' }).then(ok => {
                if (ok) void run(() => api.suspendAgreement(agreement.id), t('suspendFailed'));
              });
            }}
          >
            {ta('suspend')}
          </button>
        )}
        {canTerminate(agreement, userId) && (
          <button
            className="danger-button"
            onClick={() => {
              // T9: 终止即终态（合约关系销毁）——二次确认。
              void confirm({ body: ta('terminateConfirm'), tone: 'danger' }).then(ok => {
                if (ok) void run(() => api.terminateAgreement(agreement.id), t('terminateFailed'));
              });
            }}
          >
            {ta('terminate')}
          </button>
        )}
      </div>
      {canCounter(agreement, userId) && <CounterForm agreement={agreement} run={run} />}
      {canReadAgreement(agreement, userId) && <AgreementReadPanel agreement={agreement} />}
      <AgreementInvokeSection agreement={agreement} userId={userId} world={world} />
    </div>
  );
}

/** Read-only clause table of a terms object (known keys labeled, rest raw). */
function TermsTable({ terms }: { terms: AgreementTerms }) {
  const { t } = useTranslation('agreementDetail');
  const entries = Object.entries(terms).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return <EmptyState compact icon={FileText} title={t('termsEmpty')} />;
  return (
    <div className="object-detail__state terms-table" data-testid="agreement-terms-table">
      {entries.map(([key, value]) => (
        <div key={key} className="object-detail__row">
          <span className="object-detail__label">{termsLabel(t, key)}</span>
          <span className="terms-table__value">{renderValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

function termsLabel(t: (key: string) => string, key: string): string {
  const known: Record<string, string> = {
    meteringUnit: 'termsLabelMeteringUnit',
    quotaPerWindow: 'termsLabelQuotaPerWindow',
    windowSec: 'termsLabelWindowSec',
    windowKind: 'termsLabelWindowKind',
    pricePerUnit: 'termsLabelPricePerUnit',
    priceUnit: 'termsLabelPriceUnit',
    notes: 'termsLabelNotes',
    trigger: 'termsLabelTrigger',
    action: 'termsLabelAction',
    autoReset: 'termsLabelAutoReset',
    read: 'termsLabelRead',
  };
  const path = known[key];
  return path !== undefined ? t(path) : key;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Remind — the waiting side's nudge. Kept OUTSIDE run()'s toast funnel: the
 * 429 REMIND_RATE_LIMITED answer carries machine-readable retryAfterSec and
 * renders inline (the rate window is expected, not an error to toast).
 */
function RemindBlock({
  agreement,
  userId,
}: {
  agreement: Agreement;
  userId: string | null;
}) {
  const { t } = useTranslation('agreementDetail');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canRemind(agreement, userId)) return null;

  const remind = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.remindAgreement(agreement.id);
      setNote(result.reminded ? t('remindSent') : t('remindDropped'));
    } catch (err) {
      if (
        err instanceof ApiClientError &&
        err.status === 429 &&
        typeof err.detail('retryAfterSec') === 'number'
      ) {
        setNote(t('remindLimited', { sec: err.detail('retryAfterSec') }));
      } else {
        setNote(
          err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agreement-remind" data-testid="agreement-remind">
      <button disabled={busy} onClick={() => void remind()}>
        {t('remind')}
      </button>
      {note && <p className="page-note" data-testid="agreement-remind-note">{note}</p>}
    </div>
  );
}

/** Provider's counter form: a COMPLETE terms object (same closed schema as propose). */
function CounterForm({
  agreement,
  run,
}: {
  agreement: Agreement;
  run: (action: () => Promise<unknown>, failurePrefix: string) => Promise<void>;
}) {
  const { t } = useTranslation('agreementDetail');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(agreement.terms, null, 2));
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    let terms: AgreementTerms;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setResult(t('counterNotObject'));
        return;
      }
      terms = parsed as AgreementTerms;
    } catch {
      setResult(t('counterInvalidJson'));
      return;
    }
    await run(async () => {
      await api.counterAgreement(agreement.id, terms);
      setResult(t('counterSent'));
      setOpen(false);
    }, t('counterFailed'));
  };

  return (
    <DetailSection title={t('counterSection')}>
      <p className="page-note">{t('counterPrefillNote')}</p>
      {!open && (
        <button onClick={() => setOpen(true)} data-testid="agreement-counter-toggle">
          {t('counter')}
        </button>
      )}
      {open && (
        <div className="agreement-counter">
          <label>
            {t('counterLabel')}
            <textarea
              rows={8}
              value={text}
              onChange={event => setText(event.target.value)}
              data-testid="agreement-counter-terms"
            />
          </label>
          <button className="primary-button" onClick={() => void submit()}>
            {t('counterSubmit')}
          </button>
          <button onClick={() => setOpen(false)}>{t('counterCancel')}</button>
          {result && <p className="page-note" data-testid="agreement-counter-result">{result}</p>}
        </div>
      )}
    </DetailSection>
  );
}

/**
 * Invoke stays a list-row affordance; the detail view links back to it so the
 * action inventory per state+role reads complete without duplicating the form.
 */
function AgreementInvokeSection({
  agreement,
  userId,
}: {
  agreement: Agreement;
  userId: string | null;
  world: EnvironmentDetail;
}) {
  const { t } = useTranslation('agreementDetail');
  const canInvokeHere =
    userId !== null && agreement.consumer.id === userId && agreement.status === 'active';
  if (!canInvokeHere) return null;
  return <p className="page-note">{t('invokeNote')}</p>;
}
