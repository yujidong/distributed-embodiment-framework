/**
 * R100 web tests (li-10) — device-delete honesty for builders in the device
 * tab: a builder's delete surfaces the remove-devices PROPOSAL (no local
 * fake deletion), a rule-REJECTED proposal shows its reason in the page
 * body and leaves the device untouched, and the confirm dialog states the
 * cascade (bound agents + backed derived services) BEFORE the user commits.
 * The env owner's direct delete keeps the old immediate behavior.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, WorldAgent, WorldDevice, WorldService } from '../api/types';
import i18n from '../i18n/config';
import { WorldSidebar } from '../components/world/WorldSidebar';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders, answerConfirm } from './testUtils';

const BUILDER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: 'Builder A',
  createdAt: '2026-01-01T00:00:00Z',
};

function makeDevice(): WorldDevice {
  return {
    id: 'dev-1',
    envId: 'env-1',
    name: 'lab-101 CO2空气检测仪',
    type: 'air-quality-sensor',
    brand: null,
    capabilities: ['co2-monitoring'],
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: null,
    role: null,
    owner: { id: 'u-me', displayName: 'Builder A' },
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as WorldDevice;
}

function makeAgent(): WorldAgent {
  return {
    id: 'a-1',
    envId: 'env-1',
    name: '李家设备管家',
    capabilities: ['co2-monitoring'],
    boundDeviceIds: ['dev-1'],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'u-me', displayName: 'Builder A' },
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as WorldAgent;
}

function makeDerivedService(): WorldService {
  return {
    id: 'svc-1',
    envId: 'env-1',
    name: 'lab-101 CO2空气检测仪: co2-monitoring',
    semanticType: 'co2-monitoring',
    providerAgentId: 'a-1',
    sourceDeviceId: 'dev-1',
    origin: 'derived',
    visibility: 'members',
    interface: { actions: [] },
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as WorldService;
}

function makeWorld(role: 'builder' | 'owner'): EnvironmentDetail {
  return {
    id: 'env-1',
    name: 'Shared Lab',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-owner', displayName: 'Owner' },
    zones: [{ id: 'zone-1', name: 'Room 1' }],
    events: [],
    devices: [makeDevice()],
    agents: [makeAgent()],
    services: [makeDerivedService()],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole: role,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as EnvironmentDetail;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ApplyWorldMessage = ReturnType<typeof useAppStore.getState>['applyWorldMessage'];

const REJECT_ISSUE =
  'deviceIds[0] ("lab-101 CO2空气检测仪") is bound to agent "李家设备管家" — ' +
  'unbind it first (modify-object on the agent) before removing the device';

function proposalResponse(status: string) {
  return {
    id: 'prop-rm-d1',
    envId: 'env-1',
    kind: 'remove-devices',
    status,
    payload: { deviceIds: ['dev-1'] },
    ruleCheck: { ok: status !== 'rejected', issues: status === 'rejected' ? [REJECT_ISSUE] : [], warnings: [] },
  };
}

describe('device delete honesty (R100, li-10)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  let applyWorldMessage: ReturnType<typeof vi.fn>;
  let deleteBody: () => Response;

  beforeEach(() => {
    applyWorldMessage = vi.fn();
    deleteBody = () => jsonResponse(proposalResponse('escalated'), 201);
    useAppStore.setState({
      user: BUILDER,
      toasts: [],
      confirmRequest: null,
      selection: { objectType: 'device', id: 'dev-1' },
      applyWorldMessage: applyWorldMessage as unknown as ApplyWorldMessage,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/devices/dev-1' && method === 'DELETE') return deleteBody();
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${method} ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppStore.setState({ user: null, selection: null });
  });

  function renderSidebar(role: 'builder' | 'owner' = 'builder') {
    return renderWithProviders(
      <WorldSidebar world={makeWorld(role)} tab="devices" onTabChange={() => {}} />,
    );
  }

  it('the confirm dialog states the cascade (bound agent + backed services) before commit', async () => {
    renderSidebar();
    screen.getByText('Delete device').click();
    const confirmText = await answerConfirm(true);
    expect(confirmText).toContain('李家设备管家');
    expect(confirmText).toContain('1 derived service');
  });

  it('a rule-REJECTED proposal shows the reason in the page body and deletes NOTHING locally', async () => {
    deleteBody = () => jsonResponse(proposalResponse('rejected'), 201);
    renderSidebar();
    screen.getByText('Delete device').click();
    await answerConfirm(true);
    await waitFor(() => {
      const toast = useAppStore.getState().toasts[0];
      expect(toast?.text).toContain('rejected by the rule check');
      expect(toast?.text).toContain(REJECT_ISSUE);
    });
    // The fake 'deleted' world message is never applied — the device stays.
    expect(applyWorldMessage).not.toHaveBeenCalled();
  });

  it('a pending proposal is reported as pending — the device stays until approval', async () => {
    renderSidebar();
    screen.getByText('Delete device').click();
    await answerConfirm(true);
    await waitFor(() => {
      const toast = useAppStore.getState().toasts[0];
      expect(toast?.text).toContain('remove-devices proposal prop-rm-d1 submitted (escalated)');
    });
    expect(applyWorldMessage).not.toHaveBeenCalled();
  });

  it('an auto-APPLIED proposal deletes the device for real', async () => {
    deleteBody = () => jsonResponse(proposalResponse('applied'), 201);
    renderSidebar();
    screen.getByText('Delete device').click();
    await answerConfirm(true);
    await waitFor(() => {
      expect(applyWorldMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deleted', objectType: 'device' }),
      );
    });
    const toast = useAppStore.getState().toasts[0];
    expect(toast?.text).toContain('approved');
  });

  it('the env owner direct delete keeps the immediate behavior', async () => {
    deleteBody = () => new Response(null, { status: 204 });
    renderSidebar('owner');
    screen.getByText('Delete device').click();
    await answerConfirm(true);
    await waitFor(() => {
      expect(applyWorldMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deleted', objectType: 'device' }),
      );
    });
  });
});
