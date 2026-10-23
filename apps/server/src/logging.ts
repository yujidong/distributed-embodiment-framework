/**
 * Server logging setup — three tiers, all assembled here from ServerConfig:
 *
 * Tier 1 (env switches): config.logLevel drives BOTH the shared framework
 * logger (configureLogger) and the Fastify/pino HTTP logger (the returned
 * fastifyLogger.level); config.logModuleLevels feeds configureLogger's
 * prefix-matched per-module overrides.
 *
 * Tier 2 (built-in noise floor): the known per-tick modules of the
 * simulation engine (physics updates, heat-transfer dumps, per-device state
 * dumps) default to WARN so `speed=60` runs stay readable. LOG_LEVEL=debug
 * lifts this suppression entirely; EAF_LOG_MODULE_LEVELS entries override it
 * per module.
 *
 * File capture (LOG_FILE): when set, both log pipelines tee to a rotating
 * file in addition to stdout — the shared logger via setLogSink, pino via a
 * TeeStream destination. Unset keeps pure stdout (docker-friendly).
 */

import { inspect } from 'node:util';

import { configureLogger, LoggerLevel, setLogSink } from '@active-collaboration/shared';

import type { ServerConfig } from './config.js';
import { RotatingFileStream, TeeStream } from './log-file.js';

/**
 * Tier-2 built-in suppression: per-tick noise modules of the simulation
 * engine, held at WARN unless the operator opts into debug/verbose output.
 * Decision / collaboration / proposal / audit modules stay at INFO.
 *
 * DevLoop T-010: ThermalComfortModel joined the list after a 15-sim load
 * test showed it emitting multi-line PMV/PPD dumps per zone per tick at the
 * default info level — ~4.5MB/s of stdout (682MB in 2.5 min, a 16GB/day
 * pace that docker json-file drivers inherit). The list must track the
 * modules that actually log per tick, not just the ones that used to.
 */
const PER_TICK_QUIET_MODULES: Record<string, LoggerLevel> = {
  PhysicalEnvironment: LoggerLevel.WARN,
  PhysicsLayer: LoggerLevel.WARN,
  HeatTransferModel: LoggerLevel.WARN,
  ThermalComfortModel: LoggerLevel.WARN,
  StateInterpolator: LoggerLevel.WARN,
  EffectSource: LoggerLevel.WARN,
  BaseDevice: LoggerLevel.WARN,
  SimulatedDevice: LoggerLevel.WARN,
};

const LEVEL_NAME_TO_ENUM: Record<ServerConfig['logLevel'], LoggerLevel> = {
  debug: LoggerLevel.DEBUG,
  info: LoggerLevel.INFO,
  warn: LoggerLevel.WARN,
  error: LoggerLevel.ERROR,
  silent: LoggerLevel.SILENT,
};

export interface LoggingSetup {
  /** Fastify `logger` option (level + optional tee stream for LOG_FILE). */
  fastifyLogger: { level: string; stream?: TeeStream };
  /** The rotating destination when LOG_FILE is set; end() it on shutdown. */
  rotatingLog: RotatingFileStream | null;
}

export function setupLogging(config: ServerConfig): LoggingSetup {
  // Tier 2: suppression defaults apply unless the global level is debug
  // (debug means "show me everything"); env overrides win per module.
  const moduleLevels: Record<string, LoggerLevel> = {
    ...(config.logLevel === 'debug' ? {} : PER_TICK_QUIET_MODULES),
    ...config.logModuleLevels,
  };
  configureLogger({ level: LEVEL_NAME_TO_ENUM[config.logLevel], moduleLevels });

  if (!config.logFile) {
    return { fastifyLogger: { level: config.logLevel }, rotatingLog: null };
  }

  const rotatingLog = new RotatingFileStream(config.logFile, {
    maxSize: config.logMaxSize,
    maxFiles: config.logMaxFiles,
  });

  // Shared logger tee: console output is preserved; a serialized copy of the
  // same line (args appended via util.inspect) lands in the rotating file.
  setLogSink((level, message, args) => {
    console[level](message, ...args);
    const argSuffix =
      args.length > 0
        ? ` ${args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 4 }))).join(' ')}`
        : '';
    rotatingLog.write(`${message}${argSuffix}\n`);
  });

  return {
    fastifyLogger: { level: config.logLevel, stream: new TeeStream([process.stdout, rotatingLog]) },
    rotatingLog,
  };
}
