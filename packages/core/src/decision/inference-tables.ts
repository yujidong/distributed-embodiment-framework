/**
 * Inference keyword tables (R21 file-budget ratchet; extracted from
 * ACNecessityAssessor.ts in Phase 1 of the cognitive architecture).
 *
 * INFERRED capability/partner hints from cluster-summary text. R35 (bundled
 * with the §14.1 binary retirement): these tables are a HINT for prompts
 * (partner ranking) and the no-declaration fallback ONLY - the rendered
 * EVENT_NEEDS line and every VERDICT path compute against the
 * AUTHOR-DECLARED requiredCapabilities
 * (extractDeclaredRequiredCapabilities / declaredOrInferredRequirements in
 * the assessor), the same face the ground-truth calculator scores against.
 *
 * Pure module: no IO, no clock, no LLM.
 */

import { createLogger } from '@active-collaboration/shared';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';

const logger = createLogger('InferenceTables');

/**
 * Infer required capabilities from cluster summary
 * Maps event types to required capabilities for handling them
 */
export function inferCapabilitiesFromCluster(clusterSummary: SpatialClusterSummary): string[] {
  const capabilities: Set<string> = new Set();

  // Analyze findings to infer capabilities
  for (const finding of clusterSummary.findings) {
    // Safety check: eventType may be undefined
    const eventType = (finding.eventType || '').toLowerCase();

    // Check payload details for parameter-specific capabilities.
    // The eventType may be generic (e.g., ENVIRONMENT_PARAM_CHANGED),
    // but the details contain the actual parameter type (e.g., 'temperature').
    const details = finding.details as Record<string, unknown> | undefined;
    const parameter = (details?.parameter as string || '').toLowerCase();
    const detailsEventType = (details?.eventType as string || '').toLowerCase();

    // Smoke/fire events (R100 chen-11 — check eventType, details eventType,
    // AND the parameter: a scheduled 'smoke' event rides a generic
    // ENVIRONMENT_PARAM_CHANGED envelope and is only visible through it).
    // Without this branch a smoke event inferred NOTHING, the gap face came
    // out empty, and "no requirements → every agent eligible" broadcast the
    // AC to semantically random partners (mass justified rejection).
    const isSmokeEvent = eventType.includes('smoke') || eventType.includes('fire')
      || parameter === 'smoke'
      || detailsEventType.includes('smoke') || detailsEventType.includes('fire');
    if (isSmokeEvent) {
      // Smoke dispatch: confirm (monitoring), extract (ventilation /
      // purification), alert (broadcast / emergency response).
      capabilities.add('smoke-monitoring');
      capabilities.add('ventilation');
      capabilities.add('air-purification');
      capabilities.add('emergency-broadcast');
      capabilities.add('emergency-response');
    }

    // Air-quality / CO2 events (parameter-first, same envelope reason).
    const isAirQualityEvent = eventType.includes('air-quality') || eventType.includes('co2')
      || parameter === 'co2' || parameter === 'pm2_5' || parameter === 'pm25'
      || detailsEventType.includes('air-quality') || detailsEventType.includes('co2');
    if (isAirQualityEvent) {
      capabilities.add('ventilation');
      capabilities.add('air-purification');
      capabilities.add('air-quality-monitoring');
    }

    // Temperature-related events (check both eventType and details)
    const isTemperatureEvent = eventType.includes('temperature') || eventType.includes('temp')
      || parameter === 'temperature'
      || detailsEventType.includes('temperature');

    if (isTemperatureEvent) {
      if (finding.anomaly || finding.trend === 'increasing') {
        capabilities.add('cooling');
        capabilities.add('temperature-control');
      } else if (finding.trend === 'decreasing') {
        capabilities.add('heating');
        capabilities.add('temperature-control');
      }
    }

    // Humidity-related events (check both eventType and details)
    const isHumidityEvent = eventType.includes('humidity') || eventType.includes('moisture')
      || parameter === 'humidity';

    if (isHumidityEvent) {
      if (finding.anomaly || finding.trend === 'increasing') {
        capabilities.add('dehumidifier-control');
      } else if (finding.trend === 'decreasing') {
        capabilities.add('humidifier-control');
      }
      capabilities.add('humidity-control');
    }

    // Motion/security events
    if (eventType.includes('motion') || eventType.includes('movement') || eventType.includes('security')) {
      capabilities.add('monitoring');
      capabilities.add('security');
    }

    // Device state events — infer from context
    if (eventType.includes('device') || eventType.includes('state')) {
      const details = finding.details as Record<string, unknown> | undefined;
      const stateChange = details?.stateChange as { property?: string } | undefined;

      if (stateChange?.property === 'temperature'
          || details?.temperature !== undefined
          || (finding as Record<string, unknown>).temperature !== undefined) {
        // Temperature-specific: infer temperature/HVAC capabilities
        capabilities.add('temperature-control');
        capabilities.add('hvac-control');
      } else {
        // Generic device control
        capabilities.add('device-control');
        capabilities.add('actuation');
      }
    }

    // Power/energy events
    if (eventType.includes('power') || eventType.includes('energy') || eventType.includes('electric')) {
      capabilities.add('power-management');
      capabilities.add('device-control');
    }

    // Light/illumination events
    if (eventType.includes('light') || eventType.includes('illumination') || eventType.includes('brightness')) {
      capabilities.add('lighting-control');
    }

    // Only add emergency-response for anomalies that are NOT temperature,
    // humidity, light, smoke, or air-quality related (those have specific
    // capabilities above — a generic 'monitoring' need substring-matches
    // nearly every service and dilutes the request face).
    if (finding.anomaly && !isTemperatureEvent && !isHumidityEvent
        && !isSmokeEvent && !isAirQualityEvent
        && !eventType.includes('light') && parameter !== 'light') {
      capabilities.add('emergency-response');
      capabilities.add('monitoring');
    }
  }

  // Also check summary for additional context
  const summary = clusterSummary.summary.toLowerCase();
  if (summary.includes('temperature') && (summary.includes('high') || summary.includes('breach'))) {
    capabilities.add('cooling');
    capabilities.add('temperature-control');
  }
  if (summary.includes('urgent') || summary.includes('critical')) {
    capabilities.add('emergency-response');
  }

  // NEW: Check finding details (task payload) for capability hints
  for (const finding of clusterSummary.findings) {
    const details = finding.details;
    if (details) {
      // First, check if requiredCapabilities is explicitly defined in the task
      // This is the most reliable source of capability requirements
      if (details.requiredCapabilities && Array.isArray(details.requiredCapabilities)) {
        for (const cap of details.requiredCapabilities) {
          if (typeof cap === 'string') {
            capabilities.add(cap.toLowerCase());
            logger.info(`Added required capability from task: ${cap.toLowerCase()}`);
          }
        }
      }

      const taskTitle = (details.taskTitle || '').toLowerCase();
      const taskDescription = (details.taskDescription || details.description || '').toLowerCase();
      const combined = `${taskTitle} ${taskDescription}`;

      // Temperature-related tasks
      if (combined.includes('temperature') || combined.includes('temp') || combined.includes('thermostat')) {
        capabilities.add('temperature-control');
        capabilities.add('hvac-control');
        capabilities.add('climate-control');
      }

      // Light-related tasks
      if (combined.includes('light') || combined.includes('brightness') || combined.includes('illumination')) {
        capabilities.add('lighting-control');
        capabilities.add('light-control');
        capabilities.add('actuator-control');
      }

      // Humidity-related tasks
      if (combined.includes('humidity') || combined.includes('moisture')) {
        capabilities.add('humidity-control');
      }

      // Motion/security tasks
      if (combined.includes('motion') || combined.includes('security') || combined.includes('movement')) {
        capabilities.add('monitoring');
        capabilities.add('security');
      }

      // Smoke/fire tasks
      if (combined.includes('smoke') || combined.includes('fire')) {
        capabilities.add('smoke-monitoring');
        capabilities.add('ventilation');
        capabilities.add('emergency-broadcast');
      }

      // Device control tasks
      if (combined.includes('device') || combined.includes('control') || combined.includes('adjust')) {
        capabilities.add('device-control');
        capabilities.add('actuation');
      }
    }
  }

  // Ensure at least some capability is returned for urgent events
  if (capabilities.size === 0 && clusterSummary.significance === 'urgent') {
    capabilities.add('emergency-response');
    capabilities.add('monitoring');
  }

  const result = Array.from(capabilities);
  logger.info(`Inferred capabilities from cluster: ${result.join(', ')}`);
  return result;
}

