/**
 * DeploymentPanel — the world sidebar's 部署 tab, now the DEPLOYMENT CENTER
 * (P3b). Design note: rather than adding a separate tab, the existing 部署
 * tab hosts the Home Assistant bridge UI in new sections ABOVE the W5
 * manifest sections:
 *
 *   HA连接     — bridge status from GET /hass/status (lazy, error-tolerant)
 *   设备绑定   — per-device sim:// ↔ hass:// binding editor with an entity
 *                picker (builder/owner only; viewers read-only)
 *   安全控制台 — pending approvals, safety policies, emergency stop, and the
 *                audit feed (auto-refresh every 5s while the tab is open)
 *   指令测试   — manual actuation against a running sim with gate feedback
 *                (a parked command toasts 已提交审批, NOT an error)
 *
 * …then the W5 manifest (待采购设备 / 我要提供的服务 / 我依赖的外部服务 /
 * 我的 Agent) with its 导出 JSON button, unchanged.
 *
 * All HA logic lives in lib/hass.ts (pure, unit-tested); this file wires
 * state and events. Every HA call tolerates failure with a small inline note
 * — a misconfigured bridge must never crash the tab.
 *
 * Members only server-side: anonymous visitors get a login prompt; the
 * manifest itself 403s for logged-in non-members (they still get the HA
 * sections, with a join prompt in place of the manifest).
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Handshake,
  History,
  MonitorOff,
  ScrollText,
  SearchX,
  ShieldCheck,
  Star,
  Unplug,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import * as reverseSyncApi from '../../api/hassReverseSync';
import type { HassReverseSyncStatus } from '../../api/hassReverseSync';
import * as shadowApi from '../../api/hassShadow';
import type { HassShadowStatus } from '../../api/hassShadow';
import type {
  DeploymentManifest,
  EnvironmentDetail,
  HassAuditEntry,
  HassEntitySummary,
  HassEstopState,
  HassPendingCommand,
  HassPolicy,
  HassStatus,
  PolicyEffect,
  SimulationListEntry,
} from '../../api/types';
import { deploymentView, downloadManifest } from '../../lib/deployment';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import type { DeploymentStepId } from '../../lib/deploymentSteps';
import { DEPLOYMENT_STEPS, isStepComplete, suggestStep } from '../../lib/deploymentSteps';
import {
  AUDIT_DECISION_LABEL,
  BINDING_CHANGE_HINT,
  BINDING_KIND_LABEL,
  HASS_STATE_LABEL,
  HASS_UNCONFIGURED_HINT,
  POLICY_EFFECT_LABEL,
  auditDecisionTone,
  bindingKind,
  clockTime,
  commandFeedback,
  compactJson,
  entityDomains,
  filterHassEntities,
  hassBindingUri,
  hassBoundDevices,
  parseParamsJson,
  policyPatternError,
  policyScopeLabel,
  runningSimulationsOf,
} from '../../lib/hass';
import { SERVICE_ORIGIN_LABEL } from '../../lib/services';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';

/** Audit rows shown in the 安全控制台 (auto-refreshed). */
const AUDIT_LIMIT = 20;
/** Audit feed refresh cadence while the tab is open. */
const AUDIT_POLL_MS = 5000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DeploymentPanel({ world }: { world: EnvironmentDetail }) {
  const user = useAppStore(s => s.user);
  const { t } = useTranslation('deployment');
  const [manifest, setManifest] = useState<DeploymentManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // HA bridge status — loaded lazily when the tab opens (never fatal).
  const [hassStatus, setHassStatus] = useState<HassStatus | null>(null);
  const [hassStatusError, setHassStatusError] = useState<string | null>(null);
  const [hassStatusLoading, setHassStatusLoading] = useState(true);

  // Bumped by 指令测试 when a command gets parked; the 安全控制台 refetches.
  const [pendingVersion, setPendingVersion] = useState(0);

  // W5 向导 stepper：完成态从各段已有数据推导（lib/deploymentSteps.ts）。
  // openStep 为用户显式点开的步；未点过时回落到第一个未完成的建议步。
  const [openStep, setOpenStep] = useState<DeploymentStepId | null>(null);
  // SafetySection 上报的状态源快照（待审批数 + 急停是否已知），用于第 ③ 步判定。
  const [safetyStatus, setSafetyStatus] = useState<{
    pendingCount: number | null;
    estopKnown: boolean;
  }>({ pendingCount: null, estopKnown: false });

  const stepInput = {
    hassStatus,
    boundCount: hassBoundDevices(world.devices).length,
    pendingCount: safetyStatus.pendingCount,
    estopKnown: safetyStatus.estopKnown,
  };
  const expandedStep = openStep ?? suggestStep(stepInput);

  const worldId = world.id;
  useEffect(() => {
    if (user === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    void (async () => {
      try {
        const data = await api.getDeployment(worldId);
        if (!cancelled) setManifest(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 403) setForbidden(true);
        else setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worldId, user]);

  useEffect(() => {
    if (user === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.getHassStatus();
        if (!cancelled) setHassStatus(status);
      } catch (err) {
        if (!cancelled) setHassStatusError(errorMessage(err));
      } finally {
        if (!cancelled) setHassStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const view = useMemo(
    () => (manifest ? deploymentView(manifest, world.zones) : null),
    [manifest, world.zones],
  );

  if (user === null) {
    return <p className="page-note">{t('states.loginRequired')}</p>;
  }

  return (
    <div className="deployment">
      <ol className="deployment-steps">
        {DEPLOYMENT_STEPS.map((step, index) => {
          const complete = isStepComplete(step.id, stepInput);
          const current = step.id === expandedStep;
          return (
            <li key={step.id} className="deployment-steps__item">
              <button
                type="button"
                className={
                  `deployment-steps__button${current ? ' deployment-steps__button--current' : ''}` +
                  `${complete ? ' deployment-steps__button--done' : ''}`
                }
                aria-current={current ? 'step' : undefined}
                onClick={() => setOpenStep(step.id)}
              >
                <span className="deployment-steps__marker">
                  {complete ? <Icon icon={Check} size={12} /> : index + 1}
                </span>
                {t(step.titleKey)}
              </button>
            </li>
          );
        })}
      </ol>
      <StepShell
        step="connect"
        index={0}
        title={t('steps.connect')}
        complete={isStepComplete('connect', stepInput)}
        expanded={expandedStep === 'connect'}
        onOpen={setOpenStep}
      >
        <HassStatusCard
          status={hassStatus}
          error={hassStatusError}
          loading={hassStatusLoading}
        />
      </StepShell>
      <StepShell
        step="bind"
        index={1}
        title={t('steps.bind')}
        complete={isStepComplete('bind', stepInput)}
        expanded={expandedStep === 'bind'}
        onOpen={setOpenStep}
      >
        <BindingSection world={world} hassStatus={hassStatus} />
      </StepShell>
      <StepShell
        step="safety"
        index={2}
        title={t('steps.safety')}
        complete={isStepComplete('safety', stepInput)}
        expanded={expandedStep === 'safety'}
        onOpen={setOpenStep}
      >
        <SafetySection
          world={world}
          pendingVersion={pendingVersion}
          onStatus={setSafetyStatus}
          expanded={expandedStep === 'safety'}
        />
      </StepShell>
      <StepShell
        step="test"
        index={3}
        title={t('steps.test')}
        complete={false}
        expanded={expandedStep === 'test'}
        onOpen={setOpenStep}
      >
        <CommandTestSection world={world} onPendingParked={() => setPendingVersion(v => v + 1)} />
      </StepShell>

      {/* HIL 反向映射 P1：只读状态区（策略 + 漂移 + 手动对齐 + 最近记录）。 */}
      <ReverseSyncSection />

      {/* HIL 反向映射 P2：影子环境状态区（fork + 观测 + 残差 + 致动丢弃）。 */}
      <ShadowSection envId={world.id} />

      {forbidden && (
        <p className="page-note">{t('states.membersOnly')}</p>
      )}
      {!forbidden && error !== null && (
        <p className="page-note page-note--error">{t('states.loadFailed', { error })}</p>
      )}
      {!forbidden && error === null && (loading || manifest === null || view === null) && (
        <p className="page-note">{t('states.loading')}</p>
      )}
      {!forbidden && error === null && manifest !== null && view !== null && (
        <>
          <div className="deployment__header">
            <span className="object-detail__label">
              {manifest.environment.name} {t('pageHeaderSuffix')}
            </span>
            <button onClick={() => downloadManifest(manifest)}>{t('exportJson')}</button>
          </div>

          {view.notes.length > 0 && (
            <div className="deployment__notes">
              {view.notes.map(note => (
                <p key={note} className="deployment__note">
                  {note}
                </p>
              ))}
            </div>
          )}

          <section className="deployment__section">
            <h5 className="deployment__title">{t('sections.devicesToBuy', { count: view.deviceRows.length })}</h5>
            {view.deviceRows.length === 0 && (
              <EmptyState compact icon={Cpu} title={t('sections.devicesEmpty')} />
            )}
            {view.deviceRows.length > 0 && (
              <table className="deployment__table">
                <thead>
                  <tr>
                    <th>{t('sections.devicesTHName')}</th>
                    <th>{t('sections.devicesTHVendorModel')}</th>
                    <th>{t('sections.devicesTHZone')}</th>
                    <th>{t('sections.devicesTHPrice')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {view.deviceRows.map(device => (
                    <tr key={device.instanceId}>
                      <td>{device.name}</td>
                      <td>
                        {device.vendor !== undefined
                          ? `${device.vendor}${device.model !== undefined ? ` ${device.model}` : ''}`
                          : '—'}
                      </td>
                      <td>{device.zoneName}</td>
                      <td>{device.priceCny !== undefined ? `¥${device.priceCny}` : '—'}</td>
                      <td>
                        {device.purchaseUrl !== undefined && (
                          <a
                            className="deployment__buy"
                            href={device.purchaseUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={t('sections.buyLinkTitle')}
                          >
                            🔗
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {view.purchasableCount > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={3}>{t('sections.totalLabel', { count: view.purchasableCount })}</td>
                      <td colSpan={2}>{t('sections.totalApprox', { total: view.totalPriceCny })}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </section>

          <section className="deployment__section">
            <h5 className="deployment__title">{t('sections.servicesToOffer', { count: view.servicesToOffer.length })}</h5>
            {view.servicesToOffer.length === 0 && (
              <EmptyState compact icon={Handshake} title={t('sections.servicesToOfferEmpty')} />
            )}
            {view.servicesToOffer.map(service => (
              <div key={service.id} className="object-list__item">
                <span className="object-list__name" title={service.name}>{service.name}</span>
                <span className="object-list__meta">
                  <span className="chip">{service.semanticType}</span>{' '}
                  {SERVICE_ORIGIN_LABEL[service.origin]} · {t('sections.servicesToOfferMeta', { count: service.backedByDeviceIds.length })}
                </span>
              </div>
            ))}
          </section>

          <section className="deployment__section">
            <h5 className="deployment__title">{t('sections.servicesConsumed', { count: view.servicesConsumed.length })}</h5>
            {view.servicesConsumed.length === 0 && (
              <EmptyState compact icon={Handshake} title={t('sections.servicesConsumedEmpty')} />
            )}
            {view.servicesConsumed.map(service => (
              <div key={service.id} className="object-list__item">
                <span className="service-star service-star--filled">
                  <Icon icon={Star} size={14} fill="currentColor" />
                </span>
                <span className="object-list__name" title={service.name}>{service.name}</span>
                <span className="object-list__meta">
                  {t('sections.servicesConsumedMeta', { agent: service.provider.agentName, owner: service.provider.ownerName })}
                </span>
              </div>
            ))}
          </section>

          {manifest.myAgents.length > 0 && (
            <section className="deployment__section">
              <h5 className="deployment__title">{t('sections.myAgents', { count: manifest.myAgents.length })}</h5>
              {manifest.myAgents.map(agent => (
                <div key={agent.id} className="object-list__item">
                  <span className="object-list__name" title={agent.name}>{agent.name}</span>
                  <span className="object-list__meta">
                    {t('sections.myAgentsCapabilities', { count: agent.capabilities.length })}
                    {agent.llm
                      ? t('sections.myAgentsLlm', { provider: agent.llm.provider, model: agent.llm.model })
                      : t('sections.myAgentsNoLlm')}
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// W5 向导 StepShell — 段标题 + 折叠箭头，包在各 Section 外（不动 Section 内部）
// ---------------------------------------------------------------------------

function StepShell({
  step,
  index,
  title,
  complete,
  expanded,
  onOpen,
  children,
}: {
  step: DeploymentStepId;
  index: number;
  title: string;
  complete: boolean;
  expanded: boolean;
  onOpen: (step: DeploymentStepId) => void;
  children: ReactNode;
}) {
  return (
    <div className={`deployment-step${expanded ? ' deployment-step--open' : ''}`}>
      <button
        type="button"
        className="deployment-step__header"
        aria-expanded={expanded}
        onClick={() => onOpen(step)}
      >
        <span className={`deployment-step__index${complete ? ' deployment-step__index--done' : ''}`}>
          {complete ? <Icon icon={Check} size={12} /> : index + 1}
        </span>
        <span className="deployment-step__title">{title}</span>
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
      </button>
      {/* 保持挂载只隐藏：Section 内部的表单状态与轮询不因折叠丢失。 */}
      <div className="deployment-step__body" hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HA连接 — bridge status card
// ---------------------------------------------------------------------------

function HassStatusCard({
  status,
  error,
  loading,
}: {
  status: HassStatus | null;
  error: string | null;
  loading: boolean;
}) {
  const { t } = useTranslation('deployment');
  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('ha.statusTitle')}</h5>
      {loading && <p className="page-note">{t('ha.statusQuerying')}</p>}
      {!loading && error !== null && (
        <p className="page-note page-note--error">{t('ha.statusFailed', { error })}</p>
      )}
      {!loading && error === null && status !== null && !status.configured && (
        <p className="page-note">{HASS_UNCONFIGURED_HINT()}</p>
      )}
      {!loading && error === null && status !== null && status.configured && (
        <div className="object-detail__row">
          <span className="badge badge--hass">{HASS_STATE_LABEL[status.state]}</span>
          {status.state === 'ready' && status.entityCount !== undefined && (
            <span className="page-note">{t('ha.statusEntityCount', { count: status.entityCount })}</span>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 设备绑定 — per-device sim:// ↔ hass:// editor
// ---------------------------------------------------------------------------

function BindingSection({
  world,
  hassStatus,
}: {
  world: EnvironmentDetail;
  hassStatus: HassStatus | null;
}) {
  const { t } = useTranslation('deployment');
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const canBuild = world.myRole === 'owner' || world.myRole === 'builder';
  /** Device whose entity picker is open (null = picker closed). */
  const [pickerDeviceId, setPickerDeviceId] = useState<string | null>(null);

  const rebind = async (deviceId: string, binding: string | null) => {
    try {
      const device = await api.patchDevice(deviceId, { binding });
      // R98: a builder's rebind converts into a modify-object proposal.
      if (api.isProposalConversion(device)) {
        if (device.status !== 'rejected') {
          pushToast(t('ha.bindProposalToast', { id: device.id }));
        }
        setPickerDeviceId(null);
        return;
      }
      // Optimistic apply; the world-stream broadcast dedupes by id.
      applyWorldMessage({
        kind: 'world',
        action: 'updated',
        objectType: 'device',
        object: device,
      });
      setPickerDeviceId(null);
    } catch (error) {
      pushToast(
        binding === null
          ? t('ha.unbindFailedToast', { error: errorMessage(error) })
          : t('ha.bindFailedToast', { error: errorMessage(error) }),
      );
    }
  };

  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('ha.bindingTitle', { count: world.devices.length })}</h5>
      <p className="page-note">{BINDING_CHANGE_HINT()}</p>
      {world.devices.length === 0 && (
        <EmptyState compact icon={Unplug} title={t('ha.bindingEmpty')} />
      )}
      {world.devices.length > 0 && (
        <table className="deployment__table">
          <thead>
            <tr>
              <th>{t('ha.bindingTHName')}</th>
              <th>{t('ha.bindingTHType')}</th>
              <th>{t('ha.bindingTHBinding')}</th>
              {canBuild && <th></th>}
            </tr>
          </thead>
          <tbody>
            {world.devices.map(device => {
              const kind = bindingKind(device.binding);
              return (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{device.type}</td>
                  <td>
                    <span className={`badge badge--binding-${kind}`}>
                      {BINDING_KIND_LABEL[kind]}
                    </span>{' '}
                    <span className="deployment__binding-id">{device.binding}</span>
                  </td>
                  {canBuild && (
                    <td className="deployment__row-actions">
                      <button
                        className="link-button"
                        onClick={() =>
                          setPickerDeviceId(open => (open === device.id ? null : device.id))
                        }
                      >
                        {kind === 'hass' ? t('ha.rebind') : t('ha.bind')}
                      </button>
                      {kind === 'hass' && (
                        <button
                          className="link-button"
                          onClick={() => void rebind(device.id, null)}
                        >
                          {t('ha.unbind')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {pickerDeviceId !== null && (
        <EntityPicker
          hassStatus={hassStatus}
          onPick={entityId => void rebind(pickerDeviceId, hassBindingUri(entityId))}
          onClose={() => setPickerDeviceId(null)}
        />
      )}
    </section>
  );
}

/** The HA entity picker behind 绑定/改绑 (fetch once, filter client-side). */
function EntityPicker({
  hassStatus,
  onPick,
  onClose,
}: {
  hassStatus: HassStatus | null;
  onPick: (entityId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('deployment');
  const [entities, setEntities] = useState<HassEntitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState<string | null>(null);

  const configured = hassStatus?.configured === true;
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listHassEntities();
        if (!cancelled) setEntities(list);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configured]);

  if (!configured) {
    return (
      <div className="deployment__picker">
        <p className="page-note">{HASS_UNCONFIGURED_HINT()}</p>
        <button className="link-button" onClick={onClose}>
          {t('ha.pickerClose')}
        </button>
      </div>
    );
  }

  const filtered = entities === null ? [] : filterHassEntities(entities, { q, domain });
  const domains = entities === null ? [] : entityDomains(entities);

  return (
    <div className="deployment__picker">
      <div className="deployment__picker-controls">
        <input
          value={q}
          onChange={event => setQ(event.target.value)}
          placeholder={t('ha.pickerSearchPlaceholder')}
        />
        <select
          value={domain ?? ''}
          onChange={event => setDomain(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{t('ha.pickerAllDomains')}</option>
          {domains.map(d => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="link-button" onClick={onClose}>
          {t('ha.pickerClose')}
        </button>
      </div>
      {error !== null && (
        <p className="page-note page-note--error">{t('ha.pickerLoadFailed', { error })}</p>
      )}
      {error === null && entities === null && <p className="page-note">{t('ha.pickerLoading')}</p>}
      {entities !== null && filtered.length === 0 && (
        <EmptyState compact icon={SearchX} title={t('ha.pickerEmpty')} />
      )}
      {filtered.map(entity => (
        <button
          key={entity.entityId}
          className="object-list__item"
          onClick={() => onPick(entity.entityId)}
        >
          <span className="object-list__name" title={entity.friendlyName}>{entity.friendlyName}</span>
          <span className="object-list__meta">
            {entity.entityId} · {entity.state}
            {entity.capabilities.length > 0
              ? ` · ${entity.capabilities.slice(0, 3).join(', ')}`
              : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 安全控制台 — pending approvals, policies, E-stop, audit feed
// ---------------------------------------------------------------------------

function SafetySection({
  world,
  pendingVersion,
  onStatus,
  expanded,
}: {
  world: EnvironmentDetail;
  /** Bumped externally (指令测试 parked a command) to trigger a pending refetch. */
  pendingVersion: number;
  /** W5 stepper: reports the state sources used for the 安全闸 completion check. */
  onStatus?: (status: { pendingCount: number | null; estopKnown: boolean }) => void;
  /**
   * T-028/EA-F07: StepShell keeps collapsed sections MOUNTED (hidden), so
   * the audit feed's 5s interval used to keep hitting /api/hass/audit for
   * the lifetime of the world view once the 部署 tab had ever been opened.
   * The poll now runs only while this step is expanded; re-expanding
   * restarts it with an immediate refresh.
   */
  expanded: boolean;
}) {
  const { t } = useTranslation('deployment');
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const [pending, setPending] = useState<HassPendingCommand[] | null>(null);
  const [policies, setPolicies] = useState<HassPolicy[] | null>(null);
  const [audit, setAudit] = useState<HassAuditEntry[] | null>(null);
  const [estop, setEstop] = useState<HassEstopState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-rule form state.
  const [pattern, setPattern] = useState('');
  const [effect, setEffect] = useState<PolicyEffect>('confirm');
  const [scope, setScope] = useState<'env' | 'global'>('env');

  const worldId = world.id;

  const loadPending = async () => {
    try {
      setPending(await api.listHassPending());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadPolicies = async () => {
    try {
      setPolicies(await api.listHassPolicies());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadAudit = async () => {
    try {
      setAudit(await api.listHassAudit({ limit: AUDIT_LIMIT }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadEstop = async () => {
    try {
      setEstop(await api.getHassEstop());
    } catch {
      // The global banner also polls; a failure here just hides the state.
    }
  };

  useEffect(() => {
    void loadPending();
  }, [pendingVersion]);

  useEffect(() => {
    void loadPolicies();
    void loadEstop();
  }, []);

  // Audit feed: refresh every 5s while this step is EXPANDED (T-028/EA-F07
  // — collapsed steps stay mounted but no longer poll; unmount = hidden)
  // and, since R31 F12, only while the tab is visible.
  useVisibleInterval(() => {
    void loadAudit();
  }, AUDIT_POLL_MS, expanded);

  // W5 stepper：向面板上报完成判定所需的两个状态源。
  useEffect(() => {
    onStatus?.({ pendingCount: pending === null ? null : pending.length, estopKnown: estop !== null });
  }, [pending, estop, onStatus]);

  const decide = async (id: string, action: 'approve' | 'reject') => {
    try {
      if (action === 'approve') await api.approveHassPending(id);
      else await api.rejectHassPending(id);
      pushToast(action === 'approve' ? t('safety.approveToast') : t('safety.rejectToast'));
    } catch (err) {
      // 409 PENDING_EXPIRED / PENDING_NOT_ACTIONABLE / SIMULATION_* and 404s
      // all carry a server message worth showing verbatim.
      pushToast(errorMessage(err));
    } finally {
      void loadPending();
      void loadAudit();
    }
  };

  const addPolicy = async () => {
    const patternError = policyPatternError(pattern);
    if (patternError !== null) {
      pushToast(patternError);
      return;
    }
    try {
      await api.createHassPolicy({
        entityPattern: pattern.trim(),
        effect,
        ...(scope === 'env' ? { envId: worldId } : {}),
      });
      setPattern('');
      pushToast(t('safety.policyAddedToast'));
      void loadPolicies();
    } catch (err) {
      // 403 FORBIDDEN (non-admin global write / non-owner env write) shows
      // the server's message verbatim.
      pushToast(errorMessage(err));
    }
  };

  const removePolicy = async (id: string) => {
    try {
      await api.deleteHassPolicy(id);
      void loadPolicies();
    } catch (err) {
      pushToast(errorMessage(err));
    }
  };

  const toggleEstop = async () => {
    const active = estop?.active === true;
    if (!active && !(await confirm({ body: t('safety.estopConfirm'), tone: 'danger' }))) {
      return;
    }
    try {
      setEstop(active ? await api.clearHassEstop() : await api.engageHassEstop());
    } catch (err) {
      pushToast(errorMessage(err));
    }
  };

  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('safety.title')}</h5>
      {error !== null && (
        <p className="page-note page-note--error">{t('safety.loadFailed', { error })}</p>
      )}

      <div className="deployment__estop">
        {estop?.active === true ? (
          <>
            <span className="deployment__estop-state">
              {t('safety.estopActive', {
                by: estop.by !== undefined ? t('safety.estopByPrefix', { by: estop.by }) : '',
              })}
            </span>
            <button className="danger-button" onClick={() => void toggleEstop()}>
              {t('safety.estopClear')}
            </button>
          </>
        ) : (
          <button className="estop-button" onClick={() => void toggleEstop()}>
            {t('safety.estopEngage')}
          </button>
        )}
        {/* R2-UX-04: state the scope POSITIVELY — the e-stop gates only
            real-device (hass) commands by design (R2-WONT-02); simulation
            commands are unaffected. Don't let the red button read as a
            world-wide kill switch. */}
        <p className="page-note deployment__estop-scope">{t('safety.estopScopeNote')}</p>
      </div>

      <h6 className="deployment__subtitle">
        {pending === null ? t('safety.pendingTitleLoading') : t('safety.pendingTitle', { count: pending.length })}
      </h6>
      {pending === null && <p className="page-note">{t('safety.pendingLoading')}</p>}
      {pending !== null && pending.length === 0 && (
        <EmptyState compact icon={ShieldCheck} title={t('safety.pendingEmpty')} />
      )}
      {pending?.map(row => (
        <div key={row.id} className="deployment__pending">
          <span className="object-list__name" title={`${row.entityId} · ${row.commandName}`}>
            {row.entityId} · {row.commandName}
          </span>
          <span className="object-list__meta">
            {t('safety.pendingMeta', {
              params: compactJson(row.params),
              who: row.requestedBy ?? t('safety.pendingRequestedByFallback'),
              time: clockTime(row.requestedAt),
            })}
          </span>
          <span className="deployment__row-actions">
            <button onClick={() => void decide(row.id, 'approve')}>{t('safety.approve')}</button>
            <button className="danger-button" onClick={() => void decide(row.id, 'reject')}>
              {t('safety.reject')}
            </button>
          </span>
        </div>
      ))}

      <h6 className="deployment__subtitle">
        {policies === null
          ? t('safety.policyTitleLoading')
          : t('safety.policyTitle', { count: policies.length })}
      </h6>
      {policies === null && <p className="page-note">{t('safety.policyLoading')}</p>}
      {policies !== null && policies.length === 0 && (
        <EmptyState compact icon={ShieldCheck} title={t('safety.policyEmpty')} />
      )}
      {policies !== null && policies.length > 0 && (
        <table className="deployment__table">
          <thead>
            <tr>
              <th>{t('safety.policyTHPattern')}</th>
              <th>{t('safety.policyTHEffect')}</th>
              <th>{t('safety.policyTHScope')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {policies.map(policy => (
              <tr key={policy.id}>
                <td>{policy.entityPattern}</td>
                <td>{POLICY_EFFECT_LABEL[policy.effect]}</td>
                <td>{policyScopeLabel(policy, worldId)}</td>
                <td>
                  <button className="link-button" onClick={() => void removePolicy(policy.id)}>
                    {t('safety.policyDelete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="deployment__form">
        <input
          value={pattern}
          onChange={event => setPattern(event.target.value)}
          placeholder={t('safety.policyPatternPlaceholder')}
        />
        <select
          value={effect}
          onChange={event => setEffect(event.target.value as PolicyEffect)}
        >
          <option value="allow">{t('safety.policyEffectAllow')}</option>
          <option value="confirm">{t('safety.policyEffectConfirm')}</option>
          <option value="deny">{t('safety.policyEffectDeny')}</option>
        </select>
        <select
          value={scope}
          onChange={event => setScope(event.target.value as 'env' | 'global')}
        >
          <option value="env">{t('safety.policyScopeEnv')}</option>
          <option value="global">{t('safety.policyScopeGlobal')}</option>
        </select>
        <button onClick={() => void addPolicy()}>{t('safety.policyAddButton')}</button>
      </div>

      <h6 className="deployment__subtitle">{t('safety.auditTitle')}</h6>
      {audit === null && <p className="page-note">{t('safety.auditLoading')}</p>}
      {audit !== null && audit.length === 0 && <EmptyState compact icon={ScrollText} title={t('safety.auditEmpty')} />}
      {audit !== null && audit.length > 0 && (
        <table className="deployment__table">
          <thead>
            <tr>
              <th>{t('safety.auditTHTime')}</th>
              <th>{t('safety.auditTHEntity')}</th>
              <th>{t('safety.auditTHCommand')}</th>
              <th>{t('safety.auditTHResult')}</th>
            </tr>
          </thead>
          <tbody>
            {audit.map(entry => (
              <tr key={entry.id}>
                <td>{clockTime(entry.at)}</td>
                <td>{entry.entityId}</td>
                <td>{entry.command}</td>
                <td>
                  <span
                    className={`badge badge--${auditDecisionTone(entry.decision)}`}
                    title={entry.reason}
                  >
                    {AUDIT_DECISION_LABEL[entry.decision]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 指令测试 — manual actuation with safety-gate feedback
// ---------------------------------------------------------------------------

function CommandTestSection({
  world,
  onPendingParked,
}: {
  world: EnvironmentDetail;
  /** Called after a command was parked for confirmation (refresh 待审批). */
  onPendingParked: () => void;
}) {
  const { t } = useTranslation('deployment');
  const pushToast = useAppStore(s => s.pushToast);
  const [simulations, setSimulations] = useState<SimulationListEntry[] | null>(null);
  const [simId, setSimId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [commandName, setCommandName] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [sending, setSending] = useState(false);

  const loadSimulations = async () => {
    try {
      setSimulations(await api.listSimulations());
    } catch (error) {
      pushToast(t('command.simListFailedToast', { error: errorMessage(error) }));
    }
  };

  useEffect(() => {
    void loadSimulations();
  }, []);

  const running = simulations === null ? [] : runningSimulationsOf(simulations, world.id);
  const boundDevices = hassBoundDevices(world.devices);
  // Fall back to the first option when the picked row disappears.
  const effectiveSimId = running.some(sim => sim.id === simId) ? simId : (running[0]?.id ?? '');
  const effectiveDeviceId = boundDevices.some(device => device.id === deviceId)
    ? deviceId
    : (boundDevices[0]?.id ?? '');

  const send = async () => {
    const name = commandName.trim();
    if (name.length === 0) {
      pushToast(t('command.nameRequiredToast'));
      return;
    }
    const parsed = parseParamsJson(paramsText);
    if (parsed.error !== undefined) {
      pushToast(parsed.error);
      return;
    }
    setSending(true);
    try {
      const result = await api.sendDeviceCommand(
        effectiveSimId,
        effectiveDeviceId,
        name,
        parsed.params,
      );
      const feedback = commandFeedback(result);
      pushToast(feedback.text);
      if (feedback.kind === 'pending') onPendingParked();
    } catch (error) {
      pushToast(t('command.sendFailedToast', { error: errorMessage(error) }));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('command.title')}</h5>
      {simulations !== null && running.length === 0 && (
        <EmptyState compact icon={MonitorOff} title={t('command.noSim')} />
      )}
      {running.length > 0 && boundDevices.length === 0 && (
        <EmptyState compact icon={Unplug} title={t('command.noBoundDevices')} />
      )}
      {running.length > 0 && boundDevices.length > 0 && (
        <div className="deployment__form">
          <select value={effectiveSimId} onChange={event => setSimId(event.target.value)}>
            {running.map(sim => (
              <option key={sim.id} value={sim.id}>
                {t('command.simOption', { id: sim.id })}
              </option>
            ))}
          </select>
          <select
            value={effectiveDeviceId}
            onChange={event => setDeviceId(event.target.value)}
          >
            {boundDevices.map(device => (
              <option key={device.id} value={device.id}>
                {t('command.deviceOption', {
                  name: device.name,
                  binding: device.binding.slice('hass://'.length),
                })}
              </option>
            ))}
          </select>
          <input
            value={commandName}
            onChange={event => setCommandName(event.target.value)}
            placeholder={t('command.namePlaceholder')}
          />
          <input
            value={paramsText}
            onChange={event => setParamsText(event.target.value)}
            placeholder={t('command.paramsPlaceholder')}
          />
          <button disabled={sending} onClick={() => void send()}>
            {sending ? t('command.sending') : t('command.send')}
          </button>
          <button className="link-button" onClick={() => void loadSimulations()}>
            {t('command.refreshSim')}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 反向同步 — HIL 反向映射 P1 只读状态区（策略 + 漂移 + 手动对齐 + 最近记录）
// ---------------------------------------------------------------------------

function ReverseSyncSection() {
  const { t } = useTranslation('deployment');
  const pushToast = useAppStore(s => s.pushToast);
  const [status, setStatus] = useState<HassReverseSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);

  const load = async () => {
    try {
      setStatus(await reverseSyncApi.getHassReverseSync());
      setError(null);
    } catch (err) {
      // 与其它 HA 段一致：桥未配置/失败绝不拖垮整个标签页。
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const align = async () => {
    setAligning(true);
    try {
      const result = await reverseSyncApi.alignHassReverseSyncNow();
      pushToast(
        t('reverseSync.alignToast', {
          aligned: result.alignedDevices,
          unchanged: result.unchangedDevices,
        }),
      );
    } catch (err) {
      // 409 ESTOP_ACTIVE / REVERSE_SYNC_DISABLED / 503 的服务器消息原样展示。
      pushToast(errorMessage(err));
    } finally {
      setAligning(false);
      void load();
    }
  };

  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('reverseSync.title')}</h5>
      {error !== null && (
        <p className="page-note page-note--error">{t('reverseSync.loadFailed', { error })}</p>
      )}
      {status !== null && (
        <>
          <div className="object-detail__row">
            <span className="badge badge--hass">
              {t(`reverseSync.policy.${status.policy}`)}
            </span>
            {status.estopActive && (
              <span className="deployment__estop-state">{t('reverseSync.estopNote')}</span>
            )}
            <span className="page-note">
              {status.drift.length === 0
                ? t('reverseSync.driftNone', { count: status.boundDevices })
                : t('reverseSync.driftSome', {
                    count: status.boundDevices,
                    drift: status.drift.length,
                  })}
            </span>
            <button disabled={aligning} onClick={() => void align()}>
              {aligning ? t('reverseSync.aligning') : t('reverseSync.alignNow')}
            </button>
          </div>
          {status.drift.length > 0 && (
            <table className="deployment__table">
              <thead>
                <tr>
                  <th>{t('reverseSync.driftTHDevice')}</th>
                  <th>{t('reverseSync.driftTHKey')}</th>
                  <th>{t('reverseSync.driftTHSim')}</th>
                  <th>{t('reverseSync.driftTHHass')}</th>
                </tr>
              </thead>
              <tbody>
                {status.drift.map(entry => (
                  <tr key={`${entry.deviceId}:${entry.key}`}>
                    <td title={entry.entityId}>{entry.deviceName}</td>
                    <td>{entry.key}</td>
                    <td>{compactJson(entry.simValue)}</td>
                    <td>{compactJson(entry.hassValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h6 className="deployment__subtitle">{t('reverseSync.recentTitle')}</h6>
          {status.recentAlignments.length === 0 && (
            <EmptyState compact icon={History} title={t('reverseSync.recentEmpty')} />
          )}
          {status.recentAlignments.map(alignment => (
            <div key={alignment.id} className="object-list__item">
              <span className="object-list__name" title={alignment.entityId}>
                {alignment.entityId}
              </span>
              <span className="object-list__meta">
                {t('reverseSync.recentMeta', {
                  time: clockTime(alignment.at),
                  trigger: t(`reverseSync.trigger.${alignment.trigger}`),
                  count: alignment.changes.length,
                })}
              </span>
            </div>
          ))}
        </>
      )}
      {status === null && error === null && (
        <p className="page-note">{t('reverseSync.loading')}</p>
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// 影子环境 — HIL 反向映射 P2 状态区（fork + 观测计数 + 残差 + 致动丢弃）
// ---------------------------------------------------------------------------

function ShadowSection({ envId }: { envId: string }) {
  const { t } = useTranslation('deployment');
  const pushToast = useAppStore(s => s.pushToast);
  const [status, setStatus] = useState<HassShadowStatus | null>(null);
  /** true = 服务器明确报告无影子（404 SHADOW_NOT_FOUND），显示创建入口。 */
  const [absent, setAbsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(await shadowApi.getHassShadow(envId));
      setAbsent(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'SHADOW_NOT_FOUND') {
        setStatus(null);
        setAbsent(true);
        setError(null);
        return;
      }
      // 与其它 HA 段一致：失败绝不拖垮整个标签页（403 非 owner 也落这里）。
      setStatus(null);
      setAbsent(false);
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      // 403/409 的服务器消息原样展示（教学式错误）。
      pushToast(errorMessage(err));
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <section className="deployment__section">
      <h5 className="deployment__title">{t('shadow.title')}</h5>
      {error !== null && (
        <p className="page-note page-note--error">{t('shadow.loadFailed', { error })}</p>
      )}
      {absent && (
        <div className="object-detail__row">
          <span className="page-note">{t('shadow.absent')}</span>
          <button disabled={busy} onClick={() => void run(() => shadowApi.createHassShadow(envId))}>
            {t('shadow.create')}
          </button>
        </div>
      )}
      {status !== null && (
        <>
          <div className="object-detail__row">
            <span className="badge badge--hass">
              {status.fromCheckpoint ? t('shadow.badgeCheckpoint') : t('shadow.badgeBase')}
            </span>
            {status.estopActive && (
              <span className="deployment__estop-state">{t('shadow.estopNote')}</span>
            )}
            <span className="page-note">
              {t('shadow.summary', {
                devices: status.boundDevices.length,
                observations: status.observationCount,
                discarded: status.discardedCommandCount,
              })}
            </span>
            <button
              disabled={busy}
              onClick={() => void run(() => shadowApi.createHassShadow(envId, true))}
            >
              {t('shadow.refresh')}
            </button>
            <button disabled={busy} onClick={() => void run(() => shadowApi.deleteHassShadow(envId))}>
              {t('shadow.destroy')}
            </button>
          </div>
          {status.boundDevices.length > 0 && (
            <table className="deployment__table">
              <thead>
                <tr>
                  <th>{t('shadow.THDevice')}</th>
                  <th>{t('shadow.THObservations')}</th>
                  <th>{t('shadow.THDiscarded')}</th>
                </tr>
              </thead>
              <tbody>
                {status.boundDevices.map(device => (
                  <tr key={device.deviceId}>
                    <td title={device.entityId}>{device.deviceName}</td>
                    <td>{device.observations}</td>
                    <td>{device.discardedCommands}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h6 className="deployment__subtitle">{t('shadow.recentTitle')}</h6>
          {status.recentObservations.length === 0 && (
            <EmptyState compact icon={History} title={t('shadow.recentEmpty')} />
          )}
          {status.recentObservations.map(observation => (
            <div key={observation.id} className="object-list__item">
              <span className="object-list__name" title={observation.entityId}>
                {observation.entityId}
              </span>
              <span className="object-list__meta">
                {t('shadow.recentMeta', {
                  time: clockTime(observation.at),
                  simTime: observation.simTimeSec.toFixed(1),
                  count: observation.changes.length,
                })}
              </span>
              {observation.changes.length > 0 && (
                <span className="object-list__meta">
                  {observation.changes
                    .map(c => `${c.key}: ${compactJson(c.predicted)} → ${compactJson(c.observed)}`)
                    .join(' · ')}
                </span>
              )}
            </div>
          ))}
        </>
      )}
      {status === null && !absent && error === null && (
        <p className="page-note">{t('shadow.loading')}</p>
      )}
    </section>
  );
}
