/**
 * Agreements service layer — backing-device + proposable-service
 * resolution (R21-W1 extraction from routes/agreements.ts, pure move).
 */

import type { AgreementRoutesContext } from './context.js';
import type { AgreementRow } from '../db/agreement-store.js';
import { parseJsonArray, type EnvironmentStore } from '../db/environment-store.js';
import {
  AGGREGATE_BACKING_REMEDY,
  canSeeService,
  evaluateAggregateBacking,
  actuationBackedDevices,
  aggregateRuleBackingView,
  type ServiceInstanceRow,
  type ServiceStore,
} from '../db/service-store.js';
import { executableCommandPath, type ScenarioDevice, type SemanticOfferRule } from '@active-collaboration/core';
import { isCapabilityExecutable } from '@active-collaboration/simulation';
import type { DeviceInstanceRow } from '../db/environment-store.js';
import { ApiError } from '../errors.js';
import { canReadEnvironment } from '../env-access.js';
// T84 (R10, u1-F3): the read-source writability face — the T54 oracle's
// pre-signing projection (same evaluator, no second judgment).
import type { ReadSourceWritabilityFace } from '../frame-evaluator.js';

/**
 * Load a service for proposing an agreement: same visibility boundary as
 * subscribing — the caller must read the environment AND see the offer;
 * invisible offers answer 404 exactly like unknown ids.
 */
export function getProposableServiceOrThrow(
  ctx: AgreementRoutesContext,
  id: string,
  userId: string,
): ServiceInstanceRow {
  const service = ctx.serviceStore.getService(id);
  const env = service ? ctx.envStore.getEnvironment(service.env_id) : undefined;
  const agent = service ? ctx.envStore.getAgent(service.provider_agent_id) : undefined;
  if (!service || !env || !agent) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
  }
  const role = ctx.envStore.roleOf(env.id, userId);
  const visible =
    canReadEnvironment(env, role) &&
    canSeeService(
      service.visibility,
      agent.owner_id,
      env,
      { userId, role },
      // T-058b: an unexpired provider grant opens hidden offers for
      // proposing — the grant is the door, this agreement the contract.
      // T-053: origin rides along for the derived demo-visibility mode.
      { accessGrant: ctx.serviceStore.hasActiveAccessGrant(service.id, userId), origin: service.origin },
    );
  if (!visible) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
  }
  return service;
}

/**
 * T62 (R6, u4-F5): the CATALOG-side signability summary — the signing gates'
 * exact judgments hoisted to the market faces so "can this be contracted?"
 * is visible at list/get time, not discovered at propose with a 409.
 * Read-only, never throws; undefined only for faces no gate speaks for
 * (flow offers are backed by the flow row, not by a device judgment).
 *
 * verdicts:
 * - 'backed'    — the signing gates will not refuse on backing: a pinned
 *   derived row, a single covering device (published), or a resolvable
 *   aggregate rule with actuation-backed devices;
 * - 'ambiguous' — MORE than one bound device covers the semantic type: the
 *   propose lane WILL 409 SERVICE_BACKING_AMBIGUOUS naming these devices;
 * - 'unbacked'  — nothing delivers: no covering device (published), or the
 *   aggregate rule is unresolvable / has no actuation-backed device (the
 *   409 SERVICE_NOT_BACKED class of assertAggregateDeliverable, u2-R7-5:
 *   the 12 aggregate rows used to carry NO signability at all — json and
 *   human both silent on "can I sign this?").
 *   T103 (R16, u2-#2): the SIGNING promise is origin-split — AGGREGATE
 *   unbacked is refused at propose (assertAggregateDeliverable); PUBLISHED
 *   unbacked is signable (T84: speculative agreements are legitimate) and
 *   refused at RUNTIME (invoke SERVICE_NOT_BACKED; a computation-backed
 *   read, the COMPUTATION_METRIC_NO_READING family). The wording says which.
 *
 * `reason` rides ambiguous AND unbacked — the refusal's own wording family,
 * so the catalog face and the 409 tell one story (R102).
 *
 * T84 (R10, u1-F3): a computation-backed service whose read source (DEVICE
 * state paths) the probed world has NEVER written is signable-but-unreadable
 * — reads from the probed world honestly 409 COMPUTATION_DEVICE_STATE_UNWRITTEN
 * with no pre-signing warning. The probe's verdict (frame-evaluator's
 * readSourceWritabilityOf — the T54 oracle itself) rides `readSource`, and
 * a clean 'backed' flips to 'ambiguous': the caution marking, not a propose
 * refusal (speculative agreements are legitimate — the consumer signs with
 * the expectation, the reason names the honest refusal + remedies).
 * T86 (R11, u1-F1): the probed world is the VIEWER's default read target
 * (same adjudication as the read lane) and `readSource.probedLane` names the
 * lane — the reason layers its promise accordingly instead of a blanket
 * "every read will refuse".
 */
