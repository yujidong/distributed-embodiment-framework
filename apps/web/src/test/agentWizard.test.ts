/**
 * Agent wizard tests (W6):
 * - step validation (name + ≥1 capability; llm per provider; params JSON);
 * - device binding rules, incl. the env-owner override and the 管理区域
 *   default derivation freezing once zones are touched;
 * - the llm object builder (none / openai-compatible, the sole backend);
 * - payload builders (create omits llm; patch sends llm: null to clear);
 * - Agent-tab owner grouping (mine first).
 */

import { describe, expect, it, beforeAll } from 'vitest';

import type { ScenarioAgentLLM, WorldAgent, WorldDevice } from '../api/types';
import i18n from '../i18n/config';
import {
  buildCreatePayload,
  buildDecisionPolicy,
  buildLlm,
  buildPatchPayload,
  canBindDevice,
  capabilityVocabulary,
  createWizardState,
  defaultManagedZones,
  groupAgentsByOwner,
  parseParamsJson,
  reduceWizard,
  stepError,
  wizardError,
  wizardStateFromAgent,
  type AgentWizardAction,
  type AgentWizardState,
  type WizardValidationCtx,
} from '../lib/agentWizard';

// lib/agentWizard reads the active i18next bundle at call time; pin to en-US
// so the assertions can be exact English strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

const ME = 'user-a';

