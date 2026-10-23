/**
 * Scenario Types — runtime-facing scenario definition (platform schema v1.0)
 *
 * A `ScenarioDefinition` is the fully-validated, defaults-applied form of a
 * scenario JSON file (see `scenario-schema.ts` for the wire format and
 * `scenario-loader.ts` for validation/loading). It is the single input an
 * `EngineRuntime` needs to build a long-running simulated world: zones,
 * devices, agents, and (optionally) scheduled events.
 *
 * This type intentionally mirrors — but does not import — the experiment
 * infrastructure's scenario shapes (packages/core/tests/experiments). The
 * experiment types carry evaluation ground truth; the platform schema carries
 * deployment metadata (bindings, LLM provisioning hints) instead.
 */

/** Supported schema version. Only "1.0" exists today. */
export type ScenarioVersion = '1.0';

/** Axis-aligned zone bounds (reused from the config module). */
export type { ZoneBounds } from '../config/types.js';
import type { ZoneBounds } from '../config/types.js';
import type { LocalizedText } from '@active-collaboration/shared';
import type { FlowDefinition } from '../flows/flow-types.js';
import type { SemanticOfferRule } from '../service/semantic-offers.js';

/** Scenario metadata block. */
export interface ScenarioMeta {
  /** Unique scenario identifier (kebab-case recommended). */
  id: string;
  /**
   * Human-readable scenario name. Accepts a plain string (legacy) or a
   * `{zh, en}` object; consumers resolve via `localizedText(name, locale)`
   * from `@active-collaboration/shared`.
   */
  name: LocalizedText | string;
  /**
   * What the scenario demonstrates. Accepts a plain string or `{zh, en}`
   * object. Defaults to ''.
   */
  description: LocalizedText | string;
  /**
   * Marketing tagline (Wave 2 / F3 card redesign). Shown prominently in
   * the scenario list UI; ~60 chars zh-CN, ~120 chars en-US.
   */
  tagline?: LocalizedText;
  /**
   * ID of the event that should be the demo's "hero moment" (camera focus
   * + narration). The cinematography UI uses this to pre-warm LLM caches
   * and to suggest the playback rate that hits the event at peak attention.
   */
  heroEventId?: string;
  /**
   * Recommended sim playback rate for demo operators (1 = real-time,
   * 5 = 5x speed). Per-event `cinematography.playbackRateOverride` wins.
   */
  recommendedPlaybackRate?: number;
  /**
   * One-line disclaimer about vendor brand names used illustratively in
   * the scenario. Required by `eaf scenario lint` when any brand name
   * pattern is detected in the file. Accepts a plain string or `{zh, en}`.
   */
  vendorDisclaimer?: LocalizedText | string;
  /**
   * Building tier (B-A): floor-to-floor height in meters. The physics layer
   * derives zone z coordinates as `floor × storeyHeight`. Defaults to 3.5
   * when omitted (see EngineRuntime).
   */
  storeyHeight?: number;
  /**
   * Building tier (B-A): slab attenuation applied to cross-floor diffusion
   * flux (0 = perfect insulation, 1 = no slab). Defaults to 0.15 in the
   * physics layer when omitted.
   */
  slabAttenuation?: number;
  /**
   * Building tier (B-B): envelope flux multiplier applied to indoor↔outdoor
   * diffusion flux (U-value semantics; 0 = hermetic facade, 1 = open to the
   * weather). A zone-level `envelopeU` wins over this. Defaults to 0.1 in
   * the physics layer when omitted.
   */
  envelopeU?: number;
  /**
   * Building tier (B-B): per-person sensible heat in watts for the
   * occupancy effect sources. Defaults to 75 in EngineRuntime.
   */
  occupancyHeatW?: number;
  /**
   * Building tier (B-B): per-person CO2 emission rate (ppm/s at the zone
   * center) for the occupancy effect sources. Defaults to 0.03 in
   * EngineRuntime.
   */
  occupancyCo2Rate?: number;
  /**
   * Explicit opt-in to per-read Gaussian noise on the built-in environmental
   * value models. Defaults to false: undeclared parameters start at their
   * deterministic base value (smoke = 0, CO2 = 400 ppm, ...), so a fresh
   * world is never "dirty" and snapshots are reproducible. Set true to
   * restore the legacy noisy models.
   */
  environmentNoise?: boolean;
  /**
   * FEAT-03: opt-in field dynamics for CUSTOM (non-enum) zone parameters.
   * A key declared here takes the spatial-field path (baseline seeding,
   * localized writes, relaxation toward the seeded baseline) instead of the
   * T-304 static store — the foundation for non-standard quantities
   * (gas / radiation / noise / cleanliness) that must DECAY after an
   * injection. Standard (enum) parameters are REJECTED at load: they
   * already have dedicated physics. Undeclared keys keep the T-304 static
   * semantics exactly.
   */
  parameterPhysics?: Record<string, ScenarioParameterPhysics>;
  /**
   * FEAT-03 (stage 2): device coupling for declared custom parameters.
   * While a zone device matching `capability` (or `deviceType`) is ON, the
   * zone's `zoneParameter` drifts at `ratePerSec` × dt (negative = removal,
   * e.g. a fume hood ventilating gas away). The target MUST be declared in
   * `parameterPhysics` — the load rejects undeclared and standard-parameter
   * targets with a teaching message.
   */
  parameterEffects?: ScenarioParameterEffect[];
  /**
   * R40-B1: what-if predictor quota for THIS world. Absent = the platform
   * default lookahead (WHAT_IF_MAX_DURATION_SEC = 3600). A scenario may
   * tighten the budget (a cheap demo world capping predictions at 300s) or
   * extend it up to WHAT_IF_ABSOLUTE_MAX_DURATION_SEC (7200). The predictor
   * and the platform's what-if lane read this cap before running any fork —
   * a request beyond it is a teaching 4xx, never a silent clamp.
   */
  whatIfQuota?: ScenarioWhatIfQuota;
}

