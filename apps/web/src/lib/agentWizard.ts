/**
 * Agent creation/edit wizard logic (W6) — pure functions so the sidebar
 * component stays thin and the validation semantics are unit-testable.
 *
 * The wizard is a 4-step form (基本信息 → 绑定设备 → 管理区域 → LLM 配置)
 * embedded in the Agent sidebar tab; the same state drives both creation
 * (POST /api/environments/:id/agents) and editing (PATCH /api/agents/:id).
 *
 * Binding rule: a builder may bind only their OWN devices; the env owner may
 * bind any device in the env (the server enforces ownership too — the rule
 * here only shapes which checkboxes are enabled and gives an inline error).
 */

import type {
  OwnerRef,
  PatchAgentInput,
  ScenarioAgentLLM,
  WorldAgent,
  WorldDevice,
} from '../api/types';
import { deviceProvides } from './flowWizard';
import i18n from '../i18n/config';

/**
 * The single LLM kind: the OpenAI-compatible backend (vLLM). The local
 * backend option was removed in R44-B.
 */
export type LlmKind = 'none' | 'openai';

/**
 * T-051: tri-state policy control — unset keeps the runtime default,
 * on/off write the explicit boolean into decisionPolicy.
 */
export type PolicyTriState = 'unset' | 'on' | 'off';

export type WizardStep = 0 | 1 | 2 | 3;

/** Wizard step labels in the active locale (live i18n read). */
export function wizardStepLabels(): readonly string[] {
  const t = i18n.getFixedT(i18n.language, 'agentWizardLib');
  return [t('stepLabels.basics'), t('stepLabels.devices'), t('stepLabels.zones'), t('stepLabels.llm')];
}

/**
 * Backward-compatible alias. Components used to import this as a static array;
 * it now reads i18n at call time. Callers should invoke `wizardStepLabels()`
 * (or use the `agentWizardLib:stepLabels.*` keys from a `useTranslation` hook)
 * and treat this export as a function.
 */
export const WIZARD_STEP_LABELS = wizardStepLabels;

export interface LlmFormState {
  kind: LlmKind;
  model: string;
  /** OpenAI 兼容 only. */
  baseUrl: string;
  /** Per-agent system prompt override (llm.systemPrompt, Wave-3b). */
  systemPrompt: string;
  /** Advanced: extra provider params as JSON text (optional, validated). */
  paramsJson: string;
  advancedOpen: boolean;
}

export interface AgentWizardState {
  step: WizardStep;
  name: string;
  capabilities: string[];
  boundDeviceIds: string[];
  managedZoneIds: string[];
  /**
   * False while zones still auto-derive from the bound devices' zones; any
   * manual zone toggle freezes the list (creation starts un-customized, edit
   * starts customized so the saved value is never silently re-derived).
   */
  zonesCustomized: boolean;
  llm: LlmFormState;
  /** T-051: per-agent autonomous-decision policy (tri-state per field). */
  policy: {
    autoActuateIndependent: PolicyTriState;
    autoInitiateAC: PolicyTriState;
  };
}

export type AgentWizardAction =
  | { type: 'setName'; name: string }
  | { type: 'addCapability'; capability: string }
  | { type: 'removeCapability'; capability: string }
  | { type: 'toggleDevice'; deviceId: string }
  | { type: 'toggleZone'; zoneId: string }
  | { type: 'setLlmKind'; kind: LlmKind }
  | { type: 'setLlmModel'; model: string }
  | { type: 'setLlmBaseUrl'; baseUrl: string }
  | { type: 'setLlmSystemPrompt'; systemPrompt: string }
  | { type: 'setLlmParamsJson'; paramsJson: string }
  | { type: 'toggleAdvanced' }
  | { type: 'setPolicy'; field: 'autoActuateIndependent' | 'autoInitiateAC'; value: PolicyTriState }
  | { type: 'goToStep'; step: WizardStep };

/** Environment context the reducer needs (which zone each device sits in). */
export interface WizardEnv {
  devices: ReadonlyArray<Pick<WorldDevice, 'id' | 'zoneId'>>;
}

export function createWizardState(): AgentWizardState {
  return {
    step: 0,
    name: '',
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    zonesCustomized: false,
    llm: { kind: 'none', model: '', baseUrl: '', systemPrompt: '', paramsJson: '', advancedOpen: false },
    policy: { autoActuateIndependent: 'unset', autoInitiateAC: 'unset' },
  };
}

