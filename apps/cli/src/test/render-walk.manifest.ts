/**
 * T79 (R8, PM 战略立项) — the RENDER WALK manifest: R102 ("human ≥ json 的
 * 解释性字段") made machine-checkable over real command FACES, not just pure
 * functions. R6→R7→R8 proved the failure mode lives OUTSIDE the pure
 * renderer: the functions were right, but the bytes rode stderr (T72), the
 * fixture world didn't match reality (T69), or the face was a raw JSON dump
 * (T76). This manifest therefore walks (command, seed, anchors) triples and
 * the walker executes them against a REAL server through run(), capturing
 * stdout and stderr separately.
 *
 * The three layers (design: triage-r8.md §T79):
 * 1. 完备性 — COMMAND_SURFACE enumerates every (group, sub[, sub-sub]) face
 *    from cli.ts's COMMANDS table + each group's switch. Every command MUST
 *    be walked here or registered in EXEMPT_COMMANDS with a written reason:
 *    a new command that registers neither cannot go green.
 * 2. 断言 — per face: run `--json`, walk the payload tree; every key hit by
 *    the interpretive-field vocabulary (isInterpretiveKey) must have declared
 *    anchors or a face exemption, and every anchor must appear on the
 *    human-mode STDOUT capture (stream discipline — T72's lesson encoded).
 * 3. 卫生 — every human stdout is swept for bare UUIDs, >2-decimal floats,
 *    scientific notation, and template residue, unless the face declares an
 *    allowlist (some faces legitimately print ids — `service get`'s first
 *    line IS the id).
 *
 * Adding a face: register it in WALK_FACES with argv + anchors for every
 * interpretive key its payload carries + the seed state that makes those
 * keys non-trivial (branch seeds 只增不减 — removing a seed removes the
 * branch coverage and must review its exemptions too).
 */

// ---------------------------------------------------------------------------
// 1. The interpretive-field vocabulary (allowlist, versioned)
// ---------------------------------------------------------------------------

/**
 * R8 vocabulary v1 (triage-r8.md §T79): a json key matches when its NAME
 * (last path segment) is in EXACT_KEYS or matches the suffix rules. New
 * non-interpretive fields do NOT trip the walk (allowlist, not denylist);
 * new interpretive fields MUST either get anchors or a written exemption.
 * Renames of the vocabulary itself bump VOCAB_VERSION and get reviewed.
 */
export const VOCAB_VERSION = 'r8-v1';

const EXACT_KEYS = new Set([
  'reason',
  'warnings',
  'warning',
  'units',
  'signability',
  'declaredByProvider',
  'emptyEventWindow',
  'validationWarnings',
  'failureReason',
  'statusReason',
  'effectiveModel',
  'trackRecordNote',
  'methodologyNote',
  'defaultSimNote',
  'defaultSimulationId',
  'replyHint',
  'consumableNote',
  'deliveryNote',
  'llmWarning',
  'capabilityDrift',
  'declarationDrift',
  'autoDecision',
  'holdExpiresAt',
]);

export function isInterpretiveKey(key: string): boolean {
  if (EXACT_KEYS.has(key)) return true;
  if (/Reason$/.test(key)) return true; // *Reason (e.g. blockedReason)
  if (/Warnings$/.test(key)) return true; // *Warnings (e.g. driftWarnings)
  if (/Note$/.test(key)) return true; // *Note (e.g. remedyNote)
  return false;
}

// ---------------------------------------------------------------------------
// 2. The seed: ONE world that makes the branch states reachable
// ---------------------------------------------------------------------------

/**
 * The `r8-walk-lab` seed (seed 只增不减): provider + consumer, two HVAC
 * units bound to one agent (signability AMBIGUITY on published turn-on),
 * a published offer of a never-covered type (UNBACKED), a capability-minted
 * derived row that the provider then stops declaring (DECLARATION DRIFT),
 * and a data service whose zone-query counts a fall sensor that never fires
 * (EMPTY EVENT WINDOW on read). All seeded through the real API/CLI — the
 * T68 lesson: a hand-written payload tests a world that does not exist.
 */
export const WALK_WORLD_YAML = `version: "1.0"
environment:
  name: r8-walk-lab
  visibility: public
  map:
    type: grid
    zones:
      - id: lobby-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
      - id: office-b
        bounds: {minX: 6, maxX: 10, minY: 0, maxY: 5}
devices:
  - name: HVAC A
    zone: lobby-a
    spec:
      type: hvac
      capabilities: [turn-on, turn-off, temperature-control, hvac-control, temperature-monitoring]
  - name: HVAC B
    zone: office-b
    spec:
      type: hvac
      capabilities: [turn-on, turn-off, temperature-control, hvac-control, temperature-monitoring]
  - name: Fall Sensor B
    zone: office-b
    spec:
      type: sensor
      capabilities: [fall-detection, fall-monitoring]
    initialState: {active: false}
  # T84 (R10, u1-F3): a sensor whose only "data" is a numeric initialState
  # key — a placeholder this world never writes (nothing commands a sensor
  # and no physics effect targets it) → the auto-minted read lane is the
  # signable-but-unreadable shape the signability read-source face warns on.
  - name: Temp Sensor A
    zone: lobby-a
    spec:
      type: temperature-sensor
      capabilities: [temperature-sensing]
    initialState: {temperature: 24.5}
  # T119: a UNIQUE-capability actuator so the invoke/lifecycle family has a
  # signable offer whose backing resolves to exactly ONE device with an
  # executable command ('activate' — SimpleActionCommandHandler). turn-on/
  # turn-off stay two-device (the ambiguous face needs the 2-candidate
  # ambiguity), so the walk lab needed a capability no other device declares.
  - name: Info Board
    zone: lobby-a
    spec:
      type: light
      capabilities: [activate, deactivate]
agents:
  - name: Campus Steward
    capabilities: [hvac-control, fall-monitoring, temperature-monitoring, temperature-sensing, activate, deactivate]
    bind: [HVAC A, HVAC B, Fall Sensor B, Temp Sensor A, Info Board]
    zones: [lobby-a, office-b]
events:
  - id: evt-fall
    type: fall-detected
    zoneId: office-b
`;

