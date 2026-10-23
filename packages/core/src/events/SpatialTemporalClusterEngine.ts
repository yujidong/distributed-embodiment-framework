/**
 * Spatial-Temporal Cluster Engine
 *
 * Efficiently clusters high-frequency events by spatial region and time window.
 * This is Layer 1 of the dual-trigger AC mechanism - non-LLM based filtering.
 *
 * Key Features:
 * 1. Grid-based spatial clustering (configurable resolution)
 * 2. Time-window aggregation (configurable interval)
 * 3. Pattern detection: trend, anomaly, correlation
 * 4. Significance scoring (0-100)
 * 5. Filters 95% of events without LLM involvement
 */

import { v4 as uuidv4 } from 'uuid';
import type { SystemEvent, EventType } from './EventManager.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Spatial region definition
 */
const logger = createLogger('SpatialTemporalClusterEngine');

export interface SpatialRegion {
  id: string;
  center: { x: number; y: number; z?: number };
  radius: number; // meters
  type: 'room' | 'zone' | 'area' | 'building';
  metadata?: Record<string, any>;
}

/**
 * Temporal window definition
 */
export interface TemporalWindow {
  start: Date;
  end: Date;
  duration: number; // milliseconds
}

/**
 * Detected pattern in event cluster
 */
export interface DetectedPattern {
  type: 'trend' | 'anomaly' | 'correlation' | 'threshold_breach';
  description: string;
  confidence: number; // 0-1
  relatedParameters: string[];
  dataPoints: { timestamp: Date; value: any; location: SpatialRegion }[];
}

/**
 * Spatial cluster containing grouped events
 */
export interface SpatialCluster {
  id: string;
  region: SpatialRegion;
  temporalWindow: TemporalWindow;
  events: SystemEvent[];

  // Statistical summaries
  statistics: {
    eventCount: number;
    eventTypes: Map<string, number>;
    significanceScore: number; // 0-100
    trend: 'increasing' | 'decreasing' | 'stable' | 'volatile';
  };

  // Detected patterns
  patterns: DetectedPattern[];

  // Significance assessment
  significance: 'low' | 'medium' | 'high' | 'urgent';
  requiresLLMEvaluation: boolean;
}

/**
 * Summary of spatial cluster for LLM consumption
 */
export interface SpatialClusterSummary {
  clusterId: string;
  region: SpatialRegion;
  timeWindow: string; // Human-readable
  significance: 'low' | 'medium' | 'high' | 'urgent';

  // Concise summary for LLM
  summary: string;

  // Key findings
  findings: {
    eventType: string;
    count: number;
    trend: string;
    anomaly: boolean;
    // NEW: Store task-specific details from original event
    details?: Record<string, any>;
  }[];

  // Recommended action
  recommendation: 'ignore' | 'monitor' | 'evaluate_with_llm' | 'immediate_action';
}

/**
 * Configuration for SpatialTemporalClusterEngine
 */
export interface ClusterEngineConfig {
  // Spatial clustering settings
  spatialGridResolution: number; // Grid cell size in meters
  minEventsPerCluster: number; // Minimum events to form cluster
  maxClusterRadius: number; // Maximum cluster radius in meters

  // Temporal settings
  aggregationWindowMs: number; // Time window for aggregation
  maxClusterAge: number; // Maximum age of cluster before flush
  maxEventsPerGridCell: number; // Maximum events per grid cell before dropping oldest

  // Significance thresholds
  significanceThresholds: {
    lowThreshold: number; // 0-30 = low
    mediumThreshold: number; // 30-60 = medium
    highThreshold: number; // 60-85 = high
    // 85-100 = urgent
  };

  // Pattern detection settings
  enableTrendDetection: boolean;
  enableAnomalyDetection: boolean;
  enableCorrelationDetection: boolean;