/** Prefill the wizard from an existing agent (edit mode). */
export function wizardStateFromAgent(agent: WorldAgent): AgentWizardState {
  // ScenarioAgentLLM adds the systemPrompt patch over the contract's AgentLlm.
  const llm = agent.llm as ScenarioAgentLLM | null;
  const kind: LlmKind = llm === null ? 'none' : 'openai';
  const baseUrl =
    typeof llm?.params?.baseURL === 'string' ? (llm.params.baseURL as string) : '';
  const extraParams =
    llm?.params
      ? Object.fromEntries(Object.entries(llm.params).filter(([key]) => key !== 'baseURL'))
      : undefined;
  return {
    step: 0,
    name: agent.name,
    capabilities: [...agent.capabilities],
    boundDeviceIds: [...agent.boundDeviceIds],
    managedZoneIds: [...agent.managedZoneIds],
    zonesCustomized: true,
    llm: {
      kind,
      model: llm?.model ?? '',
      baseUrl,
      systemPrompt: llm?.systemPrompt ?? '',
      paramsJson:
        extraParams && Object.keys(extraParams).length > 0
          ? JSON.stringify(extraParams, null, 2)
          : '',
      advancedOpen: false,
    },
    policy: {
      autoActuateIndependent: policyOf(agent.decisionPolicy?.autoActuateIndependent),
      autoInitiateAC: policyOf(agent.decisionPolicy?.autoInitiateAC),
    },
  };
}

/** T-051: boolean → tri-state (undefined stays unset = runtime default). */
function policyOf(value: boolean | undefined): PolicyTriState {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unset';
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter(existing => existing !== id) : [...list, id];
}

/** Default 管理区域: the distinct zones of the bound devices (order kept). */
export function defaultManagedZones(
  boundDeviceIds: readonly string[],
  env: WizardEnv,
): string[] {
  const zones: string[] = [];
  for (const id of boundDeviceIds) {
    const zoneId = env.devices.find(device => device.id === id)?.zoneId;
    if (zoneId !== undefined && !zones.includes(zoneId)) zones.push(zoneId);
  }
  return zones;
}

export function reduceWizard(
  state: AgentWizardState,
  action: AgentWizardAction,
  env: WizardEnv,
): AgentWizardState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'addCapability': {
      const capability = action.capability.trim();
      if (capability.length === 0 || state.capabilities.includes(capability)) return state;
      return { ...state, capabilities: [...state.capabilities, capability] };
    }
    case 'removeCapability':
      return {
        ...state,
        capabilities: state.capabilities.filter(existing => existing !== action.capability),
      };
    case 'toggleDevice': {
      const boundDeviceIds = toggle(state.boundDeviceIds, action.deviceId);
      return {
        ...state,
        boundDeviceIds,
        ...(state.zonesCustomized
          ? {}
          : { managedZoneIds: defaultManagedZones(boundDeviceIds, env) }),
      };
    }
    case 'toggleZone':
      return { ...state, managedZoneIds: toggle(state.managedZoneIds, action.zoneId), zonesCustomized: true };
    case 'setLlmKind':
      return { ...state, llm: { ...state.llm, kind: action.kind } };
    case 'setLlmModel':
      return { ...state, llm: { ...state.llm, model: action.model } };
    case 'setLlmBaseUrl':
      return { ...state, llm: { ...state.llm, baseUrl: action.baseUrl } };
    case 'setLlmSystemPrompt':
      return { ...state, llm: { ...state.llm, systemPrompt: action.systemPrompt } };
    case 'setLlmParamsJson':
      return { ...state, llm: { ...state.llm, paramsJson: action.paramsJson } };
    case 'toggleAdvanced':
      return { ...state, llm: { ...state.llm, advancedOpen: !state.llm.advancedOpen } };
    case 'setPolicy':
      return { ...state, policy: { ...state.policy, [action.field]: action.value } };
    case 'goToStep':
      return { ...state, step: action.step };
  }
}

// ---------------------------------------------------------------------------
// Vocabulary + validation
// ---------------------------------------------------------------------------

/**
 * Capability vocabulary for suggestion chips: union of the env's device
 * capabilities, the semantic types already offered as services, and the
 * hardware catalog's capabilities (fetched client-side by the form).
 */
