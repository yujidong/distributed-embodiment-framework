/**
 * AgentWizard — the Agent tab's embedded creation/edit step form (W6).
 *
 * Four steps, all client-validated before submit (lib/agentWizard.ts):
 *  1. 基本信息 — name + capability chips (suggestions from the env's
 *     capability vocabulary + free-text add; at least one required);
 *  2. 绑定设备 — own devices; the env owner may bind any device (others'
 *     checkboxes render disabled for plain builders);
 *  3. 管理区域 — defaults to the bound devices' zones until touched;
 *  4. LLM 配置 — 无(规则) / OpenAI 兼容（vLLM；R44-B 起唯一后端）
 *     (baseURL + model), with a collapsed 高级 JSON params field.
 *
 * Creation POSTs and edit PATCHes; the response is applied to the world
 * store optimistically — the world-stream broadcast dedupes by id, and a
 * derived-service resync after rebinding arrives as service frames.
 */

import { useEffect, useMemo, useReducer, useState, type Dispatch } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, WorldAgent, WorldDevice } from '../../api/types';
import {
  WIZARD_STEP_LABELS,
  bindableDevices,
  unbackedCapabilities,
  buildCreatePayload,
  buildPatchPayload,
  canBindDevice,
  capabilityVocabulary,
  createWizardState,
  reduceWizard,
  splitVocabularyByBacking,
  stepError,
  wizardError,
  wizardStateFromAgent,
  type AgentWizardAction,
  type AgentWizardState,
  type WizardStep,
} from '../../lib/agentWizard';
import { useAppStore } from '../../store/useAppStore';
import { reportCapabilityDemand } from '../../lib/capabilityDemand';
import { deviceProvides } from '../../lib/flowWizard';
import { Icon } from '../ui/Icon';

export interface AgentWizardProps {
  world: EnvironmentDetail;
  /** null → create mode; an agent → edit mode (prefilled). */
  agent: WorldAgent | null;
  onClose: () => void;
}