export interface ServiceSignabilityView {
  verdict: 'backed' | 'ambiguous' | 'unbacked';
  /** Present on 'ambiguous': the propose-time 409 names these devices. */
  candidateDevices?: string[];
  /** Present on 'ambiguous'/'unbacked': the one-line reason (the gate's own wording). */
  reason?: string;
  /**
   * T84: the read-source writability face — present only when a live world
   * proved the computation's device-state read source never written. The
   * machine discriminates read-source ambiguity (propose proceeds; READS
   * refuse) from backing ambiguity (propose 409s) by this field's presence.
   */
  readSource?: ReadSourceWritabilityFace;
}

/**
 * The one-line read-source expectation (the 409's own wording family).
 *
 * T86 (R11, u1-F1): the promise is LAYERED by the probed lane — an own-sim
 * verdict must not claim the sim-less fallback refuses too. u1 was promised
 * "every read will honestly refuse" while her sim-less default read fell to
 * the authoritative world session and RETURNED the world's frozen
 * initialization value: the honest copy names what each lane does.
 *
 * T91 (R13, u2-F1): the world-session verdict now covers BOTH non-own-sim
 * viewer shapes (no targetable sim / SEVERAL — the default read asks for
 * disambiguation before any world is read), so the copy speaks "reads that
 * land on this session" instead of asserting one viewer roster shape.
 */
function readSourceNeverWrittenReason(service: ServiceInstanceRow, readSource: ReadSourceWritabilityFace): string {
  const fields = readSource.fields.map(field => `"${field}"`).join(', ');
  const lane =
    readSource.probedLane === 'world-session'
      ? `the authoritative world session "${readSource.simulationId}" has NEVER written — a read that lands ` +
        'on this session (the read lane\'s fallback world when you have NO targetable own sim; with several, ' +
        'the default read first asks you to disambiguate) will honestly refuse with ' +
        'COMPUTATION_DEVICE_STATE_UNWRITTEN (the scenario holds the paths as initialization placeholders only) '
      : `your running simulation "${readSource.simulationId}" has NEVER written — reads while your own sim ` +
        'runs will honestly refuse with COMPUTATION_DEVICE_STATE_UNWRITTEN ' +
        '(the scenario holds the paths as initialization placeholders only). Lane honesty: with NO own ' +
        'running sim the default read falls to the authoritative world session instead — a world this probe ' +
        "did not judge — where the same read can SUCCEED with the world's initialization value (a placeholder " +
        'that may stay frozen rather than refuse) ';
  return (
    `read 源从未被写：the computation behind "${service.name}" reads device state ` +
    `(${fields}) that ${lane}— Signing is NOT refused ` +
    '(speculative agreements are legitimate) — sign with that expectation. Remedies: re-register the ' +
    'metric against the zone parameter face (source:"zone", POST /api/services/:id/computation), ' +
    'or make the scenario / device physics actually write the state path, or re-bind a device whose ' +
    'world writes its state'
  );
}

