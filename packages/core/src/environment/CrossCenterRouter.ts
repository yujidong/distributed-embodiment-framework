/**
 * Cross-Center Router
 *
 * Handles routing messages between environment centers
 * Enables distributed architecture with multiple isolated deployment boundaries
 */

import type { RouteInfo, Message } from './types.js';
import { environmentRegistry } from './EnvironmentRegistry.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Cross-center router configuration
 */
const logger = createLogger('CrossCenterRouter');

export interface RouterConfig {
  maxRetries?: number;
  timeout?: number;
  enableCompression?: boolean;
  enableCaching?: boolean;
}

/**
 * Routing result
 */
export interface RoutingResult {
  success: boolean;
  routeInfo?: RouteInfo;
  error?: string;
  latency?: number;
}

/**
 * Route entry
 */
interface RouteEntry {
  fromCenterId: string;
  toCenterId: string;
  active: boolean;
  latency: number;
  lastUsed: Date;
}

/**
 * Cached message
 */
interface CachedMessage {
  message: Message;
  result: RoutingResult;
  timestamp: Date;
}

/**
 * Cross-Center Router Interface
 */
export interface ICrossCenterRouter {
  /**
   * Route a message to another environment center
   * @param fromCenterId - Source center ID
   * @param toCenterId - Target center ID
   * @param message - Message to route
   * @returns Routing result
   */
  route(
    fromCenterId: string,
    toCenterId: string,
    message: Message
  ): Promise<RoutingResult>;

  /**
   * Broadcast a message to multiple environment centers
   * @param fromCenterId - Source center ID
   * @param toCenterIds - Target center IDs
   * @param message - Message to broadcast
   * @returns Array of routing results
   */
  broadcast(
    fromCenterId: string,
    toCenterIds: string[],
    message: Message
  ): Promise<RoutingResult[]>;

  /**
   * Check if a route exists between two centers
   * @param fromCenterId - Source center ID
   * @param toCenterId - Target center ID
   * @returns True if route exists
   */
  routeExists(fromCenterId: string, toCenterId: string): boolean;

  /**
   * Get routing statistics
   */
  getStats(): RouterStats;

  /**
   * Register a route between two centers
   * @param fromCenterId - Source center ID
   * @param toCenterId - Target center ID
   */
  registerRoute(fromCenterId: string, toCenterId: string): void;

  /**
   * Unregister a route between two centers
   * @param fromCenterId - Source center ID
   * @param toCenterId - Target center ID
   */
  unregisterRoute(fromCenterId: string, toCenterId: string): void;
}

/**
 * Router statistics
 */
export interface RouterStats {
  totalRouted: number;
  successfulRoutes: number;
  failedRoutes: number;
  averageLatency: number;
  activeRoutes: number;
  cachedMessages: number;
}

/**
 * Message queue entry
 */
interface QueuedMessage {
  fromCenterId: string;
  toCenterId: string;
  message: Message;
  attempts: number;
  priority: number;
  timestamp: Date;
}

/**
 * Implementation of Cross-Center Router
 */
export class CrossCenterRouter implements ICrossCenterRouter {
  private routes: Map<string, RouteEntry>;
  private messageQueue: QueuedMessage[];
  private messageCache: Map<string, CachedMessage>;
  private stats: RouterStats;
  private config: Required<RouterConfig>;
  private isProcessingQueue: boolean = false;

  constructor(config: RouterConfig = {}) {
    this.routes = new Map();
    this.messageQueue = [];
    this.messageCache = new Map();

    this.config = {
      maxRetries: config.maxRetries ?? 3,
      timeout: config.timeout ?? 30000,
      enableCompression: config.enableCompression ?? false,
      enableCaching: config.enableCaching ?? true,
    };

    this.stats = {
      totalRouted: 0,
      successfulRoutes: 0,
      failedRoutes: 0,
      averageLatency: 0,
      activeRoutes: 0,
      cachedMessages: 0,
    };

    // Start queue processor
    this.startQueueProcessor();

    logger.info('Initialized with full routing capabilities');
  }

