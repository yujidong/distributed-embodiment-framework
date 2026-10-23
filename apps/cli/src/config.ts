/**
 * Session config — `~/.eaf/config.json` (override the directory with the
 * EAF_HOME env var, e.g. in tests or sandboxes).
 *
 * Stores the last server URL and the login token. The file is written
 * 0600 (owner-only); the token is never printed by any command.
 *
 * Profiles (Fix-10): with `--profile <name>` / `$EAF_PROFILE` the session
 * lives in `config-<name>.json` instead, so several accounts can share one
 * EAF_HOME without clobbering each other. No profile = `config.json`
 * (backwards compatible).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UiLocale } from '@active-collaboration/shared';
import { normalizeLocale } from '@active-collaboration/shared';

import type { IO } from './io.js';

export interface SessionConfig {
  server?: string;
  token?: string;
}

export const DEFAULT_SERVER = 'http://localhost:8100';

/** Profile names become file names — keep them path-safe. */
const PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidProfileName(profile: string): boolean {
  return PROFILE_PATTERN.test(profile);
}

export function configDir(io: IO): string {
  return io.env.EAF_HOME && io.env.EAF_HOME.length > 0
    ? io.env.EAF_HOME
    : join(io.homeDir, '.eaf');
}

export function configPath(io: IO, profile?: string): string {
  return join(configDir(io), profile ? `config-${profile}.json` : 'config.json');
}

export function loadConfig(io: IO, profile?: string): SessionConfig {
  try {
    const raw = readFileSync(configPath(io, profile), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const cfg = parsed as Record<string, unknown>;
    return {
      ...(typeof cfg.server === 'string' ? { server: cfg.server } : {}),
      ...(typeof cfg.token === 'string' ? { token: cfg.token } : {}),
    };
  } catch {
    return {};
  }
}

export function saveConfig(io: IO, config: SessionConfig, profile?: string): void {
  const dir = configDir(io);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath(io, profile);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions (Windows ACLs).
  }
}

/** Persist the token (login); keeps the server it was issued against. */
export function saveSession(io: IO, server: string, token: string, profile?: string): void {
  saveConfig(io, { server, token }, profile);
}

/** Drop the token (logout); keeps the server URL. */
export function clearSession(io: IO, profile?: string): void {
  const cfg = loadConfig(io, profile);
  delete cfg.token;
  saveConfig(io, cfg, profile);
}

/**
 * Server URL resolution, highest precedence first:
 * `--server` flag → EAF_SERVER env → saved config → http://localhost:8100.
 */
export function resolveServer(io: IO, flagServer?: string, profile?: string): string {
  const fromEnv = io.env.EAF_SERVER;
  const fromConfig = loadConfig(io, profile).server;
  const url = flagServer ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ?? fromConfig ?? DEFAULT_SERVER;
  return url.replace(/\/+$/, '');
}

/**
 * Language resolution, highest precedence first:
 * `--lang` flag → EAF_LANG env → default `en-US` (the CLI is English-first;
 * the server defaults to zh-CN because its URL is the public-facing one).
 *
 * Persistence to SessionConfig is intentionally NOT added — CLI users set
 * the env var in their shell profile. Adding a `lang` field to SessionConfig
 * is a one-line change if a per-profile preference is ever needed.
 */
export function resolveLang(io: IO, flagLang?: string): UiLocale {
  const fromEnv = io.env.EAF_LANG;
  const raw = flagLang ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ?? 'en-US';
  return normalizeLocale(raw);
}
