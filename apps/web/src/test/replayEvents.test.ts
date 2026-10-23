/**
 * Replay event rendering tests (Fix-14 / Fix-17): the three sim-timeline
 * event kinds (sim-decision / zone-sample / device-state) get readable
 * one-liners in the scenario event list, and readable trigger labels in the
 * episode timeline.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { ScenarioEvent } from '../api/types';
import { formatTrigger } from '../lib/episodes';
import {
  formatReplayEvent,
  isReplayEventType,
  replayEventLabel,
  replaySourceLabel,
} from '../lib/replayEvents';

// formatReplayEvent / formatTrigger read the active i18next bundle at call
// time; pin to zh-CN so the Chinese assertions below stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

function makeEvent(overrides: Partial<ScenarioEvent> = {}): ScenarioEvent {
  return {
    id: 'replay:dec:1',
    type: 'sim-decision',
    zoneId: 'zone-1',
    atSimTimeSec: 12,
    ...overrides,
  };
}

describe('formatReplayEvent (Fix-14)', () => {
  it('sim-decision shows agent, decision, source and reasoning', () => {
    const line = formatReplayEvent(
      makeEvent({
        details: {
          agentId: 'agent-1',
          decision: 'turn-on',
          decisionSource: 'llm',
          reasoning: '卧室温度过高，需要降温',
        },
      }),
    );
    expect(line).toContain('t=12s');
    expect(line).toContain('决策回放 agent-1：turn-on（llm）');
    expect(line).toContain('卧室温度过高');
  });

  it('zone-sample shows the parameter pairs and occupancy', () => {
    const line = formatReplayEvent(
      makeEvent({
        id: 'replay:zone:1',
        type: 'zone-sample',
        details: { parameters: { temperature: 26.5, co2: 800 }, occupancy: 2 },
      }),
    );
    expect(line).toContain('区域采样 zone-1');
    expect(line).toContain('temperature=26.5');
    expect(line).toContain('co2=800');
    expect(line).toContain('人数 2');
  });

  it('device-state shows the device and the triggering service', () => {
    const line = formatReplayEvent(
      makeEvent({
        id: 'replay:dev:1',
        type: 'device-state',
        details: { deviceId: 'dev-9', service: 'turn-on' },
      }),
    );
    expect(line).toBe('t=12s 设备状态回放 dev-9（turn-on）');
  });

  it('falls back to a generic line for ordinary scenario events', () => {
    const line = formatReplayEvent(
      makeEvent({ type: 'smoke-detected', parameter: 'smoke', value: 1, details: undefined }),
    );
    expect(line).toContain('smoke-detected zone-1 smoke = 1');
  });

  // R2-FEAT-12: zone 显示名（name 主 id 次）——给了 zones 映射就不再裸显 id。
  it('resolves zone display names when the names map carries zones (R2-FEAT-12)', () => {
    const names = { zones: { 'zone-1': '病区A' } };
    const sample = formatReplayEvent(
      makeEvent({
        id: 'replay:zone:1',
        type: 'zone-sample',
        details: { parameters: { temperature: 39 } },
      }),
      names,
    );
    expect(sample).toContain('区域采样 病区A');
    expect(sample).not.toContain('zone-1');
    const generic = formatReplayEvent(
      makeEvent({ type: 'smoke-detected', details: undefined }),
      names,
    );
    expect(generic).toContain('smoke-detected 病区A');
    // Unknown zone ids keep the raw id (pre-UX-07 behavior).
    const unknown = formatReplayEvent(
      makeEvent({ id: 'replay:zone:2', type: 'zone-sample', zoneId: 'zone-9', details: {} }),
      names,
    );
    expect(unknown).toContain('zone-9');
  });

  it('labels only the three replay kinds', () => {
    expect(isReplayEventType('sim-decision')).toBe(true);
    expect(isReplayEventType('zone-sample')).toBe(true);
    expect(isReplayEventType('device-state')).toBe(true);
    expect(isReplayEventType('smoke-detected')).toBe(false);
    expect(replayEventLabel('sim-decision')).toBe('决策回放');
  });
});

describe('formatReplayEvent — UX-07 name resolution', () => {
  const NAMES = {
    agents: { 'agent-1': '气候管家' },
    flows: { 'flow-uuid-1': '课后关机' },
    events: { 'evt-1': 'temperature-spike · Room 301' },
  };

  it('resolves the agent display name instead of the raw id', () => {
    const line = formatReplayEvent(
      makeEvent({
        details: { agentId: 'agent-1', decision: 'initiate_ac', decisionSource: 'llm' },
      }),
      NAMES,
    );
    expect(line).toContain('气候管家');
    expect(line).not.toContain('agent-1');
  });

  it('resolves an engine:flow source to the flow name', () => {
    const line = formatReplayEvent(
      makeEvent({
        details: {
          agentId: 'agent-1',
          kind: 'device-execution',
          decision: 'executed',
          decisionSource: 'engine:flow:flow-uuid-1',
          deviceExecution: { deviceId: 'ac-9', deviceName: '空调 9', command: 'turn-off', success: true },
        },
      }),
      NAMES,
    );
    expect(line).toContain('业务流 课后关机');
    expect(line).not.toContain('flow-uuid-1');
    // The receipt names its command + target device.
    expect(line).toContain('turn-off → 空调 9');
  });

  it('keeps raw ids when the maps have no entry (or no maps are given)', () => {
    expect(replaySourceLabel('engine:flow:missing', NAMES)).toBe('业务流 missing');
    expect(replaySourceLabel('engine:agent:agent-1', NAMES)).toBe('气候管家');
    expect(replaySourceLabel('llm', NAMES)).toBe('llm');
    expect(replaySourceLabel('engine:flow:f-1')).toBe('业务流 f-1');
    const line = formatReplayEvent(
      makeEvent({ details: { agentId: 'agent-9', decision: 'defer', decisionSource: 'rule' } }),
    );
    expect(line).toContain('agent-9');
  });
});

describe('episode trigger labels for replay kinds', () => {
  it('formatTrigger renders the Chinese label instead of the raw type', () => {
    expect(formatTrigger({ type: 'sim-decision', zoneId: 'zone-1' })).toBe('zone-1 决策回放');
    expect(formatTrigger({ type: 'zone-sample', zoneId: 'zone-1' })).toBe('zone-1 区域采样');
    expect(formatTrigger({ type: 'device-state' })).toBe('设备状态回放');
    // Ordinary physics events keep the parameter rendering.
    expect(formatTrigger({ type: 'smoke-detected', zoneId: 'z', parameter: 'smoke', value: 1 })).toBe(
      'z 烟雾 = 1',
    );
  });
});
