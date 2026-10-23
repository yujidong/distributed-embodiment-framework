/**
 * Scenario list page — cards from GET /api/scenarios.
 */

import { useEffect } from 'react';
import { Layers, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { localizedText } from '../lib/locale';
import { useAppStore } from '../store/useAppStore';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';

export function ScenarioListPage() {
  const scenarios = useAppStore(s => s.scenarios);
  const loading = useAppStore(s => s.scenariosLoading);
  const error = useAppStore(s => s.scenariosError);
  const loadScenarios = useAppStore(s => s.loadScenarios);
  const navigate = useNavigate();
  const { t } = useTranslation('scenario');
  const { t: tPage } = useTranslation('scenarioListPage');

  useEffect(() => {
    void loadScenarios();
  }, [loadScenarios]);

  if (loading && scenarios.length === 0) {
    return <p className="page-note">{tPage('loading')}</p>;
  }
  if (error) {
    return (
      <div className="page-note page-note--error">
        <p>{tPage('loadFailed', { error })}</p>
        <button onClick={() => void loadScenarios()}>{tPage('retry')}</button>
      </div>
    );
  }
  if (scenarios.length === 0) {
    return (
      <div className="empty-state">
        <Icon icon={Layers} size={28} className="empty-state__icon" />
        <p className="empty-state__title">{tPage('emptyTitle')}</p>
        <p className="empty-state__note">{tPage('emptyNote')}</p>
      </div>
    );
  }

  return (
    <div className="scenario-grid">
      {scenarios.map(scenario => {
        // Resolve the bilingual name/description/tagline via the active locale.
        // Plain-string wire data (legacy scenarios) falls through unchanged.
        const name = localizedText(scenario.name) ?? scenario.id;
        const desc = localizedText(scenario.description) ?? '';
        const truncated = desc.length > 240 ? desc.slice(0, 240) + '…' : desc;
        const hasHero = Boolean(scenario.heroEventId);
        const tagline = localizedText(scenario.tagline);
        return (
          <button
            key={scenario.id}
            className="scenario-card"
            onClick={() => navigate(`/scenarios/${scenario.id}`)}
          >
            <div className="scenario-card__header">
              <span className="scenario-card__name">{name}</span>
              <span className={`badge badge--${scenario.source}`}>
                {scenario.source === 'seed' ? 'seed' : 'user'}
              </span>
            </div>
            {tagline && <p className="scenario-card__tagline">{tagline}</p>}
            <p className="scenario-card__description">{truncated}</p>
            <div className="scenario-card__counts">
              <Badge>{scenario.counts.zones} {t('card.zones')}</Badge>
              <Badge>{scenario.counts.devices} {t('card.devices')}</Badge>
              <Badge>{scenario.counts.agents} {t('card.agents')}</Badge>
              {scenario.counts.events !== undefined && (
                <Badge>{scenario.counts.events} {t('card.events')}</Badge>
              )}
              {scenario.counts.derivedServices !== undefined && scenario.counts.derivedServices > 0 && (
                <Badge title={t('card.servicesHint')}>{scenario.counts.derivedServices}+ {t('card.services')}</Badge>
              )}
            </div>
            <div className="scenario-card__footer">
              <span className="scenario-card__id">{scenario.id}</span>
              {hasHero && (
                <span className="scenario-card__hero-badge" title={`hero: ${scenario.heroEventId}`}>
                  <Icon icon={Star} size={12} fill="currentColor" /> hero
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
