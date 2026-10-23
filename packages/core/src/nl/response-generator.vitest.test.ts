/**
 * NL response generator tests (cognitive architecture Phase 3).
 *
 * The core contract: responses render FROM the structured decision +
 * execution result — deterministic (same input, same output), and every
 * bridge honesty fact (rejections, clamps, escalation conditions) is
 * SPOKEN, never hidden.
 */

import { describe, expect, it } from 'vitest';

import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import {
  detectUserLocale,
  generateEmergencyResponse,
  generateHelpResponse,
  generateNLResponse,
  generateStatusResponse,
  renderTemplateNLResponse,
} from './response-generator.js';
import type { NLDeviceView, NLExecutionResult, NLZoneView } from './types.js';

function decision(overrides: Partial<CognitiveDecision> = {}): CognitiveDecision {
  return {
    situation: {
      type: 'anomaly',
      severity: 3,
      affectedZones: ['zone-a'],
      rootCauseHypothesis: 'HVAC failure',
      confidence: 0.85,
    },
    goals: [],
    actionPlan: {
      primary: {
        action: 'handle_independently',
        reasoning: 'actuate own hvac',
        deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } }],
      },
      escalationCondition: 'temperature exceeds 35C for more than 10 minutes',
    },
    explanation: { summary: 'Cooled the zone.', factors: [{ name: 'safety', weight: 0.8 }] },
    collaboration: { needed: false },
    uncertainty: { overall: 0.8 },
    ...overrides,
  };
}

describe('D2-F3 locale + jargon honesty', () => {
  it('a zh command renders the zh templates (situation + escalate)', () => {
    const text = renderTemplateNLResponse(
      decision({
        situation: { type: 'emergency', severity: 4, affectedZones: ['大厅'], rootCauseHypothesis: '', confidence: 0.8 },
        actionPlan: { primary: { action: 'escalate', reasoning: 'beyond scope' } },
      }),
      { success: true, message: 'no device commands executed', actions: [] },
      { locale: 'zh' },
    );
    expect(text).toContain('紧急情况');
    expect(text).toContain('大厅');
    expect(text).toContain('升级给所有者');
  });

  it('R51: executed-action lines read the device NAME, never a raw UUID', () => {
    const execution = {
      success: true,
      message: '',
      actions: [
        {
          deviceId: '6e0a6037-93ba-4bcf-841b-fe4d282547a5',
          deviceName: '排涝智能阀 1',
          command: 'open',
          params: { value: 1 },
          success: true,
        },
      ],
    };
    const zh = renderTemplateNLResponse(
      decision({ actionPlan: { primary: { action: 'handle_independently', reasoning: '' } } }),
      execution,
      { locale: 'zh' },
    );
    expect(zh).toContain('将排涝智能阀 1 设为 open');
    expect(zh).not.toContain('6e0a6037');

    // Without a name the id is SHORTENED, still never the full UUID.
    const unnamed = renderTemplateNLResponse(
      decision({ actionPlan: { primary: { action: 'handle_independently', reasoning: '' } } }),
      { ...execution, actions: [{ ...execution.actions[0]!, deviceName: undefined }] },
      { locale: 'zh' },
    );
    expect(unnamed).toContain('6e0a6037…');
    expect(unnamed).not.toContain('fe4d282547a5');

    // The failure line reads the name too.
    const failed = renderTemplateNLResponse(
      decision({ actionPlan: { primary: { action: 'handle_independently', reasoning: '' } } }),
      { success: false, message: '', actions: [{ ...execution.actions[0]!, success: false, error: 'locked' }] },
      { locale: 'zh' },
    );
    expect(failed).toContain('排涝智能阀 1: locked');
  });

  it('the raw escalationCondition never reaches the operator (either locale)', () => {
    const condition = 'severity > 2 or confidence < 0.5';
    for (const locale of ['en', 'zh'] as const) {
      const text = renderTemplateNLResponse(
        decision({
          actionPlan: {
            primary: { action: 'wait', reasoning: '' },
            escalationCondition: condition,
          },
        }),
        { success: true, message: '', actions: [] },
        { locale },
      );
      expect(text).not.toContain('severity > 2');
      expect(text).not.toContain('confidence < 0.5');
    }
  });

  it('detectUserLocale: CJK commands are zh, ASCII stays en', () => {
    expect(detectUserLocale('把大厅温度调到 22 度')).toBe('zh');
    expect(detectUserLocale('set the lobby to 22 degrees')).toBe('en');
  });
});

