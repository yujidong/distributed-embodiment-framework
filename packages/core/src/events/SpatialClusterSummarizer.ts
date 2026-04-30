/**
 * Spatial Cluster Summarizer
 *
 * Generates concise, human-readable summaries from spatial clusters.
 * These summaries are designed for efficient LLM consumption in Layer 2.
 *
 * Key Features:
 * 1. Human-readable summary generation
 * 2. Key findings extraction
 * 3. Action recommendation generation
 * 4. Optimized for LLM context window
 */

import type {
  SpatialCluster,
  SpatialClusterSummary,
  SpatialRegion,
  DetectedPattern,
} from './SpatialTemporalClusterEngine.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('SpatialClusterSummarizer');

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for SpatialClusterSummarizer
 */


export interface SummarizerConfig {
  // Summary length limits
  maxSummaryLength: number; // Characters
  maxFindingsCount: number; // Number of findings to include

  // Formatting options
  includeTimestamps: boolean;
  includeLocations: boolean;
  includePatterns: boolean;

  // Recommendation thresholds
  immediateActionThreshold: number; // Significance score for immediate action
  evaluateWithLLMThreshold: number; // Significance score for LLM evaluation
}

const DEFAULT_CONFIG: SummarizerConfig = {
  maxSummaryLength: 500,
  maxFindingsCount: 5,

  includeTimestamps: true,
  includeLocations: true,
  includePatterns: true,

  immediateActionThreshold: 85,
  evaluateWithLLMThreshold: 60,
};

// ============================================================================
// SpatialClusterSummarizer
// ============================================================================

export class SpatialClusterSummarizer {
  private config: SummarizerConfig;

  constructor(config: Partial<SummarizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('Initialized');
  }

  /**
   * Generate a summary from a spatial cluster
   */
  summarize(cluster: SpatialCluster): SpatialClusterSummary {
    // Generate human-readable time window
    const timeWindow = this.formatTimeWindow(cluster.temporalWindow.start, cluster.temporalWindow.end);

    // Extract key findings
    const findings = this.extractFindings(cluster);

    // Generate summary text
    const summary = this.generateSummaryText(cluster, findings);

    // Determine recommendation
    const recommendation = this.determineRecommendation(cluster);

    // CRITICAL: Override region ID with the actual zone ID from event payload.
    // The cluster engine uses grid-based region IDs (e.g., "region-0:0:0") which
    // are meaningless to the LLM and coverage checks. The zoneId from the event
    // payload (e.g., "kitchen") is what the LLM and preCheck logic need.
    const region = { ...cluster.region };
    const zoneId = this.extractZoneId(cluster);
    if (zoneId) {
      region.id = zoneId;
    }

    return {
      clusterId: cluster.id,
      region,
      timeWindow,
      significance: cluster.significance,
      summary,
      findings,
      recommendation,
    };
  }

  /**
   * Format time window for human reading
   */
  private formatTimeWindow(start: Date, end: Date): string {
    const formatTime = (date: Date): string => {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    };

    const duration = end.getTime() - start.getTime();
    const durationStr = duration < 1000
      ? `${duration}ms`
      : `${(duration / 1000).toFixed(1)}s`;

    return `${formatTime(start)} - ${formatTime(end)} (${durationStr})`;
  }

  /**
   * Extract key findings from cluster
   */
  private extractFindings(cluster: SpatialCluster): SpatialClusterSummary['findings'] {
    const findings: SpatialClusterSummary['findings'] = [];

    // NEW: Extract task parameters from the first event (if available)
    const taskDetails = this.extractTaskDetails(cluster);

    // Process event types
    for (const [eventType, count] of cluster.statistics.eventTypes) {
      findings.push({
        eventType,
        count,
        trend: cluster.statistics.trend,
        anomaly: cluster.patterns.some(p => p.type === 'anomaly'),
        // NEW: Include task details if available
        details: taskDetails,
      });
    }

    // Add pattern-based findings
    for (const pattern of cluster.patterns) {
      if (pattern.type === 'threshold_breach') {
        findings.push({
          eventType: 'threshold_breach',
          count: 1,
          trend: 'alert',
          anomaly: true,
        });
      }
    }

    // Sort by count and limit
    findings.sort((a, b) => b.count - a.count);
    return findings.slice(0, this.config.maxFindingsCount);
  }

  /**
   * Extract task details from cluster events
   * This preserves task parameters like targetTemp from the original event payload
   */
  private extractTaskDetails(cluster: SpatialCluster): Record<string, any> | undefined {
    // Look for task-related events with parameters
    for (const event of cluster.events) {
      const eventRecord = event as unknown as { payload?: Record<string, unknown>; metadata?: Record<string, unknown> };
      const payload = eventRecord.payload;
      const metadata = eventRecord.metadata;
      if (payload || metadata) {
        const details: Record<string, unknown> = {};

        // CRITICAL: Include ALL payload fields (parameter, newValue, zoneId,
        // severity, location, etc.) so the LLM receives complete event context.
        // Previously only 'parameters', 'taskTitle', 'taskDescription' were
        // extracted, causing the LLM to miss critical event data like severity,
        // threshold breaches, and zone information.
        if (payload) {
          Object.assign(details, payload);
        }

        // Also extract from metadata (contains eventId, eventType, requiredCapabilities, etc.)
        if (metadata) {
          Object.assign(details, metadata);
        }

        if (Object.keys(details).length > 0) {
          logger.info(`Extracted task details:`, details);
          return details;
        }
      }
    }

    return undefined;
  }

