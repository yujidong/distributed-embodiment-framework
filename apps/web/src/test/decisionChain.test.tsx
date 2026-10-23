/**
 * Decision-chain tests (Wave-4b): lib/decisionChain folds the replay
 * scenario's baked sim-decision / device-state events into per-collaboration
 * chains (grouping by collaborationId, initiator detection, Wave-4a
 * counter/defer outcomes, time-window device-action attribution), and the
 * DecisionChainPanel renders them on the scenario detail page.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ScenarioAgent, ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { DecisionChainPanel } from '../components/DecisionChainPanel';
import { aggregateDecisionChains } from '../lib/decisionChain';

// lib/decisionChain reads the active i18next bundle at call time; pin to en-US
// so the label assertions can be exact English strings. (DecisionChainPanel
// itself still carries untranslated header strings — tracked separately.)
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function simDecision(
  id: string,
  atSimTimeSec: number,
  details: Record<string, unknown>,
): ScenarioEvent {
  return { id, type: 'sim-decision', zoneId: 'zone-1', atSimTimeSec, details };
}

function deviceState(
  id: string,
  atSimTimeSec: number,
  details: Record<string, unknown>,
): ScenarioEvent {
  return { id, type: 'device-state', zoneId: 'zone-1', atSimTimeSec, details };
}

const AGENTS: ScenarioAgent[] = [
  { id: 'agent-1', name: '感知员', capabilities: [], managesZoneIds: [], boundDeviceIds: [] },
  { id: 'agent-2', name: '气候管家', capabilities: [], managesZoneIds: [], boundDeviceIds: [] },
];

afterEach(cleanup);

describe('aggregateDecisionChains (Wave-4b)', () => {
  it('groups handshake responses by collaborationId and detects the initiator', () => {
    const chains = aggregateDecisionChains([
      simDecision('d1', 10, {
        agentId: 'agent-1', eventId: 'evt-1', decision: 'initiate_ac',
        decisionSource: 'llm', reasoning: '烟雾需要空调配合',
      }),
      simDecision('d2', 12, {
        kind: 'collaboration-response', collaborationId: 'ac-1', eventId: 'evt-1',
        agentId: 'agent-2', decision: 'accept', decisionSource: 'rule',
      }),
    ]);
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;
    expect(chain.collaborationId).toBe('ac-1');
    expect(chain.initiatorId).toBe('agent-1');
    expect(chain.status).toBe('accepted');
    expect(chain.assessments.map(s => s.decision)).toEqual(['initiate_ac']);
    expect(chain.responses.map(s => s.decision)).toEqual(['accept']);
    expect(chain.startSimTimeSec).toBe(10);
  });

  it('covers the Wave-4a counter/defer outcomes', () => {
    const countered = aggregateDecisionChains([
      simDecision('d1', 1, {
        kind: 'collaboration-response', collaborationId: 'ac-c',
        agentId: 'agent-2', decision: 'counter', reasoning: '温度过高，建议 26°',
      }),
    ]);
    expect(countered[0]!.status).toBe('countered');

    const deferred = aggregateDecisionChains([
      simDecision('d1', 1, {
        kind: 'collaboration-response', collaborationId: 'ac-d',
        agentId: 'agent-2', decision: 'defer',
      }),
    ]);
    expect(deferred[0]!.status).toBe('deferred');

    // An accept still wins over a counter from another responder.
    const accepted = aggregateDecisionChains([
      simDecision('d1', 1, {
        kind: 'collaboration-response', collaborationId: 'ac-m',
        agentId: 'agent-2', decision: 'counter',
      }),
      simDecision('d2', 2, {
        kind: 'collaboration-response', collaborationId: 'ac-m',
        agentId: 'agent-3', decision: 'accept',
      }),
    ]);
    expect(accepted[0]!.status).toBe('accepted');
  });

  it('keeps assessments without a handshake as independent chains', () => {
    const chains = aggregateDecisionChains([
      simDecision('d1', 5, {
        agentId: 'agent-1', eventId: 'evt-2', decision: 'handle_independently',
        decisionSource: 'precheck',
      }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.collaborationId).toBeUndefined();
    expect(chains[0]!.status).toBe('independent');
  });

  it('attributes device actions to the chain whose sim-time window contains them', () => {
    const chains = aggregateDecisionChains([
      simDecision('d1', 10, {
        kind: 'collaboration-response', collaborationId: 'ac-1',
        agentId: 'agent-2', decision: 'accept',
      }),
      simDecision('d2', 20, {
        agentId: 'agent-1', eventId: 'evt-9', decision: 'handle_independently',
      }),
      deviceState('dev1', 15, { deviceId: 'ac-unit', service: 'turn-on' }),
      deviceState('dev2', 25, { deviceId: 'lamp', service: 'turn-off' }),
    ]);
    expect(chains).toHaveLength(2);
    expect(chains[0]!.collaborationId).toBe('ac-1');
    expect(chains[0]!.actions.map(a => a.deviceId)).toEqual(['ac-unit']);
    expect(chains[1]!.actions.map(a => a.deviceId)).toEqual(['lamp']);
  });

  it('ignores non-timeline events and malformed details', () => {
    const chains = aggregateDecisionChains([
      { id: 'e1', type: 'smoke-detected', zoneId: 'zone-1', atSimTimeSec: 1 },
      { id: 'e2', type: 'sim-decision', zoneId: 'zone-1' }, // no details at all
      simDecision('e3', 2, { kind: 'collaboration-response' }), // no collaborationId/agentId
    ]);
    expect(chains).toHaveLength(2);
    expect(chains.every(chain => chain.status === 'independent' || chain.status === 'pending')).toBe(true);
  });
});

describe('DecisionChainPanel (Wave-4b)', () => {
  const EVENTS: ScenarioEvent[] = [
    simDecision('d1', 10, {
      agentId: 'agent-1', eventId: 'evt-1', decision: 'initiate_ac',
      decisionSource: 'llm', reasoning: '烟雾需要空调配合',
    }),
    simDecision('d2', 12, {
      kind: 'collaboration-response', collaborationId: 'ac-1', eventId: 'evt-1',
      agentId: 'agent-2', decision: 'counter', decisionSource: 'llm',
      reasoning: '建议先开到 26°',
    }),
    deviceState('dev1', 14, { deviceId: 'ac-unit', service: 'turn-on' }),
  ];

  it('renders the chain with parties, counter label, reasoning and the device action', () => {
    const { container } = render(<DecisionChainPanel events={EVENTS} agents={AGENTS} />);

    expect(screen.getByText('Collaboration decision chain (1)')).toBeTruthy();
    expect(screen.getByText('Countered')).toBeTruthy(); // Wave-4a counter status badge
    expect(screen.getByText(/Initiator 感知员/)).toBeTruthy();
    expect(screen.getByText(/Responder 气候管家/)).toBeTruthy();
    // UX-07: the collaboration UUID left the visible header — it survives on
    // the header's title tooltip only.
    expect(screen.queryByText('ac-1')).toBeNull();
    expect(
      container.querySelector('.decision-chain__header')?.getAttribute('title'),
    ).toBe('ac-1');
    expect(screen.getByText(/Initiate collaboration/)).toBeTruthy();
    expect(screen.getByText(/烟雾需要空调配合/)).toBeTruthy();
    expect(screen.getByText(/建议先开到 26°/)).toBeTruthy();
    expect(screen.getByText(/Device action ac-unit/)).toBeTruthy();
  });

  it('renders the defer label for a deferred handshake', () => {
    render(
      <DecisionChainPanel
        events={[
          simDecision('d1', 3, {
            kind: 'collaboration-response', collaborationId: 'ac-d',
            agentId: 'agent-2', decision: 'defer',
          }),
        ]}
        agents={AGENTS}
      />,
    );
    // Decision label "Defer" + status label "Deferred" both render.
    expect(screen.getAllByText(/Defer/).length).toBeGreaterThan(0);
  });

  it('renders nothing when the scenario has no sim-decision events', () => {
    const { container } = render(
      <DecisionChainPanel
        events={[{ id: 'e1', type: 'smoke-detected', zoneId: 'zone-1' }]}
        agents={AGENTS}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('DecisionChainPanel — UX-07 readability', () => {
  it('device-execution receipts no longer flood the panel as standalone chains', () => {
    const chains = aggregateDecisionChains([
      simDecision('d1', 10, {
        agentId: 'agent-1', eventId: 'evt-1', decision: 'handle_independently',
        decisionSource: 'rule',
      }),
      simDecision('x1', 11, {
        kind: 'device-execution', agentId: 'agent-1', eventId: 'evt-1',
        decision: 'executed', decisionSource: 'engine',
        deviceExecution: { deviceId: 'ac-unit', command: 'turn-on', success: true },
      }),
      simDecision('x2', 12, {
        kind: 'device-execution', agentId: 'agent-1', eventId: 'evt-9',
        decision: 'executed', decisionSource: 'engine:flow:flow-1',
        deviceExecution: { deviceId: 'lamp', command: 'turn-off', success: true },
      }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.assessments.map(s => s.decision)).toEqual(['handle_independently']);
  });

  it('an llm-failure step carries its errorMessage and the panel renders it as a drill-down', () => {
    const events: ScenarioEvent[] = [
      simDecision('d1', 7, {
        kind: 'llm-failure', agentId: 'agent-1', eventId: 'evt-3',
        decision: 'error', decisionSource: 'llm-error',
        errorMessage: 'connect ECONNREFUSED 127.0.0.1:11434',
      }),
    ];
    const chains = aggregateDecisionChains(events);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.assessments[0]!.errorMessage).toBe('connect ECONNREFUSED 127.0.0.1:11434');

    const { container } = render(<DecisionChainPanel events={events} agents={AGENTS} />);
    const details = container.querySelector('details.decision-chain__error');
    expect(details).not.toBeNull();
    expect(details!.querySelector('pre')?.textContent).toBe(
      'connect ECONNREFUSED 127.0.0.1:11434',
    );
  });

  it('the chain header names the trigger event (names maps) instead of a bare id', () => {
    render(
      <DecisionChainPanel
        events={[
          { id: 'evt-1', type: 'temperature-spike', zoneId: 'zone-1', atSimTimeSec: 9 },
          simDecision('d1', 10, {
            kind: 'collaboration-response', collaborationId: 'ac-1', eventId: 'evt-1',
            agentId: 'agent-2', decision: 'accept',
          }),
        ]}
        agents={AGENTS}
        names={{
          agents: {},
          flows: {},
          events: { 'evt-1': 'temperature-spike · Room 301' },
        }}
      />,
    );
    expect(screen.getByText('Event temperature-spike · Room 301')).toBeTruthy();
  });
});
