/**
 * T-028/EA-F04 sidebar deep links: ?tab= parsing accepts 'replayShare'
 * (it used to silently fall back to devices), and tab switches WRITE ?tab=
 * back to the URL (replace) so a URL copied after navigating still opens
 * the same tab — the documented deep-link pattern (?tab=blueprints).
 *
 * UX-03: an UNKNOWN ?tab= still falls back to devices, but no longer
 * silently — the user gets a toast naming the value; valid/absent values
 * stay quiet (unknownSidebarTab is the pure decision point).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import { unknownSidebarTab, WorldViewPage } from '../pages/WorldViewPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

// reactflow (grid canvas) needs measurement APIs jsdom lacks; the geo/3d
// canvases pull heavy deps — stub all three.
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));
vi.mock('../components/worldmap/GeoWorldMap', () => ({
  GeoWorldMap: () => <div data-testid="geo-map" />,
}));
// 3D slot: Babylon CampusScene (replaced the three.js Building3DView).
vi.mock('../components/campus/CampusScene', () => ({
  CampusScene: () => <div data-testid="building-3d" />,
}));

const WORLD = {
  id: 'env-1',
  name: '链接测试环境',
  description: '',
  visibility: 'public',
  myRole: 'builder',
  mapData: null,
  zones: [],
  devices: [],
  agents: [],
  services: [],
  members: [],
  mySubscriptions: [],
} as unknown as EnvironmentDetail;

/** Mirrors the router's current search string for assertions. */
let currentSearch = '';
function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  // UX-W1: jsdom 默认视口 1024 正好命中抽屉断点（侧栏默认收起）——本套件
  // 断言侧栏 tab 内容，钉宽视口让侧栏保持默认展开。
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {}
    },
  );
  useAppStore.setState({
    user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
    world: WORLD,
    worldLoading: false,
    worldError: null,
    worldStreamStatus: 'idle',
    simulationId: null,
    simulationError: null,
    selection: null,
    layers: { zones: true, devices: true, agents: true, edges: true },
    onlineUsers: [],
    onlineAnonymousCount: 0,
    geoPlacement: null,
    devicePick: null,
    zoneDraw: null,
    toasts: [],
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  currentSearch = '';
});

describe('sidebar ?tab= deep links (T-028/EA-F04)', () => {
  it('?tab=replayShare opens the 分享 tab (used to fall back to devices)', async () => {
    renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=replayShare'] },
    );

    // The share panel's own title renders — the tab actually landed.
    expect(await screen.findByText('回放分享')).toBeTruthy();
    expect(currentSearch).toContain('tab=replayShare');
  });

  it('switching tabs writes ?tab= back to the URL', async () => {
    renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=devices'] },
    );

    // Sidebar is mounted; switch to 蓝图 (the tab OnboardingChecklist
    // deep-links to). Only one tab carries this label.
    const blueprintTab = await screen.findByText('蓝图');
    fireEvent.click(blueprintTab);

    // The panel mounts (loading/failed/empty state of the blueprints list —
    // fetch is unstubbed, any of the three is fine) and the URL now carries
    // the tab, so a copied link reopens it.
    expect(screen.getAllByText(/加载蓝图中|蓝图列表加载失败|暂无可用蓝图|还没有区域/).length).toBeGreaterThan(0);
    await waitFor(() => expect(currentSearch).toContain('tab=blueprints'));
  });

  it('?tab=sandboxes opens the 沙盒 tab (used to fall back to devices)', async () => {
    const { container } = renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=sandboxes'] },
    );

    await waitFor(() =>
      expect(container.querySelector('.world-tab--active')?.textContent).toContain('沙盒'),
    );
    expect(currentSearch).toContain('tab=sandboxes');
  });

  it('?tab=externalChannel opens the 对外通道 tab (used to fall back to devices)', async () => {
    const { container } = renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=externalChannel'] },
    );

    await waitFor(() =>
      expect(container.querySelector('.world-tab--active')?.textContent).toContain('对外通道'),
    );
  });

  it('?tab=rosterReport falls back to devices for a non-owner (owner-only panel)', async () => {
    // WORLD.myRole is 'builder' — the roster-report route is owner-gated, so
    // the deep link must not activate the tab.
    const { container } = renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=rosterReport'] },
    );

    await waitFor(() =>
      expect(container.querySelector('.world-tab--active')?.textContent).toContain('设备'),
    );
  });
});

describe('unknown ?tab= values (UX-03)', () => {
  it('unknownSidebarTab is the pure decision point: null for absent/known, the raw value otherwise', () => {
    expect(unknownSidebarTab(null)).toBeNull();
    expect(unknownSidebarTab('devices')).toBeNull();
    expect(unknownSidebarTab('replayShare')).toBeNull();
    expect(unknownSidebarTab('bogus')).toBe('bogus');
  });

  it('?tab=bogus lands on devices WITH a toast naming the value', async () => {
    const { container } = renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=bogus'] },
    );

    await waitFor(() =>
      expect(container.querySelector('.world-tab--active')?.textContent).toContain('设备'),
    );
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.some(toast => toast.text.includes('bogus'))).toBe(true);
    });
  });

  it('a known ?tab= stays quiet (no toast)', async () => {
    renderWithProviders(
      <>
        <WorldViewPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/environments/env-1?tab=devices'] },
    );

    await screen.findByText('蓝图');
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });
});
