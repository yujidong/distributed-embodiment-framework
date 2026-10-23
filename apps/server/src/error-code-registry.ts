/**
 * Error-code registry (R21-W5 guard d) — the checked-in list of EVERY
 * error code apps/server can emit.
 *
 * arch-guards.vitest.test.ts re-derives the set from source
 * (new ApiError(<status>, 'CODE' ...) + errorBody('CODE' ...)) and fails
 * on drift in EITHER direction:
 *   - a NEW code emitted but missing here  → add it to this list; that is
 *     the deliberate friction point where you also decide whether
 *     openapi.yaml documents it (the spec does not carry every internal
 *     code — but the DECISION must be explicit, not accidental).
 *   - a code listed here but no longer emitted → remove it (dead registry
 *     entries hide real removals).
 */
export const ERROR_CODES: readonly string[] = [
  'ACCESS_GRANT_NOT_FOUND',
  'API_KEY_NOT_FOUND',
  'API_KEY_SCOPE',
  'ACCESS_GRANT_REVOKED',
  'ACCESS_REQUEST_NOT_FOUND',
  'ACCESS_REQUEST_NOT_PENDING',
  'AGENT_CAPABILITIES_UNBACKED',
  'ASK_NOT_FOUND',
  'ASK_NOT_OPEN',
  'ASK_QUOTA_EXCEEDED',
  'AGENT_NOT_FOUND',
  'AGENT_AMBIGUOUS',
  'AGREEMENT_NOT_ACTIVE',
  'AGREEMENT_NOT_COUNTERED',
  'AGREEMENT_NOT_HELD',
  'AGREEMENT_HELD',
  'ADOPT_CONFIG_ARTIFACT_FORBIDDEN',
  'AGREEMENT_NOT_FOUND',
  'AGREEMENT_NOT_PROPOSED',
  'AGREEMENT_TERMINAL',
  'AGREEMENT_TERMS_VIOLATION',
  'ALREADY_MEMBER',
  'BACKUP_FAILED',
  'BACKUP_NOT_SUPPORTED',
  'BAD_GEO',
  'BAD_REQUEST',
  'BLUEPRINT_INVALID',
  'BLUEPRINT_NOT_FOUND',
  'CHECKPOINT_TOO_LARGE',
  'CHECKPOINT_UNREADABLE',
  'CHECKPOINT_UNSUPPORTED',
  'CHECKPOINT_WRITE_FAILED',
  'COMPUTATION_EVALUATION_FAILED',
  // T46 (R4, u4-P2-3): a device-input computation whose provider binding
  // resolved to ZERO devices served a plausible-looking power=0 — a fake
  // number. The read lane refuses (metered failure) until the provider
  // re-binds; "0 devices seen" is never dressed up as a reading.
  'COMPUTATION_DEVICE_INPUTS_EMPTY',
  // T54 (R6, u4-F1): the third sibling — the binding resolved AND the value
  // metric produced a number, but the number came straight off scenario
  // initialState (the device's state paths were NEVER written in this
  // world). A placeholder 0 metered as a successful delivery is the same
  // lie one layer deeper; the read refuses (metered failure) with the
  // zone-parameter cross-face contrast named when present.
  'COMPUTATION_DEVICE_STATE_UNWRITTEN',
  // T50 (R5, u2-F1): the sibling gate — the binding RESOLVED to devices, but
  // a value metric (avg/min/max/sum) had NO usable value (capability
  // re-declared away, state key gone, zones lack the parameter), so the
  // field read null. A null metered as a successful delivery is the same
  // lie as a fabricated zero; the read refuses (metered failure).
  'COMPUTATION_METRIC_NO_READING',
  'COMPUTATION_NOT_REGISTERED',
  'COMPUTATION_SCHEMA_DRIFT',
  'COMPUTATION_UNREGISTERED',
  // T129 (R21-F1): the consumption lanes' honest targeting floor. Session-
  // targeting (the world-session wake/catch-up behind the shared resolver)
  // used to hold callers past the gateway's ~100s kill with no platform
  // answer (the r21 outage; the T128 invoke floor sat AFTER this await).
  // 503 + retryAfterSec; the targeting keeps completing server-side.
  // CONSUMPTION_TARGET_PENDING: the invoke lane's targeting phase and the
  // stream upgrade handshake. READ_TARGETING_PENDING: the read lane.
  'CONSUMPTION_TARGET_PENDING',
  'CONSENT_CLASS_NOT_PROPOSABLE',
  'CONTENT_LENGTH_MISMATCH',
  'DATA_SCHEMA_MISMATCH',
  'DATA_STALE',
  'DELEGATION_ALREADY_GRANTED',
  'DELEGATION_GRANTEE_NOT_MEMBER',
  'DELEGATION_NOT_FOUND',
  'DEVICE_COMMAND_NOT_EXECUTABLE',
  'DEVICE_NOT_FOUND',
  'DEVICE_NOT_MANAGED',
  'DEVICE_SCOPE_INVALID',
  'EMAIL_TAKEN',
  'ENGINE_ERROR',
  'ENVIRONMENT_INVALID',
  'ENVIRONMENT_NOT_FOUND',
  'ESTOP_ACTIVE',
  'EVENT_SOURCE_NOT_FOUND',
  'ENV_NOT_PUBLIC',
  'EVAL_RUN_NOT_FOUND',
  'FLOW_ENGINE_UNAVAILABLE',
  'FLOW_INPUTS_REQUIRED',
  'FLOW_INVALID',
  'FLOW_NOT_FOUND',
  'FLOW_NOT_RUNNABLE',
  'FLOW_PARAMS_INVALID',
  'FLOW_QUOTA_EXCEEDED',
  'FLOW_RUN_ASYNC',
  'FLOW_RUN_REQUIRES_ENVIRONMENT',
  'FLOW_STALE_SIMULATION',
  'FLOW_SERVICE_LANE',
  // UX wave-3 (import lanes): the floorplan lane's two honest failures —
  // 503 when the deployment has no vision-capable LLM configured (teaching
  // how to configure one / naming the LLM-free IFC+OSM alternatives), 502
  // when the recognition call itself fails (provider/model named in issues).
  'FLOORPLAN_RECOGNITION_FAILED',
  'FLOORPLAN_VISION_UNAVAILABLE',
  'FORBIDDEN',
  'GRANTEE_NOT_MEMBER',
  'GRANT_EXPIRY_NOT_SHORTER',
  'HASS_CONNECT_FAILED',
  'HASS_NOT_CONFIGURED',
  'HASS_UNKNOWN_ENTITY',
  // UX wave-3 (import lanes): the uploaded IFC is not parseable STEP / has
  // no usable spatial structure — 422, the message says what was wrong.
  'IFC_IMPORT_FAILED',
  'INTERNAL',
  'INVALID_CREDENTIALS',
  'INVALID_CURRENT_PASSWORD',
  'INVALID_DISPLAY_NAME',
  'INVALID_EMAIL',
  'INVALID_EVENT_VALUE',
  'INVALID_EXPIRES_IN_DAYS',
  'INVALID_MAX_USES',
  // T128 (R20-u2 F1): invoke's honest wait floor — the provider agent's
  // decision is still running when the connection's wait limit (default
  // 90s, under the gateway's 100s kill) is reached. 503 + retryAfterSec;
  // the execution finishes in the background and lands its metering.
  'INVOKE_DECISION_PENDING',
  // R102 (wang-17): invoke param-value validation refuses with the name,
  // the expectation and the received value (validator: simulation's
  // capability-contract — the R101 capability→handler truth chain).
  'INVALID_PARAMS',
  'INVALID_PASSWORD',
  'INVALID_SCENARIO_ID',
  'INVALID_TEMPLATE_ID',
  'INVALID_WEBHOOK_URL',
  'INVITE_GATE_UNCONFIGURED',
  'INVITE_GONE',
  'INVITE_INVALID',
  'INVITE_NOT_FOUND',
  'INVITE_REQUIRED',
  'MAP_ZONES_CLEAR_UNCONFIRMED',
  'MEMBER_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'MODEL_NOT_FOUND',
  // UX wave-5 (NL import lane): no text LLM configured → 503 (teaching:
  // LLM_BASE_URL+LLM_MODEL / LLM_NL_MODEL, or the LLM-free IFC+OSM lanes);
  // the recognition call itself failing → 502; a description with no
  // building cues → 422 with example phrasings.
  'NL_IMPORT_FAILED',
  'NL_IMPORT_NO_BUILDING',
  'NL_IMPORT_UNAVAILABLE',
  'NOTIFICATION_NOT_FOUND',
  'NO_TARGET_SIMULATION',
  'NOT_AN_ENV_MEMBER',
  'NOT_A_MEMBER',
  'NOT_A_WORLD_SESSION',
  'NO_TRAJECTORY_DIR',
  'NO_WORLD_CHECKPOINT',
  // FEAT-07 phase 2 (calendar overlay): the zone occupant-schedule PATCH
  // refuses a degenerate overlay window (endsAtSimSec <= startsAtSimSec)
  // with a teaching message; documented in openapi.yaml on the endpoint.
  'OCCUPANT_OVERLAY_WINDOW_INVALID',
  // UX wave-3 (OSM import lane): Overpass unreachable/erroring on every
  // mirror → 503; a valid answer with zero usable building ways → 404.
  'OSM_IMPORT_UNAVAILABLE',
  'OSM_NO_BUILDINGS_FOUND',
  'OWNER_CANNOT_BE_DELEGATE',
  'OWNER_CANNOT_LEAVE',
  'OWNER_ROLE_IMMUTABLE',
  'PENDING_EXPIRED',
  'PENDING_NOT_ACTIONABLE',
  'PENDING_NOT_FOUND',
  'POLICY_NOT_FOUND',
  'PROPOSAL_NOT_APPLICABLE',
  'PROPOSAL_NOT_APPLIED',
  'PROPOSAL_NOT_DECIDABLE',
  'PROPOSAL_NOT_ESCALATED',
  'PROPOSAL_NOT_FOUND',
  'PROPOSAL_NOT_REVERTIBLE',
  'QUOTA_EXCEEDED',
  // T129 (R21-F1): the read lane's targeting floor (see CONSUMPTION_TARGET_
  // PENDING above) — a read whose world session is still waking / catching up
  // answers 503 + retryAfterSec, never a bare 504; nothing is metered and a
  // retry is safe (a read never double-executes).
  'READ_TARGETING_PENDING',
  'REAL_DEVICE_SURFACE',
  'REMIND_RATE_LIMITED',
  'REQUEST_BODY_TOO_LARGE',
  'REVERSE_SYNC_DISABLED',
  'ROUTE_NOT_FOUND',
  'SANDBOX_MEMBER_NOT_FOUND',
  'SANDBOX_NOT_FOUND',
  'SCENARIO_EXISTS',
  'SCENARIO_ID_MISMATCH',
  'SCENARIO_NOT_FOUND',
  'SCENARIO_READONLY',
  'SCENARIO_VALIDATION_FAILED',
  'SERVICE_BACKING_AMBIGUOUS',
  'SERVICE_BACKING_INVALID',
  'SERVICE_DERIVED_READONLY',
  'SERVICE_FLOW_MANAGED',
  'SERVICE_NOT_BACKED',
  'SERVICE_NOT_FOUND',
  'SERVICE_NOT_HIDDEN',
  'SERVICE_NOT_STREAMABLE',
  'SERVICE_ZONE_UNREACHABLE',
  'SHARE_NOT_FOUND',
  'SHARE_REVOKED',
  'SHADOW_EXISTS',
  'SHADOW_FORK_FAILED',
  'SHADOW_NOT_FOUND',
  'SHADOW_NO_BOUND_DEVICES',
  'SIMULATION_AMBIGUOUS',
  'SIMULATION_NOT_FOUND',
  'SIMULATION_NOT_HIBERNATED',
  'SIMULATION_NOT_RUNNING',
  'SIMULATION_STOPPED',
  'SIMULATION_UNAVAILABLE',
  'SIM_ALREADY_STOPPED',
  'SIM_HIBERNATED',
  'STEP_TOO_LARGE',
  'SYNC_BINDING_NOT_FOUND',
  'SYNC_BINDING_NOT_SENSORY',
  'TEMPLATE_NOT_FOUND',
  // UX wave-3 (template parameterization): POST …/instantiate values failed
  // validation — unknown var / non-integer / outside [min,max]; the message
  // restates the declared vars and their ranges.
  'TEMPLATE_VARS_INVALID',
  'TEST_INFRA_DISABLED',
  'UNAUTHORIZED',
  'UNKNOWN_COMMAND',
  'UNKNOWN_ZONE',
  'USER_NOT_FOUND',
  // T41 (R4, u1-F1): the what-if text lane's catalog-change window — a
  // question that names a device the DB has while the parse views lack it is
  // a mid-churn world, answered 503 "retry in a moment", never a 400 that
  // teaches the user to reword a healthy sentence.
  'WORLD_CATALOG_CHANGING',
  'WORLD_SESSION_CLOSED',
  'WORLD_SESSION_EXISTS',
  'WORLD_SESSION_PAUSE_UNSUPPORTED',
  'WORLD_SESSION_WAKE_FAILED',
];
