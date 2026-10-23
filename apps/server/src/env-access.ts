/**
 * Environment access control — role and visibility checks shared by routes
 *
 * Read access: any member, or anyone (including anonymous) when the
 * environment is public. Write access is role-gated:
 * - owner  — environment patch/delete, plus every object mutation
 * - builder — create device/agent instances
 * - viewer — read-only
 * Individual device/agent mutations require ownership of the OBJECT or
 * ownership of the ENVIRONMENT (builders cannot touch each other's objects).
 */

import { ApiError } from './errors.js';
import type { AuthUser } from './auth/index.js';
import type {
  EnvironmentRow,
  EnvironmentStore,
  EnvRole,
} from './db/environment-store.js';

/**
 * Environment name cap (Fix-6, usability F-10): a 100 KB name used to be
 * accepted verbatim. 200 chars is generous for a display name and keeps
 * list/detail payloads sane. Enforced on every environment-creation and
 * rename path (empty-world POST, PATCH, scenario import).
 */
export const MAX_ENV_NAME_LENGTH = 200;

/** Throw 400 when an environment name exceeds MAX_ENV_NAME_LENGTH. */
export function assertEnvNameLength(name: string): void {
  if (name.length > MAX_ENV_NAME_LENGTH) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Environment name is too long (${name.length} chars) — the limit is ${MAX_ENV_NAME_LENGTH}`,
    );
  }
}

/**
 * Load an environment or throw the standard 404.
 *
 * R13 (IB-F05/CB-F05 root cause): a literal "undefined"/"null" id is almost
 * never a real lookup miss — the caller string-interpolated a void read from
 * a create response that FAILED (4xx) or from the wrong field. The R13
 * bootstrap's members:batch hit `/api/environments/undefined/…`, 404'd, and
 * the orchestrator believed "added:2" — both builders then 403'd on their
 * first governed call. Teaching the literal-void case at the boundary makes
 * the next occurrence attributable from the response alone (same philosophy
 * as T-062's attributable 401s).
 */
export function getEnvironmentOrThrow(store: EnvironmentStore, id: string): EnvironmentRow {
  const env = store.getEnvironment(id);
  if (!env) {
    const literalVoid = id === 'undefined' || id === 'null' || id === '[object Object]';
    throw new ApiError(
      404,
      'ENVIRONMENT_NOT_FOUND',
      `Environment "${id}" not found` + (literalVoid
        ? ` — the id is the literal string "${id}", which usually means the creating call failed ` +
          'and its response id was read anyway; check the create call\'s HTTP status and body first'
        : ''),
    );
  }
  return env;
}

/** Can `user` (possibly anonymous) read this environment? */
export function canReadEnvironment(env: EnvironmentRow, role: EnvRole | undefined): boolean {
  return env.visibility === 'public' || role !== undefined;
}

/** Assert read access; 403 for strangers on private environments. */
export function requireReadAccess(
  env: EnvironmentRow,
  role: EnvRole | undefined,
): void {
  if (!canReadEnvironment(env, role)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Environment "${env.id}" is private and you are not a member`,
    );
  }
}

/** Assert the user has one of `roles` in the environment; 403 otherwise. */
export function requireEnvRole(
  store: EnvironmentStore,
  envId: string,
  user: AuthUser,
  roles: readonly EnvRole[],
): EnvRole {
  const role = store.roleOf(envId, user.id);
  if (role === undefined || !roles.includes(role)) {
    // Fix-46 (B-agent P2-4): when the caller IS a viewer, say so in their
    // terms — the generic "requires owner|builder" left viewers guessing
    // whether they were missing something or were simply read-only.
    const viewerNote = role === 'viewer'
      ? ' — you have the viewer (read-only) role in this environment; viewers cannot make changes. ' +
        'To edit, ask the environment owner to promote you to builder.'
      : role === undefined
        ? ' — you are not a member of this environment; join it or ask the owner for access.'
        : '';
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Environment "${envId}" requires role ${roles.map(r => `"${r}"`).join(' | ')}${viewerNote}`,
    );
  }
  return role;
}

/** Builder-or-owner gate for creating world objects. */
export function requireBuilderOrOwner(
  store: EnvironmentStore,
  envId: string,
  user: AuthUser,
): EnvRole {
  return requireEnvRole(store, envId, user, ['owner', 'builder']);
}

/**
 * Object-level mutation gate: allowed when the user owns the object OR owns
 * the environment it lives in.
 */
export function requireObjectMutationAccess(
  store: EnvironmentStore,
  env: EnvironmentRow,
  objectOwnerId: string,
  user: AuthUser,
  objectLabel: string,
): void {
  if (objectOwnerId === user.id) return;
  if (env.owner_id === user.id) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Only the ${objectLabel} owner or the environment owner may modify it`,
  );
}

