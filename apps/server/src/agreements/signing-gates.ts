/**
 * Agreements service layer — signing-time deliverability gates
 * (R6-B-F01 / R6-C-F02, the T-310 earliest-boundary principle carried to the
 * contract drafting entries: propose, counter, accept).
 *
 * Two boundaries, one promise. The SIGNING gates below check the world AS
 * CONTRACTED and refuse before the agreement ever enters `active` (a refusal
 * lands no row and no state — the lifecycle state machine is unchanged).
 * Runtime drift AFTER signing (device unbound, backing device absent from
 * the targeted sim, flow disabled) stays with the INVOKE-lane gates (409
 * SERVICE_NOT_BACKED / FLOW_NOT_RUNNABLE / 422 DEVICE_COMMAND_NOT_EXECUTABLE)
 * — they re-check the world AS EXECUTED. Neither boundary alone is
 * sufficient; both speak the same error codes.
 *
 * - assertAggregateDeliverable (R6-B-F01): an aggregate offer whose backing
 *   (the provider's bound devices holding the offer rule's actuation
 *   capabilities) is EMPTY used to sign fine and 409 SERVICE_NOT_BACKED only
 *   at invoke ("可签不可调" — the AC ephemeral lane delivered the same service
 *   while the explicit contract could not). The SAME judgment the invoke
 *   lane makes, hoisted to signing, with the remedy named.
 * - assertZoneReachable (R6-C-F02): an explicit agreement that declares the
 *   zone its action must physically act on (terms.targetZoneId) is refused
 *   when the provider service's backing devices can never reach it — same
 *   zone is direct, declared zone adjacency is the SpatialField propagation
 *   lane, anything else is 422 SERVICE_ZONE_UNREACHABLE. Contracts without
 *   a zone claim (pure data services, informational triggers — including
 *   trigger.zoneId, which scopes the watched EVENT, not the effect) are
 *   untouched. Exemptions: terms.delivery='propagation' (system-level
 *   delivery such as central HVAC, declared by the contracting parties) and
 *   mapData governance.contractReachabilityCheck=false (env-wide demo
 *   escape hatch; default ON).
 */

import type { AgreementRoutesContext } from './context.js';
import { aggregateActuationBacking, offerRuleForAggregate } from './backing.js';
import { AGGREGATE_BACKING_REMEDY } from '../db/service-store.js';
import type { AgreementTerms } from '../db/agreement-store.js';
import { parseJsonArray, parseMapData } from '../db/environment-store.js';
import type { DeviceInstanceRow } from '../db/environment-store.js';
import type { ServiceInstanceRow } from '../db/service-store.js';
import { ApiError } from '../errors.js';
import { deviceExecutableCommandNames, isReadOnlyCapabilityName } from '@active-collaboration/simulation';
import { temperatureCommandRank } from '@active-collaboration/core';

/**
 * The combined signing boundary — propose, counter and accept all run BOTH
 * gates so the three entries can never drift apart on what "deliverable"
 * means. `terms` are the terms ON THE TABLE (the proposal's terms, the
 * counter-offer, or the effective terms of the agreement being accepted).
 */
export function assertDeliverableAtSigning(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  terms: AgreementTerms,
): void {
  assertAggregateDeliverable(ctx, service);
  assertBackingExecutable(ctx, service);
  assertActionExecutable(ctx, service, terms);
  assertZoneReachable(ctx, service, terms);
}

/**
 * R103 (zhao-23): a negotiated terms.action.command must be EXECUTABLE on
 * the backing device at signing — the same oracle surface the invoke gate
 * and agreement callableActions use (deviceExecutableCommandNames). A
 * "fly-to-moon" clause used to sign fine and 422 only at invoke (an
 * agreement doomed from the moment it was signed, with provider-failure
 * metering on top). Refuses 422 DEVICE_COMMAND_NOT_EXECUTABLE with the
 * callable list — the invoke lane's exact teaching shape.
 *
 * Scope: derived/published offers with a determinable backing device
 * (backingDevices). Aggregate offers resolve backing per-action at invoke
 * (the T-310 gates own their deliverability); flow services run flows, not
 * device commands; computation-backed data services and hass:// real
 * hardware are exempt — all consistent with the sibling gates.
 */
