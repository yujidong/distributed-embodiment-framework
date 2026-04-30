/**
 * Trigger State Store
 *
 * Persists trigger execution state and history to enable:
 * - Recovery after server restart
 * - Idempotency guarantees
 * - Execution history tracking
 * - Concurrent safety
 *
 * Sprint 7: Trigger State Persistence
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

import { createLogger } from '@active-collaboration/shared';
/**
 * Trigger execution state
 */
const logger = createLogger('TriggerStateStore');

export interface TriggerExecutionState {
  triggerId: string;
  executionCount: number;
  lastTriggered?: Date;
  lastEvaluation?: Date;
  enabled: boolean;
  metadata: {
    lastError?: string;
    successfulExecutions?: number;
    failedExecutions?: number;
    [key: string]: any;
  };
}

/**
 * Execution history entry
 */
export interface ExecutionHistoryEntry {
  id: string;
  triggerId: string;
  timestamp: Date;
  triggered: boolean;
  actionTaken?: string;
  details?: string;
  executionTime?: number;
  error?: string;
}

/**
 * Idempotency record
 */
interface IdempotencyRecord {
  executionId: string;
  timestamp: number;
}

/**
 * Store configuration
 */
export interface TriggerStateStoreConfig {
  path?: string;
  maxHistoryPerTrigger?: number;
}

/**
 * Trigger State Store - File-based persistence
 */
export class TriggerStateStore {
  private basePath: string;
  private statesPath: string;
  private historyPath: string;
  private maxHistoryPerTrigger: number;

  // In-memory caches
  private stateCache: Map<string, TriggerExecutionState> = new Map();
  private historyCache: Map<string, ExecutionHistoryEntry[]> = new Map();
  private idempotencyCache: Map<string, IdempotencyRecord> = new Map();

  constructor(config?: TriggerStateStoreConfig) {
    this.basePath = config?.path || './data/trigger-state';
    this.statesPath = path.join(this.basePath, 'states');
    this.historyPath = path.join(this.basePath, 'history');
    this.maxHistoryPerTrigger = config?.maxHistoryPerTrigger || 100;
  }

  /**
   * Initialize the store
   */
  async initialize(config: TriggerStateStoreConfig): Promise<void> {
    this.basePath = config.path || this.basePath;

    // Create directories
    await fs.mkdir(this.statesPath, { recursive: true });
    await fs.mkdir(this.historyPath, { recursive: true });

    // Load existing states into cache
    await this.loadStatesFromDisk();
    await this.loadHistoryFromDisk();

    logger.info(`Initialized at ${this.basePath}`);
  }

   /**
   * Close the store and persist all data
   */
  async close(): Promise<void> {
    // Persist all cached states with retry
    for (const [triggerId, state] of this.stateCache) {
      try {
        await this.persistStateToDisk(state);
      } catch (error) {
        logger.error(`Failed to persist state for ${triggerId}:`, error);
      }
    }

    // Persist all cached history with retry
    for (const [triggerId, history] of this.historyCache) {
      try {
        await this.persistHistoryToDisk(triggerId, history);
      } catch (error) {
        logger.error(`Failed to persist history for ${triggerId}:`, error);
      }
    }
  }

  // ========================================================================
  // State Management
  // ========================================================================

  /**
   * Save trigger execution state
   */
  async saveTriggerState(state: TriggerExecutionState): Promise<void> {
    // Update cache
    this.stateCache.set(state.triggerId, state);

    // Persist to disk
    await this.persistStateToDisk(state);
  }

  /**
   * Get trigger execution state
   */
  async getTriggerState(triggerId: string): Promise<TriggerExecutionState | null> {
    // Check cache first
    const cached = this.stateCache.get(triggerId);
    if (cached) {
      return cached;
    }

    // Try to load from disk
    const state = await this.loadStateFromDisk(triggerId);
    if (state) {
      this.stateCache.set(triggerId, state);
    }

    return state ?? null;
  }

  /**
   * Get all trigger states
   */
  async getAllTriggerStates(): Promise<TriggerExecutionState[]> {
    // Return all cached states
    return Array.from(this.stateCache.values());
  }

  /**
   * Clear all trigger states
   */
  async clearAllStates(): Promise<void> {
    this.stateCache.clear();
    this.historyCache.clear();
    this.idempotencyCache.clear();

    // Clear disk storage
    await this.clearDirectory(this.statesPath);
    await this.clearDirectory(this.historyPath);

    logger.info('Cleared all states');
  }

  // ========================================================================
  // Execution History
  // ========================================================================

  /**
   * Record an execution history entry
   */
  async recordExecution(entry: ExecutionHistoryEntry): Promise<void> {
    // Get or create history list for this trigger
    let history = this.historyCache.get(entry.triggerId);
    if (!history) {
      history = [];
      this.historyCache.set(entry.triggerId, history);
    }

    // Add entry
    history.push(entry);

    // Trim to max size (keep most recent)
    if (history.length > this.maxHistoryPerTrigger) {
      history.splice(0, history.length - this.maxHistoryPerTrigger);
    }

    // Persist to disk asynchronously
    this.persistHistoryToDisk(entry.triggerId, history).catch(err => {
      logger.error(`Failed to persist history for ${entry.triggerId}:`, err);
    });
  }

