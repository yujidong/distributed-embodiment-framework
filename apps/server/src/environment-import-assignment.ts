/**
 * R46 (P0-1) — body parsing for import-time invites + ownership assignment
 * (资产归属下放). Split out of routes/environments.ts at the arch-guard
 * size ceiling. The route validates the BODY here (unknown email 404,
 * invalid regex / shape 400 — before any world-building starts); the
 * membership rows and the owner handover itself land inside the import
 * transaction (environment-import.ts).
 */

import { ApiError } from './errors.js';
import type { UserStore } from './db/user-store.js';
import type { ImportInvite, OwnerAssignmentPlan, OwnerAssignmentRule } from './environment-import.js';

/**
 * Parse the import body's `invites` array — `[{ email, role?:
 * 'builder' | 'viewer' }]` (role defaults to builder, the same
 * immediate-effect semantics as POST /api/environments/:id/members).
 * Emails resolve to registered users HERE (unknown → 404 USER_NOT_FOUND;
 * for not-yet-registered addresses use the pending-invite lane
 * POST /api/environments/{id}/members:batch); duplicates are deduped.
 */
export function parseImportInvites(userStore: UserStore, raw: unknown): ImportInvite[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "invites" must be an array of {email, role?} objects');
  }
  const invites: ImportInvite[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const where = `invites[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object ({email, role?})`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.email !== 'string' || record.email.trim().length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.email must be a non-empty string`);
    }
    const email = record.email.trim().toLowerCase();
    let role: 'builder' | 'viewer' = 'builder';
    if (record.role !== undefined) {
      if (record.role !== 'builder' && record.role !== 'viewer') {
        throw new ApiError(400, 'BAD_REQUEST', `${where}.role must be "builder" or "viewer"`);
      }
      role = record.role;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    const target = userStore.findByEmail(email);
    if (!target) {
      throw new ApiError(
        404,
        'USER_NOT_FOUND',
        `No registered user with email "${email}" — for not-yet-registered addresses use the ` +
        'pending-invite lane (POST /api/environments/{id}/members:batch) after the import',
      );
    }
    invites.push({ userId: target.id, email, role });
  }
  return invites;
}

/**
 * Parse the import body's `ownerAssignment` plan —
 * `{ agents: [{agentNamePattern, toUserEmail}], devices?: [...] }`.
 * Patterns are regex sources compiled HERE (invalid regex → teaching 400);
 * emails resolve to users HERE (unknown → 404). Membership is NOT checked
 * here — it can only be established by the import itself (invites), so the
 * invariant is enforced inside the import transaction.
 */
export function parseOwnerAssignment(
  userStore: UserStore,
  raw: unknown,
): OwnerAssignmentPlan | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "ownerAssignment" must be an object: { agents: [{agentNamePattern, toUserEmail}], devices?: [{deviceNamePattern, toUserEmail}] }',
    );
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.agents)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "ownerAssignment.agents" must be an array of {agentNamePattern, toUserEmail} rules',
    );
  }
  if (record.devices !== undefined && !Array.isArray(record.devices)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "ownerAssignment.devices" must be an array of {deviceNamePattern, toUserEmail} rules',
    );
  }
  const parseRules = (section: 'agents' | 'devices', rows: unknown[], patternField: string): OwnerAssignmentRule[] =>
    rows.map((row, index) => {
      const where = `ownerAssignment.${section}[${index}]`;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object {${patternField}, toUserEmail}`);
      }
      const entry = row as Record<string, unknown>;
      if (typeof entry[patternField] !== 'string' || (entry[patternField] as string).length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', `${where}.${patternField} must be a non-empty string (regex over the imported name)`);
      }
      if (typeof entry.toUserEmail !== 'string' || entry.toUserEmail.trim().length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', `${where}.toUserEmail must be a non-empty string`);
      }
      const email = entry.toUserEmail.trim().toLowerCase();
      let pattern: RegExp;
      try {
        pattern = new RegExp(entry[patternField] as string);
      } catch (error) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `${where}.${patternField} is not a valid regex (${String(error)}) — ` +
          'patterns are regular expressions matched against the imported instance NAME, e.g. "变电站" or "学校|中小学"',
        );
      }
      const target = userStore.findByEmail(email);
      if (!target) {
        throw new ApiError(
          404,
          'USER_NOT_FOUND',
          `No registered user with email "${email}" (ownerAssignment target)`,
        );
      }
      return { pattern, toUserId: target.id, toUserEmail: email };
    });
  return {
    agents: parseRules('agents', record.agents, 'agentNamePattern'),
    ...(record.devices !== undefined
      ? { devices: parseRules('devices', record.devices, 'deviceNamePattern') }
      : {}),
  };
}
