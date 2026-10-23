/**
 * Agreements service layer — the shared pull-lane read delivery (R21-W1
 * extraction from routes/agreements.ts, pure move).
 */

import type { AgreementRoutesContext } from './context.js';
import {
  CONSUMPTION_TARGET_RETRY_AFTER_SEC,
  CONSUMPTION_TARGET_WAIT_LIMIT_MS,
  raceConsumptionTargeting,
  resolveConsumptionTargetForLaneWithNote,
} from './targeting.js';
import { usageToJson } from './view.js';
import {
  computationFieldNames,
  dataSchemaFieldNames,
  dataSchemaUnits,
  fieldsAbsentFromComputation,
  readWindowStartIso,
} from './terms.js';
import { unitOf } from '@active-collaboration/shared';
import {
  parseTerms,
  type AgreementRow,
  type UsageRecordRow,
} from '../db/agreement-store.js';
import type { ServiceInstanceRow, ServiceStore } from '../db/service-store.js';
import { ApiError } from '../errors.js';
// T83 (R9, u4-F1): the ghost-event-type read annotation speaks the SAME
// declaration-table oracle the inject lane and the register warning speak.
import { environmentToScenario } from '../environment-bridge.js';
import { evaluateDataFrameNow, type StoredDataFrame } from '../frame-evaluator.js';
import type { SimulationRecord } from '../simulation-registry.js';

/**
 * T97 (R15, u1-F1): does the cached frame answer THIS request's target sim?
 * The per-service cache row names its computing sim twice (the
 * `simulation_id` COLUMN and the frame's provenance) — both are checked with
 * the column as the canonical key and the provenance copy as the legacy-row
 * fallback. `undefined` (auto-targeting) never mismatches: the §7 fallback
 * is exactly the "no running sim" promise there. A null computing-sim on a
 * legacy row stays honest-unknown → treated as a match but never as a
 * same-sim claim (provenance still displays what the frame carries).
 */
function cachedFrameTargetsDifferentSim(
  cachedRow: { simulation_id: string | null },
  cachedFrame: StoredDataFrame,
  requestedSimulationId: string | undefined,
): boolean {
  if (requestedSimulationId === undefined) return false;
  const computedFrom = cachedRow.simulation_id ?? cachedFrame.provenance.simulationId ?? null;
  return computedFrom !== null && computedFrom !== requestedSimulationId;
}

/**
 * Evaluate a computation NOW against the target sim and overwrite the
 * service's frame cache. Extracted to frame-evaluator.ts in living-worlds
 * P1W (the session's freshness-deadline recompute must share the read lane's
 * exact evaluation); this thin adapter keeps the service call sites readable.
 */
export function evaluateFrameNow(
  ctx: AgreementRoutesContext,
  _agreement: AgreementRow,
  service: ServiceInstanceRow,
  computation: NonNullable<ReturnType<ServiceStore['computationOf']>>,
  record: SimulationRecord,
): StoredDataFrame {
  return evaluateDataFrameNow(
    { envStore: ctx.envStore, serviceStore: ctx.serviceStore, simEventTallies: ctx.simEventTallies },
    { service, computation, record },
  );
}

/**
 * The shared pull-lane delivery (POST /reads and GET /reads/latest).
 *
 * Enforcement order (§5.2, mirroring invoke): quota → targeting → freshness
 * → execution-level checks. Precondition rejections (quota 429, no sim AND
 * no cache 409, stale beyond minFreshnessSec 409, non-active 409) execute
 * and meter NOTHING; execution-level failures (computation unregistered,
 * terms field violations, evaluation errors) are metered outcome='failure'
 * and burn no quota.
 *
 * `mode`:
 * - 'recompute' (POST /reads): live evaluation when a sim is targetable; the
 *   cached frame is the honest fallback when no sim runs (§7) — served with
 *   cached:true and the age the consumer's terms judge.
 * - 'latest' (GET /reads/latest): cache-first and never refreshes over a
 *   valid cache row (the cheap path); a cold cache is filled once.
 */
