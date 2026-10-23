/**
 * CollaborationsPanel — the sim console's AC collaboration list (Fix-8 /
 * Fix-17), fed by GET /api/simulations/:id/collaborations.
 *
 * The map layer (lib/collabGraph) shows live edges derived from event frames;
 * this panel is the tabular counterpart: one row per (collaboration, agent
 * view) — both sides' perspective (role initiator/participant), the session
 * status, and the collaboration's description (理由). Polls on a slow cadence
 * alongside the snapshot poll; the standalone CollaborationGraph stays
 * retired from the layout.
 */

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Handshake } from 'lucide-react';

import * as api from '../api/client';
import type { RuntimeCollaborationRecord, SnapshotAgent } from '../api/types';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { EmptyState } from './ui/EmptyState';

const POLL_INTERVAL_MS = 3000;

export function CollaborationsPanel({
  simulationId,
  agents,
  stopped = false,
}: {
  simulationId: string;
  /** Snapshot agents — used to resolve agent display names. */
  agents: SnapshotAgent[];
  /**
   * T-028/EA-F07: polling stops with the sim. The panel stays mounted (the
   * console keeps showing the final table), but /collaborations 404s once
   * retention prunes a stopped sim — a 3s poll would eventually stamp a
   * permanent SIMULATION_NOT_FOUND error over data that was fine.
   */
  stopped?: boolean;
}) {
  const { t } = useTranslation('collaborations');
  const [collaborations, setCollaborations] = useState<RuntimeCollaborationRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  // S4: 提取 load 以便错误态给「重试」入口（轮询错误曾只能等下一个周期）。
  const load = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const rows = await api.getSimulationCollaborations(simulationId);
      setCollaborations(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
    }
  };

  // R31 F12: visibility-gated cadence — no collaborations polling in a
  // hidden tab (also stopped with the sim, per T-028/EA-F07).
  useVisibleInterval(() => {
    void load();
  }, POLL_INTERVAL_MS, !stopped);

  const agentName = (id: string): string =>
    agents.find(agent => agent.id === id)?.name ?? id;

  const statusLabel = (status: string): string => {
    switch (status) {
      case 'pending':
        return t('statusPending');
      case 'in_progress':
        return t('statusInProgress');
      case 'active':
        return t('statusActive');
      case 'completed':
        return t('statusCompleted');
      case 'failed':
        return t('statusFailed');
      case 'cancelled':
        return t('statusCancelled');
      default:
        return status;
    }
  };

  const roleLabel = (role: string): string => {
    if (role === 'initiator') return t('roleInitiator');
    if (role === 'participant') return t('roleParticipant');
    return role;
  };

  return (
    <section className="live-panel collaborations-panel">
      <h3 className="side-panel__title">
        {collaborations !== null
          ? t('panelTitle', { count: collaborations.length })
          : t('panelTitleLoading')}
      </h3>
      {error && (
        <p className="page-note page-note--error">
          {t('loadFailed', { error })}{' '}
          <button className="link-button" onClick={() => void load()}>
            {t('retry')}
          </button>
        </p>
      )}
      {collaborations === null && !error && <p className="page-note">{t('loading')}</p>}
      {collaborations !== null && collaborations.length === 0 && (
        <EmptyState compact icon={Handshake} title={t('empty')} />
      )}
      {collaborations !== null && collaborations.length > 0 && (
        <ul className="decision-list">
          {collaborations.map(collab => (
            <li
              key={`${collab.id}:${collab.agentId}`}
              className="decision-item collaboration-row"
            >
              <span className="decision-item__agent" title={collab.agentId}>
                {agentName(collab.agentId)}
              </span>
              <span className="badge">{roleLabel(collab.role)}</span>
              <span className={`badge${collab.history ? '' : ' badge--user'}`}>
                {statusLabel(collab.status)}
              </span>
              <span className="object-list__meta collaboration-row__detail">
                {collab.description || collab.type}
                {collab.participants.length > 0 &&
                  `${t('participantsPrefix')}${collab.participants
                    .map(agentName)
                    .join(t('participantsJoin'))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