  // AC trigger thresholds
  acTriggerThresholds: {
    [parameter: string]: {
      threshold: number;
      operator: '>' | '<' | '>=' | '<=' | '==';
      urgency: 'low' | 'medium' | 'high' | 'urgent';
    };
  };
}

const DEFAULT_CONFIG: ClusterEngineConfig = {
  spatialGridResolution: 10, // 10 meter grid cells
  minEventsPerCluster: 3,
  maxClusterRadius: 50, // 50 meters

  aggregationWindowMs: 1000, // 1 second
  maxClusterAge: 5000, // 5 seconds
  maxEventsPerGridCell: 100, // Limit events per grid cell to prevent memory buildup

  significanceThresholds: {
    lowThreshold: 30,
    mediumThreshold: 60,
    highThreshold: 85,
  },

  enableTrendDetection: true,
  enableAnomalyDetection: true,
  enableCorrelationDetection: true,

  acTriggerThresholds: {
    temperature: { threshold: 35, operator: '>', urgency: 'high' },
    humidity: { threshold: 90, operator: '>', urgency: 'medium' },
    pm2_5: { threshold: 50, operator: '>', urgency: 'high' },
    pm10: { threshold: 80, operator: '>', urgency: 'high' },
    co2: { threshold: 1000, operator: '>', urgency: 'medium' },
    aqi: { threshold: 150, operator: '>', urgency: 'urgent' },
  },
};

// ============================================================================
// SpatialTemporalClusterEngine
// ============================================================================

export class SpatialTemporalClusterEngine {
  private config: ClusterEngineConfig;
  private pendingClusters: Map<string, SpatialCluster> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private onClusterReady: (cluster: SpatialCluster) => void;

  // Grid-based spatial index
  private spatialGrid: Map<string, SystemEvent[]> = new Map();

  // Statistics tracking
  private stats = {
    totalEventsProcessed: 0,
    totalClustersCreated: 0,
    eventsFiltered: 0,
    clustersForLLMEvaluation: 0,
  };

  constructor(
    config: Partial<ClusterEngineConfig>,
    onClusterReady: (cluster: SpatialCluster) => void
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onClusterReady = onClusterReady;

    logger.info('Initialized with config:', {
      gridResolution: this.config.spatialGridResolution,
      aggregationWindow: this.config.aggregationWindowMs,
      minEvents: this.config.minEventsPerCluster,
    });
  }