/**
 * Direct structural edit gate (Fix-1 unified change pipeline,
 * multi-user-simulation-design.md §4.1): only the ENVIRONMENT owner edits
 * the shared world directly (logged as `env-direct-edit`); builders go
 * through the proposal pipeline instead — and that applies to a builder's
 * OWN objects too (Fix-13, R5 小林 F-08: ownership in the shared world is an
 * attribution marker, not a direct-edit right). R98 (simtest-r1 li-01):
 * own-object edits CONVERT to modify-object proposals automatically on the
 * device PATCH lane (and via CLI fallback on the agent lane), so this 403
 * now only fires for OTHER people's objects — the message says who can act,
 * in Chinese, without sending end users to hand-write API calls.
 */
export function requireDirectEditAccess(
  env: EnvironmentRow,
  user: AuthUser,
  objectLabel: string,
): void {
  if (env.owner_id === user.id) return;
  const labelZh =
    objectLabel === 'device' ? '设备' : objectLabel === 'agent' ? 'Agent' : objectLabel;
  const cliHint =
    objectLabel === 'device' ? 'eaf device update'
    : objectLabel === 'agent' ? 'eaf agent update'
    : undefined;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `直接修改${labelZh}仅限环境所有者（你自己拥有的${labelZh}也不例外——共享世界里的所有权是归属标记，` +
      '不是直接修改权）。' +
      `修改自己拥有的${labelZh}请走变更管道：Web 编辑表单保存` +
      (cliHint !== undefined ? `或 CLI（${cliHint}）` : '') +
      '会自动把修改转为 modify-object 提案，经规则校验与审批后生效，无需手工调用 API；' +
      `修改他人拥有的${labelZh}需环境所有者操作。`,
  );
}

/**
 * R5-F03: the decision-configuration fields an agent's OWNER may patch
 * directly — low-risk per-agent knobs, audited to command_log like every
 * direct edit. Structural changes (name, capabilities, device bindings,
 * managed zones, scope-of-practice) stay on the governed modify-object
 * proposal lane.
 */
export const AGENT_OWNER_PATCHABLE_FIELDS: readonly string[] = ['llm', 'decisionPolicy', 'enabled'];

/**
 * PATCH /api/agents/:id access gate (R5-F03): the environment owner edits
 * everything (Fix-1); the AGENT's owner may directly patch pure decision
 * configuration (AGENT_OWNER_PATCHABLE_FIELDS only — a body naming any
 * other field, or an empty body, keeps the proposal lane); everyone else
 * gets the usual Fix-1 403.
 */
export function requireAgentPatchAccess(
  env: EnvironmentRow,
  agent: { owner_id: string },
  user: AuthUser,
  body: Record<string, unknown>,
): void {
  if (env.owner_id === user.id) return;
  if (agent.owner_id === user.id) {
    const fields = Object.keys(body);
    if (fields.length > 0 && fields.every(field => AGENT_OWNER_PATCHABLE_FIELDS.includes(field))) {
      return;
    }
    throw new ApiError(
      403,
      'FORBIDDEN',
      '作为该 Agent 的所有者，你可以直接修改的只有它的 decision configuration ' +
        `（${AGENT_OWNER_PATCHABLE_FIELDS.map(field => `"${field}"`).join(', ')}）。` +
        '结构性修改（name, capabilities, boundDeviceIds, managedZoneIds, cannotDeliverClasses）' +
        '请走变更管道：Web 编辑保存或 CLI（eaf agent update）会自动把修改转为 modify-object ' +
        '提案，经规则校验与审批后生效，无需手工调用 API。',
    );
  }
  requireDirectEditAccess(env, user, 'agent');
}