/** The data-service computation spec (event-counting → empty-window face). */
export const WALK_READ_SPEC = {
  kind: 'zone-query',
  refreshSec: 60,
  inputs: {
    zones: ['office-b'],
    metrics: [
      { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
      // An EVENT-source metric is what makes the read face an EVENT-window
      // read (read-delivery: emptyEventWindow = specHasEventMetrics && 0
      // events matched). No fall-detected event is ever injected on this
      // seed → the window is deterministically empty.
      { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 600, as: 'activeFallAlerts' },
    ],
  },
};
export const WALK_READ_IFACE = {
  dataSchema: {
    fields: [
      { name: 'avgTemperature', type: 'number', unit: '°C' },
      { name: 'activeFallAlerts', type: 'integer' },
    ],
  },
};

/**
 * T81 (R9, u2-F2): a spec whose event metric names a type the walk world
 * NEVER declares ('meteor-strike' — the world declares only 'fall-detected').
 * The registration 201 carries the ghost warning; the register face's human
 * render must show it (R102: human ≥ json), and `service computation get`
 * replays it. Field names match WALK_READ_SPEC so the interface block still
 * matches on the atomic swap (DATA_SCHEMA_MISMATCH would 400).
 */
export const WALK_GHOST_SPEC = {
  kind: 'zone-query',
  refreshSec: 60,
  inputs: {
    zones: ['office-b'],
    metrics: [
      { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
      { source: 'event', eventType: 'meteor-strike', fn: 'countSince', windowSec: 600, as: 'activeFallAlerts' },
    ],
  },
};

/**
 * T85 (R10, u4-F1): a MIXED ghost+declared event spec — 'fall-detected' is
 * declared in the walk world (evt-fall), 'meteor-strike' never. Two
 * agreements read the two fields separately so both classification branches
 * of the empty-window warning walk against one real service.
 */
export const WALK_MIXED_SPEC = {
  kind: 'zone-query',
  refreshSec: 60,
  inputs: {
    zones: ['office-b'],
    metrics: [
      // kind discipline: zone-query carries >=1 zone metric.
      { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
      { source: 'event', eventType: 'meteor-strike', fn: 'countSince', windowSec: 600, as: 'ghostAlerts' },
      { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 600, as: 'fallAlerts' },
    ],
  },
};
export const WALK_MIXED_IFACE = {
  dataSchema: {
    fields: [
      { name: 'avgTemperature', type: 'number', unit: '°C' },
      { name: 'ghostAlerts', type: 'integer' },
      { name: 'fallAlerts', type: 'integer' },
    ],
  },
};

// ---------------------------------------------------------------------------
// 2b. Flow seeds (T119): three flows, 只增不减 — the ghost trigger carries the
// T78 warning the flow faces walk; the run flow is CLEAN (declared capability
// `activate` on the unique Info Board) so sim run-flow / flow runs walk the
// success branch; the scratch flow is the lifecycle chain's expendable target
// (update/disable/enable/rm never touch the read faces' flows).
// ---------------------------------------------------------------------------

/** T78 ghost-trigger flow: the trigger names a type the world never declares. */
export const WALK_GHOST_FLOW_YAML = `name: Walk Ghost Watch
description: watch for an event this world never declares (T78 warning face)
trigger:
  kind: event
  eventType: alien-invasion
plan:
  goal: log the invasion
  nodes:
    - id: n1
      capability: fall-monitoring
`;

/** Clean flow: declared trigger type + declared executable capability. */
export const WALK_RUN_FLOW_YAML = `name: Walk Lab Flow
description: activate the info board (clean — no warnings, no drift)
trigger:
  kind: event
  eventType: fall-detected
plan:
  goal: activate the info board
  nodes:
    - id: n1
      capability: activate
`;

/** Expendable scratch flow for the update/disable/enable/rm lifecycle faces. */
export const WALK_SCRATCH_FLOW_YAML = `name: Walk Scratch Flow
description: expendable — the lifecycle write faces chew on this one
enabled: false
trigger:
  kind: event
  eventType: fall-detected
plan:
  goal: nothing important
  nodes:
    - id: n1
      capability: fall-monitoring
`;

// ---------------------------------------------------------------------------
// 3. Faces
// ---------------------------------------------------------------------------

export interface WalkFace {
  /** 对账 key — the human name of the face. */
  face: string;
  /** argv passed to run() (the walker appends nothing; use --json itself as a second run). */
  argv: string[];
  /**
   * Who runs the face (default 'consumer'). Provider-owned write faces
   * (e.g. `service computation register`, T81) need the provider session.
   */
  actor?: 'provider' | 'consumer';
  /**
   * json field dot-path (or bare key name) → anchor substrings that MUST
   * appear on the human-mode STDOUT capture. Declared per field so a new
   * interpretive json key without a human counterpart turns red HERE, not
   * in a user round.
   */
  anchors: Record<string, string[]>;
  /**
   * Field-level exemptions, each with a WRITTEN reason + source. A key here
   * is skipped by the vocabulary walk (it is declared technical debt, the
   * known-unhandled precedent — not a back door).
   */
  exempt?: Array<{ key: string; reason: string; source: string; date: string }>;
  /** Hygiene allowlist — declare WHY the face legitimately trips a rule. */
  hygiene?: {
    /** The face legitimately prints ids (e.g. `service get`'s first line). */
    bareIdOk?: boolean;
    /** The face legitimately prints raw numbers (e.g. table faces with ids/times). */
    bareFloatOk?: boolean;
    /**
     * T119: the face's PAYLOAD legitimately carries `${…}` slot syntax (the
     * builtin blueprints' install-time `zoneId` slot) — the paste-ready raw
     * JSON faces. The residue rule stays armed for every rendered sentence.
     */
    templateOk?: boolean;
  };
}

export const WALK_FACES: WalkFace[] = [
  // ----- service faces (T72's original crime scene) -----
  {
    face: 'service list',
    argv: ['service', 'list', '--env', 'r8-walk-lab'],
    anchors: {
      // Drifted rows carry declaredByProvider:false in the payload; the list
      // face marks them in the drift column (T49 shared ⚠ 口径).
      declaredByProvider: ['⚠'],
    },
    exempt: [
      {
        key: 'signability.reason',
        reason:
          'the roster marks drift (⚠ column) but not the full signing verdict — the verdict + reason + candidate devices render on the detail face (service get), which the walker covers per verdict',
        source: 'T49/T62/T68a face split (list scans, get decides); walker v1',
        date: '2026-09-17',
      },
      {
        key: 'signability',
        reason:
          'see signability.reason — the roster face carries the drift marker only; verdicts live on the detail face',
        source: 'T49/T62/T68a face split; walker v1',
        date: '2026-09-17',
      },
      {
        key: 'consumableNote',
        reason:
          'the roster marks unbacked rows (unbacked column / drift ⚠); the remedy note renders on the detail face (service get ⚠ line) which the walker covers',
        source: 'walker v1 face-split ruling (roster scans, detail decides)',
        date: '2026-09-17',
      },
      {
        key: 'trackRecordNote',
        reason:
          'the roster carries the track-record value column; the INVOKE-only 口径 note renders on the detail face (service get ⚠ line, walker-covered)',
        source: 'walker v1 face-split ruling (roster scans, detail decides)',
        date: '2026-09-17',
      },
      {
        key: 'methodologyNote',
        reason:
          'face-split, same ruling as trackRecordNote: the roster scans (track-record value column); the T121 reputation-vs-usage methodology line ("口径: reputation=全历史 …") renders on the service detail face, walker-covered with the methodologyNote anchors on every service-get face',
        source: 'T131 walker alignment — T121 payload field; roster-scans/detail-decides precedent',
        date: '2026-09-20',
      },
    ],
    hygiene: { bareIdOk: true },
  },
  {
    face: 'service get (ambiguous)',
    argv: ['service', 'get', '{svcAmbiguous}'],
    anchors: {
      signability: ['signability: ambiguous', 'SERVICE_BACKING_AMBIGUOUS', 'HVAC A', 'HVAC B'],
      'signability.reason': ['resolves to 2 backing devices'],
      declaredByProvider: ['⚠ provider 未声明'],
      methodologyNote: ['口径:'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'service get (unbacked)',
    argv: ['service', 'get', '{svcUnbacked}'],
    anchors: {
      signability: ['signability: unbacked', 'SERVICE_NOT_BACKED'],
      'signability.reason': ['no bound device'],
      consumableNote: ['no backing device'],
      declaredByProvider: ['⚠ provider 未声明'],
      methodologyNote: ['口径:'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'service get (declaration drift)',
    argv: ['service', 'get', '{svcDrift}'],
    anchors: {
      declaredByProvider: ['⚠ provider 未声明', 'declaredByProvider:false'],
      signability: ['signability: backed'],
      methodologyNote: ['口径:'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'service get (data service with computation)',
    argv: ['service', 'get', '{svcData}'],
    anchors: {
      consumableNote: [], // present only pre-registration; post-registration the face is the computation lines
      declaredByProvider: ['⚠ provider 未声明'],
      signability: ['signability:'],
      'signability.reason': ['no bound device'],
      trackRecordNote: ['track record meters'],
      methodologyNote: ['口径:'],
    },
    hygiene: { bareIdOk: true },
  },
  // ----- agreement faces (T77's empty window rides here) -----
  {
    face: 'agreement list',
    argv: ['agreement', 'list', '--env', 'r8-walk-lab'],
    anchors: {
      // Drifted service cells carry the ⚠ marker (same 口径 as service list).
      declaredByProvider: ['⚠'],
      declarationDrift: ['⚠'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agreement get',
    argv: ['agreement', 'get', '{agreementId}'],
    anchors: {
      reason: ['reason: '],
      declaredByProvider: ['⚠ provider 未声明'],
      declarationDrift: ['（设备仍可执行）'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agreement read (empty event window — T72/T77 stream regression)',
    argv: ['agreement', 'read', '{agreementId}'],
    anchors: {
      emptyEventWindow: ['⚠ 事件窗为空', '不是真实读数'],
      // T51: the units ride the human data line (avgTemperature=… °C).
      units: ['°C'],
    },
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'agreement usage',
    argv: ['agreement', 'usage', '{agreementId}'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agreement receipts',
    argv: ['agreement', 'receipts', '{agreementId}'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  // ----- env / device / agent read faces -----
  {
    face: 'env list',
    argv: ['env', 'list'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'env get',
    argv: ['env', 'get', 'r8-walk-lab'],
    anchors: {},
    exempt: [
      {
        key: 'governance.supervisedZoneNote',
        reason:
          'the note is vacuous while supervisedZones is empty; when zones ARE supervised the human face renders the full escalation sentence (env get, "supervised zones: … require the owner\'s explicit consent")',
        source: 'T-058a rendering contract (env.ts supervised-zones branch); walker v1 seed has no supervised zones',
        date: '2026-09-17',
      },
      {
        key: 'governance.humanReviewNote',
        reason:
          'the breadth-threshold note is configuration introspection ("0 = disarmed" on this seed); the gated-review MECHANISM renders on the human face via the supervised-zones sentence when active',
        source: 'T-058a; walker v1 seed runs default (disarmed) thresholds',
        date: '2026-09-17',
      },
      {
        key: 'governance.decisionDelegationNote',
        reason:
          'the note is vacuous while decisionDelegations is empty; when delegations EXIST the human face renders one sentence per delegation (env get, "zone-claim decisions delegated to: …")',
        source: 'T-072 rendering contract (env.ts delegations branch); walker v1 seed has no delegations',
        date: '2026-09-17',
      },
      {
        key: 'governance.ownershipPlanNote',
        reason:
          'the import/handover plan note is a workflow hint for importer worlds; this seed has no import flow and the human face renders no ownership plan section for plain worlds (vacuous-config exemption, same family as humanReviewNote)',
        source: 'walker v1 seed (plain grid world, no import handover)',
        date: '2026-09-17',
      },
      {
        key: 'services.declaredByProvider',
        reason:
          'the env overview face renders topology COUNTS by design (zones/devices/agents — "use --full to list them"); per-service drift renders on service list / service get / agent get, all walker-covered',
        source: 'walker v1 face-split ruling (overview counts, rosters mark)',
        date: '2026-09-17',
      },
      {
        key: 'services.consumableNote',
        reason: 'same face-split as services.declaredByProvider — the overview counts; remedy notes live on the detail face',
        source: 'walker v1 face-split ruling',
        date: '2026-09-17',
      },
      {
        key: 'defaultSimulationId',
        reason:
          'vacuous-config exemption (same family as humanReviewNote): the T122 default-sim binding is UNSET on this seed (null) and the human face renders its binding line only when set (env.defaultSim.face); the set/clear/stale states are owned by env-default-sim.vitest with their own anchors, and the stale/fallback note (defaultSimNote) renders only on drift',
        source: 'T131 walker alignment — T122 payload field; walker v1 vacuous-config precedent',
        date: '2026-09-20',
      },
    ],
    hygiene: { bareIdOk: true },
  },
  {
    face: 'env members',
    argv: ['env', 'members', 'r8-walk-lab'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'env activity',
    argv: ['env', 'activity', 'r8-walk-lab', '--limit', '10'],
    // T94 (R14, u4-P1): the face used to walk with EMPTY anchors — a
    // header-only human render (the u4 regression shape) could never go red.
    // The walker's exact top-10 window shifts with the seed's newest writes,
    // so the anchors pin the STRUCTURAL guarantees instead of one action
    // word: 'command' (feed rows render their kind column — data rows are
    // on stdout, not a bare header) and '--before' (the T94 count line,
    // rendered in every locale only after a non-empty table).
    anchors: { kind: ['command'], action: ['--before'] },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'device list',
    argv: ['device', 'list', '--env', 'r8-walk-lab'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'device get',
    argv: ['device', 'get', '{hvacA}'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agent list',
    argv: ['agent', 'list', '--env', 'r8-walk-lab'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agent get',
    argv: ['agent', 'get', '{steward}'],
    anchors: {
      // Drifted services in the provider's roster carry the ⚠ marker (same
      // 口径 as service list — the agent page is a governance surface too).
      declaredByProvider: ['⚠'],
    },
    exempt: [
      {
        key: 'services.signability.reason',
        reason:
          'the roster page marks drift (⚠) but not the per-service signing verdict — verdict/reason/candidates render on service get, which the walker covers per verdict',
        source: 'walker v1 face-split ruling (same as service list signability exemption)',
        date: '2026-09-17',
      },
      {
        key: 'services.signability',
        reason: 'see services.signability.reason — roster carries the drift marker only',
        source: 'walker v1 face-split ruling',
        date: '2026-09-17',
      },
      {
        key: 'services.consumableNote',
        reason: 'the provider roster marks drift (⚠); remedy notes live on the service detail face',
        source: 'walker v1 face-split ruling',
        date: '2026-09-17',
      },
      {
        key: 'services.trackRecordNote',
        reason:
          'the roster carries the track-record value ([有履约记录/暂无履约记录]); the INVOKE-only 口径 note renders on the service detail face (walker-covered)',
        source: 'walker v1 face-split ruling',
        date: '2026-09-17',
      },
      {
        key: 'services.methodologyNote',
        reason:
          'face-split, same ruling as services.trackRecordNote: the provider roster scans; the T121 reputation-vs-usage methodology line ("口径: …") renders on the service detail face, walker-covered with the methodologyNote anchors on every service-get face',
        source: 'T131 walker alignment — T121 payload field; roster-scans/detail-decides precedent',
        date: '2026-09-20',
      },
    ],
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  // ----- market / platform faces -----
  {
    face: 'auth whoami',
    argv: ['auth', 'whoami'],
    anchors: {},
    hygiene: { bareIdOk: true }, // the account id IS part of the answer line
  },
  {
    face: 'catalog list',
    argv: ['catalog', 'list'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'blueprint list',
    argv: ['blueprint', 'list'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'scenario-templates list',
    argv: ['scenario-templates', 'list'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'sandbox list',
    argv: ['sandbox', 'list', '--env', 'r8-walk-lab'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'notifications list',
    argv: ['notifications', 'list'],
    anchors: {},
    exempt: [
      {
        key: 'replyHint',
        reason:
          'the roster renders the hint\'s actionable half as the yourMove column ("← your move", T-059); a non-your-move hint carries no roster-visible semantics — the endpoint/allowedDecisions detail belongs to the face the notification points at',
        source: 'T119 vocabulary walk (payload grew proposal notifications); roster-scans/detail-decides precedent',
        date: '2026-09-19',
      },
      {
        key: 'reason',
        reason:
          'the roster renders kind/title/your-move (a scan face); a notification body.reason (e.g. a termination reason) renders on the DETAIL face of the thing the notification points at — agreement get\'s "reason:" line, walker-covered + named-block pinned',
        source: 'T119 vocabulary walk; face-split ruling (roster scans, detail decides)',
        date: '2026-09-19',
      },
    ],
    hygiene: { bareIdOk: true },
  },
  {
    face: 'me (workbench)',
    argv: ['me'],
    anchors: {},
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  // ----- sim faces (T76's snapshot dump was the second crime scene) -----
  {
    face: 'sim list',
    argv: ['sim', 'list', '--env', 'r8-walk-lab'],
    anchors: {},
    exempt: [
      {
        key: 'simulations.llmWarning',
        reason:
          'the llm MODE renders per row (llm=rule-only column value); the full warning sentence renders on the actionable faces — sim create / sim start (explain() → stdout) — and a per-row sentence would drown the roster',
        source: 'T52 roster design + T72 stream discipline; llmWarning is pre-R8 payload, not a new field',
        date: '2026-09-17',
      },
    ],
    hygiene: { bareIdOk: true },
  },
  {
    face: 'sim status (T83 caliber face)',
    argv: ['sim', 'status', '{simId}'],
    anchors: {},
    hygiene: { bareIdOk: true },
  },
  {
    face: 'sim snapshot (T76 — summary + unit zones table, never a bare dump)',
    argv: ['sim', 'snapshot', '{simId}'],
    anchors: {
      // T76: the human face renders the llm warning (this face was rebuilt
      // this round — R102 applies in full, no exemption).
      llmWarning: ['⚠ '],
    },
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'sim snapshot --zones',
    argv: ['sim', 'snapshot', '{simId}', '--zones'],
    anchors: {},
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'sim eval',
    argv: ['sim', 'eval', '{simId}'],
    anchors: {},
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  // ----- T80/T81 faces (R9 batch 9): write faces joining the walk -----
  {
    face: 'sim command (T80 — honest actuation echo on the executable face)',
    argv: ['sim', 'command', '{simId}', '--device', '{hvacA}', '--cmd', 'turn-on'],
    anchors: {},
    // The echo is the engine's device result verbatim (json-identical) and
    // the face names the device by its id argument — both allowed here.
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'service get (T84 + T86 — read-source never-written, layered by the probed read lane: the walker actor owns the running sim, so the own-sim verdict also names the sim-less world-session fallback)',
    argv: ['service', 'get', '{svcUnwritten}'],
    anchors: {
      signability: ['读源从未被写', 'COMPUTATION_DEVICE_STATE_UNWRITTEN', '你的自有 sim', 'world-session'],
      'signability.reason': ['read 源从未被写', 'Lane honesty'],
      methodologyNote: ['口径:'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'agreement read (T85+T133 — the GHOST field of a mixed spec renders the window-scoped copy, never a world-history claim)',
    argv: ['agreement', 'read', '{agreementGhostField}'],
    anchors: {
      emptyEventWindow: ['⚠ 事件窗为空', '本次窗口内未观测到', 'meteor-strike'],
      units: [], // count fields carry no declared unit (null) — the data line stays bare
    },
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'agreement read (T85 — the DECLARED field of a mixed spec keeps the T57a plain-window advice)',
    argv: ['agreement', 'read', '{agreementDeclaredField}'],
    anchors: {
      emptyEventWindow: ['⚠ 事件窗为空', '不是真实读数', '加宽 windowSec'],
      units: [], // count fields carry no declared unit (null) — the data line stays bare
    },
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'service computation register (T81 — the ghost event warning rides the human face)',
    actor: 'provider',
    argv: ['service', 'computation', 'register', '{svcData}', '--spec', JSON.stringify(WALK_GHOST_SPEC)],
    anchors: {
      warnings: ['unrecognized event type', 'meteor-strike', 'this world declares'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'service computation get (T81 — the ghost warning replays on the get face)',
    argv: ['service', 'computation', 'get', '{svcData}'],
    anchors: {
      warnings: ['unrecognized event type', 'meteor-strike'],
    },
    hygiene: { bareIdOk: true },
  },

  // ---------------------------------------------------------------------
  // T119 (C1, G5) batch A — env read-only family joins the walk. The seed
  // makes them non-trivial where cheap (one seeded ask); where the seed is
  // legitimately empty the anchors pin the HONEST EMPTY-STATE line (the T94
  // lesson: an empty face walked with no anchors can never go red).
  // ---------------------------------------------------------------------
  {
    face: 'env delegates (T119 — honest empty-state teaching line)',
    argv: ['env', 'delegates', 'r8-walk-lab'],
    anchors: {
      emptyState: ['no active decision delegations', 'eaf env delegates grant'],
    },
  },
  {
    face: 'env proposals (T119 — honest empty-state line on the governance board)',
    argv: ['env', 'proposals', 'r8-walk-lab'],
    anchors: {
      emptyState: ['no proposals'],
    },
  },
  {
    face: 'env session status (T119 — T82 status/state caliber line + T38.5 dual-clock note)',
    argv: ['env', 'session', 'status', 'r8-walk-lab'],
    anchors: {
      // The T82 two-words explanation renders whenever a live session exists
      // (the agreement-read faces earlier in this array materialize the
      // world session); the dual-clock note is unconditional at that point.
      state: ['是会话的关注生命周期'],
      dualClock: ['本会话是环境权威世界'],
    },
    hygiene: { bareIdOk: true }, // the session table prints simulationId
  },
  {
    face: 'env deployment (T119 — procurement manifest sections)',
    actor: 'provider',
    argv: ['env', 'deployment', 'r8-walk-lab'],
    anchors: {
      sections: ['agents to run (1)', 'devices to procure', 'services to offer'],
    },
    hygiene: { bareIdOk: true }, // the agent table prints ids (the deployable handle)
  },
  {
    face: 'env guide (T119 — honest unset line + the GENERATED service cheatsheet)',
    argv: ['env', 'guide', 'r8-walk-lab'],
    anchors: {
      unset: ['has no guide yet'],
      cheatsheet: ['Service quick-look', 'Campus Turn-on'],
    },
    hygiene: { bareIdOk: true }, // the cheatsheet table carries the propose-ready service ids
  },
  {
    face: 'env asks list (T119 — the standing-ask board with a seeded open ask)',
    argv: ['env', 'asks', 'list', 'r8-walk-lab'],
    anchors: {
      type: ['air-quality-monitoring'],
      asker: ['Walk Consumer'],
    },
    // id/matched columns are 8-char slices — never a bare full id.
  },
  {
    face: 'env set-guide (T119 — owner write echo; runs AFTER the unset read face above)',
    actor: 'provider',
    argv: ['env', 'set-guide', 'r8-walk-lab', '--purpose', 'walk-lab exercise world'],
    anchors: {
      echo: ['updated the guide of'],
    },
    hygiene: { bareIdOk: true },
  },

  // ---------------------------------------------------------------------
  // T119 (C1, G5) batch B — catalog/template/blueprint/governance read
  // family. blueprint show / scenario-templates show are paste-ready raw
  // JSON faces BY DESIGN (their humans copy the payload onward), so the
  // hygiene allowlists are declared, not silent.
  // ---------------------------------------------------------------------
  {
    face: 'catalog get (T119 — model detail: vendor/status/capabilities/price lines)',
    argv: ['catalog', 'get', '{catalogModel}'],
    anchors: {
      detail: ['vendor=', 'capabilities:'],
    },
    hygiene: { bareIdOk: true }, // first line IS `name (modelId)`
  },
  {
    face: 'scenario list (T119 — the legacy two-source store lists the bundled seeds)',
    argv: ['scenario', 'list'],
    anchors: {
      rows: ['campus-collab', 'source'],
    },
  },
  {
    face: 'scenario-templates show (T119 — the import-ready raw scenario JSON)',
    argv: ['scenario-templates', 'show', '{scenarioTemplate}'],
    anchors: {},
    // The human face is raw pretty JSON on purpose (paste into env import).
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'blueprint show (T119 — the paste/edit/repost raw blueprint JSON; carries the install-time ${zoneId} slot)',
    argv: ['blueprint', 'show', '{blueprint}'],
    anchors: {},
    // Same paste-ready raw-JSON design as scenario-templates show. The
    // `${…}` occurrences are the platform's OWN slot syntax (every builtin
    // blueprint parameterizes zoneId for install) — not unfilled template
    // residue in a rendered sentence, hence templateOk.
    hygiene: { bareIdOk: true, bareFloatOk: true, templateOk: true },
  },
  {
    face: 'service access requests (T119 — provider consent queue with the seeded request on the hidden offer)',
    actor: 'provider',
    argv: ['service', 'access', 'requests', '{svcHidden}'],
    anchors: {
      purpose: ['walk-lab data audit'],
    },
    hygiene: { bareIdOk: true }, // the id column IS the close/remind argument
  },
  {
    face: 'service access grants (T119 — grant roster with the recorded basis)',
    actor: 'provider',
    argv: ['service', 'access', 'grants', '{svcHidden}'],
    anchors: {
      basis: ['walk-lab consent'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'admin users list (T119 — ADMIN_EMAILS-gated roster; the provider IS the boot admin)',
    actor: 'provider',
    argv: ['admin', 'users', 'list'],
    anchors: {
      roster: ['walk-p-', '[admin]'],
    },
  },

  // ---------------------------------------------------------------------
  // T119 (C1, G5) batch C — flow family. ORDER: add/list/get before the
  // scratch lifecycle (update/disable/enable/rm), and `sim run-flow` (batch
  // D block below) runs BEFORE `flow runs` so the ledger has the run row.
  // ---------------------------------------------------------------------
  {
    face: 'flow add (T119 — the T78 ghost-trigger warning renders on the human face)',
    actor: 'provider',
    argv: ['flow', 'add', '--env', 'r8-walk-lab', '--file', 'walk-ghost-flow.yaml'],
    anchors: {
      validationWarnings: ['warning: ', 'alien-invasion', 'this world declares: fall-detected'],
    },
    hygiene: { bareIdOk: true }, // the added line prints the new flow id
  },
  {
    face: 'flow list (T119 — roster with trigger/lastRun columns + the T66d drift footnote)',
    actor: 'provider',
    argv: ['flow', 'list', '--env', 'r8-walk-lab'],
    anchors: {
      roster: ['Walk Ghost Watch', 'Walk Lab Flow', 'Walk Scratch Flow'],
      footnote: ['注：drift 为治理面标注'],
    },
    exempt: [
      {
        key: 'validationWarnings',
        reason:
          'face-split: the roster carries trigger/last-run/drift columns; the authoring warnings render verbatim on flow get (walker-covered since the T119 R102 fix) and on flow add/update',
        source: 'T119 walker ruling — the roster-scans/detail-decides precedent (service list signability)',
        date: '2026-09-19',
      },
    ],
    hygiene: { bareIdOk: true },
  },
  {
    face: 'flow get (T119 — the ghost-trigger warning renders on the detail face; the R102 fix this round)',
    actor: 'provider',
    argv: ['flow', 'get', '{flowGhost}'],
    anchors: {
      validationWarnings: ['warning: ', 'alien-invasion'],
    },
    hygiene: { bareIdOk: true }, // first line prints the flow id
  },
  {
    face: 'flow get (T119 — clean flow: header/trigger/plan lines, no warning block)',
    actor: 'provider',
    argv: ['flow', 'get', '{flowRun}'],
    anchors: {
      header: ['Walk Lab Flow', 'enabled'],
      trigger: ['trigger: '],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'flow update (T119 — rename echo on the scratch flow; revalidated warnings channel)',
    actor: 'provider',
    argv: ['flow', 'update', '{flowScratch}', '--name', 'Walk Scratch Flow v2'],
    anchors: {
      echo: ['updated ('],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'flow disable (T119 — transition echo on the scratch flow)',
    actor: 'provider',
    argv: ['flow', 'disable', '{flowScratch}'],
    anchors: {
      echo: ['disabled'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'flow enable (T119 — transition echo on the scratch flow)',
    actor: 'provider',
    argv: ['flow', 'enable', '{flowScratch}'],
    anchors: {
      echo: ['enabled'],
      // Fix-44f re-validates on re-enable and UX-16 flags the scratch flow's
      // multi-writer contention with the ghost flow — the PATCH payload
      // carries validationWarnings and the human face prints them (R102).
      validationWarnings: ['warning: ', 'Walk Ghost Watch', 'also actuates device(s) Fall Sensor B'],
    },
    hygiene: { bareIdOk: true },
  },
  // `flow rm` and the one-shot agreement transitions (counter / decide /
  // remind / hold / resume / suspend / terminate) CANNOT ride WALK_FACES:
  // the walker executes every face TWICE (--json then human), so a state
  // transition fails its own second run (flow rm → FLOW_NOT_FOUND; counter
  // → AGREEMENT_NOT_PROPOSED; hold → already held…), and `agreement remind`
  // is rate-limited to proposal-creation + 10 min (REMIND_RATE_LIMITED) —
  // no batch harness can run it without a wall-clock wait (the T118
  // lesson). They are pinned SINGLE-RUN by the named T119 blocks in
  // render-walk.vitest.test.ts and carry written exemptions here.

  // ---------------------------------------------------------------------
  // T119 (C1, G5) batch D — write faces with real render semantics. Only
  // IDEMPOTENT writes and one-way meters join the walk (the double-run is
  // safe: run-flow records two honest runs, inject fires a never-counted
  // type twice, invoke meters twice); this block sits after every
  // agreement-read face so nothing shifts the windows their anchors pin.
  // The one-shot transitions live in the named T119 blocks + exemptions.
  // ---------------------------------------------------------------------
  {
    face: 'sim run-flow (T119 — manual run echo: run id/status/summary + node lines)',
    argv: ['sim', 'run-flow', '{simId}', '{flowRun}'],
    anchors: {
      run: ['run ', 'success'],
    },
    // The echo carries run/node ids and the nodeResults JSON verbatim.
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'flow runs (T119 — run ledger: status/summary rows + the T107 sim-column caliber note)',
    actor: 'provider',
    argv: ['flow', 'runs', '{flowRun}', '--limit', '5'],
    anchors: {
      row: ['manual', 'success'],
      note: ['注：sim 列'],
    },
    hygiene: { bareIdOk: true },
  },
  {
    face: 'sim inject (T119 — the T66i honest unknown-event warning rides the human face)',
    argv: ['sim', 'inject', '{simId}', '--type', 'meteor-shower', '--zone', 'office-b'],
    anchors: {
      warning: ['warning: ', 'meteor-shower'],
    },
    // The echo is the engine's event record verbatim (json-identical).
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
  {
    face: 'agreement invoke (T119 — honest actuation echo: action/device/sim/usage/receipt chain)',
    argv: ['agreement', 'invoke', '{agreementLifecycle}', '--action', 'activate', '--sim', '{simId}'],
    anchors: {
      echo: ['invoke ok: activate on ', 'usage ', 'receipt '],
    },
    // The echo line carries the device/usage/receipt ids (the audit chain).
    hygiene: { bareIdOk: true, bareFloatOk: true },
  },
];

// ---------------------------------------------------------------------------
// 4. Completeness: the command surface + the exemption registry
// ---------------------------------------------------------------------------

/**
 * Every (group, sub[, sub-sub]) face of the CLI, hand-enumerated from
 * cli.ts's COMMANDS + each group's switch (the doc's ruling: hand-complete,
 * no static-parsing perfectionism). The walker fails when a command here is
 * neither walked nor exempted — that is the "new command must register" gate.
 */
export const COMMAND_SURFACE: string[] = [
  'apply',
  'import-ifc',
  'import-floorplan',
  'auth login',
  'auth register',
  'auth whoami',
  'auth set-name',
  'auth logout',
  'env list',
  'env get',
  'env create',
  'env delete',
  'env join',
  'env leave',
  'env members',
  'env delegates',
  'env proposals',
  'env session',
  'env export',
  'env deployment',
  'env guide',
  'env set-guide',
  'env activity',
  'env training-export',
  'env eval-run',
  'env asks',
  'device list',
  'device get',
  'device add',
  'device update',
  'device rm',
  'agent list',
  'agent get',
  'agent add',
  'agent update',
  'agent rm',
  'agent command',
  'agent ask',
  'agent what-if',
  'catalog list',
  'catalog get',
  'service list',
  'service get',
  'service publish',
  'service subscribe',
  'service unsubscribe',
  'service computation register',
  'service computation get',
  'service computation revoke',
  'service access request',
  'service access requests',
  'service access close',
  'service access remind',
  'service access grant',
  'service access grants',
  'service access revoke',
  'flow list',
  'flow get',
  'flow add',
  'flow adopt',
  'flow update',
  'flow rm',
  'flow enable',
  'flow disable',
  'flow runs',
  'blueprint list',
  'blueprint show',
  'blueprint create',
  'blueprint rm',
  'blueprint install',
  'blueprint uninstall',
  'agreement propose',
  'agreement list',
  'agreement get',
  'agreement decide',
  'agreement counter',
  'agreement remind',
  'agreement suspend',
  'agreement terminate',
  'agreement hold',
  'agreement resume',
  'agreement invoke',
  'agreement usage',
  'agreement receipts',
  'agreement read',
  'agreement stream',
  'notifications list',
  'notifications read',
  'notifications read-all',
  'admin backup',
  'admin invites',
  'admin users list',
  'admin users create',
  'admin users revoke',
  'me',
  'me set',
  'me show',
  'me clear',
  'sim create',
  'sim list',
  'sim start',
  'sim pause',
  'sim stop',
  'sim resume',
  'sim hibernate',
  'sim step',
  'sim status',
  'sim snapshot',
  'sim inject',
  'sim command',
  'sim run-flow',
  'sim watch',
  'sim eval',
  'sandbox create',
  'sandbox list',
  'sandbox stop',
  'scenario validate',
  'scenario lint',
  'scenario list',
  'scenario-templates list',
  'scenario-templates show',
];

/**
 * The exemption registry — every entry is a face NOT walked, with the honest
 * SEMANTIC reason: the face's class (destructive write / privileged /
 * long-lived stream / offline file / LLM lane / seed-used write), WHO watches
 * it instead, and why the walker stays out. T119 (C1, G5) rewrote the table
 * in full: the placeholder "when-only" entries (14 said increment-batch) and
 * the stale "Lane B rides…" entries (T74/T78 landed long ago) are gone — the
 * walked family joined WALK_FACES, the rest carry a watching suite or a
 * declared technical-debt nature. The completeness test FAILS a placeholder
 * on sight.
 */
export const EXEMPT_COMMANDS: Record<string, { reason: string; date: string }> = {
  // -- world import / offline file faces: file-format suites own them; the
  // walker seed USES `apply` but does not re-walk it (it would mutate the
  // shared world mid-walk).
  'apply': { reason: 'write face (world import) — the walker seed USES it; semantics owned by t076-apply-createdids.vitest + e2e.vitest; re-walking would mutate the shared world mid-walk', date: '2026-09-19' },
  'import-ifc': { reason: 'offline file face — import-ifc.vitest owns the parse/render contract; no server round-trip to walk', date: '2026-09-19' },
  'import-floorplan': { reason: 'offline file face — import-floorplan.vitest owns the parse/render contract', date: '2026-09-19' },
  // -- auth/profile: session lifecycle writes, one-line echoes.
  'auth login': { reason: 'write face (session create) — e2e.vitest covers the login flow; stdout is a one-line echo', date: '2026-09-19' },
  'auth register': { reason: 'write face — e2e.vitest covers registration; stdout is a one-line echo', date: '2026-09-19' },
  'auth set-name': { reason: 'write face (profile) — profile.vitest owns the profile echo family', date: '2026-09-19' },
  'auth logout': { reason: 'write face — e2e.vitest covers the logout path; one-line echo', date: '2026-09-19' },
  // -- env writes: destructive or seed-used; read sides are walker-covered.
  'env create': { reason: 'write face — e2e.vitest + env suites cover creation; the read faces (env list/get/guide) are walker-covered', date: '2026-09-19' },
  'env delete': { reason: 'write face — destructive teardown (world CASCADE domain); no owning suite walks it for obvious reasons', date: '2026-09-19' },
  'env join': { reason: 'write face — the walker seed USES it (consumer join); membership reads are walker-covered (env members)', date: '2026-09-19' },
  'env leave': { reason: 'write face — destructive on the shared seed (drops the consumer membership every later face relies on)', date: '2026-09-19' },
  'env export': { reason: 'write face (file output) — roundtrip-fidelity.vitest owns the export/import round trip', date: '2026-09-19' },
  'env training-export': { reason: 'write face (training corpus file output) — no interpretive divergence on record; the file contract is the export suite\'s domain', date: '2026-09-19' },
  'env eval-run': { reason: 'write face (starts an eval run) — heavy async job; the eval-gate runners own it (scripts/eval/)', date: '2026-09-19' },
  // -- device/agent lifecycle writes: their suites own the semantics; the
  // reads (device get/list, agent get/list) are walker-covered.
  'device add': { reason: 'write face — device-update.vitest owns; device list/get are walker-covered', date: '2026-09-19' },
  'device update': { reason: 'write face — device-update.vitest owns the update echo family', date: '2026-09-19' },
  'device rm': { reason: 'write face — destructive (retire cascade: derived services + agreements, R100 discipline); agreement-row-integrity suite owns the semantics', date: '2026-09-19' },
  'agent add': { reason: 'write face — agent-lifecycle.vitest owns; agent list/get are walker-covered', date: '2026-09-19' },
  'agent update': { reason: 'write face — the walker seed USES it (the capability withdrawal that creates the drift faces); not re-walked', date: '2026-09-19' },
  'agent rm': { reason: 'write face — destructive (v60 provider-agreement retire + unlink); agreement-row-integrity suite owns the semantics', date: '2026-09-19' },
  // -- LLM lanes: rule/fallback determinism owned by dedicated suites; the
  // pure render faces carry their own fast-lane guards.
  'agent command': { reason: "LLM lane — rule/fallback determinism owned by agent-nl.vitest; the verdict line's pure render is guarded by render-contract faces; walking would need a deterministic LLM stub, a different harness", date: '2026-09-19' },
  'agent ask': { reason: 'LLM lane — same ruling as agent command (agent-nl.vitest owns the fallback determinism)', date: '2026-09-19' },
  'agent what-if': { reason: 'LLM/fork lane — what-if-copy-consistency.vitest + agent-what-if.render.vitest cover the copy and pure faces; fork seeding is heavy for a batch walker', date: '2026-09-19' },
  // -- service writes: consent/noise semantics owned by their suites.
  'service publish': { reason: 'write face — the walker seed USES it (API-published offers); service list/get are walker-covered per verdict', date: '2026-09-19' },
  'service subscribe': { reason: 'write face — one-line echo; service.vitest + consent suites own the subscription semantics', date: '2026-09-19' },
  'service unsubscribe': { reason: 'write face — one-line echo; same ownership as service subscribe', date: '2026-09-19' },
  'service computation revoke': { reason: 'write face — destructive on the seed (kills the empty-window read faces that depend on the registered computation); data-services.vitest owns revoke semantics', date: '2026-09-19' },
  'service access request': { reason: 'write face — consent-semantics.vitest owns the request lifecycle; the provider queue (access requests) is walker-covered', date: '2026-09-19' },
  'service access close': { reason: 'write face (withdraw/reject a consent request) — consent-semantics.vitest owns the transition echoes', date: '2026-09-19' },
  'service access remind': { reason: 'write face (noise-controlled side effects) — consent-semantics.vitest owns the remind/drop branches', date: '2026-09-19' },
  'service access grant': { reason: 'write face — consent-semantics.vitest owns the grant echo; the grant roster (access grants) is walker-covered', date: '2026-09-19' },
  'service access revoke': { reason: 'write face — destructive (revokes live access; reads answer 409 afterwards); consent-semantics.vitest owns it', date: '2026-09-19' },
  // -- flow adopt: the only flow face still exempt — fork machinery.
  'flow adopt': { reason: 'write face through the governance pipeline — requires a fork-VALIDATED source flow (fork seeding is heavy, the agent what-if precedent); the proposal funnel it enters is covered by the proposal suites', date: '2026-09-19' },
  // `flow rm` + the one-shot agreement transitions: the walker executes
  // every face TWICE (--json then human), so a state transition fails its
  // own second run (T119 evidence: flow rm → FLOW_NOT_FOUND, counter →
  // AGREEMENT_NOT_PROPOSED). Their human echoes + v60 statusReason anchors
  // are pinned SINGLE-RUN by the named T119 blocks in
  // render-walk.vitest.test.ts — watched there, not by the batch walker.
  'flow rm': { reason: 'one-shot deletion — the walker double-run would 404 the second run; the deletion echo + audit rows are pinned single-run by the named T119 block and owned by flow.vitest (T74 audit)', date: '2026-09-19' },
  'agreement counter': { reason: 'one-shot transition (proposed → countered; a second counter 409s AGREEMENT_NOT_PROPOSED) — the T-059 echo is pinned single-run by the named T119 block; agreement-reason.vitest owns the terms semantics', date: '2026-09-19' },
  'agreement decide': { reason: 'one-shot transition (a second decide 409s on the left state) — the accept path is the walker seed itself; the reject echo is pinned single-run by the named T119 block', date: '2026-09-19' },
  'agreement remind': { reason: 'rate-limited by design (T-309: earliest remind = proposal-creation + 10 min, REMIND_RATE_LIMITED) — no batch/e2e harness can run it without a wall-clock wait (the T118 lesson); the refusal teaching is pinned by the named T119 block and the trace/autoDecision branches by the agreement suites', date: '2026-09-19' },
  'agreement hold': { reason: 'one-shot transition (active → held; holdExpiresAt echo) — pinned single-run with the payload/holdExpiresAt anchors by the named T119 block', date: '2026-09-19' },
  'agreement resume': { reason: 'one-shot transition (held → active) — pinned single-run by the named T119 block', date: '2026-09-19' },
  'agreement suspend': { reason: 'one-shot transition (v60 statusReason echo + R99 irreversibility teaching; a second suspend 409s) — pinned single-run by the named T119 block', date: '2026-09-19' },
  'agreement terminate': { reason: 'one-shot transition (terminal; statusReason + outcome 口径) — pinned single-run by the named T119 block', date: '2026-09-19' },
  // -- blueprint writes: blueprint.vitest owns; show is walker-covered.
  'blueprint create': { reason: 'write face — blueprint.vitest owns the create echo; blueprint list/show are walker-covered', date: '2026-09-19' },
  'blueprint rm': { reason: 'write face — destructive (builtin rows refuse; custom rows vanish); blueprint.vitest owns it', date: '2026-09-19' },
  'blueprint install': { reason: 'write face — heavy (world provisioning: devices/agents/flows created); blueprint.vitest owns the install semantics', date: '2026-09-19' },
  'blueprint uninstall': { reason: 'write face — destructive (agreement/service cascade, R100 discipline); blueprint.vitest + agreement-row-integrity own it', date: '2026-09-19' },
  // -- agreement negotiation writes the walker seed USES; the walked faces
  // (counter/remind/decide reject + the lifecycle chain) cover the family.
  'agreement propose': { reason: 'write face — the walker seed USES it (three proposals: lifecycle/counter/remind); the decide/counter/remind echoes are walker-covered', date: '2026-09-19' },
  'agreement stream': { reason: 'long-lived WebSocket loop — cannot walk batch-style (the walker requires exit 0); stream frames are covered by the agreement suite and the stream-frames contract tests', date: '2026-09-19' },
  // -- notifications writes: notifications.vitest owns the echo family.
  'notifications read': { reason: 'write face (marks read) — notifications.vitest owns; notifications list is walker-covered', date: '2026-09-19' },
  'notifications read-all': { reason: 'write face (marks all read) — notifications.vitest owns', date: '2026-09-19' },
  // -- admin: privileged (ADMIN_EMAILS-gated). The API gates + shapes are
  // watched server-side; the CLI echo faces are one line each.
  'admin backup': { reason: 'privileged write face (ADMIN_EMAILS-gated) — the gate is watched by apps/server/src/observability.vitest.test.ts; walking would mint a backup artifact on the shared seed', date: '2026-09-19' },
  'admin invites': { reason: 'privileged write face (ADMIN_EMAILS-gated, mints plaintext codes) — platform-invites.vitest.test.ts owns the API contract', date: '2026-09-19' },
  'admin users create': { reason: 'privileged write face (ADMIN_EMAILS-gated) — admin-users.vitest.test.ts owns the roster API contract', date: '2026-09-19' },
  'admin users revoke': { reason: 'privileged write face (destructive: kills a login) — admin-users.vitest.test.ts owns it', date: '2026-09-19' },
  // -- me/profile writes: profile.vitest owns; bare `me` is walker-covered.
  'me set': { reason: 'write face (profile prefs) — profile.vitest owns the echo; bare `me` is walker-covered', date: '2026-09-19' },
  'me show': { reason: 'duplicate read face of walked bare `me` (same payload, same renderer); profile.vitest pins the alias', date: '2026-09-19' },
  'me clear': { reason: 'write face (profile prefs) — profile.vitest owns it', date: '2026-09-19' },
  // -- sim lifecycle writes: the seed USES create/start; the rest are
  // destructive or clock-mutating on the shared world the read faces walk.
  'sim create': { reason: 'write face — the walker seed USES it (consumer sim); sim list/status/snapshot are walker-covered', date: '2026-09-19' },
  'sim start': { reason: 'write face — the walker seed USES it; status/snapshot/eval are walker-covered', date: '2026-09-19' },
  'sim pause': { reason: 'write face (lifecycle) — mutates the shared sim state the snapshot/status faces read; sim-options.vitest owns the echo family', date: '2026-09-19' },
  'sim stop': { reason: 'write face — destructive (kills the world the walk reads); sim-options.vitest owns it', date: '2026-09-19' },
  'sim resume': { reason: 'write face (lifecycle) — same shared-state ruling as sim pause', date: '2026-09-19' },
  'sim hibernate': { reason: 'write face — destructive (checkpoint + session hibernate); the hibernate lifecycle is owned by the world-session suites', date: '2026-09-19' },
  'sim step': { reason: 'write face — advances the shared seed clock (an ordering hazard for every time-window face in this manifest)', date: '2026-09-19' },
  'sim watch': { reason: 'infinite streaming loop — a different harness; the T73 judgment is pure-tested (judgeZoneChange) and the render face is covered by sim-status.render', date: '2026-09-19' },
  // -- sandbox: heavy provisioning / destructive; sandbox.vitest owns.
  'sandbox create': { reason: 'write face (heavy provisioning) — sandbox.vitest owns the lifecycle echoes', date: '2026-09-19' },
  'sandbox stop': { reason: 'write face — destructive; sandbox.vitest owns it; sandbox list is walker-covered', date: '2026-09-19' },
  // -- scenario offline file faces.
  'scenario validate': { reason: 'offline file face — scenario-validate.vitest owns (no server, no stream risk)', date: '2026-09-19' },
  'scenario lint': { reason: 'offline file face — scenario-validate.vitest owns', date: '2026-09-19' },
};

/** The `service get` command line covered by multiple walked faces collapses to this key. */
export function commandKeyOf(argv: string[]): string {
  const group = argv[0] ?? '';
  if (group === 'service') {
    if (argv[1] === 'computation' || argv[1] === 'access') return `service ${argv[1]} ${argv[2]}`;
    return `service ${argv[1] ?? ''}`.trim();
  }
  if (group === 'admin' && argv[1] === 'users') return 'admin users list';
  if (group === 'me' && argv.length <= 1) return 'me';
  return [group, argv[1]].filter(part => part !== undefined && part !== '').join(' ');
}
