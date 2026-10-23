/**
 * R76-F2 (blank-canvas onboarding) — the CatalogPanel empty state.
 *
 * A world created via 「新建环境 → 空白」 has 0 zones, which dead-ended the
 * whole placement flow (empty zone dropdown, no guidance). The panel now
 * shows a first-zone guide with inline creation: the owner creates directly
 * (POST …/zones), the builder's call converts server-side into an
 * install-zones proposal (T-055) and the panel says so.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import { CatalogPanel } from '../components/world/CatalogPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const listCatalogMock = vi.fn();
const createZoneMock = vi.fn();
const getMyQuotasMock = vi.fn();
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listCatalog: (...args: Parameters<typeof actual.listCatalog>) => listCatalogMock(...args),
    createZone: (...args: Parameters<typeof actual.createZone>) => createZoneMock(...args),
    getMyQuotas: (...args: Parameters<typeof actual.getMyQuotas>) => getMyQuotasMock(...args),
  };
});

function makeWorld(myRole: 'owner' | 'builder', zones: EnvironmentDetail['zones'] = []): EnvironmentDetail {
  return {
    id: 'env-blank',
    name: '空白环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-owner', displayName: '王老师' },
    zones,
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
    myRole,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('CatalogPanel blank-canvas empty state (R76-F2)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    useAppStore.setState({ toasts: [] });
    listCatalogMock.mockResolvedValue([]);
    getMyQuotasMock.mockRejectedValue(new Error('no quotas in test'));
    createZoneMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('owner of a 0-zone world sees the first-zone guide and creates it inline', async () => {
    createZoneMock.mockResolvedValue({ id: 'lobby', name: 'Lobby 大厅' });
    renderWithProviders(<CatalogPanel world={makeWorld('owner')} />);

    expect(await screen.findByText(/先创建第一个区域/)).toBeTruthy();
    fireEvent.click(screen.getByText('创建第一个区域'));
    fireEvent.change(screen.getByPlaceholderText('区域名称，如：一楼大厅'), {
      target: { value: 'Lobby 大厅' },
    });
    fireEvent.click(screen.getByText('创建区域'));

    await waitFor(() => {
      expect(createZoneMock).toHaveBeenCalledWith('env-blank', { id: 'lobby', name: 'Lobby 大厅' });
    });
    await waitFor(() => {
      expect(useAppStore.getState().toasts.some(t => t.text.includes('已创建区域「Lobby 大厅」'))).toBe(true);
    });
    // The builder-only proposal hint never shows for the owner.
    expect(screen.queryByText(/提交为提案/)).toBeNull();
  });

  it('builder sees the proposal hint; submit surfaces the proposal toast', async () => {
    createZoneMock.mockResolvedValue({ id: 'prop-1', kind: 'install-zones', status: 'escalated' });
    renderWithProviders(<CatalogPanel world={makeWorld('builder')} />);

    expect(await screen.findByText(/提交为提案/)).toBeTruthy();
    fireEvent.click(screen.getByText('创建第一个区域'));
    fireEvent.change(screen.getByPlaceholderText('区域名称，如：一楼大厅'), {
      target: { value: 'Garden 花园' },
    });
    fireEvent.click(screen.getByText('创建区域'));

    await waitFor(() => {
      expect(createZoneMock).toHaveBeenCalledWith('env-blank', { id: 'garden', name: 'Garden 花园' });
    });
    await waitFor(() => {
      expect(useAppStore.getState().toasts.some(t => t.text.includes('区域提案已提交'))).toBe(true);
    });
  });

  it('a rule-rejected proposal teaches the issue in place (form stays open)', async () => {
    createZoneMock.mockResolvedValue({
      id: 'prop-2',
      kind: 'install-zones',
      status: 'rejected',
      ruleCheck: { ok: false, issues: ['zones[0].id "lobby" already exists in this environment'] },
    });
    renderWithProviders(<CatalogPanel world={makeWorld('builder')} />);

    fireEvent.click(await screen.findByText('创建第一个区域'));
    fireEvent.change(screen.getByPlaceholderText('区域名称，如：一楼大厅'), {
      target: { value: '大厅' },
    });
    fireEvent.click(screen.getByText('创建区域'));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    // Form stays open for fix-and-resubmit.
    expect(screen.getByText('创建区域')).toBeTruthy();
  });

  it('no guide once the world has zones', async () => {
    renderWithProviders(
      <CatalogPanel
        world={makeWorld('owner', [{ id: 'lobby', name: '大厅' }])}
      />,
    );
    await waitFor(() => expect(listCatalogMock).toHaveBeenCalled());
    expect(screen.queryByText(/先创建第一个区域/)).toBeNull();
    expect(screen.queryByText('创建第一个区域')).toBeNull();
  });
});