/**
 * FEAT-03: per-key field-dynamics declaration for one CUSTOM zone
 * parameter (see ScenarioMeta.parameterPhysics).
 */
export interface ScenarioParameterPhysics {
  /** Relaxation rate (1/s) toward the zone baseline; default = the field's generic rate (0.005/s). */
  relaxRatePerSec?: number;
  /**
   * Seed a per-location baseline the field relaxes toward (default true).
   * `false` = no seeded baseline: an injection decays toward the environment
   * default (0 for unknown keys) instead of returning to a zone level.
   */
  relaxToBaseline?: boolean;
}

/**
 * FEAT-03 (stage 2): one device-coupling rule for a declared custom zone
 * parameter (see ScenarioMeta.parameterEffects). At least one of
 * `capability` / `deviceType` selects which devices activate the coupling;
 * `ratePerSec` is the per-second drift while such a device is ON in the zone
 * (dt-normalized in the physics layer).
 */
export interface ScenarioParameterEffect {
  /** Device capability name that activates the coupling (e.g. 'ventilation'). */
  capability?: string;
  /** Device type that activates the coupling (e.g. 'fume-hood'). */
  deviceType?: string;
  /** Custom zone parameter this coupling drives (must be declared in `parameterPhysics`). */
  zoneParameter: string;
  /** Per-second change while a matching device is ON (negative = removal). */
  ratePerSec: number;
}

/**
 * The what-if lane's budget inside one scenario (R40-B1). Validation lives
 * in scenario-schema.ts (integer ranges, no unknown fields — a dropped or
 * typo'd quota field would silently change the world's prediction budget).
 */
export interface ScenarioWhatIfQuota {
  /**
   * Max what-if lookahead in simulated seconds (integer 1..7200). Wins over
   * the platform default WHAT_IF_MAX_DURATION_SEC (3600) in BOTH directions:
   * smaller = tighter budget, larger = extended horizon.
   */
  maxDurationSec: number;
  /**
   * Reserved per-day fork budget (documentation/telemetry surface for now —
   * enforcement lands with per-user metering; the field is validated so
   * authored scenarios do not need a migration when it does).
   */
  maxForksPerDay?: number;
}

/**
 * Declarative room entry inside a zone (R82): a named interior space the
 * zone contains, documented from the source the scenario was authored from
 * (a campus guide, a building directory). Purely descriptive world metadata
 * — the runtime does not interpret it (same posture as `consentClass`).
 * It exists so interior detail can be authored WITHOUT an architectural
 * floorplan (floorplan-vision stays the geometry-grade source).
 */
