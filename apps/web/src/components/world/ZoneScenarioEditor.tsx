/**
 * ZoneScenarioEditor — UX-10 (pm-dev-backlog): the zone detail's baseline
 * parameter editor and scheduled-event (事件剧本) panel, so neither requires
 * editing the scenario JSON any more.
 *
 * There is no zone/event CRUD API: both live in the environment's map_data,
 * so every edit PATCHes /api/environments/:id with the single changed
 * mapData key — the server merges key-by-key (R5-F01), untouched keys
 * survive. The PATCH route is owner-only (same gate as ZonePanel), so
 * non-owners get the read-only display; the owner gets 编辑 / 删除 / 添加.
 *
 * - ZoneBaselineEditor: current baseline rows + an inline key=value editor
 *   (same row pattern as ZonePanel's creation form).
 * - ZoneScheduleEditor: the zone's scheduled events sorted by atSimTimeSec,
 *   plus delete and a small add form (type + fire time, optional
 *   parameter/value).
 */

import { useState } from 'react';
import { CalendarClock, SlidersHorizontal, X } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, EnvZone, ScenarioEvent } from '../../api/types';
import {
  BASELINE_KEY_SUGGESTIONS,
  baselineError,
  baselineToRows,
  mapDataWithEvents,
  mapDataWithUpdatedZone,
  parseBaselineValue,
  rowsToBaseline,
  type BaselineRow,
} from '../../lib/zoneForm';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { DetailSection } from './DetailSection';
import { useTranslation } from 'react-i18next';

interface ZoneEditorProps {
  world: EnvironmentDetail;
  zone: EnvZone;
}

function useEnvPatch(world: EnvironmentDetail) {
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  return {
    applyWorldMessage,
    pushToast,
    patch: async (mapData: { zones?: unknown[]; events?: unknown[] }) =>
      api.patchEnvironment(world.id, { mapData }),
  };
}

// ---------------------------------------------------------------------------
// Baseline parameters
// ---------------------------------------------------------------------------

export function ZoneBaselineEditor({ world, zone }: ZoneEditorProps) {
  const { t } = useTranslation('world');
  const { t: tz } = useTranslation('zone');
  const { applyWorldMessage, pushToast, patch } = useEnvPatch(world);
  const isOwner = world.myRole === 'owner';

  const baseline = zone.baseline ?? {};
  const entries = Object.entries(baseline);
  /** Non-null while the inline editor is open (prefilled from the zone). */
  const [rows, setRows] = useState<BaselineRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const formError = rows !== null ? baselineError(rows) : null;

  const save = async () => {
    if (rows === null) return;
    const next = rowsToBaseline(rows);
    // Spread-then-delete keeps every other zone field verbatim; an emptied
    // editor drops the key instead of persisting an empty object.
    const updated: EnvZone = { ...zone, ...(next !== undefined ? { baseline: next } : {}) };
    if (next === undefined) delete updated.baseline;
    setBusy(true);
    setSubmitError(null);
    try {
      const updatedEnv = await patch(mapDataWithUpdatedZone(world, updated));
      applyWorldMessage({
        kind: 'world',
        action: 'updated',
        objectType: 'environment',
        object: updatedEnv,
      });
      pushToast(t('zoneDetail.baselineSaved'));
      setRows(null);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailSection title={t('zoneDetail.baseline', { count: entries.length })}>
      {rows === null && (
        <>
          {entries.length === 0 && <EmptyState compact icon={SlidersHorizontal} title={t('zoneDetail.baselineEmpty')} />}
          {entries.map(([key, value]) => (
            <div key={key} className="object-detail__row">
              <span className="object-detail__label">{key}</span>
              {String(value)}
            </div>
          ))}
          {isOwner && (
            <div className="object-detail__actions">
              <button
                data-testid="zone-baseline-edit"
                onClick={() => {
                  setRows(baselineToRows(zone.baseline));
                  setSubmitError(null);
                }}
              >
                {t('zoneDetail.baselineEdit')}
              </button>
            </div>
          )}
        </>
      )}
      {rows !== null && (
        <div className="wizard__body">
          {rows.map((row, index) => (
            <div key={index} className="iface-row">
              <input
                value={row.key}
                onChange={event =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))
                }
                placeholder={tz('paramKeyPlaceholder')}
              />
              <input
                value={row.value}
                onChange={event =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))
                }
                placeholder={tz('paramValuePlaceholder')}
              />
              <button
                className="link-button"
                title={tz('paramRemove')}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <Icon icon={X} size={12} />
              </button>
            </div>
          ))}
          <div className="chip-row">
            {BASELINE_KEY_SUGGESTIONS.filter(
              key => !rows.some(row => row.key.trim() === key),
            ).map(key => (
              <button
                key={key}
                className="chip chip--button"
                title={tz('paramAddTitle')}
                onClick={() => setRows([...rows, { key, value: '' }])}
              >
                {key}
              </button>
            ))}
            <button className="link-button" onClick={() => setRows([...rows, { key: '', value: '' }])}>
              {tz('paramAdd')}
            </button>
          </div>
          {formError !== null && <p className="page-note">{formError}</p>}
          {submitError !== null && <p className="page-note--error">{submitError}</p>}
          <div className="wizard__footer">
            <button
              className="link-button"
              disabled={busy}
              onClick={() => {
                setRows(null);
                setSubmitError(null);
              }}
            >
              {tz('cancel')}
            </button>
            <span className="wizard__footer-spacer" />
            <button
              className="primary-button"
              disabled={busy || formError !== null}
              onClick={() => void save()}
            >
              {busy ? tz('submitting') : tz('save')}
            </button>
          </div>
        </div>
      )}
    </DetailSection>
  );
}

