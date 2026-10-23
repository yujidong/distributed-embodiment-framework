/**
 * R82 declarative zone rooms — the web zone detail renders the rooms section
 * (code · name · hours rows) when the world carries them, and nothing when it
 * doesn't. Data flow (scenario → import → EnvZone.rooms) is guarded on the
 * server by environment-roundtrip; this pins the consumer side.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { WorldSidebar } from '../components/world/WorldSidebar';
import { renderWithProviders } from './testUtils';

function makeWorld(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    id: 'env-1',
    name: 'campus',
    description: '',
    mapType: 'geo',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-me', displayName: '小A' },
    zones: [
      {
        id: 'bldg-a-f1',
        name: 'A栋 1F',
        bounds: { minX: 0, maxX: 40, minY: 0, maxY: 30 },
        rooms: [
          {
            code: 'A-0001',
            name: '食堂 Life & Hope',
            type: 'canteen',
            hours: 'Mon-Fri 11:00-13:00',
            pos: [0.2, 0.3],
          },
          { name: '讨论间' },
        ],
      },
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
    myRole: 'viewer',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('zone detail rooms section (R82)', () => {
  beforeEach(() => {
    void i18n.changeLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ user: null, selection: null, selectedServiceId: null });
  });

  it('renders room rows with code, name and hours for zones that carry them', () => {
    const world = makeWorld();
    useAppStore.setState({ selection: { objectType: 'zone', id: 'bldg-a-f1' } });
    renderWithProviders(<WorldSidebar world={world} tab="devices" onTabChange={() => {}} />);

    // Rooms sit behind the standard progressive-disclosure toggle.
    expect(screen.queryByText('A-0001')).toBeNull();
    fireEvent.click(screen.getByText('Rooms (2)'));
    expect(screen.getByText('A-0001')).toBeTruthy();
    expect(screen.getByText('食堂 Life & Hope · Mon-Fri 11:00-13:00')).toBeTruthy();
    // a room without code/type falls back to the neutral bullet label
    expect(screen.getByText('讨论间')).toBeTruthy();

    // floor mini-map: outline + one dot per positioned room (pos)
    const plan = document.querySelector('.zone-floor-plan');
    expect(plan).toBeTruthy();
    expect(document.querySelectorAll('.zone-floor-plan__room')).toHaveLength(1);
  });

  it('renders no floor mini-map when no room carries a position', () => {
    const world = makeWorld({
      zones: [{ id: 'bldg-b-f1', name: 'B栋 1F', bounds: { minX: 0, maxX: 40, minY: 0, maxY: 30 } }],
    });
    useAppStore.setState({ selection: { objectType: 'zone', id: 'bldg-b-f1' } });
    renderWithProviders(<WorldSidebar world={world} tab="devices" onTabChange={() => {}} />);

    expect(screen.queryByText('Rooms (')).toBeNull();
    expect(document.querySelector('.zone-floor-plan')).toBeNull();
  });

  it('renders no rooms section when the zone has none (backward compatible)', () => {
    const world = makeWorld({ zones: [{ id: 'bldg-b-f1', name: 'B栋 1F' }] });
    useAppStore.setState({ selection: { objectType: 'zone', id: 'bldg-b-f1' } });
    renderWithProviders(<WorldSidebar world={world} tab="devices" onTabChange={() => {}} />);

    expect(screen.queryByText(/Rooms \(/)).toBeNull();
  });
});
