/**
 * EnvSeriesPanel — LivePanels 的「环境曲线」面板：zone 选择器 +
 * echarts 多 y 轴折线（温度 / CO₂ / 湿度，人数可 toggle），随 snapshot
 * 流追加；已触发的仿真事件在触发时刻画 markLine。
 *
 * option 组装在纯函数 `buildEnvSeriesOption` 里（可单测）；组件只负责
 * 折叠状态、zone/人数选择与挂载（useECharts，主题切换自动重建取新色板）。
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import {
  chartPalette,
  useECharts,
  type ChartPalette,
  type EChartsCoreOption,
} from '../lib/echarts';
import {
  markLinesFor,
  metricSeries,
  type EnvMetric,
  type EnvTimeseries,
} from '../lib/timeseries';
import { Icon } from './ui/Icon';

interface MetricSpec {
  key: EnvMetric;
  /** i18n key under the `envSeries` namespace for the series legend label. */
  nameKey: 'metricTemperature' | 'metricCo2' | 'metricHumidity' | 'metricOccupancy';
  axis: { name: string; position: 'left' | 'right'; offset: number };
}

/** y 轴布局：温度左轴；CO₂ / 湿度右轴（湿度外移）；人数开启时占左侧外移轴。 */
const METRIC_SPECS: MetricSpec[] = [
  { key: 'temperature', nameKey: 'metricTemperature', axis: { name: '°C', position: 'left', offset: 0 } },
  { key: 'co2', nameKey: 'metricCo2', axis: { name: 'ppm', position: 'right', offset: 0 } },
  { key: 'humidity', nameKey: 'metricHumidity', axis: { name: '%', position: 'right', offset: 44 } },
  { key: 'occupancy', nameKey: 'metricOccupancy', axis: { name: 'ppl', position: 'left', offset: 44 } },
];

/** Resolves the localized series name; the axis name follows the unit. */
function metricName(spec: MetricSpec): string {
  return i18n.t(`envSeries:${spec.nameKey}`, { defaultValue: spec.key });
}

/** Localized axis name for the occupancy axis (the unit token differs per locale). */
function axisNameFor(spec: MetricSpec): string {
  if (spec.key === 'occupancy') {
    return i18n.t('envSeries:axisOccupancy', { defaultValue: 'ppl' });
  }
  return spec.axis.name;
}

export function buildEnvSeriesOption(
  palette: ChartPalette,
  series: EnvTimeseries,
  zoneId: string,
  showOccupancy: boolean,
): EChartsCoreOption {
  const specs = METRIC_SPECS.filter(spec => spec.key !== 'occupancy' || showOccupancy);
  const marks = markLinesFor(series, zoneId);
  const axisLabel = { color: palette.textDim, fontSize: 10 };

  const lineSeries = specs.map((spec, index) => ({
    type: 'line' as const,
    name: metricName(spec),
    yAxisIndex: index,
    data: metricSeries(series, zoneId, spec.key),
    showSymbol: false,
    lineStyle: { width: 1.5, color: palette.series[index % palette.series.length] },
    itemStyle: { color: palette.series[index % palette.series.length] },
  }));

  // markLine 挂在第一条有数据的系列上（zone 可能缺温度参数）。
  const carrier = lineSeries.find(s => s.data.length > 0);
  const seriesWithMarks = lineSeries.map(s =>
    s === carrier && marks.length > 0
      ? {
          ...s,
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: palette.accent, type: 'dashed' as const, width: 1 },
            label: { color: palette.textDim, fontSize: 10 },
            data: marks.map(mark => ({
              xAxis: mark.t,
              label: { formatter: mark.type },
            })),
          },
        }
      : s,
  );

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 4, right: 4, top: 26, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 3,
      textStyle: { color: palette.textDim, fontSize: 10 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.panelBg,
      borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 11 },
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? String(Math.round(value * 10) / 10) : '-',
    },
    xAxis: {
      type: 'value',
      name: 'sim-s',
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisLabel,
      splitLine: { show: false },
    },
    yAxis: specs.map((spec, index) => ({
      type: 'value' as const,
      name: axisNameFor(spec),
      nameTextStyle: { color: palette.textDim, fontSize: 10 },
      position: spec.axis.position,
      offset: spec.axis.offset,
      scale: true,
      axisLine: { show: true, lineStyle: { color: palette.series[index % palette.series.length] } },
      axisLabel,
      splitLine: { show: index === 0, lineStyle: { color: palette.splitLine, opacity: 0.4 } },
    })),
    series: seriesWithMarks,
  };
}

export interface EnvSeriesPanelProps {
  series: EnvTimeseries;
  /** 当前聚焦 agent 的管辖 zone（优先选为默认 zone）。 */
  preferredZoneId?: string | null;
}

export function EnvSeriesPanel({ series, preferredZoneId }: EnvSeriesPanelProps) {
  const theme = useAppStore(s => s.theme);
  const { t } = useTranslation('envSeries');
  const [open, setOpen] = useState(true);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [showOccupancy, setShowOccupancy] = useState(false);

  const zoneId =
    selectedZone && series.zoneIds.includes(selectedZone)
      ? selectedZone
      : preferredZoneId && series.zoneIds.includes(preferredZoneId)
        ? preferredZoneId
        : (series.zoneIds[0] ?? null);

  const option = useMemo(
    () => (zoneId ? buildEnvSeriesOption(chartPalette(theme), series, zoneId, showOccupancy) : null),
    // `buildEnvSeriesOption` reads i18n synchronously; re-resolve on language change too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, series, zoneId, showOccupancy, i18n.language],
  );
  const chartRef = useECharts(option, theme);

  return (
    <section className="live-panel live-panel--env">
      <button className="link-button" onClick={() => setOpen(value => !value)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} /> {t('panelLabel')}
      </button>
      {open && (
        <div className="env-chart">
          <div className="env-chart__toolbar">
            <select
              aria-label={t('zoneSelectAria')}
              value={zoneId ?? ''}
              onChange={event => setSelectedZone(event.target.value)}
            >
              {series.zoneIds.map(id => (
                <option key={id} value={id}>
                  {series.zoneNames[id] ?? id}
                </option>
              ))}
            </select>
            <label className="env-chart__toggle">
              <input
                type="checkbox"
                checked={showOccupancy}
                onChange={event => setShowOccupancy(event.target.checked)}
              />
              {t('occupancyToggle')}
            </label>
          </div>
          {option ? (
            <div ref={chartRef} className="env-chart__canvas" data-testid="env-chart-canvas" />
          ) : (
            <p className="page-note">{t('waitingData')}</p>
          )}
        </div>
      )}
    </section>
  );
}
