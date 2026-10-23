/**
 * API DTO types — derived from the OpenAPI contract.
 *
 * The single source of truth for the wire contract is
 * `apps/server/openapi.yaml` (server-side reconciliation tests keep it in
 * sync with the routes). `generated.ts` next to this file is produced by
 * openapi-typescript from that contract:
 *
 *     npm run sync-types -w @active-collaboration/web
 *
 * Most interfaces below are type aliases (or thin patches) over the
 * generated schemas, so contract drift is caught at compile time. Types are
 * kept local (NOT imported from `@active-collaboration/core`) so the browser
 * bundle never pulls node-only dependencies (mqtt, ws, ajv, fs).
 *
 * Patches (`Omit<…> & {…}`) exist where the hand-curated contract lags the
 * serializers — each one is commented; when openapi.yaml catches up, drop
 * the patch and alias the schema directly. Pure frontend-helper types
 * (WebSocket frames, form state, snapshot-only blocks) remain hand-written
 * at the bottom of the file.
 */

import type { components } from './generated';
import type { LocalizedText } from '@active-collaboration/shared';

type Schema = components['schemas'];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type ScenarioSource = Schema['ScenarioSummary']['source'];

export type ScenarioSummary = Schema['ScenarioSummary'];

/**
 * Scenario meta. openapi.yaml's ScenarioDefinition.meta lacks the building
 * tier (B-A) fields, so this stays hand-written and is patched into
 * ScenarioDefinition below.
 *
 * i18n (Phase 1+3): `name`, `description`, `vendorDisclaimer`, and `tagline`
 * all accept the bilingual `{zh, en}` object shape from server-backed
 * scenarios authored after Phase 3. Legacy single-string form still flows
 * through unchanged; consumers resolve via `localizedText()` from
 * `lib/locale.ts`.
 */
export interface ScenarioMeta {
  id: string;
  name: LocalizedText | string;
  description: LocalizedText | string;
  /** Building tier (B-A): floor-to-floor height in meters (default 3.5). */
  storeyHeight?: number;
  /** Building tier (B-A): cross-floor diffusion flux multiplier (default 0.15). */
  slabAttenuation?: number;
  /** Wave 2: marketing tagline (zh/en), mirrored from ScenarioSummary. */
  tagline?: LocalizedText;
  /** Wave 2: event id that should be the demo "hero moment". */
  heroEventId?: string;
  /** Wave 2: demo playback rate hint (drives the replay default speed). */
  recommendedPlaybackRate?: number;
  /** Wave 2: vendor-names illustrative-use disclaimer (detail page footer). */
  vendorDisclaimer?: LocalizedText | string;
}

/** Zone bounds including the optional 3D extent (floor/altitude, meters). */
export type ZoneBounds = NonNullable<Schema['ScenarioZone']['bounds']>;

export type ScenarioZone = Schema['ScenarioZone'];

export type DeviceRole = Schema['ScenarioDevice']['role'];

export type ScenarioDevice = Schema['ScenarioDevice'];

/**
 * Patch over the contract's AgentLlm: core's scenario-schema also accepts
 * `systemPrompt` (per-agent prompt override, Wave-3b; the server passes the
 * llm object through verbatim), but openapi.yaml does not list it yet.
 */
export type ScenarioAgentLLM = Schema['AgentLlm'] & { systemPrompt?: string };

export type ScenarioAgent = Schema['ScenarioAgent'];

export type ScenarioEvent = Schema['ScenarioEvent'];

/** Mirror of packages/core/src/scenario/scenario-types.ts `ScenarioDefinition`. */
export type ScenarioDefinition = Omit<Schema['ScenarioDefinition'], 'meta'> & {
  meta: ScenarioMeta;
};

/**
 * W1b: one row of GET /api/scenario-templates. The :id variant returns the
 * raw scenario JSON, posted verbatim to /api/environments.
 * UX-W3: `vars` marks a parameterized template — values go to
 * POST /api/scenario-templates/:id/instantiate before import.
 */
export type ScenarioTemplateSummary = Schema['ScenarioTemplateSummary'];

/** UX-W3: one declared sizing parameter of a parameterized template. */
export type ScenarioTemplateVar = NonNullable<ScenarioTemplateSummary['vars']>[number];

// ---------------------------------------------------------------------------
// UX-W3 import lanes + device-template catalog
// ---------------------------------------------------------------------------

/** Response shape of the three import lanes (import-floorplan/-ifc/-osm). */
export type ScenarioImportDraft = Schema['ScenarioImportDraft'];

/** One row of GET /api/device-templates (built-in registry pass-through). */
export type DeviceTemplate = Schema['DeviceTemplate'];

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

/** Mirror of EngineRuntime lifecycle states. */
export type EngineRuntimeState = Schema['EngineRuntimeState'];

export type LlmClientPreset = NonNullable<Schema['CreateSimulationBody']['options']>['llmClient'];

/** AC mode for A/B comparison runs (see CreateSimulationBody.options.acMode). */
export type AcMode = NonNullable<Schema['CreateSimulationBody']['options']>['acMode'];

/**
 * Patch over CreateSimulationBody.options: the contract marks fields with a
 * server default as required (openapi-typescript treats `default` that way);
 * the frontend omits them to take the default.
 */
export type CreateSimulationOptions = Omit<
  NonNullable<Schema['CreateSimulationBody']['options']>,
  'llmClient' | 'acMode' | 'autoActuateIndependent'
