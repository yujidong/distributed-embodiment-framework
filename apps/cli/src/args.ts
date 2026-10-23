/**
 * Argument parsing — a strict wrapper over node:util parseArgs.
 *
 * Every command accepts the global flags too (`--server`, `--profile`,
 * `--lang`, `--json`, `--help`), so users can place them anywhere on the
 * line. Unknown flags and missing values are usage errors (exit 2), never
 * silent mis-parses.
 */

import { parseArgs } from 'node:util';

import { usageError } from './errors.js';

export interface FlagSpec {
  type: 'string' | 'boolean';
  short?: string;
  /** Allow the flag to repeat; values collect into an array. */
  multiple?: boolean;
}

/** Global flags every command accepts (merged into its own spec). */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  server: { type: 'string' },
  profile: { type: 'string' },
  lang: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export interface ParsedArgs {
  flags: Record<string, unknown>;
  positionals: string[];
}

export function parse(argv: string[], spec: Record<string, FlagSpec>, usage: string): ParsedArgs {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const [name, flag] of Object.entries({ ...GLOBAL_FLAGS, ...spec })) {
    options[name] = {
      type: flag.type,
      ...(flag.short ? { short: flag.short } : {}),
      ...(flag.multiple ? { multiple: true } : {}),
    };
  }
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { flags: values, positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`${message}\nusage: ${usage}`);
  }
}

export function stringFlag(flags: Record<string, unknown>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function requireString(flags: Record<string, unknown>, name: string, usage: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined || value.length === 0) {
    throw usageError(`missing required flag --${name}\nusage: ${usage}`);
  }
  return value;
}

export function boolFlag(flags: Record<string, unknown>, name: string): boolean {
  return flags[name] === true;
}

export function numberFlag(
  flags: Record<string, unknown>,
  name: string,
  usage: string,
): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw usageError(`flag --${name} must be a number, got ${JSON.stringify(raw)}\nusage: ${usage}`);
  }
  return value;
}

/** Comma-separated string flag → string[] (e.g. --capabilities a,b,c). */
export function csvFlag(flags: Record<string, unknown>, name: string): string[] | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  return raw.split(',').map(part => part.trim()).filter(part => part.length > 0);
}

/** JSON-valued string flag → parsed value (e.g. --params '{"on":true}'). */
export function jsonFlag<T = unknown>(
  flags: Record<string, unknown>,
  name: string,
  usage: string,
): T | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw usageError(`flag --${name} must be valid JSON, got ${JSON.stringify(raw)}\nusage: ${usage}`);
  }
}

/** Require exactly one positional argument. */
export function requirePositional(positionals: string[], label: string, usage: string): string {
  if (positionals.length === 0) {
    throw usageError(`missing <${label}> argument\nusage: ${usage}`);
  }
  if (positionals.length > 1) {
    throw usageError(`unexpected extra arguments: ${positionals.slice(1).join(' ')}\nusage: ${usage}`);
  }
  return positionals[0];
}

export function rejectExtraPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${usage}`);
  }
}