  /**
   * Extract zoneId from cluster events' payloads.
   * The cluster engine loses the zoneId (uses grid-based region IDs instead),
   * so we need to recover it from the original event payload.
   */
  private extractZoneId(cluster: SpatialCluster): string | undefined {
    for (const event of cluster.events) {
      const payload = (event as any).payload;
      if (payload?.zoneId && typeof payload.zoneId === 'string') {
        return payload.zoneId;
      }
    }
    return undefined;
  }

  /**
   * Generate human-readable summary text
   */
  private generateSummaryText(
    cluster: SpatialCluster,
    findings: SpatialClusterSummary['findings']
  ): string {
    const parts: string[] = [];

    // Event type and source
    const eventTypes = Array.from(cluster.statistics.eventTypes.keys()).join(', ');
    const firstEvent = cluster.events[0];
    const eventSource = firstEvent?.source || 'unknown';
    parts.push(`Event ${eventTypes} from ${eventSource}`);

    // CRITICAL: Include concrete payload values for LLM context.
    // Without specific values (temperature=36, threshold=35, breach=true),
    // the LLM cannot make accurate collaboration decisions.
    const payloadDetails = this.extractPayloadDetails(cluster);
    if (payloadDetails) {
      parts.push(payloadDetails);
    }

    // Significance
    parts.push(`Significance: ${cluster.significance} (${cluster.statistics.significanceScore}/100)`);

    // Trend (only if notable)
    if (cluster.statistics.trend !== 'stable') {
      parts.push(`Trend: ${cluster.statistics.trend}`);
    }

    // Patterns (only if present)
    if (this.config.includePatterns && cluster.patterns.length > 0) {
      const patternSummaries = cluster.patterns
        .slice(0, 3)
        .map(p => p.description);
      parts.push(`Patterns: ${patternSummaries.join('; ')}`);
    }

    let summary = parts.join(', ');

    // Truncate if too long
    if (summary.length > this.config.maxSummaryLength) {
      summary = summary.substring(0, this.config.maxSummaryLength - 3) + '...';
    }

    return summary;
  }

  /**
   * Extract concrete payload values from cluster events for summary text.
   * Mirrors the format used by eventToClusterSummary() in the direct Layer 2 path.
   */
  private extractPayloadDetails(cluster: SpatialCluster): string | null {
    const firstEvent = cluster.events[0];
    if (!firstEvent) return null;

    const eventRecord = firstEvent as unknown as { payload?: Record<string, unknown> };
    const payload = eventRecord.payload;
    if (!payload) return null;

    const detailParts: string[] = [];

    // Key fields that the LLM needs for decision-making
    const keyFields = ['parameter', 'newValue', 'value', 'temperature', 'humidity',
      'threshold', 'breach', 'severity', 'zoneId'] as const;

    for (const field of keyFields) {
      if (payload[field] !== undefined) {
        detailParts.push(`${field}=${payload[field]}`);
      }
    }

    return detailParts.length > 0 ? detailParts.join(', ') : null;
  }

  /**
   * Format location for human reading
   */
  private formatLocation(region: SpatialRegion): string {
    const { center, type } = region;
    return `${type} at (${center.x.toFixed(0)}, ${center.y.toFixed(0)}${center.z ? `, ${center.z.toFixed(0)}` : ''})`;
  }

  /**
   * Determine recommended action based on cluster significance
   */
  private determineRecommendation(cluster: SpatialCluster): SpatialClusterSummary['recommendation'] {
    const score = cluster.significance === 'urgent' ? 90 :
                  cluster.significance === 'high' ? 75 :
                  cluster.significance === 'medium' ? 50 : 25;

    if (score >= this.config.immediateActionThreshold) {
      return 'immediate_action';
    }

    if (score >= this.config.evaluateWithLLMThreshold) {
      return 'evaluate_with_llm';
    }

    if (score >= 30) {
      return 'monitor';
    }

    return 'ignore';
  }

  /**
   * Generate LLM-friendly prompt from summary
   */
  generateLLMPrompt(summary: SpatialClusterSummary): string {
    return `You are an IoT agent monitoring system events. Analyze the following event cluster and determine if Active Collaboration (AC) is needed.

## Event Cluster Summary
- **Location**: ${this.formatLocation(summary.region)}
- **Time Window**: ${summary.timeWindow}
- **Significance**: ${summary.significance}

## Key Findings
${summary.findings.map((f, i) => `${i + 1}. ${f.eventType}: ${f.count} events, trend: ${f.trend}${f.anomaly ? ' (ANOMALY)' : ''}`).join('\n')}

## Summary
${summary.summary}

## Task
Determine:
1. Is Active Collaboration (AC) needed? (yes/no)
2. If yes, what type of collaboration is needed?
3. Which agent capabilities would be required?
4. What is the urgency level? (low/medium/high/urgent)

Respond in JSON format.`;
  }

  /**
   * Batch summarize multiple clusters
   */
  batchSummarize(clusters: SpatialCluster[]): SpatialClusterSummary[] {
    return clusters.map(cluster => this.summarize(cluster));
  }

  /**
   * Filter summaries by recommendation type
   */
  filterByRecommendation(
    summaries: SpatialClusterSummary[],
    recommendation: SpatialClusterSummary['recommendation']
  ): SpatialClusterSummary[] {
    return summaries.filter(s => s.recommendation === recommendation);
  }

  /**
   * Get only summaries that need LLM evaluation
   */
  getSummariesForLLM(summaries: SpatialClusterSummary[]): SpatialClusterSummary[] {
    return summaries.filter(
      s => s.recommendation === 'evaluate_with_llm' || s.recommendation === 'immediate_action'
    );
  }
}

export default SpatialClusterSummarizer;