export function assertActionExecutable(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  terms: AgreementTerms,
): void {
  const command = terms.action?.command;
  if (command === undefined) return;
  if (service.origin === 'flow') return;
  if (service.origin === 'aggregate') return;
  if (ctx.serviceStore.computationOf(service.id) !== undefined) return;
  const candidates = backingDevices(ctx, service);
  if (candidates.length === 0) return; // unbacked — the SERVICE_NOT_BACKED gates own that refusal
  const surfaces = candidates
    .filter(device => !(device.binding ?? '').startsWith('hass://'))
    .map(device => ({
      device,
      callable: deviceExecutableCommandNames(
        parseJsonArray<string>(device.capabilities_json),
        device.type,
        device.binding,
      ),
    }));
  if (surfaces.length === 0) return; // all hass:// — real hardware the registry cannot speak for
  if (surfaces.some(entry => entry.callable.includes(command))) return;
  // T67 (R6 closeout): the temperature-equivalence gate — the SAME matcher
  // the parse lane's T2/T48 equivalence uses (temperatureCommandRank, now
  // exported). Env-imported HVAC devices conventionally speak CAPABILITY
  // names ('temperature-control', 'cooling') where a negotiated clause says
  // 'set-temperature' — the parse lane maps that ask onto the device's own
  // face command (its notes declare the mapping), so signing must agree:
  // a temperature-setter clause is deliverable when the face carries any
  // temperature-ranked command. The literal-command oracle alone
  // false-refused every canonical 温度条款 (the R6 closeout finding: two
  // suites red at HEAD).
  const equivalent = findTemperatureEquivalent(command, surfaces);
  if (equivalent !== undefined) return;
  const names = surfaces.map(entry => `"${entry.device.name}"`).join(', ');
  const callable = [...new Set(surfaces.flatMap(entry => entry.callable))];
  throw new ApiError(
    422,
    'DEVICE_COMMAND_NOT_EXECUTABLE',
    `terms.action.command "${command}" is not executable on the backing device ${names} of service ` +
      `"${service.name}" — callable actions: ${callable.join(', ') || '(none — the device currently has no executable commands)'}. ` +
      'Signing this clause would land an agreement whose every invoke fails — ' +
      'pick one of the callable actions, or drop terms.action (invoke scope unrestricted)',
    undefined,
    { requestedCommand: command, callableActions: callable, backingDeviceIds: candidates.map(d => d.id) },
  );
}

/**
 * T67: the temperature equivalence for a negotiated clause — the requested
 * command must itself be a temperature-setter-class ask, and the device's
 * callable face must carry a temperature-ranked command for the mapping to
 * land on (both judged by the shared temperatureCommandRank; read-type
 * sensor commands never count as setters). Returns the face command the
 * parse lane would map onto, or undefined when no equivalence exists.
 */
function findTemperatureEquivalent(
  command: string,
  surfaces: ReadonlyArray<{ callable: readonly string[] }>,
): string | undefined {
  // rank 0 = the canonical 'set-temperature' itself; 1/2 = the temp-named /
  // cooling-heating ask family; -1 = not a temperature ask (read-type
  // sensors included). Only -1 is "no equivalence to seek".
  if (temperatureCommandRank(command) < 0) return undefined;
  for (const entry of surfaces) {
    const match = entry.callable
      .map(faceCommand => ({ faceCommand, rank: temperatureCommandRank(faceCommand) }))
      .filter(candidate => candidate.rank > 0)
      .sort((a, b) => a.rank - b.rank)[0];
    if (match !== undefined) return match.faceCommand;
  }
  return undefined;
}

/**
 * R6-B-F01: an aggregate offer must resolve its semantic offer rule
 * (built-in OR scenario-authored — the invoke lane reads the same merged
 * table via offerRuleForAggregate) AND at least one bound device of the
 * provider agent must HOLD one of the rule's actuation capabilities — the
 * exact two 409 conditions of the invoke lane's
 * resolveBackingDeviceForServiceAction, hoisted to signing (a signing-time
 * check has no action yet, so the invoke lane's per-action byAction step
 * has no signing-time counterpart; its byCapability fallback IS the
 * deliverability condition). Refusals are 409 SERVICE_NOT_BACKED — the
 * invoke lane's code, so every "this offer cannot deliver" answer speaks
 * one language; the message names what is missing and the remedy.
 */