export function serviceSignabilityOf(
  envStore: EnvironmentStore,
  service: ServiceInstanceRow,
  // T84: the pre-probed read-source verdict (undefined = nothing honest to
  // claim — no live world, no computation, oracle silent).
  readSource?: ReadSourceWritabilityFace,
): ServiceSignabilityView | undefined {
  const base = baseSignabilityOf(envStore, service);
  if (base === undefined || readSource === undefined || readSource.fields.length === 0) {
    return base;
  }
  // T84 overlay: the read-source fact rides every verdict it probed; a clean
  // 'backed' flips to 'ambiguous' (the caution marking — propose itself is
  // NOT refused) and the verdict-level reason speaks the read-source 409.
  const reason = readSourceNeverWrittenReason(service, readSource);
  return {
    ...base,
    ...(base.verdict === 'backed' ? { verdict: 'ambiguous' as const } : {}),
    ...(base.verdict === 'backed' ? { reason } : {}),
    readSource,
  };
}

/** The T62 backing judgment proper (before the T84 read-source overlay). */
function baseSignabilityOf(
  envStore: EnvironmentStore,
  service: ServiceInstanceRow,
): ServiceSignabilityView | undefined {
  // T68a (R7, u2-R7-5): aggregate offers sign through the RULE lane — the
  // same evaluateAggregateBacking judgment the signing gate
  // (assertAggregateDeliverable) and the invoke lane read. A rule-less or
  // actuation-less aggregate is exactly the 409 SERVICE_NOT_BACKED class →
  // unbacked with the gate's own reason. Never 'ambiguous': per-device
  // ambiguity is a category error on the rule lane (invoke resolves the
  // device per ACTION).
  if (service.origin === 'aggregate') {
    const evaluation = evaluateAggregateBacking(envStore, service);
    if (evaluation.rule === undefined) {
      return {
        verdict: 'unbacked',
        reason:
          `no semantic offer rule resolves for type "${service.semantic_type}" (neither a built-in rule ` +
          'nor one of this world\'s scenario-authored mapData.semanticOfferRules) — proposing will refuse ' +
          'with SERVICE_NOT_BACKED; the provider must re-declare the rule (or withdraw the offer)',
      };
    }
    if (evaluation.actuationDevices.length === 0) {
      return {
        verdict: 'unbacked',
        reason:
          `no bound device of the provider agent holds any of the offer rule's actuation capabilities ` +
          `(${evaluation.rule.actuates.join(', ')}) — proposing will refuse with SERVICE_NOT_BACKED. ` +
          AGGREGATE_BACKING_REMEDY,
      };
    }
    return { verdict: 'backed' };
  }
  if (service.origin === 'flow') return undefined;
  if (service.source_device_id !== null) return { verdict: 'backed' }; // derived → pinned
  const agent = envStore.getAgent(service.provider_agent_id);
  if (agent === undefined) return undefined;
  const candidates: string[] = [];
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = envStore.getDevice(deviceId);
    if (device && parseJsonArray<string>(device.capabilities_json).includes(service.semantic_type)) {
      candidates.push(device.name);
    }
  }
  if (candidates.length === 0) {
    // T68a (R7): the unbacked verdict now carries its reason too — "why can't
    // I sign this?" answers on the same face, not by proposing and reading
    // the 409.
    return {
      verdict: 'unbacked',
      reason:
        `no bound device of provider agent "${agent.name}" covers "${service.semantic_type}" — ` +
        'there is nothing to execute; every invoke will refuse with SERVICE_NOT_BACKED until a device ' +
        'holding the capability is bound (PATCH /api/agents/:id boundDeviceIds)',
    };
  }
  if (candidates.length > 1) {
    return {
      verdict: 'ambiguous',
      candidateDevices: candidates,
      reason:
        `resolves to ${candidates.length} backing devices of provider agent "${agent.name}" ` +
        `(${candidates.map(name => `"${name}"`).join(', ')}) — proposing an agreement will refuse ` +
        'with SERVICE_BACKING_AMBIGUOUS until the provider publishes per-device services or ' +
        'narrows its bindings',
    };
  }
  return { verdict: 'backed' };
}