> & {
  llmClient?: LlmClientPreset;
  acMode?: AcMode;
  /** T-051: false = decision-only run (overrides every agent policy). */
  autoActuateIndependent?: boolean;
};

/** Response of POST /api/simulations (201). */
export type CreateSimulationResult = Schema['CreateSimulationResult'];

export type SimulationListEntry = Schema['SimulationListEntry'];

/** Response of POST /api/simulations/:id/{start,pause,resume,stop}. */
export type SimulationStateResult = Schema['SimulationStateResult'];

/** Living-world sandbox fork (R40-B3) — the /api/environments/:id/sandboxes row. */
export type Sandbox = Schema['Sandbox'];

/**
 * POST /api/simulations/:id/hibernate (R40-B3) — the frozen-world echo:
 * checkpoint + release; resume continues id, history and timeline.
 */
export interface HibernatedSimulationResult {
  id: string;
  state: 'hibernated';
  simTimeSec: number;
  hibernatedAt: string;
  checkpoint: Record<string, unknown>;
}

/** Response of POST /api/simulations/:id/step. */
export type SimulationStepResult = Schema['SimulationStepResult'];

/** Mirror of EngineRuntime `RuntimeDecisionRecord`. */
export type RuntimeDecisionRecord = Schema['EngineSnapshot']['recentDecisions'][number];

/**
 * Runtime comfort sub-object (NFR-1, ASHRAE 55 PMV/PPD): EngineRuntime
 * embeds it into the zone's parameter record alongside the scalar values.
 */
export interface SnapshotZoneComfort {
  pmv: number;
  ppd: number;
  sensation: string;
  comfortLevel: string;
}

/**
 * Patch over the generated snapshot zone: the contract types `parameters`
 * as scalar-only, but the runtime may add a `comfort` sub-object.
 */
export type SnapshotZone = Omit<Schema['EngineSnapshot']['zones'][number], 'parameters'> & {
  parameters: Schema['EngineSnapshot']['zones'][number]['parameters'] & {
    comfort?: SnapshotZoneComfort;
  };
};

export type SnapshotDevice = Schema['EngineSnapshot']['devices'][number];

/**
 * Mirror of EngineRuntime `FaultProfile` (P3d failure-mode injection).
 * Fields combine freely; all optional.
 */
export type FaultProfile = Schema['FaultProfile'];

/** Result of PUT/DELETE /api/simulations/:id/faults/:deviceId. */
export type DeviceFaultResult = Schema['DeviceFaultResult'];

export type SnapshotAgent = Schema['EngineSnapshot']['agents'][number];

/** Per-agent reputation summary embedded in engine snapshots (P4-1). */
export type AgentReputationSummary = SnapshotAgent['reputation'];

export type ScheduledEventStatus = Schema['EngineSnapshot']['scheduledEvents'][number];

/** Mirror of EngineRuntime `EngineSnapshot`. */
export type EngineSnapshot = Schema['EngineSnapshot'];

/**
 * The engine snapshot's `llm` block (P4-2) — present only when cache and/or
 * triage is active.
 */
export type SnapshotLlmMetrics = NonNullable<EngineSnapshot['llm']>;

// ---------------------------------------------------------------------------
// WebSocket stream (GET /api/simulations/:id/stream) — not in the contract
// ---------------------------------------------------------------------------

/**
 * Wire shape of one engine SystemEvent as JSON (mirrors
 * packages/shared/src/types/events.ts `SystemEvent`; `type` stays a plain
 * string so unknown/new event types survive the round trip). `timestamp` is
 * an ISO string over the wire; `payload` is event-specific and rendered
 * defensively everywhere.
 */
