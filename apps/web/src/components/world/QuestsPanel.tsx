/**
 * QuestsPanel (R6-D-M1, gamification-design.md §2 机制一) — the world
 * sidebar's「关卡」tab: the L1-L6 quest backbone (安家 → 武装 → 有人值守 →
 * 世界活了 → 第一份合约 → 组合应用) rendered from GET
 * /api/environments/:id/quest-state. The server derives per-quest
 * achieved/locked from real platform facts (devices / trajectory / agreement
 * outcomes / flow runs) — no points or badges (§7 非目标): every tick is a
 * real world state. The current quest shows a guidance line + a jump button
 * to the sidebar tab where the next step happens.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, CircleCheck, Lock } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, QuestHint, QuestState } from '../../api/types';
import { queryKeys } from '../../lib/queryClient';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/Loading';
import type { SidebarTab } from './WorldSidebar';

/** Where each guidance hint's next step lives in the sidebar (null = no jump). */
const HINT_TAB: Record<QuestHint, SidebarTab | null> = {
  'import-building': null,
  'install-blueprint': 'blueprints',
  'bind-agent': 'agents',
  'install-collab-pair': 'blueprints',
  'complete-agreement': 'agreements',
  'compose-flow': 'blueprints',
};

export function QuestsPanel({
  world,
  onTabChange,
}: {
  world: EnvironmentDetail;
  /** Jump target for the current quest's guidance button. */
  onTabChange?: (tab: SidebarTab) => void;
}) {
  const { t } = useTranslation('quests');
  const questQuery = useQuery({
    queryKey: queryKeys.environments.questState(world.id),
    queryFn: () => api.getQuestState(world.id),
  });

  if (questQuery.isPending) {
    return <Loading className="world-sidebar__panel-fallback" />;
  }
  if (questQuery.isError) {
    const error = questQuery.error;
    const message =
      error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error);
    return <p className="page-note page-note--error">{t('loadFailed', { error: message })}</p>;
  }

  const state: QuestState = questQuery.data;
  const done = state.quests.filter(quest => quest.achieved).length;

  return (
    <div className="quest-panel" data-testid="quest-panel">
      <div className="object-list__meta" data-testid="quest-progress">
        {t('progress', { done, total: state.quests.length })}
      </div>
      <div className="quest-progress-bar" aria-hidden="true">
        <span
          className="quest-progress-bar__fill"
          style={{ width: `${(done / state.quests.length) * 100}%` }}
        />
      </div>
      {state.current === null && <EmptyState compact icon={CircleCheck} title={t('allDone')} />}
      {state.quests.map(quest => {
        const isCurrent = state.current === quest.id;
        const targetTab = HINT_TAB[quest.hint];
        return (
          <section
            key={quest.id}
            className={`quest-entry${quest.achieved ? ' quest-entry--done' : ''}${quest.locked ? ' quest-entry--locked' : ''}`}
            data-testid={`quest-${quest.id}`}
          >
            <div className="quest-entry__header">
              {quest.achieved ? (
                <Icon icon={Check} size={14} label={t('stateAchieved')} />
              ) : quest.locked ? (
                <Icon icon={Lock} size={14} label={t('stateLocked')} />
              ) : null}
              <span className="quest-entry__name">{t(`level.${quest.id}.title`)}</span>
              <span className={`badge ${quest.achieved ? 'badge--ok' : isCurrent ? '' : 'badge--warn'}`.trim()}>
                {quest.achieved
                  ? t('stateAchieved')
                  : quest.locked
                    ? t('stateLocked')
                    : t('stateCurrent')}
              </span>
            </div>
            <p className="quest-entry__desc">{t(`level.${quest.id}.desc`)}</p>
            {isCurrent && (
              <div className="quest-entry__guidance" data-testid="quest-guidance">
                <span>{t(`hint.${quest.hint}`)}</span>
                {targetTab !== null && onTabChange !== undefined && (
                  <button className="link-button" onClick={() => onTabChange(targetTab)}>
                    {t('go')}
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