/**
 * T-306 (EN-F07): a PUBLISHED service (source_device_id === null) whose provider agent has MORE THAN ONE bound device covering the semantic type
 * is an ambiguous contract — first-match resolution used to silently pick
 * an arbitrary device ("HVAC Setpoint-as-a-Service" landed on the plant-room
 * water heater; "turn-off" on the PV inverter). Consumers cannot target a
 * device (InvokeServiceBody deliberately has no deviceId), so ambiguity is
 * an ERROR, not a guess (T-201 philosophy). Derived services pin their
 * source device and are never ambiguous.
 */
export function assertBackingUnambiguous(
  ctx: Pick<AgreementRoutesContext, 'envStore'>,
  service: ServiceInstanceRow,
): void {
  if (service.source_device_id !== null) return; // derived → pinned
  // Mechanism D: flow-services are backed by a flow, not by a device
  // capability match — device ambiguity is a category error here.
  if (service.origin === 'flow') return;
  // R54: an aggregate offer is backed by its capability BUNDLE — the
  // per-device ambiguity check below is about a single semantic type
  // matching many devices, which does not apply; invoke resolves the
  // device per ACTION (resolveBackingDeviceForAction).
  if (service.origin === 'aggregate') return;
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  if (!agent) return;
  const candidates: string[] = [];
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = ctx.envStore.getDevice(deviceId);
    if (device && parseJsonArray<string>(device.capabilities_json).includes(service.semantic_type)) {
      candidates.push(device.name);
    }
  }
  if (candidates.length > 1) {
    throw new ApiError(
      409,
      'SERVICE_BACKING_AMBIGUOUS',
      `Service "${service.name}" resolves to more than one backing device of provider agent ` +
        `"${agent.name}": ${candidates.map(name => `"${name}"`).join(', ')} — ` +
        'publish per-device services (derived services pin their source device), ' +
        "or restrict the provider agent's bindings",
      undefined,
      { candidateDevices: candidates },
    );
  }
}

/**
 * The device the provider agent commands for an invoke (§3.2.1): the derived
 * service's source device, else the first bound device of the provider agent
 * whose capabilities back the service's semantic type. None → 409
 * SERVICE_NOT_BACKED (an unbacked offer is a legitimate listing, but it has
 * nothing to execute). T-306: ambiguity (more than one covering device) is
 * a 409 BEFORE the arbitrary first-match pick.
 */
/**
 * The offer rule an aggregate service was minted from, resolved against the
 * SAME merged table the mint side uses
 * (ServiceStore.syncAggregateOffers / importDeclaredServices merge the world's
 * scenario-authored rules over the built-ins). Resolving built-ins-only here
 * was the "可签不可调" root cause: a scenario-rule offer signed fine, then
 * every invoke 409'd "no longer matches a semantic offer rule".
 *
 * T31: delegates to the ONE judgment (evaluateAggregateBacking in
 * service-store.ts) shared with the catalog unbacked flag and the detail
 * view — no second rule resolution exists.
 */
export function offerRuleForAggregate(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): SemanticOfferRule | undefined {
  return evaluateAggregateBacking(ctx.envStore, service).rule;
}

/**
 * The aggregate offer's actuation backing: the bound devices of the provider
 * agent HOLDING at least one of the rule's actuation capabilities — the
 * invoke lane's byCapability condition (its 409 fires exactly when this list
 * is empty or the rule is unresolvable). An EMPTY list is the
 * signable-but-undeliverable class (e.g. minted from DECLARED capabilities
 * no bound device ever grounded) — the signing gate (signing-gates.ts)
 * refuses it at propose/counter/accept.
 *
 * T31: the device filter is the shared actuationBackedDevices helper.
 */
export function aggregateActuationBacking(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  rule: SemanticOfferRule,
): Array<{ deviceId: string; deviceName: string }> {
  return actuationBackedDevices(ctx.envStore, service.provider_agent_id, rule.actuates);
}

