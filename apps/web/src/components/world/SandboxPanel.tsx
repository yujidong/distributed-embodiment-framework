/**
 * SandboxPanel — living-world fork management (R40-B3).
 *
 * The fork model (design-living-worlds §10 / P2F) was CLI/API-only until
 * now: this panel gives it a Web entry — fork the world's CURRENT dynamics
 * into a private sandbox (fromCheckpoint), list your forks (owner sees
 * all), stop a running fork, and promote a fork-validated flow back into
 * the authoritative world via the adopt-config governance funnel (P2F §11,
 * mirrors `eaf flow adopt`).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';

import * as api from '../../api/client';
import { queryKeys } from '../../lib/queryClient';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import type { EnvironmentDetail } from '../../api/types';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SandboxPanel({ world }: { world: EnvironmentDetail }): JSX.Element {
  const { t } = useTranslation('world');
  const queryClient = useQueryClient();
  const pushToast = useAppStore(s => s.pushToast);
  const [forking, setForking] = useState(false);
  const [adoptFor, setAdoptFor] = useState<string | null>(null);
  const [flowJson, setFlowJson] = useState('');
  const [evalRunId, setEvalRunId] = useState('');

  const sandboxes = useQuery({
    queryKey: queryKeys.environments.sandboxes(world.id),
    queryFn: () => api.listSandboxes(world.id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.sandboxes(world.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.proposals(world.id) });
  };

  const forkMutation = useMutation({
    mutationFn: () => api.createSandbox(world.id, { fromCheckpoint: true }),
    onSuccess: sandbox => {
      pushToast(t('sandbox.forked', { id: sandbox.id.slice(0, 8) }));
      invalidate();
    },
    onError: (error: Error) => pushToast(error.message),
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => api.stopSandbox(id),
    onSuccess: () => {
      pushToast(t('sandbox.stopped'));
      invalidate();
    },
    onError: (error: Error) => pushToast(error.message),
  });

  const adoptMutation = useMutation({
    mutationFn: (input: { forkId: string; definition: Record<string, unknown>; evalRunId?: string }) =>
      api.submitFlowAdoption(world.id, input),
    onSuccess: proposal => {
      pushToast(t('sandbox.adoptSubmitted', { id: proposal.id.slice(0, 8) }));
      setAdoptFor(null);
      setFlowJson('');
      setEvalRunId('');
      invalidate();
    },
    onError: (error: Error) => pushToast(error.message),
  });

  const submitAdopt = () => {
    if (adoptFor === null) return;
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(flowJson) as Record<string, unknown>;
    } catch {
      pushToast(t('sandbox.adoptInvalidJson'));
      return;
    }
    adoptMutation.mutate({
      forkId: adoptFor,
      definition,
      ...(evalRunId.trim().length > 0 ? { evalRunId: evalRunId.trim() } : {}),
    });
  };

  return (
    <section className="world-panel">
      <h3 className="side-panel__title">{t('sandbox.title')}</h3>
      <p className="page-note">{t('sandbox.intro')}</p>
      <div className="sandbox-panel__actions">
        <button
          disabled={forking || forkMutation.isPending}
          onClick={() => {
            setForking(true);
            forkMutation.mutate();
            setForking(false);
          }}
        >
          {t('sandbox.forkButton')}
        </button>
      </div>

      {sandboxes.isLoading ? (
        <p className="page-note">{t('sandbox.loading')}</p>
      ) : sandboxes.isError ? (
        <p className="error-banner">{String((sandboxes.error as Error).message)}</p>
      ) : (sandboxes.data ?? []).length === 0 ? (
        <EmptyState compact icon={FlaskConical} title={t('sandbox.empty')} />
      ) : (
        <ul className="sandbox-list">
          {(sandboxes.data ?? []).map(sandbox => (
            <li key={sandbox.id} className="sandbox-item">
              <div className="sandbox-item__head">
                <span className="sandbox-item__id" title={sandbox.id}>{sandbox.id.slice(0, 8)}</span>
                <span className={`sandbox-item__status sandbox-item__status--${sandbox.status}`}>
                  {sandbox.status === 'active' ? t('sandbox.statusActive') : t('sandbox.statusStopped')}
                </span>
                <span className="sandbox-item__owner">{sandbox.owner.displayName}</span>
                <span className="sandbox-item__time">{formatTime(sandbox.createdAt)}</span>
              </div>
              <div className="sandbox-item__actions">
                {sandbox.simulationId !== null && sandbox.status === 'active' && (
                  <button
                    disabled={stopMutation.isPending}
                    onClick={() => stopMutation.mutate(sandbox.id)}
                  >
                    {t('sandbox.stopButton')}
                  </button>
                )}
                <button onClick={() => setAdoptFor(adoptFor === sandbox.id ? null : sandbox.id)}>
                  {t('sandbox.adoptButton')}
                </button>
              </div>
              {adoptFor === sandbox.id && (
                <div className="sandbox-adopt">
                  <p className="page-note">{t('sandbox.adoptHint')}</p>
                  <textarea
                    className="sandbox-adopt__json"
                    rows={8}
                    placeholder={t('sandbox.adoptPlaceholder')}
                    value={flowJson}
                    onChange={event => setFlowJson(event.target.value)}
                  />
                  <input
                    className="sandbox-adopt__eval"
                    placeholder={t('sandbox.adoptEvalRun')}
                    value={evalRunId}
                    onChange={event => setEvalRunId(event.target.value)}
                  />
                  <button
                    disabled={adoptMutation.isPending || flowJson.trim().length === 0}
                    onClick={submitAdopt}
                  >
                    {t('sandbox.adoptSubmit')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