export async function deliverRead(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  rawBody: Record<string, unknown>,
  mode: 'recompute' | 'latest',
) {
  // v60: a retired agreement's service ref is NULL — it lands in the same
  // 404 below as a deleted service (reads on a provider-less row are impossible).
  const service = agreement.service_id !== null
    ? ctx.serviceStore.getService(agreement.service_id)
    : undefined;
  if (!service) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${agreement.service_id}" no longer exists`);
  }
  const terms = parseTerms(agreement.terms_json);
  const readTerms = terms.read;
  // T35 (R3 u2-F-07, R102 discipline): an execution-level read failure meters
  // WITH the reason — the invoke lane (appendRefusalUsage / the metered
  // invoke row) and the reboot lane already name WHY on the usage row; the
  // read lane silently dropped it (u2's d931efb0 failure row had no
  // failureReason on any face). Same source text as the thrown ApiError.
  const meterRead = async (
    outcome: 'success' | 'failure',
    failureReason?: string,
  ): Promise<UsageRecordRow> => {
    const now = new Date().toISOString();
    return ctx.agreementStore.appendUsage({
      agreementId: agreement.id,
      envId: agreement.env_id,
      consumerAgentId: agreement.consumer_agent_id,
      providerAgentId: agreement.provider_agent_id,
      kind: 'read',
      action: null,
      quantity: 1,
      unit: terms.meteringUnit ?? 'reading',
      outcome,
      effectRef: null,
      ...(failureReason !== undefined ? { failureReason } : {}),
      origin: service.origin,
      startedAt: now,
      endedAt: now,
    });
  };

  // Body: optional simulationId + fields narrowing (validated, closed).
  if (rawBody.simulationId !== undefined &&
      (typeof rawBody.simulationId !== 'string' || rawBody.simulationId.length === 0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "simulationId" must be a non-empty string when provided');
  }
  const simulationId = rawBody.simulationId as string | undefined;
  if (rawBody.fields !== undefined) {
    if (!Array.isArray(rawBody.fields) || rawBody.fields.length === 0 ||
        rawBody.fields.some(field => typeof field !== 'string' || field.length === 0)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "fields" must be a non-empty array of dataSchema field names when provided',
      );
    }
  }
  const requestedFields = rawBody.fields as string[] | undefined;

  // Quota (§5.3): the read budget counts kind='read' rows only — a separate
  // budget from the invoke quota (T-307 by-kind generalization).
  if (readTerms?.quotaPerWindow !== undefined && readTerms?.windowSec !== undefined) {
    const current = ctx.agreementStore.countUsageSince(
      agreement.id,
      readWindowStartIso(terms, agreement),
      'read',
    );
    if (current >= readTerms.quotaPerWindow) {
      throw new ApiError(
        429,
        'QUOTA_EXCEEDED',
        `Agreement "${agreement.id}" read quota exceeded: ${current}/${readTerms.quotaPerWindow} ` +
        `reads in the current ${readTerms.windowSec}s window — retry after the window passes`,
        undefined,
        { quota: 'agreement_read_per_window', limit: readTerms.quotaPerWindow, current },
      );
    }
  }

  // Computation presence is an execution-level check (§5.2): revoked specs
  // leave a failure row (audit trail), never a silent fallback to cache.
  const computation = ctx.serviceStore.computationOf(service.id);
  if (computation === undefined) {
    const reason =
      `The computation behind service "${service.name}" was revoked by the provider — reads cannot be evaluated; ` +
      'the agreement itself is NOT terminated (that stays bilateral: POST /api/agreements/:id/terminate)';
    await meterRead('failure', reason);
    throw new ApiError(409, 'COMPUTATION_UNREGISTERED', reason);
  }

  // T132 (R20-F, u2-F1): legacy wildcard-in-array specs — the write-time
  // repair cannot reach rows already in the store (the `["*"]` shape used to
  // pass registration). The evaluator filters zones by LITERAL id, so such a
  // row selects ZERO zones and every value metric reads null — the generic
  // METRIC_NO_READING copy ("the selected zones lack the parameter") is
  // factually wrong for it (no zone was ever selected). Name the real cause
  // and the re-registration path instead. The read refuses honestly (no zone
  // id was ever enumerated — there is nothing to read), metered as failure.
  const legacySpec = (() => {
    try {
      return JSON.parse(computation.spec_json) as {
        zones?: unknown;
        metrics?: Array<{ source?: unknown; as?: unknown; fn?: unknown }>;
      };
    } catch {
      return undefined; // unreadable spec — the evaluation lane owns that refusal
    }
  })();
  if (
    legacySpec !== undefined &&
    Array.isArray(legacySpec.zones) &&
    legacySpec.zones.some(entry => typeof entry === 'string' && entry.trim() === '*')
  ) {
    // Only the ZONE-source VALUE metrics die with an empty zone selection
    // (device metrics filter devices, counts cannot be null) — the `fields`
    // detail names exactly the fields the wildcard poisoned.
    const legacyNoReadingFields = (legacySpec.metrics ?? [])
      .filter(metric =>
        metric !== null && typeof metric === 'object' &&
        metric.source === 'zone' && typeof metric.as === 'string' &&
        (metric.fn === 'avg' || metric.fn === 'min' || metric.fn === 'max' || metric.fn === 'sum'))
      .map(metric => metric.as as string);
    const reason =
      `The spec behind service "${service.name}" lists a wildcard "*" inside its inputs.zones ARRAY — ` +
      'that form is no longer accepted (it silently matched zero zones, which is why every read came ' +
      'back with no reading). Register the wildcard as the BARE string "*" (inputs.zones = "*" — every ' +
      'zone), or revoke and re-register with concrete zone ids enumerated in the array ' +
      '(`eaf env get --full` lists the world\'s zone ids; POST /api/services/:id/computation); ' +
      'the agreement itself is NOT terminated';
    await meterRead('failure', reason);
    throw new ApiError(409, 'COMPUTATION_METRIC_NO_READING', reason, undefined, {
      fields: legacyNoReadingFields,
    });
  }

  // T-407 (R19, FM-F02): read-field schema drift — an honest refusal over
  // fabricated data. When the agreement's terms.read.fields name fields the
  // CURRENT computation no longer produces (the provider re-registered with
  // renames), serving `field: null` for every renamed field is
  // indistinguishable from a legitimately-null value — the consumer had to
  // terminate + re-create blind. Refuse with the missing list + the current
  // schema_version + the action path (same spirit as DATA_STALE /
  // AGREEMENT_NOT_ACTIVE). Legitimately-null VALUES still serve — only
  // schema-absent NAMES drift.
    if (readTerms?.fields !== undefined) {
      const drifted = fieldsAbsentFromComputation(readTerms.fields, computation);
      if (drifted.length > 0) {
        const currentNames = [...computationFieldNames(computation)];
        // T57d (R6, u4-F6): the remedy names a path that EXISTS — an ACTIVE
        // agreement cannot counter (AGREEMENT_NOT_PROPOSED; renegotiation is
        // terminate + re-propose), so the old "counter" teaching contradicted
        // the lifecycle and sent users into a guaranteed second error.
        const reason =
          `The computation behind service "${service.name}" no longer produces the field(s) ` +
          `${drifted.map(f => `"${f}"`).join(', ')} that agreement "${agreement.id}" reads — the provider ` +
          `re-registered the spec (current schema_version ${computation.schema_version}; current fields: ` +
          `${currentNames.map(f => `"${f}"`).join(', ')}). Renegotiate onto the new names: ` +
          'POST /api/agreements/:id/terminate, then propose a fresh agreement with the updated ' +
          'terms.read.fields (POST /api/services/:id/agreements) — or ask the provider to restore the ' +
          'old field names; the agreement itself is NOT terminated by this refusal';
        await meterRead('failure', reason);
        throw new ApiError(
          409,
          'COMPUTATION_SCHEMA_DRIFT',
          reason,
          undefined,
          {
            missingFields: drifted,
            schemaVersion: computation.schema_version,
            currentFields: currentNames,
          },
        );
      }
    }

  // T-058b (design-consent-semantics.md §4.1): the consent door at READ
  // time. A HIDDEN service whose consumer's access grant expired or was
  // revoked refuses data delivery — metered as failure (audit trail), the
  // agreement itself is NOT silently terminated (same philosophy as the
  // computation revocation above: ending the contract stays bilateral).
  if (
    service.visibility === 'hidden' &&
    !ctx.serviceStore.hasActiveAccessGrant(service.id, agreement.consumer_owner_id)
  ) {
    const reason =
      `The access grant behind service "${service.name}" has expired or was revoked — ` +
      'reads are refused until the provider re-grants access ' +
      '(the request lane: POST /api/services/:id/access-requests); ' +
      'the agreement itself keeps its status (termination stays bilateral: POST /api/agreements/:id/terminate)';
    await meterRead('failure', reason);
    throw new ApiError(409, 'ACCESS_GRANT_REVOKED', reason);
  }

  // Targeting / cache fallback (§7). Living-worlds P1W: with no explicit
  // simulationId the read targets the env's authoritative world session
  // (created on demand, materialized to wall-now — the authoritative frame).
  const cachedRow = ctx.serviceStore.latestFrameOf(service.id);
  let frame: StoredDataFrame;
  let cached = false;
  let record: SimulationRecord | undefined;
  // T122 (R17-u3/R19-u4): the disclosure when the default lane rode (or fell
  // off) the environment's default-simulation binding — surfaced on the
  // response so no world answer arrives without its "which world" story.
  let defaultSimNote: string | undefined;
  if (mode === 'latest' && cachedRow !== undefined) {
    // T97 (R15, u1-F1): the cache is keyed per computing WORLD — an explicit
    // simulationId may only be answered by a frame computed from THAT sim
    // (the route passes no simulationId on the latest path today, but the
    // guard keeps the lane honest if query support ever lands).
    const cachedFrame = JSON.parse(cachedRow.frame_json) as StoredDataFrame;
    if (cachedFrameTargetsDifferentSim(cachedRow, cachedFrame, simulationId)) {
      throw new ApiError(
        409,
        'SIMULATION_NOT_RUNNING',
        `Simulation "${simulationId}" has no cached frame for service "${service.name}" — ` +
          `the latest cached frame was computed from sim "${cachedRow.simulation_id ?? cachedFrame.provenance.simulationId ?? '?'}"; ` +
          'target a running simulation to compute a fresh frame from it',
      );
    }
    cached = true; // the cheap path never recomputes over a valid cache row
    frame = cachedFrame;
  } else {
    try {
      // T129 (R21-F1): the read lane's honest targeting wait floor. The r21
      // outage's primary symptom was exactly this call — a read with no own
      // sim targets the authoritative world session, and the wake/catch-up
      // behind it held the caller past the public gateway's ~100s kill (a
      // bare 504; the read face had NO floor of its own). Past the floor:
      // 503 READ_TARGETING_PENDING + retryAfterSec + teaching. NOT metered
      // (a precondition rejection — reads only meter a delivered frame) and
      // NOT a §7 cache fallback (a pending world is not a missing world;
      // the read is safe to retry — it never double-executes). The raced
      // targeting keeps completing server-side.
      const targetWaitMs = ctx.consumptionTargetWaitMs ?? CONSUMPTION_TARGET_WAIT_LIMIT_MS;
      const resolved = await raceConsumptionTargeting(
        targetWaitMs,
        () => new ApiError(
          503,
          'READ_TARGETING_PENDING',
          `This read's world targeting is still pending — the environment's authoritative world ` +
            'session is being woken / caught up to wall-now (a world that fell behind keeps catching ' +
            `up server-side; nothing is truncated or skipped). This read has waited ` +
            `${Math.round(targetWaitMs / 1000)}s on the connection, this endpoint's honest wait floor ` +
            '(the gateway kills longer waits at ~100s with a bare 504). Nothing was metered (reads ' +
            'only meter a delivered frame) and a read is safe to retry in a moment — it never ' +
            'double-executes; if it keeps pending, inspect the world session with ' +
            '`eaf env session status <envId>` (GET /api/environments/<envId>). ' +
            '本次读取的世界定向仍在进行（权威 world session 唤醒/追平中；落后较多的世界会在服务端继续' +
            '追平，不会截断或跳变）——本端点的诚实等待下限已到，本次未计量；读取稍后重试即可' +
            '（读不会重复执行），持续挂起可用 `eaf env session status` 查看世界追平状态。',
          undefined,
          { retryAfterSec: CONSUMPTION_TARGET_RETRY_AFTER_SEC },
        ),
        () => resolveConsumptionTargetForLaneWithNote(
          ctx, agreement, agreement.consumer_owner_id, simulationId, 'data reads',
          // T51 (R5, u4-P1-1): the read targets the consumer's OWN RUNNING sim
          // when she has one (the world she is actually watching) and falls
          // back to the authoritative world session only when she does not —
          // a fresh reading of an idle 1x session behind her back is how
          // "power=0" contradicted the 500 W she saw on the snapshot.
          { preferSession: true, preferOwnRunningSim: true },
        ),
      );
      record = resolved.record;
      defaultSimNote = resolved.defaultSimNote;
      // P1W (§6.1 in-flight read pin): the world must not be demoted
      // mid-evaluation — a half-hibernated read is a half-fresh frame.
      const releasePin = record.envSession === true && ctx.worldSessions !== undefined
        ? await ctx.worldSessions.observe(agreement.env_id)
        : undefined;
      try {
        frame = evaluateFrameNow(ctx, agreement, service, computation, record);
      } finally {
        releasePin?.();
      }
    } catch (error) {
      if (
        cachedRow !== undefined &&
        error instanceof ApiError &&
        (error.code === 'SIMULATION_NOT_RUNNING' ||
          // CP-F04 (R15): in AUTO-TARGETING mode (no explicit simulationId)
          // a consumer with NO running sim of their own gets the cached
          // frame even when OTHER stakeholders' sims run — the shared
          // resolver's foreign-only 403 ("N running simulations, none
          // created by you") described the FRESH lane, but the consumer
          // cannot recompute either way, and §7's degradation promise is
          // "no running sim → latest cached frame (+ staleness labeling)".
          // An EXPLICIT foreign simulationId stays a hard 403 (the caller
          // asked for that sim specifically — actionable, no fallback).
          (error.code === 'FORBIDDEN' && simulationId === undefined))
      ) {
        // T97 (R15, u1-F1): the §7 cached fallback is per-WORLD. The cache
        // holds ONE latest frame per service — whichever sim computed it
        // last — so an EXPLICIT simulationId must only be answered by a
        // frame computed from THAT sim (u1: reads naming a teammate's
        // stopped sim were served the cache of her own sim / the world
        // session — even a 244s STALE frame — each metered success, exit 0;
        // the explicit target was never validated). When the cached frame
        // was computed from a different world, the honest targeting error
        // (409 SIMULATION_NOT_RUNNING / 404 NOT_FOUND) stands instead: a
        // wrong-world frame is not a degradation, it is wrong data.
        // Same-sim requests keep §7 (the frame came from exactly the world
        // asked for); AUTO-TARGETING keeps CP-F04 (any cached frame is the
        // no-running-sim fallback, with provenance + staleness labeling).
        const cachedFrame = JSON.parse(cachedRow.frame_json) as StoredDataFrame;
        if (cachedFrameTargetsDifferentSim(cachedRow, cachedFrame, simulationId)) {
          throw error;
        }
        // No running sim → the cached frame is the honest fallback (§7).
        cached = true;
        frame = cachedFrame;
      } else if (!(error instanceof ApiError)) {
        // Evaluation-level failure (input schema drift, unreadable stored
        // spec): metered as failure with the cause — never a fake frame.
        const reason =
          `Evaluating the computation of service "${service.name}" failed: ${(error as Error).message} — ` +
          'the provider should re-register the spec against the current world (POST /api/services/:id/computation)';
        await meterRead('failure', reason);
        throw new ApiError(422, 'COMPUTATION_EVALUATION_FAILED', reason);
      } else {
        // Other targeting errors (404 explicit-foreign 403 / AMBIGUOUS /
        // 400) are actionable by the caller — precondition rejections, no
        // fallback, no metering.
        throw error;
      }
    }
  }

  // Freshness (§6, enforced): a cached frame older than the consumer's
  // minFreshnessSec is refused — never silently faked as fresh. The cached
  // row's computed_at_wall COLUMN is the cache's canonical timestamp (the
  // JSON copy is provenance display); live frames use their own wall time.
  const computedAtSource = cached ? cachedRow!.computed_at_wall : frame.provenance.computedAtWall;

  // T46 (R4, u4-P2-3): the empty-binding honesty gate. A computation with
  // DEVICE inputs whose provider binding resolved to ZERO devices just saw
  // nothing of the world — the frame's count-metrics read 0 and value
  // metrics null, which a consumer reads as "power = 0 W" (u4's meter vs
  // snapshot 500 W). 0 is a plausible-looking FAKE number here; the read
  // refuses (metered failure, like the other execution-level refusals)
  // until the provider re-binds devices. Cached frames carry the same
  // inputsSummary, so the gate applies to the §7 fallback too.
  const specJson = JSON.parse(computation.spec_json) as {
    refreshSec?: unknown;
    metrics?: Array<{ source?: unknown; as?: unknown; path?: unknown; fn?: unknown; eventType?: unknown }>;
  };
  const specHasDeviceMetrics = (specJson.metrics ?? []).some(metric => metric?.source === 'device');
  // T83 (R9, u4-F1) + T85 (R10, u4-F1): which of the spec's event-metric
  // types does THIS world never declare? A ghost type reads 0 forever — the
  // generic "widen windowSec" advice is permanently useless for it, so the
  // read face must say "never produced" instead. Same oracle as the register
  // warning (environmentToScenario's declaration table); a bridgeless world
  // stays permissive (honest unknown — no fabricated verdict). Non-blocking:
  // the frame carries the annotation, the consumer's CLI renders it.
  //
  // T85 granularity: the classification is PER FIELD ({as, eventType} pairs,
  // not spec-level type sets) — the frame annotation is filtered to the
  // DELIVERED fields after field scoping resolves below, so a mixed
  // ghost+declared spec no longer mislabels a delivered declared field as a
  // ghost, and the types of metrics OUTSIDE the delivered scope never leak.
  const specEventMetrics = (specJson.metrics ?? [])
    .filter(metric =>
      metric !== null && typeof metric === 'object' &&
      metric.source === 'event' && typeof metric.as === 'string' &&
      typeof metric.eventType === 'string')
    .map(metric => ({ field: metric.as as string, eventType: metric.eventType as string }));
  let declaredEventTypes: string[] = [];
  let declaredTableReachable = false;
  if (specEventMetrics.length > 0) {
    try {
      const env = ctx.envStore.getEnvironment(agreement.env_id);
      if (env !== undefined) {
        const scenario = environmentToScenario(
          env,
          ctx.envStore.devicesOf(env.id),
          ctx.envStore.agentsOf(env.id),
        );
        declaredEventTypes = [...new Set(scenario.events.map(event => event.type))];
        declaredTableReachable = true;
      }
    } catch {
      // no declaration table reachable — nothing honest to claim (no ghost
      // verdicts, no declared-empty classification)
    }
  }
  if (specHasDeviceMetrics && frame.provenance.inputsSummary.devices === 0) {
    const reason =
      `The computation behind service "${service.name}" reads DEVICE inputs, but the provider agent's ` +
      `binding resolved to 0 devices in the target world — every value below would be a fabricated ` +
      `zero, not a reading. The provider must re-bind (or re-install) the devices this service reads ` +
      `(device churn — removals/re-installs — unlinks bindings); ` +
      'the agreement itself is NOT terminated';
    await meterRead('failure', reason);
    throw new ApiError(409, 'COMPUTATION_DEVICE_INPUTS_EMPTY', reason);
  }
  // T46: units keyed by OUTPUT field — a metric's unit is the platform unit
  // of its SOURCE path (a zone metric over `temperature` reads °C even when
  // the provider renames the output to "avgTemperature"); no path/declared
  // unit → null, never an invented unit.
  const unitByField: Record<string, string | null> = {};
  // T57c (R6, u4-F8): the dataSchema's DECLARED units — event metrics (no
  // source path) read their unit from the registration-time declaration
  // instead of being dropped to null.
  const declaredUnits = dataSchemaUnits(service);
  // T50: the fields whose metric is a VALUE aggregation (avg/min/max/sum
  // over zone parameters or device state paths) — the only fields that can
  // come back null from the evaluator, and the only nulls this gate refuses.
  const valueMetricFields = new Set<string>();
  // T51: whether the spec reads the EVENT window at all (an empty window on
  // an event-less spec is normal and needs no explanation).
  let specHasEventMetrics = false;
  for (const metric of specJson.metrics ?? []) {
    if (metric === null || typeof metric !== 'object') continue;
    if ((metric.source === 'zone' || metric.source === 'device') && typeof metric.as === 'string') {
      unitByField[metric.as] = unitOf(typeof metric.path === 'string' ? metric.path : '');
      if (metric.fn === 'avg' || metric.fn === 'min' || metric.fn === 'max' || metric.fn === 'sum') {
        valueMetricFields.add(metric.as);
      }
    } else if (typeof metric.as === 'string') {
      // T57c: event metrics carry the REGISTERED unit (declared unitless
      // strings stay as declared; undeclared stays null — never invented).
      unitByField[metric.as] = declaredUnits[metric.as] ?? null;
      if (metric.source === 'event') specHasEventMetrics = true;
    }
  }

  const computedAtMs = Date.parse(computedAtSource);
  const freshnessSec = Number.isFinite(computedAtMs)
    ? Math.max(0, Math.round((Date.now() - computedAtMs) / 1000))
    : 0;
  let refreshSec = 60;
  if (typeof specJson.refreshSec === 'number') {
    refreshSec = specJson.refreshSec;
  }
  const staleThreshold = readTerms?.minFreshnessSec ?? refreshSec;
  const stale = freshnessSec > staleThreshold;
  if (cached && readTerms?.minFreshnessSec !== undefined && freshnessSec > readTerms.minFreshnessSec) {
    throw new ApiError(
      409,
      'DATA_STALE',
      `The cached frame for service "${service.name}" is ${freshnessSec}s old — older than the agreed minFreshnessSec ${readTerms.minFreshnessSec}s. ` +
      'Start (or target) a running simulation to recompute: POST /api/simulations { environmentId }, then /start, and pass its id as body.simulationId',
      undefined,
      { freshnessSec, minFreshnessSec: readTerms.minFreshnessSec },
    );
  }

  // Field scoping (§6, enforced): the delivered frame is filtered to the
  // agreed subset server-side; a request naming unagreed fields is a 422
  // (the consumer cannot widen the clause — action.command semantics).
  const schemaFields = dataSchemaFieldNames(service);
  const allowedFields = readTerms?.fields ?? (schemaFields.length > 0 ? schemaFields : Object.keys(frame.data));
  if (requestedFields !== undefined) {
    const outside = requestedFields.filter(field => !allowedFields.includes(field));
    if (outside.length > 0) {
      const reason =
        `Agreement "${agreement.id}" read terms allow only ${allowedFields.map(f => `"${f}"`).join(', ')} — ` +
        `the requested field(s) ${outside.map(f => `"${f}"`).join(', ')} are outside the negotiated scope`;
      await meterRead('failure', reason);
      throw new ApiError(
        422,
        'AGREEMENT_TERMS_VIOLATION',
        reason,
        undefined,
        { allowedFields, requestedFields },
      );
    }
  }
  const deliveredFields = requestedFields ?? allowedFields;
  // T85 (R10, u4-F1): per-field ghost classification over the DELIVERED
  // scope only. `ghostEventFields` = delivered fields whose event metric's
  // type this world never declared (the T83 annotation rides exactly these);
  // `declaredEmptyEventFields` = delivered event fields of DECLARED types —
  // on a mixed ghost+declared delivery they keep the T57a "plain empty
  // window" advice instead of being swallowed by the ghost copy. Both are
  // undefined when the declaration table was unreachable (honest unknown).
  const deliveredEventMetrics = specEventMetrics.filter(metric =>
    deliveredFields.includes(metric.field));
  const ghostEventMetrics = declaredTableReachable
    ? deliveredEventMetrics.filter(metric => !declaredEventTypes.includes(metric.eventType))
    : [];
  const declaredEmptyEventFields = declaredTableReachable
    ? deliveredEventMetrics
        .filter(metric => !ghostEventMetrics.includes(metric))
        .map(metric => metric.field)
    : [];
  const ghostEventTypes = [...new Set(ghostEventMetrics.map(metric => metric.eventType))];
  const data: Record<string, number | null> = {};
  for (const field of deliveredFields) {
    // Fields absent from the frame (schema drift, provider renaming) stay
    // visibly absent — never silently dropped.
    data[field] = frame.data[field] ?? null;
  }

  // T50 (R5, u2-F1): the null-reading honesty gate — the sibling of the
  // empty-binding gate above. A binding that resolved to devices is not
  // enough: when a VALUE metric (avg/min/max/sum over zone parameters or
  // device state paths) has NO usable value — the device's capability was
  // re-declared away, the state key no longer exists, the selected zones
  // lack the parameter — the field is null, and `null` metered as a
  // successful delivery is the same lie as a fabricated zero (u2: "成功
  // 交付的空读数" in the billing ledger). The read refuses (metered
  // failure, failureReason named) until the provider re-declares the
  // capability or re-registers the spec; cached frames carry the same
  // data, so the gate applies to the §7 fallback too.
  const noReadingFields = deliveredFields.filter(
    field => data[field] === null && valueMetricFields.has(field),
  );
  if (noReadingFields.length > 0) {
    const reason =
      `The computation behind service "${service.name}" produced NO reading for ` +
      `${noReadingFields.map(f => `"${f}"`).join(', ')}: the bound inputs exist but none currently ` +
      `provides a usable value (a capability was re-declared away, the device state key is gone, ` +
      `or the selected zones lack the parameter) — every value below would be an empty delivery, ` +
      `not a reading. The provider must re-declare the capability on the device or re-register the ` +
      `spec (POST /api/services/:id/computation); the agreement itself is NOT terminated`;
    await meterRead('failure', reason);
    throw new ApiError(409, 'COMPUTATION_METRIC_NO_READING', reason, undefined, {
      fields: noReadingFields,
    });
  }

  // T54 (R6, u4-F1): the never-written-state gate — the third sibling. A
  // binding that resolved to devices AND a value metric that produced a
  // number is still not enough: when the number came straight off scenario
  // initialState (the device's state paths were NEVER written in this world
  // — no command, no tick write-back, no physics effect), it is a
  // placeholder, not a measurement. u4's meter: device state held the
  // initialized `power: 0` while the ZONE parameter face said 500 W — a
  // "successful" delivery of a fabricated 0 metered against the agreement.
  // The frame's provenance carries the evaluator's never-written verdict
  // (same oracle on the §7 cached fallback); frames computed before this
  // gate existed carry no verdict and stay silent (honest-unknown). Cached
  // frames carry the same face, so the gate applies there too.
  const unwritten = frame.provenance.inputsSummary.deviceStateUnwritten;
  if (unwritten !== undefined && unwritten.fields.length > 0) {
    const hitFields = deliveredFields.filter(field => unwritten.fields.includes(field));
    if (hitFields.length > 0) {
      const echo = unwritten.zoneEcho.filter(entry => hitFields.includes(entry.field));
      const echoText = echo.length > 0
        ? ` Cross-face contrast: the ZONE parameter face carries the same name — ${echo
            .map(entry => `\`${entry.parameter}\` = ${entry.value} (zone "${entry.zoneId}")`)
            .join(', ')} — which is the reading this world actually maintains; the device-state face was never written.`
        : '';
      const reason =
        `The computation behind service "${service.name}" delivered ${hitFields.map(f => `"${f}"`).join(', ')} ` +
        `from DEVICE state that this world has NEVER written — the value is a scenario-initialization ` +
        `placeholder, not a measurement (no command, tick write-back, or physics effect has ever updated ` +
        `that state path in this simulation).${echoText} ` +
        `Remedy: point the metric at the zone parameter (re-register the spec with a source:"zone" metric: ` +
        `POST /api/services/:id/computation) or make the device's physics write the state path; ` +
        'the agreement itself is NOT terminated';
      await meterRead('failure', reason);
      throw new ApiError(409, 'COMPUTATION_DEVICE_STATE_UNWRITTEN', reason, undefined, {
        fields: hitFields,
        ...(echo.length > 0 ? { zoneEcho: echo } : {}),
      });
    }
  }

  const usage = await meterRead('success');
  const receipt = await ctx.settlement.settle({
    agreementId: agreement.id,
    envId: agreement.env_id,
    terms,
    usageRecords: [usage],
  });

  return {
    agreementId: agreement.id,
    // T68c (R7, u2): a cached delivery (the --latest cheap path, or the §7
    // fallback) has no TARGETED sim — the top-level simulationId used to go
    // honestly-null there while the human face still read "cached, computed
    // from sim X" off the provenance (u2: --json 溯源丢 simulationId). The
    // frame's COMPUTING sim now rides the top level too, so the json face is
    // never less traceable than the human one (R102); `cached: true` keeps
    // naming the mode, so targeted-fresh vs cached-at-a-glance stays distinct.
    simulationId: record?.id ?? frame.provenance.simulationId ?? null,
    // T122: the default-binding disclosure — present only when the world
    // choice involved the environment's default simulation (bound + honored,
    // or bound + stale + fell back). R102: the human face renders it too.
    ...(defaultSimNote !== undefined ? { defaultSimNote } : {}),
    frame: {
      kind: 'data' as const,
      agreementId: agreement.id,
      serviceId: service.id,
      schemaVersion: frame.schemaVersion,
      data,
      // T46 (u4): the read's METADATA face — the platform unit per field
      // (traced through the metric's source path; null = no declared unit,
      // never an invented one) beside the provenance the frame already
      // carries (which sim, sim-time, how many devices/zones were read).
      units: Object.fromEntries(
        deliveredFields.map(field => [field, unitByField[field] ?? null]),
      ),
      provenance: {
        ...frame.provenance,
        // T57b (R6, u2-F-2-2): the cached frame keeps its computation-time
        // provenance — "which world computed this frame" is a computation
        // FACT (saveFrame stored it), and nulling it broke traceability and
        // contradicted the human face ("computed from sim X"). The TARGETED
        // sim stays on the top-level simulationId when one is targeted; on
        // the cached fallback the top level carries the computing sim
        // (T68c, R7) and the distinction lives in `cached: true`.
        cached,
      },
      // T57a (R6, u4-F2): the event window's CLOCK semantics — windowSec is
      // SIMULATED seconds, and under speed multipliers 600 sim-s can be a
      // handful of real seconds. The frame names its window and the source
      // sim's window rate so "no events in the window" can be judged
      // honestly (the CLI renders the ≈real-seconds conversion).
      ...(frame.eventWindowSec !== undefined ? { eventWindowSec: frame.eventWindowSec } : {}),
      ...(frame.effectiveSpeedPerSec !== undefined
        ? { effectiveSpeedPerSec: frame.effectiveSpeedPerSec }
        : {}),
      // T51 (R5, u4-P1-1): an EVENT-window spec that matched zero events
      // carries an explicit flag — the consumer's CLI renders "事件窗为空"
      // so a structurally-zero count is never read as a real 0 reading.
      emptyEventWindow: specHasEventMetrics && frame.provenance.inputsSummary.eventsWindowed === 0,
      // T83: the ghost annotation rides ONLY when the DELIVERED fields
      // reference undeclared types (T85: spec-level ghost metrics outside
      // the delivery neither trigger the copy nor leak their type names) —
      // no noise on honest empty windows.
      ...(ghostEventTypes.length > 0
        ? {
            undeclaredEventTypes: ghostEventTypes,
            declaredEventTypes,
            // T85: the delivered fields the ghost copy speaks for — the CLI
            // keeps the declared-but-empty siblings' T57a advice separate.
            ghostEventFields: [...new Set(ghostEventMetrics.map(metric => metric.field))],
          }
        : {}),
      // T85: on a mixed ghost+declared delivery the declared-but-empty
      // fields keep the T57a plain-window advice — the CLI renders it beside
      // (not instead of) the ghost copy. Rides only on a genuinely empty
      // window and a reachable declaration table.
      ...(specHasEventMetrics && frame.provenance.inputsSummary.eventsWindowed === 0 &&
            declaredEmptyEventFields.length > 0
        ? { declaredEmptyEventFields }
        : {}),
      freshnessSec,
      stale,
    },
    applied: {
      fields: deliveredFields,
      meteringUnit: terms.meteringUnit ?? 'reading',
      ...(readTerms?.retentionSec !== undefined ? { retentionSec: readTerms.retentionSec } : {}),
    },
    termsEnforced: readTerms !== undefined,
    usage: usageToJson(usage),
    receiptId: receipt?.id ?? null,
  };
}
