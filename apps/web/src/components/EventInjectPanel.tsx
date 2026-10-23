/**
 * EventInjectPanel — console sidebar form for POST /simulations/:id/events.
 *
 * Preset event types auto-suggest parameter+value (mirroring the engine's
 * EVENT_TYPE_DEFAULTS, extended for co2/light); everything stays editable —
 * "custom" allows a free-text type. The server is authoritative: the result
 * (targetAgentIds) is shown as an inline confirmation, API errors (e.g.
 * UNKNOWN_ZONE) render inline with their code.
 *
 * T-027: the zone dropdown only offers zones that exist in THIS simulation
 * (scenario ∩ snapshot) — the console scenario is rebuilt from the FULL
 * environment, but a zone-scoped sim (zoneIds subset) would otherwise offer
 * out-of-scope targets that fail with a raw UNKNOWN_ZONE on first submit.
 * The selection follows the scope (stale picks are re-defaulted) and submit
 * re-validates against the snapshot with teaching copy, not the engine 400.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { ScenarioDefinition } from '../api/types';
import { scopedZones, zoneInSnapshot } from '../lib/consoleScope';
import { QUICK_EVENT_PRESETS } from '../lib/eventPresets';
import type { EventQuickPreset } from '../lib/eventPresets';
import { useAppStore } from '../store/useAppStore';

interface Preset {
  type: string;
  /** i18n key under eventInject.presets for the dropdown label. */
  labelKey: string;
  parameter: string;
  value: number;
}

const PRESETS: Preset[] = [
  { type: 'temperature-spike', labelKey: 'temperatureSpike', parameter: 'temperature', value: 32 },
  { type: 'humidity-spike', labelKey: 'humiditySpike', parameter: 'humidity', value: 85 },
  { type: 'co2-anomaly', labelKey: 'co2Anomaly', parameter: 'co2', value: 1200 },
  { type: 'smoke-detected', labelKey: 'smokeDetected', parameter: 'smoke', value: 1 },
  { type: 'light-anomaly', labelKey: 'lightAnomaly', parameter: 'light', value: 50 },
  { type: 'motion-detected', labelKey: 'motionDetected', parameter: 'motion', value: 1 },
  // UX-13: zone occupancy (latched by setZoneOccupancy — shaping/events.ts)
  // for the library-comfort "evening crowd" scripts.
  { type: 'occupancy', labelKey: 'occupancy', parameter: 'occupancy', value: 120 },
];

// G3: 下拉标签走 i18n（severity.low/medium/high/critical），值保持英文 token。
const SEVERITIES = [
  { value: 'low', labelKey: 'severity.low' },
  { value: 'medium', labelKey: 'severity.medium' },
  { value: 'high', labelKey: 'severity.high' },
  { value: 'critical', labelKey: 'severity.critical' },
] as const;

type Severity = (typeof SEVERITIES)[number]['value'];

export interface EventInjectPanelProps {
  scenario: ScenarioDefinition;
}

