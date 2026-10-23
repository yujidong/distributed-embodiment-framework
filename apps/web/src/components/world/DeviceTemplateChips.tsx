/**
 * DeviceTemplateChips — UX-W3 shared suggestion surface over
 * GET /api/device-templates (the built-in registry): a search box + matching
 * template chips. Used by DeviceForm (pick a template → type/capabilities
 * prefill) and CatalogPanel (type-filter suggestions).
 *
 * Honest degradation: when the API fails the hook swaps in the small static
 * fallback wordlist and this component says so — free-text input remains the
 *兜底 in every case.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DeviceTemplate } from '../../api/types';
import { useDeviceTemplates } from '../../hooks/useDeviceTemplates';
import { deviceTemplateEffectsNote, filterDeviceTemplates } from '../../lib/deviceTemplates';

export interface DeviceTemplateChipsProps {
  /**
   * External filter text (CatalogPanel reuses its type-filter input). When
   * omitted the component renders its own search box (DeviceForm).
   */
  query?: string;
  /** Called when a template chip is picked. */
  onPick: (template: DeviceTemplate) => void;
  /** Highlight + describe the applied template (DeviceForm after a pick). */
  selectedId?: string | null;
  /** Chip cap (default 12) — the registry is 73+, search narrows it. */
  limit?: number;
}

export function DeviceTemplateChips({
  query,
  onPick,
  selectedId = null,
  limit = 12,
}: DeviceTemplateChipsProps) {
  const { t } = useTranslation('deviceForm');
  const { templates, degraded } = useDeviceTemplates();
  const [innerQuery, setInnerQuery] = useState('');
  const effectiveQuery = query ?? innerQuery;

  const matches = useMemo(
    () => filterDeviceTemplates(templates, effectiveQuery).slice(0, limit),
    [templates, effectiveQuery, limit],
  );
  const selected = selectedId !== null ? templates.find(tp => tp.id === selectedId) : undefined;
  const selectedNote = selected ? deviceTemplateEffectsNote(selected) : '';

  return (
    <div className="device-templates">
      {query === undefined && (
        <input
          value={innerQuery}
          onChange={event => setInnerQuery(event.target.value)}
          placeholder={t('templateSearchPlaceholder')}
          aria-label={t('templateSearchPlaceholder')}
        />
      )}
      {degraded && <p className="page-note">{t('templatesDegraded')}</p>}
      {matches.length > 0 ? (
        <div className="chip-row">
          {matches.map(template => (
            <button
              key={template.id}
              className={
                selectedId === template.id
                  ? 'chip chip--button chip--template chip--active'
                  : 'chip chip--button chip--template'
              }
              title={template.description}
              onClick={() => onPick(template)}
            >
              {template.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="object-list__meta">{t('templatesNoMatch')}</p>
      )}
      {selected && (
        <p className="object-list__meta device-templates__note">
          {selected.description}
          {selectedNote !== '' ? ` · ${selectedNote}` : ''}
        </p>
      )}
    </div>
  );
}