export interface ScenarioRoom {
  /** Room code as printed on the door (e.g. 'A-3027'); unique within the zone. */
  code?: string;
  /** Display name (e.g. '食堂 Life & Hope'). */
  name: string;
  /** Function tag (e.g. 'canteen', 'stationery', 'service-point'). */
  type?: string;
  /** Opening hours as human-readable text (e.g. 'Mon-Fri 9:00-17:00'). */
  hours?: string;
  /**
   * R82: room position within the floor's footprint, normalized [u, v] in
   * [0,1] — u along the footprint bbox width (lng axis), v along its depth
   * (lat axis, 0 = max-lat/north edge). Read off a floor plan; consumers
   * render a floor mini-map, the runtime never interprets it.
   */
  pos?: [number, number];
}

/** A physical zone (room, area) in the environment. */
export interface ScenarioZone {
  id: string;
  name?: string;
  /** Zone type classification (e.g. 'living-room', 'office'). */
  type?: string;
  /**
   * Building tier (B-A): owning building id. Absent = single-building
   * scenario; purely classificatory in v1 (physics keys off `floor`).
   */
  buildingId?: string;
  /**
   * Building tier (B-A): storey number (0 = ground floor). Absent = 0.
   * Zones on the same floor diffuse by 2D center distance as before;
   * cross-floor exchange happens only between zones whose adjacency lists
   * explicitly interconnect (stairwell/shaft zones), attenuated by the
   * slab factor.
   */
  floor?: number;
  bounds?: ZoneBounds;
  /**
   * T-058a (design-consent-semantics.md §3.1, server-side governance): the
   * zone's consent class — 'standard' (default) | 'supervised' (third-party
   * proposals touching the zone require the environment owner's explicit
   * consent; AI review is advisory) | 'restricted' (reserved). Declarative
   * world metadata: the runtime does not interpret it; the server's proposal
   * pipeline does (validated at load time, survives env import/export).
   */
  consentClass?: 'standard' | 'supervised' | 'restricted';
  /**
   * Building tier (B-B): current headcount. Drives per-zone occupancy
   * effect sources (sensible heat + CO2) injected at the zone center;
   * changeable at runtime via occupancy events / `setZoneOccupancy`.
   * Absent = 0.
   */
  occupancy?: number;
  /**
   * Fix-52a: schedule-driven occupancy. When declared, the runtime
   * automatically calls `setZoneOccupancy` at the schedule boundaries —
   * the zone goes from 0 to `count` people at `startSimTimeSec`, and back
   * to 0 at `endSimTimeSec`. This drives CO2 + sensible heat + motion
   * without manual event injection. Overridden by explicit occupancy
   * events (last write wins).
   */
  occupantSchedule?: {
    /** Headcount during the active window. */
    count: number;
    /** Sim-time second when occupancy begins (e.g. 28800 = 08:00). */
    startSimTimeSec: number;
    /** Sim-time second when occupancy ends (e.g. 64800 = 18:00). */
    endSimTimeSec: number;
    /** Repeat daily (default true). Set false for one-shot. */
    repeatDaily?: boolean;
  };
  /**
   * FEAT-07 phase-2 (calendar overlay): a TEMPORARY timetable that replaces
   * the base occupantSchedule inside the absolute sim-time window
   * `[startsAtSimSec, endsAtSimSec)` (e.g. exam-week extended library
   * hours); at the window end the base timetable governs again. The window
   * boundaries are occupancy due moments with the same catch-up discipline
   * as the runtime PATCH (in-window arrive corrects the headcount, a past
   * depart never zeroes — last write wins). Writable at runtime via the
   * env-level occupant-schedule PATCH (`overlay` field).
   */
  occupantScheduleOverlay?: {
    schedule: {
      count: number;
      startSimTimeSec: number;
      endSimTimeSec: number;
      repeatDaily?: boolean;
    };
    /** Absolute sim-second the overlay starts governing (inclusive). */
    startsAtSimSec: number;
    /** Absolute sim-second the overlay stops governing (exclusive; must exceed startsAtSimSec). */
    endsAtSimSec: number;
  };
  /**
   * Building tier (B-B): per-zone envelope flux multiplier (U-value
   * semantics) for exchanges with an adjacent `type: 'outdoor'` zone.
   * Wins over `meta.envelopeU`; defaults to 0.1 in the physics layer.
   */
  envelopeU?: number;
  /**
   * T-105 (F-PH05): the zone's solar aperture in m² (a glass atrium's
   * skylights, a roof-garden's glazing). Drives a per-tick solar-gain heat
   * source: W = solar_radiation × glassAreaM2 × g-value (0.45). Absent/0 =
   * no solar gain.
   */
  glassAreaM2?: number;
  /**
   * T-105 (F-PH05): interior ambient coupling buffer, 0..1 (default 1).
   * The zone relaxes toward its ambient attractor at this fraction of the
   * generic rate — a buffered interior zone tracks the building mix slowly
   * instead of being a bitwise slave of the global ambient. Does not apply
   * to volume-registered zones' physical thermal-envelope rate, nor to
   * outdoor boundaries (always direct).
   */
  ambientBuffer?: number;
  /**
   * Zones sharing a boundary; used for effect-propagation reasoning.
   * The loader auto-symmetrizes the lists (a declared A→B implies B→A),
   * so the loaded definition is always bidirectional.
   */
  adjacentZoneIds: string[];
  /**
   * Optional baseline physical conditions for this zone (e.g.
   * `{ temperature: 31.5, humidity: 68 }`), seeded into the physical
   * environment when the runtime is built — BEFORE the tick loop starts and
   * WITHOUT delivering events to agents (so baselines never trigger AC
   * decisions, unlike `atSimTimeSec: 0` events).
   *
   * Zones with `bounds`: the baseline is seeded as per-zone spatial state
   * (localized write at the zone center + relaxation attractor), so zones
   * may legitimately differ. Zones without `bounds`: the value models are
   * global per parameter, so when several zones declare a baseline for the
   * same parameter the value from the LAST zone in the array wins for every
   * zone — keep per-parameter values consistent across unbounded zones.
   */
  baseline?: Record<string, number | boolean>;
  /**
   * R82: declarative interior rooms inside this zone (see ScenarioRoom) —
   * survives env import/export and the web zone detail; the physics and
   * decision layers never read it.
   */
  rooms?: ScenarioRoom[];
}

