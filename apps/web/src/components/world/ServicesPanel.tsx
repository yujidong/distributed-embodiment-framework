/**
 * ServicesPanel — the 服务 (service marketplace) sidebar tab (W3).
 *
 * The marketplace is the cross-owner discovery surface: it lists what agents
 * OFFER (services), not what they HAVE (devices). Browse by semantic type
 * (groups) with filters for semantic type / provider / origin; each row
 * shows only the star, owner swatch, name and an unbacked warning for offers
 * no bound device
 * supports. Clicking a row expands an inline brief (Track F: provider /
 * origin / visibility / reputation + a description excerpt); the brief's
 * 「查看完整详情」 button opens the detail (description, interface params,
 * source-device link for derived services — long sections collapsed behind
 * toggles).
 *
 * The list arrives visibility-filtered from the server and updates live from
 * the world stream (lib/worldChange.ts); the panel handles browse-time
 * grouping/filtering (lib/services.ts) plus the W6 write affordances:
 * 发布服务 (when the caller has ≥1 agent here), edit/delete on own published
 * rows, and the visibility cycle on own derived rows (their only mutable
 * field — anything else is a server-side 409).
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ChevronDown, ChevronRight, Star, TriangleAlert } from 'lucide-react';

import * as api from '../../api/client';
import type {
  EnvironmentDetail,
  ServiceOrigin,
  StandingAsk,
  WorldAgent,
  WorldService,
} from '../../api/types';
import { colorForUserId } from '../../lib/memberColors';
import { formatReputationPercent, reputationTier } from '../../lib/reputation';
import { serviceBrief } from '../../lib/rowBrief';
import {
  filterServices,
  groupServicesBySemanticType,
  providersOf,
  semanticTypesOf,
} from '../../lib/services';
import { nextVisibility } from '../../lib/serviceForm';
import { useAppStore } from '../../store/useAppStore';
import { ReputationChip } from '../ReputationChip';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { DetailSection } from './DetailSection';
import { RowBrief } from './RowBrief';
import { ServiceForm } from './ServiceForm';
import { useTranslation } from 'react-i18next';

export function ServicesPanel({
  world,
  onShowDevice,
}: {
  world: EnvironmentDetail;
  /** Jump to the devices tab focused on a device (source-device link). */
  onShowDevice: (deviceId: string) => void;
}) {
  const selectedServiceId = useAppStore(s => s.selectedServiceId);
  const selectService = useAppStore(s => s.selectService);
  const user = useAppStore(s => s.user);
  const myServiceSubscriptions = useAppStore(s => s.myServiceSubscriptions);
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { t } = useTranslation('services');

  const [semanticType, setSemanticType] = useState<string | null>(null);
  // R80-FW1: the spatial filter — services anchored in one zone.
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [providerAgentId, setProviderAgentId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<ServiceOrigin | null>(null);
  // Fix-20 (F-09): full-text search over the visible offers.
  const [q, setQ] = useState('');
  // W5: 「只看我的依赖」 — subscribed offers only.
  const [onlyMine, setOnlyMine] = useState(false);
  // R78-F: 只看他人（协作浏览方向）。
  const [othersOnly, setOthersOnly] = useState(false);
  // R80-2: 只看我的 —— 超大市场里定位自有服务（与 othersOnly 互斥）。
  const [mineOnly, setMineOnly] = useState(false);
  /** W6: publish form (null service) or edit form (a published service). */
  const [form, setForm] = useState<{ service: WorldService | null } | null>(null);
  // T-069 (R23): the demand board — a minimal READ surface of open standing
  // asks (what members WANT that does not exist yet). v1 has no create/
  // withdraw form here; those travel via CLI/OpenAPI (documented).
  const [asks, setAsks] = useState<StandingAsk[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAsks(null);
    api
      .listEnvAsks(world.id, 'open')
      .then(rows => {
        if (!cancelled) setAsks(rows);
      })
      .catch(() => {
        // Non-members (e.g. anonymous public viewers) have no board by
        // design — the section simply stays hidden instead of erroring the
        // whole marketplace panel.
        if (!cancelled) setAsks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [world.id]);

  // Same mutation rights as the server: agent owner or env owner, builder+.
  const canManage = (ownerId: string) =>
    user !== null &&
    (world.myRole === 'owner' || world.myRole === 'builder') &&
    (user.id === ownerId || world.myRole === 'owner');
  const myAgents = world.agents.filter(agent => user !== null && agent.owner.id === user.id);

  const removeService = async (service: WorldService) => {
    if (!(await confirm({ body: t('deleteConfirm', { name: service.name }), tone: 'danger' }))) return;
    try {
      await api.deleteService(service.id);
      applyWorldMessage({
        kind: 'world',
        action: 'deleted',
        objectType: 'service',
        object: { id: service.id },
      });
    } catch (error) {
      pushToast(t('deleteFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const cycleVisibility = async (service: WorldService) => {
    try {
      const updated = await api.patchService(service.id, {
        visibility: nextVisibility(service.visibility),
      });
      applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'service', object: updated });
    } catch (error) {
      pushToast(t('visibilityFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const semanticTypes = useMemo(() => semanticTypesOf(world.services), [world.services]);
  const providers = useMemo(() => providersOf(world.services), [world.services]);
  const groups = useMemo(
    () =>
      groupServicesBySemanticType(
        filterServices(world.services, {
          semanticType,
          providerAgentId,
          origin,
          q,
          excludeOwnerUserId: othersOnly ? user?.id ?? null : null,
          ownerUserId: mineOnly ? user?.id ?? null : null,
          zoneId: zoneFilter,
        }).filter(
          service => !onlyMine || myServiceSubscriptions.includes(service.id),
        ),
      ),
    [world.services, semanticType, providerAgentId, origin, q, zoneFilter, onlyMine, mineOnly, othersOnly, user, myServiceSubscriptions],
  );

  const selected =
    selectedServiceId !== null
      ? (world.services.find(service => service.id === selectedServiceId) ?? null)
      : null;

  if (form) {
    return (
      <ServiceForm
        key={form.service?.id ?? 'publish'}
        world={world}
        service={form.service}
        myAgents={myAgents}
        onClose={() => setForm(null)}
      />
    );
  }

  if (selected) {
    return (
      <ServiceDetail
        world={world}
        service={selected}
        onBack={() => selectService(null)}
        onOpenDevice={onShowDevice}
      />
    );
  }

  return (
    <div className="service-marketplace">
      {myAgents.length > 0 && (world.myRole === 'owner' || world.myRole === 'builder') && (
        <button
          className="primary-button world-sidebar__create"
          onClick={() => setForm({ service: null })}
        >
          {t('publish')}
        </button>
      )}
      <div className="service-marketplace__filters">
        <input
          className="service-marketplace__search"
          type="search"
          value={q}
          placeholder={t('searchPlaceholder')}
          onChange={event => setQ(event.target.value)}
        />
        <select
          value={semanticType ?? ''}
          onChange={event => setSemanticType(event.target.value || null)}
        >
          <option value="">{t('filterAllTypes')}</option>
          {semanticTypes.map(type => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        {/* R80-FW1: 空间维度——多区域大世界里「我只看我区域周边的服务」。 */}
        <select
          value={zoneFilter ?? ''}
          onChange={event => setZoneFilter(event.target.value || null)}
          aria-label={t('filterByZone')}
        >
          <option value="">{t('filterAllZones')}</option>
          {world.zones.map(zone => (
            <option key={zone.id} value={zone.id}>
              {zone.name ?? zone.id}
            </option>
          ))}
        </select>
        <select
          value={providerAgentId ?? ''}
          onChange={event => setProviderAgentId(event.target.value || null)}
        >
          <option value="">{t('filterAllProviders')}</option>
          {providers.map(provider => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
        <select
          value={origin ?? ''}
          onChange={event => setOrigin((event.target.value || null) as ServiceOrigin | null)}
        >
          <option value="">{t('filterAllOrigins')}</option>
          <option value="derived">{t('originDerived')}</option>
          <option value="published">{t('originPublished')}</option>
          <option value="flow">{t('originFlow')}</option>
        </select>
        {user !== null && (
          <>
            <button
              className={onlyMine ? 'filter-chip filter-chip--active' : 'filter-chip'}
              title={t('onlySubscribedTitle')}
              onClick={() => { setOnlyMine(current => !current); if (onlyMine) setOthersOnly(false); }}
            >
              <Icon icon={Star} size={13} fill="currentColor" /> {t('onlySubscribed')}
            </button>
            {/* R78-F: the collaboration direction — hide my own offers. */}
            <button
              className={othersOnly ? 'filter-chip filter-chip--active' : 'filter-chip'}
              title={t('othersOnlyTitle')}
              onClick={() => { setOthersOnly(current => !current); if (othersOnly) setOnlyMine(false); if (!othersOnly) setMineOnly(false); }}
            >
              {t('othersOnly')}
            </button>
            {/* R80-2: the self-management direction — only my own offers. */}
            <button
              className={mineOnly ? 'filter-chip filter-chip--active' : 'filter-chip'}
              title={t('mineOnlyTitle')}
              onClick={() => { setMineOnly(current => !current); if (!mineOnly) setOthersOnly(false); }}
            >
              {t('mineOnly')}
            </button>
          </>
        )}
      </div>
      {asks !== null && asks.length > 0 && (
        <section className="service-group" data-testid="asks-board">
          <h5 className="service-group__title">
            <span className="chip">{t('asksTitle')}</span>
            <span className="service-group__count">{asks.length}</span>
          </h5>
          {asks.map(ask => (
            <div key={ask.id} className="object-list__row" data-testid="asks-board-row">
              <div className="object-list__item service-row">
                <span
                  className="owner-swatch"
                  style={{ background: colorForUserId(ask.asker.id) }}
                  title={ask.asker.displayName}
                />
                <span className="object-list__name" title={ask.note.length > 0 ? ask.note : ask.semanticType}>
                  {ask.semanticType}
                  {ask.zoneId !== undefined && (
                    <span className="service-row__unbacked">
                      · {t('asksZone')}: {ask.zoneId}
                    </span>
                  )}
                  {ask.autoPropose && <span className="service-row__unbacked"> · {t('asksAuto')}</span>}
                </span>
                <span className="object-list__meta">{ask.asker.displayName}</span>
              </div>
            </div>
          ))}
        </section>
      )}
      {world.services.length === 0 && (
        <p className="page-note">
          {t('emptyNoServices')}
          {myAgents.length > 0 ? t('emptyCanPublish') : ''}。
        </p>
      )}
      {world.services.length > 0 && groups.length === 0 && (
        <p className="page-note">
          {onlyMine ? t('emptyNoBookmarks') : t('emptyNoMatch')}
        </p>
      )}
      {groups.map(group => (
        <section key={group.semanticType} className="service-group">
          <h5 className="service-group__title">
            <span className="chip">{group.semanticType}</span>
            <span className="service-group__count">{group.services.length}</span>
          </h5>
          {group.services.map(service => (
            <ServiceRow
              key={service.id}
              service={service}
              starred={myServiceSubscriptions.includes(service.id)}
              canStar={user !== null}
              canManage={canManage(service.provider.owner.id)}
              onOpen={() => selectService(service.id)}
              onEdit={() => setForm({ service })}
              onDelete={() => void removeService(service)}
              onCycleVisibility={() => void cycleVisibility(service)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ServiceRow({
  service,
  starred,
  canStar,
  canManage,
  onOpen,
  onEdit,
  onDelete,
  onCycleVisibility,
}: {
  service: WorldService;
  /** W5: in the caller's 我依赖的服务 bookmarks. */
  starred: boolean;
  /** Stars render for logged-in users only. */
  canStar: boolean;
  /** W6: agent owner / env owner may edit published rows, cycle derived rows. */
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCycleVisibility: () => void;
}) {
  const toggleServiceSubscription = useAppStore(s => s.toggleServiceSubscription);
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('services');
  // Track F 信息分级: the row keeps only star + swatch + name (+⚠) + the
  // (visually muted) manage actions; provider/origin/visibility/reputation
  // and the description move into the inline brief, whose 「查看完整详情」
  // button runs onOpen (the detail view).
  const brief = serviceBrief(service);
  return (
    <div className="object-list__row">
      <div className="object-list__item service-row">
        {canStar && (
          <button
            className={starred ? 'service-star service-star--filled' : 'service-star'}
            title={starred ? t('row.unstar') : t('row.star')}
            onClick={event => {
              event.stopPropagation();
              void toggleServiceSubscription(service.id);
            }}
          >
            <Icon icon={Star} size={14} fill={starred ? 'currentColor' : 'none'} label={starred ? t('row.starred') : t('row.notStarred')} />
          </button>
        )}
        <button
          className="service-row__main"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          <span
            className="owner-swatch"
            style={{ background: colorForUserId(service.provider.owner.id) }}
            title={service.provider.owner.displayName}
          />
          <span className="object-list__name" title={service.name}>
            {service.name}
            {service.unbacked && (
              <span className="service-row__unbacked" title={t('row.unbackedTitle')}>
                <Icon icon={TriangleAlert} size={12} /> {t('row.unbacked')}
              </span>
            )}
          </span>
          <Icon
            icon={open ? ChevronDown : ChevronRight}
            size={13}
            className="object-list__chevron"
          />
        </button>
        {canManage && (
          <span className="service-row__actions">
            {/* MI-D: flow-services are editable like published offers
                (interface stays server-generated; delete = unpublish). */}
            {service.origin === 'published' || service.origin === 'flow' ? (
              <>
                <button className="link-button" onClick={onEdit}>
                  {t('row.edit')}
                </button>
                <button className="link-button" onClick={onDelete}>
                  {t('row.delete')}
                </button>
              </>
            ) : (
              <button
                className="link-button"
                title={t('row.visibilityTitle')}
                onClick={onCycleVisibility}
              >
                {t(`visibility${service.visibility[0].toUpperCase()}${service.visibility.slice(1)}`)} <Icon icon={ArrowLeftRight} size={12} />
              </button>
            )}
          </span>
        )}
      </div>
      {open && (
        <RowBrief onOpenDetail={onOpen}>
          <span className="object-list__brief-row">
            {brief.providerLabel} ·{' '}
            {service.origin === 'derived'
              ? t('originDerived')
              : service.origin === 'flow'
                ? t('originFlow')
                : service.origin === 'aggregate'
                  ? t('originAggregate')
                  : t('originPublished')}{' '}
            ·{' '}
            {t(`visibility${service.visibility[0].toUpperCase()}${service.visibility.slice(1)}`)}
            <ReputationChip reputation={service.reputation} />
          </span>
          {brief.description !== null && (
            <span className="object-list__brief-desc" title={brief.description}>{brief.description}</span>
          )}
        </RowBrief>
      )}
    </div>
  );
}

function ServiceDetail({
  world,
  service,
  onBack,
  onOpenDevice,
}: {
  world: EnvironmentDetail;
  service: WorldService;
  onBack: () => void;
  onOpenDevice: (deviceId: string) => void;
}) {
  const user = useAppStore(s => s.user);
  const { t } = useTranslation('services');
  const { t: tDetail } = useTranslation('servicesPanelDetail');
  const [proposeOpen, setProposeOpen] = useState(false);
  const sourceDevice =
    service.sourceDeviceId !== null
      ? (world.devices.find(device => device.id === service.sourceDeviceId) ?? null)
      : null;
  const interfaceJson = JSON.stringify(service.interface, null, 2);
  // Fix-11/17: the propose form targets one of MY agents as the consumer.
  const myAgents = world.agents.filter(agent => user !== null && agent.owner.id === user.id);

  return (
    <div className="object-detail">
      <button className="link-button" onClick={onBack}>
        <Icon icon={ArrowLeft} size={14} /> {t('detail.backToList')}
      </button>
      <h4 className="object-detail__name">{service.name}</h4>
      <div className="chip-row">
        <span className="chip">{service.semanticType}</span>
        <span className="badge">
          {service.origin === 'derived'
            ? t('originDerived')
            : service.origin === 'flow'
              ? t('originFlow')
              : service.origin === 'aggregate'
                ? t('originAggregate')
                : t('originPublished')}
        </span>
        <span className="badge">{t(`visibility${service.visibility[0].toUpperCase()}${service.visibility.slice(1)}`)}</span>
      </div>
      {user !== null && (
        <div className="object-detail__actions">
          <button className="primary-button" onClick={() => setProposeOpen(open => !open)}>
            {proposeOpen ? t('detail.proposeOpen') : t('detail.proposeClosed')}
          </button>
        </div>
      )}
      {user !== null && <InvokeTrial service={service} />}
      {proposeOpen && user !== null && (
        <ProposeAgreementForm
          service={service}
          myAgents={myAgents}
          onDone={() => setProposeOpen(false)}
        />
      )}
      {service.unbacked && (
        <p className="service-detail__warning">
          <Icon icon={TriangleAlert} size={14} /> {t('detail.unbackedTitle')}
        </p>
      )}
      <div className="object-detail__row">
        <span className="object-detail__label">{t('detail.provider')}</span>
        {service.provider.name}（{service.provider.owner.displayName}）
      </div>
      <div className="object-detail__section" data-testid="service-track-record">
        <span className="object-detail__label">{t('detail.trackRecord')}</span>
        <div className="track-record">
          <span className="track-record__score">
            {formatReputationPercent(service.reputation.score)}
          </span>
          <span
            className={`track-record__bar track-record__bar--${reputationTier(service.reputation)}`}
          >
            <span
              className="track-record__fill"
              style={{ width: formatReputationPercent(service.reputation.score) }}
            />
          </span>
          <ReputationChip reputation={service.reputation} />
        </div>
        <div className="track-record__detail">
          {tDetail('trackRecordDetail', {
            attempts: service.reputation.attempts,
            successes: service.reputation.successes,
          })}
          {service.reputation.attempts > 0 &&
            tDetail('trackRecordFailures', {
              failures: Math.round((service.reputation.attempts - service.reputation.successes) * 10) / 10,
            })}
        </div>
      </div>
      {service.origin === 'derived' && (
        <div className="object-detail__row">
          <span className="object-detail__label">{tDetail('sourceDeviceLabel')}</span>
          {sourceDevice ? (
            <button
              className="link-button object-detail__link"
              onClick={() => onOpenDevice(sourceDevice.id)}
            >
              {sourceDevice.name}{tDetail('sourceDeviceClickHint')}
            </button>
          ) : (
            (service.sourceDeviceId ?? tDetail('sourceDeviceDeleted'))
          )}
        </div>
      )}
      {service.description && (
        <DetailSection title={tDetail('descriptionLabel')}>
          <div className="object-detail__state">{service.description}</div>
        </DetailSection>
      )}
      {service.origin === 'flow' && <FlowServiceInterface service={service} />}
      <DetailSection title={tDetail('interfaceLabel')}>
        <pre className="service-detail__interface">{interfaceJson}</pre>
      </DetailSection>
    </div>
  );
}

/**
 * Mechanism D: the human-readable reading of a flow-service's generated
 * interface — the single `run` action with its input-parameter schema
 * (types/bounds/defaults) and the delegate-node count (the Wave-A caution:
 * does one "deterministic" call internally consult agent judgment?).
 */
function FlowServiceInterface({ service }: { service: WorldService }) {
  const { t: tFlow } = useTranslation('servicesPanelDetail');
  const iface = service.interface as {
    kind?: unknown;
    flowId?: unknown;
    actions?: Array<{ name?: unknown; parameters?: Record<string, Record<string, unknown>> }>;
    delegateNodeCount?: unknown;
  };
  if (iface?.kind !== 'flow') return null;
  const parameters = iface.actions?.[0]?.parameters ?? {};
  const delegateCount = typeof iface.delegateNodeCount === 'number' ? iface.delegateNodeCount : 0;
  const renderParam = (spec: Record<string, unknown>): string => {
    const parts: string[] = [String(spec.type ?? 'unknown')];
    if (spec.required === true) parts.push(tFlow('flowParamRequired'));
    if (spec.default !== undefined) parts.push(`${tFlow('flowParamDefault')} ${JSON.stringify(spec.default)}`);
    if (spec.min !== undefined || spec.max !== undefined) {
      parts.push(`[${spec.min ?? '-∞'}, ${spec.max ?? '∞'}]`);
    }
    if (Array.isArray(spec.enum)) parts.push(`∈ {${spec.enum.map(v => JSON.stringify(v)).join(', ')}}`);
    return parts.join(' · ');
  };
  return (
    <DetailSection title={tFlow('flowInterfaceTitle')}>
      <div className="object-detail__state">
        <p className="object-detail__brief-desc">
          {tFlow('flowInterfaceNote', { name: service.name })}
        </p>
        <ul className="check-list">
          <li className="check-list__item">
            <code>run</code>
            {Object.keys(parameters).length === 0
              ? tFlow('flowNoParams')
              : Object.entries(parameters).map(([name, spec]) => (
                  <div key={name} className="object-list__meta">
                    <code>{name}</code>: {renderParam(spec)}
                  </div>
                ))}
          </li>
        </ul>
        <p className="object-list__meta">
          {delegateCount > 0
            ? tFlow('flowDelegateCount', { count: delegateCount })
            : tFlow('flowNoDelegates')}
        </p>
      </div>
    </DetailSection>
  );
}

/**
 * Fix-11/17: propose an agreement on this offer (POST /services/:id/agreements).
 * The optional consumer agent must be one of the caller's own agents; terms
 * stay minimal (notes only) — quota/price fields are API-only for now.
 */
function ProposeAgreementForm({
  service,
  myAgents,
  onDone,
}: {
  service: WorldService;
  myAgents: WorldAgent[];
  onDone: () => void;
}) {
  const pushToast = useAppStore(s => s.pushToast);
  const { t: tDetail } = useTranslation('servicesPanelDetail');
  // R80-FW4: pre-select the user's first agent — the requirement is visible
  // AND pre-satisfied (an empty required combo was the R79 silent failure).
  const [consumerAgentId, setConsumerAgentId] = useState(myAgents[0]?.id ?? '');
  // R78-G1: proposal failures persist INLINE — a transient toast was the
  // last silent-failure manifestation (user believes they proposed while
  // nothing landed; the R77 rounds proved the cost of that).
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  // R80-FW4: the form states its OWN requirements up front instead of
  // discovering them via a 400 (R79's sec probe — submit failed with only
  // a toast). flow services hard-require the structured run clause (added
  // automatically since MI-D); every origin requires a consumer agent.
  const flowService = service.origin === 'flow';

  const submit = async () => {
    if (busy) return;
    if (consumerAgentId === '') {
      setSubmitError(tDetail('proposeNeedConsumerAgent'));
      return;
    }
    setBusy(true);
    try {
      await api.proposeAgreement(service.id, {
        consumerAgentId,
        ...(service.origin === 'flow'
          ? {
              // MI-D: a flow-service contract REQUIRES the structured run
              // clause (propose 400 otherwise) — the form adds it verbatim.
              terms: {
                ...(notes.trim() ? { notes: notes.trim() } : {}),
                action: { command: 'run' },
              },
            }
          : notes.trim()
            ? { terms: { notes: notes.trim() } }
            : {}),
      });
      pushToast(tDetail('proposeToast', { name: service.provider.name }));
      onDone();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="object-detail__section agreement-propose">
      <span className="object-detail__label">{tDetail('proposeFormTitle')}</span>
      {/* R80-FW4: state the requirements UP FRONT, per service shape. */}
      <p className="page-note">
        {flowService ? tDetail('proposeReqFlow') : tDetail('proposeReqStandard')}
      </p>
      {myAgents.length === 0 && (
        <p className="page-note page-note--error">{tDetail('proposeNoAgents')}</p>
      )}
      {myAgents.length > 0 && (
        <label>
          {tDetail('consumerAgentLabel')}
          <select
            value={consumerAgentId}
            onChange={event => setConsumerAgentId(event.target.value)}
          >
            <option value="">{tDetail('consumerAgentNoneOption')}</option>
            {myAgents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {tDetail('notesLabel')}
        <input
          value={notes}
          placeholder={tDetail('notesPlaceholder')}
          onChange={event => setNotes(event.target.value)}
        />
      </label>
      {submitError !== null && (
        <p className="page-note page-note--error">{tDetail('proposeFailedInline', { error: submitError })}</p>
      )}
      <button className="primary-button" disabled={busy} onClick={() => void submit()}>
        {tDetail('submitProposal')}
      </button>
    </div>
  );
}

/**
 * R59 试调 — one-click direct invocation from the catalog detail. Runs
 * POST /api/services/:id/invoke with the member's JWT: own services go the
 * direct lane, active-agreement holders ride the metered lane, everyone
 * else gets the teaching 403 surfaced verbatim (it points at the agreement
 * path). Flow-backed services are refused by the server (lane teaching).
 */
function InvokeTrial({ service }: { service: WorldService }) {
  const { t } = useTranslation('services');
  const pushToast = useAppStore(s => s.pushToast);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState('');
  const [params, setParams] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const actions = useMemo(() => {
    const iface = service.interface as { actions?: Array<{ name: string }> } | undefined;
    return (iface?.actions ?? []).map(entry => entry.name);
  }, [service.interface]);

  const run = async () => {
    if (action.length === 0) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = params.trim().length > 0 ? (JSON.parse(params) as Record<string, unknown>) : {};
    } catch {
      pushToast(t('invoke.paramsInvalid'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await api.invokeService(service.id, { action, params: parsed });
      setResult(t('invoke.ok', { lane: outcome.lane, deviceId: outcome.deviceId ?? '' }));
    } catch (error) {
      const message = error instanceof api.ApiClientError ? `${error.code}: ${error.message}` : String(error);
      setResult(message);
    } finally {
      setBusy(false);
    }
  };

  if (actions.length === 0) return null;
  return (
    <div className="invoke-trial">
      <button type="button" className="link-button" onClick={() => setOpen(o => !o)}>
        {open ? t('invoke.hide') : t('invoke.try')}
      </button>
      {open && (
        <div className="invoke-trial__body">
          <div className="member-list__actions-row">
            <select value={action} onChange={e => setAction(e.target.value)}>
              <option value="">{t('invoke.pickAction')}</option>
              {actions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <button type="button" className="primary-button" onClick={() => void run()} disabled={busy || action.length === 0}>
              {t('invoke.run')}
            </button>
          </div>
          <textarea
            className="mapping-editor"
            rows={3}
            value={params}
            onChange={e => setParams(e.target.value)}
            placeholder='{ "value": 1 }'
          />
          {result !== null && <pre className="service-detail__interface">{result}</pre>}
        </div>
      )}
    </div>
  );
}
