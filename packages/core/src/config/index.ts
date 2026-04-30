/**
 * Configuration Module
 *
 * Provides declarative configuration capabilities for the Active Collaboration IoT platform.
 * This module enables users to define environments, devices, agents, and autonomous behaviors
 * through configuration files (JSON/YAML) instead of code.
 */

// Types
export * from './types';

// Loader and Validator
export { ConfigLoader } from './ConfigLoader';
export { ConfigValidator } from './ConfigValidator';

// Storage and Hot Reload
export { ConfigStorage } from './ConfigStorage';
export type { StorageOptions, ConfigMetadata } from './ConfigStorage';

export { ConfigHotReloader } from './ConfigHotReloader';
export type { HotReloadOptions, WatchHandle } from './ConfigHotReloader';
