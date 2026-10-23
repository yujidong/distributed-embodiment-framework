/**
 * Deployment-center (P3b) lib tests — the pure logic behind the 部署 tab's
 * HA sections and the global E-stop banner:
 *
 * - commandFeedback: a gate-parked command toasts 已提交审批 (#id) — a
 *   soft-block, NOT an error; success → 已执行; failure → the server error.
 * - binding helpers: hass:// URI building, binding-kind classification, the
 *   hass-bound device set, entity-domain derivation, and q+domain filtering.
 * - policy form validation: empty/whitespace patterns rejected; exact, '*',
 *   and prefix-wildcard ('light.*') syntaxes accepted.
 * - estopBannerModel: inactive/unknown → hidden; active → visible with the
 *   operator (未知 fallback).
 * - plus small extras (scope labels, audit tones, running-sim filter, params
 *   JSON parsing).
 */

import { describe, expect, it, beforeAll } from 'vitest';

import type { HassEntitySummary, HassPolicy, WorldDevice } from '../api/types';
import i18n from '../i18n/config';
import {
  AUDIT_DECISION_LABEL,
  auditDecisionLabel,
  auditDecisionTone,
  bindingKind,
  commandFeedback,
  compactJson,
  entityDomains,
  estopBannerModel,
  filterHassEntities,
  hassBindingUri,
  hassBoundDevices,
  parseParamsJson,
  policyPatternError,
  policyScopeLabel,
  runningSimulationsOf,
} from '../lib/hass';