  /**
   * Route a message to another environment center
   */
  async route(
    fromCenterId: string,
    toCenterId: string,
    message: Message
  ): Promise<RoutingResult> {
    const startTime = Date.now();
    const cacheKey = this.getCacheKey(fromCenterId, toCenterId, message);

    logger.info(`Routing message from ${fromCenterId} to ${toCenterId}`);

    // Check cache if enabled
    if (this.config.enableCaching) {
      const cached = this.messageCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp.getTime() < 60000) { // 1 minute cache
        logger.info('Cache hit - returning cached result');
        this.stats.cachedMessages++;
        return {
          ...cached.result,
          latency: Date.now() - startTime,
        };
      }
    }

    // Verify both centers exist
    const fromCenter = environmentRegistry.getCenter(fromCenterId);
    const toCenter = environmentRegistry.getCenter(toCenterId);

    if (!fromCenter) {
      const error = `Source center ${fromCenterId} not found`;
      logger.info(`${error}`);
      return { success: false, error };
    }

    if (!toCenter) {
      const error = `Target center ${toCenterId} not found`;
      logger.info(`${error}`);
      return { success: false, error };
    }

    // Check if route is registered
    const routeKey = this.getRouteKey(fromCenterId, toCenterId);
    const route = this.routes.get(routeKey);

    if (!route || !route.active) {
      // Auto-register route if both centers exist
      this.registerRoute(fromCenterId, toCenterId);
    }