export function assertAggregateDeliverable(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): void {
  if (service.origin !== 'aggregate') return;
  const rule = offerRuleForAggregate(ctx, service);
  if (rule === undefined) {
    throw new ApiError(
      409,
      'SERVICE_NOT_BACKED',
      `Aggregate service "${service.name}" matches no semantic offer rule ` +
        `(semantic type "${service.semantic_type}" is neither a built-in rule nor one of this ` +
        "world's scenario-authored mapData.semanticOfferRules) — the offer is stale and can never " +
        'be invoked; the provider must re-declare the rule (or withdraw the offer) before it can be contracted',
    );
  }
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  const backing = aggregateActuationBacking(ctx, service, rule);
  if (backing.length > 0) return;
  const boundNames = agent === undefined
    ? []
    : parseJsonArray<string>(agent.bound_device_ids_json)
        .map(deviceId => ctx.envStore.getDevice(deviceId)?.name)
        .filter((name): name is string => name !== undefined);
  throw new ApiError(
    409,
    'SERVICE_NOT_BACKED',
    `Aggregate service "${service.name}" has no actuation backing — no bound device of provider agent ` +
      (agent === undefined ? '(the provider agent is gone)' : `"${agent.name}"`) +
      (boundNames.length > 0 ? ` (${boundNames.map(name => `"${name}"`).join(', ')})` : ' (none bound)') +
      ` holds any of the offer rule's actuation capabilities (${rule.actuates.join(', ')}) — ` +
      // T31: the remedy sentence is the SHARED constant the catalog face
      // (aggregateBackingMissing.remedy) also carries — one judgment, one
      // remedy, "the offer was likely minted from DECLARED capabilities
      // alone" context added here.
      'the offer was likely minted from DECLARED capabilities alone. ' +
      AGGREGATE_BACKING_REMEDY,
    undefined,
    { actuationCapabilities: [...rule.actuates] },
  );
}

/**
 * R100 (chen-11): the zero-executable-commands gate. A service whose EVERY
 * determinable backing device executes NOTHING (the T-056 dead marketing
 * names — 'emergency-broadcast' declared on a speaker) used to sign all the
 * way to active and only fail at invoke ("this device has no executable
 * commands") — a contract that is dead on arrival. Refuses at signing with
 * the same 409 SERVICE_NOT_BACKED family as the aggregate gate, naming the
 * dead devices/capabilities and the remedy.
 *
 * Actuation intent only — exemptions mirror the zone gate: flow services,
 * computation-backed data services, and services whose semantic type is
 * read/query-class (monitoring/reading — a SENSOR backing legitimately has
 * no commands). Services with no determinable backing stay with the other
 * gates' refusal.
 */
export function assertBackingExecutable(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): void {
  if (service.origin === 'flow') return;
  if (ctx.serviceStore.computationOf(service.id) !== undefined) return;
  if (isReadOnlyCapabilityName(service.semantic_type)) return;
  const candidates = backingDevices(ctx, service);
  if (candidates.length === 0) return;
  const alive = candidates.filter(device =>
    deviceExecutableCommandNames(
      parseJsonArray<string>(device.capabilities_json),
      device.type,
      device.binding,
    ).length > 0,
  );
  if (alive.length > 0) return;
  const detail = candidates
    .map(device =>
      `"${device.name}" (type "${device.type}", capabilities [${parseJsonArray<string>(device.capabilities_json).join(', ')}], executable commands: none)`,
    )
    .join(', ');
  throw new ApiError(
    409,
    'SERVICE_NOT_BACKED',
    `Service "${service.name}" cannot deliver — every backing device has ZERO executable commands: ${detail}. ` +
      'The declared capabilities are names no command handler executes (the device "commands" list is empty), so every ' +
      'invoke of this agreement would fail with "this device has no executable commands". Remedies for the provider: ' +
      're-declare the device with handler-backed capabilities (a speaker: play-alert / turn-on / set-volume — PATCH its ' +
      'capabilities or recreate it), then re-publish; or withdraw the service',
    undefined,
    {
      backingDeviceIds: candidates.map(device => device.id),
      deadCapabilities: [
        ...new Set(candidates.flatMap(device => parseJsonArray<string>(device.capabilities_json))),
      ],
    },
  );
}

/**
 * The service's determinable backing devices: the derived row's pinned
 * source device; otherwise the provider agent's bound devices holding the
 * backing capability (aggregate: the offer rule's actuates; published: the
 * semantic type) — the same candidate semantics as backingZoneEntries,
 * minus the zone requirement.
 */
function backingDevices(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): DeviceInstanceRow[] {
  if (service.source_device_id !== null) {
    const device = ctx.envStore.getDevice(service.source_device_id);
    return device === undefined ? [] : [device];
  }
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  if (agent === undefined) return [];
  const rule = service.origin === 'aggregate' ? offerRuleForAggregate(ctx, service) : undefined;
  const backingCapabilities = rule !== undefined ? rule.actuates : [service.semantic_type];
  const devices: DeviceInstanceRow[] = [];
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = ctx.envStore.getDevice(deviceId);
    if (!device) continue;
    const caps = parseJsonArray<string>(device.capabilities_json);
    if (backingCapabilities.some(capability => caps.includes(capability))) devices.push(device);
  }
  return devices;
}

