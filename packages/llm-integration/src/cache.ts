/**
 * LLM Response Cache (P4-2)
 *
 * Caches chat responses keyed by a stable hash of the semantic request
 * (model, system prompt, user prompt, format, temperature). Repeated
 * simulation runs re-issue identical prompts at ~temperature 0, so cache
 * hits are free wins: no provider call, no queue wait.
 *
 * Two tiers:
 * - In-memory LRU (always on when caching is enabled, default 500 entries).
 * - Optional SQLite persistence: when `persistPath` is provided, entries are
 *   also written to a SQLite database so cache survives process restarts.
 *   SQLite access is best-effort: any error (missing driver, read-only fs,
 *   corrupt db) is logged and the cache degrades to in-memory only. The
 *   engine keeps the default in-memory-only cache; apps/server can opt into
 *   persistence by passing a path.
 *
 * Cache-key normalization (documented contract):
 * - Whitespace-insensitive: leading/trailing whitespace is trimmed and every
 *   run of internal whitespace (spaces, tabs, newlines) collapses to one
 *   space. LLMs are (near-)insensitive to this, and simulation prompt
 *   builders differ in incidental formatting.
 * - NOT case-insensitive: case can change tokenization and meaning.
 * - `format` is canonicalized with object keys sorted, so key order in a
 *   JSON schema does not matter.
 * - `temperature` defaults to the provider default when undefined — requests
 *   that omit temperature share entries with explicit-default requests ONLY
 *   if the number matches. Since we cannot know the provider-side default,
 *   undefined is treated as its own bucket ("default") — an explicit
 *   temperature: 0 does NOT collide with an omitted one. Callers that want
 *   cross-run hits should pin temperature explicitly.
 */

import { createHash } from 'crypto';
import { createLogger } from '@active-collaboration/shared';
import type { TokenUsage } from './types';

const logger = createLogger('LLMCache');

/**
 * Inputs that define a cacheable request. Everything that changes the
 * provider's response must be part of the key.
 */
export interface LLMCacheKeyInput {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  format?: 'json' | Record<string, unknown>;
  temperature?: number;
}

export interface LLMCacheEntry {
  response: string;
  usage?: TokenUsage;
  model: string;
  /** Epoch ms when the entry was stored. */
  storedAt: number;
}

export interface LLMCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  /** Sum of totalTokens of served cache hits — tokens the provider did NOT have to generate. */
  tokensSavedEstimate: number;
  size: number;
  maxSize: number;
}

export interface LLMCacheOptions {
  /** Maximum in-memory entries (LRU). Default 500. */
  maxSize?: number;
  /**
   * Optional SQLite file path for persistence across restarts.
   * Uses better-sqlite3 when available; degrades to in-memory on any error.
   */
  persistPath?: string;
}

/** Normalize free text for keying: trim + collapse internal whitespace runs. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Canonicalize a format value: sort object keys recursively for stable JSON. */
function canonicalizeFormat(format: LLMCacheKeyInput['format']): string {
  if (format === undefined) return '';
  if (format === 'json') return '"json"';
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortKeys(format));
}

/**
 * Build the stable cache key for a request.
 */
export function buildCacheKey(input: LLMCacheKeyInput): string {
  const payload = [
    input.provider,
    input.model,
    normalizeText(input.systemPrompt),
    normalizeText(input.userPrompt),
    canonicalizeFormat(input.format),
    input.temperature === undefined ? 'default' : String(input.temperature),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Minimal structural interface for the better-sqlite3 driver so this package
 * does not take a hard dependency on it (apps/server provides it).
 */
interface SqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
}

export class LLMCache {
  private readonly maxSize: number;
  /** Map insertion order doubles as LRU order (oldest first). */
  private readonly store = new Map<string, LLMCacheEntry>();
  private hits = 0;
  private misses = 0;
  private tokensSaved = 0;

  private db: SqliteDatabase | null = null;
  private dbGet: SqliteStatement | null = null;
  private dbSet: SqliteStatement | null = null;

  constructor(options: LLMCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 500;
    if (options.persistPath) {
      this.initPersistence(options.persistPath);
    }
  }

  /**
   * Look up a cached response. On hit, refreshes LRU position and records
   * stats. Returns undefined on miss.
   */
  get(key: string): LLMCacheEntry | undefined {
    let entry = this.store.get(key);
    if (entry) {
      // Refresh LRU position: delete + re-set moves to newest end.
      this.store.delete(key);
      this.store.set(key, entry);
    } else {
      entry = this.loadFromDb(key) ?? undefined;
      if (entry) {
        this.store.set(key, entry);
        this.evictIfNeeded();
      }
    }

    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.tokensSaved += entry.usage?.totalTokens ?? 0;
    return entry;
  }

  /**
   * Store a response. Writes through to SQLite when persistence is enabled.
   */
  set(key: string, entry: LLMCacheEntry): void {
    this.store.delete(key);
    this.store.set(key, entry);
    this.evictIfNeeded();
    this.saveToDb(key, entry);
  }

  getStats(): LLMCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      tokensSavedEstimate: this.tokensSaved,
      size: this.store.size,
      maxSize: this.maxSize,
    };
  }

  /** Clear stats counters (entries are kept). */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.tokensSaved = 0;
  }

  clear(): void {
    this.store.clear();
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  private initPersistence(persistPath: string): void {
    try {
      // Loaded lazily so the engine (which never persists) doesn't need the
      // native module installed. Resolved from the caller's node_modules.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      this.db = new Database(persistPath) as SqliteDatabase;
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, response TEXT, usage TEXT, model TEXT, stored_at INTEGER)'
      );
      this.dbGet = this.db.prepare('SELECT response, usage, model, stored_at FROM llm_cache WHERE key = ?');
      this.dbSet = this.db.prepare(
        'INSERT OR REPLACE INTO llm_cache (key, response, usage, model, stored_at) VALUES (?, ?, ?, ?, ?)'
      );
      logger.info(`SQLite persistence enabled at ${persistPath}`);
    } catch (error) {
      logger.warn(`SQLite persistence unavailable (${error instanceof Error ? error.message : String(error)}); using in-memory only`);
      this.db = null;
      this.dbGet = null;
      this.dbSet = null;
    }
  }

  private loadFromDb(key: string): LLMCacheEntry | null {
    if (!this.dbGet) return null;
    try {
      const row = this.dbGet.get(key) as
        | { response: string; usage: string | null; model: string; stored_at: number }
        | undefined;
      if (!row) return null;
      return {
        response: row.response,
        usage: row.usage ? (JSON.parse(row.usage) as TokenUsage) : undefined,
        model: row.model,
        storedAt: row.stored_at,
      };
    } catch (error) {
      logger.warn('SQLite read failed:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private saveToDb(key: string, entry: LLMCacheEntry): void {
    if (!this.dbSet) return;
    try {
      this.dbSet.run(
        key,
        entry.response,
        entry.usage ? JSON.stringify(entry.usage) : null,
        entry.model,
        entry.storedAt
      );
    } catch (error) {
      logger.warn('SQLite write failed:', error instanceof Error ? error.message : String(error));
    }
  }
}
