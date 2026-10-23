/**
 * Simulation console deep link (R15-D1, R12 遗留): /simulations/:simId.
 *
 * The console itself is an overlay driven by the store's simulationId — it
 * attaches live state (REST poll + WS + replay buffer) that a URL alone
 * cannot carry. This page is the RESTORE SHIM: it resolves the sim id to its
 * environment through the registry list, reopens the console exactly the way
 * the workbench does, and then renders nothing — App swaps in the console
 * overlay once the store holds the sim. A stale link (server restarted, sim
 * gone) lands on a self-explaining note instead of a blank screen.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { useAppStore } from '../store/useAppStore';

export function SimulationConsolePage() {
  const { simId } = useParams<{ simId: string }>();
  const simulationId = useAppStore(s => s.simulationId);
  const openSimulationConsole = useAppStore(s => s.openSimulationConsole);
  const clearSimulation = useAppStore(s => s.clearSimulation);
  const { t } = useTranslation('sim');
  const [fatal, setFatal] = useState(false);

  useEffect(() => {
    if (!simId || simulationId === simId) return;
    let cancelled = false;
    void (async () => {
      try {
        const entry = (await api.listSimulations()).find(sim => sim.id === simId);
        if (cancelled) return;
        if (!entry || !entry.environmentId) {
          // Unknown id, or a legacy scenario-source sim (no environment to
          // reopen against) — both are un-restorable by deep link.
          setFatal(true);
          return;
        }
        await openSimulationConsole(simId, entry.environmentId);
        if (cancelled) return;
        if (useAppStore.getState().simulationError) {
          // The snapshot fetch inside the open failed — the sim is gone
          // (e.g. server restart cleared the in-memory registry).
          clearSimulation();
          setFatal(true);
        }
      } catch {
        if (!cancelled) setFatal(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [simId, simulationId, openSimulationConsole, clearSimulation]);

  if (fatal) {
    return (
      <div className="page-note page-note--error">
        <h2>{t('consoleRestore.title')}</h2>
        <p>{t('consoleRestore.body')}</p>
        <Link className="link-button" to="/environments">{t('consoleRestore.back')}</Link>
      </div>
    );
  }
  return <p className="page-note">{t('consoleRestore.loading')}</p>;
}
