/**
 * Device-command ownership gates (POST /api/simulations/:id/commands) —
 * the three actuation boundaries that key on WHO owns the device, split
 * out of routes/simulations.ts at the arch-guard size ceiling
 * (R21-W1 house pattern: gates live in a service module, routes consume).
 *
 * Gate order (deliberate — first failure wins):
 * 1. hass:// (Fix-9, R4-P1): a device bound to real hardware is only ever
 *    commandable by its owner — even inside a simulation, because
 *    twin-sync/actuation can forward the command to REAL hardware.
 * 2. World session (T-401, R19/CC-F01): the env's AUTHORITATIVE world
 *    session writes back to the shared world for real, so the sandbox
 *    exemption does not apply — device owner / env owner / admin /
 *    unowned only, everyone else 403 pointing at the metered agreement
 *    invocation lane. STRICTER than gate 3 on purpose: no importer-shared
 *    or agreement carve-outs here (real shared-world effect = the
 *    agreement lane's terms/quota/metering).
 * 3. Org boundary (R46, P0-2): every OTHER env-backed sim. The sim
 *    channel used to keep Fix-9's any-device sandbox, so a builder could
 *    drive ANOTHER org's device (供电局开了水务的阀门, 200). Now: another
 *    member's device is 403 with a teaching message, EXCEPT
 *      a. the device owner themself,
 *      b. the env owner (importer — world-session parity),
 *      c. the device is still IMPORTER-owned (owner_id = env owner) —
 *         shared-sandbox semantics for assets nobody has been assigned
 *         (single-user worlds and unassigned leftovers keep working),
 *      d. an ACTIVE agreement authorizes the caller: its consumer is the
 *         caller and its provider agent manages this device (the
 *         sanctioned cross-org lane for the rehearsal channel; a HELD
 *         agreement does not authorize — the consumer's own pause).
 *   Admins never reach the gates (isAdmin is precomputed by the route;
 *   Fix-47: admins may control any simulation).
 */

import { parseJsonArray, type EnvironmentStore } from './db/environment-store.js';
import type { AgreementStore } from './db/agreement-store.js';
import type { UserStore } from './db/user-store.js';
import type { AuthUser } from './auth/index.js';
import { ApiError } from './errors.js';

/** The stores the gates need (SimulationRoutesContext satisfies this). */
export interface DeviceCommandGateContext {
  envStore?: EnvironmentStore;
  /** Owner display names for the teaching 403s (falls back to raw ids). */
  userStore?: UserStore;
  /** R46 P0-2: the agreement carve-out oracle (absent → fail closed). */
  agreementStore?: AgreementStore;
}

/** The simulation-record slice the gates read. */
export interface DeviceCommandGateRecord {
  environmentId?: string;
  envSession?: boolean;
}

/**
 * Run gates 1–3 for `deviceId`. Only meaningful when the device resolves
 * to a device_instances row of the sim's environment (`environmentId`):
 * legacy scenario sims carry no rows and keep their creator-only rule.
 */
export function assertDeviceCommandGates(
  ctx: DeviceCommandGateContext,
  record: DeviceCommandGateRecord,
  user: AuthUser,
  deviceId: string,
  isAdmin: boolean,
): void {
  if (record.environmentId === undefined || ctx.envStore === undefined) return;

  // Gate 1 — hass:// real-hardware bridge (Fix-9, R4-P1).
  const device = ctx.envStore.getDevice(deviceId);
  if (
    device !== undefined &&
    device.env_id === record.environmentId &&
    device.binding !== null &&
    device.binding.startsWith('hass://') &&
    device.owner_id !== user.id
  ) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Device "${device.name}" (${deviceId}) is bound to real hardware (${device.binding}) — ` +
      'only the device owner may command it, even inside a simulation',
    );
  }

  // Gate 2 — the authoritative world session (T-401, R19/CC-F01).
  if (record.envSession === true && !isAdmin) {
    const envRole = ctx.envStore.roleOf(record.environmentId, user.id);
    if (envRole !== 'owner') {
      if (
        device !== undefined &&
        device.env_id === record.environmentId &&
        device.owner_id !== user.id &&
        device.owner_id != null
      ) {
        const ownerName =
          ctx.userStore?.findById(device.owner_id)?.display_name ?? device.owner_id;
        throw new ApiError(
          403,
          'FORBIDDEN',
          `Device "${device.name}" (${deviceId}) is owned by "${ownerName}" — this simulation ` +
          `is the environment's AUTHORITATIVE world session, so device commands have real ` +
          'shared-world effect and are limited to the device owner, the environment owner, or ' +
          'an admin. To actuate another tenant\'s device with terms, quota and metering, agree ' +
          'with the owner and execute it through the agreement lane: ' +
          'POST /api/agreements/:id/invocations',
        );
      }
    }
  }

  // Gate 3 — org boundary for every other env-backed sim (R46, P0-2).
  if (isAdmin) return;
  if (
    device !== undefined &&
    device.env_id === record.environmentId &&
    device.owner_id != null &&
    device.owner_id !== user.id
  ) {
    const envRole = ctx.envStore.roleOf(record.environmentId, user.id);
    const envOwnerActing = envRole === 'owner';
    const importerOwned =
      ctx.envStore.getEnvironment(record.environmentId)?.owner_id === device.owner_id;
    if (
      !envOwnerActing &&
      !importerOwned &&
      !activeAgreementCoversDevice(ctx, record.environmentId, deviceId, user.id)
    ) {
      const ownerName =
        ctx.userStore?.findById(device.owner_id)?.display_name ?? device.owner_id;
      throw new ApiError(
        403,
        'FORBIDDEN',
        `Device "${device.name}" (${deviceId}) is owned by "${ownerName}" — ` +
        'cross-organization actuation needs a lane: agree with the owner on the service ' +
        '(POST /api/services/{id}/agreements) or claim the asset through governance ' +
        `(ownership-transfer proposal, POST /api/environments/${record.environmentId}/proposals). ` +
        'Sandbox rehearsal does not cross org boundaries.',
      );
    }
  }
}

/**
 * Does an ACTIVE agreement authorize `userId` to operate `deviceId` in
 * `envId`? True when the user is the agreement's CONSUMER and the
 * agreement's PROVIDER agent manages (is bound to) the device — the
 * provider's actuation surface is exactly what the contract covers. Held
 * agreements do NOT authorize (the consumer's own circuit-breaker pause);
 * proposed/countered/suspended/terminated never did.
 */
function activeAgreementCoversDevice(
  ctx: DeviceCommandGateContext,
  envId: string,
  deviceId: string,
  userId: string,
): boolean {
  if (ctx.agreementStore === undefined || ctx.envStore === undefined) return false;
  return ctx.agreementStore.agreementsOfEnv(envId).some(agreement => {
    // v60: retired rows are unlinked and never active — skip null refs.
    if (
      agreement.status !== 'active' ||
      agreement.consumer_owner_id !== userId ||
      agreement.provider_agent_id === null
    ) {
      return false;
    }
    const provider = ctx.envStore!.getAgent(agreement.provider_agent_id);
    return (
      provider !== undefined &&
      parseJsonArray<string>(provider.bound_device_ids_json).includes(deviceId)
    );
  });
}