/** Sensor/actuator classification of a device. */
export type DeviceRole = 'sensor' | 'actuator' | 'hybrid';

/** A device deployed in a zone. */
export interface ScenarioDevice {
  id: string;
  /** Human-readable name. Defaults to the device id. */
  name: string;
  /** Semantic device type (e.g. 'temperature-sensor', 'hvac', 'smart-light'). */
  type: string;
  /**
   * Sensor/actuator classification. Explicit in the file or inferred from
   * capabilities by the loader (read-only capabilities → sensor;
   * read + write/execute → hybrid; write/execute only → actuator).
   */
  role: DeviceRole;
  /** Capability names (e.g. 'temperature-reading', 'temperature-control'). */
  capabilities: string[];
  /** Zone the device is located in. */
  zoneId: string;
  /**
   * Owning stakeholder agent id (Wave 2 B5). Today the loader infers
   * ownership from `agents[].boundDeviceIds`; this field lets authors
   * make ownership explicit on the device side for governance/UI use.
   * When set, it must match exactly one agent's `boundDeviceIds` entry
   * or the loader emits a warning.
   */
  ownerId?: string;
  /**
   * Backend binding URI. `sim://` (the default) builds a SimulatedDevice;
   * `hass://<entity-id>` binds the device to a Home Assistant entity and is
   * honored when the runtime is given a `deviceFactory` (the server registry
   * provides one when HASS_URL/HASS_TOKEN are configured). Without a factory
   * every device — whatever its binding — builds as simulated.
   */
  binding: string;
  /** Extra initial device state (merged over `{ zoneId, status: 'active' }`). */
  initialState?: Record<string, unknown>;
}

/** LLM provisioning hint for an agent (metadata only in v1). */
export interface ScenarioAgentLLM {
  provider: string;
  model: string;
  params?: Record<string, unknown>;
  /**
   * Per-agent AC-assessor system prompt (Wave-3b agent A/B): wins over the
   * runtime-wide `assessorSystemPrompt` option for THIS agent. Unlike
   * provider/model (provisioning metadata), this one changes behavior.
   */
  systemPrompt?: string;
}

