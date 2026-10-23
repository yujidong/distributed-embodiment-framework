/**
 * AgreementReadPanel — the data-read screen for agreements carrying
 * terms.read (T-066 surface 3, R14 Wave-A data services).
 *
 * Renders inside AgreementDetail (consumer + active + read clause):
 * - POST /api/agreements/:id/reads (synchronous evaluation) and
 *   GET …/reads/latest (cached newest frame — the cheap path);
 * - the DataFrame: delivered fields, schemaVersion, provenance
 *   (computationKind, inputsSummary incl. the scoped device count,
 *   providerAgentId/registeredBy, computedAtWall, simTimeSec, simulationId),
 *   cached/freshnessSec states — a STALE frame looks stale;
 * - the read-quota meter mirroring the server's counting (lib/dataRead);
 * - the receipts trail (GET …/receipts, append-only settlement archive);
 * - error answers rendered VERBATIM (code + server message) plus teaching
 *   copy for the known teaching codes, with the machine fields the server
 *   attaches (limit/current, freshnessSec/minFreshnessSec,
 *   allowedFields/requestedFields, boundDevices/invalidDevices).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Receipt } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { Agreement, DataReadResult, SettlementReceipt, UsageRecord } from '../../api/types';
import { readQuotaMeter, readTermsOf } from '../../lib/dataRead';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import { DetailSection } from './DetailSection';

export function AgreementReadPanel({ agreement }: { agreement: Agreement }) {
  const { t } = useTranslation('agreementRead');
  const pushToast = useAppStore(s => s.pushToast);

  const read = readTermsOf(agreement);
  const [fieldsText, setFieldsText] = useState('');
  const [result, setResult] = useState<DataReadResult | null>(null);
  const [error, setError] = useState<ReadErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<UsageRecord[] | null>(null);
  const [receipts, setReceipts] = useState<SettlementReceipt[] | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await api.getAgreementUsage(agreement.id));
    } catch (err) {
      pushToast(`${t('usageFailed')}：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [agreement.id, pushToast, t]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const doRead = async (mode: 'fresh' | 'latest') => {
    setBusy(true);
    setError(null);
    const fields = fieldsText
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0);
    try {
      const outcome =
        mode === 'fresh'
          ? await api.readAgreementData(agreement.id, fields.length > 0 ? { fields } : {})
          : await api.readAgreementLatest(agreement.id);
      setResult(outcome);
      // A delivered read is metered — the quota meter must catch up.
      await loadUsage();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, details: err.details });
      } else {
        setError({ code: 'NETWORK_ERROR', message: String(err) });
      }
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const loadReceipts = async () => {
    try {
      setReceipts(await api.getAgreementReceipts(agreement.id));
    } catch (err) {
      pushToast(`${t('receiptsFailed')}：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const meter =
    read !== undefined
      ? readQuotaMeter(usage ?? [], read, agreement.terms.windowKind, agreement.updatedAt)
      : null;
  const allowedFields = read?.fields;

  return (
    <DetailSection title={t('title')}>
      <p className="page-note">{t('intro')}</p>
      {meter !== null && (
        <div className="read-quota" data-testid="read-quota-meter">
          <span className="read-quota__label">
            {t('quota', { used: meter.used, limit: meter.limit, sec: meter.windowSec })}
          </span>
          <span
            className={`track-record__bar ${
              meter.used >= meter.limit ? 'track-record__bar--warn' : 'track-record__bar--good'
            }`}
          >
            <span
              className="track-record__fill"
              style={{
                width: `${Math.min(100, Math.round((meter.used / Math.max(meter.limit, 1)) * 100))}%`,
              }}
            />
          </span>
        </div>
      )}
      <div className="read-controls">
        <label>
          {t('fieldsLabel')}
          <input
            value={fieldsText}
            placeholder={allowedFields ? allowedFields.join(', ') : t('fieldsPlaceholder')}
            onChange={event => setFieldsText(event.target.value)}
            data-testid="read-fields-input"
          />
        </label>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void doRead('fresh')}
          data-testid="read-now"
        >
          {t('readNow')}
        </button>
        <button disabled={busy} onClick={() => void doRead('latest')} data-testid="read-latest">
          {t('readLatest')}
        </button>
      </div>
      {error !== null && <ReadErrorBox error={error} />}
      {result !== null && <ReadResultView result={result} />}
      <div className="read-receipts">
        <button className="link-button" onClick={() => void loadReceipts()} data-testid="read-receipts-toggle">
          {t('receiptsShow')}
        </button>
        {receipts !== null &&
          (receipts.length === 0 ? (
            <EmptyState compact icon={Receipt} title={t('receiptsEmpty')} />
          ) : (
            <table className="device-table read-receipts__table" data-testid="read-receipts-table">
              <thead>
                <tr>
                  <th>{t('receiptsTHId')}</th>
                  <th>{t('receiptsTHProvider')}</th>
                  <th>{t('receiptsTHUsage')}</th>
                  <th>{t('receiptsTHCreatedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(receipt => (
                  <tr key={receipt.id}>
                    <td>{receipt.id}</td>
                    <td>{receipt.provider}</td>
                    <td>{t('receiptsUsageCount', { count: receipt.usageRecordIds.length })}</td>
                    <td>{receipt.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </DetailSection>
  );
}

/** One rendered read failure: the verbatim answer + machine fields. */
interface ReadErrorView {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function ReadErrorBox({ error }: { error: ReadErrorView }) {
  const { t } = useTranslation('agreementRead');
  const teaching = t(`help_${error.code}`, { defaultValue: '' });
  return (
    <div className="page-note page-note--error read-error" data-testid="read-error">
      <p className="read-error__code">{error.code}</p>
      <p>{error.message}</p>
      {teaching !== '' && <p className="read-error__teaching">{teaching}</p>}
      {error.details !== undefined && (
        <p className="read-error__details">{JSON.stringify(error.details)}</p>
      )}
    </div>
  );
}

function ReadResultView({ result }: { result: DataReadResult }) {
  const { t } = useTranslation('agreementRead');
  const { frame, applied } = result;
  const provenance = frame.provenance;
  return (
    <div
      className={`read-result${frame.stale ? ' read-result--stale' : ''}`}
      data-testid="read-result"
    >
      <div className="read-result__badges">
        <span className={`badge ${frame.stale ? 'badge--danger' : 'badge--ok'}`}>
          {frame.stale ? t('staleBadge') : t('freshBadge')}
        </span>
        {provenance.cached && <span className="badge badge--warn">{t('cachedBadge')}</span>}
        <span className="object-list__meta">{t('freshnessSec', { sec: frame.freshnessSec })}</span>
        <span className="object-list__meta">{t('schemaVersion', { version: frame.schemaVersion })}</span>
        {result.termsEnforced && <span className="badge badge--ok">{t('termsEnforcedBadge')}</span>}
      </div>
      {frame.stale && <p className="page-note page-note--error">{t('staleNote')}</p>}
      <table className="device-table read-frame" data-testid="read-frame">
        <thead>
          <tr>
            <th>{t('frameTHField')}</th>
            <th>{t('frameTHValue')}</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(frame.data).map(([field, value]) => (
            <tr key={field}>
              <td>{field}</td>
              <td>{value === null ? t('frameNull') : String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="read-provenance" data-testid="read-provenance">
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provComputationKind')}</span>
          {provenance.computationKind}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provInputs')}</span>
          {t('provInputsSummary', {
            zones: provenance.inputsSummary.zones,
            devices: provenance.inputsSummary.devices,
            events: provenance.inputsSummary.eventsWindowed,
          })}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provDeviceScope')}</span>
          {t('provDeviceScopeValue', { devices: provenance.inputsSummary.devices })}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provComputedAt')}</span>
          {provenance.computedAtWall}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provSim')}</span>
          {provenance.simulationId === null
            ? t('provSimCached')
            : `${provenance.simulationId} (t=${provenance.simTimeSec}s)`}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provProvider')}</span>
          {provenance.providerAgentId}
        </div>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('provRegisteredBy')}</span>
          {provenance.registeredBy}
        </div>
      </div>
      <p className="object-list__meta">
        {t('appliedFields', { fields: applied.fields.join(', ') })}
        {applied.retentionSec !== undefined ? t('appliedRetention', { sec: applied.retentionSec }) : ''}
      </p>
    </div>
  );
}
