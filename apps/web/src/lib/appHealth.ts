/**
 * App health aggregation (R14 P0-1) — pure functions behind the sidebar's
 * 「应用」 overview tab. Everything derives from data the frontend already
 * holds (EnvironmentDetail + the flows list), so the panel needs no extra
 * endpoints and the rules stay unit-testable.
 *
 * Checks:
 * - agentNoDevices: an agent bound to no device at all;
 * - zoneUnmanaged: a zone no agent manages (zone.id absent from every
 *   agent.managedZoneIds); outdoor/envelope zones (classifyZone = 'outdoor')
 *   are exempt — nobody is expected to "manage" the outdoors;
 * - flowDisabled: a flow with enabled = false. NOTE: the Flow wire type
 *   carries no lastRun/runCount field, so "从未触发" would require one
 *   listFlowRuns call per flow (N requests per sidebar render). We flag
 *   disabled flows instead — the cheap, deterministic proxy for "this flow
 *   will never fire".
 * - agentNoServices: an agent that neither derives nor publishes any service.
 * - flowZoneNoActuator (R14 P1-2): an enabled zone-triggered flow whose
 *   trigger zone has NO device providing a plan node's capability — the
 *   flow-invoker refuses cross-zone actuation (R12), so such a flow fails
 *   at runtime on every firing. Disabled flows are exempt (already flagged).
 */

import type { EnvZone, Flow, WorldAgent, WorldDevice, WorldService } from '../api/types';
import { deviceProvides } from './flowWizard';
import { classifyZone } from './zoneVisual';
import { servicesOfAgent } from './services';

export type HealthIssueKind =
  | 'agentNoDevices'
  | 'zoneUnmanaged'
  | 'flowDisabled'
  | 'agentNoServices'
  | 'flowZoneNoActuator';

export interface HealthIssue {
  kind: HealthIssueKind;
  /** Id of the offending object (agent / zone / flow). */
  id: string;
  /** Display name (falls back to the id for unnamed zones). */
  name: string;
}

export interface AppHealthInput {
  devices: readonly WorldDevice[];
  agents: readonly WorldAgent[];
  services: readonly WorldService[];
  zones: readonly EnvZone[];
  /**
   * The env's flows, or null when the list is unavailable (query still
   * loading / failed) — flow checks are skipped then rather than guessing.
   */
  flows: readonly Flow[] | null;
}

/** All health findings, ordered by kind then name. */
export function computeAppHealth(input: AppHealthInput): HealthIssue[] {
  const issues: HealthIssue[] = [];

  for (const agent of input.agents) {
    if (agent.boundDeviceIds.length === 0) {
      issues.push({ kind: 'agentNoDevices', id: agent.id, name: agent.name });
    }
    if (servicesOfAgent(input.services, agent.id).length === 0) {
      issues.push({ kind: 'agentNoServices', id: agent.id, name: agent.name });
    }
  }

  const managedZoneIds = new Set(input.agents.flatMap(agent => agent.managedZoneIds));
  for (const zone of input.zones) {
    if (managedZoneIds.has(zone.id)) continue;
    if (classifyZone(zone) === 'outdoor') continue;
    issues.push({ kind: 'zoneUnmanaged', id: zone.id, name: zone.name ?? zone.id });
  }

  if (input.flows !== null) {
    for (const flow of input.flows) {
      if (!flow.enabled) {
        issues.push({ kind: 'flowDisabled', id: flow.id, name: flow.name });
        continue;
      }
      const triggerZoneId =
        flow.trigger.kind === 'condition' || flow.trigger.kind === 'event'
          ? flow.trigger.zoneId
          : undefined;
      if (triggerZoneId === undefined) continue;
      const zoneDevices = input.devices.filter(device => device.zoneId === triggerZoneId);
      // Mechanism A: delegate nodes have no capability (their actuation
      // budgets are zone-validated server-side) — only action nodes count.
      const undeliverable = flow.plan.nodes.some(
        node =>
          'capability' in node &&
          !zoneDevices.some(device => deviceProvides(device.capabilities, node.capability)),
      );
      if (undeliverable) {
        issues.push({ kind: 'flowZoneNoActuator', id: flow.id, name: flow.name });
      }
    }
  }

  const kindOrder: Record<HealthIssueKind, number> = {
    agentNoDevices: 0,
    zoneUnmanaged: 1,
    flowDisabled: 2,
    agentNoServices: 3,
    flowZoneNoActuator: 4,
  };
  return issues.sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name),
  );
}

/** Devices not bound to any agent — the overview's「未纳入管理的设备」group. */
export function unboundDevices(
  devices: readonly WorldDevice[],
  agents: readonly WorldAgent[],
): WorldDevice[] {
  const boundIds = new Set(agents.flatMap(agent => agent.boundDeviceIds));
  return devices.filter(device => !boundIds.has(device.id));
}
