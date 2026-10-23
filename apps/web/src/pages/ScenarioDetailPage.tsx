/**
 * Scenario detail page (legacy file-scenario browser) — header (meta), shared
 * world map (dot/agent-layer rendering), agent side list, LLM-mode selector,
 * and the "运行仿真" entry point.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { LlmClientPreset } from '../api/types';
import { localizedText } from '../lib/locale';
import { useTranslation } from 'react-i18next';
import { formatReplayEvent } from '../lib/replayEvents';
import { shareNameMaps } from '../lib/shareReplay';
import { worldModelFromScenario } from '../lib/worldModel';
import { useAppStore } from '../store/useAppStore';
import { AgentSidePanel } from '../components/AgentSidePanel';
import { DecisionChainPanel } from '../components/DecisionChainPanel';
import { Icon } from '../components/ui/Icon';
import { WorldMap } from '../components/worldmap/WorldMap';

const LLM_OPTION_KEYS: Array<{ value: LlmClientPreset; key: string }> = [
  { value: 'none', key: 'detail.llmOptionNone' },
  { value: 'auto', key: 'detail.llmOptionAuto' },
  { value: 'llm', key: 'detail.llmOptionLlm' },
];

export function ScenarioDetailPage() {
  const scenario = useAppStore(s => s.currentScenario);
  const error = useAppStore(s => s.currentScenarioError);
  const simulationError = useAppStore(s => s.simulationError);
  const openScenario = useAppStore(s => s.openScenario);
  const startSimulationFor = useAppStore(s => s.startSimulationFor);
  const { t } = useTranslation('scenario');

  const [llmClient, setLlmClient] = useState<LlmClientPreset>('auto');
  const navigate = useNavigate();
  const model = useMemo(() => (scenario ? worldModelFromScenario(scenario) : null), [scenario]);

  // Route-driven loading: /scenarios/:scenarioId picks the scenario.
  const { scenarioId } = useParams<{ scenarioId: string }>();
  useEffect(() => {
    if (!scenarioId) return;
    if (useAppStore.getState().currentScenario?.meta.id === scenarioId) return;
    void openScenario(scenarioId);
  }, [scenarioId, openScenario]);

  if (error) {
    return (
      <div className="page-note page-note--error">
        <p>{t('detail.loadFailed', { error })}</p>
        <button onClick={() => navigate('/scenarios')}>{t('detail.backToList')}</button>
      </div>
    );
  }
  if (!scenario || !model) {
    return <p className="page-note">{t('detail.loading')}</p>;
  }

  return (
    <div className="detail-page">
      <header className="detail-header">
        <Link className="link-button" to="/scenarios">
          <Icon icon={ArrowLeft} size={14} /> {t('detail.back')}
        </Link>
        <div className="detail-header__meta">
          <h2>{localizedText(scenario.meta.name) ?? scenario.meta.id}</h2>
          <span className="detail-header__id">{scenario.meta.id}</span>
          <span className="badge badge--version">v{scenario.version}</span>
        </div>
        <p className="detail-header__description">{localizedText(scenario.meta.description) ?? ''}</p>
        <label className="llm-select">
          {t('detail.llmMode')}
          <select
            value={llmClient}
            onChange={event => setLlmClient(event.target.value as LlmClientPreset)}
          >
            {LLM_OPTION_KEYS.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.key)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          onClick={() => void startSimulationFor(scenario.meta.id, llmClient)}
        >
          {t('detail.run')}
        </button>
      </header>
      {simulationError && (
        <div className="error-banner">{t('detail.simStartFailed', { error: simulationError })}</div>
      )}
      {/* Wave-4b: the collaboration decision chain of replay scenarios
          (renders nothing when no sim-decision events are baked in).
          UX-07: names maps resolve event labels in the chain header. */}
      <DecisionChainPanel
        events={scenario.events}
        agents={scenario.agents}
        names={shareNameMaps(scenario)}
      />
      {scenario.events.length > 0 && (
        <section className="live-panel scenario-events">
          <h3 className="side-panel__title">{t('detail.scheduledEvents', { count: scenario.events.length })}</h3>
          <ul className="decision-list">
            {scenario.events.map(event => (
              <li key={event.id} className="decision-item">
                {formatReplayEvent(event)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="detail-body">
        <main className="detail-main">
          <WorldMap model={model} />
        </main>
        <AgentSidePanel scenario={scenario} />
      </div>
      {scenario.meta.vendorDisclaimer && (
        <footer className="detail-page__disclaimer">
          {localizedText(scenario.meta.vendorDisclaimer) ?? ''}
        </footer>
      )}
    </div>
  );
}
