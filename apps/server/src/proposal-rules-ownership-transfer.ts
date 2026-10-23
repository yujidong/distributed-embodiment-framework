/**
 * ownership-transfer rule check (C3, R42-B — devloop-r41-a1 §8) — the same
 * module-split pattern as proposal-rules-adopt-config.ts (R22 file-size
 * discipline): everything the ownership-transfer proposal kind validates
 * lives here; proposal-rules.ts dispatches `case 'ownership-transfer'`
 * into it.
 *
 * D2-F8 / R41-F5 root cause: template imports land EVERY agent and device
 * on the importer, so other members hit "owned by another user" rejections
 * (install-agents bindings, modify-object) and 403s when naming their own
 * agents as agreement consumers — the multi-stakeholder "I" existed in
 * name only. The sanctioned fix is a governance-plane handover: one
 * proposal moves `agent_instances.owner_id` / `device_instances.owner_id`
 * (optionally carrying an agent's bound devices), always medium + forced
 * owner escalation (D2-F9 discipline — the AI reviewer may never approve a
 * trust-boundary change), fully revertible via the reverse transfer.
 *
 * Boundary (design §8.4): ownership is governance-plane, NOT data-plane —
 * reputation aggregation (by agentId) and already-derived services
 * (provider_agent_id) are untouched by a transfer.
 */

import { parseJsonArray, parseMapData, type EnvironmentRow } from './db/environment-store.js';
import type { AgentInstanceRow, DeviceInstanceRow } from './db/environment-store.js';
import {
  isPlainObject,
  type RuleCheckContext,
  type RuleCheckResult,
} from './proposal-rules.js';

/** Agent-transfer device modes: 'bound' = carry the bound devices along. */
export const OWNERSHIP_TRANSFER_DEVICES_MODES = ['bound', 'keep'] as const;
export type OwnershipTransferDevicesMode = (typeof OWNERSHIP_TRANSFER_DEVICES_MODES)[number];

/** One validated transfer (the apply step consumes these verbatim). */
export interface NormalizedOwnershipTransfer {
  kind: 'agent' | 'device';
  id: string;
  name: string;
  fromUserId: string;
  toUserId: string;
  devices: OwnershipTransferDevicesMode;
  /** The bound device rows an agent transfer with devices:'bound' carries. */
  boundDeviceIds: string[];
}

/**
 * The env's ownership plan (mapData.governance.ownershipPlan, C3): 'members'
 * declares a multi-stakeholder world — its UNASSIGNED objects (still owned
 * by the env owner, i.e. never claimed) may be claimed by builder members
 * through this proposal kind. Default 'importer' = legacy behavior.
 */
export function envOwnershipPlan(env: EnvironmentRow): 'importer' | 'members' {
  return parseMapData(env).governance?.ownershipPlan === 'members' ? 'members' : 'importer';
}

/**
 * Resolve `payload.toUser` (userId or email) to a user id. Returns undefined
 * when the context carries no userStore (minimal test deps) — the caller
 * turns that into a teaching issue, adopt-config's sandboxStore precedent.
 */
function resolveToUser(
  ctx: RuleCheckContext,
  raw: string,
): { userId: string | undefined; note: string } {
  if (raw.includes('@')) {
    const row = ctx.userStore?.findByEmail(raw.toLowerCase());
    return { userId: row?.id, note: `email "${raw}"` };
  }
  const row = ctx.userStore?.findById(raw);
  return { userId: row?.id, note: `user id "${raw}"` };
}

/**
 * C3 rule check: shape + reference integrity, the submitter gate, the
 * toUser membership gate, and the constant medium + forced-escalation
 * verdict. Collects issues (never throws); the normalized transfers land
 * on `result.ownershipTransfers` for the apply step.
 */
