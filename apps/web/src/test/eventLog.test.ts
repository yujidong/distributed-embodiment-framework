/**
 * Event log formatter: family classification and human summaries, with
 * emphasis on defensive rendering — unknown event types and malformed
 * payloads must still produce a readable line.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { SystemEventDto } from '../api/types';
import i18n from '../i18n/config';
import { eventFamily, summarizeEvent, toLogEntry } from '../lib/eventLog';

function event(type: string, payload?: unknown): SystemEventDto {
  return { id: `evt-${type}`, type, source: 'test', payload };
}

// summarizeEvent reads the active i18next bundle at call time; pin to en-US so
// assertions can be exact strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

describe('eventFamily', () => {
  it('classifies by type prefix', () => {
    expect(eventFamily('device.state_change')).toBe('device');
    expect(eventFamily('environment.param_changed')).toBe('environment');
    expect(eventFamily('collaboration.proposal')).toBe('collaboration');
    expect(eventFamily('agent.state_change')).toBe('agent');
    expect(eventFamily('system.error')).toBe('other');
  });

  it('puts AC_STATE_CHANGED custom events into the collaboration family', () => {
    const entry = toLogEntry(
      event('custom', { customType: 'AC_STATE_CHANGED', collaborationId: 'ac-1', from: 'forming', to: 'running' }),
    );
    expect(entry.family).toBe('collaboration');
  });
});

describe('summarizeEvent', () => {
  it('summarizes a device operation with its result', () => {
    expect(
      summarizeEvent(
        event('device.operation_executed', {
          deviceName: 'living-room-ac',
          commandName: 'set-temperature',
          result: { success: true },
        }),
      ),
    ).toBe('Device op living-room-ac set-temperature → success');
  });

  it('summarizes an ac-proposal collaboration message', () => {
    expect(
      summarizeEvent(
        event('collaboration.message', {
          type: 'ac-proposal',
          initiatorId: 'temp-monitor-agent',
          targetAgentId: 'hvac-control-agent',
          description: 'need cooling',
        }),
      ),
    ).toBe('Collaboration proposal temp-monitor-agent → hvac-control-agent: need cooling');
  });

  it('summarizes an AC state transition', () => {
    expect(
      summarizeEvent(
        event('custom', { customType: 'AC_STATE_CHANGED', collaborationId: 'ac-1', from: 'forming', to: 'completed' }),
      ),
    ).toBe('AC state ac-1: forming → completed');
  });

  it('renders unknown payload shapes defensively', () => {
    // Unknown type with an arbitrary payload → truncated JSON dump, no throw.
    const line = summarizeEvent(event('brand.new_type', { weird: [1, { x: 'y' }] }));
    expect(line).toContain('brand.new_type');
    expect(line).toContain('weird');
  });

  it('handles missing/undefined payloads without throwing', () => {
    expect(() => summarizeEvent(event('device.state_change', undefined))).not.toThrow();
    expect(summarizeEvent(event('device.state_change', undefined))).toContain('Device state');
    expect(() => summarizeEvent(event('collaboration.completed', null))).not.toThrow();
    // Non-JSON-serializable payloads (circular) must not throw either.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => summarizeEvent(event('mystery', circular))).not.toThrow();
  });

  it('classifies and summarizes flow.triggered / flow.executed', () => {
    expect(eventFamily('flow.triggered')).toBe('flow');
    expect(eventFamily('flow.executed')).toBe('flow');
    expect(
      summarizeEvent(event('flow.triggered', { flowId: 'flow-1', runId: 'r1', triggerKind: 'event' })),
    ).toBe('Flow flow-1 triggered (event)');
    expect(
      summarizeEvent(
        event('flow.executed', {
          flowId: 'flow-1',
          runId: 'r1',
          triggerKind: 'event',
          status: 'partial',
          summary: '2/3 nodes succeeded',
        }),
      ),
    ).toBe('Flow flow-1 ran partially succeeded: 2/3 nodes succeeded');
  });
});
