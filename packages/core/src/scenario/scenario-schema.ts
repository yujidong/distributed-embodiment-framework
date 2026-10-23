/**
 * Scenario JSON Schema (draft-07) — wire format for scenario files v1.0
 *
 * Validates the on-disk shape of a scenario file before the loader applies
 * semantic checks (reference integrity, binding support) and defaults.
 *
 * Design notes:
 * - `additionalProperties: true` everywhere: unknown fields are tolerated so
 *   newer schema minor versions remain loadable by this validator.
 * - Required fields are the minimum the engine needs to build a world.
 * - `binding` accepts `sim://` (default) and `hass://<entity-id>` (P3a Home
 *   Assistant backend; resolution happens at runtime via a deviceFactory,
 *   not in the loader).
 */

import Ajv, { type ValidateFunction } from 'ajv';

import { FLOW_JSON_SCHEMA } from '../flows/flow-types.js';

const nonEmptyString = { type: 'string', minLength: 1 } as const;

/**
 * Localized-text object shape (`{ zh, en, … }`). Future languages (ja, ko)
 * add keys without changing this schema — `additionalProperties: true` on
 * the object form keeps the door open.
 */
const localizedTextObjectSchema = {
  type: 'object',
  required: ['zh', 'en'],
  additionalProperties: true,
  properties: {
    zh: { type: 'string' },
    en: { type: 'string' },
  },
} as const;

/**
 * A field that may be either a plain string (legacy scenario files) or a
 * `{zh, en}` object. The loader normalizes at runtime; downstream
 * consumers call `localizedText(value, locale)` from `@active-collaboration/shared`.
 */
const localizedTextSchema = {
  oneOf: [{ type: 'string' }, localizedTextObjectSchema],
} as const;

/** Same as `localizedTextSchema` but the string form must be non-empty. */
const localizedNonEmptySchema = {
  oneOf: [nonEmptyString, localizedTextObjectSchema],
} as const;

const zoneBoundsSchema = {
  type: 'object',
  required: ['minX', 'maxX', 'minY', 'maxY'],
  additionalProperties: true,
  properties: {
    minX: { type: 'number' },
    maxX: { type: 'number' },
    minY: { type: 'number' },
    maxY: { type: 'number' },
    minZ: { type: 'number' },
    maxZ: { type: 'number' },
  },
} as const;

const zoneSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: true,
  properties: {
    id: nonEmptyString,
    name: { type: 'string' },
    type: { type: 'string' },
    // Building tier (B-A): flat floor metadata, no nesting. Both optional —
    // absent means "single building, ground floor" and physics is unchanged.
    buildingId: { type: 'string' },
    floor: { type: 'integer' },
    bounds: zoneBoundsSchema,
    // Building tier (B-B): current headcount driving the occupancy effect
    // sources (sensible heat + CO2). Optional; absent = 0.
    occupancy: { type: 'number', minimum: 0 },
    // Fix-52a: schedule-driven occupancy — the runtime auto-fires
    // setZoneOccupancy at the schedule boundaries.
    occupantSchedule: {
      type: 'object',
      required: ['count', 'startSimTimeSec', 'endSimTimeSec'],
      additionalProperties: false,
      properties: {
        count: { type: 'integer', minimum: 0 },
        startSimTimeSec: { type: 'number', minimum: 0 },
        endSimTimeSec: { type: 'number', minimum: 0 },
        repeatDaily: { type: 'boolean', default: true },
      },
    },
    // FEAT-07 phase-2: temporary calendar overlay — replaces the base
    // occupantSchedule inside [startsAtSimSec, endsAtSimSec) (absolute sim
    // seconds); the loader rejects a window with endsAt <= startsAt.
    occupantScheduleOverlay: {
      type: 'object',
      required: ['schedule', 'startsAtSimSec', 'endsAtSimSec'],
      additionalProperties: false,
      properties: {
        schedule: {
          type: 'object',
          required: ['count', 'startSimTimeSec', 'endSimTimeSec'],
          additionalProperties: false,
          properties: {
            count: { type: 'integer', minimum: 0 },
            startSimTimeSec: { type: 'number', minimum: 0 },
            endSimTimeSec: { type: 'number', minimum: 0 },
            repeatDaily: { type: 'boolean', default: true },
          },
        },
        startsAtSimSec: { type: 'number', minimum: 0 },
        endsAtSimSec: { type: 'number', minimum: 0 },
      },
    },
    // Building tier (B-B): per-zone envelope flux multiplier (U-value
    // semantics) for exchanges with an adjacent outdoor zone. Wins over
    // meta.envelopeU; defaults to 0.1 in the physics layer.
    envelopeU: { type: 'number', minimum: 0, maximum: 1 },
    // T-105 (F-PH05): the zone's solar aperture (m²) — glass zones get a
    // per-tick solar-gain heat source W = solar_radiation × area × g-value.
    glassAreaM2: { type: 'number', minimum: 0 },
    // T-105 (F-PH05): interior ambient coupling buffer (0..1) — the zone
    // relaxes toward its ambient attractor at this fraction of the generic
    // rate (buffered interior vs direct exterior tracking). Default 1.
    ambientBuffer: { type: 'number', minimum: 0, maximum: 1 },
    adjacentZoneIds: {
      type: 'array',
      items: nonEmptyString,
      uniqueItems: true,
    },
    baseline: {
      type: 'object',
      additionalProperties: { type: ['number', 'boolean'] },
    },
    // R82: declarative interior rooms — descriptive world metadata (the
    // runtime never interprets it); shape-validated so authored detail
    // cannot silently degrade to an unusable blob.
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        additionalProperties: true,
        properties: {
          code: { type: 'string' },
          name: { type: 'string', minLength: 1 },
          type: { type: 'string' },
          hours: { type: 'string' },
          pos: {
            type: 'array',
            items: { type: 'number', minimum: 0, maximum: 1 },
            minItems: 2,
            maxItems: 2,
          },
        },
      },
    },
  },
} as const;

