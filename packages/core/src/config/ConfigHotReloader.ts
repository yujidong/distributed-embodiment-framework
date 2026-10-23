/**
 * Configuration Hot Reloader
 *
 * Watches configuration files for changes and triggers reload when modified.
 * Supports debouncing to prevent rapid re-reloads during file saves.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DeclarativeConfig } from './types';
import { ConfigLoader } from './ConfigLoader';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('ConfigHotReloader');

export interface HotReloadOptions {
  debounceMs?: number;      // Debounce interval (default: 1000ms)
  ignoreInitial?: boolean;  // Ignore initial load event
  validateOnChange?: boolean; // Validate config before triggering callback
}

export interface WatchHandle {
  id: string;
  path: string;
  stop(): void;
}

type ChangeCallback = (config: DeclarativeConfig, filePath: string) => void | Promise<void>;
type ErrorCallback = (error: Error, filePath: string) => void;

/**
 * Hot reloader for configuration files
 */
export class ConfigHotReloader {
  private loader: ConfigLoader;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private callbacks: Map<string, Set<ChangeCallback>> = new Map();
  private errorCallbacks: Set<ErrorCallback> = new Set();
  private options: HotReloadOptions;

  constructor(loader: ConfigLoader, options: HotReloadOptions = {}) {
    this.loader = loader;
    this.options = {
      debounceMs: 1000,
      ignoreInitial: false,
      validateOnChange: true,
      ...options,
    };
  }

  /**
   * Watch a configuration file for changes
   */
  watch(
    filePath: string,
    onChange: ChangeCallback,
    onError?: ErrorCallback
  ): WatchHandle {
    const absolutePath = path.resolve(filePath);

    // Add callback
    if (!this.callbacks.has(absolutePath)) {
      this.callbacks.set(absolutePath, new Set());
    }
    this.callbacks.get(absolutePath)!.add(onChange);

    if (onError) {
      this.errorCallbacks.add(onError);
    }

    // Create watcher if not already watching
    if (!this.watchers.has(absolutePath)) {
      const watcher = fs.watch(
        absolutePath,
        (eventType) => {
          if (eventType === 'change') {
            this.handleChange(absolutePath);
          }
        }
      );

      watcher.on('error', (error) => {
        this.handleError(error, absolutePath);
      });

      this.watchers.set(absolutePath, watcher);

      // Trigger initial load if not ignored
      if (!this.options.ignoreInitial) {
        this.handleChange(absolutePath);
      }
    }

    return {
      id: absolutePath,
      path: absolutePath,
      stop: () => this.stopWatching(absolutePath, onChange),
    };
  }

  /**
   * Watch a directory for changes to any configuration files
   */
  watchDirectory(
    dirPath: string,
    onChange: ChangeCallback,
    onError?: ErrorCallback
  ): WatchHandle {
    const absolutePath = path.resolve(dirPath);

    // Ensure directory exists
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
    }

    // Watch the directory
    const watcher = fs.watch(
      absolutePath,
      { recursive: false },
      (eventType, filename) => {
        if (!filename) return;

        const ext = path.extname(filename).toLowerCase();
        if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') return;

        if (eventType === 'change' || eventType === 'rename') {
          const filePath = path.join(absolutePath, filename);
          if (fs.existsSync(filePath)) {
            this.handleChange(filePath, onChange);
          }
        }
      }
    );

    const handleId = `dir:${absolutePath}`;
    this.watchers.set(handleId, watcher);

    if (onError) {
      this.errorCallbacks.add(onError);
    }

    return {
      id: handleId,
      path: absolutePath,
      stop: () => {
        watcher.close();
        this.watchers.delete(handleId);
      },
    };
  }

  /**
   * Stop watching a specific file
   */
  stopWatching(filePath: string, callback?: ChangeCallback): void {
    const absolutePath = path.resolve(filePath);

    // Remove callback
    if (callback) {
      const callbacks = this.callbacks.get(absolutePath);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.callbacks.delete(absolutePath);
        }
      }
    } else {
      this.callbacks.delete(absolutePath);
    }

    // Close watcher if no more callbacks
    if (!this.callbacks.has(absolutePath)) {
      const watcher = this.watchers.get(absolutePath);
      if (watcher) {
        watcher.close();
        this.watchers.delete(absolutePath);
      }

      // Clear any pending debounce timer
      const timer = this.debounceTimers.get(absolutePath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(absolutePath);
      }
    }
  }

  /**
   * Stop all watchers
   */
  stopAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.callbacks.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Manually reload a configuration file
   */
  async reload(filePath: string): Promise<DeclarativeConfig> {
    const absolutePath = path.resolve(filePath);
    const config = await this.loader.load(absolutePath);

    // Trigger callbacks
    const callbacks = this.callbacks.get(absolutePath);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          await callback(config, absolutePath);
        } catch (error) {
          this.handleError(error as Error, absolutePath);
        }
      }
    }

    return config;
  }

  /**
   * Check if currently watching a file
   */
  isWatching(filePath: string): boolean {
    const absolutePath = path.resolve(filePath);
    return this.watchers.has(absolutePath);
  }

  /**
   * Get list of watched files
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchers.keys()).filter(
      key => !key.startsWith('dir:')
    );
  }

  /**
   * Add global error callback
   */
  onError(callback: ErrorCallback): void {
    this.errorCallbacks.add(callback);
  }

  /**
   * Remove global error callback
   */
  offError(callback: ErrorCallback): void {
    this.errorCallbacks.delete(callback);
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Handle file change with debouncing
   */
  private handleChange(filePath: string, specificCallback?: ChangeCallback): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      await this.processChange(filePath, specificCallback);
    }, this.options.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process file change
   */
  private async processChange(
    filePath: string,
    specificCallback?: ChangeCallback
  ): Promise<void> {
    try {
      // Check if file still exists
      if (!fs.existsSync(filePath)) {
        return;
      }

      // Load configuration
      const config = await this.loader.load(filePath);

      // Validate if enabled
      if (this.options.validateOnChange) {
        const validation = this.loader.validate(config);
        if (!validation.valid) {
          const error = new Error(
            `Configuration validation failed: ${validation.errors.map((e: { message: string }) => e.message).join(', ')}`
          );
          this.handleError(error, filePath);
          return;
        }
      }

      // Trigger callbacks
      if (specificCallback) {
        await specificCallback(config, filePath);
      } else {
        const callbacks = this.callbacks.get(filePath);
        if (callbacks) {
          for (const callback of callbacks) {
            try {
              await callback(config, filePath);
            } catch (error) {
              this.handleError(error as Error, filePath);
            }
          }
        }
      }

    } catch (error) {
      this.handleError(error as Error, filePath);
    }
  }

  /**
   * Handle error
   */
  private handleError(error: Error, filePath: string): void {
    logger.error(`Error for ${filePath}:`, error.message);

    for (const callback of this.errorCallbacks) {
      try {
        callback(error, filePath);
      } catch (callbackError) {
        logger.error('Error in error callback:', callbackError);
      }
    }
  }
}
