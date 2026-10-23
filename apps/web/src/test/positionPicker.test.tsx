/**
 * UX-W4 position picker — coordinate conversions (lib/positionPicker) and
 * the click-to-fill behavior (ZonePositionPicker + DeviceForm embedding).
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { EnvironmentDetail, EnvZone } from '../api/types';
import { DeviceForm } from '../components/world/DeviceForm';
import { ZonePositionPicker } from '../components/world/ZonePositionPicker';
import i18n from '../i18n/config';
import { geoToPlan, gridToPlan, planOutline, planToGrid } from '../lib/positionPicker';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, listCatalog: vi.fn().mockResolvedValue([]) };
});
void api;

const GRID_ZONE: EnvZone = {
  id: 'living-room',
  name: '客厅',
  bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
} as EnvZone;

const GEO_ZONE: EnvZone = {
  id: 'plaza',
  name: '广场',
  polygon: [
    [31.0, 120.0],
    [31.0, 120.002],
    [30.998, 120.002],
    [30.998, 120.0],
  ],
} as EnvZone;

function makeGridWorld(): EnvironmentDetail {
  return {
    id: 'env-1',
    name: 'grid-world',
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
    zones: [GRID_ZONE],
    events: [],
    devices: [
      {
        id: 'dev-1',
        name: '旧传感器',
        type: 'sensor',
        capabilities: ['sense_temperature'],
        zoneId: 'living-room',
        position: { x: 3, y: 2.5 },
        initialState: null,
        brand: null,
      },
    ],
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
  } as unknown as EnvironmentDetail;
}

/** jsdom has no layout — give the SVG a deterministic 200×100 rect. */
function stubSvgRect(svg: Element, rect = { left: 0, top: 0, width: 200, height: 100 }) {
  svg.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ user: null, devicePick: null, toasts: [] });
});

describe('positionPicker geometry (pure)', () => {
  it('planOutline: grid bounds → full rect; polygon → bbox-normalized (north edge v=0); none → null', () => {
    expect(planOutline(GRID_ZONE)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    const outline = planOutline(GEO_ZONE);
    expect(outline).not.toBeNull();
    // north edge (lat 31.0) maps to v=0; west edge (lng 120.0) to u=0.
    expect(outline![0]).toEqual([0, 0]);
    expect(outline![2]).toEqual([100, 100]);
    expect(planOutline({ id: 'z' } as EnvZone)).toBeNull();
  });

  it('gridToPlan / planToGrid round-trip through zone-bounds world units', () => {
    const plan = gridToPlan(GRID_ZONE, { x: 3, y: 2.5 });
    expect(plan).toEqual({ u: 50, v: 50 });
    const world = planToGrid(GRID_ZONE, plan!);
    expect(world).toEqual({ x: 3, y: 2.5 });
    // offset bounds: min corner → (0, 0), max corner → (100, 100)
    const offset: EnvZone = { id: 'z', bounds: { minX: 10, maxX: 20, minY: -5, maxY: 5 } } as EnvZone;
    expect(gridToPlan(offset, { x: 10, y: -5 })).toEqual({ u: 0, v: 0 });
    expect(planToGrid(offset, { u: 100, v: 100 })).toEqual({ x: 20, y: 5 });
  });

  it('planToGrid clamps clicks outside the plan into the bounds', () => {
    expect(planToGrid(GRID_ZONE, { u: -10, v: 250 })).toEqual({ x: 0, y: 5 });
  });

  it('geoToPlan normalizes to the polygon bbox (north → v=0)', () => {
    expect(geoToPlan(GEO_ZONE, { lat: 31.0, lng: 120.0 })).toEqual({ u: 0, v: 0 });
    expect(geoToPlan(GEO_ZONE, { lat: 30.998, lng: 120.002 })).toEqual({ u: 100, v: 100 });
    expect(geoToPlan(GRID_ZONE, { lat: 31.0, lng: 120.0 })).toBeNull();
  });
});

describe('ZonePositionPicker component', () => {
  it('grid: click converts through the SVG rect into world units', () => {
    const onPick = vi.fn();
    renderWithProviders(
      <ZonePositionPicker zone={GRID_ZONE} isGeo={false} interactive devices={[]} current={null} onPick={onPick} />,
    );
    const svg = document.querySelector('.zone-position-picker')!;
    stubSvgRect(svg);
    fireEvent.click(svg, { clientX: 100, clientY: 50 });
    expect(onPick).toHaveBeenCalledWith({ x: 3, y: 2.5 });
  });

  it('grid: renders device reference dots (excluding the edited device) and the current marker', () => {
    const world = makeGridWorld();
    renderWithProviders(
      <ZonePositionPicker
        zone={GRID_ZONE}
        isGeo={false}
        interactive
        devices={world.devices}
        excludeDeviceId="dev-1"
        current={{ x: 1.5, y: 1.25 }}
        onPick={() => {}}
      />,
    );
    // the edited device is excluded → no reference dot
    expect(document.querySelectorAll('.zone-position-picker__device')).toHaveLength(0);
    const marker = document.querySelector('.zone-position-picker__marker');
    expect(marker).toBeTruthy();
    expect(marker!.getAttribute('cx')).toBe('25');
    expect(marker!.getAttribute('cy')).toBe('25');
  });

  it('geo: read-only preview — clicks never call onPick', () => {
    const onPick = vi.fn();
    renderWithProviders(
      <ZonePositionPicker
        zone={GEO_ZONE}
        isGeo
        interactive={false}
        devices={[]}
        current={{ lat: 31.0, lng: 120.0 }}
        onPick={onPick}
      />,
    );
    const svg = document.querySelector('.zone-position-picker')!;
    stubSvgRect(svg);
    fireEvent.click(svg, { clientX: 100, clientY: 50 });
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector('.zone-position-picker__marker')).toBeTruthy();
  });

  it('returns null for a zone with neither bounds nor polygon', () => {
    const { container } = renderWithProviders(
      <ZonePositionPicker zone={{ id: 'z' } as EnvZone} isGeo={false} interactive devices={[]} current={null} />,
    );
    expect(container.querySelector('.zone-position-picker')).toBeNull();
  });
});