const deviceSchema = {
  type: 'object',
  required: ['id', 'type', 'capabilities', 'zoneId'],
  additionalProperties: true,
  properties: {
    id: nonEmptyString,
    name: { type: 'string' },
    type: nonEmptyString,
    role: { enum: ['sensor', 'actuator', 'hybrid'] },
    capabilities: {
      type: 'array',
      items: nonEmptyString,
    },
    zoneId: nonEmptyString,
    binding: {
      type: 'string',
      pattern: '^(sim|hass)://',
    },
    initialState: { type: 'object' },
  },
} as const;

const agentLLMSchema = {
  type: 'object',
  required: ['provider', 'model'],
  additionalProperties: true,
  properties: {
    provider: nonEmptyString,
    model: nonEmptyString,
    params: { type: 'object' },
    systemPrompt: nonEmptyString,
  },
} as const;

/**
 * P3: a semantic offer rule — built-in rules live in core
 * (service/semantic-offers.ts); scenarios may add their own (top-level
 * `semanticOfferRules`) or declare an agent's services directly
 * (`agents[].services`). `requires`/`actuates` must be non-empty: an
 * offer without a requirement set matches EVERY agent, and one without
 * actuation backing authorizes no executable surface.
 */
const semanticOfferRuleSchema = {
  type: 'object',
  required: ['semanticType', 'label', 'description', 'requires', 'actuates'],
  additionalProperties: true,
  properties: {
    semanticType: nonEmptyString,
    label: nonEmptyString,
    description: { type: 'string' },
    requires: { type: 'array', items: nonEmptyString, minItems: 1 },
    actuates: { type: 'array', items: nonEmptyString, minItems: 1 },
  },
} as const;

const agentSchema = {
  type: 'object',
  required: ['id', 'name', 'capabilities'],
  additionalProperties: true,
  properties: {
    id: nonEmptyString,
    name: nonEmptyString,
    capabilities: {
      type: 'array',
      items: nonEmptyString,
    },
    managesZoneIds: {
      type: 'array',
      items: nonEmptyString,
      uniqueItems: true,
    },
    boundDeviceIds: {
      type: 'array',
      items: nonEmptyString,
      uniqueItems: true,
    },
    // Master enable switch (default true): disabled agents receive no events
    // and are not eligible for partner selection.
    enabled: { type: 'boolean' },
    // T-601 (R26): `llm: null` is the explicit per-agent rule-only opt-out —
    // legal at the schema boundary, honored by EngineRuntime buildAgent.
    llm: { anyOf: [agentLLMSchema, { type: 'null' }] },
    // P3: author-declared semantic services (see scenario-types.ts).
    services: {
      type: 'array',
      items: semanticOfferRuleSchema,
    },
  },
} as const;

const eventSchema = {
  type: 'object',
  required: ['id', 'type', 'zoneId'],
  additionalProperties: true,
  properties: {
    id: nonEmptyString,
    type: nonEmptyString,
    zoneId: nonEmptyString,
    parameter: nonEmptyString,
    value: { type: ['number', 'boolean', 'string'] },
    atSimTimeSec: { type: 'number', minimum: 0 },
    severity: { enum: ['low', 'medium', 'high', 'critical'] },
    requiredCapabilities: {
      type: 'array',
      items: nonEmptyString,
      uniqueItems: true,
    },
    // T-019: replay-baked observation events are details-only (the runtime
    // never injects them) — see ScenarioEvent.observationOnly.
    observationOnly: { type: 'boolean' },
  },
} as const;

