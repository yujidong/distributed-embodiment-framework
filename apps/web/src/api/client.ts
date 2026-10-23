/**
 * API client — thin typed wrappers over the Fastify REST API.
 *
 * All requests go through the `/api` base (proxied to the server in dev by
 * Vite). The server reports failures as `{ error: { code, message, issues? } }`
 * with a non-2xx status; every wrapper throws an `ApiClientError` carrying
 * that code/message instead of returning a partial object.
 */

import type {
  AdminObservability,
  AdminUser,
  AgentReputation,
  Agreement,
  AgreementInvocationResult,
  AgreementListEntry,
  AgreementStatus,
  AgreementTerms,
  ApiErrorBody,
  AppNotification,
  ArrivalDigest,
  Blueprint,
  BlueprintInstallResult,
  PublicHealth,
  CatalogModelDetail,
  CatalogModelSummary,
  CreateDeviceInput,
  CreateEnvironmentInput,
  CreateServiceInput,
  CreateSimulationOptions,
  CreateSimulationResult,
  DataReadResult,
  DeploymentManifest,
  DeviceCommandResult,
  DeviceTemplate,
  EngineSnapshot,
  EnvironmentDetail,
  EnvironmentSummary,
  EnvActivityEntry,
  EnvMember,
  EnvVisibility,
  EnvInvite,
  EnvZone,
  FaultProfile,
  HibernatedSimulationResult,
  Sandbox,
  WhatIfResult,
  DeviceFaultResult,
  EvalReport,
  EvalRunJob,
  EvalRunSummary,
  Flow,
  CreateFlowInput,
  FlowRun,
  PatchFlowInput,
  HassApproveResult,
  HassAuditEntry,
  HassEntitySummary,
  HassEstopState,
  HassPendingCommand,
  HassPolicy,
  HassStatus,
  InjectEventInput,
  InjectEventResult,
  MeOverview,
  MemberBatchResult,
  NotificationListResult,
  PatchAgentInput,
  PatchDeviceInput,
  PatchServiceInput,
  PlatformInvite,
  PolicyEffect,
  ProposeAgreementInput,
  QuestState,
  GovernanceProposal,
  ProposalRemindResult,
  PublicUser,
  ReadAgreementInput,
  SettlementReceipt,
  AgreementRemindResult,
  RosterReport,
  RuntimeCollaborationRecord,
  ScenarioAgentLLM,
  ScenarioDefinition,
  ScenarioImportDraft,
  ScenarioSummary,
  ScenarioTemplateSummary,
  ServiceOrigin,
  ServiceSubscriptionResult,
  SimulationListEntry,
  SimulationStateResult,
  SimulationStepResult,
  TrajectoryRecordDto,
  UsageRecord,
  WorldAgent,
  WorldDevice,
  WorldService,
  StandingAsk,
} from './types';
import { buildCatalogQuery, type CatalogFilters } from '../lib/catalogQuery';

const API_BASE = '/api';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown,
    /**
     * Extra machine-readable fields the server merges into the error object
     * (T-066): `retryAfterSec` on REMIND_RATE_LIMITED, `limit`/`current` on
     * QUOTA_EXCEEDED, `freshnessSec`/`minFreshnessSec` on DATA_STALE,
     * `allowedFields`/`requestedFields` on AGREEMENT_TERMS_VIOLATION,
     * `boundDevices`/`invalidDevices` on DEVICE_SCOPE_INVALID. Keys are
     * stable server contract — clients branch on them.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** One machine field from the error body (`undefined` when absent). */
  detail(key: string): unknown {
    return this.details?.[key];
  }
}

/**
 * Called whenever an authed request comes back 401 (expired/invalid session).
 * The store registers a handler that clears the auth slice; the auth guard
 * then routes to the login page. Auth endpoints themselves are excluded —
 * a failed login must not trip the global handler.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    // The session lives in the httpOnly `eaf_token` cookie — always send it.
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) {
      onUnauthorized?.();
    }
    const errorBody = body as ApiErrorBody | null;
    if (errorBody && typeof errorBody === 'object' && errorBody.error) {
      // The server spreads extra machine fields (retryAfterSec, limit…) as
      // siblings of code/message/issues inside `error` — keep them for UIs
      // that branch on them (remind rate-limit, quota, freshness).
      const { code, message, issues, ...details } = errorBody.error;
      throw new ApiClientError(
        response.status,
        code,
        message,
        issues,
        Object.keys(details).length > 0 ? details : undefined,
      );
    }
    throw new ApiClientError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
  }
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function del(path: string): Promise<void> {
  await request<unknown>(path, { method: 'DELETE' });
}

/**
 * T-048: a builder's structural DELETE is converted server-side into a
 * governed proposal and answered 201 + proposal body (the env-owner path
 * answers 204 → null). The body is the proposal, not a deletion.
 */
async function delReturningBody(path: string): Promise<ProposalConversion | null> {
  return request<ProposalConversion | null>(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Governed mutations (T-048) — builder writes become proposals
// ---------------------------------------------------------------------------

/**
 * The auto-submitted proposal a builder's structural call converts into
 * (subset of the wire shape): the object lands only if the pipeline approves.
 */
export interface ProposalConversion {
  id: string;
  kind: string;
  status: string;
  payload?: Record<string, unknown>;
  ruleCheck?: { ok: boolean; issues?: string[]; warnings?: string[] } | null;
  createdIds?: { devices?: string[]; agents?: string[] };
}

/** True when a create/delete/patch response is a proposal, not the object. */
export function isProposalConversion(value: unknown): value is ProposalConversion {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProposalConversion).kind === 'string' &&
    typeof (value as ProposalConversion).status === 'string'
  );
}

/**
 * R80-FW2 — POST /api/environments/:id/proposals (kind ownership-transfer):
 * the MEMBER claim lane. In a members-plan world a builder claims an
 * unclaimed agent/device (current holder = env owner, toUser = self).
 */
export function submitClaimProposal(
  envId: string,
  transfers: Array<{ kind: 'agent' | 'device'; id: string; toUser: string }>,
): Promise<ProposalConversion> {
  return post<ProposalConversion>(
    `/environments/${encodeURIComponent(envId)}/proposals`,
    { kind: 'ownership-transfer', payload: { transfers } },
  );
}

/**
 * POST /api/environments/:id/proposals (kind modify-object) — the governed
 * path for a builder's own-object edits (enabled toggle, wizard save).
 */
