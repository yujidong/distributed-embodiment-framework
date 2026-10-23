/**
 * Deployment manifest grouping tests (W5): the 部署 tab's view model —
 * zone-name resolution, the catalog-matched "待采购" set and its price
 * total, and the notes passthrough.
 */

import { describe, expect, it } from 'vitest';

import type { DeploymentManifest } from '../api/types';
import { deploymentView } from '../lib/deployment';

function makeManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    environment: { id: 'env-1', name: '测试环境' },
    myAgents: [],
    devicesToDeploy: [],
    syncBindings: [],
    servicesToOffer: [],
    servicesConsumed: [],
    notes: [],
    ...overrides,
  };
}

const ZONES = [
  { id: 'zone-a', name: '客厅', adjacentZoneIds: [] },
  { id: 'zone-b', adjacentZoneIds: [] },
];

describe('deploymentView', () => {
  it('resolves zone names and marks catalog matches', () => {
    const manifest = makeManifest({
      devicesToDeploy: [
        {
          instanceId: 'd1',
          name: '温湿度计',
          type: 'temp-humidity-sensor',
          zoneId: 'zone-a',
          position: null,
          binding: 'sim://d1',
          deploymentStatus: 'simulation-only',
          catalogModelId: 'm1',
          vendor: 'Xiaomi',
          model: 'LYWSD03MMC',
          priceCny: 29,
          purchaseUrl: 'https://example.com/m1',
        },
        {
          instanceId: 'd2',
          name: '杂牌传感器',
          type: 'misc',
          zoneId: 'zone-b',
          position: null,
          binding: 'sim://d2',
          deploymentStatus: 'simulation-only',
        },
        {
          instanceId: 'd3',
          name: '未知区域设备',
          type: 'misc',
          zoneId: 'zone-ghost',
          position: null,
          binding: 'sim://d3',
          deploymentStatus: 'simulation-only',
        },
      ],
    });
    const view = deploymentView(manifest, ZONES);
    expect(view.deviceRows.map(row => row.zoneName)).toEqual(['客厅', 'zone-b', 'zone-ghost']);
    expect(view.deviceRows.map(row => row.catalogMatched)).toEqual([true, false, false]);
  });

  it('sums the purchasable set (matched models with known prices)', () => {
    const manifest = makeManifest({
      devicesToDeploy: [
        {
          instanceId: 'd1',
          name: 'A',
          type: 't',
          zoneId: 'zone-a',
          position: null,
          binding: 'sim://d1',
          deploymentStatus: 'simulation-only',
          catalogModelId: 'm1',
          priceCny: 100,
        },
        {
          instanceId: 'd2',
          name: 'B',
          type: 't',
          zoneId: 'zone-a',
          position: null,
          binding: 'sim://d2',
          deploymentStatus: 'simulation-only',
          catalogModelId: 'm2',
          // Matched but priceless: counts as purchasable, adds nothing.
        },
        {
          instanceId: 'd3',
          name: 'C',
          type: 't',
          zoneId: 'zone-a',
          position: null,
          binding: 'sim://d3',
          deploymentStatus: 'simulation-only',
        },
      ],
    });
    const view = deploymentView(manifest, ZONES);
    expect(view.purchasableCount).toBe(2);
    expect(view.totalPriceCny).toBe(100);
  });

  it('passes the service sections and notes through untouched', () => {
    const manifest = makeManifest({
      servicesToOffer: [
        {
          id: 's1',
          name: '电表: energy-monitoring',
          semanticType: 'energy-monitoring',
          origin: 'derived',
          backedByDeviceIds: ['d1'],
        },
      ],
      servicesConsumed: [
        {
          id: 's2',
          name: 'Brokerage',
          semanticType: 'energy-trading',
          provider: { agentId: 'a1', agentName: 'AgentA', ownerName: '小B' },
        },
      ],
      notes: ['3 台设备待采购，名录总价约 ¥3596'],
    });
    const view = deploymentView(manifest, ZONES);
    expect(view.servicesToOffer).toEqual(manifest.servicesToOffer);
    expect(view.servicesConsumed).toEqual(manifest.servicesConsumed);
    expect(view.notes).toEqual(['3 台设备待采购，名录总价约 ¥3596']);
  });
});