/**
 * T8 (R2 u2-F2): the aggregate offer's backing VIEW — the RULE lane, so the
 * detail face speaks the same judgment as the signing gates
 * (assertAggregateDeliverable) and the invoke lane
 * (resolveBackingDeviceForServiceAction) instead of the legacy literal
 * capability match that can never hit an aggregate's semantic type (the
 * false "unbacked offer" warning on backed aggregates). null = genuinely
 * unbacked (no resolvable rule OR no bound device holding an actuation
 * capability) — exactly the 409 SERVICE_NOT_BACKED class. `callableActions`
 * is the union of executable commands across the backing devices under the
 * rule's actuation capabilities — the exact action set the invoke lane
 * resolves (its byAction predicate over the same pairs).
 */
export function aggregateBackingView(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): {
  kind: 'rule';
  rule: string;
  actuates: string[];
  devices: Array<{ id: string; name: string }>;
  callableActions: string[];
} | null {
  // T31: delegates to the ONE catalog-side view (service-store.ts) — the
  // agreement detail and the service detail can no longer disagree.
  return aggregateRuleBackingView(ctx.envStore, service);
}

/**
 * R54: action-aware backing resolution. Aggregate offers carry no pinned
 * device — the invoked ACTION selects the backing: the provider's bound
 * device whose executable command surface under the offer's actuation
 * capabilities contains the action. Non-aggregate services keep the
 * action-blind legacy resolution (their backing is structural).
 */
export function resolveBackingDeviceForAction(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  action: string,
): string {
  const service =
    agreement.service_id !== null ? ctx.serviceStore.getService(agreement.service_id) : undefined;
  if (service === undefined || service.origin !== 'aggregate') {
    return resolveBackingDevice(ctx, agreement);
  }
  return resolveBackingDeviceForServiceAction(ctx, service, action);
}

/**
 * R55: the service-level variant the direct-invoke lane uses (no agreement
 * row exists there). Same semantics: the ACTION picks the bundle device.
 */
export function resolveBackingDeviceForServiceAction(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  action: string,
): string {
  if (service.origin !== 'aggregate') {
    if (service.source_device_id !== null) {
      const device = ctx.envStore.getDevice(service.source_device_id);
      if (device) return device.id;
    }
    // Non-agreement direct invoke on a published service: same capability
    // match as the agreement lane (the first bound device holding the type).
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    if (agent) {
      for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
        const device = ctx.envStore.getDevice(deviceId);
        if (device && parseJsonArray<string>(device.capabilities_json).includes(service.semantic_type)) {
          return device.id;
        }
      }
    }
    throw new ApiError(
      409,
      'SERVICE_NOT_BACKED',
      `Service "${service.name}" has no backing device — nothing to invoke`,
    );
  }
  const rule = offerRuleForAggregate(ctx, service);
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  if (rule === undefined || agent === undefined) {
    throw new ApiError(
      409,
      'SERVICE_NOT_BACKED',
      `Aggregate service "${service.name}" no longer matches a semantic offer rule — nothing to invoke`,
    );
  }
  const candidate = (predicate: (device: DeviceInstanceRow) => boolean): DeviceInstanceRow | undefined => {
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const device = ctx.envStore.getDevice(deviceId);
      if (device && predicate(device)) return device;
    }
    return undefined;
  };
  // 1) a device that can EXECUTE the invoked action under an actuation
  //    capability of the offer;
  const byAction = candidate(device =>
    rule.actuates.some(capability =>
      (executableCommandPath(asScenarioDeviceFor(device), capability, isCapabilityExecutable) ?? [])
        .includes(action)));
  if (byAction !== undefined) return byAction.id;
  // 2) fallback: the first device holding any actuation capability (the
  //    offer's own qualification guarantees at least one exists).
  const byCapability = candidate(device => {
    const caps = parseJsonArray<string>(device.capabilities_json);
    return rule.actuates.some(capability => caps.includes(capability));
  });
  if (byCapability !== undefined) return byCapability.id;
  throw new ApiError(
    409,
    'SERVICE_NOT_BACKED',
    `Aggregate service "${service.name}" has no bound device backing its actuation capabilities ` +
    `(${rule.actuates.join(', ')}) — nothing to invoke`,
  );
}

