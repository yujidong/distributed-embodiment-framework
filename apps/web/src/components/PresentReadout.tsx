/**
 * PresentReadout — 演示模式的大字号环境读数条：当前聚焦 zone 的
 * 温度 / CO₂ / occupancy，等宽数字 + 超大字号 + token 语义色，
 * 只读渲染（数据来自 rendered snapshot，回放时随游标变化）。
 */

import { useTranslation } from 'react-i18next';

import type { EngineSnapshot } from '../api/types';
import { comfortBadgeVariant, readZoneComfort } from '../lib/zoneVisual';

export interface PresentReadoutProps {
  snapshot: EngineSnapshot | null;
  /** 聚焦 zone（selectedAgent 管辖 / hero 事件 zone / 第一个 zone，由调用方决定）。 */
  zoneId: string | null;
}

function formatNumber(value: number | boolean | undefined, digits = 0): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

export function PresentReadout({ snapshot, zoneId }: PresentReadoutProps) {
  const { t } = useTranslation('presentReadout');
  const { t: tc } = useTranslation('comfort');
  const zones = snapshot?.zones ?? [];
  const zone = zones.find(z => z.id === zoneId) ?? zones[0];
  if (!zone) return null;
  const comfort = readZoneComfort(zone.parameters);

  return (
    <div className="present-readout" data-testid="present-readout">
      <span className="present-readout__zone">{zone.name ?? zone.id}</span>
      <span className="present-readout__metric">
        <span className="present-readout__value present-readout__value--temperature">
          {formatNumber(zone.parameters.temperature, 1)}
        </span>
        <span className="present-readout__label">{t('temperatureLabel')}</span>
      </span>
      <span className="present-readout__metric">
        <span className="present-readout__value present-readout__value--co2">
          {formatNumber(zone.parameters.co2)}
        </span>
        <span className="present-readout__label">{t('co2Label')}</span>
      </span>
      <span className="present-readout__metric">
        <span className="present-readout__value present-readout__value--occupancy">
          {formatNumber(zone.parameters.occupancy)}
        </span>
        <span className="present-readout__label">{t('occupancyLabel')}</span>
      </span>
      {comfort && (
        <span className="present-readout__metric">
          <span className={`badge badge--${comfortBadgeVariant(comfort.comfortLevel)}`}>
            {tc(`sensation.${comfort.sensation}`, { defaultValue: comfort.sensation })}
            {' · PMV '}
            {comfort.pmv.toFixed(1)}
          </span>
          <span className="present-readout__label">{t('comfortLabel')}</span>
        </span>
      )}
    </div>
  );
}