/**
 * Per-agent autonomous-decision policy (T-050 core-side, R11 corrective).
 * Both fields are optional and absent = the runtime-wide default (current
 * behavior). A sim-level EngineRuntimeOptions override WINS over this
 * per-agent policy — the operator running the evaluation decides; the
 * scenario author sets the world's defaults.
 */
export interface ScenarioAgentDecisionPolicy {
  /**
   * R45-P1 (F4): the agent's organizational role for the decision path.
   * `role: 'coordinator'` marks dispatchers (municipal centers, regional
   * coordinators) whose bound devices are REPRESENTATIVE reach, not an
   * execution mandate — precheck then never short-circuits them into
   * 'handle_independently' on Type-A (direct coverage × no gap); the LLM
   * lane decides, so cross-zone dispatch ("市级点将") stays possible.
   * Absent = executor (default, unchanged behavior).
   */
  role?: 'coordinator';
  /**
   * Actuate the agent's OWN bound devices on 'handle_independently'
   * decisions (default true). Set false for agents that should only
   * decide/record (advisory dashboards, decision-only evaluation arms).
   * Enforced in DualTriggerACManager (own devices only, never cross-agent).
   */
  autoActuateIndependent?: boolean;
  /**
   * Execute AC initiation (send proposals) when Layer 2 decides
   * initiate_ac (default true). Set false to record AC decisions without
   * the collaboration machinery (decision-only runs).
   */
  autoInitiateAC?: boolean;
  /**
   * R43-B/lever-b (training loop v5 §9.5): precheck Type-A pass-through —
   * let Type-A events (direct actuator coverage × no capability gap, ground
   * truth handle_independently) reach the LLM decision lane instead of the
   * deterministic short-circuit, producing REAL GT-A×LLM handle samples
   * (v5.2's templated corpus closes the format gap but not the
   * real-prompt distribution gap — real handle prompts were 0/17).
   * - 'off' (default / absent): current behavior, zero LLM cost.
   * - 'sample': pass through with probability precheckPassThroughRate.
   * - 'all': pass every Type-A event through.
   * Cost guard: this converts the cheapest decision path (no LLM call)
   * into an LLM call — data-production flag, keep OFF for live scenarios.
   * Ground truth is unchanged (handle_independently), so wrong LLM answers
   * are discarded by the label-consistency gate on export.
   */
  precheckPassThrough?: 'off' | 'sample' | 'all';
  /**
   * 'sample' mode pass probability p in [0,1]; default 0.3.
   * Only meaningful together with precheckPassThrough='sample'.
   */
  precheckPassThroughRate?: number;
}

