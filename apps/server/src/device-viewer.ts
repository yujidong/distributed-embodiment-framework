/**
 * Device viewer assembly (R21-W4, audit §3.4) — the ONE per-request
 * viewer-resolution + oracle-wiring helpers for every device-bearing
 * surface.
 *
 * History: five call sites (environments world-stream + detail,
 * env-objects, simulations snapshot/timeline tiers, twin-sync observations)
 * each hand-built the `{userId, isAdmin}` viewer and/or the
 * `deviceOwnershipOracle` wiring against the env store, with per-site
 * admin-comparison quirks. Both assemblies live here now; the projection
 * truth itself stays in device-privacy.ts (projectDeviceJson and the tier
 * decision).
 */

import { isAdminEmail } from './auth/admin.js';
import {
  deviceOwnershipOracle,
  type DeviceOwnership,
  type DeviceViewer,
} from './device-privacy.js';
import type { DeviceInstanceRow } from './db/environment-store.js';

/**
 * The ONE viewer resolution. Admin-ness goes through the single admin truth
 * (auth/admin.ts isAdminEmail), so a mixed-case ADMIN_EMAILS row cannot make
 * two device surfaces disagree about the viewer's tier. Structural `ctx`:
 * any router context carrying an `adminEmails` list.
 */
export function deviceViewerOf(
  ctx: { adminEmails?: readonly string[] },
  user: { id: string; email: string } | null | undefined,
): DeviceViewer {
  return {
    userId: user?.id ?? null,
    ...(user != null && isAdminEmail(user.email, ctx.adminEmails ?? [])
      ? { isAdmin: true }
      : {}),
  };
}

/**
 * The ONE per-request oracle assembly — `deviceOwnershipOracle` wired to the
 * environment store (structural ctx: any store exposing
 * getDevice/getEnvironment), so every redaction site resolves ownership
 * identically.
 */
export function deviceOracleFor(ctx: {
  getDevice: (deviceId: string) => DeviceInstanceRow | undefined;
  getEnvironment: (envId: string) => { owner_id: string } | undefined;
}): (deviceId: string) => DeviceOwnership | undefined {
  return deviceOwnershipOracle(
    deviceId => ctx.getDevice(deviceId),
    envId => ctx.getEnvironment(envId)?.owner_id ?? null,
  );
}
