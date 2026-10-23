/**
 * WorkbenchPage — 工作台, the W5 post-login landing: 我的视角看"我有什么 /
 * 我用什么 / 我在参与什么 / 我要构建什么".
 *
 * Content comes from GET /api/me/overview (via TanStack Query —
 * hooks/useOverview owns the fetch and the optimistic 取消收藏):
 * - a greeting header + quick actions (新建环境 / 浏览环境 — the env home
 *   keeps the create dialog and the public-env browser; the service
 *   marketplace lives inside each world's 服务 tab);
 * - one card per environment the caller participates in: role, 我的
 *   设备/Agent/服务 counts, 我的依赖 count, 运行中仿真 count (click attaches
 *   the sim console to that live simulation);
 * - a totals row across environments;
 * - two flat sections: 我发布的服务 (all envs) and 我依赖的服务 (with an
 *   unsubscribe button per row);
 * - for admins (user.isAdmin from /auth/me), the 系统 observability card
 *   (P4-4, ObservabilityCard) polling /api/admin/observability.
 */

import { Boxes, Inbox, Star } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { MeOverview } from '../api/types';
import { useOverview, useUnsubscribeFromWorkbench } from '../hooks/useOverview';
import { isWorkbenchEmpty, workbenchCards, type WorkbenchCard } from '../lib/workbench';
import { useAppStore } from '../store/useAppStore';
import { ObservabilityCard } from '../components/ObservabilityCard';
import {
  OnboardingChecklist,
  onboardingWasHidden,
  resetOnboardingPrefs,
} from '../components/OnboardingChecklist';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { useRoleLabel } from '../i18n/index';
import { useTranslation } from 'react-i18next';