/** JSON Schema (draft-07) for a scenario file, version "1.0". */
export const SCENARIO_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://active-collaboration.dev/schemas/scenario-1.0.json',
  title: 'ScenarioFile',
  type: 'object',
  required: ['version', 'meta', 'zones', 'devices', 'agents'],
  additionalProperties: true,
  properties: {
    version: { const: '1.0' },
    meta: {
      type: 'object',
      required: ['id', 'name'],
      additionalProperties: true,
      properties: {
        id: nonEmptyString,
        name: localizedNonEmptySchema,
        description: localizedTextSchema,
        // Building tier (B-A): floor-to-floor height in meters, used by the
        // physics layer for z coordinates and by the frontend for storey
        // spacing. Defaults to 3.5 when omitted.
        storeyHeight: { type: 'number', exclusiveMinimum: 0 },
        // Slab attenuation for cross-floor diffusion coupling (0 = perfect
        // insulation, 1 = no slab). Defaults to 0.15 in the physics layer.
        slabAttenuation: { type: 'number', minimum: 0, maximum: 1 },
        // Building tier (B-B): envelope flux multiplier for indoor↔outdoor
        // coupling (per-zone `envelopeU` wins). Defaults to 0.1 in the
        // physics layer.
        envelopeU: { type: 'number', minimum: 0, maximum: 1 },
        // Building tier (B-B): per-person sensible heat (W) and CO2
        // emission rate (ppm/s) for the occupancy effect sources.
        // Defaults: 75 W and 0.03 ppm/s in EngineRuntime.
        occupancyHeatW: { type: 'number', minimum: 0 },
        occupancyCo2Rate: { type: 'number', minimum: 0 },
        // Explicit opt-in to per-read Gaussian noise on the built-in
        // environmental value models (default: false — a fresh world is
        // deterministic and never "dirty").
        environmentNoise: { type: 'boolean' },
        // FEAT-03: opt-in field dynamics for CUSTOM (non-enum) zone
        // parameters — a declared key relaxes toward its zone baseline
        // instead of holding forever (T-304 static semantics). Semantic
        // checks (custom-keys-only, parameterEffects targets must be
        // declared here) run in the loader with teaching messages;
        // additionalProperties:false inside each entry so a typo'd field
        // fails the load.
        parameterPhysics: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              relaxRatePerSec: { type: 'number', minimum: 0 },
              relaxToBaseline: { type: 'boolean' },
            },
          },
        },
        // FEAT-03 (stage 2): device coupling — while a zone device holding
        // `capability` (or of `deviceType`) is ON, the zone's custom
        // `zoneParameter` drifts at `ratePerSec` × dt (negative = removal,
        // e.g. fume-hood ventilation draining gas).
        parameterEffects: {
          type: 'array',
          items: {
            type: 'object',
            required: ['zoneParameter', 'ratePerSec'],
            // At least one selector: a coupling with no device face would
            // silently never fire.
            anyOf: [{ required: ['capability'] }, { required: ['deviceType'] }],
            additionalProperties: false,
            properties: {
              capability: nonEmptyString,
              deviceType: nonEmptyString,
              zoneParameter: nonEmptyString,
              ratePerSec: { type: 'number' },
            },
          },
        },
        // R40-B1: the what-if predictor's budget for this world. Capped at
        // 7200s (2h) — a lookahead beyond that is a fork-cost problem, not a
        // schema one; additionalProperties:false so a typo'd field fails the
        // load instead of silently falling back to the platform default.
        whatIfQuota: {
          type: 'object',
          required: ['maxDurationSec'],
          additionalProperties: false,
          properties: {
            maxDurationSec: { type: 'integer', minimum: 1, maximum: 7200 },
            maxForksPerDay: { type: 'integer', minimum: 1 },
          },
        },
        // Wave 2 / Wave 8 authoring extensions — bilingual marketing copy.
        // Tagline is the established `{zh, en}` pattern; name/description
        // accept either form for incremental migration.
        tagline: localizedTextObjectSchema,
        vendorDisclaimer: localizedTextSchema,
      },
    },
    zones: {
      type: 'array',
      minItems: 1,
      items: zoneSchema,
    },
    devices: {
      type: 'array',
      items: deviceSchema,
    },
    agents: {
      type: 'array',
      items: agentSchema,
    },
    events: {
      type: 'array',
      items: eventSchema,
    },
    // User-orchestrated business flows (optional). Elements follow the flows
    // module's FLOW_JSON_SCHEMA; semantic checks (assignments, conditions)
    // run via validateFlow(), not here.
    flows: {
      type: 'array',
      items: FLOW_JSON_SCHEMA,
    },
    // P3: scenario-authored semantic offer rules (merged over the built-in
    // table wherever offers are derived).
    semanticOfferRules: {
      type: 'array',
      items: semanticOfferRuleSchema,
    },
    // P3: scenario-authored capability-equivalence groups (registered at
    // load time). A group needs ≥2 members to equate anything.
    capabilitySynonyms: {
      type: 'array',
      items: { type: 'array', items: nonEmptyString, minItems: 2 },
    },
  },
} as const;

/**
 * Create a compiled ajv validator for the scenario schema.
 * `allErrors` is on so callers can report every violation at once.
 */
export function createScenarioValidator(): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(SCENARIO_JSON_SCHEMA);
}
