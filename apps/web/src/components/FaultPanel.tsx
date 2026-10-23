/**
 * FaultPanel — 故障 section of the sim console right drawer (P3d).
 *
 * Device select → fault form (offline toggle / failureRate slider 0-100% /
 * latencyMs input / staleState toggle) → PUT /simulations/:id/faults/:deviceId.
 * Active faults (snapshot-driven) render below with badges
 * (离线 / 间歇失败 30% / 延迟 500ms / 状态冻结) and a one-click 清除.
 * The server is authoritative: the list refreshes from the snapshot poll;
 * API errors render inline with their code.
 *
 * T-027: the device dropdown only offers devices in THIS simulation
 * (scenario ∩ snapshot) — zone-scoped sims otherwise default to the full
 * world's first device and submit a 404 DEVICE_NOT_FOUND on arrival. The
 * selection follows the scope and submit re-validates with teaching copy.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { ScenarioDefinition } from '../api/types';
import { deviceInSnapshot, scopedDevices } from '../lib/consoleScope';
import {
  EMPTY_FAULT_FORM,
  faultBadges,
  serializeFaultForm,
  type FaultFormState,
} from '../lib/faults';
import { useAppStore } from '../store/useAppStore';

export interface FaultPanelProps {
  scenario: ScenarioDefinition;
}

export function FaultPanel({ scenario }: FaultPanelProps) {
  const simulationId = useAppStore(s => s.simulationId);
  const snapshot = useAppStore(s => s.snapshot);
  const snapshotState = snapshot?.state ?? null;
  const snapshotDevices = snapshot?.devices ?? null;
  const { t } = useTranslation('faultPanel');

  const [form, setForm] = useState<FaultFormState>(EMPTY_FAULT_FORM);
  const [deviceId, setDeviceId] = useState(scenario.devices[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // T-027: only devices THIS sim can see (snapshot = ground truth); the
  // selection sync below re-defaults stale full-world picks.
  const deviceOptions = useMemo(
    () => scopedDevices(scenario.devices, snapshot),
    [scenario.devices, snapshot],
  );

  useEffect(() => {
    if (snapshot === null) return;
    if (deviceOptions.some(device => device.id === deviceId)) return;
    setDeviceId(deviceOptions[0]?.id ?? '');
  }, [deviceOptions, deviceId, snapshot]);

  const stopped = snapshotState === 'stopped';

  const activeFaults = useMemo(
    () => (snapshotDevices ?? []).filter(d => d.fault != null),
    [snapshotDevices],
  );

  const update = (patch: Partial<FaultFormState>) => {
    setForm(current => ({ ...current, ...patch }));
    setError(null);
  };

  const submit = async () => {
    if (!simulationId || busy) return;
    if (!deviceId) {
      setError(t('deviceRequired'));
      return;
    }
    // T-027: teach, never send — a device outside the sim's world is a 404
    // DEVICE_NOT_FOUND at the engine, not a platform bug.
    if (!deviceInSnapshot(snapshot, deviceId)) {
      const device = scenario.devices.find(d => d.id === deviceId);
      setError(t('deviceOutOfScope', { device: device?.name ?? deviceId }));
      return;
    }
    const profile = serializeFaultForm(form);
    if (!profile) {
      setError(t('invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await api.setDeviceFault(simulationId, deviceId, profile);
      setConfirmation(t('injected', { deviceId }));
    } catch (err) {
      // T-009: English API payload — localized framing (client-side checks
      // above set already-localized t('deviceRequired')/t('invalid')).
      setError(
        t('actionFailed', {
          error: err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const clearFault = async (targetDeviceId: string) => {
    if (!simulationId || busy) return;
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await api.clearDeviceFault(simulationId, targetDeviceId);
      setConfirmation(t('cleared', { deviceId: targetDeviceId }));
    } catch (err) {
      setError(
        t('actionFailed', {
          error: err instanceof ApiClientError ? `${err.code}: ${err.message}` : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="live-panel inject-panel fault-panel">
      <h3 className="side-panel__title">{t('title')}</h3>
      <div className="inject-panel__form">
        <label>
          {t('deviceLabel')}
          <select value={deviceId} onChange={event => setDeviceId(event.target.value)}>
            {deviceOptions.map(device => (
              <option key={device.id} value={device.id}>
                {device.name} · {device.id}
              </option>
            ))}
          </select>
        </label>
        <label className="fault-panel__toggle">
          <input
            type="checkbox"
            checked={form.offline}
            onChange={event => update({ offline: event.target.checked })}
          />
          {t('offlineLabel')}
        </label>
        <label>
          {t('intermittentLabel', { n: form.failureRatePct })}
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={form.failureRatePct}
            onChange={event => update({ failureRatePct: Number(event.target.value) })}
          />
        </label>
        <label>
          {t('latencyLabel')}
          <input
            type="number"
            min={0}
            value={form.latencyMsText}
            placeholder={t('latencyPlaceholder')}
            onChange={event => update({ latencyMsText: event.target.value })}
          />
        </label>
        <label className="fault-panel__toggle">
          <input
            type="checkbox"
            checked={form.staleState}
            onChange={event => update({ staleState: event.target.checked })}
          />
          {t('staleStateLabel')}
        </label>
        <button
          className="primary-button"
          disabled={busy || !simulationId || stopped}
          onClick={() => void submit()}
        >
          {t('submit')}
        </button>
        {confirmation && <p className="inject-panel__confirmation">{confirmation}</p>}
        {error && <p className="inject-panel__error">{error}</p>}
      </div>

      {activeFaults.length > 0 && (
        <div className="fault-panel__active">
          <span className="agent-card__label">{t('activeFaults', { count: activeFaults.length })}</span>
          {activeFaults.map(device => (
            <div key={device.id} className="fault-panel__active-item">
              <div className="fault-panel__active-head">
                <span className="fault-panel__device">{device.name}</span>
                <button
                  className="link-button"
                  disabled={busy}
                  onClick={() => void clearFault(device.id)}
                >
                  {t('clear')}
                </button>
              </div>
              <div className="fault-panel__badges">
                {faultBadges(device.fault!).map(badge => (
                  <span key={badge.key} className="badge badge--fault">
                    {badge.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
