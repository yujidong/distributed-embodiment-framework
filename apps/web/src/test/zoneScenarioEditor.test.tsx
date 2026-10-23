/**
 * UX-10: the zone detail's baseline parameter editor and scheduled-event
 * (事件剧本) panel (ZoneScenarioEditor) — read-only display for everyone,
 * owner-only edits that PATCH /api/environments/:id with the single changed
 * mapData key (zones / events).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, EnvZone, ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { ZoneBaselineEditor, ZoneScheduleEditor } from '../components/world/ZoneScenarioEditor';
import { baselineToRows, mapDataWithEvents, mapDataWithUpdatedZone } from '../lib/zoneForm';
import { useAppStore } from '../store/useAppStore';
import { answerConfirm } from './testUtils';

const ZONE: EnvZone = {
  id: 'zone-1',
  name: '客厅',
  bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 },
  baseline: { temperature: 26, occupied: true },
} as EnvZone;

const EVENT: ScenarioEvent = {
  id: 'ev-1',
  type: 'smoke-detected',
  zoneId: 'zone-1',
  atSimTimeSec: 60,
  parameter: 'pm2_5',
  value: 200,
} as ScenarioEvent;

function makeWorld(myRole: EnvironmentDetail['myRole'] = 'owner'): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-me', displayName: '小A' },
    zones: [ZONE],
    events: [EVENT],
    devices: [],
    agents: [],
    services: [],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Controlled-input helper: fire a native change React picks up. */
function setInputValue(input: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('zoneForm UX-10 helpers', () => {
  it('baselineToRows prefills the editor from a stored baseline', () => {
    expect(baselineToRows(ZONE.baseline)).toEqual([
      { key: 'temperature', value: '26' },
      { key: 'occupied', value: 'true' },
    ]);
    expect(baselineToRows(undefined)).toEqual([]);
  });

  it('mapDataWithUpdatedZone replaces only the matching zone', () => {
    const world = makeWorld();
    const updated = { ...ZONE, baseline: { temperature: 21 } };
    const body = mapDataWithUpdatedZone(world, updated);
    expect(body).toEqual({ zones: [updated] });
  });

  it('mapDataWithEvents sends only the events key (key-merge lane)', () => {
    expect(mapDataWithEvents([EVENT])).toEqual({ events: [EVENT] });
  });
});

describe('ZoneBaselineEditor (UX-10)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/environments/env-1' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { mapData: { zones: EnvZone[] } };
          return jsonResponse({ ...makeWorld(), zones: body.mapData.zones });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the current baseline read-only and PATCHes the edited values', async () => {
    render(<ZoneBaselineEditor world={makeWorld()} zone={ZONE} />);

    // DetailSection is collapsed by default — the section header (with the
    // count) is the visible entry; expand it to reach the rows.
    screen.getByText('Baseline parameters (2)').click();
    expect(await screen.findByText('temperature')).toBeTruthy();
    expect(screen.getByText('26')).toBeTruthy();

    screen.getByTestId('zone-baseline-edit').click();
    const valueInput = await screen.findByDisplayValue('26');
    setInputValue(valueInput, '21');
    screen.getByText('Save zone').click();

    await waitFor(() => {
      const patchCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/environments/env-1');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall?.[1]?.body)) as {
        mapData: { zones: Array<EnvZone & { baseline?: Record<string, number | boolean> }> };
      };
      // Only the zones key is sent (the server key-merges the rest).
      expect(Object.keys(body.mapData)).toEqual(['zones']);
      expect(body.mapData.zones[0]?.baseline).toEqual({ temperature: 21, occupied: true });
    });
  });

  it('hides the edit button for non-owners', async () => {
    render(<ZoneBaselineEditor world={makeWorld('viewer')} zone={ZONE} />);
    screen.getByText('Baseline parameters (2)').click();
    expect(await screen.findByText('temperature')).toBeTruthy();
    expect(screen.queryByTestId('zone-baseline-edit')).toBeNull();
  });
});

describe('ZoneScheduleEditor (UX-10)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({ toasts: [], confirmRequest: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/environments/env-1' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { mapData: { events: ScenarioEvent[] } };
          return jsonResponse({ ...makeWorld(), events: body.mapData.events });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the zone events sorted by fire time and deletes one via events-key PATCH', async () => {
    render(<ZoneScheduleEditor world={makeWorld()} zone={ZONE} />);

    screen.getByText('Scheduled events (1)').click();
    const row = await screen.findByTestId('zone-schedule-row');
    expect(row.textContent).toContain('t=60s');
    expect(row.textContent).toContain('smoke-detected');
    expect(row.textContent).toContain('pm2_5=200');

    screen.getByText('Delete').click();
    await answerConfirm(true);
    await waitFor(() => {
      const patchCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/environments/env-1');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall?.[1]?.body)) as { mapData: { events: unknown[] } };
      expect(Object.keys(body.mapData)).toEqual(['events']);
      expect(body.mapData.events).toEqual([]);
    });
  });

  it('adds a scheduled event with type + fire time + parameter/value', async () => {
    render(<ZoneScheduleEditor world={makeWorld()} zone={ZONE} />);

    screen.getByText('Scheduled events (1)').click();
    (await screen.findByTestId('zone-schedule-add')).click();
    setInputValue(await screen.findByPlaceholderText('e.g. smoke-detected'), 'occupancy');
    setInputValue(screen.getByPlaceholderText('e.g. 60'), '120');
    setInputValue(screen.getByPlaceholderText('Parameter name'), 'occupancy');
    setInputValue(screen.getByPlaceholderText('Value, e.g. 26 or true'), '120');
    screen.getByText('Add').click();

    await waitFor(() => {
      const patchCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/environments/env-1');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall?.[1]?.body)) as { mapData: { events: ScenarioEvent[] } };
      expect(body.mapData.events).toHaveLength(2);
      const added = body.mapData.events[1]!;
      expect(added.id).toMatch(/^ui-zone-1-/);
      expect(added).toMatchObject({
        type: 'occupancy',
        zoneId: 'zone-1',
        atSimTimeSec: 120,
        parameter: 'occupancy',
        value: 120,
      });
    });
  });

  it('rejects an incomplete form without calling the API', async () => {
    render(<ZoneScheduleEditor world={makeWorld()} zone={ZONE} />);
    screen.getByText('Scheduled events (1)').click();
    (await screen.findByTestId('zone-schedule-add')).click();
    setInputValue(await screen.findByPlaceholderText('e.g. smoke-detected'), 'occupancy');
    screen.getByText('Add').click();
    expect(
      await screen.findByText('Enter an event type and a valid fire time (sim seconds ≥ 0).'),
    ).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it('hides add/delete for non-owners but keeps the list', async () => {
    render(<ZoneScheduleEditor world={makeWorld('builder')} zone={ZONE} />);
    screen.getByText('Scheduled events (1)').click();
    expect(await screen.findByTestId('zone-schedule-row')).toBeTruthy();
    expect(screen.queryByTestId('zone-schedule-add')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });
});