/** An autonomous agent participating in the scenario. */
export interface ScenarioAgent {
  id: string;
  name: string;
  /** Capabilities this agent offers to peers. */
  capabilities: string[];
  /** Zones this agent is responsible for (event routing + device assignment). */
  managesZoneIds: string[];
  /** Devices explicitly assigned to this agent. */
  boundDeviceIds: string[];
  /**
   * Capability classes this agent is NOT permitted to deliver, even if its
   * `capabilities` array lists them. Used for scope-of-practice filtering
   * (e.g., a retail pharmacy `pharmacy-agent` may have
   * `controlled-substance-dispense` in its capabilities for OTC adjacent
   * flows but must NOT be selected for `tpa-dispense`). The negotiator
   * drops any candidate whose `cannotDeliverClasses` intersects the
   * event's `requiredCapabilities`.
   */
  cannotDeliverClasses?: string[];
  /**
   * Short 2-4 char label for map hexagen display (Wave 2 B4). Falls back
   * to the first 2 chars of `name` when unset.
   */
  shortLabel?: string;
  /**
   * Per-agent rate limit (events per minute this agent may initiate).
   * Documentation-only today; engine enforcement in a later wave.
   */
  rateLimitPerMinute?: number;
  /**
   * Master enable switch (default true). A disabled agent does NOT receive
   * injected events and is NOT eligible for partner selection; collaborations
   * already in progress run to completion naturally. Toggleable at runtime
   * via EngineRuntime.setAgentEnabled.
   */
  enabled?: boolean;
  /**
   * Owning tenant (user id) of this agent instance (T-201). Emitted by the
   * server's environment bridge from `agent_instances.owner_id`; file-based
   * scenarios leave it undefined. Flow assignment uses it to scope flow
   * nodes to the flow author's OWN agents/devices — undefined means "no
   * tenant attribution" (legacy/file worlds) and stays eligible for
   * everyone, preserving core-only consumers.
   */
  ownerUserId?: string;
  /**
   * T-601 (R26): `llm: null` is an EXPLICIT opt-out — this agent runs
   * rule-only by construction even when the runtime carries a shared LLM
   * client (mixed worlds). Absent (undefined) keeps the legacy fall-through
   * to the shared client; an llm block opts in per agent.
   */
  llm?: ScenarioAgentLLM | null;
  /**
   * Per-agent autonomous-decision policy (T-050). Optional — absent keeps
   * the runtime-wide defaults. The loader whitelists it additively.
   */
  decisionPolicy?: ScenarioAgentDecisionPolicy;
  /**
   * P3: author-declared semantic services this agent exposes — the
   * scenario author's direct service channel, bypassing rule derivation
   * (the offer exists because the author SAYS so, like a published
   * world-layer offer; backing is not policed). Same shape as a
   * SemanticOfferRule; `requires`/`actuates` document the capability
   * contract and ground the callable interface. Imported into the world
   * layer as origin='published' service rows.
   */
  services?: SemanticOfferRule[];
}

