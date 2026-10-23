/**
 * Aggregate (semantic) offer assembly — pure shaping (L2), see
 * docs/architecture-runtime.md
 *
 * P3: the runtime-side twin of the world layer's R53 aggregate sync. Given
 * an agent's definition and its bound devices, compute the semantic offers
 * its capability union qualifies for under the merged rule table
 * (scenario rules, then operator option rules, deduped over the built-ins)
 * and shape each hit as a Service + registration slot. Pure: the engine
 * only loops the result into EnvironmentCenter.registerService.
 */

import type { Service } from '@active-collaboration/shared';

import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ScenarioAgent, ScenarioDevice } from '../../scenario/index.js';
import { mergeOfferRules, semanticOffersOf, type SemanticOfferRule } from '../../service/semantic-offers.js';

/** One aggregate-offer registration the engine should make. */
export interface AggregateOfferSpec {
  /** Synthetic deviceId slot: `aggregate:<agentId>:<semanticType>`. */
  deviceSlot: string;
  service: Service;
}

/**
 * The aggregate offers one agent qualifies for. The union mirrors the world
 * layer's syncAggregateOffers (declared capabilities + bound-device
 * capabilities); the slot never collides with a device-derived key
 * (`<deviceId>:<name>`) or the world-catalog mirror (`world:<rowId>`).
 */
export function aggregateOfferSpecs(
  agentDef: ScenarioAgent,
  managedDevices: ScenarioDevice[],
  scenarioRules: readonly SemanticOfferRule[] | undefined,
  optionRules: readonly SemanticOfferRule[] | undefined,
): AggregateOfferSpec[] {
  const rules = mergeOfferRules([...(scenarioRules ?? []), ...(optionRules ?? [])]);
  const union = new Set<string>(agentDef.capabilities);
  for (const device of managedDevices) {
    for (const capability of device.capabilities) union.add(capability);
  }
  return semanticOffersOf(union, rules).map(rule => {
    const deviceSlot = `aggregate:${agentDef.id}:${rule.semanticType}`;
    return {
      deviceSlot,
      service: {
        id: `aggregate-${agentDef.id}-${rule.semanticType}`,
        name: rule.label,
        description: rule.description,
        deviceId: deviceSlot,
        uri: `aggregate://${agentDef.id}/${rule.semanticType}`,
        httpMethod: 'POST',
        parameters: [],
        location: '',
        category: rule.semanticType,
        isConditional: false,
        // The offer's callable surface is its actuation backing (same
        // vocabulary the world-layer aggregate interface is grounded in).
        capabilities: [...rule.actuates],
        origin: 'aggregate',
        semanticType: rule.semanticType,
        summary: rule.description,
        providerAgentId: agentDef.id,
        providerAgentName: agentDef.name,
      },
    };
  });
}

/**
 * Register one agent's aggregate offers into the EnvironmentCenter (P3) —
 * spec assembly above + the registration loop, kept out of EngineRuntime
 * for its size budget. Env-backed runtimes: the server's catalog-sync seam
 * sweeps these `aggregate:` keys and re-mirrors the DB rows instead (the
 * world layer stays authoritative there).
 */
export function registerAggregateOffers(
  center: EnvironmentCenter,
  agentDef: ScenarioAgent,
  managedDevices: ScenarioDevice[],
  scenarioRules: readonly SemanticOfferRule[] | undefined,
  optionRules: readonly SemanticOfferRule[] | undefined,
): void {
  for (const spec of aggregateOfferSpecs(agentDef, managedDevices, scenarioRules, optionRules)) {
    center.registerService(spec.service, agentDef.id, spec.deviceSlot, {
      origin: 'aggregate',
      semanticType: spec.service.semanticType,
      summary: spec.service.summary,
      visibility: 'members',
    });
  }
}