describe('DeviceForm position picker embedding', () => {
  it('grid: clicking the plan fills the X/Y inputs; existing devices render as dots', () => {
    renderWithProviders(<DeviceForm world={makeGridWorld()} device={null} onClose={() => {}} />);
    const svg = document.querySelector('.zone-position-picker')!;
    expect(svg).toBeTruthy();
    expect(document.querySelectorAll('.zone-position-picker__device')).toHaveLength(1);
    expect(screen.getByText(/点击平面图设置位置/)).toBeTruthy();

    stubSvgRect(svg);
    fireEvent.click(svg, { clientX: 100, clientY: 50 });
    expect((screen.getByPlaceholderText('X') as HTMLInputElement).value).toBe('3');
    expect((screen.getByPlaceholderText('Y') as HTMLInputElement).value).toBe('2.5');

    // the filled position shows up as the marker, re-clickable
    expect(document.querySelector('.zone-position-picker__marker')).toBeTruthy();
    fireEvent.click(svg, { clientX: 0, clientY: 0 });
    expect((screen.getByPlaceholderText('X') as HTMLInputElement).value).toBe('0');
    expect((screen.getByPlaceholderText('Y') as HTMLInputElement).value).toBe('0');
  });

  it('en-US: picker hint is localized', () => {
    void i18n.changeLanguage('en-US');
    renderWithProviders(<DeviceForm world={makeGridWorld()} device={null} onClose={() => {}} />);
    expect(screen.getByText(/Click the plan to set the position/)).toBeTruthy();
  });

  it('geo: the form shows the read-only plan preview next to the map-pick channel', () => {
    const world = { ...makeGridWorld(), mapType: 'geo', zones: [GEO_ZONE], devices: [] } as EnvironmentDetail;
    renderWithProviders(<DeviceForm world={world} device={null} onClose={() => {}} />);
    expect(document.querySelector('.zone-position-picker')).toBeTruthy();
    expect(screen.getByText(/平面图预览——位置仍由上方地图点选设置/)).toBeTruthy();
    // map-pick channel untouched
    expect(screen.getByText('地图点选')).toBeTruthy();
  });
});