export function checkOwnershipTransfer(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  authorId: string,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  const rawTransfers = payload.transfers;
  if (!Array.isArray(rawTransfers) || rawTransfers.length === 0) {
    issues.push(
      'payload.transfers must be a non-empty array of { kind: "agent"|"device", id, toUser, devices? } entries',
    );
    return;
  }
  if (ctx.userStore === undefined) {
    issues.push('ownership-transfer toUser cannot be verified in this context (no user store) — submit through the API server');
    return;
  }

  const members = new Map(ctx.envStore.membersOf(env.id).map(member => [member.user_id, member.role]));
  const plan = envOwnershipPlan(env);
  const seen = new Set<string>();
  const transfers: NormalizedOwnershipTransfer[] = [];

  rawTransfers.forEach((raw, index) => {
    const path = `transfers[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push(`${path} must be an object`);
      return;
    }
    const kind = raw.kind;
    if (kind !== 'agent' && kind !== 'device') {
      issues.push(`${path}.kind must be "agent" | "device"`);
      return;
    }
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
      issues.push(`${path}.id must be a non-empty string`);
      return;
    }
    const id = raw.id.trim();
    if (seen.has(`${kind}:${id}`)) {
      issues.push(`${path} (${kind} "${id}") appears twice in payload.transfers — one transfer per object`);
      return;
    }
    seen.add(`${kind}:${id}`);

    const device: DeviceInstanceRow | undefined = kind === 'device' ? ctx.envStore.getDevice(id) : undefined;
    const agent: AgentInstanceRow | undefined =
      kind === 'agent' && device === undefined ? ctx.envStore.getAgent(id) : undefined;
    const target = device ?? agent;
    if (!target || target.env_id !== env.id) {
      issues.push(`${path}.id references unknown ${kind} "${id}" in this environment`);
      return;
    }
    const fromUserId = target.owner_id;

    // toUser: userId or email, resolved against the user store.
    if (typeof raw.toUser !== 'string' || raw.toUser.trim().length === 0) {
      issues.push(`${path}.toUser must be a user id or email`);
      return;
    }
    const { userId: toUserId, note } = resolveToUser(ctx, raw.toUser.trim());
    if (toUserId === undefined) {
      issues.push(`${path}.toUser (${note}) does not match any registered user`);
      return;
    }
    const role = members.get(toUserId);
    if (role !== 'owner' && role !== 'builder') {
      issues.push(
        `${path}.toUser (${note}) is ${role === undefined ? 'not a member of this environment' : `a ${role} member`} — ` +
          'ownership may only move to the environment owner or a builder member (invite them first: POST /api/environments/{id}/members)',
      );
      return;
    }

    // devices option: agents only, closed enum, default 'keep'.
    let devices: OwnershipTransferDevicesMode = 'keep';
    if (raw.devices !== undefined) {
      if (kind !== 'agent') {
        issues.push(
          `${path}.devices is only valid on agent transfers — a device transfer moves exactly the named device`,
        );
      } else if (!(OWNERSHIP_TRANSFER_DEVICES_MODES as readonly string[]).includes(raw.devices as OwnershipTransferDevicesMode)) {
        issues.push(
          `${path}.devices must be one of ${OWNERSHIP_TRANSFER_DEVICES_MODES.map(m => `"${m}"`).join(' | ')} ` +
          '("bound" carries the agent\'s bound devices along — required before the new owner may bind them; "keep" leaves them with the current owner)',
        );
        return;
      } else {
        devices = raw.devices as OwnershipTransferDevicesMode;
      }
    }

    // No-op guard: transferring to the current holder changes nothing.
    if (toUserId === fromUserId) {
      issues.push(`${path}: ${kind} "${target.name}" already belongs to ${note} — nothing to transfer`);
      return;
    }

    // Submitter gate: the env owner (any transfer) or the CURRENT holder
    // (giving something away), plus the C3 claim path — in a
    // governance.ownershipPlan='members' world, a builder member may claim
    // an UNASSIGNED object (still owned by the env owner) for THEMSELVES;
    // the proposal still escalates, so the owner gates every claim.
    const isEnvOwner = authorId === env.owner_id;
    const isCurrentHolder = authorId === fromUserId;
    const isMemberClaim =
      plan === 'members' &&
      fromUserId === env.owner_id &&
      toUserId === authorId &&
      members.get(authorId) === 'builder';
    if (!isEnvOwner && !isCurrentHolder && !isMemberClaim) {
      const planNote =
        plan === 'members'
          ? ' (this is a members-plan world: you may CLAIM an unassigned object — still owned by the environment owner — by naming yourself as toUser)'
          : ' (the environment owner can initiate any transfer; a members-plan world additionally lets members claim unassigned objects)';
      issues.push(
        `${path}: only the environment owner or the current holder of ${kind} "${target.name}" may transfer it` +
        planNote,
      );
      return;
    }

    // Agent bound devices (existence validated; 'bound' carries them).
    const boundDeviceIds: string[] = [];
    if (agent !== undefined) {
      for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
        const bound = ctx.envStore.getDevice(deviceId);
        if (!bound || bound.env_id !== env.id) {
          issues.push(`${path}: agent "${agent.name}" has a dangling bound device "${deviceId}"`);
          continue;
        }
        boundDeviceIds.push(deviceId);
      }
    }

    transfers.push({
      kind,
      id,
      name: target.name,
      fromUserId,
      toUserId,
      devices,
      boundDeviceIds,
    });
  });

  if (issues.length > 0 || transfers.length === 0) return;
  result.ownershipTransfers = transfers;

  // C3 verdict: ownership is the trust boundary (device privacy rules and
  // the agreement consumer identity key on owner_id) — constant medium with
  // FORCED owner escalation; the AI reviewer never approves one (D2-F9).
  result.riskLevel = 'medium';
  result.forceEscalate = true;
  result.escalateReason =
    'ownership-transfer reassigns the trust boundary (device privacy + agreement-consumer identity) — ' +
    'the environment owner must decide (C3, D2-F9 discipline)';

  // Boundary honesty (§8.4): the transfer is governance-plane only.
  result.warnings.push(
    'ownership is governance-plane: reputation (aggregated by agentId) and already-derived services ' +
    '(provider_agent_id) are NOT affected by this transfer',
  );
}