/**
 * R6-C-F02: the physical reachability gate. Fires only when the terms claim
 * a target zone (terms.targetZoneId); everything else passes untouched:
 * zone-less contracts, flow-services (the flow author's T-201 scoping is
 * their whole security model), computation-backed data services (bytes
 * travel, physics does not), and declared/exempted deliveries.
 */
export function assertZoneReachable(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
  terms: AgreementTerms,
): void {
  const targetZoneId = terms.targetZoneId;
  if (targetZoneId === undefined) return;
  if (service.origin === 'flow') return;
  if (ctx.serviceStore.computationOf(service.id) !== undefined) return; // data service
  if (terms.delivery === 'propagation') return; // declared system-level delivery
  const env = ctx.envStore.getEnvironment(service.env_id);
  if (env === undefined) return;
  const mapData = parseMapData(env);
  if (mapData.governance?.contractReachabilityCheck === false) return; // env-wide escape hatch
  const zoneById = new Map(mapData.zones.map(zone => [zone.id, zone]));
  const targetZone = zoneById.get(targetZoneId);
  if (targetZone === undefined) {
    throw new ApiError(
      422,
      'SERVICE_ZONE_UNREACHABLE',
      `terms.targetZoneId "${targetZoneId}" names no zone of environment "${env.id}" — ` +
        `known zones: ${mapData.zones.map(zone => `"${zone.id}"`).join(', ') || '(none)'}`,
      undefined,
      { targetZoneId, knownZoneIds: mapData.zones.map(zone => zone.id) },
    );
  }
  const backing = backingZoneEntries(ctx, service);
  if (backing.length === 0) return; // no determinable backing — the unbacked gates own that refusal
  for (const entry of backing) {
    if (entry.zoneId === targetZoneId) return; // direct: the backing device acts in the target zone
    const sourceZone = zoneById.get(entry.zoneId);
    // Declared adjacency = the SpatialField propagation lane. Tolerate
    // one-sided declarations like the physics loader (it symmetrizes).
    if (sourceZone?.adjacentZoneIds?.includes(targetZoneId) === true) return;
    if (targetZone.adjacentZoneIds?.includes(entry.zoneId) === true) return;
  }
  throw new ApiError(
    422,
    'SERVICE_ZONE_UNREACHABLE',
    `Service "${service.name}" is backed by device(s) in zone(s) ` +
      `${backing.map(entry => `"${entry.zoneId}" (device "${entry.deviceName}")`).join(', ')} and cannot ` +
      `physically act on zone "${targetZoneId}" — no shared zone and no declared adjacency for spatial ` +
      'propagation, so the agreement would meter commands whose effect never lands. Remedies: contract ' +
      'a provider with actuation in or adjacent to the target zone; if the delivery is system-level ' +
      '(central HVAC / district loop), declare terms.delivery="propagation"; or the world owner may ' +
      'declare the zones adjacent (PATCH mapData zones[].adjacentZoneIds). Env-wide escape hatch: ' +
      'mapData governance.contractReachabilityCheck=false disables this gate',
    undefined,
    { targetZoneId, backingZoneIds: [...new Set(backing.map(entry => entry.zoneId))] },
  );
}

/**
 * The zones the service's actuation physically starts from: the derived
 * row's pinned source device; otherwise the provider agent's bound devices
 * backing the offer (aggregate: the rule's actuation capabilities;
 * published: the semantic type). Devices without a zone are skipped — a
 * zone-less backing cannot be judged and stays ungated.
 */
function backingZoneEntries(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): Array<{ deviceId: string; deviceName: string; zoneId: string }> {
  const entries: Array<{ deviceId: string; deviceName: string; zoneId: string }> = [];
  const push = (deviceId: string): void => {
    const device = ctx.envStore.getDevice(deviceId);
    if (device && device.zone_id !== null) {
      entries.push({ deviceId: device.id, deviceName: device.name, zoneId: device.zone_id });
    }
  };
  if (service.source_device_id !== null) {
    push(service.source_device_id);
    return entries;
  }
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  if (agent === undefined) return entries;
  const rule = service.origin === 'aggregate' ? offerRuleForAggregate(ctx, service) : undefined;
  const backingCapabilities = rule !== undefined ? rule.actuates : [service.semantic_type];
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = ctx.envStore.getDevice(deviceId);
    if (!device) continue;
    const caps = parseJsonArray<string>(device.capabilities_json);
    if (backingCapabilities.some(capability => caps.includes(capability))) push(deviceId);
  }
  return entries;
}