/** Minimal ScenarioDevice projection for the executable-path oracle. */
function asScenarioDeviceFor(device: DeviceInstanceRow): ScenarioDevice {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    capabilities: parseJsonArray<string>(device.capabilities_json),
    zoneId: device.zone_id,
  } as ScenarioDevice;
}

export function resolveBackingDevice(
  ctx: { envStore: EnvironmentStore; serviceStore: Pick<ServiceStore, 'getService'> },
  agreement: AgreementRow,
): string {
  // v60: a retired agreement has no service — it also never reaches the
  // invoke lanes (suspended/terminated), but the type no longer proves it.
  const service =
    agreement.service_id !== null ? ctx.serviceStore.getService(agreement.service_id) : undefined;
  if (service) {
    assertBackingUnambiguous(ctx, service);
    if (service.source_device_id !== null) {
      const device = ctx.envStore.getDevice(service.source_device_id);
      if (device) return device.id;
    }
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    if (agent) {
      for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
        const device = ctx.envStore.getDevice(deviceId);
        if (device && parseJsonArray<string>(device.capabilities_json).includes(service.semantic_type)) {
          return device.id;
        }
      }
    }
  }
  throw new ApiError(
    409,
    'SERVICE_NOT_BACKED',
    `Service "${agreement.service_id}" has no backing device — nothing to invoke`,
  );
}

/**
 * C4 (T-086, RT26-F05 — DevLoop R28): the PRE-FLIGHT stale-sim drift view.
 * The invoke-time 409 SERVICE_NOT_BACKED already names the device, but by
 * then the consumer has built and sent the request; this surfaces the same
 * fact on agreement DETAIL and ACCEPT — the backing device exists in the
 * environment yet is ABSENT from a running simulation the caller may target
 * (the frozen-world-predating-a-late-install shape). Undefined when the
 * device resolves in every targetable running sim, when there are no
 * running sims to check (nothing to warn about — the invoke will create or
 * demand one), or when the agreement has no backing device at all (unbacked
 * offers keep their propose-time gates).
 */
export interface BackingDeviceDriftView {
  deviceId: string;
  deviceName: string;
  /** Running sims the caller may target that lack the backing device. */
  absentFrom: Array<{ simulationId: string; state: string }>;
  note: string;
}

export function backingDeviceDriftOf(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  callerId: string,
): BackingDeviceDriftView | undefined {
  if (agreement.status !== 'active') return undefined; // only active agreements invoke
  let deviceId: string;
  try {
    deviceId = resolveBackingDevice(ctx, agreement);
  } catch {
    return undefined; // unbacked/ambiguous — the propose + invoke gates own those cases
  }
  const device = ctx.envStore.getDevice(deviceId);
  if (device === undefined) return undefined;
  const envRow = ctx.envStore.getEnvironment(agreement.env_id);
  const mayTarget = (sim: { createdBy?: string }): boolean =>
    sim.createdBy === undefined ||
    sim.createdBy === callerId ||
    sim.createdBy === envRow?.owner_id;
  const absentFrom = ctx.registry
    .runningAllForEnvironment(agreement.env_id)
    .filter(mayTarget)
    .filter(sim => !sim.runtime.getSnapshot().devices.some(entry => entry.id === deviceId))
    .map(sim => ({ simulationId: sim.id, state: sim.runtime.getState() }));
  if (absentFrom.length === 0) return undefined;
  return {
    deviceId,
    deviceName: device.name,
    absentFrom,
    note:
      `the backing device "${device.name}" is absent from ${absentFrom.length} running simulation(s) ` +
      `you may target — invocations against them will 409 SERVICE_NOT_BACKED. ` +
      'Restart a drifted sim (POST /api/simulations then /start) to rebuild it from the current ' +
      'environment, or invoke WITHOUT simulationId to run in the authoritative world session',
  };
}