export function capabilityVocabulary(input: {
  devices: ReadonlyArray<Pick<WorldDevice, 'capabilities'>>;
  services: ReadonlyArray<{ semanticType: string }>;
  catalogCapabilities?: readonly string[];
}): string[] {
  const all = new Set<string>();
  for (const device of input.devices) {
    for (const capability of device.capabilities) all.add(capability);
  }
  for (const service of input.services) all.add(service.semanticType);
  for (const capability of input.catalogCapabilities ?? []) all.add(capability);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/**
 * R75/F1: devices the viewer may bind — own devices; the env owner may bind
 * any device (mirrors canBindDevice, batched for the backing checks).
 */
export function bindableDevices(
  devices: ReadonlyArray<Pick<WorldDevice, 'id' | 'owner' | 'capabilities'>>,
  viewerId: string,
  isEnvOwner: boolean,
): Array<Pick<WorldDevice, 'id' | 'owner' | 'capabilities'>> {
  return devices.filter(device => canBindDevice(device, viewerId, isEnvOwner));
}

/**
 * R75/F1: capabilities NOT provided by any of `devices` (same containment
 * matcher as the flow wizard — a light approximation of the server's
 * capabilityMatches; synonym-only edge cases fall through to the loud
 * rejection teaching, never a silent one).
 */
export function unbackedCapabilities(
  capabilities: readonly string[],
  devices: ReadonlyArray<Pick<WorldDevice, 'capabilities'>>,
): string[] {
  return capabilities.filter(
    capability => !devices.some(device => deviceProvides(device.capabilities, capability)),
  );
}

/**
 * R75/F1: split the suggestion vocabulary by whether ANY bindable device
 * provides the capability — the wizard renders the backed chips normally and
 * the unbacked ones with a warning marker, so a builder never discovers the
 * rule through a rejected proposal (the R71 F1 failure mode: 11/11 silently
 * rejected because brightness-control/crowd-monitoring looked selectable).
 */
export function splitVocabularyByBacking(
  vocabulary: readonly string[],
  devices: ReadonlyArray<Pick<WorldDevice, 'capabilities'>>,
): { backed: string[]; unbacked: string[] } {
  const backed: string[] = [];
  const unbacked: string[] = [];
  for (const capability of vocabulary) {
    (devices.some(device => deviceProvides(device.capabilities, capability))
      ? backed
      : unbacked
    ).push(capability);
  }
  return { backed, unbacked };
}

/** May this viewer bind the device to an agent? Own devices; env owner: any. */
export function canBindDevice(
  device: Pick<WorldDevice, 'owner'>,
  viewerId: string,
  isEnvOwner: boolean,
): boolean {
  return device.owner.id === viewerId || isEnvOwner;
}

export interface WizardValidationCtx extends WizardEnv {
  devices: ReadonlyArray<Pick<WorldDevice, 'id' | 'zoneId' | 'owner' | 'capabilities'>>;
  viewerId: string;
  isEnvOwner: boolean;
}

/** Parse the advanced params JSON: empty is fine; otherwise a plain object. */
export function parseParamsJson(
  json: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (json.trim().length === 0) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function llmStepError(state: AgentWizardState): string | null {
  const t = i18n.getFixedT(i18n.language, 'agentWizardLib');
  const { llm } = state;
  if (llm.kind === 'none') return null;
  if (llm.model.trim().length === 0) return t('stepError.llmModelRequired');
  if (!parseParamsJson(llm.paramsJson).ok) return t('stepError.llmParamsJson');
  return null;
}

/** Inline validation for one step; null when the step may advance. */
export function stepError(
  state: AgentWizardState,
  step: WizardStep,
  ctx: WizardValidationCtx,
): string | null {
  const t = i18n.getFixedT(i18n.language, 'agentWizardLib');
  if (step === 0) {
    if (state.name.trim().length === 0) return t('stepError.nameRequired');
    if (state.capabilities.length === 0) return t('stepError.capabilityRequired');
    // R75/F1: a capability NO bindable device provides can never survive the
    // server's T-206 backing rule — stop it here with teaching, not a silent
    // proposal rejection (the R71 F1 failure mode).
    const bindable = bindableDevices(ctx.devices, ctx.viewerId, ctx.isEnvOwner);
    const unfixable = unbackedCapabilities(state.capabilities, bindable);
    if (unfixable.length > 0) {
      return t('stepError.capabilityUnfixable', {
        capabilities: unfixable.map(cap => `"${cap}"`).join(', '),
      });
    }
    return null;
  }
  if (step === 1) {
    for (const id of state.boundDeviceIds) {
      const device = ctx.devices.find(d => d.id === id);
      if (!device) return t('stepError.deviceMissing');
      if (!canBindDevice(device, ctx.viewerId, ctx.isEnvOwner)) {
        return t('stepError.deviceForbidden');
      }
    }
    // R75/F1: the server's install-agents rule check requires every declared
    // capability to be provided by a BOUND device (an agent with no devices
    // may declare none). Gate the same rule client-side so the proposal
    // never ships into a rejection the user can't see.
    const bound = ctx.devices.filter(d => state.boundDeviceIds.includes(d.id));
    const unbacked = unbackedCapabilities(state.capabilities, bound);
    if (unbacked.length > 0) {
      return t('stepError.capabilityUnbacked', {
        capabilities: unbacked.map(cap => `"${cap}"`).join(', '),
        provided:
          [...new Set(bound.flatMap(d => d.capabilities))].sort().join(', ') ||
          t('capabilityNothing'),
      });
    }
    return null;
  }
  if (step === 2) return null;
  return llmStepError(state);
}

/** First failing step's error (submit gate), or null when ready. */
export function wizardError(state: AgentWizardState, ctx: WizardValidationCtx): string | null {
  for (const step of [0, 1, 2, 3] as const) {
    const error = stepError(state, step, ctx);
    if (error !== null) return error;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Build the llm object matching the scenario schema
 * (`{provider, model, params?}`); null for 无(规则). Assumes validation passed.
 */
export function buildLlm(state: AgentWizardState): ScenarioAgentLLM | null {
  const { llm } = state;
  if (llm.kind === 'none') return null;
  const extra = parseParamsJson(llm.paramsJson);
  const extraParams = extra.ok ? extra.value : undefined;
  const systemPrompt = llm.systemPrompt.trim();
  const promptField = systemPrompt !== '' ? { systemPrompt } : {};
  // baseURL is optional — empty means "use the server's LLM_BASE_URL".
  const baseUrl = llm.baseUrl.trim();
  const params = { ...(baseUrl !== '' ? { baseURL: baseUrl } : {}), ...extraParams };
  return {
    provider: 'openai-compatible',
    model: llm.model.trim(),
    ...promptField,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/**
 * T-051: build the decisionPolicy payload — an explicit boolean per
 * tri-state field; null when both are unset (clears to the runtime-wide
 * defaults; a sim-level option still overrides whatever is stored).
 */
export function buildDecisionPolicy(state: AgentWizardState): Record<string, boolean> | null {
  const policy: Record<string, boolean> = {};
  if (state.policy.autoActuateIndependent !== 'unset') {
    policy.autoActuateIndependent = state.policy.autoActuateIndependent === 'on';
  }
  if (state.policy.autoInitiateAC !== 'unset') {
    policy.autoInitiateAC = state.policy.autoInitiateAC === 'on';
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

/** POST body for creation (llm omitted when 无(规则)). */
export function buildCreatePayload(state: AgentWizardState): {
  name: string;
  capabilities: string[];
  boundDeviceIds: string[];
  managedZoneIds: string[];
  llm?: ScenarioAgentLLM;
  decisionPolicy?: Record<string, boolean>;
} {
  const llm = buildLlm(state);
  const decisionPolicy = buildDecisionPolicy(state);
  return {
    name: state.name.trim(),
    capabilities: state.capabilities,
    boundDeviceIds: state.boundDeviceIds,
    managedZoneIds: state.managedZoneIds,
    ...(llm !== null ? { llm } : {}),
    ...(decisionPolicy !== null ? { decisionPolicy } : {}),
  };
}

/** PATCH body for editing (llm: null clears the agent's llm server-side). */
export function buildPatchPayload(state: AgentWizardState): PatchAgentInput {
  return {
    name: state.name.trim(),
    capabilities: state.capabilities,
    boundDeviceIds: state.boundDeviceIds,
    managedZoneIds: state.managedZoneIds,
    llm: buildLlm(state),
    // T-051: same full-state save semantics as llm — null clears the policy.
    decisionPolicy: buildDecisionPolicy(state),
  };
}

// ---------------------------------------------------------------------------
// Agent tab grouping
// ---------------------------------------------------------------------------

export interface AgentOwnerGroup {
  owner: OwnerRef;
  agents: WorldAgent[];
}

/**
 * Group the Agent tab list by owner: the viewer's own agents first (one user
 * typically runs several), then everyone else's grouped by owner.
 */
export function groupAgentsByOwner(
  agents: readonly WorldAgent[],
  viewerId: string | null,
): { mine: WorldAgent[]; others: AgentOwnerGroup[] } {
  const mine: WorldAgent[] = [];
  const others = new Map<string, AgentOwnerGroup>();
  for (const agent of agents) {
    if (viewerId !== null && agent.owner.id === viewerId) {
      mine.push(agent);
      continue;
    }
    const group = others.get(agent.owner.id);
    if (group) group.agents.push(agent);
    else others.set(agent.owner.id, { owner: agent.owner, agents: [agent] });
  }
  return { mine, others: [...others.values()] };
}
