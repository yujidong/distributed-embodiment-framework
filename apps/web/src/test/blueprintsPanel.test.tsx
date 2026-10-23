/**
 * BlueprintsPanel tests (Fix-38): the world sidebar's 蓝图 tab — list render
 * from a stubbed GET /api/blueprints plus the install flow (zone pick → POST
 * …/install → success/error toast), driven by a stubbed fetch against the
 * real API client (same pattern as agreements.test.tsx).
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Blueprint, EnvironmentDetail } from '../api/types';
import { BlueprintsPanel } from '../components/world/BlueprintsPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

function makeWorld(): EnvironmentDetail {
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
    zones: [
      { id: 'zone-1', name: '101 教室' },
      { id: 'zone-2', name: '102 教室' },
    ],
    events: [],
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
    myRole: 'owner',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const BUILTIN_BP: Blueprint = {
  id: 'bp-energy',
  name: '教室节能管家',
  description: '温度传感器 + 空调 + 节能 Agent。',
  definition: {
    devices: [
      { name: '教室温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
      { name: '教室空调', type: 'hvac', capabilities: ['cooling'], zoneId: '${zoneId}' },
    ],
    agents: [
      { name: '节能管家', capabilities: ['cooling'], managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
    ],
    flows: [
      { name: '高温自动降温', enabled: true, trigger: {}, plan: { goal: '降温', nodes: [] } },
    ],
  },
  isBuiltin: true,
  createdBy: null,
};

const CUSTOM_BP: Blueprint = {
  id: 'bp-custom',
  name: '自定义蓝图',
  description: '',
  definition: {
    devices: [{ name: '灯', type: 'light', capabilities: ['turn-on'], zoneId: '${zoneId}' }],
    agents: [],
  },
  isBuiltin: false,
  createdBy: 'u-me',
};

// R6-D-S3: a collaboration pair — A suggests B and B suggests A.
const PAIR_A: Blueprint = {
  id: 'co2-monitor',
  name: 'CO2 监测员',
  description: 'CO₂ 传感器 + 环境监测 Agent。',
  definition: {
    devices: [{ name: 'CO2 传感器', type: 'air-quality-sensor', capabilities: ['co2-reading'], zoneId: '${zoneId}' }],
    agents: [
      { name: '环境监测员', capabilities: ['air-quality-monitoring'], managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0] },
    ],
    partnerSuggestion: { blueprintId: 'fresh-air-manager', note: '与「新风管家」装在同一区域。' },
  },
  isBuiltin: true,
  createdBy: null,
};

const PAIR_B: Blueprint = {
  id: 'fresh-air-manager',
  name: '新风管家',
  description: '新风设备 + 新风调度 Agent。',
  definition: {
    devices: [{ name: '新风机', type: 'fresh-air-system', capabilities: ['ventilation-control'], zoneId: '${zoneId}' }],
    agents: [
      { name: '新风管家', capabilities: ['ventilation-control'], managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0] },
    ],
    partnerSuggestion: { blueprintId: 'co2-monitor', note: '与「CO2 监测员」装在同一区域。' },
  },
  isBuiltin: true,
  createdBy: null,
};

function installResult(bp: Blueprint, zoneId: string) {
  return {
    blueprintId: bp.id,
    blueprintName: bp.name,
    envId: 'env-1',
    zoneId,
    createdIds: { devices: ['d1'], agents: ['a1'], flows: [] },
    summary: { devices: 1, agents: 1, flows: 0 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BlueprintsPanel', () => {
  // Panel text uses the active i18next bundle; pin to zh-CN so the
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  let installShouldFail = false;
  let listedBlueprints: Blueprint[];

  beforeEach(() => {
    installShouldFail = false;
    listedBlueprints = [BUILTIN_BP, CUSTOM_BP];
    useAppStore.setState({ toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/blueprints') return jsonResponse({ blueprints: listedBlueprints });
        if (url === '/api/environments/env-1/blueprints/bp-energy/install' && init?.method === 'POST') {
          if (installShouldFail) {
            return jsonResponse({ error: { code: 'UNKNOWN_ZONE', message: 'Zone does not exist' } }, 400);
          }
          return jsonResponse(
            {
              blueprintId: 'bp-energy',
              blueprintName: '教室节能管家',
              envId: 'env-1',
              zoneId: 'zone-1',
              createdIds: { devices: ['d1', 'd2'], agents: ['a1'], flows: ['f1'] },
              summary: { devices: 2, agents: 1, flows: 1 },
            },
            201,
          );
        }
        // R6-D-S3 pair installs (zoneId echoes the request body).
        const pairMatch = url.match(/^\/api\/environments\/env-1\/blueprints\/(co2-monitor|fresh-air-manager)\/install$/);
        if (pairMatch && init?.method === 'POST') {
          const bp = pairMatch[1] === 'co2-monitor' ? PAIR_A : PAIR_B;
          const zoneId = (JSON.parse(String(init.body)) as { zoneId: string }).zoneId;
          return jsonResponse(installResult(bp, zoneId), 201);
        }
        // The post-install invalidation refetches the environment detail.
        if (url === '/api/environments/env-1') return jsonResponse(makeWorld());
        // The health card (R14 P1-2) polls the env's flows.
        if (url === '/api/environments/env-1/flows') return jsonResponse({ flows: [] });
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the blueprint list with contents summary and zone picker', async () => {
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    expect(await screen.findByText('教室节能管家')).toBeTruthy();
    expect(screen.getByText('自定义蓝图')).toBeTruthy();
    expect(screen.getByText('内置')).toBeTruthy();
    expect(screen.getByText('2 台设备 · 1 个 Agent · 1 条业务流')).toBeTruthy();
    // Device/agent chips summarize what the blueprint creates.
    expect(screen.getByText('教室温感')).toBeTruthy();
    expect(screen.getByText('节能管家')).toBeTruthy();
    // Each card's zone picker defaults to the world's first zone.
    const selects = screen.getAllByLabelText('目标区域') as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    expect(selects[0].value).toBe('zone-1');
  });

  it('installs into the default zone and toasts the summary', async () => {
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    (await screen.findAllByText('安装'))[0].click();

    await waitFor(() => {
      const installCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]).includes('/blueprints/bp-energy/install'));
      expect(installCall).toBeTruthy();
      expect(JSON.parse(String(installCall?.[1]?.body))).toEqual({ zoneId: 'zone-1' });
    });
    await waitFor(() => {
      expect(useAppStore.getState().toasts.some(toast => toast.text.includes('已安装'))).toBe(true);
    });
  });

  it('installs into the picked zone and toasts server errors', async () => {
    installShouldFail = true;
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    const select = (await screen.findAllByLabelText('目标区域'))[0] as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, 'zone-2');
    select.dispatchEvent(new Event('change', { bubbles: true }));

    screen.getAllByText('安装')[0].click();

    await waitFor(() => {
      const installCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]).includes('/blueprints/bp-energy/install'));
      expect(JSON.parse(String(installCall?.[1]?.body))).toEqual({ zoneId: 'zone-2' });
    });
    await waitFor(() => {
      expect(
        useAppStore.getState().toasts.some(toast => toast.text.includes('安装蓝图失败')),
      ).toBe(true);
    });
  });

  it('pins a one-shot health-check card after a successful install (R14 P1-2)', async () => {
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    (await screen.findAllByText('安装'))[0].click();

    // The card reports the post-install checklist: this world has zones no
    // agent manages, so the finding shows instead of「全部就绪」.
    const card = await screen.findByTestId('health-check-card');
    expect(card.textContent).toContain('安装完成 · 系统体检');
    await waitFor(() => {
      expect(card.textContent).toContain('无 Agent 管理的区域');
      expect(card.textContent).toContain('101 教室');
    });

    // Manual dismiss — the card never reappears on its own.
    screen.getByText('知道了').click();
    await waitFor(() => {
      expect(screen.queryByTestId('health-check-card')).toBeNull();
    });
  });

  it('shows the 建议搭配 hint on cards carrying a partnerSuggestion (R6-D-S3)', async () => {
    listedBlueprints = [PAIR_A, PAIR_B, CUSTOM_BP];
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    const hintA = await screen.findByTestId('pair-hint-co2-monitor');
    expect(hintA.textContent).toContain('建议搭配：新风管家');
    expect(hintA.getAttribute('title')).toContain('同一区域');
    const hintB = screen.getByTestId('pair-hint-fresh-air-manager');
    expect(hintB.textContent).toContain('建议搭配：CO2 监测员');
    // Self-sufficient cards carry no hint.
    expect(screen.queryByTestId('pair-hint-bp-custom')).toBeNull();
  });

  it('installing a pair card pins a one-click partner-install card (R6-D-S3)', async () => {
    listedBlueprints = [PAIR_A, PAIR_B];
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    // Install the producer card into the default zone.
    (await screen.findAllByText('安装'))[0].click();

    // The pair prompt names the partner and offers a one-click install.
    const card = await screen.findByTestId('pair-suggestion-card');
    expect(card.textContent).toContain('建议搭配');
    expect(card.textContent).toContain('新风管家');

    screen.getByText('安装「新风管家」').click();

    // The partner installs into the SAME zone, and the prompt does not
    // ping-pong back to the first card.
    await waitFor(() => {
      const pairCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]).includes('/blueprints/fresh-air-manager/install'));
      expect(pairCall).toBeTruthy();
      expect(JSON.parse(String(pairCall?.[1]?.body))).toEqual({ zoneId: 'zone-1' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('pair-suggestion-card')).toBeNull();
    });
  });

  it('dismissing the pair prompt skips the partner install', async () => {
    listedBlueprints = [PAIR_A, PAIR_B];
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    (await screen.findAllByText('安装'))[0].click();
    const card = await screen.findByTestId('pair-suggestion-card');
    within(card).getByText('知道了').click();

    await waitFor(() => {
      expect(screen.queryByTestId('pair-suggestion-card')).toBeNull();
    });
    expect(
      vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('fresh-air-manager/install')),
    ).toBe(false);
  });

  it('a card without partnerSuggestion does not trigger the pair prompt', async () => {
    renderWithProviders(<BlueprintsPanel world={makeWorld()} />);

    (await screen.findAllByText('安装'))[0].click();

    await screen.findByTestId('health-check-card');
    expect(screen.queryByTestId('pair-suggestion-card')).toBeNull();
  });
});