describe('D2-F2 honesty — non-executing decisions never claim execution', () => {
  it('invoke_flow without a wired lane names the flow AND states nothing executed', () => {
    const text = renderTemplateNLResponse(
      decision({
        actionPlan: {
          primary: { action: 'invoke_flow', flowId: 'night-setback', reasoning: 'standard procedure' },
        },
      }),
      { success: true, message: 'no device commands executed', actions: [] },
    );
    expect(text).toContain('night-setback');
    expect(text).toContain('no flow-invocation lane');
    expect(text).not.toContain("I'm running");
  });

  it('R6-E-F09: an invoked flow reports the run id and status', () => {
    const text = renderTemplateNLResponse(
      decision({
        actionPlan: {
          primary: { action: 'invoke_flow', flowId: 'night-setback', reasoning: 'standard procedure' },
        },
      }),
      {
        success: true,
        actions: [],
        flowInvocation: { flowId: 'night-setback', status: 'invoked', runId: 'run-7', runStatus: 'success' },
      },
    );
    expect(text).toContain('night-setback');
    expect(text).toContain('run-7');
    expect(text).toContain('success');
  });

  it('R6-E-F09: a refused flow names the gate reason (hallucinated id spelled out)', () => {
    const text = renderTemplateNLResponse(
      decision({
        actionPlan: {
          primary: { action: 'invoke_flow', flowId: 'fake-flow', reasoning: 'the model invented this id' },
        },
      }),
      {
        success: false,
        executedNothing: true,
        actions: [],
        flowInvocation: { flowId: 'fake-flow', status: 'refused', reason: 'that flow does not exist or you are not allowed to invoke it' },
      },
    );
    expect(text).toContain('fake-flow');
    expect(text).toContain('does not exist');
    expect(text).not.toContain('started');
  });
});

describe('renderTemplateNLResponse', () => {
  it('renders the anomaly → action → escalation pattern', () => {
    const execution: NLExecutionResult = {
      success: true,
      actions: [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 }, success: true },
      ],
    };
    const text = renderTemplateNLResponse(decision(), execution);
    expect(text).toContain('anomaly');
    expect(text).toContain('zone-a');
    expect(text).toContain('HVAC failure');
    expect(text).toContain('hvac-1');
    expect(text).toContain('24°C');
    expect(text).toContain('escalate');
  });

  it('is deterministic — byte-identical for identical inputs', () => {
    const execution: NLExecutionResult = { success: true, actions: [] };
    const a = renderTemplateNLResponse(decision(), execution);
    const b = renderTemplateNLResponse(decision(), execution);
    expect(a).toBe(b);
  });

  it('speaks bridge rejections and clamps (never hides them)', () => {
    const execution: NLExecutionResult = {
      success: true,
      actions: [],
      rejected: [{ deviceId: 'x', command: 'turn-off', reason: 'not your device' }],
      clamped: ['hvac-1: set-temperature targetTemperature 50 → 40 (clamped)'],
    };
    const text = renderTemplateNLResponse(decision(), execution);
    expect(text).toContain('refused');
    expect(text).toContain('not your device');
    expect(text).toContain('clamped');
  });

  it('reports failed commands honestly', () => {
    const execution: NLExecutionResult = {
      success: false,
      actions: [{ deviceId: 'hvac-1', command: 'set-temperature', success: false, error: 'offline' }],
    };
    const text = renderTemplateNLResponse(decision(), execution);
    expect(text).toContain('failed');
    expect(text).toContain('offline');
  });

  it('renders the escalate decision without inventing actions', () => {
    const escalate = decision({
      actionPlan: { primary: { action: 'escalate', reasoning: 'beyond my scope' } },
    });
    const text = renderTemplateNLResponse(escalate, { success: true, actions: [] });
    expect(text).toContain('escalated');
    expect(text).not.toContain("I've set");
  });
});

describe('generateNLResponse (LLM polish seam)', () => {
  it('returns the template when no polish seam is given', async () => {
    const template = renderTemplateNLResponse(decision(), { success: true, actions: [] });
    await expect(generateNLResponse(decision(), { success: true, actions: [] })).resolves.toBe(template);
  });

  it('uses polish output when available, template on polish failure', async () => {
    const polished = await generateNLResponse(
      decision(),
      { success: true, actions: [] },
      { polishWithLLM: async () => 'Polished wording.' },
    );
    expect(polished).toBe('Polished wording.');
    const fallback = await generateNLResponse(
      decision(),
      { success: true, actions: [] },
      {
        polishWithLLM: async () => {
          throw new Error('down');
        },
      },
    );
    expect(fallback).toBe(renderTemplateNLResponse(decision(), { success: true, actions: [] }));
  });
});

