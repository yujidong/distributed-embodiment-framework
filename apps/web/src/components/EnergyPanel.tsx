/**
 * EnergyPanel (R15-D8) — per-device cumulative energy curves + per-zone
 * totals, rendered from the LIVE snapshot stream (replay cursor movement
 * never pollutes it). Collapsible like the physics curves above it.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EngineSnapshot } from '../api/types';
import { chartPalette, useECharts } from '../lib/echarts';
import {
  appendDeviceEnergy,
  buildEnergyOption,
  createDeviceEnergySeries,
  zoneEnergyTotals,
  type DeviceEnergySeries,
} from '../lib/deviceEnergy';
import { formatEnergyWh } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { Icon } from './ui/Icon';

function useDeviceEnergy(snapshot: EngineSnapshot | null): DeviceEnergySeries {
  const [series, setSeries] = useState(createDeviceEnergySeries);
  useEffect(() => {
    if (!snapshot) return;
    setSeries(prev => appendDeviceEnergy(prev, snapshot));
  }, [snapshot]);
  return series;
}

export interface EnergyPanelProps {
  /** LIVE snapshot (the store's, not the replay cursor's). */
  snapshot: EngineSnapshot | null;
  /** Zone display names for the totals list. */
  zoneNames: Record<string, string>;
}

export function EnergyPanel({ snapshot, zoneNames }: EnergyPanelProps) {
  const theme = useAppStore(s => s.theme);
  const { t } = useTranslation('energy');
  const [open, setOpen] = useState(false);
  const series = useDeviceEnergy(snapshot);

  const totals = useMemo(
    () => (snapshot ? zoneEnergyTotals(series, snapshot.devices) : []),
    [series, snapshot],
  );
  const option = useMemo(
    () => (snapshot ? buildEnergyOption(chartPalette(theme), series, snapshot.devices) : null),
    [theme, series, snapshot],
  );
  const chartRef = useECharts(option, theme);

  if (series.deviceIds.length === 0 && totals.length === 0) return null;

  return (
    <section className="live-panel live-panel--energy">
      <button className="link-button" onClick={() => setOpen(value => !value)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} /> {t('panelLabel')}
      </button>
      {open && (
        <div className="energy-panel">
          {totals.length > 0 && (
            <div className="energy-panel__zones">
              {totals.map(({ zoneId, wh }) => (
                <span key={zoneId} className="badge energy-panel__zone" title={zoneId}>
                  {zoneNames[zoneId] ?? zoneId} · {formatEnergyWh(wh)}
                </span>
              ))}
            </div>
          )}
          {option ? (
            <div ref={chartRef} className="env-chart__canvas" data-testid="energy-chart-canvas" />
          ) : (
            <p className="page-note">{t('waitingData')}</p>
          )}
        </div>
      )}
    </section>
  );
}