/**
 * R103 (chen-20): the event-type → dispatch-needs mapping for ROUTING —
 * one synthetic finding through the single inference table, so the event
 * router and the AC request face can never drift apart (the table is the
 * only place event types map to capabilities). Unknown types honestly
 * return empty (routing falls through to the managed/adjacent levels).
 */
export function inferNeedsForEventType(eventType: string): string[] {
  return inferCapabilitiesFromCluster({
    clusterId: `route-probe-${eventType}`,
    region: { id: 'unknown', center: { x: 0, y: 0 }, radius: 0, type: 'zone' },
    timeWindow: '',
    significance: 'medium',
    summary: '',
    findings: [{ eventType, count: 1, trend: 'stable', anomaly: false, details: {} }],
    recommendation: 'evaluate_with_llm',
  });
}

/**
 * Infer partner agent types from cluster summary
 */
export function inferPartnerTypesFromCluster(clusterSummary: SpatialClusterSummary): string[] {
  const partnerTypes: Set<string> = new Set();

  // Analyze findings to infer partner types
  for (const finding of clusterSummary.findings) {
    // Safety check: eventType may be undefined
    const eventType = (finding.eventType || '').toLowerCase();

    if (eventType.includes('temperature') || eventType.includes('temp')) {
      partnerTypes.add('climate-control-agent');
      partnerTypes.add('temperature-monitor-agent');
    }

    if (eventType.includes('humidity') || eventType.includes('moisture')) {
      partnerTypes.add('humidity-control-agent');
    }

    if (eventType.includes('motion') || eventType.includes('security')) {
      partnerTypes.add('security-agent');
      partnerTypes.add('surveillance-agent');
    }

    if (eventType.includes('device')) {
      partnerTypes.add('device-manager-agent');
    }

    if (finding.anomaly) {
      partnerTypes.add('emergency-response-agent');
    }
  }

  // Default partner types for urgent events
  if (partnerTypes.size === 0 && clusterSummary.significance === 'urgent') {
    partnerTypes.add('cognitive-agent');
  }

  const result = Array.from(partnerTypes);
  logger.info(`Inferred partner types from cluster: ${result.join(', ')}`);
  return result;
}
