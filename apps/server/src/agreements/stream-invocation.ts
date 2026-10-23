/**
 * Agreements service layer — stream consumption sessions (R21-W1
 * extraction from routes/agreements.ts, pure move).
 *
 * The WebSocket session behind GET /api/agreements/:id/stream: both lanes
 * (device observation + computation data frames), the T-109 mid-stream
 * activity gate, the Wave-6 sim-stop close, the P1W observation pin and the
 * session metering tail. The route keeps only the upgrade-time
 * preconditions; everything after the socket opens lives here.
 */

import { EventType } from '@active-collaboration/core';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket } from 'ws';

import type { AgreementRoutesContext } from './context.js';
import { resolveBackingDevice } from './backing.js';
import { evaluateFrameNow } from './read-delivery.js';
import { resolveConsumptionTargetSimForLane } from './targeting.js';
import { fieldsAbsentFromComputation } from './terms.js';
import {
  parseTerms,
} from '../db/agreement-store.js';
import { parseJsonArray } from '../db/environment-store.js';
import type { ComputationSpec } from '../computation-evaluator.js';
import { ApiError } from '../errors.js';
import type { StoredDataFrame } from '../frame-evaluator.js';

/**
 * Fix-20: parse the stream's `?params=temperature,co2` filter — a set of
 * parameter names, or undefined when the query is absent (push every
 * change). Present-but-empty (or only separators) is a 400: a filter that
 * matches nothing is almost certainly a typo.
 */
export function parseStreamParamFilter(raw: unknown): Set<string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'Query "params" must be a comma-separated string');
  }
  const names = new Set(
    raw
      .split(',')
      .map(name => name.trim())
      .filter(name => name.length > 0),
  );
  if (names.size === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Query "params" must list at least one parameter name');
  }
  return names;
}

/** Parsed, validated inputs the route threads from the upgrade to the session. */
export interface AgreementStreamSessionArgs {
  agreementId: string;
  userId: string;
  simulationId: string | undefined;
  paramFilter: Set<string> | undefined;
  log: FastifyBaseLogger;
}

