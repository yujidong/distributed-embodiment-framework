/**
 * Computation evaluator — declarative aggregation specs for data services
 * (R14 Wave-A, design-data-services.md §3.1)
 *
 * A ComputationSpec is a CLOSED-SCHEMA, purely declarative description of an
 * aggregation over world state: the provider writes WHAT to compute (zone
 * parameters, provider-device states, injected-event windows), the PLATFORM
 * evaluates it deterministically. No provider code, no sandbox, no LLM
 * anywhere near a billable reading (design principle 2 / §10).
 *
 * This module is pure: spec validation + spec × inputs → {data,
 * inputsSummary}. Route code gathers the inputs (sim snapshot zones, the
 * provider agent's bound devices from the sim + env store, the per-sim
 * injected-event window) and builds the DataFrame envelope — so the math is
 * unit-testable without Fastify or a registry.
 *
 * Privacy invariants (design principle 3): outputs are aggregates only —
 * counts/averages/min/max over the selected inputs. There is NO schema field
 * that could project an ARBITRARY device (no `latest`/newest-device pick);
 * `inputs.devices` (T-065, R16) is the explicit, provider-owned exception —
 * the provider DECLARES the exact device ids the computation may read (a
 * per-bed service names exactly its bed's device), the route validates the
 * ids against the provider agent's bound devices, and the evaluator filters
 * to the declared set so `inputsSummary.devices` always counts EXACTLY the
 * scoped devices: a computation can never read a device outside its
 * declared inputs, and the summary can never overstate what was read.
 */

import { ApiError } from './errors.js';

// ---------------------------------------------------------------------------
// Spec types (the closed schema)
// ---------------------------------------------------------------------------

/** Phase 1 kinds. `flow-report` is a RESERVED name (Phase 2) — parse-only. */
export type ComputationKind = 'zone-query' | 'device-aggregate';

/** Numeric aggregation over the selected zones' parameter values. */
export type ZoneFn = 'avg' | 'min' | 'max' | 'sum';

/**
 * Aggregations over the provider agent's bound devices that declare the
 * capability. `count`/`countActive` never touch values; `avg`/`min`/`max`
 * aggregate a numeric state path. There is deliberately NO `latest`/per-device
 * projection: snapshot device state carries no timestamps, and "the newest
 * device" would be arbitrary — honest aggregation only.
 */
export type DeviceFn = 'count' | 'countActive' | 'avg' | 'min' | 'max';

export interface ZoneMetric {
  source: 'zone';
  /** Zone parameter name (the standard seven ∪ declared baseline keys, T-304). */
  path: string;
  fn: ZoneFn;
  /** Output field name — must appear in interface.dataSchema verbatim. */
  as: string;
}

export interface DeviceMetric {
  source: 'device';
  /** Devices = the provider agent's bound devices declaring this capability. */
  capability: string;
  /** Device state key (required for avg/min/max; countActive defaults 'active'). */
  path?: string;
  fn: DeviceFn;
  as: string;
}

export interface EventMetric {
  source: 'event';
  /** Original injected event type (e.g. 'fall-detected'), pre-mapping. */
  eventType: string;
  fn: 'countSince';
  /** Window length in SIMULATED seconds back from the evaluation's simTime. */
  windowSec: number;
  as: string;
}

export type ComputationMetric = ZoneMetric | DeviceMetric | EventMetric;

/** The stored (validated) computation spec. */
export interface ComputationSpec {
  kind: ComputationKind;
  /** Declared refresh target (seconds) — cache TTL + consumer freshness anchor. */
  refreshSec: number;
  /** Zone ids, or '*' for every zone in the world. */
  zones: string[] | '*';
  metrics: ComputationMetric[];
  /**
   * T-065 (R16): explicit device scoping — the EXACT device ids the
   * computation may read (the per-bed form names one device). Undefined =
   * the Phase-1 aggregate lane (the provider agent's bound devices, caller-
   * gathered). The route validates the ids are bound to the provider agent
   * (foreign/unowned ids are refused); the evaluator filters inputs to this
   * set, so inputsSummary.devices counts exactly the scoped devices.
   */
  devices?: string[];
  /** Structured provider privacy declaration (informational, surfaces in interface). */
  excludes?: string[];
}

// ---------------------------------------------------------------------------
// Evaluation input views (caller-gathered, snapshot-shaped)
// ---------------------------------------------------------------------------

export interface ZoneView {
  id: string;
  parameters: Record<string, number | boolean>;
  occupancy?: number;
}

export interface DeviceView {
  id: string;
  /** Declared capabilities (from the env-store device row, not the snapshot). */
  capabilities: string[];
  state: Record<string, unknown>;
}