export function AgentWizard({ world, agent, onClose }: AgentWizardProps) {
  const { t } = useTranslation('agentForm');
  const user = useAppStore(s => s.user);
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);

  const viewerId = user?.id ?? '';
  const isEnvOwner = world.myRole === 'owner';
  const ctx = useMemo(
    () => ({ devices: world.devices, viewerId, isEnvOwner }),
    [world.devices, viewerId, isEnvOwner],
  );

  const [state, dispatch] = useReducer(
    (s: AgentWizardState, a: AgentWizardAction) => reduceWizard(s, a, ctx),
    agent ? wizardStateFromAgent(agent) : createWizardState(),
  );

  const [catalogCapabilities, setCatalogCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Capability vocabulary = env devices + existing services + the catalog.
  useEffect(() => {
    let cancelled = false;
    api
      .listCatalog()
      .then(models => {
        if (cancelled) return;
        setCatalogCapabilities([...new Set(models.flatMap(model => model.capabilities))]);
      })
      .catch(() => {
        // Catalog unreachable → suggestions just shrink; the form still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const vocabulary = useMemo(
    () =>
      capabilityVocabulary({
        devices: world.devices,
        services: world.services,
        catalogCapabilities,
      }),
    [world.devices, world.services, catalogCapabilities],
  );

  // R75/F1: split suggestions by whether a BINDABLE device provides them —
  // unbacked chips stay selectable (the owner may still place a device) but
  // carry a warning marker, so the T-206 backing rule is visible BEFORE the
  // proposal is rejected (the R71 F1 failure mode: 11/11 silent rejections).
  const bindable = useMemo(
    () => bindableDevices(world.devices, viewerId, isEnvOwner),
    [world.devices, viewerId, isEnvOwner],
  );
  const { backed: backedVocabulary, unbacked: unbackedVocabulary } = useMemo(
    () => splitVocabularyByBacking(vocabulary, bindable),
    [vocabulary, bindable],
  );

  const step = state.step;
  const currentStepError = stepError(state, step, ctx);
  // R80-FW3: a blocked declaration is the strongest demand signal — the user
  // WROTE the capability and the platform cannot back it. (Effect, not render
  // side-effect; fire-and-forget, session-deduped.)
  useEffect(() => {
    if (currentStepError?.includes('没有任何你可绑定的设备能提供') ?? false) {
      for (const capability of state.capabilities) reportCapabilityDemand(
        capability, 'wizard-rejected-declaration', world.id,
      );
    }
  }, [currentStepError, state.capabilities, world.id]);
  const wholeFormError = wizardError(state, ctx);
  const isLastStep = step === 3;

  const addCapability = (value: string) => {
    dispatch({ type: 'addCapability', capability: value });
    setCapabilityInput('');
  };

  /**
   * R75/F1: a proposal the governance pipeline REJECTED synchronously (rule
   * check failed) must never read as success — the wizard stays open and the
   * rule-check issues render in place, naming exactly what to fix. The
   * server's issues already teach (they list what the bound devices provide).
   */
  const proposalRejectedError = (proposal: api.ProposalConversion): string => {
    const issues = proposal.ruleCheck?.issues ?? [];
    return t('proposalRejectedInForm', {
      id: proposal.id,
      issues: issues.length > 0 ? issues.join('；') : t('proposalRejectedNoIssues'),
    });
  };

  const submit = async () => {
    if (busy || wholeFormError !== null) return;
    setBusy(true);
    setSubmitError(null);
    try {
      if (agent) {
        if (isEnvOwner) {
          const updated = await api.patchAgent(agent.id, buildPatchPayload(state));
          applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'agent', object: updated });
          pushToast(t('savedToast', { name: updated.name }));
        } else {
          // T-048: the direct PATCH route is owner-only — a builder's own
          // edit goes through a modify-object proposal (same patch body).
          const proposal = await api.submitModifyObjectProposal(
            world.id,
            agent.id,
            buildPatchPayload(state) as unknown as Record<string, unknown>,
          );
          if (proposal.status === 'rejected') {
            setSubmitError(proposalRejectedError(proposal));
            return; // keep the form open — fix and resubmit in place
          }
          pushToast(
            proposal.status === 'applied'
              ? t('proposalAppliedToast')
              : t('proposalToast', { id: proposal.id, status: proposal.status }),
          );
        }
      } else {
        const created = await api.createAgent(world.id, buildCreatePayload(state));
        if (api.isProposalConversion(created)) {
          // T-048: a builder's create is an install-agents PROPOSAL — the
          // agent lands only if the pipeline approves it (no fake object).
          if (created.status === 'rejected') {
            setSubmitError(proposalRejectedError(created));
            return; // keep the form open — fix and resubmit in place
          }
          pushToast(t('proposalToast', { id: created.id, status: created.status }));
        } else {
          applyWorldMessage({ kind: 'world', action: 'created', objectType: 'agent', object: created });
          pushToast(t('createdToast', { name: created.name }));
        }
      }
      onClose();
    } catch (error) {
      // T-009: English API payload — localized framing at the catch site.
      setSubmitError(
        t('submitFailed', {
          error: error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const myDevices = world.devices.filter(device => device.owner.id === viewerId);
  const otherDevices = world.devices.filter(device => device.owner.id !== viewerId);
  const zoneName = (zoneId: string) =>
    world.zones.find(zone => zone.id === zoneId)?.name ?? zoneId;

  return (
    <div className="wizard">
      <div className="wizard__header">
        <h4 className="object-detail__name">{agent ? t('editTitle') : t('newTitle')}</h4>
        <div className="wizard__steps">
          {WIZARD_STEP_LABELS().map((label, index) => (
            <span
              key={label}
              className={
                index === step ? 'wizard__step-chip wizard__step-chip--active' : 'wizard__step-chip'
              }
            >
              {index + 1}. {label}
            </span>
          ))}
        </div>
      </div>

      <div className="wizard__body">
        {step === 0 && (
          <>
            <label className="form-field">
              <span className="form-field__label">{t('nameLabel')}</span>
              <input
                value={state.name}
                onChange={event => dispatch({ type: 'setName', name: event.target.value })}
                placeholder={t('namePlaceholder')}
              />
            </label>
            <div className="form-field">
              <span className="form-field__label">{t('capabilitiesLabel')}</span>
              {state.capabilities.length > 0 && (
                <div className="chip-row">
                  {state.capabilities.map(capability => {
                    // R78-E: the SELECTED row gets the same ⚠ verdict as the
                    // suggestions — free-text entries included (the step-0
                    // gate stays the final word; this is the instant cue).
                    const unbacked = unbackedCapabilities([capability], bindable);
                    return (
                      <button
                        key={capability}
                        className={`chip chip--button chip--active${unbacked.length > 0 ? ' chip--unbacked' : ''}`}
                        title={unbacked.length > 0 ? t('capabilityUnbackedTitle', { capability }) : t('capabilityRemove')}
                        onClick={() => dispatch({ type: 'removeCapability', capability })}
                      >
                        {unbacked.length > 0 ? '⚠ ' : ''}{capability} <Icon icon={X} size={12} label={t('capabilityRemoveLabel', { capability })} />
                      </button>
                    );
                  })}
                </div>
              )}
              {backedVocabulary.filter(c => !state.capabilities.includes(c)).length > 0 && (
                <div className="chip-row">
                  {backedVocabulary
                    .filter(capability => !state.capabilities.includes(capability))
                    .map(capability => (
                      <button
                        key={capability}
                        className="chip chip--button"
                        title={t('capabilityAdd')}
                        onClick={() => addCapability(capability)}
                      >
                        {capability}
                      </button>
                    ))}
                </div>
              )}
              {unbackedVocabulary.filter(c => !state.capabilities.includes(c)).length > 0 && (
                <>
                  <p className="page-note">{t('capabilityUnbackedHint')}</p>
                  <div className="chip-row">
                    {unbackedVocabulary
                      .filter(capability => !state.capabilities.includes(capability))
                      .map(capability => (
                        <button
                          key={capability}
                          className="chip chip--button chip--unbacked"
                          title={t('capabilityUnbackedTitle', { capability })}
                          onClick={() => {
                            // R80-FW3: seeing an unbackable chip IS demand —
                            // report it so the deployer's catalog-gap view
                            // learns what to add (fire-and-forget).
                            reportCapabilityDemand(capability, 'wizard-unbacked-chip', world.id);
                            addCapability(capability);
                          }}
                        >
                          ⚠ {capability}
                        </button>
                      ))}
                  </div>
                </>
              )}
              <div className="form-field__inline">
                <input
                  value={capabilityInput}
                  onChange={event => setCapabilityInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') addCapability(capabilityInput);
                  }}
                  placeholder={t('capabilityCustomPlaceholder')}
                />
                <button
                  disabled={capabilityInput.trim().length === 0}
                  onClick={() => addCapability(capabilityInput)}
                >
                  {t('capabilityAddButton')}
                </button>
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="page-note">{t('devicesHint')}</p>
            <DeviceGroup
              title={t('devicesTitle')}
              devices={myDevices}
              emptyNote={t('devicesEmptyMine')}
              boundIds={state.boundDeviceIds}
              zoneName={zoneName}
              disabledIds={new Set()}
              neededCapabilities={state.capabilities}
              dispatch={dispatch}
            />
            {otherDevices.length > 0 && (
              <DeviceGroup
                title={
                  isEnvOwner
                    ? t('devicesOthersOwner')
                    : t('devicesOthersNonOwner')
                }
                devices={otherDevices}
                emptyNote=""
                boundIds={state.boundDeviceIds}
                zoneName={zoneName}
                disabledIds={
                  new Set(
                    otherDevices
                      .filter(device => !canBindDevice(device, viewerId, isEnvOwner))
                      .map(device => device.id),
                  )
                }
                neededCapabilities={state.capabilities}
                dispatch={dispatch}
              />
            )}
          </>
        )}

        {step === 2 && (
          <>
            <p className="page-note">{t('zonesHint')}</p>
            {world.zones.length === 0 && <p className="page-note">{t('zonesEmpty')}</p>}
            <div className="check-list">
              {world.zones.map(zone => (
                <label key={zone.id} className="check-list__item">
                  <input
                    type="checkbox"
                    checked={state.managedZoneIds.includes(zone.id)}
                    onChange={() => dispatch({ type: 'toggleZone', zoneId: zone.id })}
                  />
                  <span>{zone.name ?? zone.id}</span>
                  {zone.type && <span className="object-list__meta">{zone.type}</span>}
                </label>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="form-field">
              <span className="form-field__label">{t('decisionMode')}</span>
              <label className="check-list__item">
                <input
                  type="radio"
                  name="llm-kind"
                  checked={state.llm.kind === 'none'}
                  onChange={() => dispatch({ type: 'setLlmKind', kind: 'none' })}
                />
                {t('modeNone')}
              </label>
              <label className="check-list__item">
                <input
                  type="radio"
                  name="llm-kind"
                  checked={state.llm.kind === 'openai'}
                  onChange={() => dispatch({ type: 'setLlmKind', kind: 'openai' })}
                />
                {t('modeOpenAI')}
              </label>
            </div>
            {state.llm.kind === 'openai' && (
              <>
                <label className="form-field">
                  <span className="form-field__label">Base URL (optional)</span>
                  <input
                    value={state.llm.baseUrl}
                    onChange={event =>
                      dispatch({ type: 'setLlmBaseUrl', baseUrl: event.target.value })
                    }
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="form-field">
                  <span className="form-field__label">{t('modelLabel')}</span>
                  <input
                    value={state.llm.model}
                    onChange={event => dispatch({ type: 'setLlmModel', model: event.target.value })}
                  />
                </label>
              </>
            )}
            {state.llm.kind !== 'none' && (
              <label className="form-field">
                <span className="form-field__label">{t('systemPromptLabel')}</span>
                <textarea
                  className="dialog__textarea"
                  aria-label={t('systemPromptAria')}
                  value={state.llm.systemPrompt}
                  onChange={event =>
                    dispatch({ type: 'setLlmSystemPrompt', systemPrompt: event.target.value })
                  }
                  placeholder={t('systemPromptPlaceholder')}
                  rows={3}
                />
              </label>
            )}
            {state.llm.kind !== 'none' && (
              <div className="form-field">
                <button className="link-button" onClick={() => dispatch({ type: 'toggleAdvanced' })}>
                  <Icon icon={state.llm.advancedOpen ? ChevronDown : ChevronRight} size={13} /> {t('advanced')}
                </button>
                {state.llm.advancedOpen && (
                  <textarea
                    className="dialog__textarea wizard__params"
                    value={state.llm.paramsJson}
                    onChange={event =>
                      dispatch({ type: 'setLlmParamsJson', paramsJson: event.target.value })
                    }
                    placeholder={t('advancedPlaceholder')}
                    rows={4}
                  />
                )}
              </div>
            )}
            {/* T-051: per-agent actuation policy — tri-state selects; unset
                keeps the runtime default (a sim-level option still wins). */}
            <div className="form-field">
              <span className="form-field__label">{t('policyTitle')}</span>
              <p className="page-note">{t('policyHint')}</p>
              {(['autoActuateIndependent', 'autoInitiateAC'] as const).map(field => (
                <label key={field} className="form-field__inline">
                  <span>
                    {field === 'autoActuateIndependent' ? t('policyAutoActuate') : t('policyAutoInitiate')}
                  </span>
                  <select
                    className="member-list__role"
                    value={state.policy[field]}
                    onChange={event =>
                      dispatch({
                        type: 'setPolicy',
                        field,
                        value: event.target.value as 'unset' | 'on' | 'off',
                      })
                    }
                  >
                    <option value="unset">{t('policyUnset')}</option>
                    <option value="on">{t('policyOn')}</option>
                    <option value="off">{t('policyOff')}</option>
                  </select>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {currentStepError !== null && <p className="page-note">{currentStepError}</p>}
      {/* R76-F1: half-logged-in boot (GET /auth/me failed) leaves viewerId
          empty → zero bindable devices → every chip unbacked and Next silently
          disabled. Say what happened instead of failing quietly. */}
      {user === null && <p className="page-note--error">{t('sessionLostHint')}</p>}
      {submitError !== null && <p className="page-note--error">{submitError}</p>}

      <div className="wizard__footer">
        <button className="link-button" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </button>
        <span className="wizard__footer-spacer" />
        {step > 0 && (
          <button
            disabled={busy}
            onClick={() => dispatch({ type: 'goToStep', step: (step - 1) as WizardStep })}
          >
            {t('prev')}
          </button>
        )}
        {!isLastStep && (
          <button
            className="primary-button"
            disabled={currentStepError !== null}
            onClick={() => dispatch({ type: 'goToStep', step: (step + 1) as WizardStep })}
          >
            {t('next')}
          </button>
        )}
        {isLastStep && (
          <button
            className="primary-button"
            disabled={busy || wholeFormError !== null}
            onClick={() => void submit()}
          >
            {busy ? t('submitting') : agent ? t('save') : t('create')}
          </button>
        )}
      </div>
    </div>
  );
}

function DeviceGroup({
  title,
  devices,
  emptyNote,
  boundIds,
  zoneName,
  disabledIds,
  neededCapabilities,
  dispatch,
}: {
  title: string;
  devices: readonly WorldDevice[];
  emptyNote: string;
  boundIds: readonly string[];
  zoneName: (zoneId: string) => string;
  disabledIds: ReadonlySet<string>;
  /** R79-logi (A3): capabilities declared at step 0 — matching rows first. */
  neededCapabilities: readonly string[];
  dispatch: Dispatch<AgentWizardAction>;
}) {
  // R72: hierarchical rows — the name gets the full line width; type/zone/
  // owner details collapse behind a per-device toggle instead of fighting
  // for space on the same line (they never fit in a 340px sidebar).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { t } = useTranslation('agentForm');
  const toggleExpanded = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // R79-logi (A3): the list was never truncated — but rows showed only the
  // device NAME, so in a 100+ device template world the one device covering
  // the declared capability was unfindable (probe gave up after scanning the
  // first 5–10 rows; the step-1 backing gate then blocked 下一步). Surface it:
  // devices providing a declared capability sort first (stable) and carry a
  // match chip, and the expanded details now list the device's capabilities.
  const providesNeeded = (device: WorldDevice): boolean =>
    neededCapabilities.some(capability => deviceProvides(device.capabilities, capability));
  const sortedDevices =
    neededCapabilities.length === 0
      ? devices
      : [...devices].sort((a, b) => Number(providesNeeded(b)) - Number(providesNeeded(a)));

  return (
    <div className="form-field">
      <span className="form-field__label">{title}</span>
      {devices.length === 0 && emptyNote !== '' && <p className="page-note">{emptyNote}</p>}
      <div className="check-list">
        {sortedDevices.map(device => {
          const disabled = disabledIds.has(device.id);
          const bound = boundIds.includes(device.id);
          const isOpen = expanded.has(device.id);
          return (
            <div
              key={device.id}
              className={
                'check-list__item' + (disabled ? ' check-list__item--disabled' : '')
              }
            >
              <div className="check-list__row">
                <label className="check-list__bind">
                  <input
                    type="checkbox"
                    checked={bound}
                    disabled={disabled}
                    onChange={() => dispatch({ type: 'toggleDevice', deviceId: device.id })}
                  />
                  <span className="check-list__name">{device.name}</span>
                </label>
                {providesNeeded(device) && (
                  <span className="check-list__match">{t('deviceMatchDeclared')}</span>
                )}
                <button
                  type="button"
                  className="check-list__toggle"
                  title={isOpen ? '收起详情' : '查看详情'}
                  onClick={() => toggleExpanded(device.id)}
                >
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              </div>
              {isOpen && (
                <div className="check-list__details">
                  {device.type} · {zoneName(device.zoneId)} ·{' '}
                  {device.owner.displayName}
                  {disabled ? ' · 不可绑定' : ''}
                  <div>
                    {t('deviceCapabilities', {
                      list: device.capabilities.join(', ') || '—',
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
