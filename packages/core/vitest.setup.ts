/**
 * Vitest setup for the packages/core default suite (Wave-6)
 *
 * Lowers the shared logger (@active-collaboration/shared) to WARN so test
 * runs stay quiet — the engine logs every tick/agent decision at INFO,
 * which used to bury failures (and bloat CI logs). Set
 * EAF_TEST_LOG_LEVEL=info (or debug) to restore the old verbosity for a
 * debugging session.
 */

import { configureLogger, LoggerLevel } from '@active-collaboration/shared';

const raw = (process.env.EAF_TEST_LOG_LEVEL ?? 'warn').toUpperCase();
const level = (LoggerLevel as Record<string, number>)[raw];

configureLogger({
  level: level ?? LoggerLevel.WARN,
  timestamps: false,
});
