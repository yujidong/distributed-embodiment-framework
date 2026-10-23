/**
 * ImportDraftReview — UX-W3 shared review step for the three import lanes
 * (floorplan / IFC / OSM). The lanes produce a scenario-JSON draft that is
 * never persisted server-side; this panel is where the user inspects it
 * (zone list with rename/remove, process warnings, summary counts) before
 * confirming — confirmation hands the EDITED draft back to the caller, which
 * posts it to POST /api/environments (the standing import path).
 */

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  draftCounts,
  draftName,
  extractDraftZones,
  removeDraftZone,
  renameDraftZone,
} from '../lib/importDraft';
import { Icon } from './ui/Icon';

export interface ImportDraftReviewProps {
  draft: Record<string, unknown>;
  warnings: string[];
  busy: boolean;
  /** Create-step failure (POST /api/environments) — shown above the actions. */
  error?: string | null;
  onConfirm: (editedDraft: Record<string, unknown>) => void;
  onBack: () => void;
}

export function ImportDraftReview({
  draft,
  warnings,
  busy,
  error = null,
  onConfirm,
  onBack,
}: ImportDraftReviewProps) {
  const { t } = useTranslation('environments');
  const [edited, setEdited] = useState(draft);
  const zones = useMemo(() => extractDraftZones(edited), [edited]);
  const counts = useMemo(() => draftCounts(edited), [edited]);
  const name = draftName(edited);

  // R2-FEAT-09: the type column was raw English slugs — translate the known
  // vocabulary, pass anything else through verbatim (honest fallback).
  const zoneTypeLabel = (type: string): string =>
    type === '' ? '—' : t(`create.review.zoneTypes.${type}`, { defaultValue: type });

  return (
    <div className="import-review">
      <p className="import-review__summary">
        {t('create.review.summary', {
          name: name || t('create.review.unnamed'),
          zones: counts.zones,
          devices: counts.devices,
          agents: counts.agents,
        })}
      </p>

      {zones.length > 0 ? (
        <table className="import-review__zones">
          <thead>
            <tr>
              <th>{t('create.review.zoneId')}</th>
              <th>{t('create.review.zoneName')}</th>
              <th>{t('create.review.zoneType')}</th>
              <th>{t('create.review.zoneFloor')}</th>
              <th aria-label={t('create.review.removeZone')} />
            </tr>
          </thead>
          <tbody>
            {zones.map(zone => (
              <tr key={zone.id}>
                <td className="import-review__zone-id">{zone.id}</td>
                <td>
                  <input
                    value={zone.name}
                    aria-label={t('create.review.renameZoneAria', { id: zone.id })}
                    onChange={event =>
                      setEdited(current => renameDraftZone(current, zone.id, event.target.value))
                    }
                  />
                </td>
                <td>{zoneTypeLabel(zone.type)}</td>
                <td>{zone.floor ?? '—'}</td>
                <td>
                  <button
                    className="link-button"
                    title={t('create.review.removeZone')}
                    aria-label={t('create.review.removeZoneAria', { id: zone.id })}
                    disabled={busy}
                    onClick={() => setEdited(current => removeDraftZone(current, zone.id))}
                  >
                    <Icon icon={Trash2} size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="page-note">{t('create.review.noZones')}</p>
      )}

      {warnings.length > 0 && (
        <div className="import-review__warnings">
          <p className="import-review__warnings-title">
            {t('create.review.warningsTitle', { count: warnings.length })}
          </p>
          <ul>
            {warnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="env-card__error">{error}</p>}

      <div className="dialog__actions">
        <button onClick={onBack} disabled={busy}>
          {t('create.review.back')}
        </button>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onConfirm(edited)}
        >
          {busy ? t('create.creating') : t('create.review.confirm')}
        </button>
      </div>
    </div>
  );
}
