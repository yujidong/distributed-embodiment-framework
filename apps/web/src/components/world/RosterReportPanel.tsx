/**
 * RosterReportPanel — the world sidebar's 评分报告 tab (Fix-37), owner-only
 * (WorldSidebar injects the tab only when world.myRole === 'owner'). Renders
 * GET /api/environments/:id/roster-report as a per-member grading table
 * (devices/agents/flows/services counts with an expandable inventory) and a
 * 下载 CSV link to the same endpoint's ?format=csv variant — the session
 * rides on the httpOnly cookie, so no extra auth handling is needed.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';

import * as api from '../../api/client';
import type { EnvironmentDetail, RosterReportEntry } from '../../api/types';
import { useRosterReport } from '../../hooks/useEnvironments';
import { useRoleLabel } from '../../i18n/index';
import { EmptyState } from '../ui/EmptyState';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RosterReportPanel({ world }: { world: EnvironmentDetail }) {
  const { t } = useTranslation('rosterReport');
  const roleLabel = useRoleLabel();
  const report = useRosterReport(world.id);
  /** userId of the entry whose inventory is expanded (null = all collapsed). */
  const [expanded, setExpanded] = useState<string | null>(null);

  if (report.isPending) {
    return <p className="page-note">{t('states.loading')}</p>;
  }
  if (report.isError) {
    return (
      <p className="page-note page-note--error">
        {t('states.loadFailed', { error: errorMessage(report.error) })}
      </p>
    );
  }

  const data = report.data;
  return (
    <div className="roster-report">
      <div className="roster-report__header">
        <span className="page-note">
          {t('summary', {
            count: data.totalMembers,
            time: new Date(data.generatedAt).toLocaleString(),
          })}
        </span>
        <a className="primary-button roster-report__download" href={api.rosterReportCsvUrl(world.id)} download>
          {t('downloadCsv')}
        </a>
      </div>
      {data.entries.length === 0 && <EmptyState compact icon={Users} title={t('states.empty')} />}
      {data.entries.length > 0 && (
        <table className="roster-report__table">
          <thead>
            <tr>
              <th>{t('thMember')}</th>
              <th>{t('thRole')}</th>
              <th>{t('thDevices')}</th>
              <th>{t('thAgents')}</th>
              <th>{t('thFlows')}</th>
              <th>{t('thServices')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map(entry => (
              <RosterRow
                key={entry.userId}
                entry={entry}
                roleLabel={roleLabel(entry.role)}
                expanded={expanded === entry.userId}
                onToggle={() =>
                  setExpanded(current => (current === entry.userId ? null : entry.userId))
                }
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RosterRow({
  entry,
  roleLabel,
  expanded,
  onToggle,
}: {
  entry: RosterReportEntry;
  roleLabel: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('rosterReport');
  const { inventory } = entry;
  const joinOr = (items: string[]) => (items.length > 0 ? items.join('、') : t('inventoryEmpty'));
  return (
    <>
      <tr>
        <td>
          <div className="roster-report__name">{entry.displayName}</div>
          {entry.email !== '' && <div className="roster-report__email">{entry.email}</div>}
        </td>
        <td>
          <span className="badge">{roleLabel}</span>
        </td>
        <td>{entry.counts.devices}</td>
        <td>{entry.counts.agents}</td>
        <td>{entry.counts.flows}</td>
        <td>{entry.counts.services}</td>
        <td>
          <button className="link-button" aria-expanded={expanded} onClick={onToggle}>
            {t('detail')}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="roster-report__inventory-row">
          <td colSpan={7}>
            {/* R12-5c-B: 限高 + 内部滚动 — 156 台设备的明细不再灌满侧栏；
                类目标题带计数，一眼看清规模。 */}
            <div className="roster-report__inventory-scroll">
              <div className="roster-report__inventory">
                <span className="object-detail__label">
                  {t('inventoryDevices')}（{inventory.devices.length}）
                </span>
                {joinOr(inventory.devices.map(d => `${d.name}（${d.type}）`))}
              </div>
              <div className="roster-report__inventory">
                <span className="object-detail__label">
                  {t('inventoryAgents')}（{inventory.agents.length}）
                </span>
                {joinOr(inventory.agents.map(a => a.name))}
              </div>
              <div className="roster-report__inventory">
                <span className="object-detail__label">
                  {t('inventoryFlows')}（{inventory.flows.length}）
                </span>
                {joinOr(
                  inventory.flows.map(f => (f.enabled ? f.name : `${f.name}${t('flowDisabledSuffix')}`)),
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
