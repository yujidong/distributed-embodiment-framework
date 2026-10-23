/**
 * EnvironmentsHomePage — the multi-user home (§11): 我的 / 公开 tabs of
 * environment cards, a three-mode create dialog (模板 / 空白环境 / 导入场景
 * JSON, defaulting to 模板), and per-card actions by role (进入, 加入/离开,
 * owner 菜单: 删除, 设为公开/私有).
 *
 * The list is server state owned by TanStack Query (hooks/useEnvironments);
 * card mutations invalidate it instead of the old store reload.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Globe, X } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { EnvironmentSummary, EnvVisibility, ScenarioTemplateSummary } from '../api/types';
import { FloorplanImportPane, IfcImportPane, NlImportPane, OsmImportPane } from '../components/ImportWizards';
import {
  defaultTemplateVarInputs,
  validateTemplateVarInputs,
  type TemplateVarInputs,
} from '../lib/templateVars';
import {
  useEnvironmentList,
  useJoinEnvironment,
  useLeaveEnvironment,
  usePublicHealth,
  useRemoveEnvironment,
  useSetEnvironmentVisibility,
} from '../hooks/useEnvironments';
import { useScenarioTemplateList } from '../hooks/useScenarioTemplates';
import { queryKeys } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';
import { Badge } from '../components/ui/Badge';
import { BannerStack } from '../components/BannerStack';
import { Icon } from '../components/ui/Icon';
import { useRoleLabel } from '../i18n/index';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { FilePickButton } from '../components/ui/FilePickButton';
import { useTranslation } from 'react-i18next';

type HomeTab = 'mine' | 'public';

/** Card timestamp: the locale's short date is enough to tell two same-name imports apart. */
function formatEnvTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function EnvironmentsHomePage() {
  const { data: environments = [], error, isLoading, refetch } = useEnvironmentList();
  // R74: decision posture — the rule-test banner source (public endpoint).
  const { data: health } = usePublicHealth();
  const { t } = useTranslation('environments');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<HomeTab>('mine');
  const pushToast = useAppStore(s => s.pushToast);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>('templates');
  const [starterBusy, setStarterBusy] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);

  const openCreate = (mode: CreateMode) => {
    setCreateMode(mode);
    setCreateOpen(true);
  };

  // W1b: the workbench onboarding card deep-links here with
  // ?create=templates to land the user straight on the create dialog's
  // 模板 tab. Consume the param so a refresh doesn't reopen the dialog.
  // R15-D10: ?tab=public lands students on the 公开 tab (class guidance).
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('create') === 'templates') {
      openCreate('templates');
      setSearchParams({}, { replace: true });
    }
    const tabParam = searchParams.get('tab');
    if (tabParam === 'public') {
      setTab('public');
      setSearchParams({}, { replace: true });
    } else if (tabParam !== null && tabParam !== 'mine') {
      // UX-03: an unknown ?tab= used to be silently ignored — say so, then
      // consume the param like the known values above.
      pushToast(t('unknownTabToast', { tab: tabParam }));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, pushToast, t]);

  // W1b: the empty-state starter-home button is one-click now — fetch the
  // bundled template and create the environment directly (private, matching
  // the create dialog's default). On failure fall back to the import dialog.
  const importStarterHome = async () => {
    if (starterBusy) return;
    setStarterBusy(true);
    setStarterError(null);
    try {
      const scenario = await api.getScenarioTemplate('starter-home');
      const detail = await api.createEnvironment({ ...scenario, visibility: 'private' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
      navigate(`/environments/${detail.id}`);
    } catch (err) {
      setStarterError(err instanceof Error ? err.message : String(err));
      openCreate('import');
    } finally {
      setStarterBusy(false);
    }
  };

  const visible = environments.filter(env =>
    tab === 'mine' ? env.myRole !== null : env.visibility === 'public',
  );

  return (
    <div className="home-page">
      {/* R74: anything short of a live LLM backend is NOT production — say
          so before the user enters any world. rule-test = the test-only
          rule harness; llm-unreachable = the configured backend is down and
          decisions are degrading to rules right now. */}
      {health?.decision && health.decision.mode !== 'llm' && (
        // UX-W1: 决策态势横幅收进 BannerStack（治理级单条，不折叠）——
        // data-testid/className 原样保留，decisionBanner 测试道不变。
        <BannerStack
          items={[
            {
              id: 'decision-mode',
              tone: 'governance',
              content: (
                <div
                  className={`decision-banner${health.decision.mode === 'llm-unreachable' ? ' decision-banner--unreachable' : ''}`}
                  data-testid="decision-mode-banner"
                  role="status"
                >
                  <strong>
                    {health.decision.mode === 'llm-unreachable'
                      ? t('decisionBanner.unreachableTitle', { model: health.decision.model ?? '' })
                      : t('decisionBanner.title')}
                  </strong>
                  <span>
                    {health.decision.mode === 'llm-unreachable'
                      ? t('decisionBanner.unreachableBody', { model: health.decision.model ?? '' })
                      : t('decisionBanner.body')}
                  </span>
                </div>
              ),
            },
          ]}
        />
      )}
      <div className="home-toolbar">
        <div className="home-tabs">
          <button
            className={tab === 'mine' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setTab('mine')}
          >
            {t('tabMine')}
          </button>
          <button
            className={tab === 'public' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setTab('public')}
          >
            {t('tabPublic')}
          </button>
        </div>
        <Link className="link-button" to="/">
          <Icon icon={ArrowLeft} size={14} /> {t('backToWorkbench')}
        </Link>
        <button className="primary-button" onClick={() => openCreate('templates')}>
          {t('newEnv')}
        </button>
      </div>

      {error && (
        <div className="page-note page-note--error">
          <p>{t('loadFailed', { error: error.message })}</p>
          <button onClick={() => void refetch()}>{t('retry')}</button>
        </div>
      )}
      {!error && isLoading && environments.length === 0 && <p className="page-note">{t('loading')}</p>}
      {!error && !isLoading && visible.length === 0 &&
        (tab === 'mine' ? (
          <div className="empty-state">
            <Icon icon={Globe} size={28} className="empty-state__icon" />
            <p className="empty-state__title">{t('emptyMineTitle')}</p>
            <p className="empty-state__note">{t('emptyMineNote')}</p>
            <div className="empty-state__actions">
              <button
                className="primary-button"
                disabled={starterBusy}
                onClick={() => void importStarterHome()}
              >
                {starterBusy ? t('importStarterBusy') : t('importStarter')}
              </button>
              <button onClick={() => openCreate('blank')}>{t('newBlank')}</button>
            </div>
            {starterError && (
              <p className="env-card__error">{t('importStarterFailed', { error: starterError })}</p>
            )}
          </div>
        ) : (
          <EmptyState icon={Globe} title={t('emptyPublic')} />
        ))}

      <div className="scenario-grid">
        {visible.map(env => (
          <EnvironmentCard key={env.id} env={env} />
        ))}
      </div>

      {createOpen && (
        <CreateEnvironmentDialog initialMode={createMode} onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function EnvironmentCard({ env }: { env: EnvironmentSummary }) {
  const roleLabel = useRoleLabel();
  const { t: tw } = useTranslation('world');
  const { t } = useTranslation('environments');
  const user = useAppStore(s => s.user);
  const confirm = useConfirm();
  const removeEnvironment = useRemoveEnvironment();
  const setEnvironmentVisibility = useSetEnvironmentVisibility();
  const joinEnvironment = useJoinEnvironment();
  const leaveEnvironment = useLeaveEnvironment();

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isOwner = env.myRole === 'owner' && user?.id === env.owner.id;
  const navigate = useNavigate();
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      // T-009: API payloads are English by contract — frame them so the
      // card-level failure is still intelligible in the active locale.
      setActionError(t('actionFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="scenario-card env-card"
      // Fix-46: whole card clickable — the explicit "enter" button stays for
      // discoverability, but clicking anywhere on the card navigates (the
      // common card affordance users expect).
      role="link"
      tabIndex={0}
      // R75/F7 + R76: the container names its environment AND its owner —
      // same-name worlds (the bundled demo vs a user's import) are otherwise
      // indistinguishable to assistive tech and automation.
      aria-label={t('cardAria', { name: env.name, owner: env.owner.displayName })}
      onClick={() => navigate(`/environments/${env.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/environments/${env.id}`); }}
    >
      <div className="scenario-card__header">
        <span className="scenario-card__name">{env.name}</span>
        <span className="env-card__badges">
          <span className="badge">{env.mapType}</span>
          <span className={`badge ${env.visibility === 'public' ? 'badge--seed' : ''}`}>
            {env.visibility === 'public' ? tw('visibility.public') : tw('visibility.private')}
          </span>
          {env.myRole && <span className="badge badge--user">{roleLabel(env.myRole)}</span>}
        </span>
      </div>
      <p className="scenario-card__description">{env.description || t('noDescription')}</p>
      <div className="scenario-card__counts">
        <Badge>{env.counts.devices} {t('countDevices')}</Badge>
        <Badge>{env.counts.agents} {t('countAgents')}</Badge>
        <Badge>{env.counts.services} {t('countServices')}</Badge>
        <Badge>{env.counts.members} {t('countMembers')}</Badge>
      </div>
      {/* R84 (R75-1/4 residual): owner AND creation time side by side —
          same-name imports (the bundled demo vs a user's copy) stay
          distinguishable in the grid, not only to assistive tech. */}
      <div className="scenario-card__id">
        {t('owner', { name: env.owner.displayName })} · {t('createdAt', { time: formatEnvTime(env.createdAt) })}
      </div>
      {actionError && <p className="env-card__error">{actionError}</p>}
      <div className="env-card__actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => navigate(`/environments/${env.id}`)}
        >
          {t('enter')}
        </button>
        {env.visibility === 'public' && env.myRole === null && (
          <button
            disabled={busy}
            // R75/F7 + R76: bare 加入 doesn't say WHICH environment — name
            // and owner both (same-name demo disambiguation).
            aria-label={t('joinAria', { name: env.name, owner: env.owner.displayName })}
            onClick={() => void run(() => joinEnvironment.mutateAsync(env.id))}
          >
            {t('join')}
          </button>
        )}
        {env.myRole !== null && env.myRole !== 'owner' && (
          <button
            disabled={busy}
            onClick={() => {
              // T6: 离开环境即失去成员身份与其中对象的所有权语境——二次确认。
              void confirm({ body: t('leaveConfirm', { name: env.name }), tone: 'warn' }).then(ok => {
                if (ok) void run(() => leaveEnvironment.mutateAsync(env.id));
              });
            }}
          >
            {t('leave')}
          </button>
        )}
        {isOwner && (
          <>
            <button
              disabled={busy}
              onClick={() => {
                // T6: 设为公开 = 任何人可见可加入——二次确认；转私有可免。
                if (env.visibility === 'public') {
                  void run(() =>
                    setEnvironmentVisibility.mutateAsync({ id: env.id, visibility: 'private' }),
                  );
                  return;
                }
                void confirm({ body: t('setPublicConfirm', { name: env.name }), tone: 'warn' }).then(ok => {
                  if (ok) {
                    void run(() =>
                      setEnvironmentVisibility.mutateAsync({ id: env.id, visibility: 'public' }),
                    );
                  }
                });
              }}
            >
              {env.visibility === 'public' ? t('setPrivate') : t('setPublic')}
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                void confirm({ body: t('deleteConfirm', { name: env.name }), tone: 'danger' }).then(ok => {
                  if (ok) void run(() => removeEnvironment.mutateAsync(env.id));
                });
              }}
            >
              {t('delete')}
            </button>
          </>
        )}
        {/* Decorative affordance hint: the whole card navigates (Fix-46). */}
        <Icon icon={ChevronRight} size={14} className="env-card__chevron" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

type CreateMode = 'templates' | 'blank' | 'import' | 'nl' | 'floorplan' | 'ifc' | 'osm';

/** Blank-world map tiers — the create dialog offers both (UX-W2). */
export type BlankMapType = 'grid' | 'geo';

/** Geo zoom bounds mirror the server contract (apps/server/src/geo.ts MIN/MAX_ZOOM). */
export const GEO_ZOOM_MIN = 1;
export const GEO_ZOOM_MAX = 19;

export interface BlankEnvironmentForm {
  name: string;
  description: string;
  mapType: BlankMapType;
  /** Raw input strings — validated here so the dialog and tests share one path. */
  geoLat: string;
  geoLng: string;
  geoZoom: string;
  visibility: EnvVisibility;
  membersPlan: boolean;
}

export type BlankBodyError = 'create.nameRequired' | 'create.geoCenterInvalid' | 'create.geoZoomInvalid';

/**
 * UX-W2: validate the blank-world form and build the POST /api/environments
 * body. geo payloads follow the server empty-world branch
 * (apps/server/src/routes/environments.ts:449-487 → parseMapDataInput →
 * geo.ts parseGeoMapData): `mapData.center {lat,lng}` is required
 * (lat −90..90 / lng −180..180), `mapData.zoom` optional (1..19).
 */
export function buildBlankEnvironmentBody(
  form: BlankEnvironmentForm,
): { body: Record<string, unknown>; error?: never } | { body?: never; error: BlankBodyError } {
  const name = form.name.trim();
  if (!name) return { error: 'create.nameRequired' };
  const body: Record<string, unknown> = {
    name,
    description: form.description.trim(),
    mapType: form.mapType,
    visibility: form.visibility,
  };
  if (form.mapType === 'geo') {
    const lat = Number(form.geoLat);
    const lng = Number(form.geoLng);
    const latOk = form.geoLat.trim() !== '' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
    const lngOk = form.geoLng.trim() !== '' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
    if (!latOk || !lngOk) return { error: 'create.geoCenterInvalid' };
    const mapData: Record<string, unknown> = { center: { lat, lng } };
    if (form.geoZoom.trim() !== '') {
      const zoom = Number(form.geoZoom);
      if (!Number.isFinite(zoom) || zoom < GEO_ZOOM_MIN || zoom > GEO_ZOOM_MAX) {
        return { error: 'create.geoZoomInvalid' };
      }
      mapData.zoom = zoom;
    }
    body.mapData = mapData;
  }
  if (form.membersPlan) body.ownershipPlan = 'members';
  return { body };
}

function CreateEnvironmentDialog({
  initialMode = 'templates',
  onClose,
}: {
  initialMode?: CreateMode;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useAppStore(s => s.pushToast);
  const { t } = useTranslation('environments');

  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<EnvVisibility>('private');
  // R80-FW2: the claim-plan declaration — the LAST MILE of C3/R42-B (the
  // mechanism existed server-side since R42; no UI ever exposed it, so
  // template worlds stayed importer-owned and every proposal funneled to
  // one owner — the R79 organizer-load finding).
  const [membersPlan, setMembersPlan] = useState(false);
  const [scenarioJson, setScenarioJson] = useState('');
  // UX-W2: blank-world geo tier — center + optional zoom (see
  // buildBlankEnvironmentBody for the wire contract).
  const [mapType, setMapType] = useState<BlankMapType>('grid');
  const [geoLat, setGeoLat] = useState('');
  const [geoLng, setGeoLng] = useState('');
  const [geoZoom, setGeoZoom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  // R2-UX-22a: the picked import file's name (FilePickButton display).
  const [importFileName, setImportFileName] = useState<string | null>(null);

  // B2: import from a local .json file — read it into the same textarea so
  // the user can still review/edit before submitting.
  const importFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setImportFileName(file.name);
    file.text().then(
      text => setScenarioJson(text),
      () => setError(t('create.importFileFailed')),
    );
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      let body: Record<string, unknown>;
      if (mode === 'blank') {
        const built = buildBlankEnvironmentBody({
          name,
          description,
          mapType,
          geoLat,
          geoLng,
          geoZoom,
          visibility,
          membersPlan,
        });
        if (built.error) {
          setError(t(built.error));
          setBusy(false);
          return;
        }
        body = built.body;
      } else {
        try {
          body = JSON.parse(scenarioJson) as Record<string, unknown>;
        } catch {
          setError(t('create.jsonParseFailed'));
          setBusy(false);
          return;
        }
        body = { ...body, visibility };
        if (membersPlan) body.ownershipPlan = 'members';
      }
      const detail = await api.createEnvironment(body);
      // The list query is cached — drop it so the home shows the new env.
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
      // R84 (R75-1/4 residual): server teaching warnings (duplicate-name,
      // zero-zone) ride the 201 — surface them as toasts BEFORE navigating,
      // same as the template path (R78); a same-name re-import must tell the
      // user both copies now exist instead of silently duplicating.
      for (const warning of detail.warnings ?? []) pushToast(warning);
      onClose();
      navigate(`/environments/${detail.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        // T-009: English API payload — localized framing keeps the failure
        // readable; the code token stays for cross-referencing the contract.
        // R2-UX-25: a bare「SCENARIO_VALIDATION_FAILED: Scenario validation
        // failed」first line told the user nothing — fold the first issue
        // into the headline (the full list still renders below).
        const issueList = Array.isArray(err.issues) ? err.issues.map(String) : [];
        const headline =
          issueList.length > 0
            ? `${err.code}: ${err.message} — ${issueList[0]}`
            : `${err.code}: ${err.message}`;
        setError(t('create.failed', { error: headline }));
        // Scenario-import 400s carry a verbatim issue list — show it as-is.
        if (issueList.length > 0) setIssues(issueList);
      } else {
        setError(t('create.failed', { error: String(err) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <div className="dialog__titlebar">
          <h3 className="dialog__title">{t('create.title')}</h3>
          {/* R2-UX-22b: an explicit ✕ close — the floorplan/ifc/osm lanes
              render no cancel button at all, and every mode deserves the
              standard dialog affordance. */}
          <button
            className="dialog__close"
            aria-label={t('create.closeDialog')}
            onClick={onClose}
          >
            <Icon icon={X} size={16} />
          </button>
        </div>
        <div className="home-tabs">
          <button
            className={mode === 'templates' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('templates')}
          >
            {t('create.modeTemplates')}
          </button>
          <button
            className={mode === 'blank' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('blank')}
          >
            {t('create.modeBlank')}
          </button>
          <button
            className={mode === 'import' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('import')}
          >
            {t('create.modeImport')}
          </button>
          <button
            className={mode === 'nl' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('nl')}
          >
            {t('create.modeNl')}
          </button>
          <button
            className={mode === 'floorplan' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('floorplan')}
          >
            {t('create.modeFloorplan')}
          </button>
          <button
            className={mode === 'ifc' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('ifc')}
          >
            {t('create.modeIfc')}
          </button>
          <button
            className={mode === 'osm' ? 'home-tab home-tab--active' : 'home-tab'}
            onClick={() => setMode('osm')}
          >
            {t('create.modeOsm')}
          </button>
        </div>

        {/* R2-FEAT-09: each create lane gets a one-line plain-language
            explanation — the tab names alone (模板/空白/JSON/图纸/IFC/OSM)
            didn't tell newcomers what they're for. */}
        <p className="page-note">{t(`create.modeHint.${mode}`)}</p>
        {mode === 'templates' ? (
          <TemplateCards visibility={visibility} membersPlan={membersPlan} onClose={onClose} />
        ) : mode === 'blank' ? (
          <>
            <label className="dialog-field">
              {t('create.blankNameLabel')}
              <input
                key="blank-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={t('create.blankNamePlaceholder')}
              />
            </label>
            <label className="dialog-field">
              {t('create.blankDescLabel')}
              <input value={description} onChange={event => setDescription(event.target.value)} />
            </label>
            <label className="dialog-field">
              {t('create.mapTypeLabel')}
              <select
                value={mapType}
                onChange={event => setMapType(event.target.value as BlankMapType)}
              >
                <option value="grid">{t('create.mapTypeGridOption')}</option>
                <option value="geo">{t('create.mapTypeGeoOption')}</option>
              </select>
            </label>
            {mapType === 'geo' && (
              <>
                <div className="geo-center-row">
                  <label className="dialog-field">
                    {t('create.geoCenterLatLabel')}
                    <input
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      value={geoLat}
                      onChange={event => setGeoLat(event.target.value)}
                      /* R2: a bare-number placeholder reads as a prefilled
                         default — the submit then fails「中心点无效」on an
                         "obviously filled" field. Mark it as an example. */
                      placeholder={t('create.geoLatPlaceholder')}
                    />
                  </label>
                  <label className="dialog-field">
                    {t('create.geoCenterLngLabel')}
                    <input
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      value={geoLng}
                      onChange={event => setGeoLng(event.target.value)}
                      placeholder={t('create.geoLngPlaceholder')}
                    />
                  </label>
                </div>
                <label className="dialog-field">
                  {t('create.geoZoomLabel')}
                  <input
                    type="number"
                    min={GEO_ZOOM_MIN}
                    max={GEO_ZOOM_MAX}
                    step={1}
                    value={geoZoom}
                    onChange={event => setGeoZoom(event.target.value)}
                  />
                </label>
              </>
            )}
          </>
        ) : mode === 'import' ? (
          <>
            <div className="dialog-field">
              {t('create.importFileLabel')}
              {/* R2-UX-22a: localized trigger instead of the browser-locale
                  native file button. */}
              <FilePickButton
                label={t('create.filePickButton')}
                emptyLabel={t('create.filePickEmpty')}
                inputAriaLabel={t('create.importFileLabel')}
                accept=".json,application/json"
                pickedName={importFileName}
                onPick={importFile}
              />
            </div>
            <label className="dialog-field">
              {t('create.jsonLabel')} (v1.0)
              <textarea
                className="dialog__textarea"
                value={scenarioJson}
                onChange={event => setScenarioJson(event.target.value)}
                placeholder='{"version":"1.0","meta":{...},"zones":[...],"devices":[...],"agents":[...],"events":[...]}'
                rows={10}
              />
            </label>
          </>
        ) : (
          /* UX-W3/W5 draft lanes (一句话 / 图纸 / IFC / OSM) — each pane owns
             its two-step wizard (inputs → shared ImportDraftReview → confirm
             creates). */
          <>
            {mode === 'nl' && (
              <NlImportPane
                visibility={visibility}
                membersPlan={membersPlan}
                onClose={onClose}
                onSwitchMode={setMode}
              />
            )}
            {mode === 'floorplan' && (
              <FloorplanImportPane
                visibility={visibility}
                membersPlan={membersPlan}
                onClose={onClose}
                onSwitchMode={setMode}
              />
            )}
            {mode === 'ifc' && (
              <IfcImportPane
                visibility={visibility}
                membersPlan={membersPlan}
                onClose={onClose}
                onSwitchMode={setMode}
              />
            )}
            {mode === 'osm' && (
              <OsmImportPane
                visibility={visibility}
                membersPlan={membersPlan}
                onClose={onClose}
                onSwitchMode={setMode}
              />
            )}
          </>
        )}

        <label className="dialog-field">
          {t('create.visibilityLabel')}
          <select
            value={visibility}
            onChange={event => setVisibility(event.target.value as EnvVisibility)}
          >
            <option value="private">{t('create.visibilityPrivateOption')}</option>
            <option value="public">{t('create.visibilityPublicOption')}</option>
          </select>
        </label>

        {error && <p className="env-card__error">{error}</p>}
        {issues.length > 0 && (
          <ul className="dialog__issues">
            {issues.map(issue => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}

        {/* R80-FW2: claim-plan declaration (C3/R42-B last mile). */}
        {mode !== 'blank' && (
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={membersPlan}
              onChange={event => setMembersPlan(event.target.checked)}
            />
            <span>{t('create.membersPlan')}</span>
            <span className="object-list__meta">{t('create.membersPlanHint')}</span>
          </label>
        )}
        <div className="dialog__actions">
          {/* UX-W3/W5 lanes own their action rows inside the pane. */}
          {mode !== 'nl' && mode !== 'floorplan' && mode !== 'ifc' && mode !== 'osm' && (
            <>
              <button onClick={onClose} disabled={busy}>
                {t('create.cancel')}
              </button>
              {/* 模板 tab: each card carries its own 创建 button. */}
              {mode !== 'templates' && (
                <button className="primary-button" disabled={busy} onClick={() => void submit()}>
                  {busy ? t('create.creating') : (mode === 'blank' ? t('create.submitBlank') : t('create.submitImport'))}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * W1b 模板 tab — the bundled scenario templates as cards; one click fetches
 * the template JSON and posts it to /api/environments (same import path as
 * paste-JSON, so geo templates keep their own map fields), then jumps into
 * the new world.
 */
function TemplateCards({
  visibility,
  membersPlan = false,
  onClose,
}: {
  visibility: EnvVisibility;
  /** R81: the claim-plan declaration rides the template path too (the
   *  template card bypasses the dialog's own submit — the first R81 smoke
   *  caught the checkbox silently not reaching this lane). */
  membersPlan?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useAppStore(s => s.pushToast);
  const { t } = useTranslation('environments');
  const { data: templates = [], error, isLoading, refetch } = useScenarioTemplateList();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // UX-W3: a parameterized template (vars) opens this form before creation —
  // values go to POST …/instantiate and the expanded scenario is imported.
  const [paramTemplate, setParamTemplate] = useState<ScenarioTemplateSummary | null>(null);
  const [paramInputs, setParamInputs] = useState<TemplateVarInputs>({});
  // R2-FEAT-04: the parameterized lane also takes a custom environment name
  // (default = the template's display name) — a static「(30 栋)」-style
  // template name no longer freezes onto every instance.
  const [paramName, setParamName] = useState('');

  /** Shared tail: scenario JSON → POST /api/environments → toasts → navigate. */
  const createFromScenario = async (scenario: Record<string, unknown>) => {
    const detail = await api.createEnvironment({ ...scenario, visibility, ...(membersPlan ? { ownershipPlan: 'members' } as const : {}) });
    // The list query is cached — drop it so the home shows the new env.
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
    // R78: server teaching warnings (duplicate-name, zero-zone) ride the
    // 201 response — surface them as toasts BEFORE navigating, or they
    // are lost and the user re-derives them the hard way (R77 same-name
    // world detour).
    for (const warning of detail.warnings ?? []) pushToast(warning);
    onClose();
    navigate(`/environments/${detail.id}`);
  };

  const createFromTemplate = async (template: ScenarioTemplateSummary) => {
    if (busyId !== null) return;
    // Parameterized template: open the var form instead of creating directly.
    if (template.vars && template.vars.length > 0) {
      setParamTemplate(template);
      setParamInputs(defaultTemplateVarInputs(template.vars));
      setParamName(template.name);
      setCreateError(null);
      return;
    }
    setBusyId(template.id);
    setCreateError(null);
    try {
      const scenario = await api.getScenarioTemplate(template.id);
      await createFromScenario(scenario);
    } catch (err) {
      // T-009: English API payload — localized framing at the catch site.
      setCreateError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
      setBusyId(null);
    }
  };

  /** Param form submit: validate → instantiate → create. */
  const submitParamForm = async () => {
    if (busyId !== null || paramTemplate === null) return;
    const vars = paramTemplate.vars ?? [];
    const validation = validateTemplateVarInputs(vars, paramInputs);
    if (!validation.ok) {
      const first = validation.errors[0]!;
      const label = vars.find(v => v.name === first.name)?.label ?? first.name;
      setCreateError(
        first.reason === 'notInt'
          ? t('create.templateVars.notInt', { label })
          : t('create.templateVars.outOfRange', {
              label,
              min: vars.find(v => v.name === first.name)?.min ?? 0,
              max: vars.find(v => v.name === first.name)?.max ?? 0,
            }),
      );
      return;
    }
    setBusyId(paramTemplate.id);
    setCreateError(null);
    try {
      const scenario = await api.instantiateScenarioTemplate(paramTemplate.id, validation.values);
      // R2-FEAT-04: a custom environment name overrides the template's
      // meta.name on the instance (blank = keep the template name).
      if (paramName.trim() !== '' && paramName.trim() !== paramTemplate.name) {
        const meta = (scenario.meta ?? {}) as Record<string, unknown>;
        scenario.meta = { ...meta, name: paramName.trim() };
      }
      await createFromScenario(scenario);
    } catch (err) {
      setCreateError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
      setBusyId(null);
    }
  };

  if (error) {
    return (
      <div className="page-note page-note--error">
        <p>{t('create.templatesLoadFailed', { error: error.message })}</p>
        <button onClick={() => void refetch()}>{t('retry')}</button>
      </div>
    );
  }
  if (isLoading) return <p className="page-note">{t('create.templatesLoading')}</p>;
  if (templates.length === 0) return <EmptyState icon={Globe} title={t('create.templatesEmpty')} />;

  // R2-FEAT-09: starter-home pins to the top with a「新手推荐」badge — the
  // alphabetical server order buried the one template meant for newcomers.
  const ordered = [...templates].sort((a, b) =>
    a.id === 'starter-home' ? -1 : b.id === 'starter-home' ? 1 : 0,
  );

  return (
    <div className="template-list">
      {createError && <p className="env-card__error">{createError}</p>}
      {/* UX-W3: the parameter form replaces the list while open — one template
          is sized at a time; 返回 restores the cards. */}
      {paramTemplate !== null ? (
        <div className="template-vars-form">
          <p className="template-vars-form__title">
            {t('create.templateVars.title', { name: paramTemplate.name })}
          </p>
          {/* R2-FEAT-04: the instance name is editable (default = template
              name) — two instances of one template stay distinguishable. */}
          <label className="dialog-field">
            {t('create.templateVars.envNameLabel')}
            <input
              value={paramName}
              aria-label={t('create.templateVars.envNameLabel')}
              onChange={event => setParamName(event.target.value)}
            />
          </label>
          {(paramTemplate.vars ?? []).map(v => (
            <label key={v.name} className="dialog-field">
              {v.label}
              <span className="object-list__meta">
                {t('create.templateVars.range', { min: v.min, max: v.max, default: v.default })}
              </span>
              <input
                type="number"
                step={1}
                min={v.min}
                max={v.max}
                value={paramInputs[v.name] ?? String(v.default)}
                aria-label={v.label}
                onChange={event =>
                  setParamInputs(current => ({ ...current, [v.name]: event.target.value }))
                }
              />
            </label>
          ))}
          <div className="dialog__actions">
            <button
              disabled={busyId !== null}
              onClick={() => {
                setParamTemplate(null);
                setCreateError(null);
              }}
            >
              {t('create.review.back')}
            </button>
            <button
              className="primary-button"
              disabled={busyId !== null}
              onClick={() => void submitParamForm()}
            >
              {busyId === paramTemplate.id ? t('create.creating') : t('create.templateCreate')}
            </button>
          </div>
        </div>
      ) : (
        ordered.map(template => (
        <div key={template.id} className="template-card">
          <div className="template-card__header">
            <span className="template-card__name">{template.name}</span>
            {template.id === 'starter-home' && (
              <span className="badge template-card__badge-beginner">{t('create.beginnerBadge')}</span>
            )}
            <span className="badge">{template.mapType}</span>
            {template.vars && template.vars.length > 0 && (
              <span className="badge badge--seed">{t('create.templateVars.badge')}</span>
            )}
          </div>
          <p className="template-card__description" title={template.description}>{template.description}</p>
          <div className="template-card__footer">
            <span className="template-card__counts">
              {t('create.templateCounts', {
                zones: template.counts.zones,
                devices: template.counts.devices,
                agents: template.counts.agents,
                // R75/F10: the server already counts derived services — show
                // it so a service-rich template no longer reads as bare.
                services: template.counts.derivedServices,
              })}
            </span>
            <button
              className="primary-button"
              disabled={busyId !== null}
              onClick={() => void createFromTemplate(template)}
            >
              {busyId === template.id ? t('create.creating') : t('create.templateCreate')}
            </button>
          </div>
        </div>
        ))
      )}
    </div>
  );
}
