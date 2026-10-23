/**
 * BlueprintsPanel — the world sidebar's 蓝图 tab (Fix-38). Lists the
 * blueprint templates from GET /api/blueprints (built-in seeds like
 * classroom-energy-saver plus custom ones) and installs one into a chosen
 * zone of the current world via POST …/blueprints/:bpId/install.
 *
 * The server gates install to builder/owner; the panel mirrors that by
 * showing the zone picker + 安装 button only when world.myRole allows it —
 * viewers see the template list read-only.
 *
 * R14 P1-2: a successful install pins a one-shot 系统体检 card on top of the
 * list — the computeAppHealth checklist (lib/appHealth.ts) re-run against
 * the refreshed world — so the builder immediately sees what the install
 * left unwired. It renders once per install and dismisses manually; it is
 * NOT a per-visit nag.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, Package } from 'lucide-react';

import * as api from '../../api/client';
import type { Blueprint, EnvironmentDetail } from '../../api/types';
import { useBlueprintList, useInstallBlueprint } from '../../hooks/useBlueprints';
import { computeAppHealth } from '../../lib/appHealth';
import { queryKeys } from '../../lib/queryClient';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import type { SidebarTab } from './WorldSidebar';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BlueprintsPanel({
  world,
  onTabChange,
}: {
  world: EnvironmentDetail;
  /** Optional jump target for the health card's「应用」总览 button. */
  onTabChange?: (tab: SidebarTab) => void;
}) {
  const { t } = useTranslation('blueprints');
  const { t: tw } = useTranslation('world');
  const pushToast = useAppStore(s => s.pushToast);
  const blueprints = useBlueprintList();
  const install = useInstallBlueprint(world.id);
  /** Per-card zone pick (defaults to the world's first zone). */
  const [zonePick, setZonePick] = useState<Record<string, string>>({});
  /** P1-2: name of the blueprint whose install the health card reports on. */
  const [healthCheck, setHealthCheck] = useState<string | null>(null);
  /**
   * R6-D-S3: after installing a card that carries a partnerSuggestion, pin a
   * one-shot "建议搭配" card offering a one-click install of the partner
   * blueprint into the SAME zone — the shortest path to the L4 quest (first
   * cross-agent collaboration).
   */
  const [pairPrompt, setPairPrompt] = useState<{ partnerId: string; zoneId: string } | null>(null);

  // The env's flows feed the health checks; null while loading/failed (flow
  // findings are skipped then, same convention as AppOverviewPanel).
  const flowsQuery = useQuery({
    queryKey: queryKeys.flows.list(world.id),
    queryFn: () => api.listFlows(world.id),
  });

  const canBuild = world.myRole === 'owner' || world.myRole === 'builder';
  const zones = world.zones;

  const installBp = (bp: Blueprint, fixedZoneId?: string, fromPairCard = false) => {
    const zoneId = fixedZoneId ?? zonePick[bp.id] ?? zones[0]?.id ?? '';
    if (zoneId === '') return;
    install.mutate(
      { bpId: bp.id, zoneId },
      {
        onSuccess: result => {
          pushToast(
            t('installSuccess', {
              name: result.blueprintName,
              devices: result.summary.devices,
              agents: result.summary.agents,
              flows: result.summary.flows,
            }),
          );
          setHealthCheck(result.blueprintName);
          // From the pair card the pair is now complete — don't ping-pong the
          // prompt back to the blueprint just installed from.
          if (bp.definition.partnerSuggestion !== undefined && !fromPairCard) {
            setPairPrompt({ partnerId: bp.definition.partnerSuggestion.blueprintId, zoneId });
          } else {
            setPairPrompt(null);
          }
        },
        onError: error => pushToast(t('installFailed', { error: errorMessage(error) })),
      },
    );
  };

  if (blueprints.isPending) {
    return <p className="page-note">{t('states.loading')}</p>;
  }
  if (blueprints.isError) {
    return (
      <p className="page-note page-note--error">
        {t('states.loadFailed', { error: errorMessage(blueprints.error) })}
      </p>
    );
  }
  if (blueprints.data.length === 0) {
    return <EmptyState icon={Package} title={t('states.empty')} />;
  }

  const health =
    healthCheck === null
      ? null
      : computeAppHealth({
          devices: world.devices,
          agents: world.agents,
          services: world.services,
          zones: world.zones,
          flows: flowsQuery.data ?? null,
        });

  return (
    <div className="blueprint-list">
      {health !== null && (
        <section className="blueprint-card" data-testid="health-check-card">
          <div className="blueprint-card__header">
            <span className="blueprint-card__name">{t('health.title')}</span>
          </div>
          {health.length === 0 ? (
            <p className="page-note">{t('health.allReady')}</p>
          ) : (
            health.map(issue => (
              <div key={`${issue.kind}-${issue.id}`} className="object-detail__row">
                <span className="object-detail__label">{tw(`appOverview.health.${issue.kind}`)}</span>
                {issue.name}
              </div>
            ))
          )}
          <div className="blueprint-card__form">
            {onTabChange !== undefined && (
              <button className="link-button" onClick={() => onTabChange('appOverview')}>
                {t('health.openOverview')}
              </button>
            )}
            <button onClick={() => setHealthCheck(null)}>{t('health.dismiss')}</button>
          </div>
        </section>
      )}
      {pairPrompt !== null && (() => {
        const partner = blueprints.data.find(bp => bp.id === pairPrompt.partnerId);
        if (partner === undefined) return null;
        const installingPair = install.isPending && install.variables?.bpId === partner.id;
        return (
          <section className="blueprint-card" data-testid="pair-suggestion-card">
            <div className="blueprint-card__header">
              <span className="blueprint-card__name">{t('pair.title')}</span>
            </div>
            <p className="blueprint-card__desc">
              {t('pair.prompt', { name: partner.name })}
              {partner.definition.partnerSuggestion?.note !== undefined &&
                ` ${partner.definition.partnerSuggestion.note}`}
            </p>
            <div className="blueprint-card__form">
              <button
                className="primary-button"
                disabled={installingPair}
                onClick={() => {
                  setPairPrompt(null);
                  installBp(partner, pairPrompt.zoneId, true);
                }}
              >
                {installingPair ? t('installing') : t('pair.installNow', { name: partner.name })}
              </button>
              <button onClick={() => setPairPrompt(null)}>{t('health.dismiss')}</button>
            </div>
          </section>
        );
      })()}
      {canBuild && zones.length === 0 && (
        <EmptyState compact icon={MapPin} title={t('states.noZones')} />
      )}
      {blueprints.data.map(bp => {
        const definition = bp.definition;
        const flowCount = definition.flows?.length ?? 0;
        const zoneId = zonePick[bp.id] ?? zones[0]?.id ?? '';
        const installing = install.isPending && install.variables?.bpId === bp.id;
        return (
          <section key={bp.id} className="blueprint-card">
            <div className="blueprint-card__header">
              <span className="blueprint-card__name">{bp.name}</span>
              {bp.isBuiltin && <span className="badge">{t('builtin')}</span>}
            </div>
            {bp.description !== '' && <p className="blueprint-card__desc">{bp.description}</p>}
            <p className="blueprint-card__meta">
              {t('contents', {
                devices: definition.devices.length,
                agents: definition.agents.length,
                flows: flowCount,
              })}
            </p>
            {definition.partnerSuggestion !== undefined && (
              <p className="blueprint-card__meta" data-testid={`pair-hint-${bp.id}`}
                title={definition.partnerSuggestion.note}>
                {t('pair.hint', {
                  name:
                    blueprints.data.find(b => b.id === definition.partnerSuggestion!.blueprintId)
                      ?.name ?? definition.partnerSuggestion.blueprintId,
                })}
              </p>
            )}
            <div className="chip-row">
              {definition.devices.map(device => (
                <span key={device.name} className="chip" title={device.type}>
                  {device.name}
                </span>
              ))}
              {definition.agents.map(agent => (
                <span key={agent.name} className="chip">
                  {agent.name}
                </span>
              ))}
            </div>
            {canBuild && (
              <div className="blueprint-card__form">
                <select
                  aria-label={t('targetZone')}
                  value={zoneId}
                  disabled={zones.length === 0 || installing}
                  onChange={event =>
                    setZonePick(picks => ({ ...picks, [bp.id]: event.target.value }))
                  }
                >
                  {zones.map(zone => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button"
                  disabled={zoneId === '' || installing}
                  onClick={() => installBp(bp)}
                >
                  {installing ? t('installing') : t('install')}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