  /**
   * Add an event to the clustering engine
   */
  addEvent(event: SystemEvent): void {
    this.stats.totalEventsProcessed++;

    // Extract location from event payload
    const location = this.extractLocation(event);
    if (!location) {
      // Event without location - cannot cluster spatially
      this.stats.eventsFiltered++;
      return;
    }

    // Get grid cell key
    const gridKey = this.getGridKey(location);

    // Add to spatial grid
    if (!this.spatialGrid.has(gridKey)) {
      this.spatialGrid.set(gridKey, []);
    }
    const cellEvents = this.spatialGrid.get(gridKey)!;

    // Limit events per grid cell to prevent unbounded memory growth
    if (cellEvents.length >= this.config.maxEventsPerGridCell) {
      cellEvents.shift(); // Drop oldest event
    }
    cellEvents.push(event);

    // Update or create cluster
    this.updateCluster(gridKey, event, location);

    // Start flush timer if not running
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(
        () => this.flush(),
        this.config.aggregationWindowMs
      );
    }
  }

  /**
   * Extract location from event payload
   */
  private extractLocation(event: SystemEvent): { x: number; y: number; z?: number } | null {
    const payload = event.payload || {};

    // Try different location formats
    if (payload.location) {
      return payload.location;
    }
    if (payload.coordinates) {
      return payload.coordinates;
    }
    if (payload.position) {
      return payload.position;
    }
    if (payload.x !== undefined && payload.y !== undefined) {
      return { x: payload.x, y: payload.y, z: payload.z };
    }

    return null;
  }

  /**
   * Get grid cell key for a location
   */
  private getGridKey(location: { x: number; y: number; z?: number }): string {
    const resolution = this.config.spatialGridResolution;
    const gridX = Math.floor(location.x / resolution);
    const gridY = Math.floor(location.y / resolution);
    const gridZ = location.z !== undefined ? Math.floor(location.z / resolution) : 0;
    return `${gridX}:${gridY}:${gridZ}`;
  }

  /**
   * Get region center from grid key
   */
  private getRegionFromGridKey(gridKey: string): SpatialRegion {
    const [gridX, gridY, gridZ] = gridKey.split(':').map(Number);
    const resolution = this.config.spatialGridResolution;

    return {
      id: `region-${gridKey}`,
      center: {
        x: (gridX + 0.5) * resolution,
        y: (gridY + 0.5) * resolution,
        z: (gridZ + 0.5) * resolution,
      },
      radius: resolution / 2,
      type: 'zone',
    };
  }

  /**
   * Update or create cluster for grid cell
   */
  private updateCluster(
    gridKey: string,
    event: SystemEvent,
    location: { x: number; y: number; z?: number }
  ): void {
    const now = new Date();

    if (this.pendingClusters.has(gridKey)) {
      // Update existing cluster
      const cluster = this.pendingClusters.get(gridKey)!;
      cluster.events.push(event);
      cluster.temporalWindow.end = now;
      cluster.statistics.eventCount++;

      // Update event type counts
      const eventType = event.type;
      const count = cluster.statistics.eventTypes.get(eventType) || 0;
      cluster.statistics.eventTypes.set(eventType, count + 1);

      // Recalculate significance
      this.calculateClusterSignificance(cluster);
    } else {
      // Create new cluster
      const region = this.getRegionFromGridKey(gridKey);
      const eventType = event.type;

      const cluster: SpatialCluster = {
        id: uuidv4(),
        region,
        temporalWindow: {
          start: now,
          end: now,
          duration: 0,
        },
        events: [event],
        statistics: {
          eventCount: 1,
          eventTypes: new Map([[eventType, 1]]),
          significanceScore: 0,
          trend: 'stable',
        },
        patterns: [],
        significance: 'low',
        requiresLLMEvaluation: false,
      };

      this.calculateClusterSignificance(cluster);
      this.pendingClusters.set(gridKey, cluster);
    }
  }

  /**
   * Calculate significance score for a cluster
   */
  private calculateClusterSignificance(cluster: SpatialCluster): void {
    let score = 0;

    // Factor 1: Event count (max 30 points)
    score += Math.min(30, cluster.statistics.eventCount * 3);

    // Factor 2: Event type diversity (max 20 points)
    const typeCount = cluster.statistics.eventTypes.size;
    score += Math.min(20, typeCount * 5);

    // Factor 3: Check against AC trigger thresholds (max 50 points)
    for (const event of cluster.events) {
      const payload = event.payload || {};
      for (const [param, config] of Object.entries(this.config.acTriggerThresholds)) {
        const value = payload[param];
        if (value !== undefined && typeof value === 'number') {
          if (this.evaluateThreshold(value, config.threshold, config.operator)) {
            score += 50;
            break;
          }
        }
      }
    }

    // Normalize to 0-100
    cluster.statistics.significanceScore = Math.min(100, score);

    // Determine significance level
    const thresholds = this.config.significanceThresholds;
    if (score >= thresholds.highThreshold) {
      cluster.significance = 'urgent';
    } else if (score >= thresholds.mediumThreshold) {
      cluster.significance = 'high';
    } else if (score >= thresholds.lowThreshold) {
      cluster.significance = 'medium';
    } else {
      cluster.significance = 'low';
    }

    // Determine if LLM evaluation is needed
    cluster.requiresLLMEvaluation =
      cluster.significance === 'high' || cluster.significance === 'urgent';
  }

  /**
   * Evaluate threshold condition
   */
  private evaluateThreshold(
    value: number,
    threshold: number,
    operator: string
  ): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      default:
        return false;
    }
  }

  /**
   * Detect patterns in cluster
   */
  private detectPatterns(cluster: SpatialCluster): void {
    cluster.patterns = [];

    if (this.config.enableTrendDetection) {
      this.detectTrends(cluster);
    }

    if (this.config.enableAnomalyDetection) {
      this.detectAnomalies(cluster);
    }

    if (this.config.enableCorrelationDetection) {
      this.detectCorrelations(cluster);
    }
  }

  /**
   * Detect trends in cluster events
   */
  private detectTrends(cluster: SpatialCluster): void {
    const numericValues: { timestamp: Date; value: number; param: string }[] = [];

    // Extract numeric values from events
    for (const event of cluster.events) {
      const payload = event.payload || {};
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'number') {
          numericValues.push({
            timestamp: event.timestamp || new Date(),
            value,
            param: key,
          });
        }
      }
    }

    if (numericValues.length < 3) return;

    // Group by parameter
    const byParam = new Map<string, typeof numericValues>();
    for (const item of numericValues) {
      if (!byParam.has(item.param)) {
        byParam.set(item.param, []);
      }
      byParam.get(item.param)!.push(item);
    }

    // Detect trends for each parameter
    for (const [param, values] of byParam) {
      if (values.length < 3) continue;

      // Sort by timestamp
      values.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Simple trend detection: compare first and last values
      const first = values[0].value;
      const last = values[values.length - 1].value;
      const change = ((last - first) / first) * 100;

      if (Math.abs(change) > 10) {
        cluster.patterns.push({
          type: 'trend',
          description: `${param} ${change > 0 ? 'increasing' : 'decreasing'} by ${Math.abs(change).toFixed(1)}%`,
          confidence: Math.min(1, Math.abs(change) / 50),
          relatedParameters: [param],
          dataPoints: values.slice(0, 5).map(v => ({
            timestamp: v.timestamp,
            value: v.value,
            location: cluster.region,
          })),
        });

        // Update cluster trend
        cluster.statistics.trend = change > 0 ? 'increasing' : 'decreasing';
      }
    }
  }

  /**
   * Detect anomalies in cluster events
   */
  private detectAnomalies(cluster: SpatialCluster): void {
    // Check for threshold breaches
    for (const event of cluster.events) {
      const payload = event.payload || {};

      for (const [param, config] of Object.entries(this.config.acTriggerThresholds)) {
        const value = payload[param];
        if (value !== undefined && typeof value === 'number') {
          if (this.evaluateThreshold(value, config.threshold, config.operator)) {
            cluster.patterns.push({
              type: 'threshold_breach',
              description: `${param} ${config.operator} ${config.threshold}: current value ${value}`,
              confidence: 0.9,
              relatedParameters: [param],
              dataPoints: [{
                timestamp: event.timestamp || new Date(),
                value,
                location: cluster.region,
              }],
            });
          }
        }
      }
    }

    // Check for sudden spikes
    const numericValues: number[] = [];
    for (const event of cluster.events) {
      const payload = event.payload || {};
      for (const value of Object.values(payload)) {
        if (typeof value === 'number') {
          numericValues.push(value);
        }
      }
    }

    if (numericValues.length >= 3) {
      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      const variance = numericValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numericValues.length;
      const stdDev = Math.sqrt(variance);

      // Detect outliers (> 2 standard deviations)
      for (const value of numericValues) {
        if (Math.abs(value - mean) > 2 * stdDev) {
          cluster.patterns.push({
            type: 'anomaly',
            description: `Anomalous value detected: ${value.toFixed(2)} (mean: ${mean.toFixed(2)}, std: ${stdDev.toFixed(2)})`,
            confidence: 0.7,
            relatedParameters: [],
            dataPoints: [{
              timestamp: new Date(),
              value,
              location: cluster.region,
            }],
          });
          break; // Only report one anomaly per cluster
        }
      }
    }
  }

  /**
   * Detect correlations between parameters
   */
  private detectCorrelations(cluster: SpatialCluster): void {
    // Extract numeric values grouped by timestamp
    const dataPoints = new Map<number, Map<string, number>>();

    for (const event of cluster.events) {
      const timestamp = event.timestamp?.getTime() || Date.now();
      if (!dataPoints.has(timestamp)) {
        dataPoints.set(timestamp, new Map());
      }

      const payload = event.payload || {};
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'number') {
          dataPoints.get(timestamp)!.set(key, value);
        }
      }
    }

    if (dataPoints.size < 3) return;

    // Get all parameters
    const params = new Set<string>();
    for (const values of dataPoints.values()) {
      for (const param of values.keys()) {
        params.add(param);
      }
    }

    // Check correlation between pairs of parameters
    const paramList = Array.from(params);
    for (let i = 0; i < paramList.length; i++) {
      for (let j = i + 1; j < paramList.length; j++) {
        const param1 = paramList[i];
        const param2 = paramList[j];

        const pairs: [number, number][] = [];
        for (const values of dataPoints.values()) {
          if (values.has(param1) && values.has(param2)) {
            pairs.push([values.get(param1)!, values.get(param2)!]);
          }
        }

        if (pairs.length >= 3) {
          const correlation = this.calculateCorrelation(pairs);
          if (Math.abs(correlation) > 0.7) {
            cluster.patterns.push({
              type: 'correlation',
              description: `Strong ${correlation > 0 ? 'positive' : 'negative'} correlation between ${param1} and ${param2} (${correlation.toFixed(2)})`,
              confidence: Math.abs(correlation),
              relatedParameters: [param1, param2],
              dataPoints: [],
            });
          }
        }
      }
    }
  }

  /**
   * Calculate Pearson correlation coefficient
   */
  private calculateCorrelation(pairs: [number, number][]): number {
    const n = pairs.length;
    if (n < 2) return 0;

    const sumX = pairs.reduce((a, [x]) => a + x, 0);
    const sumY = pairs.reduce((a, [, y]) => a + y, 0);
    const sumXY = pairs.reduce((a, [x, y]) => a + x * y, 0);
    const sumX2 = pairs.reduce((a, [x]) => a + x * x, 0);
    const sumY2 = pairs.reduce((a, [, y]) => a + y * y, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt(
      (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
    );

    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  /**
   * Flush all pending clusters
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingClusters.size === 0) {
      this.spatialGrid.clear();
      return;
    }

    const now = new Date();

    // Process each cluster
    for (const [gridKey, cluster] of this.pendingClusters) {
      // Calculate final temporal window duration
      cluster.temporalWindow.duration =
        cluster.temporalWindow.end.getTime() - cluster.temporalWindow.start.getTime();

      // Detect patterns
      this.detectPatterns(cluster);

      // Only emit clusters with minimum events
      if (cluster.statistics.eventCount >= this.config.minEventsPerCluster) {
        this.stats.totalClustersCreated++;

        if (cluster.requiresLLMEvaluation) {
          this.stats.clustersForLLMEvaluation++;
        } else {
          this.stats.eventsFiltered += cluster.events.length;
        }

        this.onClusterReady(cluster);
      }
    }

    // Clear for next window
    this.pendingClusters.clear();
    this.spatialGrid.clear();

    logger.info('Flush complete:', {
      clustersCreated: this.stats.totalClustersCreated,
      clustersForLLM: this.stats.clustersForLLMEvaluation,
      eventsFiltered: this.stats.eventsFiltered,
    });
  }

  /**
   * Get current statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Stop the engine and flush remaining clusters
   */
  stop(): void {
    logger.info('Stopping...');
    this.flush();
  }
}

export default SpatialTemporalClusterEngine;