/** A scenario event, injectable manually or on a simulation-time schedule. */
export interface ScenarioEvent {
  id: string;
  /** Event type (e.g. 'temperature-spike', 'motion-detected'). */
  type: string;
  /** Zone the event originates in. */
  zoneId: string;
  /** Physical parameter to set (defaults derived from `type` when omitted). */
  parameter?: string;
  /** Value to set (defaults derived from `type` when omitted). */
  value?: number | boolean | string;
  /** Sim-time (seconds since runtime start) at which to auto-inject. */
  atSimTimeSec?: number;
  /**
   * T-103 (F-PH21): duration of a zone-scoped physical effect in SIM
   * seconds — consumed by `power-outage`-family events (devices in the zone
   * lose power for the duration, then restore gradually). Default 300.
   */
  durationSec?: number;
  /**
   * Severity for prioritization and anomaly classification (default
   * 'medium'). Delivered to agents in the event payload: 'high'/'critical'
   * mark the event as an anomaly with an increasing trend in the AC
   * necessity assessor, mirroring real threshold breaches.
   */
  severity?: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Optional capability requirements carried by the event payload (task
   * metadata). The AC necessity assessor prefers these over capability
   * inference, and partner selection uses them to find capable agents —
   * e.g. `['air-purification', 'ventilation']` for a smoke event.
   */
  requiredCapabilities?: string[];
  /**
   * Opaque metadata carried through validation untouched (e.g. replay-baked
   * provenance: decision reasoning, zone-sample readings). The engine never
   * interprets it — injection only reads the physical fields above.
   */
  details?: Record<string, unknown>;
  /**
   * Sensor confidence in [0, 1] for the source reading that produced this
   * event (default 1.0). Models mmWave fall detectors' ~3-5 false-positive
   * rate per week, ambiguous ECG patches, fog-occluded cameras, etc. Today
   * the engine treats every event as ground truth; this field exists so
   * downstream engine layers (Layer 1 clustering, AC necessity) can start
   * consulting it without a schema migration. Authoring-side: set
   * `confidence < 1` for any event sourced from a sensor with known
   * false-positive potential.
   */
  confidence?: number;
  /**
   * Cinematography hints for the Web UI (Wave 2 B3). The UI watches the
   * event log; when an event with `cinematography.cameraFocusKind` fires,
   * the map auto-focuses its zone and shows the `narrationCue` overlay.
   * Manual focus controls still override.
   */
  cinematography?: {
    /** Short human-readable cue shown as a transient overlay when the event fires. */
    narrationCue?: string;
    /** Per-event playback-rate hint (overrides meta.recommendedPlaybackRate). */
    playbackRateOverride?: number;
    /** Agent IDs to spotlight in the UI when this event fires. */
    highlightAgentIds?: string[];
    /** Camera framing strategy. */
    cameraFocusKind?: 'zone' | 'agent-pair' | 'event-source';
  };
  /**
   * PIPL Article 23 consent requirements (Wave 2 B6 / Workstream G).
   * Documents what personal data the event will cause to flow between
   * which recipients. The engine does not yet enforce this at runtime;
   * authors mark events so downstream compliance tooling can audit.
   */
  consentRequirements?: {
    /** Personal data fields the event will expose (e.g. 'ecg', 'location', 'diagnosis'). */
    dataFields: string[];
    /** Agent IDs that will receive the data. */
    recipients: string[];
    /** PIPL consent class. 'emergency' bypasses pre-consent (PIPL Art 25). */
    consentClass: 'routine' | 'sensitive' | 'emergency';
  };
  /**
   * Liability class (Wave 2 B7 / Workstream G). Tags events where partners
   * cannot legally decline (e.g., 120 ambulance dispatch for a code stroke).
   * Today this is documentation-only; future runtime may enforce.
   */
  liabilityClass?: 'must-respond' | 'best-effort' | 'advisory';
  /**
   * Author-facing rationale for why AC is necessary (or honestly, why it
   * isn't). Documents the 3-condition diagnostic: partnerSetUnpredictable,
   * noCentralAuthority, combinatorialStateSpace. Required for flagship
   * scenarios; `eaf scenario validate` warns when missing.
   */
  acRationale?: {
    partnerSetUnpredictable: boolean;
    noCentralAuthority: boolean;
    combinatorialStateSpace: boolean;
    score: string;
    verdict: 'AC-necessary' | 'AC-valuable' | 'AC-overkill';
    reasoning: string;
  };
  /**
   * Zone to focus the UI camera on when this event fires (cinematography
   * helper). Falls back to `zoneId` when unset.
   */
  focusZoneId?: string;
  /**
   * One-sentence human-stakes narrative for UI display (e.g. "张大爷 71
   * 岁，独居，10 分钟未动。门锁还锁着。"). Optional but recommended for
   * any event in a flagship scenario. Accepts a plain string (legacy,
   * treated as zh-only) or a `{zh, en}` object for bilingual scenarios.
   */
  humanNarrative?: LocalizedText | string;
  /**
   * Replay/observation hygiene (T-019): this event RECORDS observed world
   * state — a baked zone-sample, device-state snapshot, or a past agent
   * decision from a replay export — it is not a stimulus. The runtime
   * NEVER injects observation-only events: no physics write, no agent
   * fan-out, no decision evaluation. Without the flag, replaying a
   * recorded timeline re-triggers one agent decision per baked sample
   * (R10: 2326 spurious decisions in one 3-min window). Replay generation
   * marks its baked timeline events with this flag; hand-authored
   * scenarios rarely need it.
   */
  observationOnly?: boolean;
}

/**
 * Full scenario definition consumed by EngineRuntime. Produced by
 * `loadScenarioFile()` / `loadScenarioFromFile()` — not hand-written.
 */
export interface ScenarioDefinition {
  version: ScenarioVersion;
  meta: ScenarioMeta;
  zones: ScenarioZone[];
  devices: ScenarioDevice[];
  agents: ScenarioAgent[];
  events: ScenarioEvent[];
  /**
   * User-orchestrated business flows (optional). Validated by
   * `validateFlow()` (flows module); executed by the runtime's FlowEngine
   * when no explicit `flowsProvider` option overrides them.
   */
  flows?: FlowDefinition[];
  /**
   * P3: scenario-authored semantic offer rules — merged OVER the built-in
   * rule table (`mergeOfferRules`: dedupe by semanticType, custom wins)
   * everywhere offers are derived (world-layer aggregate sync, runtime
   * aggregate registration). Absent = built-in rules only.
   */
  semanticOfferRules?: SemanticOfferRule[];
  /**
   * P3: scenario-authored capability-equivalence groups — registered into
   * the process-level synonym registry at load time
   * (`extendCapabilitySynonyms`), so scenario-specific vocabulary
   * participates in capability matching. Absent = built-in table only.
   */
  capabilitySynonyms?: string[][];
}
