/**
 * flowWarnings — save-time advisory warnings for the flow canvas (UX-12).
 *
 * The headline case: a flow that runs `set-brightness` on a lamp that is
 * currently OFF (library-comfort 19:00 flow) produces no visible effect and
 * confuses users. On save, action nodes whose pinned target device is
 * currently off AND whose command surface carries no turn-on get a
 * non-blocking warning.
 *
 * Pure functions only — the page supplies the device power face from the
 * latest sim snapshot and renders the returned warnings. Explicit design
 * decision (PM backlog UX-12): "set-brightness > 0 implies turn-on" is NOT
 * assumed — only an explicit turn-on capability suppresses the warning.
 */

import type { FlowPlanAnyNode, SnapshotDevice } from '../api/types';

/**
 * Coarse on/off face of a device. 'present' = existence without an on/off
 * claim (pure sensors); 'unknown' = the snapshot has no entry for the device
 * (no live session yet) — no honest verdict, never warned on.
 */
export type DevicePowerFace = 'on' | 'off' | 'present' | 'unknown';

/**
 * Derive the power face from a snapshot device entry. Mirrors the server's
 * coarseDeviceStatus (apps/server/src/device-privacy.ts), which in turn
 * mirrors the simulation's powered predicate: full-tier entries expose
 * `state.power` / `state.status`; S2-redacted (coarse) entries carry only the
 * pre-derived `status`.
 */
export function devicePowerFaceOf(
  device: Pick<SnapshotDevice, 'state'> & { status?: string },
): DevicePowerFace {
  if (device.status === 'on' || device.status === 'off' || device.status === 'present') {
    return device.status;
  }
  const state = device.state;
  if (state === null || state === undefined) return 'unknown';
  if (state.power === true) return 'on';
  if (state.status === 'on' || state.status === 'active') return 'on';
  if (state.power === false) return 'off';
  return 'present';
}

/**
 * Turn-on capability names, normalized the same way the simulation resolves
 * commands (lowercase, -/_ stripped; COMMAND_ALIASES in
 * packages/simulation/src/devices/handlers/CommandHandler.ts).
 */
const TURN_ON_NORMALIZED: ReadonlySet<string> = new Set([
  'turnon',
  'on',
  'poweron',
  'switchon',
  'lighton',
]);

/** Is this capability a power-on command for its target device? */
export function isTurnOnCapability(capability: string): boolean {
  return TURN_ON_NORMALIZED.has(capability.toLowerCase().replace(/[-_]/g, ''));
}

/** One off-device warning: the offending action node + its pinned target. */
export interface OffDeviceWarning {
  nodeId: string;
  deviceId: string;
  capability: string;
}

/**
 * Action nodes that actuate a currently-OFF device with no turn-on in the
 * flow's command surface for that device.
 *
 * Scope decisions (honesty over coverage):
 * - Only ACTION nodes (capability shape); delegate/service/notify/wait nodes
 *   have no static command surface.
 * - Only nodes with a deviceId pin — an unpinned node's target is decided at
 *   run time, so "currently off" cannot be honestly determined.
 * - A turn-on suppresses the warning when it is pinned to the same device OR
 *   unpinned (auto-assignment may land it on this device — the benefit of the
 *   doubt goes to the author).
 * - 'unknown'/'present'/'on' faces never warn; turn-on nodes themselves never
 *   warn (turning on an off device is the fix, not the problem).
 */
export function offDeviceWarnings(
  planNodes: readonly FlowPlanAnyNode[],
  powerFaceOf: (deviceId: string) => DevicePowerFace,
): OffDeviceWarning[] {
  const actionNodes = planNodes.filter(
    (node): node is Extract<FlowPlanAnyNode, { capability: string }> => 'capability' in node,
  );
  const turnOnCovers = (deviceId: string) =>
    actionNodes.some(
      node =>
        (node.deviceId === undefined || node.deviceId === deviceId) &&
        isTurnOnCapability(node.capability),
    );
  const warnings: OffDeviceWarning[] = [];
  for (const node of actionNodes) {
    if (node.deviceId === undefined) continue;
    if (isTurnOnCapability(node.capability)) continue;
    if (powerFaceOf(node.deviceId) !== 'off') continue;
    if (turnOnCovers(node.deviceId)) continue;
    warnings.push({ nodeId: node.id, deviceId: node.deviceId, capability: node.capability });
  }
  return warnings;
}