describe('generateStatusResponse / generateHelpResponse / generateEmergencyResponse', () => {
  const zones: NLZoneView[] = [
    { zoneId: 'lobby', name: 'Lobby', parameters: { temperature: 27.5, occupancy: 12 } },
  ];
  const devices: NLDeviceView[] = [
    { deviceId: 'hvac-1', name: 'HVAC', type: 'hvac', online: true, commands: ['set-temperature'] },
    { deviceId: 'dead-1', name: 'Dead', type: 'sensor', online: false, commands: [] },
  ];

  it('renders zone readings with values', () => {
    const text = generateStatusResponse({ devices, zones });
    expect(text).toContain('lobby');
    expect(text).toContain('27.5');
    // R47: the operator-facing actuator line shows the device NAME, not the
    // raw id (UUID dumps were unreadable).
    expect(text).toContain('HVAC');
    expect(text).not.toContain('hvac-1');
    expect(text).toContain('offline');
  });

  it('labels unnamed devices with a shortened id, never a full UUID', () => {
    const text = generateStatusResponse({
      devices: [{ deviceId: '6e0a6037-93ba-4bcf-841b-fe4d282547a5', online: true, commands: ['open'] }],
      zones,
    });
    expect(text).toContain('6e0a6037…');
    expect(text).not.toContain('fe4d282547a5');
  });

  it('renders the zh templates when the operator asked in Chinese', () => {
    const text = generateStatusResponse({ devices, zones, locale: 'zh' });
    expect(text).toContain('当前状态');
    expect(text).toContain('我可操作的设备：HVAC。');
    expect(text).toContain('离线设备：Dead');
  });

  it('scopes to requested zones', () => {
    const text = generateStatusResponse({ devices, zones: [...zones, { zoneId: 'other' }], targetZones: ['other'] });
    expect(text).toContain('other');
    expect(text).not.toContain('Lobby (lobby)');
  });

  it('help renders the real capability surface', () => {
    const text = generateHelpResponse({ agentName: 'ThermalOps', devices, zones });
    expect(text).toContain('ThermalOps');
    expect(text).toContain('hvac-1');
    expect(text).toContain('lobby');
  });

  it('emergency response names the bypass semantics', () => {
    const text = generateEmergencyResponse({
      action: 'emergency',
      rawText: 'fire!',
      parseSource: 'rules',
      targetZones: ['lobby'],
    });
    expect(text).toContain('EMERGENCY');
    expect(text).toContain('lobby');
    expect(text).toContain('escalated');
  });
});

// ============================================================================
// T10 (R2, u2-F4 / u3-F5): ask parameter face — focus folding, explicit
// truncation, zone candidates
// ============================================================================

describe('T10: ask parameter face (R2)', () => {
  const manyParams: NLZoneView[] = [
    {
      zoneId: 'bldg-d-f1', name: 'D栋一层',
      parameters: {
        temperature: 24.5, humidity: 55.1, light: 278.8, motion: 0,
        smoke: 0, co2: 444.5, pm2_5: 12.3, power: 1200,
      },
    },
  ];

  it('focus "pm25" matches the pm2_5 key (folded) and is never truncated away', () => {
    const text = generateStatusResponse({
      devices: [],
      zones: manyParams,
      focusParameters: ['pm25'],
    });
    expect(text).toContain('pm2_5 12.3');
  });

  it('focus matching stays folded-exact (co2 cannot swallow a co2_baseline key)', () => {
    const text = generateStatusResponse({
      devices: [],
      zones: [{ zoneId: 'z', parameters: { co2: 400, co2_baseline: 420 } }],
      focusParameters: ['CO2'],
    });
    expect(text).toContain('co2 400');
    expect(text).toContain('co2_baseline');
  });

  it('non-focused truncation is EXPLICIT: names how many parameters were left out', () => {
    const text = generateStatusResponse({ devices: [], zones: manyParams });
    // 8 parameters, 6 listed → the hint names the other 2.
    expect(text).toContain('2 more parameters not listed');
  });

  it('zh truncation hint renders in the operator language', () => {
    const text = generateStatusResponse({ devices: [], zones: manyParams, locale: 'zh' });
    expect(text).toContain('另有 2 项参数未列出');
  });

  it('zone candidates render as a teaching tail (shorthand miss never dumps silently)', () => {
    const text = generateStatusResponse({
      devices: [],
      zones: manyParams,
      zoneCandidates: [
        { zoneId: 'bldg-b-f1', name: 'B栋一层' },
        { zoneId: 'bldg-a-f1', name: 'A栋一层' },
      ],
      locale: 'zh',
    });
    expect(text).toContain('最接近的分区');
    expect(text).toContain('B栋一层 (bldg-b-f1)');
  });
});