// ---------------------------------------------------------------------------
// Scheduled events (事件剧本)
// ---------------------------------------------------------------------------

/** The value input accepts numbers/booleans (baseline parsing) or a raw string. */
function parseEventValue(raw: string): number | boolean | string | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  return parseBaselineValue(text) ?? text;
}

export function ZoneScheduleEditor({ world, zone }: ZoneEditorProps) {
  const { t } = useTranslation('world');
  const { t: tz } = useTranslation('zone');
  const { applyWorldMessage, pushToast, patch } = useEnvPatch(world);
  const confirm = useConfirm();
  const isOwner = world.myRole === 'owner';

  const zoneEvents = world.events
    .filter(event => event.zoneId === zone.id)
    .sort((a, b) => (a.atSimTimeSec ?? Infinity) - (b.atSimTimeSec ?? Infinity));

  const [formOpen, setFormOpen] = useState(false);
  const [eventType, setEventType] = useState('');
  const [fireAt, setFireAt] = useState('');
  const [parameter, setParameter] = useState('');
  const [value, setValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyEvents = async (
    events: ScenarioEvent[],
    successKey: 'scheduleAdded' | 'scheduleDeleted',
  ) => {
    setBusy(true);
    try {
      const updatedEnv = await patch(mapDataWithEvents(events));
      applyWorldMessage({
        kind: 'world',
        action: 'updated',
        objectType: 'environment',
        object: updatedEnv,
      });
      pushToast(t(`zoneDetail.${successKey}`));
      return true;
    } catch (error) {
      pushToast(
        t('zoneDetail.scheduleFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addEvent = async () => {
    const type = eventType.trim();
    const atSimTimeSec = Number(fireAt.trim());
    if (type.length === 0 || fireAt.trim().length === 0 || !Number.isFinite(atSimTimeSec) || atSimTimeSec < 0) {
      setFormError(t('zoneDetail.scheduleFormError'));
      return;
    }
    const parsedValue = parseEventValue(value);
    const event: ScenarioEvent = {
      // UI-authored id — unique enough within an env (zone + wall clock).
      id: `ui-${zone.id}-${Date.now().toString(36)}`,
      type,
      zoneId: zone.id,
      atSimTimeSec,
      ...(parameter.trim().length > 0 ? { parameter: parameter.trim() } : {}),
      ...(parsedValue !== undefined ? { value: parsedValue } : {}),
    } as ScenarioEvent;
    const ok = await applyEvents([...world.events, event], 'scheduleAdded');
    if (ok) {
      setFormOpen(false);
      setEventType('');
      setFireAt('');
      setParameter('');
      setValue('');
      setFormError(null);
    }
  };

  const removeEvent = async (event: ScenarioEvent) => {
    if (!(await confirm({ body: t('zoneDetail.scheduleDeleteConfirm', { id: event.id }), tone: 'danger' }))) return;
    await applyEvents(world.events.filter(existing => existing.id !== event.id), 'scheduleDeleted');
  };

  return (
    <DetailSection title={t('zoneDetail.schedule', { count: zoneEvents.length })}>
      {zoneEvents.length === 0 && <EmptyState compact icon={CalendarClock} title={t('zoneDetail.scheduleEmpty')} />}
      {zoneEvents.map(event => (
        <div key={event.id} className="object-detail__row" data-testid="zone-schedule-row">
          <span className="object-detail__label">
            {event.atSimTimeSec !== undefined ? `t=${event.atSimTimeSec}s` : '—'}
          </span>
          <span>
            {event.type}
            {event.parameter !== undefined
              ? ` · ${event.parameter}${event.value !== undefined ? `=${String(event.value)}` : ''}`
              : ''}
          </span>
          {isOwner && (
            <button
              className="link-button"
              disabled={busy}
              onClick={() => void removeEvent(event)}
            >
              {t('zoneDetail.scheduleDelete')}
            </button>
          )}
        </div>
      ))}
      {isOwner && !formOpen && (
        <div className="object-detail__actions">
          <button data-testid="zone-schedule-add" onClick={() => setFormOpen(true)}>
            {t('zoneDetail.scheduleAdd')}
          </button>
        </div>
      )}
      {isOwner && formOpen && (
        <div className="wizard__body">
          <label className="form-field">
            <span className="form-field__label">{t('zoneDetail.scheduleTypeLabel')}</span>
            <input
              value={eventType}
              onChange={event => setEventType(event.target.value)}
              placeholder={t('zoneDetail.scheduleTypePlaceholder')}
            />
          </label>
          <label className="form-field">
            <span className="form-field__label">{t('zoneDetail.scheduleTimeLabel')}</span>
            <input
              value={fireAt}
              onChange={event => setFireAt(event.target.value)}
              placeholder={t('zoneDetail.scheduleTimePlaceholder')}
              inputMode="numeric"
            />
          </label>
          <div className="iface-row">
            <input
              value={parameter}
              onChange={event => setParameter(event.target.value)}
              placeholder={tz('paramKeyPlaceholder')}
            />
            <input
              value={value}
              onChange={event => setValue(event.target.value)}
              placeholder={tz('paramValuePlaceholder')}
            />
          </div>
          {formError !== null && <p className="page-note">{formError}</p>}
          <div className="wizard__footer">
            <button
              className="link-button"
              disabled={busy}
              onClick={() => {
                setFormOpen(false);
                setFormError(null);
              }}
            >
              {tz('cancel')}
            </button>
            <span className="wizard__footer-spacer" />
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void addEvent()}
            >
              {busy ? tz('submitting') : t('zoneDetail.scheduleSubmit')}
            </button>
          </div>
        </div>
      )}
    </DetailSection>
  );
}
