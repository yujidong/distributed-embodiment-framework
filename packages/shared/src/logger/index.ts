/**
 * Structured Logger for Active Collaboration IoT Framework
 *
 * Provides consistent logging across all packages with:
 * - Module/component prefixes for traceability
 * - Log level filtering
 * - Structured context data
 * - Lazy evaluation for performance
 */

/**
 * Numeric log levels for filtering.
 * Re-uses the LogLevel type from types/index.ts ('info' | 'warn' | 'error' | 'debug')
 * but provides a numeric enum for comparison-based filtering.
 */
export enum LoggerLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/** Logger configuration */
export interface LoggerConfig {
  /** Minimum log level to output */
  level: LoggerLevel;
  /** Include timestamps in output */
  timestamps: boolean;
  /** Include module prefix */
  prefix: boolean;
  /**
   * Per-module log level overrides.
   * Keys are module names (matched by prefix, e.g. 'SimulatedDevice' matches '[SimulatedDevice:...]').
   * Values are the minimum level to output for that module.
   *
   * @example
   * // Suppress noisy physics/device logs while keeping decision logs:
   * moduleLevels: {
   *   'SimulatedDevice': LoggerLevel.WARN,
   *   'PhysicsLayer': LoggerLevel.WARN,
   *   'GridPhysicsEngine': LoggerLevel.WARN,
   * }
   */
  moduleLevels?: Record<string, LoggerLevel>;
}

const DEFAULT_CONFIG: LoggerConfig = {
  level: LoggerLevel.INFO,
  timestamps: true,
  prefix: true,
};

let globalConfig: LoggerConfig = { ...DEFAULT_CONFIG };

/**
 * Optional output sink for emitted log lines. When set, it replaces the
 * default `console.*` output — the server installs a tee sink (console +
 * rotating log file) at startup. Receives the level, the fully formatted
 * message, and the extra args; level filtering has already been applied,
 * so a SILENT/filtered module never reaches the sink. Tests leave this
 * null and keep the plain console behavior.
 */
export type LogSink = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  args: unknown[],
) => void;

let logSink: LogSink | null = null;

/**
 * Install (or clear, with `null`) the global output sink.
 */
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

/**
 * Configure the global logger settings
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

/**
 * Get the current log level
 */
export function getLoggerLevel(): LoggerLevel {
  return globalConfig.level;
}

/**
 * Resolve effective log level for a module.
 * Checks module-level overrides first (prefix match), falls back to global.
 */
function resolveLevel(module: string): LoggerLevel {
  const moduleLevels = globalConfig.moduleLevels;
  if (moduleLevels) {
    // Exact match first, then prefix match
    if (moduleLevels[module] !== undefined) return moduleLevels[module];
    for (const [key, level] of Object.entries(moduleLevels)) {
      if (module.startsWith(key)) return level;
    }
  }
  return globalConfig.level;
}

/**
 * Create a scoped logger for a specific module/component
 *
 * @example
 * const logger = createLogger('CognitiveAgent');
 * logger.info('Agent initialized', { agentId: 'agent-1' });
 * logger.error('Decision failed', error);
 */
export function createLogger(module: string) {
  const formatMessage = (level: string, message: string): string => {
    const parts: string[] = [];
    if (globalConfig.timestamps) {
      parts.push(new Date().toISOString());
    }
    if (globalConfig.prefix) {
      parts.push(`[${module}]`);
    }
    parts.push(`[${level}]`);
    parts.push(message);
    return parts.join(' ');
  };

  const emit = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    args: unknown[],
  ): void => {
    if (logSink) {
      logSink(level, message, args);
      return;
    }
    console[level](message, ...args);
  };

  return {
    debug(message: string, ...args: unknown[]): void {
      if (resolveLevel(module) <= LoggerLevel.DEBUG) {
        emit('debug', formatMessage('DEBUG', message), args);
      }
    },

    info(message: string, ...args: unknown[]): void {
      if (resolveLevel(module) <= LoggerLevel.INFO) {
        emit('info', formatMessage('INFO', message), args);
      }
    },

    warn(message: string, ...args: unknown[]): void {
      if (resolveLevel(module) <= LoggerLevel.WARN) {
        emit('warn', formatMessage('WARN', message), args);
      }
    },

    error(message: string, ...args: unknown[]): void {
      if (resolveLevel(module) <= LoggerLevel.ERROR) {
        emit('error', formatMessage('ERROR', message), args);
      }
    },
  };
}

/**
 * Type-safe logger interface for dependency injection
 */
export type Logger = ReturnType<typeof createLogger>;