export function WorkbenchPage() {
  const user = useAppStore(s => s.user);
  const { t } = useTranslation('workbench');
  const { data: overview = null, error, isLoading, refetch } = useOverview();
  const navigate = useNavigate();
  // R2-FEAT-07: 「不再显示」/庆祝态关闭后的恢复入口 —— 引导隐藏时 hint 行
  // 尾出现「重新显示新手引导」，点击清 localStorage 并 remount 清单。
  const [guideHidden, setGuideHidden] = useState(onboardingWasHidden);
  const [guideReset, setGuideReset] = useState(0);
  const reshowGuide = () => {
    resetOnboardingPrefs();
    setGuideHidden(false);
    setGuideReset(n => n + 1);
  };

  return (
    <div className="home-page workbench">
      <div className="home-toolbar">
        <div>
          <h3 className="workbench__greeting">
            {user ? t('headerUser', { name: user.displayName }) : t('headerAnon')}
          </h3>
          <p className="page-note workbench__tagline">{t('tagline')}</p>
        </div>
        <div className="workbench__actions">
          <button className="primary-button" onClick={() => navigate('/environments')}>
            {t('newEnv')}
          </button>
          <button onClick={() => navigate('/environments')}>{t('browseEnv')}</button>
        </div>
      </div>

      {error && (
        <div className="page-note page-note--error">
          <p>{t('loadFailed', { error: error.message })}</p>
          <button onClick={() => void refetch()}>{t('retry')}</button>
        </div>
      )}
      {/* W1b 新手引导: hides itself once dismissed/celebrated; R2-FEAT-07
          完成判定见 lib/onboarding.ts（不再被模板导入/自动世界会话瞬间完成）。 */}
      {overview !== null && (
        <OnboardingChecklist
          key={guideReset}
          overview={overview}
          onHidden={() => setGuideHidden(true)}
        />
      )}
      {!error && isLoading && overview === null && <p className="page-note">{t('loading')}</p>}
      {overview !== null && <OverviewBody overview={overview} />}

      {/* P4-4: the 系统 card is admin-only (user.isAdmin comes from /auth/me). */}
      {user?.isAdmin === true && <ObservabilityCard />}
      {/* Invite-only alpha operations: the admin panel entry lives beside
          the 系统 card (same isAdmin gate). */}
      {user?.isAdmin === true && (
        <p className="page-note">
          <Link className="link-button" to="/admin">
            {t('adminLink')}
          </Link>
        </p>
      )}

      <p className="page-note workbench__hint">
        {t('hint')}
        {guideHidden && (
          <>
            {' · '}
            <button className="link-button" onClick={reshowGuide}>
              {t('reshowGuide')}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function OverviewBody({ overview }: { overview: MeOverview }) {
  const navigate = useNavigate();
  const { t } = useTranslation('workbench');
  const cards = workbenchCards(overview);
  // Defensive: pre-Fix-16 servers (and stale caches) omit the todos block.
  const todos = overview.todos ?? {
    pendingProposals: 0,
    pendingAgreements: 0,
    unreadNotifications: 0,
  };
  return (
    <>
      {(todos.pendingProposals > 0 ||
        todos.pendingAgreements > 0 ||
        todos.unreadNotifications > 0) && (
        <p className="page-note workbench__todos" data-testid="workbench-todos">
          {t('todosPrefix')}
          {todos.pendingProposals > 0 && ` ${t('todoProposal', { count: todos.pendingProposals })}`}
          {todos.pendingAgreements > 0 && ` ${t('todoAgreement', { count: todos.pendingAgreements })}`}
          {todos.unreadNotifications > 0 && (
            <Link className="link-button" to="/notifications">
              {t('todoUnread', { count: todos.unreadNotifications })}
            </Link>
          )}
        </p>
      )}
      {cards.length === 0 && (
        <div className="empty-state">
          <Icon icon={Boxes} size={28} className="empty-state__icon" />
          <p className="empty-state__title">{t('emptyTitle')}</p>
          <p className="empty-state__note">{t('emptyNote')}</p>
          <div className="empty-state__actions">
            <button className="primary-button" onClick={() => navigate('/environments')}>
              {t('emptyNewEnv')}
            </button>
            {/* R15-D10 / R2-UX-13: 不预设受众（校园/企业/医院皆可）——指向
                公开环境目录，受邀用户经邀请邮箱自动加入对应环境。 */}
            <button onClick={() => navigate('/environments?tab=public')}>
              {t('emptyFindClass')}
            </button>
          </div>
          <p className="page-note empty-state__invite-hint">{t('invitedHint')}</p>
        </div>
      )}
      {cards.length > 0 && isWorkbenchEmpty(overview) && (
        <EmptyState compact icon={Inbox} title={t('nothingYet')} />
      )}
      <div className="scenario-grid">
        {cards.map(card => (
          <WorkbenchEnvCard key={card.id} card={card} />
        ))}
      </div>
      <div className="workbench__totals">
        {t('totals', {
          envs: overview.totals.environments,
          devices: overview.totals.myDevices,
          agents: overview.totals.myAgents,
          services: overview.totals.myServices,
          subs: overview.totals.mySubscriptions,
          // T63 (R6, u2-F-2-1): a refetch racing the render used to
          // interpolate `undefined` and blank the figure (3→2→空白→2→1).
          // Guard every count — a missing number renders 0, never blank.
          running: overview.totals.runningSimulations ?? 0,
        })}
      </div>
      <MyServicesSection overview={overview} />
      <MySubscriptionsSection overview={overview} />
    </>
  );
}

function WorkbenchEnvCard({ card }: { card: WorkbenchCard }) {
  const roleLabel = useRoleLabel();
  const { t } = useTranslation('workbench');
  const openSimulationConsole = useAppStore(s => s.openSimulationConsole);
  const navigate = useNavigate();

  return (
    <div className="scenario-card env-card">
      <div className="scenario-card__header">
        <button
          className="link-button scenario-card__name workbench__env-link"
          onClick={() => navigate(`/environments/${card.id}`)}
        >
          {card.name}
        </button>
        <span className="env-card__badges">
          <span className="badge">{card.mapType}</span>
          <span className="badge badge--user">{roleLabel(card.myRole)}</span>
        </span>
      </div>
      <div className="scenario-card__counts workbench__counts">
        <Badge>{card.myDevices} {t('cardMyDevices')}</Badge>
        <Badge>{card.myAgents} {t('cardAgents')}</Badge>
        <Badge>{card.myServices} {t('cardServices')}</Badge>
        <Badge>{card.mySubscriptions} {t('cardSubs')}</Badge>
      </div>
      <div className="env-card__actions">
        <button className="primary-button" onClick={() => navigate(`/environments/${card.id}`)}>
          {t('cardEnter')}
        </button>
        {/* R2-UX-12: 运行中仿真 (0) 与世界会话并存时，「0」曾是唯一信号——
            补「世界会话活跃」徽标（R73 always-on 世界不创建仿真）。 */}
        {(card.runningSimulations ?? 0) === 0 && card.hasWorldSession === true && (
          <Badge variant="ok" className="badge--world-session">
            {t('cardWorldSession')}
          </Badge>
        )}
        <button
          disabled={card.attachableSimulationId === null}
          title={
            card.attachableSimulationId === null ? t('cardNoSim') : t('cardAttachSim')
          }
          onClick={() =>
            card.attachableSimulationId !== null &&
            void openSimulationConsole(card.attachableSimulationId, card.id)
          }
        >
          {t('cardRunningSim', { count: card.runningSimulations ?? 0 })}
        </button>
      </div>
    </div>
  );
}

function MyServicesSection({ overview }: { overview: MeOverview }) {
  const { t } = useTranslation('workbench');
  return (
    <section className="workbench-section">
      <h4 className="workbench-section__title">{t('myServices', { count: overview.myServices.length })}</h4>
      {overview.myServices.length === 0 && (
        <EmptyState compact icon={Inbox} title={t('servicesEmpty')} />
      )}
      <div className="object-list">
        {overview.myServices.map(service => (
          <div key={service.id} className="object-list__item workbench-row">
            <span className="object-list__name" title={service.name}>{service.name}</span>
            <span className="chip">{service.semanticType}</span>
            <span className="badge">
              {service.origin === 'derived' ? t('originDerived') : t('originPublished')}
            </span>
            <span className="object-list__meta">{service.envName}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MySubscriptionsSection({ overview }: { overview: MeOverview }) {
  const { t } = useTranslation('workbench');
  const unsubscribe = useUnsubscribeFromWorkbench();
  return (
    <section className="workbench-section">
      <h4 className="workbench-section__title">{t('mySubscriptions', { count: overview.mySubscriptions.length })}</h4>
      {overview.mySubscriptions.length === 0 && (
        <EmptyState compact icon={Inbox} title={t('subsEmpty')} />
      )}
      <div className="object-list">
        {overview.mySubscriptions.map(service => (
          <div key={service.id} className="object-list__item workbench-row">
            <span className="service-star service-star--filled" title={t('bookmarked')}>
              <Icon icon={Star} size={14} fill="currentColor" />
            </span>
            <span className="object-list__name" title={service.name}>{service.name}</span>
            <span className="object-list__meta">
              {t('providerMeta', {
                agent: service.provider.agentName,
                owner: service.provider.ownerName,
                envName: service.envName,
              })}
            </span>
            <button
              className="link-button"
              disabled={unsubscribe.isPending && unsubscribe.variables === service.id}
              onClick={() => unsubscribe.mutate(service.id)}
            >
              {/* W1: 取消收藏的 busy 态（曾点击无反馈、可重复触发）。 */}
              {unsubscribe.isPending && unsubscribe.variables === service.id
                ? t('unsubscribing')
                : t('unsubscribe')}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
