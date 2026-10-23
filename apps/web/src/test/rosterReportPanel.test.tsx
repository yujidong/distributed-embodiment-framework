/**
 * RosterReportPanel tests (Fix-37): the owner-only 评分报告 tab — table
 * render from a stubbed GET /api/environments/:id/roster-report, the
 * expandable per-member inventory, and the CSV download link.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, RosterReport } from '../api/types';
import { RosterReportPanel } from '../components/world/RosterReportPanel';
import i18n from '../i18n/config';
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
    owner: { id: 'u-teacher', displayName: '王老师' },
    zones: [],
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

const REPORT: RosterReport = {
  envId: 'env-1',
  envName: '测试环境',
  generatedAt: '2026-08-18T03:00:00Z',
  totalMembers: 2,
  entries: [
    {
      userId: 'u-teacher',
      displayName: '王老师',
      email: 'teacher@example.com',
      role: 'owner',
      counts: { devices: 0, agents: 0, flows: 0, services: 0 },
      inventory: { devices: [], agents: [], flows: [] },
    },
    {
      userId: 'u-student',
      displayName: '小A',
      email: 'a@example.com',
      role: 'builder',
      counts: { devices: 2, agents: 1, flows: 1, services: 1 },
      inventory: {
        devices: [
          { id: 'd1', name: '教室温感', type: 'temperature-sensor' },
          { id: 'd2', name: '教室空调', type: 'hvac' },
        ],
        agents: [{ id: 'a1', name: '节能管家' }],
        flows: [{ id: 'f1', name: '高温自动降温', enabled: false }],
      },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RosterReportPanel', () => {
  // Panel text uses the active i18next bundle; pin to zh-CN so the
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/environments/env-1/roster-report') return jsonResponse(REPORT);
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the per-member grading table with counts and roles', async () => {
    renderWithProviders(<RosterReportPanel world={makeWorld()} />);

    expect(await screen.findByText('小A')).toBeTruthy();
    expect(screen.getByText('王老师')).toBeTruthy();
    expect(screen.getByText('a@example.com')).toBeTruthy();
    expect(screen.getByText('拥有者')).toBeTruthy();
    expect(screen.getByText('协作者')).toBeTruthy();
    // 小A's counts row: 2 devices, 1 agent, 1 flow, 1 service.
    const row = screen.getByText('小A').closest('tr')!;
    expect(row.textContent).toContain('2');
    expect(row.textContent).toContain('1');
    // Summary line with member count.
    expect(screen.getByText(/共 2 名成员/)).toBeTruthy();
  });

  it('links the CSV export and expands the per-member inventory', async () => {
    renderWithProviders(<RosterReportPanel world={makeWorld()} />);

    const csvLink = (await screen.findByText('下载 CSV')) as HTMLAnchorElement;
    expect(csvLink.href).toContain('/api/environments/env-1/roster-report?format=csv');

    (await screen.findAllByText('明细'))[1].click();
    expect(await screen.findByText(/教室温感（temperature-sensor）/)).toBeTruthy();
    expect(screen.getByText(/节能管家/)).toBeTruthy();
    expect(screen.getByText(/高温自动降温（停用）/)).toBeTruthy();
  });
});