// lib/hass reads the active i18next bundle at call time; pin to en-US so the
// assertions can be exact English strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function makeDevice(overrides: Partial<WorldDevice> = {}): WorldDevice {
  return {
    id: 'dev-1',
    envId: 'env-1',
    name: '客厅灯',
    type: 'light',
    brand: null,
    capabilities: ['lighting-control'],
    zoneId: 'zone-a',
    position: null,
    initialState: null,
    binding: 'sim://dev-1',
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeEntity(overrides: Partial<HassEntitySummary> = {}): HassEntitySummary {
  return {
    entityId: 'light.living_room',
    domain: 'light',
    friendlyName: 'Living Room Light',
    state: 'off',
    capabilities: ['lighting-control'],
    suggestedCapabilities: ['lighting-control', 'turn-on', 'turn-off'],
    ...overrides,
  };
}

function makePolicy(overrides: Partial<HassPolicy> = {}): HassPolicy {
  return {
    id: 'pol-1',
    envId: null,
    entityPattern: '*',
    effect: 'confirm',
    createdBy: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('commandFeedback', () => {
  it('treats a gate-parked command as an approval notice, not an error', () => {
    const feedback = commandFeedback({ success: false, pending: true, pendingId: 'p-42' });
    expect(feedback).toEqual({ kind: 'pending', text: 'Submitted for approval (#p-42)' });
  });

  it('omits the id suffix when the server sent none', () => {
    expect(commandFeedback({ success: false, pending: true }).text).toBe('Submitted for approval');
  });

  it('reports plain success as Executed', () => {
    expect(commandFeedback({ success: true, result: { on: true } })).toEqual({
      kind: 'ok',
      text: 'Executed',
    });
  });

  it('surfaces the server error message (and a fallback) on failure', () => {
    expect(commandFeedback({ success: false, error: 'device offline' })).toEqual({
      kind: 'error',
      text: 'device offline',
    });
    expect(commandFeedback({ success: false }).text).toBe('Command execution failed');
  });
});

describe('binding helpers', () => {
  it('builds the hass:// binding URI for an entity', () => {
    expect(hassBindingUri('light.living_room')).toBe('hass://light.living_room');
  });

  it('classifies bindings by scheme', () => {
    expect(bindingKind('sim://dev-1')).toBe('sim');
    expect(bindingKind('hass://light.living_room')).toBe('hass');
    expect(bindingKind('mqtt://odd')).toBe('other');
  });

  it('collects only the hass://-bound devices for the 指令测试 picker', () => {
    const devices = [
      makeDevice({ id: 'd1', binding: 'sim://d1' }),
      makeDevice({ id: 'd2', binding: 'hass://light.living_room' }),
      makeDevice({ id: 'd3', binding: 'hass://climate.bedroom' }),
    ];
    expect(hassBoundDevices(devices).map(device => device.id)).toEqual(['d2', 'd3']);
  });
});

describe('entity picker derivation', () => {
  const ENTITIES = [
    makeEntity({ entityId: 'light.living_room', domain: 'light', friendlyName: 'Living Room' }),
    makeEntity({ entityId: 'light.bedroom', domain: 'light', friendlyName: '卧室灯' }),
    makeEntity({ entityId: 'climate.bedroom', domain: 'climate', friendlyName: 'Bedroom AC' }),
    makeEntity({ entityId: 'switch.kettle', domain: 'switch', friendlyName: 'Kettle' }),
  ];

  it('derives the sorted distinct domain list', () => {
    expect(entityDomains(ENTITIES)).toEqual(['climate', 'light', 'switch']);
    expect(entityDomains([])).toEqual([]);
  });

  it('matches q against entity id and friendly name, case-insensitively', () => {
    expect(filterHassEntities(ENTITIES, { q: 'LIVING' }).map(e => e.entityId)).toEqual([
      'light.living_room',
    ]);
    expect(filterHassEntities(ENTITIES, { q: '卧室' }).map(e => e.entityId)).toEqual([
      'light.bedroom',
    ]);
    // Blank/whitespace q matches everything.
    expect(filterHassEntities(ENTITIES, { q: '  ' })).toHaveLength(4);
  });

  it('combines the domain filter with q', () => {
    expect(
      filterHassEntities(ENTITIES, { domain: 'light', q: 'bedroom' }).map(e => e.entityId),
    ).toEqual(['light.bedroom']);
    expect(filterHassEntities(ENTITIES, { domain: 'climate' }).map(e => e.entityId)).toEqual([
      'climate.bedroom',
    ]);
    expect(filterHassEntities(ENTITIES, { domain: 'switch', q: 'bedroom' })).toEqual([]);
  });
});

describe('policyPatternError', () => {
  it('rejects empty and whitespace-only patterns', () => {
    expect(policyPatternError('')).toBe('Entity pattern cannot be empty');
    expect(policyPatternError('   ')).toBe('Entity pattern cannot be empty');
  });

  it('rejects patterns containing whitespace', () => {
    expect(policyPatternError('light. living_room')).toBe('Entity pattern cannot contain whitespace');
    expect(policyPatternError('light .*')).toBe('Entity pattern cannot contain whitespace');
  });

  it('accepts the exact, all, and prefix-wildcard syntaxes', () => {
    expect(policyPatternError('light.living_room')).toBeNull();
    expect(policyPatternError('*')).toBeNull();
    expect(policyPatternError('light.*')).toBeNull();
  });

  it('rejects other wildcard placements', () => {
    const hint =
      'Only an exact entity id, "*" (all), or a prefix wildcard (e.g. light.*) is supported';
    expect(policyPatternError('li*ht.living_room')).toBe(hint);
    expect(policyPatternError('*.living_room')).toBe(hint);
    expect(policyPatternError('.*')).toBe(hint);
    expect(policyPatternError('light.**')).toBe(hint);
  });
});

describe('policyScopeLabel', () => {
  it('labels global rows Global, own-env rows This environment, others by env id', () => {
    expect(policyScopeLabel(makePolicy({ envId: null }), 'env-1')).toBe('Global');
    expect(policyScopeLabel(makePolicy({ envId: 'env-1' }), 'env-1')).toBe('This environment');
    expect(policyScopeLabel(makePolicy({ envId: 'env-2' }), 'env-1')).toBe('env-2');
  });
});

describe('estopBannerModel', () => {
  it('stays hidden when the state is unknown or inactive', () => {
    expect(estopBannerModel(null)).toEqual({ visible: false, text: '' });
    expect(estopBannerModel({ active: false })).toEqual({ visible: false, text: '' });
  });

  it('shows the operator when the E-stop is engaged', () => {
    const model = estopBannerModel({ active: true, by: 'user-a', at: '2026-07-21T00:00:00Z' });
    expect(model.visible).toBe(true);
    expect(model.text).toBe(
      'Emergency stop active — all real-device commands are blocked (triggered by: user-a)',
    );
  });

  it('falls back to unknown when the operator is missing', () => {
    expect(estopBannerModel({ active: true }).text).toContain('(triggered by: unknown)');
  });
});

describe('audit decision display', () => {
  it('has a localized label and a badge tone for every decision', () => {
    // AUDIT_DECISION_LABEL is a live Proxy over i18n; assert each key via the
    // matching function and through the indexable record.
    const expected = {
      allowed: 'Executed',
      blocked: 'Blocked',
      pending: 'Pending approval',
      approved: 'Approved',
      rejected: 'Rejected',
      estopped: 'E-stop intercepted',
      'rate-limited': 'Rate-limited',
    } as const;
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      expect(auditDecisionLabel(key)).toBe(expected[key]);
      expect(AUDIT_DECISION_LABEL[key]).toBe(expected[key]);
    }
    expect(auditDecisionTone('allowed')).toBe('ok');
    expect(auditDecisionTone('approved')).toBe('ok');
    expect(auditDecisionTone('pending')).toBe('warn');
    expect(auditDecisionTone('rate-limited')).toBe('warn');
    expect(auditDecisionTone('blocked')).toBe('danger');
    expect(auditDecisionTone('rejected')).toBe('danger');
    expect(auditDecisionTone('estopped')).toBe('danger');
  });
});

describe('command-test helpers', () => {
  it('filters the sim list to the caller\'s running sims of this environment', () => {
    const sims = [
      { id: 's1', scenarioId: 'sc', environmentId: 'env-1', state: 'running' as const, simTimeSec: 0, llm: 'rule-only' as const },
      { id: 's2', scenarioId: 'sc', environmentId: 'env-1', state: 'paused' as const, simTimeSec: 0, llm: 'rule-only' as const },
      { id: 's3', scenarioId: 'sc', environmentId: 'env-2', state: 'running' as const, simTimeSec: 0, llm: 'rule-only' as const },
      { id: 's4', scenarioId: 'sc', state: 'running' as const, simTimeSec: 0, llm: 'rule-only' as const },
    ];
    expect(runningSimulationsOf(sims, 'env-1').map(sim => sim.id)).toEqual(['s1']);
  });

  it('parses the optional params JSON (blank → none; objects only)', () => {
    expect(parseParamsJson('')).toEqual({});
    expect(parseParamsJson('  ')).toEqual({});
    expect(parseParamsJson('{"brightness": 80}')).toEqual({ params: { brightness: 80 } });
    expect(parseParamsJson('[1, 2]').error).toBe('Params must be a JSON object');
    expect(parseParamsJson('42').error).toBe('Params must be a JSON object');
    expect(parseParamsJson('{oops').error).toBe('Params JSON could not be parsed');
  });

  it('compacts pending params JSON with truncation', () => {
    expect(compactJson({ on: true })).toBe('{"on":true}');
    const long = compactJson({ note: 'x'.repeat(100) }, 24);
    expect(long).toHaveLength(24);
    expect(long.endsWith('…')).toBe(true);
  });
});