/** One injected event inside the countSince window (sim-clock anchored). */
export interface WindowedEventView {
  eventType: string;
  simTimeSec: number;
}

export interface ComputationInputs {
  zones: ZoneView[];
  devices: DeviceView[];
  events: WindowedEventView[];
  simTimeSec: number;
  /**
   * T54 (R6 u4-F1): per-device state paths WRITTEN at least once since the
   * runtime constructed the device (commands, tick write-backs, checkpoint
   * restores). A device whose written set lacks the metric path feeds the
   * value straight from scenario initialState — a PLACEHOLDER, not a
   * measurement. Absent device key = the runtime cannot say for that device
   * (legacy adapter); an absent map entirely = the runtime cannot say at all
   * — both keep the unwritten gate silent (honest-unknown, no fabricated
   * verdicts).
   */
  writtenDeviceStatePaths?: Record<string, string[]>;
}

/** T54: value fields whose inputs were entirely never-written state paths. */
export interface DeviceStateUnwrittenView {
  /** Output field names (metric `as`) whose value rested only on placeholders. */
  fields: string[];
  /**
   * Cross-face contrast: a ZONE parameter carrying the SAME name as the
   * never-written device state path (the "two faces" trap — the zone face
   * says 500 W while the device face still holds the initialized 0). Capped
   * at 3 entries; values as of this evaluation.
   */
  zoneEcho: Array<{ field: string; parameter: string; zoneId: string; value: number | boolean }>;
}

export interface ComputationResult {
  /** One entry per metric `as` — always present; null when the input had no usable values (no silent field dropping). */
  data: Record<string, number | null>;
  inputsSummary: {
    zones: number;
    devices: number;
    eventsWindowed: number;
    /** Present (non-empty) only when a value metric rested entirely on never-written device state. */
    deviceStateUnwritten?: DeviceStateUnwrittenView;
  };
}

// ---------------------------------------------------------------------------
// Validation (closed schema — unknown keys 400 with teaching, lessons.md #1/#5)
// ---------------------------------------------------------------------------

const ZONE_FNS: readonly ZoneFn[] = ['avg', 'min', 'max', 'sum'];
const DEVICE_FNS: readonly DeviceFn[] = ['count', 'countActive', 'avg', 'min', 'max'];
const KINDS: readonly ComputationKind[] = ['zone-query', 'device-aggregate'];
/** Phase 2 reserved kind name — parseable so the route can reject with teaching. */
export const RESERVED_COMPUTATION_KINDS: readonly string[] = ['flow-report'];

/**
 * T-075 (R22, CC-F04): the boolean-ish device state spellings the platform's
 * power commands WRITE — PowerCommandHandler always writes `power` (boolean)
 * + `status`, and mirrors into `on` / `powered` when the device tracks them.
 * `active` is NOT among them (no handler ever writes it), so a `countActive`
 * metric on the bare default plausibly reads zero forever. Exported for the
 * registration route's world-aware warning (the T-406 non-blocking pattern).
 */
export const COUNT_ACTIVE_BOOLEAN_KEYS: readonly string[] = ['power', 'on', 'powered'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "${where}.${key}" is not a known field (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}" must be a non-empty string`);
  }
  return value.trim();
}

function positiveNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}" must be a number > 0`);
  }
  return value;
}

/**
 * Parse + validate a registration body (`POST /api/services/:id/computation`)
 * into a ComputationSpec. Closed at every level: unknown keys are named, the
 * metric source literals are checked, `as` names must be unique, and the kind
 * must fit its metrics (zone-query ≥1 zone metric; device-aggregate ≥1 device
 * metric; event metrics allowed in both). Returns the `as` names separately —
 * the route cross-checks them against interface.dataSchema (§9).
 */
