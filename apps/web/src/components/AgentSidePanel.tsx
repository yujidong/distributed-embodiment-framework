/**
 * Agent side panel — static (scenario definition) view of the agents:
 * name, capability chips, bound devices, managed zones.
 */

import type { ScenarioAgent, ScenarioDefinition } from '../api/types';
import { useTranslation } from 'react-i18next';

export interface AgentSidePanelProps {
  scenario: ScenarioDefinition;
}

function deviceName(scenario: ScenarioDefinition, id: string): string {
  return scenario.devices.find(d => d.id === id)?.name ?? id;
}

function AgentCard({ agent, scenario }: { agent: ScenarioAgent; scenario: ScenarioDefinition }) {
  const { t } = useTranslation('agentSidePanel');
  return (
    <div className="agent-card">
      <div className="agent-card__name">{agent.name}</div>
      <div className="agent-card__id">{agent.id}</div>
      <div className="chip-row">
        {agent.capabilities.map(capability => (
          <span key={capability} className="chip">
            {capability}
          </span>
        ))}
      </div>
      {agent.boundDeviceIds.length > 0 && (
        <div className="agent-card__section">
          <span className="agent-card__label">{t('boundDevices')}</span>
          {agent.boundDeviceIds.map(id => (
            <div key={id} className="agent-card__item">
              {deviceName(scenario, id)}
            </div>
          ))}
        </div>
      )}
      {agent.managesZoneIds.length > 0 && (
        <div className="agent-card__section">
          <span className="agent-card__label">{t('managedZones')}</span>
          {agent.managesZoneIds.map(id => (
            <div key={id} className="agent-card__item">
              {scenario.zones.find(z => z.id === id)?.name ?? id}
            </div>
          ))}
        </div>
      )}
      {agent.llm && (
        <div className="agent-card__llm">
          LLM: {agent.llm.provider}/{agent.llm.model}
        </div>
      )}
    </div>
  );
}

export function AgentSidePanel({ scenario }: AgentSidePanelProps) {
  const { t } = useTranslation('agentSidePanel');
  return (
    <aside className="side-panel">
      <h3 className="side-panel__title">{t('agentsTitle', { count: scenario.agents.length })}</h3>
      {scenario.agents.map(agent => (
        <AgentCard key={agent.id} agent={agent} scenario={scenario} />
      ))}
    </aside>
  );
}