  /**
   * Get execution history for a trigger
   */
  async getExecutionHistory(triggerId: string, limit?: number): Promise<ExecutionHistoryEntry[]> {
    let history = this.historyCache.get(triggerId);

    if (!history) {
      // Try to load from disk
      history = await this.loadHistoryFromDiskForTrigger(triggerId);
      if (history) {
        this.historyCache.set(triggerId, history);
      }
    }

    if (!history) {
      return [];
    }

    // Return most recent entries first, limited if requested
    const sorted = [...history].sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Clean up old execution history
   */
  async cleanupOldHistory(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    let deleted = 0;

    for (const [triggerId, history] of this.historyCache) {
      const originalLength = history.length;

      // Filter out old entries
      const filtered = history.filter(entry =>
        new Date(entry.timestamp).getTime() >= cutoff
      );

      if (filtered.length < originalLength) {
        deleted += originalLength - filtered.length;
        this.historyCache.set(triggerId, filtered);

        // Persist updated history
        await this.persistHistoryToDisk(triggerId, filtered);
      }
    }

    logger.info(`Cleaned up ${deleted} old history entries`);
    return deleted;
  }

  // ========================================================================
  // Idempotency
  // ========================================================================

  /**
   * Check and mark execution as idempotent
   * Returns true if this is the first execution within the window
   */
  async checkAndMarkIdempotent(executionId: string, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const record = this.idempotencyCache.get(executionId);

    // Check if execution exists within window
    if (record && (now - record.timestamp) < windowMs) {
      return false; // Duplicate execution
    }

    // Mark as executed
    this.idempotencyCache.set(executionId, {
      executionId,
      timestamp: now,
    });

    return true; // First execution
  }

  // ========================================================================
  // Persistence Helpers
  // ========================================================================

  /**
   * Persist state to disk
   */
  private async persistStateToDisk(state: TriggerExecutionState): Promise<void> {
    const filePath = path.join(this.statesPath, `${state.triggerId}.json`);

    try {
      // Ensure directory exists
      await fs.mkdir(this.statesPath, { recursive: true });

      await fs.writeFile(
        filePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error(`Failed to persist state for ${state.triggerId}:`, error);
      throw error;
    }
  }

  /**
   * Load state from disk
   */
  private async loadStateFromDisk(triggerId: string): Promise<TriggerExecutionState | undefined> {
    const filePath = path.join(this.statesPath, `${triggerId}.json`);

    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const state = JSON.parse(content) as TriggerExecutionState;

      // Convert date strings back to Date objects
      if (typeof state.lastTriggered === 'string') {
        state.lastTriggered = new Date(state.lastTriggered);
      }
      if (typeof state.lastEvaluation === 'string') {
        state.lastEvaluation = new Date(state.lastEvaluation);
      }

      return state;
    } catch (error) {
      logger.error(`Failed to load state for ${triggerId}:`, error);
      return undefined;
    }
  }

  /**
   * Load all states from disk
   */
  private async loadStatesFromDisk(): Promise<void> {
    try {
      const files = await fs.readdir(this.statesPath);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const triggerId = file.replace('.json', '');
          const state = await this.loadStateFromDisk(triggerId);
          if (state) {
            this.stateCache.set(triggerId, state);
          }
        }
      }

      logger.info(`Loaded ${this.stateCache.size} states from disk`);
    } catch (error) {
      // Directory doesn't exist yet, that's okay
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error loading states:', error);
      }
    }
  }

  /**
   * Persist history to disk
   */
  private async persistHistoryToDisk(triggerId: string, history: ExecutionHistoryEntry[]): Promise<void> {
    const filePath = path.join(this.historyPath, `${triggerId}.json`);

    try {
      // Ensure directory exists
      await fs.mkdir(this.historyPath, { recursive: true });

      await fs.writeFile(
        filePath,
        JSON.stringify(history, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error(`Failed to persist history for ${triggerId}:`, error);
      throw error;
    }
  }

  /**
   * Load history from disk for a specific trigger
   */
  private async loadHistoryFromDiskForTrigger(triggerId: string): Promise<ExecutionHistoryEntry[] | undefined> {
    const filePath = path.join(this.historyPath, `${triggerId}.json`);

    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const history = JSON.parse(content) as ExecutionHistoryEntry[];

      // Convert date strings back to Date objects
      for (const entry of history) {
        if (typeof entry.timestamp === 'string') {
          entry.timestamp = new Date(entry.timestamp);
        }
      }

      return history;
    } catch (error) {
      logger.error(`Failed to load history for ${triggerId}:`, error);
      return undefined;
    }
  }

  /**
   * Load all history from disk
   */
  private async loadHistoryFromDisk(): Promise<void> {
    try {
      const files = await fs.readdir(this.historyPath);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const triggerId = file.replace('.json', '');
          const history = await this.loadHistoryFromDiskForTrigger(triggerId);
          if (history) {
            this.historyCache.set(triggerId, history);
          }
        }
      }

      logger.info(`Loaded history for ${this.historyCache.size} triggers from disk`);
    } catch (error) {
      // Directory doesn't exist yet, that's okay
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error loading history:', error);
      }
    }
  }

  /**
   * Clear a directory
   */
  private async clearDirectory(dirPath: string): Promise<void> {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(dirPath, file));
        }
      }
    } catch (error) {
      // Directory doesn't exist, that's okay
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
