/**
 * Agent chat panel (cognitive architecture Phase 3) — the Web lane of the
 * natural-language interface: pick a RUNNING agent, type a plain-language
 * command or question, read the plain-language answer.
 *
 * Commands go to POST /api/agents/:id/command (parse → decide → execute →
 * respond); the "ask" toggle switches to the read-only /ask lane. The
 * transcript shows the agent's answer plus per-action outcome lines so the
 * executed device commands stay visible next to the prose.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { agentAsk, agentCommand, agentWhatIf, ApiClientError } from '../api/client';
import type { NLVerification, WhatIfResult } from '../api/types';

interface SnapshotAgent {
  id: string;
  name: string;
}

export interface AgentChatPanelProps {
  simulationId: string;
  agents: SnapshotAgent[];
  stopped?: boolean;
}

interface ChatEntry {
  kind: 'command' | 'ask' | 'what-if';
  text: string;
  response?: string;
  actions?: Array<{ deviceId: string; command: string; success: boolean; error?: string }>;
  /**
   * R76-F3: which lane parsed/decided this entry (wire field
   * intent.parseSource) — the decision posture must be visible per message,
   * never only in the network log.
   */
  parseSource?: 'llm' | 'rules' | 'rules-llm-down';
  /** R40-B1: the verify-before-act verdict on command entries. */
  verification?: NLVerification;
  /** R40-B1: the prediction result on what-if entries. */
  prediction?: WhatIfResult['result'];
  error?: string;
  pending: boolean;
}

/** S3': 历史只保留最近 10 条（slice(-9) + 新条目）——UI 需明示截断。 */
const MAX_ENTRIES = 10;

export function AgentChatPanel({ simulationId, agents, stopped }: AgentChatPanelProps) {
  const { t } = useTranslation('agentChat');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [mode, setMode] = useState<'command' | 'ask' | 'what-if'>('command');
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || agentId.length === 0) return;
    setText('');
    const entry: ChatEntry = { kind: mode, text: trimmed, pending: true };
    setEntries(prev => [...prev.slice(-(MAX_ENTRIES - 1)), entry]);
    try {
      if (mode === 'command') {
        const result = await agentCommand(agentId, trimmed, simulationId);
        entry.response = result.naturalLanguageResponse;
        entry.actions = result.executionResult.actions;
        entry.parseSource = result.intent.parseSource;
        entry.verification = (result.executionResult as { verification?: NLVerification }).verification;
      } else if (mode === 'what-if') {
        const result = await agentWhatIf(agentId, trimmed, simulationId);
        entry.prediction = result.result;
        // confidence 可能为 NaN（预测器 0/0）—— 无值时不追加百分比
        const confidencePct = Number.isFinite(result.result.confidence)
          ? ` (${Math.round(result.result.confidence * 100)}%)`
          : '';
        entry.response = `${result.result.verdict}${confidencePct}`;
      } else {
        const result = await agentAsk(agentId, trimmed, simulationId);
        entry.response = result.naturalLanguageResponse;
        entry.parseSource = result.intent.parseSource;
      }
    } catch (error) {
      entry.error = error instanceof ApiClientError ? error.message : String(error);
    } finally {
      entry.pending = false;
      setEntries(prev => [...prev]);
    }
  };

  if (agents.length === 0) {
    return <p className="agent-chat__empty">{t('noAgents')}</p>;
  }

  return (
    <div className="agent-chat">
      <div className="agent-chat__controls">
        <select
          className="agent-chat__agent"
          value={agentId}
          onChange={event => setAgentId(event.target.value)}
          aria-label={t('agentSelect')}
        >
          {agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <div className="agent-chat__modes" role="group" aria-label={t('modeLabel')}>
          {(['command', 'what-if', 'ask'] as const).map(value => (
            <label key={value} className={`agent-chat__mode ${mode === value ? 'agent-chat__mode--on' : ''}`}>
              <input
                type="radio"
                name={`chat-mode-${simulationId}`}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {t(`mode_${value}`)}
            </label>
          ))}
        </div>
      </div>
      {stopped && <div className="agent-chat__stopped">{t('stopped')}</div>}
      <div className="agent-chat__log">
        {entries.length >= MAX_ENTRIES && (
          <div className="agent-chat__truncated">{t('truncatedNotice', { max: MAX_ENTRIES })}</div>
        )}
        {entries.map((entry, index) => (
          <div key={index} className={`agent-chat__entry agent-chat__entry--${entry.kind}`}>
            <div className="agent-chat__input-line">
              {entry.text}
              {entry.parseSource !== undefined && (
                <span
                  className={`agent-chat__source agent-chat__source--${entry.parseSource}`}
                  title={t(`sourceTip_${entry.parseSource}`)}
                >
                  {t(`source_${entry.parseSource}`)}
                </span>
              )}
            </div>
            {entry.pending && <div className="agent-chat__pending">{t('thinking')}</div>}
            {entry.response !== undefined && (
              <div className="agent-chat__response">{entry.response}</div>
            )}
            {entry.actions !== undefined && entry.actions.length > 0 && (
              <ul className="agent-chat__actions">
                {entry.actions.map((action, i) => (
                  <li key={i} className={action.success ? 'agent-chat__action--ok' : 'agent-chat__action--fail'}>
                    {action.success ? '✓' : '✗'} {action.deviceId} {action.command}
                    {action.error !== undefined ? ` — ${action.error}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {entry.verification !== undefined && (
              <div
                className={`agent-chat__verification agent-chat__verification--${entry.verification.verdict}`}
                title={entry.verification.rationale ?? ''}
              >
                {entry.verification.blocked
                  ? t('verificationBlocked')
                  : t(`verdict_${entry.verification.verdict}`)}
                {' '}({Math.round(entry.verification.confidence * 100)}%)
              </div>
            )}
            {entry.prediction !== undefined && (
              <div className={`agent-chat__verification agent-chat__verification--${entry.prediction.verdict}`}>
                <span className="agent-chat__verdict-badge">{t(`verdict_${entry.prediction.verdict}`)}</span>
                <ul className="agent-chat__deltas">
                  {Object.entries(entry.prediction.delta).map(([metric, value]) => (
                    <li key={metric}>
                      {metric}: {value > 0 ? '+' : ''}{Math.round(value * 100) / 100}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {entry.error !== undefined && (
              <div className="agent-chat__error">{t('requestFailed', { error: entry.error })}</div>
            )}
          </div>
        ))}
      </div>
      <form
        className="agent-chat__form"
        onSubmit={event => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="agent-chat__input"
          value={text}
          placeholder={mode === 'command' ? t('commandPlaceholder') : mode === 'what-if' ? t('whatIfPlaceholder') : t('askPlaceholder')}
          onChange={event => setText(event.target.value)}
          maxLength={2000}
        />
        <button className="agent-chat__send" type="submit" disabled={text.trim().length === 0}>
          {t('send')}
        </button>
      </form>
    </div>
  );
}