export function submitModifyObjectProposal(
  envId: string,
  targetId: string,
  patch: Record<string, unknown>,
): Promise<ProposalConversion> {
  return post<ProposalConversion>(
    `/environments/${encodeURIComponent(envId)}/proposals`,
    { kind: 'modify-object', payload: { targetId, patch } },
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function register(input: {
  email: string;
  password: string;
  displayName: string;
  /** Alpha capacity gating (EAF_INVITE_ONLY): required when the server runs invite-only. */
  inviteCode?: string;
}): Promise<PublicUser> {
  return post<PublicUser>('/auth/register', input);
}

export function login(input: { email: string; password: string }): Promise<{ token: string }> {
  return post<{ token: string }>('/auth/login', input);
}

export function logout(): Promise<void> {
  return post<void>('/auth/logout');
}

export function getMe(): Promise<PublicUser> {
  return request<PublicUser>('/auth/me');
}

// ---------------------------------------------------------------------------
// Observability (P4-4, admin-only)
// ---------------------------------------------------------------------------

/** GET /api/admin/observability — 403 for non-admins; the card handles that. */
export function getAdminObservability(): Promise<AdminObservability> {
  return request<AdminObservability>('/admin/observability');
}

// ---------------------------------------------------------------------------
// Admin panel (invite-only alpha operations, admin-only)
// ---------------------------------------------------------------------------

/** GET /api/admin/invites — every platform invite with usage statistics. */
export async function listAdminInvites(): Promise<PlatformInvite[]> {
  const body = await request<{ invites: PlatformInvite[] }>('/admin/invites');
  return body.invites;
}

/** POST /api/admin/invites — mint a code; the response is the only plaintext view. */
export function createAdminInvite(input: {
  maxUses?: number;
  expiresInDays?: number | null;
}): Promise<PlatformInvite> {
  return post<PlatformInvite>('/admin/invites', input);
}

/** POST /api/admin/invites/:code/revoke — idempotent; 404 for an unknown code. */
export function revokeAdminInvite(code: string): Promise<PlatformInvite> {
  return post<PlatformInvite>(`/admin/invites/${encodeURIComponent(code)}/revoke`);
}

/** GET /api/admin/users — the registered-account roster (invite-gate operations). */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const body = await request<{ users: AdminUser[] }>('/admin/users');
  return body.users;
}

/** GET /api/me/quotas — limit + current usage per quota (P4-4). */
export interface QuotaIntrospection {
  quotas: {
    environmentsPerUser: { limit: number; used: number };
    devicesPerEnv: { limit: number; used: number };
    agentsPerEnv: { limit: number; used: number };
    runningSimsPerUser: { limit: number; used: number };
    sandboxesPerUserPerEnv: { limit: number; used: number };
  };
}

export function getMyQuotas(): Promise<QuotaIntrospection> {
  return request<QuotaIntrospection>('/me/quotas');
}

/**
 * GET /api/health — the PUBLIC (unauthenticated) liveness probe. R74: carries
 * the server's decision posture so the home page can label a rule-driven
 * server as TEST mode instead of letting it pass as production behavior.
 */
export function getPublicHealth(): Promise<PublicHealth> {
  return request<PublicHealth>('/health');
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export async function listEnvironments(filter: 'mine' | 'all' = 'mine'): Promise<EnvironmentSummary[]> {
  // R15-D2: the server default is the caller's worlds; 'all' opts into the
  // full visible set (mine + public).
  const body = await request<{ environments: EnvironmentSummary[] }>(
    `/environments${filter === 'all' ? '?filter=all' : ''}`,
  );
  return body.environments;
}

export function getEnvironment(id: string): Promise<EnvironmentDetail> {
  return request<EnvironmentDetail>(`/environments/${encodeURIComponent(id)}`);
}

/** Fix-19: the environment's newest-first activity feed. */
export function getEnvironmentActivity(id: string, limit?: number): Promise<EnvActivityEntry[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return request<{ entries: EnvActivityEntry[] }>(
    `/environments/${encodeURIComponent(id)}/activity${query}`,
  ).then(body => body.entries);
}

/**
 * T-071/R6-D-F01 (gamification S2): the env's arrival digest — the daily
 * memo carrying completedCollaborations (world outcomes) and the env-owner
 * providerUnavailableAgreements work queue.
 */
export function getEnvironmentDigest(id: string): Promise<ArrivalDigest> {
  return request<ArrivalDigest>(`/environments/${encodeURIComponent(id)}/digest`);
}

/**
 * R6-D-M1 (gamification §2): the env's L1-L6 quest state — per-quest
 * achieved/locked + the current quest's guidance hint token.
 */
export function getQuestState(id: string): Promise<QuestState> {
  return request<QuestState>(`/environments/${encodeURIComponent(id)}/quest-state`);
}

export function createEnvironment(
  input: CreateEnvironmentInput | Record<string, unknown>,
): Promise<EnvironmentDetail> {
  return post<EnvironmentDetail>('/environments', input);
}

export function patchEnvironment(
  id: string,
  patchBody: {
    name?: string;
    description?: string;
    visibility?: EnvVisibility;
    /**
     * mapData patch — the server merges it KEY BY KEY into the stored map
     * data (R5-F01 mergeMapDataPatch): send only the touched key(s) (zones /
     * events) and unmentioned keys are preserved server-side. The W6-2 zone
     * management callers still assemble a full body via lib/zoneForm.ts.
     */
    mapData?: {
      zones?: unknown[];
      center?: { lat: number; lng: number };
      zoom?: number;
      events?: unknown[];
    };
  },
): Promise<EnvironmentDetail> {
  return patch<EnvironmentDetail>(`/environments/${encodeURIComponent(id)}`, patchBody);
}

export function deleteEnvironment(id: string): Promise<void> {
  return del(`/environments/${encodeURIComponent(id)}`);
}

export interface JoinEnvironmentResult {
  envId: string;
  userId: string;
  role: string;
  alreadyMember: boolean;
}

export function joinEnvironment(id: string): Promise<JoinEnvironmentResult> {
  return post<JoinEnvironmentResult>(`/environments/${encodeURIComponent(id)}/join`, {});
}

export function leaveEnvironment(id: string): Promise<void> {
  return post<void>(`/environments/${encodeURIComponent(id)}/leave`, {});
}

// ---------------------------------------------------------------------------
// Members (owner manages the roster; a member may remove themselves)
// ---------------------------------------------------------------------------

/** POST /api/environments/:id/members:batch — roster import (owner only). */
export function batchAddMembers(
  envId: string,
  input: { emails: string[]; role?: 'builder' | 'viewer' },
): Promise<MemberBatchResult> {
  return post<MemberBatchResult>(
    `/environments/${encodeURIComponent(envId)}/members:batch`,
    input,
  );
}

/** PATCH /api/environments/:id/members/:userId — role change (owner only). */
export function updateMemberRole(
  envId: string,
  userId: string,
  role: 'builder' | 'viewer',
): Promise<EnvMember> {
  return patch<EnvMember>(
    `/environments/${encodeURIComponent(envId)}/members/${encodeURIComponent(userId)}`,
    { role },
  );
}

/** GET /api/environments/:id/invites — pending invites (owner, R15-D10). */
export async function listEnvInvites(envId: string): Promise<EnvInvite[]> {
  const body = await request<{ invites: EnvInvite[] }>(
    `/environments/${encodeURIComponent(envId)}/invites`,
  );
  return body.invites;
}

/**
 * GET /api/environments/:id/proposals — the environment's proposals (T-404:
 * members see all). T-072: each row carries `youCanDecide` — the CALLER's
 * decidable-by-me mark (owner: every escalated proposal; the active
 * zone-claims delegate: escalated zone-claims in their zone scope).
 */
export async function listEnvProposals(envId: string): Promise<GovernanceProposal[]> {
  const body = await request<{ proposals: GovernanceProposal[] }>(
    `/environments/${encodeURIComponent(envId)}/proposals`,
  );
  return body.proposals;
}

/**
 * POST /api/proposals/:id/decide (R40-A1) — an escalated proposal's decider
 * (env owner; an in-scope zone-claims delegate for zone-claims) approves or
 * rejects it. Approving applies the change immediately.
 */
export function decideProposal(
  id: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<GovernanceProposal> {
  return post<GovernanceProposal>(
    `/proposals/${encodeURIComponent(id)}/decide`,
    { decision, ...(reason !== undefined ? { reason } : {}) },
  );
}

/**
 * POST /api/proposals/:id/remind (R40-A1) — the AUTHOR's nudge on a still
 * escalated proposal (10-min rate window anchored at creation/last reminder;
 * 429 REMIND_RATE_LIMITED carries retryAfterSec on ApiClientError.details).
 */
export function remindProposal(id: string): Promise<ProposalRemindResult> {
  return post<ProposalRemindResult>(`/proposals/${encodeURIComponent(id)}/remind`, {});
}

// ---------------------------------------------------------------------------
// Living-world sandboxes (R40-B3): fork / list / stop + flow adopt-config
// ---------------------------------------------------------------------------

/**
 * POST /api/environments/:id/sandboxes — fork a private sandbox from the
 * world's CURRENT dynamics (P2F §10.1 cheap fork, fromCheckpoint: true).
 */
export function createSandbox(
  envId: string,
  options: { fromCheckpoint?: boolean } = {},
): Promise<Sandbox> {
  return post<Sandbox>(
    `/environments/${encodeURIComponent(envId)}/sandboxes`,
    { fromCheckpoint: options.fromCheckpoint ?? true },
  );
}

/** GET /api/environments/:id/sandboxes — own + joined forks (owner: all). */
export async function listSandboxes(envId: string): Promise<Sandbox[]> {
  const body = await request<{ sandboxes: Sandbox[] }>(
    `/environments/${encodeURIComponent(envId)}/sandboxes`,
  );
  return body.sandboxes;
}

/** POST /api/sandboxes/:id/stop — release the fork's simulation. */
export function stopSandbox(id: string): Promise<{ id: string; status: string }> {
  return post<{ id: string; status: string }>(`/sandboxes/${encodeURIComponent(id)}/stop`, {});
}

/**
 * POST /api/environments/:id/proposals (kind 'adopt-config', P2F §11) —
 * promote a fork-VALIDATED flow into the authoritative world through the
 * governance funnel (AI review + owner decide). Mirrors `eaf flow adopt`.
 */
export function submitFlowAdoption(
  envId: string,
  input: { forkId: string; definition: Record<string, unknown>; evalRunId?: string },
): Promise<GovernanceProposal> {
  return post<GovernanceProposal>(
    `/environments/${encodeURIComponent(envId)}/proposals`,
    {
      kind: 'adopt-config',
      payload: {
        sourceFork: { forkId: input.forkId, envId },
        ...(input.evalRunId !== undefined
          ? { evidence: { evalRunId: input.evalRunId } }
          : {}),
        artifacts: [{ type: 'flow-definition', definition: input.definition }],
      },
    },
  );
}

/**
 * POST /api/proposals/:id/revert (R40-A1) — proposal author or env owner
 * rolls back an APPLIED proposal (the inverse operation is logged).
 */
export function revertProposal(id: string): Promise<GovernanceProposal> {
  return post<GovernanceProposal>(`/proposals/${encodeURIComponent(id)}/revert`, {});
}

/** DELETE /api/environments/:id/invites/:inviteId — revoke a pending invite. */
export function revokeEnvInvite(envId: string, inviteId: string): Promise<void> {
  return del(`/environments/${encodeURIComponent(envId)}/invites/${encodeURIComponent(inviteId)}`);
}

/** DELETE /api/environments/:id/members/:userId — owner removes; self = leave. */
export function removeMember(envId: string, userId: string): Promise<void> {
  return del(`/environments/${encodeURIComponent(envId)}/members/${encodeURIComponent(userId)}`);
}

// ---------------------------------------------------------------------------
// World objects (device / agent instances)
// ---------------------------------------------------------------------------

/**
 * POST /api/environments/:id/devices — env owner: 201 + the created device.
 * A builder's create is converted server-side into an install-devices
 * proposal (201 + proposal body — the device lands only if the pipeline
 * approves it). Callers must branch on isProposalConversion (R100).
 */
export function createDevice(
  envId: string,
  input: CreateDeviceInput,
): Promise<WorldDevice | ProposalConversion> {
  return post<WorldDevice | ProposalConversion>(
    `/environments/${encodeURIComponent(envId)}/devices`,
    input,
  );
}

/**
 * PATCH /api/devices/:id — env owner: the updated device. R98: a builder
 * patching THEIR OWN device is converted server-side into a modify-object
 * proposal (201) — callers must branch on isProposalConversion.
 */
export function patchDevice(
  id: string,
  patchBody: PatchDeviceInput,
): Promise<WorldDevice | ProposalConversion> {
  return patch<WorldDevice | ProposalConversion>(`/devices/${encodeURIComponent(id)}`, patchBody);
}

/**
 * DELETE /api/devices/:id — env owner: 204 (null) and the device is gone;
 * builder deleting their own device: 201 + the auto-submitted
 * remove-devices proposal (the device STAYS until the pipeline approves
 * it — and a rule-rejected proposal means it stays for good, R100 li-10).
 */
export function deleteDevice(id: string): Promise<ProposalConversion | null> {
  return delReturningBody(`/devices/${encodeURIComponent(id)}`);
}

export function createAgent(
  envId: string,
  input: {
    name: string;
    capabilities: string[];
    boundDeviceIds?: string[];
    managedZoneIds?: string[];
    llm?: ScenarioAgentLLM;
    /** T-051: per-agent actuation defaults (absent = runtime defaults). */
    decisionPolicy?: { autoActuateIndependent?: boolean; autoInitiateAC?: boolean };
  },
): Promise<WorldAgent> {
  return post<WorldAgent>(`/environments/${encodeURIComponent(envId)}/agents`, input);
}

export function patchAgent(id: string, patchBody: PatchAgentInput): Promise<WorldAgent> {
  return patch<WorldAgent>(`/agents/${encodeURIComponent(id)}`, patchBody);
}

/**
 * DELETE /api/agents/:id — env owner: 204 (null) and the agent is gone;
 * builder deleting their own agent: 201 + the auto-submitted remove-agents
 * proposal (the agent STAYS until the pipeline approves it, T-048).
 */
export function deleteAgent(id: string): Promise<ProposalConversion | null> {
  return delReturningBody(`/agents/${encodeURIComponent(id)}`);
}

/**
 * POST /api/environments/:id/zones (T-055) — governed zone creation.
 * Env owner: 201 + the created zone (merged into mapData immediately).
 * Builder: the call auto-converts into an `install-zones` PROPOSAL and the
 * proposal comes back (201) — the zone lands only if the pipeline approves.
 * Discriminate with `isProposalConversion` (same convention as createAgent).
 */
export function createZone(
  envId: string,
  input: {
    id: string;
    name?: string;
    type?: string;
    bounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ?: number; maxZ?: number };
    polygon?: [number, number][];
    adjacentZoneIds?: string[];
    baseline?: Record<string, number | boolean>;
  },
): Promise<EnvZone | ProposalConversion> {
  return post<EnvZone | ProposalConversion>(
    `/environments/${encodeURIComponent(envId)}/zones`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Flows (user-orchestrated business flows)
// ---------------------------------------------------------------------------

/**
 * POST /api/simulations/:id/flows/:flowId/run (R41-C1) — manually trigger a
 * flow inside a RUNNING env-backed simulation (bypasses the flow's own
 * trigger; recorded with triggerKind 'manual'). Mirrors `eaf sim run-flow`.
 */
export function runFlowManually(
  simId: string,
  flowId: string,
  params?: Record<string, unknown>,
): Promise<{ flowId: string; run: FlowRun | null }> {
  return post<{ flowId: string; run: FlowRun | null }>(
    `/simulations/${encodeURIComponent(simId)}/flows/${encodeURIComponent(flowId)}/run`,
    params !== undefined ? { params } : {},
  );
}

export async function listFlows(envId: string): Promise<Flow[]> {
  const body = await request<{ flows: Flow[] }>(
    `/environments/${encodeURIComponent(envId)}/flows`,
  );
  return body.flows;
}

export function getFlow(id: string): Promise<Flow> {
  return request<Flow>(`/flows/${encodeURIComponent(id)}`);
}

/** Create a flow; validation failures surface as 422 FLOW_INVALID with issues. */
export function createFlow(envId: string, input: CreateFlowInput): Promise<Flow> {
  return post<Flow>(`/environments/${encodeURIComponent(envId)}/flows`, input);
}

export function patchFlow(id: string, patchBody: PatchFlowInput): Promise<Flow> {
  return patch<Flow>(`/flows/${encodeURIComponent(id)}`, patchBody);
}

export function deleteFlow(id: string): Promise<void> {
  return del(`/flows/${encodeURIComponent(id)}`);
}

/** The flow's execution ledger (server keeps at most 50 runs per flow). */
export async function listFlowRuns(id: string, limit?: number): Promise<FlowRun[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const body = await request<{ runs: FlowRun[] }>(
    `/flows/${encodeURIComponent(id)}/runs${query}`,
  );
  return body.runs;
}

// ---------------------------------------------------------------------------
// Service layer (W3)
// ---------------------------------------------------------------------------

export interface ServiceListFilters {
  semanticType?: string;
  provider?: string;
  origin?: ServiceOrigin;
}

export async function listEnvServices(
  envId: string,
  filters: ServiceListFilters = {},
): Promise<WorldService[]> {
  const params = new URLSearchParams();
  if (filters.semanticType) params.set('semanticType', filters.semanticType);
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.origin) params.set('origin', filters.origin);
  const query = params.toString();
  const body = await request<{ services: WorldService[] }>(
    `/environments/${encodeURIComponent(envId)}/services${query ? `?${query}` : ''}`,
  );
  return body.services;
}

/**
 * T-069 (R23): the standing-ask 需求板 — member-only read surface of what
 * members WANT that does not exist yet. `status` slices the board
 * (open|mine|all, default open).
 */
export async function listEnvAsks(
  envId: string,
  status: 'open' | 'mine' | 'all' = 'open',
): Promise<StandingAsk[]> {
  const body = await request<{ asks: StandingAsk[] }>(
    `/environments/${encodeURIComponent(envId)}/asks?status=${status}`,
  );
  return body.asks;
}

export function publishService(
  envId: string,
  agentId: string,
  input: CreateServiceInput,
): Promise<WorldService> {
  return post<WorldService>(
    `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(agentId)}/services`,
    input,
  );
}

export function patchService(id: string, patchBody: PatchServiceInput): Promise<WorldService> {
  return patch<WorldService>(`/services/${encodeURIComponent(id)}`, patchBody);
}

export function deleteService(id: string): Promise<void> {
  return del(`/services/${encodeURIComponent(id)}`);
}

/** P4-1: an agent's learned per-capability track record in an environment. */
export function getAgentReputation(envId: string, agentId: string): Promise<AgentReputation> {
  return request<AgentReputation>(
    `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(agentId)}/reputation`,
  );
}

// ---------------------------------------------------------------------------
// User perspective (W5) — overview, subscriptions, deployment manifest
// ---------------------------------------------------------------------------

export function getMyOverview(): Promise<MeOverview> {
  return request<MeOverview>('/me/overview');
}

export function subscribeService(id: string): Promise<ServiceSubscriptionResult> {
  return put<ServiceSubscriptionResult>(`/services/${encodeURIComponent(id)}/subscribe`);
}

export function unsubscribeService(id: string): Promise<void> {
  return del(`/services/${encodeURIComponent(id)}/subscribe`);
}

export function getDeployment(envId: string): Promise<DeploymentManifest> {
  return request<DeploymentManifest>(`/environments/${encodeURIComponent(envId)}/deployment`);
}

// ---------------------------------------------------------------------------
// Device catalog
// ---------------------------------------------------------------------------

export function listCatalog(filters: CatalogFilters = {}): Promise<CatalogModelSummary[]> {
  return request<CatalogModelSummary[]>(`/catalog${buildCatalogQuery(filters)}`);
}

export function getCatalogModel(id: string): Promise<CatalogModelDetail> {
  return request<CatalogModelDetail>(`/catalog/${encodeURIComponent(id)}`);
}

export function instantiateDevice(
  envId: string,
  input: { modelId: string; name?: string; zoneId: string; position?: Record<string, unknown> },
): Promise<WorldDevice> {
  return post<WorldDevice>(`/environments/${encodeURIComponent(envId)}/devices:instantiate`, input);
}

// ---------------------------------------------------------------------------
// Scenarios (legacy file-based browser, kept for one release)
// ---------------------------------------------------------------------------

export async function listScenarios(): Promise<ScenarioSummary[]> {
  const body = await request<{ scenarios: ScenarioSummary[] }>('/scenarios');
  return body.scenarios;
}

export function getScenario(id: string): Promise<ScenarioDefinition> {
  return request<ScenarioDefinition>(`/scenarios/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Scenario templates (W1b onboarding) — bundled seeds, ready to import
// ---------------------------------------------------------------------------

/** GET /api/scenario-templates — summaries of the bundled seed scenarios. */
export async function getScenarioTemplates(lang: string): Promise<ScenarioTemplateSummary[]> {
  const body = await request<{ templates: ScenarioTemplateSummary[] }>(
    `/scenario-templates?lang=${encodeURIComponent(lang)}`,
  );
  return body.templates;
}

/**
 * GET /api/scenario-templates/:id — the raw scenario JSON, ready to POST to
 * /api/environments as an import body (spread it and attach `visibility`).
 */
export function getScenarioTemplate(id: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/scenario-templates/${encodeURIComponent(id)}`);
}

/**
 * UX-W3: POST /api/scenario-templates/:id/instantiate — expand a parameterized
 * template (meta.vars) with caller values → the scenario JSON, ready to POST
 * to /api/environments (same import path as GET /:id). Never persists.
 */
export function instantiateScenarioTemplate(
  id: string,
  values: Record<string, number>,
): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>(
    `/scenario-templates/${encodeURIComponent(id)}/instantiate`,
    { values },
  );
}

// ---------------------------------------------------------------------------
// UX-W3 environment import lanes — DRAFT-producing (nothing persists; the
// reviewed draft is imported through POST /api/environments)
// ---------------------------------------------------------------------------

export interface FloorplanImportInput {
  image: { base64: string; mimeType: string };
  buildingId: string;
  floor: number;
  /** Caller-confirmed scale: pixels-per-meter OR a known-dimension segment. */
  pixelsPerMeter?: number;
  calibration?: { x1: number; y1: number; x2: number; y2: number; meters: number };
  name?: string;
}

/** POST /api/environments/import-floorplan — vision-LLM lane (503 when unconfigured). */
export function importFloorplan(input: FloorplanImportInput): Promise<ScenarioImportDraft> {
  return post<ScenarioImportDraft>('/environments/import-floorplan', input);
}

/** POST /api/environments/import-ifc — IFC (STEP) lane, no LLM (422 on parse failure). */
export function importIfc(input: { ifc: string; name?: string }): Promise<ScenarioImportDraft> {
  return post<ScenarioImportDraft>('/environments/import-ifc', input);
}

/** POST /api/environments/import-osm — Overpass proxy lane (503 down / 404 no buildings). */
export function importOsm(
  input: { bbox: [number, number, number, number] } | { query: string },
): Promise<ScenarioImportDraft> {
  return post<ScenarioImportDraft>('/environments/import-osm', input);
}

/** POST /api/environments/import-nl — UX-W5 one-sentence lane (503 no LLM / 422 no building cues). */
export function importNl(input: { text: string; name?: string }): Promise<ScenarioImportDraft> {
  return post<ScenarioImportDraft>('/environments/import-nl', input);
}

/** GET /api/device-templates — the built-in device-template registry (UX-W3). */
export async function listDeviceTemplates(): Promise<DeviceTemplate[]> {
  const body = await request<{ templates: DeviceTemplate[] }>('/device-templates');
  return body.templates;
}

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

export function createSimulation(
  scenarioId: string,
  options?: CreateSimulationOptions,
): Promise<CreateSimulationResult> {
  return post<CreateSimulationResult>('/simulations', { scenarioId, options });
}

/** Create a simulation from an environment (P2a; the server bridges env → scenario). */
export function createSimulationForEnvironment(
  environmentId: string,
  options?: CreateSimulationOptions,
  /**
   * A2 zone scoping: TOP-LEVEL body field (not inside `options`) — the server
   * prunes the bridged world to these zones. Omit for the full world.
   */
  zoneIds?: string[],
): Promise<CreateSimulationResult> {
  return post<CreateSimulationResult>('/simulations', {
    environmentId,
    options,
    ...(zoneIds !== undefined ? { zoneIds } : {}),
  });
}

export async function listSimulations(): Promise<SimulationListEntry[]> {
  const body = await request<{ simulations: SimulationListEntry[] }>('/simulations');
  return body.simulations;
}

export function getSnapshot(id: string): Promise<EngineSnapshot> {
  return request<EngineSnapshot>(`/simulations/${encodeURIComponent(id)}/snapshot`);
}

/**
 * Trajectory records for one simulation (W8), optionally filtered by
 * eventId/agentId — the reasoning source behind LLM decisions in the
 * episode timeline. Server caps at the latest 500 records.
 */
export async function getTrajectory(
  id: string,
  filters: { eventId?: string; agentId?: string } = {},
): Promise<TrajectoryRecordDto[]> {
  const params = new URLSearchParams();
  if (filters.eventId) params.set('eventId', filters.eventId);
  if (filters.agentId) params.set('agentId', filters.agentId);
  const query = params.toString();
  const body = await request<{ records: TrajectoryRecordDto[] }>(
    `/simulations/${encodeURIComponent(id)}/trajectory${query ? `?${query}` : ''}`,
  );
  return body.records;
}

/**
 * Fix-22/Wave-3a eval report (B5): aggregated decision-quality metrics for
 * one simulation — decision accuracy by source, AC handshake success rate,
 * temperature-class effect-check pass rate, reputation totals. 404 when the
 * simulation is unknown to both the live registry and the on-disk fallback.
 */
export function getEvalReport(id: string): Promise<EvalReport> {
  return request<EvalReport>(`/simulations/${encodeURIComponent(id)}/eval-report`);
}

/**
 * T-016: the environment's batch-eval history, newest first (summary rows —
 * full per-run results ride getEvalRun).
 */
export function listEvalRuns(envId: string): Promise<EvalRunSummary[]> {
  return request<{ runs: EvalRunSummary[] }>(
    `/environments/${encodeURIComponent(envId)}/eval-runs`,
  ).then(body => body.runs);
}

/** GET /api/eval-runs/:id — the full batch job (spec + result + error). */
export function getEvalRun(id: string): Promise<EvalRunJob> {
  return request<EvalRunJob>(`/eval-runs/${encodeURIComponent(id)}`);
}

function simAction<T>(id: string, action: string, body?: unknown): Promise<T> {
  return post<T>(`/simulations/${encodeURIComponent(id)}/${action}`, body);
}

export function startSimulation(id: string, speed?: number): Promise<SimulationStateResult> {
  return simAction<SimulationStateResult>(id, 'start', speed === undefined ? {} : { speed });
}

export function pauseSimulation(id: string): Promise<SimulationStateResult> {
  return simAction<SimulationStateResult>(id, 'pause', {});
}

export function resumeSimulation(id: string, speed?: number): Promise<SimulationStateResult> {
  return simAction<SimulationStateResult>(id, 'resume', speed === undefined ? {} : { speed });
}

export function stopSimulation(id: string): Promise<SimulationStateResult> {
  return simAction<SimulationStateResult>(id, 'stop', {});
}

/**
 * POST /api/simulations/:id/hibernate (R40-B3) — freeze into a versioned
 * checkpoint and release the runtime (living-worlds §9). Idempotent; the
 * id, history and timeline continue at resume.
 */
export function hibernateSimulation(id: string): Promise<HibernatedSimulationResult> {
  return simAction<HibernatedSimulationResult>(id, 'hibernate', {});
}

export function stepSimulation(id: string, n = 1): Promise<SimulationStepResult> {
  return simAction<SimulationStepResult>(id, 'step', { n });
}

/**
 * Fix-10 step-to semantics (CLI `sim step --to`): advance until simTimeSec
 * reaches `toSimTimeSec`. Mutually exclusive with `n` server-side; the target
 * must be greater than the current simTimeSec.
 */
export function stepSimulationTo(id: string, toSimTimeSec: number): Promise<SimulationStepResult> {
  return simAction<SimulationStepResult>(id, 'step', { toSimTimeSec });
}

export function injectEvent(id: string, input: InjectEventInput): Promise<InjectEventResult> {
  return post<InjectEventResult>(`/simulations/${encodeURIComponent(id)}/events`, input);
}

export function getSimulationSnapshot(
  id: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/simulations/${encodeURIComponent(id)}/snapshot`);
}

export function sendDeviceCommand(
  id: string,
  deviceId: string,
  commandName: string,
  params?: Record<string, unknown>,
): Promise<DeviceCommandResult> {
  return post<DeviceCommandResult>(`/simulations/${encodeURIComponent(id)}/commands`, {
    deviceId,
    commandName,
    params,
  });
}

// ---------------------------------------------------------------------------
// Agent natural-language interface (cognitive architecture Phase 3)
// ---------------------------------------------------------------------------

/** Parsed intent (subset of the wire shape the UI renders). */
export interface NLCommandIntent {
  action: 'set_parameter' | 'run_flow' | 'get_status' | 'optimize' | 'emergency' | 'help' | 'unknown';
  rawText: string;
  parseSource: 'rules' | 'llm' | 'rules-llm-down';
  targetZones?: string[];
  targetDevices?: string[];
  targetParameters?: Record<string, number>;
  notes?: string[];
}

/** What actually happened when the decision's action plan ran. */
export interface NLExecutionResult {
  success: boolean;
  message?: string;
  actions: Array<{
    deviceId: string;
    command: string;
    params?: Record<string, unknown>;
    success: boolean;
    error?: string;
  }>;
  rejected?: Array<{ deviceId?: string; command?: string; reason: string }>;
  clamped?: string[];
}

/** POST /api/agents/:id/command — the four-stage pipeline result. */
export interface NLCommandResult {
  agentId: string;
  simulationId: string;
  intent: NLCommandIntent;
  cognitiveDecision: Record<string, unknown>;
  decisionSource: 'llm' | 'rules' | 'emergency';
  executionResult: NLExecutionResult;
  naturalLanguageResponse: string;
}

/** POST /api/agents/:id/ask — read-only structured answer + NL explanation. */
export interface NLAskResult {
  agentId: string;
  simulationId: string;
  intent: NLCommandIntent;
  data: {
    zones?: Array<{ zoneId: string; name?: string; parameters: Record<string, number | boolean> }>;
    devices?: Array<{ deviceId: string; name: string; online: boolean; state?: Record<string, unknown> }>;
    assessment?: Record<string, unknown>;
  };
  naturalLanguageResponse: string;
}

/** POST /api/agents/:id/command — command a RUNNING agent in plain language. */
export function agentCommand(
  agentId: string,
  text: string,
  simId?: string,
): Promise<NLCommandResult> {
  return post<NLCommandResult>(
    `/agents/${encodeURIComponent(agentId)}/command`,
    simId !== undefined ? { text, simId } : { text },
  );
}

/** POST /api/agents/:id/ask — ask a running agent a question (read-only). */
export function agentAsk(agentId: string, text: string, simId?: string): Promise<NLAskResult> {
  return post<NLAskResult>(
    `/agents/${encodeURIComponent(agentId)}/ask`,
    simId !== undefined ? { text, simId } : { text },
  );
}

/**
 * POST /api/agents/:id/what-if (R40-B1) — dual-fork prediction: verdict
 * (improvement/neutral/degradation) + confidence + per-metric deltas.
 */
export function agentWhatIf(
  agentId: string,
  text: string,
  simId?: string,
): Promise<WhatIfResult> {
  return post<WhatIfResult>(
    `/agents/${encodeURIComponent(agentId)}/what-if`,
    simId !== undefined ? { text, simId } : { text },
  );
}

// ---------------------------------------------------------------------------
// Failure-mode injection (P3d)
// ---------------------------------------------------------------------------

/** PUT /api/simulations/:id/faults/:deviceId — set/replace a device's fault profile. */
export function setDeviceFault(
  id: string,
  deviceId: string,
  profile: FaultProfile,
): Promise<DeviceFaultResult> {
  return put<DeviceFaultResult>(
    `/simulations/${encodeURIComponent(id)}/faults/${encodeURIComponent(deviceId)}`,
    profile,
  );
}

/** DELETE /api/simulations/:id/faults/:deviceId — clear a device's fault (idempotent). */
export function clearDeviceFault(id: string, deviceId: string): Promise<DeviceFaultResult> {
  return request<DeviceFaultResult>(
    `/simulations/${encodeURIComponent(id)}/faults/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE' },
  );
}

/** GET /api/simulations/:id/faults — map of active fault profiles by device id. */
export function listDeviceFaults(id: string): Promise<{ faults: Record<string, FaultProfile> }> {
  return request<{ faults: Record<string, FaultProfile> }>(
    `/simulations/${encodeURIComponent(id)}/faults`,
  );
}

// ---------------------------------------------------------------------------
// Home Assistant bridge (P3a status/entities + P3b actuation safety)
// ---------------------------------------------------------------------------

/** GET /api/hass/status — reports the connection state; never errors. */
export function getHassStatus(): Promise<HassStatus> {
  return request<HassStatus>('/hass/status');
}

export async function listHassEntities(
  filters: { domain?: string; q?: string } = {},
): Promise<HassEntitySummary[]> {
  const params = new URLSearchParams();
  if (filters.domain) params.set('domain', filters.domain);
  if (filters.q) params.set('q', filters.q);
  const query = params.toString();
  const body = await request<{ entities: HassEntitySummary[] }>(
    `/hass/entities${query ? `?${query}` : ''}`,
  );
  return body.entities;
}

export async function listHassPolicies(): Promise<HassPolicy[]> {
  const body = await request<{ policies: HassPolicy[] }>('/hass/policies');
  return body.policies;
}

/** Create a policy: omit `envId` for a global rule (server admins only). */
export function createHassPolicy(input: {
  envId?: string;
  entityPattern: string;
  effect: PolicyEffect;
}): Promise<HassPolicy> {
  return post<HassPolicy>('/hass/policies', input);
}

export function deleteHassPolicy(id: string): Promise<void> {
  return del(`/hass/policies/${encodeURIComponent(id)}`);
}

export async function listHassPending(): Promise<HassPendingCommand[]> {
  const body = await request<{ pending: HassPendingCommand[] }>('/hass/pending');
  return body.pending;
}

export function approveHassPending(id: string): Promise<HassApproveResult> {
  return post<HassApproveResult>(`/hass/pending/${encodeURIComponent(id)}/approve`, {});
}

export function rejectHassPending(id: string): Promise<HassPendingCommand> {
  return post<HassPendingCommand>(`/hass/pending/${encodeURIComponent(id)}/reject`, {});
}

/** Newest-first audit feed (server caps limit at 200, default 50). */
export async function listHassAudit(
  filters: { entity?: string; sim?: string; limit?: number } = {},
): Promise<HassAuditEntry[]> {
  const params = new URLSearchParams();
  if (filters.entity) params.set('entity', filters.entity);
  if (filters.sim) params.set('sim', filters.sim);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const query = params.toString();
  const body = await request<{ audit: HassAuditEntry[] }>(
    `/hass/audit${query ? `?${query}` : ''}`,
  );
  return body.audit;
}

export function getHassEstop(): Promise<HassEstopState> {
  return request<HassEstopState>('/hass/estop');
}

/** Engage the emergency stop — deliberately open to any logged-in user. */
export function engageHassEstop(): Promise<HassEstopState> {
  return post<HassEstopState>('/hass/estop', {});
}

export function clearHassEstop(): Promise<HassEstopState> {
  return request<HassEstopState>('/hass/estop', { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Agreements (Fix-11 service consumption)
// ---------------------------------------------------------------------------

/** POST /api/services/:id/agreements — consumer proposes an agreement. */
export function proposeAgreement(
  serviceId: string,
  input: ProposeAgreementInput = {},
): Promise<Agreement> {
  return post<Agreement>(`/services/${encodeURIComponent(serviceId)}/agreements`, input);
}

export interface AgreementListFilters {
  role?: 'consumer' | 'provider';
  status?: AgreementStatus;
  /**
   * UX-10: ?include=terminated opens the env-wide read lane — terminated
   * rows the caller is not a party to ride the response as the T30
   * RESTRICTED view (agents + outcome, no owner identities, no terms).
   */
  includeTerminated?: boolean;
}

/** GET /api/agreements?envId= — agreements the caller is a party to. */
export async function listAgreements(
  envId: string,
  filters: AgreementListFilters = {},
): Promise<AgreementListEntry[]> {
  const params = new URLSearchParams({ envId });
  if (filters.role) params.set('role', filters.role);
  if (filters.status) params.set('status', filters.status);
  if (filters.includeTerminated) params.set('include', 'terminated');
  const body = await request<{ agreements: AgreementListEntry[] }>(`/agreements?${params.toString()}`);
  return body.agreements;
}

/** POST /api/agreements/:id/decide — provider accepts/rejects a proposal. */
export function decideAgreement(id: string, decision: 'accept' | 'reject'): Promise<Agreement> {
  return post<Agreement>(`/agreements/${encodeURIComponent(id)}/decide`, { decision });
}

/** GET /api/agreements/:id — one agreement (parties + env owner; T-066 detail). */
export function getAgreement(id: string): Promise<Agreement> {
  return request<Agreement>(`/agreements/${encodeURIComponent(id)}`);
}

/**
 * POST /api/agreements/:id/counter — the provider counters a proposed
 * agreement with a COMPLETE terms object (T-059): proposed → countered, the
 * decide right passes to the consumer.
 */
export function counterAgreement(id: string, terms: AgreementTerms): Promise<Agreement> {
  return post<Agreement>(`/agreements/${encodeURIComponent(id)}/counter`, { terms });
}

/** POST /api/agreements/:id/remind — 429 REMIND_RATE_LIMITED carries retryAfterSec. */
export function remindAgreement(id: string): Promise<AgreementRemindResult> {
  return post<AgreementRemindResult>(`/agreements/${encodeURIComponent(id)}/remind`, {});
}

export function suspendAgreement(id: string): Promise<Agreement> {
  return post<Agreement>(`/agreements/${encodeURIComponent(id)}/suspend`, {});
}

export function terminateAgreement(id: string): Promise<Agreement> {
  return post<Agreement>(`/agreements/${encodeURIComponent(id)}/terminate`, {});
}

/** POST /api/agreements/:id/invocations — consumer invokes an active agreement. */
export function invokeAgreement(
  id: string,
  input: { action: string; params?: Record<string, unknown> },
): Promise<AgreementInvocationResult> {
  return post<AgreementInvocationResult>(
    `/agreements/${encodeURIComponent(id)}/invocations`,
    input,
  );
}

/** GET /api/agreements/:id/usage — the append-only metering ledger. */
export async function getAgreementUsage(id: string): Promise<UsageRecord[]> {
  const body = await request<{ usage: UsageRecord[] }>(
    `/agreements/${encodeURIComponent(id)}/usage`,
  );
  return body.usage;
}

/**
 * POST /api/agreements/:id/reads — synchronous evaluation, returns a
 * DataFrame (R14 Wave-A pull lane). Errors carry machine fields
 * (QUOTA_EXCEEDED limit/current, DATA_STALE freshnessSec/minFreshnessSec,
 * 422 allowedFields/requestedFields) on ApiClientError.details.
 */
export function readAgreementData(id: string, input: ReadAgreementInput = {}): Promise<DataReadResult> {
  return post<DataReadResult>(`/agreements/${encodeURIComponent(id)}/reads`, input);
}

/** GET /api/agreements/:id/reads/latest — the cached newest frame (cheap path). */
export function readAgreementLatest(id: string): Promise<DataReadResult> {
  return request<DataReadResult>(`/agreements/${encodeURIComponent(id)}/reads/latest`);
}

/** GET /api/agreements/:id/receipts — the settlement trail (§3.4). */
export async function getAgreementReceipts(id: string): Promise<SettlementReceipt[]> {
  const body = await request<{ receipts: SettlementReceipt[] }>(
    `/agreements/${encodeURIComponent(id)}/receipts`,
  );
  return body.receipts;
}

// ---------------------------------------------------------------------------
// Simulation collaborations (Fix-8)
// ---------------------------------------------------------------------------

/** GET /api/simulations/:id/collaborations — one row per (collab, agent-view). */
export async function getSimulationCollaborations(
  id: string,
  filters: { agentId?: string; status?: string } = {},
): Promise<RuntimeCollaborationRecord[]> {
  const params = new URLSearchParams();
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  const body = await request<{ collaborations: RuntimeCollaborationRecord[] }>(
    `/simulations/${encodeURIComponent(id)}/collaborations${query ? `?${query}` : ''}`,
  );
  return body.collaborations;
}

// ---------------------------------------------------------------------------
// Notifications (Fix-16) — pull-only inbox
// ---------------------------------------------------------------------------

/**
 * GET /api/notifications — the caller's inbox (unreadCount always present).
 * T-030: `before` (ISO) is the backwards cursor — strictly older rows, the
 * same contract as the activity feed's `?before=`.
 */
export function listNotifications(
  filters: { unread?: boolean; limit?: number; before?: string } = {},
): Promise<NotificationListResult> {
  const params = new URLSearchParams();
  if (filters.unread !== undefined) params.set('unread', String(filters.unread));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.before !== undefined) params.set('before', filters.before);
  const query = params.toString();
  return request<NotificationListResult>(`/notifications${query ? `?${query}` : ''}`);
}

export function markNotificationRead(id: string): Promise<AppNotification> {
  return post<AppNotification>(`/notifications/${encodeURIComponent(id)}/read`, {});
}

export function markAllNotificationsRead(): Promise<{ marked: number }> {
  return post<{ marked: number }>('/notifications/read-all', {});
}

// ---------------------------------------------------------------------------
// Blueprints (Fix-38) — one-click application templates
// ---------------------------------------------------------------------------

/** GET /api/blueprints — built-in + custom templates (auth required). */
export async function getBlueprints(): Promise<Blueprint[]> {
  const body = await request<{ blueprints: Blueprint[] }>('/blueprints');
  return body.blueprints;
}

/**
 * POST /api/environments/:envId/blueprints/:bpId/install — creates the
 * blueprint's devices/agents/flows in the target zone (builder/owner only).
 */
export function installBlueprint(
  envId: string,
  bpId: string,
  input: { zoneId: string },
): Promise<BlueprintInstallResult> {
  return post<BlueprintInstallResult>(
    `/environments/${encodeURIComponent(envId)}/blueprints/${encodeURIComponent(bpId)}/install`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Roster report (Fix-37) — owner-only grading export
// ---------------------------------------------------------------------------

/** GET /api/environments/:id/roster-report — per-member app inventory (owner only). */
export function getRosterReport(envId: string): Promise<RosterReport> {
  return request<RosterReport>(`/environments/${encodeURIComponent(envId)}/roster-report`);
}

/**
 * The CSV variant of the roster report as a plain URL — the session rides on
 * the httpOnly `eaf_token` cookie, so an anchor/`window.open` downloads it
 * with no extra auth handling.
 */
export function rosterReportCsvUrl(envId: string): string {
  return `${API_BASE}/environments/${encodeURIComponent(envId)}/roster-report?format=csv`;
}

// ---------------------------------------------------------------------------
// Training data export (Fix-22 / plan-r81 B3) — owner-only NDJSON download
// ---------------------------------------------------------------------------

/**
 * The NDJSON training-data export as a plain URL — same cookie-download
 * convention as rosterReportCsvUrl: the session rides on the httpOnly
 * `eaf_token` cookie, so an anchor/`window.open` streams the (potentially
 * large) NDJSON file straight to disk without JSON-parsing it in the page.
 * Owner-only server-side (others get a 403 JSON body); the export itself is
 * audited in command_log. `simId` scopes the trajectory/timeline records to
 * one simulation (DB-side usage + reputation-snapshot are always included);
 * `format` switches the data lines to a training view (sft/dpo/structured).
 */
export function trainingExportUrl(
  envId: string,
  filters: { simId?: string; from?: string; to?: string; format?: 'sft' | 'dpo' | 'structured' } = {},
): string {
  const params = new URLSearchParams();
  if (filters.simId) params.set('simId', filters.simId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.format) params.set('format', filters.format);
  const query = params.toString();
  return `${API_BASE}/environments/${encodeURIComponent(envId)}/training-export${query ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------
// Replay shares (R15-B1) — anonymous read-only replay links
// ---------------------------------------------------------------------------

/** GET /api/shares/:id — what an anonymous viewer of a share link sees. */
export interface ReplayShareView {
  id: string;
  name: string;
  description: string;
  envName: string;
  environmentId: string;
  createdAt: string;
  expiresAt: string;
  eventCount: number;
  scenario: ScenarioDefinition;
}

export interface CreateReplayShareInput {
  from: string;
  to: string;
  name?: string;
  description?: string;
  expiresInDays?: number;
}

export interface CreateReplayShareResult {
  shareId: string;
  /** Relative (`/share/<id>`) — the caller joins its own origin. */
  sharePath: string;
  expiresAt: string;
  report: { eventCount?: number; skipped?: number; unchanged?: number } & Record<string, unknown>;
}

/** POST /api/environments/:id/replay-shares — public envs only (403 otherwise). */
export function createReplayShare(
  envId: string,
  input: CreateReplayShareInput,
): Promise<CreateReplayShareResult> {
  return post<CreateReplayShareResult>(
    `/environments/${encodeURIComponent(envId)}/replay-shares`,
    input,
  );
}

/** GET /api/shares/:id — public; 404 SHARE_NOT_FOUND when unknown/expired. */
export function getReplayShare(shareId: string): Promise<ReplayShareView> {
  return request<ReplayShareView>(`/shares/${encodeURIComponent(shareId)}`);
}

// ---------------------------------------------------------------------------
// R59 — external channel management (API keys + event sources)
// ---------------------------------------------------------------------------

export interface ApiKeySummary {
  id: string;
  name: string;
  envId: string;
  serviceId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreated extends ApiKeySummary {
  /** The plaintext secret — shown exactly once at creation. */
  key: string;
}

export async function listApiKeys(envId: string): Promise<{ keys: ApiKeySummary[] }> {
  return request(`/environments/${encodeURIComponent(envId)}/api-keys`);
}

export async function createApiKey(
  envId: string,
  input: { name: string; serviceId?: string; ttlDays?: number },
): Promise<ApiKeyCreated> {
  return request(`/environments/${encodeURIComponent(envId)}/api-keys`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await requestVoid(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface EventSourceSummary {
  id: string;
  envId: string;
  name: string;
  url: string;
  pollIntervalSec: number;
  enabled: boolean;
  mapping: Record<string, unknown>;
  lastPollAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastInjected: number;
  createdAt: string;
}

export interface EventSourcePollResult {
  sourceId: string;
  status: string;
  fetchedItems: number;
  injected: number;
  deduped: number;
  skippedItems: number;
  error?: string;
  source: EventSourceSummary;
}

export async function listEventSources(envId: string): Promise<{ sources: EventSourceSummary[] }> {
  return request(`/environments/${encodeURIComponent(envId)}/event-sources`);
}

export async function createEventSource(
  envId: string,
  input: { name: string; url: string; pollIntervalSec?: number; authHeaders?: Record<string, string>; mapping?: Record<string, unknown> },
): Promise<EventSourceSummary> {
  return request(`/environments/${encodeURIComponent(envId)}/event-sources`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function patchEventSource(id: string, patch: { enabled?: boolean; pollIntervalSec?: number; mapping?: Record<string, unknown>; name?: string }): Promise<EventSourceSummary> {
  return request(`/event-sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteEventSource(id: string): Promise<void> {
  await requestVoid(`/event-sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function pollEventSource(id: string): Promise<EventSourcePollResult> {
  return request(`/event-sources/${encodeURIComponent(id)}/poll-now`, { method: 'POST', body: '{}' });
}

/** R59: the direct service invocation (the channel behind 试调). */
export async function invokeService(
  serviceId: string,
  input: { action: string; params?: Record<string, unknown>; simulationId?: string },
): Promise<{ lane: string; success: boolean; deviceId?: string; error?: string; result?: unknown; agreementId?: string }> {
  return request(`/services/${encodeURIComponent(serviceId)}/invoke`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