function makeDevice(id: string, ownerId: string, zoneId = 'zone-1'): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name: `设备${id}`,
    type: 'meter',
    brand: null,
    capabilities: ['energy-monitoring'],
    zoneId,
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: ownerId, displayName: ownerId === ME ? '我' : '小B' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeAgent(id: string, ownerId: string, overrides: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id,
    envId: 'env-1',
    name: `Agent${id}`,
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: ownerId, displayName: ownerId === ME ? '我' : '小B' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function ctx(overrides: Partial<WizardValidationCtx> = {}): WizardValidationCtx {
  return {
    devices: [makeDevice('d1', ME, 'zone-1'), makeDevice('d2', 'user-b', 'zone-2')],
    viewerId: ME,
    isEnvOwner: false,
    ...overrides,
  };
}

function reduce(
  state: AgentWizardState,
  action: AgentWizardAction,
  devices = ctx().devices,
): AgentWizardState {
  return reduceWizard(state, action, { devices });
}

describe('step validation', () => {
  it('requires a name and at least one capability on step 0', () => {
    const empty = createWizardState();
    expect(stepError(empty, 0, ctx())).toBe('Please fill in the name.');

    const named = reduce(empty, { type: 'setName', name: '  管家  ' });
    expect(stepError(named, 0, ctx())).toBe('Add at least 1 capability.');

    const ready = reduce(named, { type: 'addCapability', capability: 'energy-monitoring' });
    expect(stepError(ready, 0, ctx())).toBeNull();
    // R75/F1: a capability with no bound device can no longer pass the whole
    // form (the server's T-206 backing rule rejects such proposals — the R71
    // silent-rejection failure mode). Bind the covering device → valid.
    expect(wizardError(ready, ctx())).toContain('not provided by the bound devices');
    const bound = reduce(ready, { type: 'toggleDevice', deviceId: 'd1' });
    expect(wizardError(bound, ctx())).toBeNull();
  });

  it('R75/F1: the llm kind defaults to none — the wizard never dead-ends a new user on step 4', () => {
    expect(createWizardState().llm.kind).toBe('none');
  });

  it('R75/F1: step 0 rejects a capability no bindable device provides, with teaching', () => {
    // d2 (foreign) provides hvac-control — a builder cannot bind it, so the
    // capability is unfixable for them; the env owner CAN bind any device.
    const devices = [
      makeDevice('d1', ME, 'zone-1'),
      { ...makeDevice('d2', 'user-b', 'zone-2'), capabilities: ['hvac-control'] },
    ];
    let state = reduce(createWizardState(), { type: 'setName', name: '管家' });
    state = reduce(state, { type: 'addCapability', capability: 'hvac-control' });
    expect(stepError(state, 0, ctx({ devices }))).toContain(
      'No device you can bind provides "hvac-control"',
    );
    expect(stepError(state, 0, ctx({ devices, isEnvOwner: true }))).toBeNull();
    // A capability NOTHING in the env provides fails for the owner too.
    let stray = reduce(createWizardState(), { type: 'setName', name: '管家' });
    stray = reduce(stray, { type: 'addCapability', capability: 'crowd-monitoring' });
    expect(stepError(stray, 0, ctx({ isEnvOwner: true }))).toContain(
      'No device you can bind provides "crowd-monitoring"',
    );
  });

  it('R75/F1: step 1 demands the bound devices cover every declared capability', () => {
    let state = reduce(createWizardState(), { type: 'setName', name: '管家' });
    state = reduce(state, { type: 'addCapability', capability: 'hvac-control' });
    // No devices bound at all → unbacked.
    expect(stepError(state, 1, ctx())).toContain('"hvac-control" is not provided');
    // Bind a device with a DIFFERENT capability → still unbacked, and the
    // error teaches what the bound devices do provide.
    state = reduce(state, { type: 'toggleDevice', deviceId: 'd1' });
    const error = stepError(state, 1, ctx());
    expect(error).toContain('"hvac-control" is not provided');
    expect(error).toContain('they provide: energy-monitoring');
  });

  it('trims and dedupes capabilities', () => {
    let state = createWizardState();
    state = reduce(state, { type: 'addCapability', capability: '  hvac-control ' });
    state = reduce(state, { type: 'addCapability', capability: 'hvac-control' });
    state = reduce(state, { type: 'addCapability', capability: '   ' });
    expect(state.capabilities).toEqual(['hvac-control']);
    state = reduce(state, { type: 'removeCapability', capability: 'hvac-control' });
    expect(state.capabilities).toEqual([]);
  });
});

describe('device binding rules', () => {
  it('allows own devices; forbids others for a plain builder', () => {
    expect(canBindDevice(makeDevice('d1', ME), ME, false)).toBe(true);
    expect(canBindDevice(makeDevice('d2', 'user-b'), ME, false)).toBe(false);
  });

  it('env-owner override: any device may be bound', () => {
    expect(canBindDevice(makeDevice('d2', 'user-b'), ME, true)).toBe(true);
  });

  it('step 1 rejects a bound foreign device for builders, allows it for the env owner', () => {
    const state = reduce(createWizardState(), { type: 'toggleDevice', deviceId: 'd2' });
    expect(stepError(state, 1, ctx())).toBe(
      'You can only bind your own devices (the environment owner may bind any device).',
    );
    expect(stepError(state, 1, ctx({ isEnvOwner: true }))).toBeNull();
  });

  it('rejects bindings to devices no longer in the env', () => {
    const state = reduce(createWizardState(), { type: 'toggleDevice', deviceId: 'ghost' });
    expect(stepError(state, 1, ctx())).toBe('A bound device no longer exists — please reselect.');
  });

  it('derives 管理区域 from bound devices until zones are touched manually', () => {
    let state = createWizardState();
    state = reduce(state, { type: 'toggleDevice', deviceId: 'd1' });
    expect(state.managedZoneIds).toEqual(['zone-1']);
    state = reduce(state, { type: 'toggleDevice', deviceId: 'd2' });
    expect(state.managedZoneIds).toEqual(['zone-1', 'zone-2']);

    // Manual edit freezes the derivation.
    state = reduce(state, { type: 'toggleZone', zoneId: 'zone-2' });
    expect(state.zonesCustomized).toBe(true);
    expect(state.managedZoneIds).toEqual(['zone-1']);
    state = reduce(state, { type: 'toggleDevice', deviceId: 'd2' });
    expect(state.managedZoneIds).toEqual(['zone-1']);
  });

  it('defaultManagedZones dedupes zones in binding order', () => {
    const devices = [
      makeDevice('d1', ME, 'zone-1'),
      makeDevice('d2', ME, 'zone-1'),
      makeDevice('d3', ME, 'zone-2'),
    ];
    expect(defaultManagedZones(['d1', 'd2', 'd3'], { devices })).toEqual(['zone-1', 'zone-2']);
  });
});

describe('llm builder', () => {
  function llmState(actions: AgentWizardAction[]): AgentWizardState {
    return actions.reduce((state, action) => reduce(state, action), createWizardState());
  }

  it('无(规则) builds no llm object', () => {
    expect(buildLlm(createWizardState())).toBeNull();
  });

  it('the llm kind requires a model; baseURL is optional (server default)', () => {
    const noModel = llmState([
      { type: 'setLlmKind', kind: 'openai' },
      { type: 'setLlmModel', model: ' ' },
    ]);
    expect(stepError(noModel, 3, ctx())).toBe('Please fill in the model name.');

    const withParams = llmState([
      { type: 'setLlmKind', kind: 'openai' },
      { type: 'setLlmModel', model: 'qwen3:8b' },
      { type: 'setLlmParamsJson', paramsJson: '{"num_ctx": 8192}' },
    ]);
    expect(stepError(withParams, 3, ctx())).toBeNull();
    expect(buildLlm(withParams)).toEqual({
      provider: 'openai-compatible',
      model: 'qwen3:8b',
      params: { num_ctx: 8192 },
    });

    const noUrl = llmState([
      { type: 'setLlmKind', kind: 'openai' },
      { type: 'setLlmModel', model: 'gpt-x' },
    ]);
    expect(stepError(noUrl, 3, ctx())).toBeNull();
    expect(buildLlm(noUrl)).toEqual({ provider: 'openai-compatible', model: 'gpt-x' });

    const ready = llmState([
      { type: 'setLlmKind', kind: 'openai' },
      { type: 'setLlmModel', model: ' gpt-x ' },
      { type: 'setLlmBaseUrl', baseUrl: ' https://api.example.com/v1 ' },
      { type: 'setLlmParamsJson', paramsJson: '{"temperature": 0.2}' },
    ]);
    expect(stepError(ready, 3, ctx())).toBeNull();
    expect(buildLlm(ready)).toEqual({
      provider: 'openai-compatible',
      model: 'gpt-x',
      params: { baseURL: 'https://api.example.com/v1', temperature: 0.2 },
    });
  });

  it('rejects invalid advanced params JSON', () => {
    const bad = llmState([
      { type: 'setLlmKind', kind: 'openai' },
      { type: 'setLlmModel', model: 'qwen3:8b' },
      { type: 'setLlmParamsJson', paramsJson: '{not json' },
    ]);
    expect(stepError(bad, 3, ctx())).toBe('Advanced parameters must be a valid JSON object.');
    expect(parseParamsJson('[1,2]').ok).toBe(false);
    expect(parseParamsJson('').ok).toBe(true);
  });
});

describe('payload builders + prefill', () => {
  it('create payload omits llm when 无(规则); patch sends llm: null', () => {
    let state = createWizardState();
    state = reduce(state, { type: 'setName', name: ' 管家 ' });
    state = reduce(state, { type: 'addCapability', capability: 'hvac-control' });
    state = reduce(state, { type: 'toggleDevice', deviceId: 'd1' });

    expect(buildCreatePayload(state)).toEqual({
      name: '管家',
      capabilities: ['hvac-control'],
      boundDeviceIds: ['d1'],
      managedZoneIds: ['zone-1'],
    });
    expect(buildPatchPayload(state)).toEqual({
      name: '管家',
      capabilities: ['hvac-control'],
      boundDeviceIds: ['d1'],
      managedZoneIds: ['zone-1'],
      llm: null,
      decisionPolicy: null,
    });
  });

  it('T-051: decision policy round-trips through prefill and both payload builders', () => {
    // Unset both → omitted from create, null (clear) in patch.
    let state = createWizardState();
    state = reduce(state, { type: 'setPolicy', field: 'autoActuateIndependent', value: 'off' });
    expect(buildDecisionPolicy(state)).toEqual({ autoActuateIndependent: false });
    expect(buildCreatePayload(state).decisionPolicy).toEqual({ autoActuateIndependent: false });
    expect(buildPatchPayload(state).decisionPolicy).toEqual({ autoActuateIndependent: false });

    // Unset again → cleared.
    state = reduce(state, { type: 'setPolicy', field: 'autoActuateIndependent', value: 'unset' });
    expect(buildDecisionPolicy(state)).toBeNull();

    // Edit prefill: an explicit stored policy maps to on/off tri-states.
    const agent = makeAgent('a1', ME, {
      decisionPolicy: { autoActuateIndependent: false, autoInitiateAC: true },
    });
    const prefilled = wizardStateFromAgent(agent);
    expect(prefilled.policy).toEqual({ autoActuateIndependent: 'off', autoInitiateAC: 'on' });
    expect(buildPatchPayload(prefilled).decisionPolicy).toEqual({
      autoActuateIndependent: false,
      autoInitiateAC: true,
    });

    // Absent policy fields stay unset (runtime default).
    expect(wizardStateFromAgent(makeAgent('a2', ME)).policy).toEqual({
      autoActuateIndependent: 'unset',
      autoInitiateAC: 'unset',
    });
  });

  it('wizardStateFromAgent prefills an openai-compatible agent round-trip', () => {
    const agent = makeAgent('a1', ME, {
      name: '能效管家',
      capabilities: ['energy-monitoring'],
      boundDeviceIds: ['d1'],
      managedZoneIds: ['zone-1'],
      llm: { provider: 'openai-compatible', model: 'qwen3:8b', params: { num_ctx: 8192 } },
    });
    const state = wizardStateFromAgent(agent);
    expect(state.zonesCustomized).toBe(true);
    expect(buildPatchPayload(state)).toEqual({
      name: '能效管家',
      capabilities: ['energy-monitoring'],
      boundDeviceIds: ['d1'],
      managedZoneIds: ['zone-1'],
      llm: { provider: 'openai-compatible', model: 'qwen3:8b', params: { num_ctx: 8192 } },
      decisionPolicy: null,
    });
  });

  it('wizardStateFromAgent splits baseURL out of openai-compatible params', () => {
    const agent = makeAgent('a1', ME, {
      llm: {
        provider: 'openai-compatible',
        model: 'gpt-x',
        params: { baseURL: 'https://x', temperature: 0.5 },
      },
    });
    const state = wizardStateFromAgent(agent);
    expect(state.llm.kind).toBe('openai');
    expect(state.llm.baseUrl).toBe('https://x');
    expect(state.llm.paramsJson).toBe(JSON.stringify({ temperature: 0.5 }, null, 2));
    expect(buildLlm(state)).toEqual(agent.llm);
  });

  it('an untouched edited agent does not re-derive zones on device toggle', () => {
    const agent = makeAgent('a1', ME, { managedZoneIds: ['zone-9'] });
    const state = reduce(wizardStateFromAgent(agent), { type: 'toggleDevice', deviceId: 'd1' });
    expect(state.managedZoneIds).toEqual(['zone-9']);
  });

  it('systemPrompt round-trips through prefill and buildLlm', () => {
    const agent = makeAgent('a1', ME, {
      llm: { provider: 'openai-compatible', model: 'qwen3:8b', systemPrompt: '你是节能专员。' } as ScenarioAgentLLM,
    });
    const state = wizardStateFromAgent(agent);
    expect(state.llm.systemPrompt).toBe('你是节能专员。');
    expect(buildLlm(state)).toEqual(agent.llm);

    // Blank/whitespace prompts are omitted from the payload.
    const blank = reduce(state, { type: 'setLlmSystemPrompt', systemPrompt: '  ' });
    expect(buildLlm(blank)).toEqual({ provider: 'openai-compatible', model: 'qwen3:8b' });
  });
});

describe('capability vocabulary + owner grouping', () => {
  it('unions devices, services and catalog, sorted and deduped', () => {
    const vocab = capabilityVocabulary({
      devices: [
        { capabilities: ['b-type', 'a-type'] },
        { capabilities: ['a-type'] },
      ],
      services: [{ semanticType: 'c-type' }, { semanticType: 'a-type' }],
      catalogCapabilities: ['d-type', 'b-type'],
    });
    expect(vocab).toEqual(['a-type', 'b-type', 'c-type', 'd-type']);
  });

  it('groups agents by owner with mine first', () => {
    const agents = [
      makeAgent('a1', 'user-b'),
      makeAgent('a2', ME),
      makeAgent('a3', 'user-c'),
      makeAgent('a4', 'user-b'),
      makeAgent('a5', ME),
    ];
    const { mine, others } = groupAgentsByOwner(agents, ME);
    expect(mine.map(a => a.id)).toEqual(['a2', 'a5']);
    expect(others.map(group => group.owner.id)).toEqual(['user-b', 'user-c']);
    expect(others[0].agents.map(a => a.id)).toEqual(['a1', 'a4']);
  });

  it('anonymous viewer: everything lands in others', () => {
    const { mine, others } = groupAgentsByOwner([makeAgent('a1', 'user-b')], null);
    expect(mine).toEqual([]);
    expect(others).toHaveLength(1);
  });
});