export function parseComputationSpec(raw: unknown): {
  spec: ComputationSpec;
  asNames: string[];
  schemaVersion: number;
  /** T-406: non-blocking registration hints (e.g. qualified device paths). */
  warnings: string[];
} {
  if (!isPlainObject(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object (the computation spec)');
  }
  const specWarnings: string[] = [];
  requireKeys(raw, ['kind', 'refreshSec', 'inputs', 'excludes', 'schemaVersion', 'interface'], 'body');

  const kind = raw.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as ComputationKind)) {
    const reserved = typeof kind === 'string' && RESERVED_COMPUTATION_KINDS.includes(kind)
      ? ' (reserved for Phase 2 — not implemented yet)'
      : '';
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "kind" must be one of ${KINDS.map(k => `"${k}"`).join(' | ')} — got "${String(kind)}"${reserved}`,
    );
  }

  const refreshSec = positiveNumber(raw.refreshSec, 'refreshSec');

  if (!isPlainObject(raw.inputs)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "inputs" must be an object');
  }
  requireKeys(raw.inputs, ['zones', 'metrics', 'devices'], 'inputs');

  let zones: string[] | '*';
  if (raw.inputs.zones === '*') {
    zones = '*';
  } else if (Array.isArray(raw.inputs.zones)) {
    if (raw.inputs.zones.length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "inputs.zones" must be a non-empty array of zone ids, or "*" for every zone',
      );
    }
    zones = raw.inputs.zones.map((zone, index) => {
      const zoneId = nonEmptyString(zone, `inputs.zones[${index}]`);
      // T132 (R20-F, u2-F1): the wildcard has exactly ONE legal spelling — the
      // whole inputs.zones as the bare string "*" (handled above). An array
      // containing "*" is the silent-null trap: the array form filters zones
      // by LITERAL id, so `["*"]` matched zero zones and every read honestly
      // 409ed METRIC_NO_READING after the registration looked accepted.
      // Same write-time teaching refusal as the T-406 dotted-path spec
      // ("parses, but can never work" → refuse where it is written).
      if (zoneId === '*') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "inputs.zones[${index}]" is the wildcard "*" — the array form cannot contain it. ` +
          'The wildcard has ONE legal spelling: write the WHOLE inputs.zones as the bare string "*" ' +
          '(every zone in the world), or enumerate CONCRETE zone ids in the array ' +
          '(`eaf env get --full` lists the world\'s zone ids). The array form filters zones by literal id, ' +
          'so a "*" element would match no zone and every read would refuse with no reading',
        );
      }
      return zoneId;
    });
  } else {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "inputs.zones" must be an array of zone ids, or "*" for every zone',
    );
  }

  if (!Array.isArray(raw.inputs.metrics) || raw.inputs.metrics.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "inputs.metrics" must be a non-empty array of metric definitions',
    );
  }
  const metrics: ComputationMetric[] = raw.inputs.metrics.map((metric, index) => {
    const where = `inputs.metrics[${index}]`;
    if (!isPlainObject(metric)) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "${where}" must be an object`);
    }
    const source = metric.source;
    if (source === 'zone') {
      requireKeys(metric, ['source', 'path', 'fn', 'as'], where);
      const fn = metric.fn;
      if (typeof fn !== 'string' || !ZONE_FNS.includes(fn as ZoneFn)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${where}.fn" must be one of ${ZONE_FNS.map(f => `"${f}"`).join(' | ')} for a zone metric`,
        );
      }
      const zonePath = nonEmptyString(metric.path, `${where}.path`);
      // T-406 (R19, FM-F03): zone metrics read zone.parameters[path] as a
      // LITERAL key — a dotted "zoneId.parameter" path never matches and the
      // metric silently evaluates null on every frame. Reject at write time
      // with the teaching error (that syntax is a flow-condition feature).
      if (zonePath.includes('.')) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${where}.path" must be the BARE zone parameter name (got "${zonePath}") — ` +
          'zones are already selected by inputs.zones; the "zoneId.parameter" syntax is a ' +
          'flow-condition feature, not a computation metric path',
        );
      }
      return {
        source: 'zone',
        path: zonePath,
        fn: fn as ZoneFn,
        as: nonEmptyString(metric.as, `${where}.as`),
      } satisfies ZoneMetric;
    }
    if (source === 'device') {
      requireKeys(metric, ['source', 'capability', 'path', 'fn', 'as'], where);
      const fn = metric.fn;
      if (typeof fn !== 'string' || !DEVICE_FNS.includes(fn as DeviceFn)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${where}.fn" must be one of ${DEVICE_FNS.map(f => `"${f}"`).join(' | ')} for a device metric` +
            ' — only aggregate functions are allowed (per-device projection is refused by design)',
        );
      }
      const needsPath = fn === 'avg' || fn === 'min' || fn === 'max';
      const path = metric.path !== undefined
        ? nonEmptyString(metric.path, `${where}.path`)
        : undefined;
      if (needsPath && path === undefined) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${where}.path" (the device state key) is required for fn "${fn}"`,
        );
      }
      // T-406 (R19, FM-F03): device state keys are free-form, so qualified
      // paths stay PERMISSIVE here — but the "deviceKey.field" shape is the
      // standing silent-null trap, so surface a warning the route can attach
      // to its 201 (the reader learns before the first all-null frame).
      const devicePathWarning =
        path !== undefined && /^[^.]+\.[^.]+$/.test(path)
          ? `${where}.path "${path}" looks like a qualified "deviceKey.field" path — device metric ` +
            'paths are the LITERAL device state key; the qualified syntax is a flow-condition ' +
            'feature. If the state key really contains a dot, ignore this warning.'
          : undefined;
      if (devicePathWarning !== undefined) specWarnings.push(devicePathWarning);
      // T-075 (R22, CC-F04): countActive defaults path 'active' — a key NO
      // platform command handler ever writes (turn-on writes power/on/powered),
      // so the bare default plausibly counts zero forever. Free-form keys stay
      // permissive (a device may legitimately track `active` in initialState),
      // so this is a teaching WARNING, not a 400 — the world-aware half of the
      // check (against the bound devices' actual keys) lives in the route.
      if (fn === 'countActive' && path === undefined) {
        specWarnings.push(
          `${where} (countActive) reads the DEFAULT state key "active", which no platform ` +
            'command handler ever writes — turn-on/turn-off maintain the boolean spellings ' +
            `${COUNT_ACTIVE_BOOLEAN_KEYS.map(key => `"${key}"`).join(', ')} ` +
            '(power always; on/powered when the device tracks them). Pass an explicit ' +
            'path (e.g. "power") unless your devices genuinely track a custom "active" key.',
        );
      }
      return {
        source: 'device',
        capability: nonEmptyString(metric.capability, `${where}.capability`),
        ...(path !== undefined ? { path } : {}),
        fn: fn as DeviceFn,
        as: nonEmptyString(metric.as, `${where}.as`),
      } satisfies DeviceMetric;
    }
    if (source === 'event') {
      requireKeys(metric, ['source', 'eventType', 'fn', 'windowSec', 'as'], where);
      if (metric.fn !== 'countSince') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${where}.fn" must be "countSince" for an event metric`,
        );
      }
      return {
        source: 'event',
        eventType: nonEmptyString(metric.eventType, `${where}.eventType`),
        fn: 'countSince',
        windowSec: positiveNumber(metric.windowSec, `${where}.windowSec`),
        as: nonEmptyString(metric.as, `${where}.as`),
      } satisfies EventMetric;
    }
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "${where}.source" must be one of "zone" | "device" | "event" — got "${String(source)}"`,
    );
  });

  const asNames = metrics.map(metric => metric.as);
  if (new Set(asNames).size !== asNames.length) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Output field names ("as") must be unique — duplicates: ${asNames.filter((name, i) => asNames.indexOf(name) !== i).join(', ')}`,
    );
  }

  // T-065 (R16): explicit device scoping — the per-bed lane. The ids are
  // validated against the provider agent's bound devices by the ROUTE (the
  // evaluator is pure and world-blind); here we keep the closed schema:
  // non-empty, unique, and only meaningful with a device metric to scope.
  let devices: string[] | undefined;
  if (raw.inputs.devices !== undefined) {
    if (!Array.isArray(raw.inputs.devices) || raw.inputs.devices.length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "inputs.devices" must be a non-empty array of device ids when provided (the per-bed form names exactly its bed\'s device)',
      );
    }
    devices = raw.inputs.devices.map((device, index) =>
      nonEmptyString(device, `inputs.devices[${index}]`));
    if (new Set(devices).size !== devices.length) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "inputs.devices" must not repeat a device id — duplicates: ${devices.filter((id, i) => devices!.indexOf(id) !== i).join(', ')}`,
      );
    }
    if (!metrics.some(metric => metric.source === 'device')) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "inputs.devices" scopes the DEVICE input lane — declare at least one metric with source "device" alongside it (a device scope without a device metric reads nothing)',
      );
    }
  }

  if (kind === 'zone-query' && !metrics.some(metric => metric.source === 'zone')) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'kind "zone-query" requires at least one metric with source "zone"',
    );
  }
  if (kind === 'device-aggregate' && !metrics.some(metric => metric.source === 'device')) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'kind "device-aggregate" requires at least one metric with source "device"',
    );
  }

  let excludes: string[] | undefined;
  if (raw.excludes !== undefined) {
    if (!Array.isArray(raw.excludes) || raw.excludes.length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "excludes" must be a non-empty array of privacy declarations (or omitted)',
      );
    }
    excludes = raw.excludes.map((entry, index) => nonEmptyString(entry, `excludes[${index}]`));
  }

  let schemaVersion = 1;
  if (raw.schemaVersion !== undefined) {
    if (
      typeof raw.schemaVersion !== 'number' ||
      !Number.isInteger(raw.schemaVersion) ||
      raw.schemaVersion < 1
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "schemaVersion" must be an integer >= 1 (increment on breaking data changes)',
      );
    }
    schemaVersion = raw.schemaVersion;
  }

  return {
    spec: {
      kind: kind as ComputationKind,
      refreshSec,
      zones,
      metrics,
      ...(devices !== undefined ? { devices } : {}),
      ...(excludes !== undefined ? { excludes } : {}),
    },
    asNames,
    schemaVersion,
    warnings: specWarnings,
  };
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

function aggregateNumbers(values: number[], fn: ZoneFn | 'avg' | 'min' | 'max'): number | null {
  if (values.length === 0) return null;
  switch (fn) {
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'sum':
      return values.reduce((sum, value) => sum + value, 0);
  }
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Evaluate a validated spec against gathered inputs. Total (never throws for
 * absent data): a metric whose inputs have no usable values yields null —
 * the field stays present in the frame with a visible null, it never
 * silently disappears (silent field dropping is the #1 usability trap).
 * Malformed stored specs (should be impossible — validated at registration)
 * throw and the read path meters the failure honestly.
 */
export function evaluateComputation(
  spec: ComputationSpec,
  inputs: ComputationInputs,
): ComputationResult {
  const selectedZones =
    spec.zones === '*'
      ? inputs.zones
      : inputs.zones.filter(zone => spec.zones.includes(zone.id));
  // Device inputs are caller-scoped to the provider's bound devices; a spec
  // that DECLARES `devices` (T-065) is filtered to that exact set HERE — the
  // one truth for the aggregate-privacy invariant: the frame (and its
  // inputsSummary) can never touch or count a device outside the declared
  // inputs, no matter which lane (pull recompute / cache / push) evaluates.
  const scopedDevices =
    spec.devices === undefined
      ? inputs.devices
      : inputs.devices.filter(device => spec.devices!.includes(device.id));
  const data: Record<string, number | null> = {};
  let eventsWindowed = 0;
  // T54: value metrics whose EVERY matching device lacks the metric path in
  // its written-set — the value came entirely from scenario initialState
  // placeholders (all devices' written sets must be KNOWN for the verdict;
  // any unknown device keeps the gate silent).
  const unwrittenFields: string[] = [];
  const zoneEcho: DeviceStateUnwrittenView['zoneEcho'] = [];

  for (const metric of spec.metrics) {
    if (metric.source === 'zone') {
      const values = selectedZones
        .map(zone => numeric(zone.parameters[metric.path]))
        .filter((value): value is number => value !== null);
      data[metric.as] = aggregateNumbers(values, metric.fn);
      continue;
    }
    if (metric.source === 'device') {
      const matching = scopedDevices.filter(device =>
        device.capabilities.includes(metric.capability),
      );
      if (metric.fn === 'count') {
        data[metric.as] = matching.length;
        continue;
      }
      if (metric.fn === 'countActive') {
        const key = metric.path ?? 'active';
        data[metric.as] = matching.filter(device => device.state[key] === true).length;
        continue;
      }
      const values = matching
        .map(device => numeric(device.state[metric.path as string]))
        .filter((value): value is number => value !== null);
      data[metric.as] = aggregateNumbers(values, metric.fn);
      // T54: a non-null value can still be a PLACEHOLDER — flag it when the
      // written-sets prove every matching device's path was never written.
      const statePath = metric.path as string;
      if (data[metric.as] !== null && inputs.writtenDeviceStatePaths !== undefined && matching.length > 0) {
        const allUnwritten = matching.every(device => {
          const written = inputs.writtenDeviceStatePaths?.[device.id];
          return written !== undefined && !written.includes(statePath);
        });
        if (allUnwritten) {
          unwrittenFields.push(metric.as);
          for (const zone of selectedZones) {
            const value = zone.parameters[statePath];
            if (typeof value === 'number' || typeof value === 'boolean') {
              zoneEcho.push({ field: metric.as, parameter: statePath, zoneId: zone.id, value });
              break; // one contrasting zone names the cross-face trap
            }
          }
        }
      }
      continue;
    }
    // event metric
    const cutoff = inputs.simTimeSec - metric.windowSec;
    const matched = inputs.events.filter(
      event => event.eventType === metric.eventType && event.simTimeSec >= cutoff,
    );
    eventsWindowed += matched.length;
    data[metric.as] = matched.length;
  }

  return {
    data,
    inputsSummary: {
      zones: selectedZones.length,
      devices: scopedDevices.length,
      eventsWindowed,
      ...(unwrittenFields.length > 0 ? { deviceStateUnwritten: { fields: unwrittenFields, zoneEcho } } : {}),
    },
  };
}