export function EventInjectPanel({ scenario }: EventInjectPanelProps) {
  const simulationId = useAppStore(s => s.simulationId);
  const snapshot = useAppStore(s => s.snapshot);
  const snapshotState = snapshot?.state ?? null;
  const recordTriggerHint = useAppStore(s => s.recordTriggerHint);
  const { t } = useTranslation('eventInject');

  const [presetIndex, setPresetIndex] = useState(0);
  const [customType, setCustomType] = useState('');
  const [zoneId, setZoneId] = useState(scenario.zones[0]?.id ?? '');
  const [parameter, setParameter] = useState(PRESETS[0].parameter);
  const [value, setValue] = useState(String(PRESETS[0].value));
  const [severity, setSeverity] = useState<Severity>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // T-027: only zones THIS sim can see (snapshot = ground truth). Before the
  // first snapshot the full scenario list shows; the sync below corrects it.
  const zoneOptions = useMemo(() => scopedZones(scenario.zones, snapshot), [scenario.zones, snapshot]);

  // Keep the selection inside the scope: a default picked from the full
  // world (scenario.zones[0]) may be out-of-scope for a zone-scoped sim.
  useEffect(() => {
    if (snapshot === null) return;
    if (zoneOptions.some(zone => zone.id === zoneId)) return;
    setZoneId(zoneOptions[0]?.id ?? '');
  }, [zoneOptions, zoneId, snapshot]);

  const isCustom = presetIndex === -1;
  const stopped = snapshotState === 'stopped';

  const onPresetChange = (index: number) => {
    setPresetIndex(index);
    setError(null);
    if (index >= 0) {
      setParameter(PRESETS[index].parameter);
      setValue(String(PRESETS[index].value));
    }
  };

  // 常用事件 chip：只预填表单，不直接提交；zoneId 仍由用户选择。
  // R2-UX-06：type 命中下拉 PRESETS 时映射回对应索引（下拉显示选中的预置
  // 项而非「自定义」），只有下拉没有的 type 才走自定义输入框。
  const applyQuickPreset = (preset: EventQuickPreset) => {
    const index = PRESETS.findIndex(p => p.type === preset.type);
    setPresetIndex(index);
    setCustomType(index === -1 ? preset.type : '');
    setParameter(preset.parameter);
    setValue(String(preset.value));
    setSeverity(preset.severity);
    setError(null);
    setConfirmation(null);
  };

  const submit = async () => {
    if (!simulationId || busy) return;
    const type = isCustom ? customType.trim() : PRESETS[presetIndex].type;
    const numeric = Number(value);
    if (!type) {
      setError(t('typeMissing'));
      return;
    }
    if (!zoneId) {
      setError(t('zoneMissing'));
      return;
    }
    // T-027: never send a target outside the sim's world — teach instead of
    // surfacing the engine's raw UNKNOWN_ZONE (races: snapshot swapped since
    // the option list rendered).
    if (!zoneInSnapshot(snapshot, zoneId)) {
      const zone = scenario.zones.find(z => z.id === zoneId);
      setError(t('zoneOutOfScope', { zone: zone?.name ?? zoneId }));
      return;
    }
    if (Number.isNaN(numeric)) {
      setError(t('valueNotNumber', { value }));
      return;
    }
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      const result = await api.injectEvent(simulationId, {
        type,
        zoneId,
        parameter: parameter.trim() || undefined,
        value: numeric,
        severity,
      });
      // W8: injected events never echo on the bus — remember the trigger
      // client-side so the episode timeline can reconstruct it.
      recordTriggerHint(result.eventId, {
        type,
        zoneId,
        ...(parameter.trim() ? { parameter: parameter.trim() } : {}),
        value: numeric,
        at: new Date().toISOString(),
      });
      const targets =
        result.targetAgentIds.length > 0 ? result.targetAgentIds.join(', ') : t('noTargetAgents');
      setConfirmation(t('confirmed', { eventId: result.eventId, targets }));
    } catch (err) {
      // T-009: English API payload — localized framing (client-side checks
      // above set already-localized validation strings).
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
    <section className="live-panel inject-panel">
      <h3 className="side-panel__title">{t('title')}</h3>
      <div className="inject-panel__quick">
        <span className="inject-panel__quick-label">{t('quickTitle')}</span>
        {QUICK_EVENT_PRESETS.map(preset => (
          <button
            key={preset.labelKey}
            type="button"
            className="inject-panel__chip"
            onClick={() => applyQuickPreset(preset)}
          >
            {t(`quick.${preset.labelKey}`)}
          </button>
        ))}
      </div>
      <div className="inject-panel__form">
        <label>
          {t('typeLabel')}
          <select
            value={presetIndex}
            onChange={event => onPresetChange(Number(event.target.value))}
          >
            {PRESETS.map((preset, index) => (
              <option key={preset.type} value={index}>
                {t(`presets.${preset.labelKey}`)}
              </option>
            ))}
            <option value={-1}>{t('customOption')}</option>
          </select>
        </label>
        {isCustom && (
          <label>
            {t('customLabel')}
            <input
              value={customType}
              placeholder={t('customPlaceholder')}
              onChange={event => setCustomType(event.target.value)}
            />
          </label>
        )}
        <label>
          {t('zoneLabel')}
          <select value={zoneId} onChange={event => setZoneId(event.target.value)}>
            {zoneOptions.map(zone => (
              <option key={zone.id} value={zone.id}>
                {zone.name ?? zone.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('parameterLabel')}
          <input value={parameter} onChange={event => setParameter(event.target.value)} />
        </label>
        <label>
          {t('valueLabel')}
          <input
            type="number"
            value={value}
            onChange={event => setValue(event.target.value)}
          />
        </label>
        <label>
          {t('severityLabel')}
          <select value={severity} onChange={event => setSeverity(event.target.value as Severity)}>
            {SEVERITIES.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
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
    </section>
  );
}