export async function runAgreementStreamSession(
  ctx: AgreementRoutesContext,
  socket: WebSocket,
  args: AgreementStreamSessionArgs,
): Promise<void> {
  // The upgrade-time preValidation proved all of these exist.
  const agreement = ctx.agreementStore.getAgreement(args.agreementId)!;
  const record = await resolveConsumptionTargetSimForLane(
    ctx, agreement, args.userId, args.simulationId, 'streams',
    { preferSession: (agreement.service_id !== null ? ctx.serviceStore.computationOf(agreement.service_id) : undefined) !== undefined },
  );
  const runtime = record.runtime;
  const service = agreement.service_id !== null
    ? ctx.serviceStore.getService(agreement.service_id)
    : undefined;
  const computation = agreement.service_id !== null
    ? ctx.serviceStore.computationOf(agreement.service_id)
    : undefined;

  const startedAt = new Date().toISOString();
  let pushed = 0;
  // T-109: set when a mid-stream status check found the agreement no
  // longer active — the session then meters a non-success outcome.
  let inactiveStatus: string | null = null;
  const send = (message: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message), error => {
      if (error) args.log.warn({ err: error }, 'agreement stream send failed');
    });
  };
  // Wave-6: register the session so a simulation stop closes it actively
  // (close frame → cleanup below meters it) instead of ping/ponging on.
  ctx.streamSessions.track(record.id, socket);
  // Living-worlds P1W (§6.1 observation pin): a stream targeting the
  // authoritative world session keeps it ACTIVE — the last disconnect
  // may demote. The pin survives session rebuilds (identity-keyed).
  // T-405 (R19, CC-F03): acquisition is asynchronous — a socket that
  // closes BEFORE the observe() resolves must not leak the pin (a leak
  // pins the world ACTIVE forever); a late resolve releases straight
  // away instead of assigning a release nobody will call.
  let releaseSessionPin: (() => void) | undefined;
  let sessionPinWanted = false;
  if (record.envSession === true && ctx.worldSessions !== undefined) {
    sessionPinWanted = true;
    void ctx.worldSessions.observe(agreement.env_id).then(release => {
      if (!sessionPinWanted) {
        try {
          release();
        } catch {
          // Best-effort — the world-session service tolerates it.
        }
        return;
      }
      releaseSessionPin = release;
    });
  }

  // T-109 helper shared by both lanes: the upgrade-time gate only covers
  // CONNECT — suspend/terminate must also stop an ESTABLISHED socket.
  const stillActive = (): boolean => {
    const status = ctx.agreementStore.getAgreement(agreement.id)?.status ?? 'unknown';
    if (status === 'active') return true;
    inactiveStatus = status;
    send({ kind: 'closed', agreementId: agreement.id, reason: `agreement ${status}` });
    socket.close(1008, `agreement ${status}`);
    return false;
  };

  const unsubscribers: Array<() => void> = [];

  if (computation !== undefined && service !== undefined) {
    // -------------------------------------------------------------------
    // R14 Wave-A data lane: recompute the ComputationSpec when its
    // inputs change and push DataFrames (§3.1 push). Triggers:
    // DEVICE_STATE_CHANGE of the provider's bound devices +
    // ENVIRONMENT_PARAM_CHANGED on the spec's zones (injections/zone
    // writes). Pure physics drift emits no bus event per tick — Phase 1
    // has no resident scheduler (refreshSec is cache/TTL semantics only),
    // so a zone-metric frame moves on injections and device changes.
    // -------------------------------------------------------------------
    const terms = parseTerms(agreement.terms_json);
    const readTerms = terms.read;
    const spec = JSON.parse(computation.spec_json) as ComputationSpec;
    const boundDeviceIds = new Set<string>(
      ctx.envStore.getAgent(service.provider_agent_id) === undefined
        ? []
        : parseJsonArray<string>(
            ctx.envStore.getAgent(service.provider_agent_id)!.bound_device_ids_json,
          ),
    );
    const specZones = spec.zones === '*' ? null : new Set(spec.zones);
    // T-065 (R16): a spec that declares inputs.devices wakes only on
    // THOSE devices — the other resident's watch changing state must not
    // trigger a per-bed computation (and its data never enters the frame:
    // evaluateFrameNow runs the evaluator's scope filter).
    const triggerDeviceIds = spec.devices === undefined ? boundDeviceIds : new Set(spec.devices);

    send({
      kind: 'subscribed',
      agreementId: agreement.id,
      simulationId: record.id,
      deviceId: null,
      semanticType: service.semantic_type,
      computation: {
        kind: computation.kind,
        refreshSec: typeof spec.refreshSec === 'number' ? spec.refreshSec : 60,
        schemaVersion: computation.schema_version,
      },
    });

    // Best-effort cadence throttle (§6, declarative): skip recompute
    // pushes closer than cadenceSec of the last TRIGGER-driven push,
    // SIM-CLOCK anchored. T-405 (R19, CC-F03): cadenceSec throttles
    // BURSTS — it never swallows an ISOLATED trigger. The connect-time
    // frame is a snapshot, not a trigger response, so it does NOT
    // anchor the cadence clock (anchoring it made the ONLY trigger in
    // the window land "within cadence" of the initial push and the
    // stream went silent forever). Skips are visible at debug level.
    let lastPushSimTime: number | null = null;
    const pushFrame = (initial = false): void => {
      if (!stillActive()) return;
      // §7: computation revoked mid-stream — close with a reason, metered
      // as the session ends (the socket close fires cleanup below).
      const currentComputation = agreement.service_id !== null
        ? ctx.serviceStore.computationOf(agreement.service_id)
        : undefined;
      if (currentComputation === undefined) {
        send({
          kind: 'closed',
          agreementId: agreement.id,
          reason: 'computation unregistered',
        });
        socket.close(1001, 'computation unregistered');
        return;
      }
      const simTimeSec = runtime.getSimTimeSec();
      if (
        !initial &&
        readTerms?.cadenceSec !== undefined &&
        lastPushSimTime !== null &&
        simTimeSec - lastPushSimTime < readTerms.cadenceSec
      ) {
        args.log.debug(
          {
            agreementId: agreement.id,
            simTimeSec,
            lastPushSimTime,
            cadenceSec: readTerms?.cadenceSec,
          },
          'agreement stream push throttled by cadence (burst skip; isolated triggers still pass)',
        );
        return;
      }
      // T-407 (R19, FM-F02): read-field schema drift — the agreement's
      // terms.read.fields name fields the CURRENT computation no longer
      // produces (provider re-registered with renames). Serving
      // plausible nulls is fabrication; close with a teaching reason
      // (mirrors the computation-unregistered handling; the socket
      // close meters the session end).
      if (readTerms?.fields !== undefined) {
        const drifted = fieldsAbsentFromComputation(readTerms.fields, currentComputation);
        if (drifted.length > 0) {
          send({
            kind: 'closed',
            agreementId: agreement.id,
            reason: 'read fields drifted',
            missingFields: drifted,
            schemaVersion: currentComputation.schema_version,
          });
          socket.close(1001, 'read fields drifted');
          return;
        }
      }
      let frame: StoredDataFrame;
      try {
        frame = evaluateFrameNow(ctx, agreement, service, currentComputation, record);
      } catch (error) {
        args.log.warn(
          { err: error },
          'agreement data stream evaluation failed (frame skipped, session stays open)',
        );
        return;
      }
      // Field scoping: the push lane delivers the same subset the pull
      // lane would (terms.read.fields; absent = everything computed).
      const allowed = readTerms?.fields ?? Object.keys(frame.data);
      const data: Record<string, number | null> = {};
      for (const field of allowed) data[field] = frame.data[field] ?? null;
      // T-405: only TRIGGER-driven pushes anchor the cadence clock.
      if (!initial) lastPushSimTime = simTimeSec;
      pushed += 1;
      send({
        kind: 'data',
        agreementId: agreement.id,
        serviceId: service.id,
        schemaVersion: frame.schemaVersion,
        data,
        provenance: { ...frame.provenance, cached: false },
        freshnessSec: 0,
        stale: false,
        ...(readTerms?.retentionSec !== undefined ? { retentionSec: readTerms.retentionSec } : {}),
      });
    };

    // One frame immediately (the stream is useful from the first tick),
    // then on every matching input change. Triggers:
    // - DEVICE_STATE_CHANGE on the bus for the provider's bound devices
    //   (device metric inputs; emitterId = device id);
    // - runtime.onInjectedEvent for zone-scoped injections — injections
    //   are ROUTED to managing agents and never ride the bus (the same
    //   reason the countSince tally hooks the listener). Listener order
    //   guarantees the tally already contains the event when the
    //   recompute reads its window (the tally attaches at sim creation).
    // T-405: the initial frame is passed `initial: true` — a snapshot
    // that does NOT anchor the cadence clock (see pushFrame).
    pushFrame(true);
    unsubscribers.push(
      runtime.subscribe(event => {
        const payload = event.payload as { emitterId?: unknown } | undefined;
        if (!payload || typeof payload.emitterId !== 'string' || !triggerDeviceIds.has(payload.emitterId)) return;
        pushFrame();
      }, EventType.DEVICE_STATE_CHANGE),
      runtime.onInjectedEvent(injected => {
        if (specZones !== null && !specZones.has(injected.zoneId)) return;
        pushFrame();
      }),
      runtime.subscribe(event => {
        const payload = event.payload as { zoneId?: unknown } | undefined;
        if (!payload) return;
        if (specZones !== null && !specZones.has(String(payload.zoneId))) return;
        pushFrame();
      }, EventType.ENVIRONMENT_PARAM_CHANGED),
    );
  } else {
    // -------------------------------------------------------------------
    // Device observation lane (§3.2.2, Phase 2) — unchanged behavior.
    // -------------------------------------------------------------------
    const deviceId = resolveBackingDevice(ctx, agreement);
    // Fix-20: parameter-level filter — only frames where one of the listed
    // parameters actually changed are pushed (absent = every change).
    const paramFilter = args.paramFilter;

    // Hello frame: what this stream is scoped to.
    send({
      kind: 'subscribed',
      agreementId: agreement.id,
      simulationId: record.id,
      deviceId,
      semanticType: service?.semantic_type ?? null,
      ...(paramFilter !== undefined ? { params: [...paramFilter] } : {}),
    });

    // Observation changes of the PROVIDER's backing device, filtered by
    // this agreement. Device-emitted DEVICE_STATE_CHANGE carries
    // emitterId = device id (metadata.deviceId too); data-source events
    // without a device id never match.
    unsubscribers.push(
      runtime.subscribe(event => {
        const payload = event.payload as {
          emitterId?: unknown;
          oldState?: unknown;
          newState?: unknown;
          changedParameters?: unknown;
        } | undefined;
        if (!payload || payload.emitterId !== deviceId) return;
        const changed = Array.isArray(payload.changedParameters) ? payload.changedParameters : [];
        if (
          paramFilter !== undefined &&
          !changed.some(param => typeof param === 'string' && paramFilter.has(param))
        ) {
          return;
        }
        // T-109: cheap indexed get, only on frames that would otherwise push.
        if (!stillActive()) return;
        pushed += 1;
        send({
          kind: 'observation',
          agreementId: agreement.id,
          deviceId,
          changedParameters: changed,
          state: payload.newState ?? null,
          simTimeSec: runtime.getSimTimeSec(),
        });
      }, EventType.DEVICE_STATE_CHANGE),
    );
  }

  // Metering (§3.3): ONE UsageRecord per stream session, quantity = the
  // pushed message count — appended when the socket closes, for whatever
  // reason it closed. The data lane meters the same way (kind='stream',
  // quantity = pushed frames, unit='message') — push consumption reuses
  // the existing stream metering (design §5).
  //
  // Heartbeat (Fix-15, F-21): a killed CLI does not always close the TCP
  // socket (e.g. the npx/tsx wrapper dies but the orphaned node child
  // keeps the connection open) — no FIN/RST ever arrives, so 'close'
  // never fires and the session would go unmetered. Ping on a cadence;
  // one missed pong terminates the socket, which fires 'close' below.
  let pongReceived = true;
  socket.on('pong', () => {
    pongReceived = true;
  });
  const heartbeat = setInterval(() => {
    if (!pongReceived) {
      socket.terminate();
      return;
    }
    pongReceived = false;
    socket.ping();
  }, ctx.streamHeartbeatMs);
  heartbeat.unref();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    ctx.streamSessions.release(record.id, socket);
    // T-405: a pin that resolves AFTER this point must release on the
    // spot (no leak) — flip the wanted flag before releasing any pin
    // we already hold.
    sessionPinWanted = false;
    try {
      releaseSessionPin?.();
    } catch {
      // A pin release must never break metering.
    }
    // Meter even when an unsubscribe half fails (runtime already
    // stopped) — the usage record is the session's evidence of consumption.
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        args.log.warn({ err: error }, 'agreement stream unsubscribe failed');
      }
    }
    try {
      ctx.agreementStore.appendUsage({
        agreementId: agreement.id,
        envId: agreement.env_id,
        consumerAgentId: agreement.consumer_agent_id,
        providerAgentId: agreement.provider_agent_id,
        kind: 'stream',
        quantity: pushed,
        unit: 'message',
        // T-109: a session the agreement ended mid-stream (suspended/
        // terminated) is metered as a failure, not a clean consumption.
        outcome: inactiveStatus !== null ? 'failure' : 'success',
        origin: (agreement.service_id !== null ? ctx.serviceStore.getService(agreement.service_id) : undefined)?.origin ?? null,
        startedAt,
        endedAt: new Date().toISOString(),
      });
    } catch (error) {
      args.log.warn({ err: error }, 'agreement stream usage append failed');
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