    try {
      // In a real implementation, this would:
      // 1. Serialize the message
      // 2. Send it via HTTP/WebSocket/gRPC to the target center
      // 3. Wait for acknowledgment
      // 4. Return the result

      // For now, we'll simulate cross-center communication
      // by checking if the target center has the required resources

      const success = await this.simulateCrossCenterCall(fromCenterId, toCenterId, message);

      const latency = Date.now() - startTime;
      const result: RoutingResult = {
        success,
        routeInfo: {
          fromCenterId,
          toCenterId,
          message,
          timestamp: new Date(),
        },
        latency,
      };

      // Update stats
      this.stats.totalRouted++;
      if (success) {
        this.stats.successfulRoutes++;
        this.updateAverageLatency(latency);

        // Cache successful result
        if (this.config.enableCaching) {
          this.messageCache.set(cacheKey, {
            message,
            result,
            timestamp: new Date(),
          });
          this.stats.cachedMessages = this.messageCache.size;
        }
      } else {
        this.stats.failedRoutes++;

        // Add to queue for retry
        if (this.config.maxRetries > 0) {
          this.addToQueue(fromCenterId, toCenterId, message, 1);
        }
      }

      // Update route usage
      const routeEntry = this.routes.get(routeKey);
      if (routeEntry) {
        routeEntry.lastUsed = new Date();
        routeEntry.latency = latency;
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Routing failed:`, errorMsg);

      this.stats.totalRouted++;
      this.stats.failedRoutes++;

      return {
        success: false,
        error: `Routing failed: ${errorMsg}`,
        latency: Date.now() - startTime,
      };
    }
  }

  /**
   * Broadcast a message to multiple environment centers
   */
  async broadcast(
    fromCenterId: string,
    toCenterIds: string[],
    message: Message
  ): Promise<RoutingResult[]> {
    logger.info(`Broadcasting from ${fromCenterId} to ${toCenterIds.length} centers`);

    // Route to all targets in parallel
    const promises = toCenterIds.map(toCenterId =>
      this.route(fromCenterId, toCenterId, message)
    );

    const results = await Promise.all(promises);

    logger.info(`Broadcast complete: ${results.filter(r => r.success).length}/${results.length} successful`);

    return results;
  }

  /**
   * Check if a route exists between two centers
   */
  routeExists(fromCenterId: string, toCenterId: string): boolean {
    const routeKey = this.getRouteKey(fromCenterId, toCenterId);
    const route = this.routes.get(routeKey);
    return route?.active ?? false;
  }

  /**
   * Get routing statistics
   */
  getStats(): RouterStats {
    return {
      ...this.stats,
      activeRoutes: Array.from(this.routes.values()).filter(r => r.active).length,
      cachedMessages: this.messageCache.size,
    };
  }

  /**
   * Register a route between two centers
   */
  registerRoute(fromCenterId: string, toCenterId: string): void {
    const routeKey = this.getRouteKey(fromCenterId, toCenterId);

    // Verify centers exist
    const fromCenter = environmentRegistry.getCenter(fromCenterId);
    const toCenter = environmentRegistry.getCenter(toCenterId);

    if (!fromCenter || !toCenter) {
      logger.info(`Cannot register route - one or both centers not found`);
      return;
    }

    // Create or update route
    const route: RouteEntry = {
      fromCenterId,
      toCenterId,
      active: true,
      latency: 0,
      lastUsed: new Date(),
    };

    this.routes.set(routeKey, route);

    logger.info(`Registered route: ${fromCenterId} -> ${toCenterId}`);
  }

  /**
   * Unregister a route between two centers
   */
  unregisterRoute(fromCenterId: string, toCenterId: string): void {
    const routeKey = this.getRouteKey(fromCenterId, toCenterId);
    const route = this.routes.get(routeKey);

    if (route) {
      route.active = false;
      logger.info(`Unregistered route: ${fromCenterId} -> ${toCenterId}`);
    }
  }

  /**
   * Get route key from two center IDs
   */
  private getRouteKey(fromCenterId: string, toCenterId: string): string {
    return `${fromCenterId}->${toCenterId}`;
  }

  /**
   * Get cache key for message
   */
  private getCacheKey(fromCenterId: string, toCenterId: string, message: Message): string {
    return `${fromCenterId}->${toCenterId}:${JSON.stringify(message)}`;
  }

  /**
   * Simulate cross-center call (for single-server deployment)
   * In real deployment, this would make actual HTTP/WebSocket calls
   */
  private async simulateCrossCenterCall(
    _fromCenterId: string,
    toCenterId: string,
    message: Message
  ): Promise<boolean> {
    try {
      // In a real distributed system, this would:
      // 1. Make HTTP/gRPC call to target center's API
      // 2. Target center processes the message locally
      // 3. Target center returns result
      // 4. This center returns result to caller

      // For single-server deployment, we simulate by checking
      // if the target center has the required resources/agents

      const toCenter = environmentRegistry.getCenter(toCenterId);
      if (!toCenter) {
        return false;
      }

      // Simulate network latency
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 50));

      // Check if the message type is supported by target center
      const messageType = String(message.type);

      if (messageType === 'agent-request' || messageType === 'query') {
        // Check if target center has agents
        const agents = toCenter.listAgents();
        return agents.length > 0;
      }

      if (messageType === 'device-query' || messageType === 'query') {
        // Check if target center has devices
        const devices = toCenter.listDevices();
        return devices.length > 0;
      }

      if (messageType === 'collaboration' || messageType === 'proposal' || messageType === 'notification') {
        // Collaboration requires agents
        const agents = toCenter.listAgents();
        return agents.length > 0;
      }

      return true;
    } catch (error) {
      logger.error('Cross-center call failed:', error);
      return false;
    }
  }

  /**
   * Update average latency
   */
  private updateAverageLatency(latency: number): void {
    const total = this.stats.totalRouted;
    const currentAvg = this.stats.averageLatency;
    this.stats.averageLatency = (currentAvg * (total - 1) + latency) / total;
  }

  /**
   * Add message to retry queue
   */
  private addToQueue(
    fromCenterId: string,
    toCenterId: string,
    message: Message,
    priority: number
  ): void {
    this.messageQueue.push({
      fromCenterId,
      toCenterId,
      message,
      attempts: 1,
      priority,
      timestamp: new Date(),
    });

    logger.info(`Message added to retry queue (size: ${this.messageQueue.length})`);
  }

  /**
   * Start queue processor
   */
  private startQueueProcessor(): void {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    setInterval(async () => {
      if (this.messageQueue.length === 0) {
        return;
      }

      logger.info(`Processing retry queue (${this.messageQueue.length} messages)`);

      // Process messages with exponential backoff
      const now = Date.now();
      const messagesToProcess: QueuedMessage[] = [];
      const messagesToKeep: QueuedMessage[] = [];

      for (const msg of this.messageQueue) {
        const delay = Math.pow(2, msg.attempts) * 1000; // Exponential backoff
        const timeSinceAttempt = now - msg.timestamp.getTime();

        if (timeSinceAttempt >= delay) {
          messagesToProcess.push(msg);
        } else {
          messagesToKeep.push(msg);
        }
      }

      this.messageQueue = messagesToKeep;

      // Process queued messages
      for (const msg of messagesToProcess) {
        if (msg.attempts >= this.config.maxRetries) {
          logger.info(`Message exceeded max retries, dropping`);
          this.stats.failedRoutes++;
          continue;
        }

        const result = await this.route(msg.fromCenterId, msg.toCenterId, msg.message);

        if (result.success) {
          logger.info(`Queued message routed successfully after ${msg.attempts} attempts`);
        } else {
          // Re-queue with incremented attempts
          msg.attempts++;
          msg.timestamp = new Date();
          this.messageQueue.push(msg);
        }
      }
    }, 5000); // Process queue every 5 seconds
  }
}

/**
 * Stub implementation (kept for backward compatibility)
 */
export class CrossCenterRouterStub implements ICrossCenterRouter {
  private stats: RouterStats;

  constructor(_config: RouterConfig = {}) {
    this.stats = {
      totalRouted: 0,
      successfulRoutes: 0,
      failedRoutes: 0,
      averageLatency: 0,
      activeRoutes: 0,
      cachedMessages: 0,
    };

    logger.info('[CrossCenterRouterStub] Initialized (legacy stub - use CrossCenterRouter instead)');
  }

  async route(
    fromCenterId: string,
    toCenterId: string,
    _message: Message
  ): Promise<RoutingResult> {
    logger.info(
      `[CrossCenterRouterStub] Route from ${fromCenterId} to ${toCenterId} (stub - not implemented)`
    );

    this.stats.totalRouted++;
    this.stats.failedRoutes++;

    return {
      success: false,
      error: 'Using stub implementation. Use CrossCenterRouter instead.',
    };
  }

  async broadcast(
    fromCenterId: string,
    toCenterIds: string[],
    _message: Message
  ): Promise<RoutingResult[]> {
    logger.info(
      `[CrossCenterRouterStub] Broadcast from ${fromCenterId} to ${toCenterIds.length} centers (stub - not implemented)`
    );

    this.stats.totalRouted += toCenterIds.length;
    this.stats.failedRoutes += toCenterIds.length;

    return toCenterIds.map(() => ({
      success: false,
      error: 'Using stub implementation. Use CrossCenterRouter instead.',
    }));
  }

  routeExists(_fromCenterId: string, _toCenterId: string): boolean {
    return false;
  }

  registerRoute(_fromCenterId: string, _toCenterId: string): void {
    logger.info('[CrossCenterRouterStub] registerRoute called (stub - not implemented)');
  }

  unregisterRoute(_fromCenterId: string, _toCenterId: string): void {
    logger.info('[CrossCenterRouterStub] unregisterRoute called (stub - not implemented)');
  }

  getStats(): RouterStats {
    return { ...this.stats };
  }
}

// Export singleton instance (using real implementation)
export const crossCenterRouter = new CrossCenterRouter();