export interface SystemEventDto {
  id: string;
  type: string;
  source: string;
  timestamp?: string;
  correlationId?: string;
  priority?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Messages on the simulation stream: an initial snapshot, then engine events
 * batched ≤10 msg/s, plus periodic snapshots (server-side cadence) and —
 * since R30/R31 — the additive delta lane between full snapshots.
 */
export type StreamMessage =
  | { kind: 'snapshot'; data: EngineSnapshot }
  | { kind: 'event'; data: SystemEventDto[] }
  | { kind: 'zone-delta'; data: ZoneDeltaFrame }
  | { kind: 'device-delta'; data: DeviceDeltaFrame };

/**
 * R31 SF10 client mirror of the server's delta frames
 * (apps/server/src/sim-stream-deltas.ts — DevLoop R30 Task 4): one
 * zone-parameter change per frame. Occupancy rides as param 'occupancy'.
 * Unlike snapshot/event these frames are FLAT on the wire (no `data`
 * wrapper); parseStreamMessage normalizes them into the wrapper.
 */
export interface ZoneDeltaFrame {
  kind: 'zone-delta';
  zoneId: string;
  param: string;
  oldValue: number | boolean;
  newValue: number | boolean;
  simTimeSec: number;
}

/** R31 SF10: one device's changed state fields (`from`/`to` per field). */
export interface DeviceDeltaFrame {
  kind: 'device-delta';
  deviceId: string;
  changedFields: Record<string, { from: unknown; to: unknown }>;
  simTimeSec: number;
}

// ---------------------------------------------------------------------------
// Trajectory records (GET /api/simulations/:id/trajectory, W8)
// ---------------------------------------------------------------------------

/**
 * One (event, agent) trajectory record as written by the core
 * TrajectoryRecorder JSONL. Hand-written: the contract types `context` as a
 * free-form object, but the UI drills into its structure.
 */
export interface TrajectoryRecordDto {
  recordedAt: string;
  scenario: string;
  condition: string;
  iteration: number;
  eventId: string;
  agentId: string;
  context: {
    capabilities: string[];
    managedZoneIds?: string[];
    actuatorZoneIds?: string[];
    partnerServices: Array<{ serviceName: string; capabilities: string[]; providerAgentId: string }>;
    partnerServicesTotal: number;
  };
  prompt?: { systemPrompt?: string; userPrompt: string };
  rawResponse?: string;
  decision: string;
  decisionSource: string;
  groundTruth: { correctDecision: string; interactionType: string };
  correct: boolean;
  goalAchieved?: boolean;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Event injection / device commands
// ---------------------------------------------------------------------------

/** Mirror of EngineRuntime `InjectEventInput`. */
export type InjectEventInput = Schema['InjectEventInput'];

/** Mirror of EngineRuntime `InjectEventResult`. */
export type InjectEventResult = Schema['InjectEventResult'];

/** Response of POST /api/simulations/:id/devices/:deviceId/commands (200/202). */
export type DeviceCommandResult = Schema['DeviceCommandResult'];

/** Server error body shape: `{ error: { code, message, issues? } }`. */
export type ApiErrorBody = Schema['Error'];

// ---------------------------------------------------------------------------
// Auth (P2a)
// ---------------------------------------------------------------------------

export type PublicUser = Schema['PublicUser'];

// ---------------------------------------------------------------------------
// Observability (P4-4) — GET /api/admin/observability (admin-only).
// ---------------------------------------------------------------------------

/** Response of GET /api/admin/observability (admin-only). */
export type AdminObservability = Schema['ObservabilitySummary'];

/** Platform registration invite row (admin invite management, schema v57). */
export type PlatformInvite = Schema['PlatformInvite'];

/** Admin roster row — GET /api/admin/users (PublicUser + isAdmin). */
export type AdminUser = Schema['AdminUser'];

// ---------------------------------------------------------------------------
// Environments (P2a)
// ---------------------------------------------------------------------------

export type EnvVisibility = Schema['EnvVisibility'];
export type EnvRole = Schema['EnvRole'];

export type OwnerRef = Schema['OwnerRef'];

/**
 * Patch over the generated EnvZone: the contract schema lags the server's
 * environment-store EnvZone, which also carries the per-zone `envelopeU`
 * (B-B envelope flux multiplier) and `occupancy` (B-B headcount). Zones ride
 * map_data verbatim both ways (parseMapDataInput validates only consentClass/
 * bounds/polygon and passes the object through; the detail serializer emits
 * `zones: mapData.zones` unchanged), so the fields are live on the wire.
 */
export type EnvZone = Schema['EnvZone'] & {
  envelopeU?: number;
  occupancy?: number;
};

/** A declarative interior room (R82) — mirrors the server's EnvRoom. */
export type EnvRoom = NonNullable<EnvZone['rooms']>[number];

/** Plan-image underlay for one storey (B-D), as embedded in EnvironmentDetail. */
export type EnvFloorPlan = Schema['EnvironmentDetail']['floorPlans'][number];

/**
 * Demo-playback metadata (T-032): tagline / heroEventId /
 * recommendedPlaybackRate / vendorDisclaimer — imported from the scenario
 * template meta and persisted on the env's mapData; surfaced on
 * EnvironmentDetail.demo (null when the world carries none) and re-emitted
 * by bridge/replay exports so the demo player works on imported envs.
 */
export type EnvDemoMeta = NonNullable<Schema['EnvironmentDetail']['demo']>;

export type EnvironmentCounts = Schema['EnvironmentCounts'];

/** Mirror of env-serializers `environmentSummary`. */
export type EnvironmentSummary = Schema['EnvironmentSummary'];

/**
 * Patch over the generated WorldDevice: the contract marks `binding`
 * optional, but the serializer always emits it (P3b).
 */
export type WorldDevice = Omit<Schema['WorldDevice'], 'binding'> & {
  /**
   * P3b deployment binding: 'sim://<deviceId>' (default, simulated) or
   * 'hass://<entity-id>' (actuate the real Home Assistant entity).
   */
  binding: string;
};

/** Mirror of env-serializers `agentToJson` (an agent instance in a world). */
export type WorldAgent = Schema['WorldAgent'];

export type EnvMember = Schema['EnvMember'];

/** Per-row outcome of POST /api/environments/:id/members:batch (Fix-37 + R15-D10). */
export type MemberBatchStatus = 'added' | 'already_member' | 'invited' | 'not_found';

export interface MemberBatchRow {
  email: string;
  status: MemberBatchStatus;
  userId?: string;
}

export interface MemberBatchResult {
  envId: string;
  role: EnvRole;
  /** `invited` counts emails parked as pending invites (R15-D10). */
  summary: { total: number; added: number; skipped: number; failed: number; invited?: number };
  results: MemberBatchRow[];
}

/** One pending invite row (GET /api/environments/:id/invites, R15-D10). */
export interface EnvInvite {
  id: string;
  email: string;
  role: 'builder' | 'viewer';
  invitedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Governance (proposals + decision delegations, T-404 / T-072)
// ---------------------------------------------------------------------------

/**
 * One proposal row on the member's list (T-404: members see all). T-072
 * adds `youCanDecide` — the CALLER's decidable-by-me mark (owner: every
 * escalated proposal; the active zone-claims delegate: escalated
 * zone-claims inside their delegated zones; absent for older payloads).
 */
export type GovernanceProposal = Schema['Proposal'] & {
  youCanDecide?: boolean;
};

/**
 * Response of POST /api/proposals/:id/remind (R40-A1). Hand-written: the
 * contract defines this shape inline on the path (no named schema), same
 * pattern as AgreementRemindResult.
 */
export type ProposalRemindResult = {
  proposalId: string;
  status: string;
  /** False when a noise-control rule dropped the notification. */
  reminded: boolean;
  note?: string;
  /** Present when an in-scope zone-claims delegate was nudged too. */
  delegateReminded?: boolean;
};

/** One active decision delegation (T-072, D-1 decide half). */
export type EnvDelegation = NonNullable<
  NonNullable<Schema['EnvironmentDetail']['governance']>['decisionDelegations']
>[number];

// ---------------------------------------------------------------------------
// Service layer (W3)
// ---------------------------------------------------------------------------

export type ServiceOrigin = Schema['ServiceOrigin'];
/** public=anyone who can read the env; members=env members; hidden=provider agent owner + env owner. */
export type ServiceVisibility = Schema['ServiceVisibility'];

export type ServiceProviderRef = Schema['ServiceProvider'];

/**
 * Learned track record of (provider agent × semantic type), P4-1. `score` is
 * the decayed Bayesian success rate (prior 0.7); `attempts` the raw use
 * count (drives the insufficient-data display).
 */
export type ServiceReputation = Schema['ServiceReputation'];

/** Response of GET /api/environments/:id/agents/:agentId/reputation (P4-1). */
export type AgentReputation = Schema['AgentReputation'];

export type WorldService = Schema['ServiceInstance'];

export type CreateServiceInput = Schema['PublishServiceBody'];

export type PatchServiceInput = Schema['PatchServiceBody'];

/** T-069 (R23): a standing ask on the demand board (需求板). */
export type StandingAsk = Schema['StandingAsk'];

/** Fix-19: the owner-written structured guide to a world (all fields optional text). */
export type EnvGuide = Schema['EnvGuide'];

/** Fix-19: one entry of the environment activity feed (newest first). */
export type EnvActivityEntry = Schema['ActivityEntry'];

/** T-071/R6-D-F01: the env's arrival digest — the achievement timeline's source. */
export type ArrivalDigest = Schema['ArrivalDigest'];

/** R5-F06: one terminated agreement as a world outcome (achievement entry). */
export type CompletedCollaborationEntry = Schema['CompletedCollaborationEntry'];

/** v60 (R6-E-F08): env-owner-only provider-lost work-queue entry. */
export type ProviderUnavailableAgreementEntry = Schema['ProviderUnavailableAgreementEntry'];

/**
 * Mirror of the environment detail response (GET/POST /api/environments[/:id]).
 * Patch over the generated schema: the contract types `events` as EnvMapEvent
 * (the UI reuses the ScenarioEvent shape, which also carries replay
 * `details`), and `mySubscriptions` is emitted only for authenticated callers
 * in practice.
 */
export type EnvironmentDetail = Omit<
  Schema['EnvironmentDetail'],
  'zones' | 'events' | 'devices' | 'mySubscriptions'
> & {
  zones: EnvZone[];
  /** Scheduled events baked into the world (empty for grid imports). */
  events: ScenarioEvent[];
  devices: WorldDevice[];
  /** W5: ids of services the caller bookmarked in this env (empty when anonymous). */
  mySubscriptions?: string[];
};

// ---------------------------------------------------------------------------
// User perspective (W5)
// ---------------------------------------------------------------------------

/** One per-env card of the workbench overview (caller is a member). */
export type MeOverviewEnv = Schema['MeOverviewEnv'];

/** Flat "我发布的服务" entry (across the caller's environments). */
export type MyServiceRef = Schema['MyServiceRef'];

/**
 * Hand-written subset of the generated MySubscriptionRef.provider: the
 * contract also emits `ownerId` (Fix-10), which the UI does not consume yet.
 */
export interface ServiceProviderSummary {
  agentId: string;
  agentName: string;
  ownerName: string;
}

/** Flat "我依赖的服务" entry (the caller's bookmarks, across envs). */
export type MySubscriptionRef = Omit<Schema['MySubscriptionRef'], 'provider'> & {
  provider: ServiceProviderSummary;
};

/** Fix-16: the workbench's actionable-attention counts. */
export type MeOverviewTodos = Schema['MeOverview']['todos'];

/** Response of GET /api/me/overview. */
export type MeOverview = Omit<Schema['MeOverview'], 'user' | 'mySubscriptions'> & {
  user: PublicUser;
  mySubscriptions: MySubscriptionRef[];
};

/** Response of PUT /api/services/:id/subscribe (200/201). */
export type ServiceSubscriptionResult = Schema['ServiceSubscription'];

/** One devicesToDeploy entry of the deployment manifest. */
export type DeploymentDevice = Schema['DeploymentManifest']['devicesToDeploy'][number];

export type DeploymentServiceOffer = Schema['DeploymentManifest']['servicesToOffer'][number];

export type DeploymentServiceConsumed = Omit<
  Schema['DeploymentManifest']['servicesConsumed'][number],
  'provider'
> & {
  provider: ServiceProviderSummary;
};

/** Response of GET /api/environments/:id/deployment — the caller's manifest. */
export type DeploymentManifest = Omit<Schema['DeploymentManifest'], 'servicesConsumed'> & {
  servicesConsumed: DeploymentServiceConsumed[];
};

/**
 * Patch over CreateEnvironmentBody: the contract marks `mapType` required
 * (server default `grid`); the frontend omits it to take the default.
 */
export type CreateEnvironmentInput = Omit<Schema['CreateEnvironmentBody'], 'mapType'> & {
  mapType?: string;
};

export type CreateDeviceInput = Schema['CreateDeviceBody'];

/** PATCH /api/agents/:id — any subset; `llm: null` clears the agent's llm. */
export type PatchAgentInput = Schema['PatchAgentBody'];

export type PatchDeviceInput = Schema['PatchDeviceBody'];

// ---------------------------------------------------------------------------
// Flows (user-orchestrated business flows — "when <trigger> → run <plan>")
// ---------------------------------------------------------------------------

export type FlowCondition = Schema['FlowCondition'];

export type FlowTrigger = Schema['FlowTrigger'];

export type FlowPlanNode = Schema['FlowPlanNode'];

/** Mechanism A: delegate node (bounded LLM judgment step inside a flow). */
export type FlowDelegateNode = Schema['FlowDelegateNode'];

/** R6-B-F03: service node (cross-tenant orchestration via an active agreement). */
export type FlowServiceNode = Schema['FlowServiceNode'];

/** FEAT-05: notify node (deterministic notification lane to the user inbox). */
export type FlowNotifyNode = Schema['FlowNotifyNode'];

/** FEAT-06: wait node (deterministic sim-second delay). */
export type FlowWaitNode = Schema['FlowWaitNode'];

/** Any plan node: action, delegate, service, notify or wait. */
export type FlowPlanAnyNode = Schema['FlowPlan']['nodes'][number];

export type FlowPlan = Schema['FlowPlan'];

export type Flow = Schema['Flow'];

/**
 * One flow execution ledger entry. The contract types `nodeResults` as a
 * free-form object; the UI drills into core PlanNodeResult's shape, so it is
 * narrowed here (same pattern as TrajectoryRecordDto above).
 */
export interface FlowNodeResult {
  status: string;
  attempts: number;
  error?: string;
  note?: string;
  /** T-201: the device this node actuated (present once the invoker resolved one). */
  deviceId?: string;
}

export type FlowRun = Omit<Schema['FlowRun'], 'nodeResults'> & {
  nodeResults: Record<string, FlowNodeResult>;
};

/**
 * Patch over CreateFlowBody: the contract marks `enabled` required (server
 * default `true`); the frontend omits it to take the default.
 */
export type CreateFlowInput = Omit<Schema['CreateFlowBody'], 'enabled'> & {
  enabled?: boolean;
};

export type PatchFlowInput = Schema['PatchFlowBody'];

/** One issue from the 422 FLOW_INVALID validation report (core PlanIssue). */
export interface FlowIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Device catalog (P2b)
// ---------------------------------------------------------------------------

export type CatalogModelSummary = Schema['CatalogModelSummary'];

export type CatalogModelDetail = Schema['CatalogModelDetail'];

// ---------------------------------------------------------------------------
// Home Assistant bridge (P3a status/entities + P3b actuation safety)
// ---------------------------------------------------------------------------

/** GET /api/hass/status — never errors; it REPORTS the connection state. */
export type HassStatus = Schema['HassStatus'];

/** One entity row of GET /api/hass/entities (deployment-UI preview). */
export type HassEntitySummary = Schema['HassEntitySummary'];

export type PolicyEffect = Schema['HassPolicy']['effect'];

/** One safety policy row (GET/POST /api/hass/policies). */
export type HassPolicy = Schema['HassPolicy'];

export type HassPendingStatus = Schema['HassPendingCommand']['status'];

/** One parked command awaiting confirmation (GET /api/hass/pending). */
export type HassPendingCommand = Schema['HassPendingCommand'];

/**
 * Response of POST /api/hass/pending/:id/approve (200). Patch over the
 * generated HassPendingApprovalResult to narrow `status` to 'approved'.
 */
export type HassApproveResult = Omit<Schema['HassPendingApprovalResult'], 'status'> & {
  status: 'approved';
};

export type HassAuditDecision = Schema['HassAuditEntry']['decision'];

/** One audit-feed row (GET /api/hass/audit; newest first). */
export type HassAuditEntry = Schema['HassAuditEntry'];

/** GET/POST/DELETE /api/hass/estop — the emergency-stop state. */
export type HassEstopState = Schema['HassEstopState'];

// ---------------------------------------------------------------------------
// World stream (GET /api/environments/:id/stream) — P2b world sync.
// F0-1 (R84): the frame types come from the shared registry
// (packages/shared/src/stream-frames.ts) — the single source of truth the
// server publishes from; the hand-written mirrors that let R82-F2 happen
// are gone. The contract test (src/test/streamFramesContract.test.ts) pins
// WorldStreamMessage's kind set to the registry's STREAM_FRAME_KINDS and the
// parser dispatch to both.
//
// Recorded server↔web differences (deliberate, contract-tested):
// - world frames may carry objectType 'flow' (flows routes); the web parser
//   drops them — the flows page refetches instead of streaming edits;
// - proposal/agreement/error frames are typed here but NOT dispatched by the
//   world-stream hook (governance surfaces poll the activity feed; 'error'
//   is a T-007 teaching frame for broken integrations). They are listed in
//   KNOWN_UNHANDLED_STREAM_KINDS (lib/worldStreamRouter.ts).
// ---------------------------------------------------------------------------

import type {
  AgreementEventMessage,
  PresenceMessage,
  ProposalEventMessage,
  StreamErrorMessage,
  WorldChangeMessage,
  WorldSessionStatusMessage,
} from '@active-collaboration/shared';

export type {
  AgreementEventMessage,
  AgreementStreamAction,
  PresenceMessage,
  PresenceSnapshotMessage,
  PresenceUpdateMessage,
  PresenceUserRef,
  ProposalEventMessage,
  ProposalStreamAction,
  StreamErrorMessage,
  WorldAction,
  WorldChangeMessage,
  WorldObjectType,
  WorldSessionStatusMessage,
} from '@active-collaboration/shared';

/** Any message on the environment stream (world changes + presence + governance + session + teaching errors). */
export type WorldStreamMessage =
  | WorldChangeMessage
  | PresenceMessage
  | ProposalEventMessage
  | AgreementEventMessage
  | StreamErrorMessage
  | WorldSessionStatusMessage;

// ---------------------------------------------------------------------------
// Agreements (Fix-11 service consumption)
// ---------------------------------------------------------------------------

export type AgreementStatus = Schema['AgreementStatus'];

/** All-optional contract terms; absent fields mean "unlimited" (§3.1). */
export type AgreementTerms = Schema['AgreementTerms'];

/**
 * Hand-written required-fields version of the contract's agreement service
 * summary (the contract marks every field optional; the UI renders them
 * unconditionally).
 */
export interface AgreementServiceRef {
  id: string;
  name: string;
  semanticType: string;
}

/** One agreement row (GET /api/agreements, propose/decide/suspend/terminate). */
export type Agreement = Omit<Schema['ServiceAgreement'], 'service'> & {
  /** Null when the service row is gone. */
  service: AgreementServiceRef | null;
};

/**
 * T30 RESTRICTED view of a TERMINATED agreement (server
 * terminatedAgreementRestrictedJson): non-party members — and anonymous
 * readers of a public env — read participants as AGENTS plus the outcome and
 * timestamps; no owner identities, no terms. The `view: 'restricted'`
 * discriminator tells it apart from the full Agreement in the same list
 * response (the ?include=terminated lane).
 */
export interface RestrictedAgreementView {
  id: string;
  envId: string;
  status: AgreementStatus;
  source: Agreement['source'];
  collaborationId: string | null;
  service: { id: string | null; name: string | null };
  consumerAgentId: string | null;
  consumerAgentName: string | null;
  providerAgentId: string | null;
  providerAgentName: string | null;
  /** completed | cancelled | ended-without-delivery (or a usage outcome). */
  outcome: string;
  terminatedAt: string;
  view: 'restricted';
}

/** A row of GET /api/agreements — full party view or the restricted lane. */
export type AgreementListEntry = Agreement | RestrictedAgreementView;

export function isRestrictedAgreementView(
  entry: AgreementListEntry,
): entry is RestrictedAgreementView {
  return (entry as RestrictedAgreementView).view === 'restricted';
}

/** Body of POST /api/services/:id/agreements (all fields optional). */
export type ProposeAgreementInput = Schema['ProposeAgreementBody'];

/** Response of POST /api/agreements/:id/remind (T-309/T-059 — the nudge). */
export type AgreementRemindResult = {
  agreementId: string;
  status: string;
  /** False when a noise-control rule dropped the notification. */
  reminded: boolean;
  note?: string;
};

/** R14 Wave-A data frame (§3.2) — pull body and push message share it. */
export type DataFrame = Schema['DataFrame'];

/** Response of POST /reads and GET /reads/latest — frame + applied + metering. */
export type DataReadResult = Schema['DataReadResult'];

/** Body of POST /api/agreements/:id/reads (both fields optional). */
export interface ReadAgreementInput {
  simulationId?: string;
  fields?: string[];
}

/** One settlement receipt (§3.4; GET /api/agreements/:id/receipts). */
export type SettlementReceipt = Schema['SettlementReceipt'];

/** One metering record (GET /api/agreements/:id/usage; append-only). */
export type UsageRecord = Schema['UsageRecord'];

/** Response of POST /api/agreements/:id/invocations. */
export type AgreementInvocationResult = Schema['InvocationResult'];

// ---------------------------------------------------------------------------
// Simulation collaborations (Fix-8) — not in the contract
// ---------------------------------------------------------------------------

/** One collaboration session as seen by ONE agent (one row per view). */
export interface RuntimeCollaborationRecord {
  /** Shared collaboration id (same on both sides). */
  id: string;
  /** Agent whose session view this row is. */
  agentId: string;
  role: 'initiator' | 'participant';
  /** pending | in_progress | active | completed | failed | cancelled */
  status: string;
  type: string;
  initiator: string;
  participants: string[];
  description: string;
  createdAt: string;
  updatedAt: string;
  /** True when the session already moved to history (terminal status). */
  history: boolean;
}

// ---------------------------------------------------------------------------
// Notifications (Fix-16)
// ---------------------------------------------------------------------------

/** One inbox row; `body` is the parsed JSON detail object (kind-specific). */
export type AppNotification = Schema['Notification'];

/** Response of GET /api/notifications (unreadCount is always present). */
export type NotificationListResult = Schema['NotificationList'];

// ---------------------------------------------------------------------------
// Blueprints (Fix-38) — not in the OpenAPI contract yet; hand-written.
// Mirrors apps/server/src/db/blueprint-store.ts and routes/blueprints.ts.
// ---------------------------------------------------------------------------

export interface BlueprintDeviceDef {
  name: string;
  type: string;
  capabilities: string[];
  /** Template variable (${zoneId}) or literal — resolved at install time. */
  zoneId: string;
  initialState?: Record<string, unknown>;
}

export interface BlueprintAgentDef {
  name: string;
  capabilities: string[];
  managesZoneIds: string[];
  /** Indexes into the definition's devices array. */
  boundDeviceIndexes: number[];
}

export interface BlueprintFlowDef {
  name: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  plan: { goal: string; nodes: Array<Record<string, unknown>> };
}

/**
 * R6-D-S3: collaboration-pair metadata — "this card pairs with blueprint X".
 * Display/hint only; the install path never reads it.
 */
export interface BlueprintPartnerSuggestion {
  blueprintId: string;
  note?: string;
}

export interface BlueprintDefinition {
  devices: BlueprintDeviceDef[];
  agents: BlueprintAgentDef[];
  flows?: BlueprintFlowDef[];
  partnerSuggestion?: BlueprintPartnerSuggestion;
}

/** One row of GET /api/blueprints (bpToJson). */
export interface Blueprint {
  id: string;
  name: string;
  description: string;
  definition: BlueprintDefinition;
  isBuiltin: boolean;
  createdBy: string | null;
}

/** 201 response of POST /api/environments/:envId/blueprints/:bpId/install. */
export interface BlueprintInstallResult {
  blueprintId: string;
  blueprintName: string;
  envId: string;
  zoneId: string;
  createdIds: { devices: string[]; agents: string[]; flows: string[] };
  summary: { devices: number; agents: number; flows: number };
}

// ---------------------------------------------------------------------------
// Quest levels (R6-D-M1, gamification-design.md §2) — hand-written, mirrors
// apps/server/src/quests.ts (deriveQuests output of GET …/quest-state).
// ---------------------------------------------------------------------------

export type QuestId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export type QuestHint =
  | 'import-building'
  | 'install-blueprint'
  | 'bind-agent'
  | 'install-collab-pair'
  | 'complete-agreement'
  | 'compose-flow';

export interface QuestStatus {
  id: QuestId;
  achieved: boolean;
  locked: boolean;
  hint: QuestHint;
}

/** Response of GET /api/environments/:id/quest-state. */
export interface QuestState {
  quests: QuestStatus[];
  current: QuestId | null;
}

// ---------------------------------------------------------------------------
// Roster report (Fix-37) — owner-only grading export; not in the contract.
// Mirrors GET /api/environments/:id/roster-report in routes/environments.ts.
// ---------------------------------------------------------------------------

/** One member's app inventory row of the roster report. */
export interface RosterReportEntry {
  userId: string;
  displayName: string;
  email: string;
  role: EnvRole;
  counts: { devices: number; agents: number; flows: number; services: number };
  inventory: {
    devices: Array<{ id: string; name: string; type: string }>;
    agents: Array<{ id: string; name: string }>;
    flows: Array<{ id: string; name: string; enabled: boolean }>;
  };
}

/** JSON response of GET /api/environments/:id/roster-report. */
export interface RosterReport {
  envId: string;
  envName: string;
  generatedAt: string;
  totalMembers: number;
  entries: RosterReportEntry[];
}

// ---------------------------------------------------------------------------
// Eval report (Fix-22 + Wave-3a) — GET /api/simulations/:id/eval-report.
// Hand-written to match the server aggregate (apps/server/src/eval-report.ts);
// includes `unlabeled`, which the OpenAPI schema omits but the route returns.
// ---------------------------------------------------------------------------

/** Decision-quality metrics for one simulation (see eval-report.ts). */
/** One agent's meta-cognition summary on the eval report (R40-B2). */
export interface MetaAgentCognition {
  agentId: string;
  agentName: string;
  /** 1 − weighted ECE; null = no evaluable decisions yet (honest empty). */
  calibrationScore: number | null;
  decisionCount: number;
  evaluatedDecisions: number;
  successRate: number | null;
  topUncalibratedActions: Array<{
    action: string;
    count: number;
    avgConfidence: number;
    successRate: number;
    gap: number;
  }>;
  capabilityBoundary: { strong: string[]; weak: string[]; mustEscalate: string[] };
  trustPartners: Array<{ partnerId: string; trust: number; interactions: number }>;
}

export interface EvalReport {
  simId: string;
  /** Null when a disk-rebuilt report has no trajectory records. */
  scenarioId: string | null;
  environmentId?: string;
  /** registry = live in-memory record; disk = rebuilt after a restart. */
  source: 'registry' | 'disk';
  /** Null for disk-rebuilt reports (runtime state is unrecoverable). */
  state: 'created' | 'running' | 'paused' | 'stopped' | null;
  simTimeSec: number | null;
  /** Disk-rebuild degradation notes, only present for source 'disk'. */
  notes?: string[];
  /**
   * R40-B2: per-agent meta-cognition face (calibration / capability
   * boundary / trust). Registry-only — the disk fallback degrades honestly
   * by omitting it.
   */
  metaAgents?: MetaAgentCognition[];
  /** Distinct events that produced an assessed decision. */
  events: number;
  decisions: {
    total: number;
    correct: number;
    /** Ground-truth-less decisions, excluded from the accuracy denominator. */
    unlabeled: number;
    /** Null when every decision is unlabeled. */
    accuracy: number | null;
    /** Decision count by decisionSource (precheck|rule|llm|triage). */
    bySource: Record<string, number>;
  };
  handshakes: {
    initiated: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
  };
  effectChecks: {
    attempts: number;
    successes: number;
    failures: number;
    /** Temperature-class capability pass rate (successes/attempts). */
    passRate: number | null;
  };
  /**
   * F3-2（plan-r84）轨迹级小节：链路完整率 / LLM 结构化输出合规率 /
   * LLM 失败计数。数据全部来自 trajectory 已有字段，无新埋点。
   */
  trajectory?: {
    llmFailures: number;
    structuredOutput: { llm: number; json: number; fsm: number; jsonRate: number | null };
    chain: { actionable: number; withFeedback: number; completeness: number | null };
  };
  reputation: {
    totals: { attempts: number; successes: number; failures: number };
    agents: Array<{ agentId: string; attempts: number; successes: number; failures: number }>;
  };
}

// ---------------------------------------------------------------------------
// Eval runs (Wave-3a batch jobs) — POST /api/environments/:id/eval-runs,
// GET /api/eval-runs/:id, and the T-016 environment list. Hand-written to
// match the server serializers (apps/server/src/routes/eval-runs.ts).
// ---------------------------------------------------------------------------

export type EvalRunStatus = 'pending' | 'running' | 'done' | 'failed';

/** The headline rates one arm of a finished batch carries (eval-report 口径). */
export interface EvalRunArmMetrics {
  decisions: { accuracy: number | null };
  handshakes: { successRate: number | null };
  effectChecks: { passRate: number | null };
}

/** One arm of a finished batch's result (subset the panel renders). */
export interface EvalRunResultArm {
  label: string;
  status: 'done' | 'failed';
  simId?: string;
  llm?: 'llm' | 'rule-only';
  llmModel?: string;
  llmPromptVariant?: string;
  durationMs: number;
  error?: string;
  metrics?: EvalRunArmMetrics;
}

/** GET /api/eval-runs/:id — the full job row (spec echoes the submit body). */
export interface EvalRunJob {
  id: string;
  envId: string;
  createdBy: string;
  status: EvalRunStatus;
  spec: { runs?: unknown[] } & Record<string, unknown>;
  result?: {
    envId: string;
    generatedAt: string;
    runs: EvalRunResultArm[];
    comparison: {
      labels: string[];
      metrics: Record<string, Array<number | null>>;
    };
  };
  error?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * T-016 list summary row (GET /api/environments/:id/eval-runs): arms = the
 * batch's run count; metricsDigest averages the three headline rates across
 * metric-bearing arms (null while pending/running/failed).
 */
export interface EvalRunSummary {
  id: string;
  envId: string;
  createdBy: string;
  status: EvalRunStatus;
  arms: number;
  metricsDigest: {
    decisionAccuracy: number | null;
    handshakeSuccessRate: number | null;
    effectCheckPassRate: number | null;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * POST /api/agents/:id/what-if (R40-B1) — the prediction face. Typed
 * hand-written over the contract's WhatIfResponse (the /command
 * verification rides the same verdict vocabulary).
 */
export interface WhatIfResult {
  agentId: string;
  simulationId: string;
  simTimeSec: number;
  durationMs: number;
  result: {
    scenario: Record<string, unknown>;
    baseline: Record<string, number[]>;
    intervention: Record<string, number[]>;
    delta: Record<string, number>;
    verdict: 'improvement' | 'neutral' | 'degradation' | 'inconclusive';
    confidence: number;
    rationale?: string;
  };
}

/** The verify-before-act verdict embedded in /command results (R40-B1). */
export interface NLVerification {
  verdict: 'improvement' | 'neutral' | 'degradation' | 'inconclusive';
  confidence: number;
  blocked: boolean;
  rationale?: string;
}

/**
 * GET /api/health — the public liveness payload (R74 adds `decision`).
 * Only the fields the frontend consumes are typed; the server may carry more.
 */
export interface PublicHealth {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSec: number;
  worlds: { environments: number; sims: { total: number; running: number } };
  /** R74: decision posture — 'rule-test' is the TEST-ONLY rule harness;
   * 'llm-unreachable' means the configured LLM backend is down (degrading).
   * UX-R2: `unreachableDetail` carries the last probe error (optional). */
  decision: { mode: 'llm' | 'llm-unreachable' | 'rule-test'; model?: string; unreachableDetail?: string };
  checks: { database: 'ok' | 'fail' };
  /** Alpha capacity gating (EAF_INVITE_ONLY, schema v57): true ⇒ the register
   *  form must collect an invite code. */
  auth: { inviteOnly: boolean };
}
