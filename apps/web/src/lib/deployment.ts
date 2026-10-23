/**
 * Deployment-manifest helpers (W5) — group the GET …/deployment payload
 * into the sidebar tab's render model: the 待采购设备 table (with zone
 * names resolved and a price total), the offer/consumed service sections,
 * and the exportable JSON blob.
 */

import type { DeploymentDevice, DeploymentManifest, EnvZone } from '../api/types';

/** One row of the 待采购设备 table. */
export interface DeploymentDeviceRow extends DeploymentDevice {
  zoneName: string;
  /** True when the device joined exactly one active catalog model. */
  catalogMatched: boolean;
}

export interface DeploymentView {
  deviceRows: DeploymentDeviceRow[];
  /** Devices with an unambiguous catalog match (the "待采购" set). */
  purchasableCount: number;
  /** Sum of known catalog prices over the purchasable set. */
  totalPriceCny: number;
  servicesToOffer: DeploymentManifest['servicesToOffer'];
  servicesConsumed: DeploymentManifest['servicesConsumed'];
  notes: string[];
}

/** Group a manifest for display (zone ids → display names, totals). */
export function deploymentView(
  manifest: DeploymentManifest,
  zones: readonly EnvZone[],
): DeploymentView {
  const zoneNameById = new Map(zones.map(zone => [zone.id, zone.name ?? zone.id]));
  const deviceRows = manifest.devicesToDeploy.map(device => ({
    ...device,
    zoneName: zoneNameById.get(device.zoneId) ?? device.zoneId,
    catalogMatched: device.catalogModelId !== undefined,
  }));
  const purchasable = deviceRows.filter(row => row.catalogMatched);
  return {
    deviceRows,
    purchasableCount: purchasable.length,
    totalPriceCny: purchasable.reduce((sum, row) => sum + (row.priceCny ?? 0), 0),
    servicesToOffer: manifest.servicesToOffer,
    servicesConsumed: manifest.servicesConsumed,
    notes: manifest.notes,
  };
}

/** Trigger a browser download of the manifest as pretty-printed JSON. */
export function downloadManifest(manifest: DeploymentManifest): void {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `deployment-${manifest.environment.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
