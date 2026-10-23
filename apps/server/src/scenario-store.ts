/**
 * Scenario Store — two-source JSON file store for scenarios
 *
 * Sources (merged, user shadows seed on id collision):
 * - `seedDir` — bundled read-only scenarios (repo `config/scenarios/*.json`).
 *   Never written by the API; PUT/DELETE against a seed id is a 403.
 * - `userDir` — user-created scenarios (`data/scenarios/*.json` by default).
 *   Created on startup; the only directory this store writes to.
 *
 * Files are named `<scenario-id>.json` and validated with the core scenario
 * loader (`loadScenarioFile` / `loadScenarioFromFile`). Invalid files are
 * skipped (with a warning) rather than failing the whole listing. Because
 * ids become file names, ids must match `SAFE_ID_PATTERN` — this is enforced
 * on writes, and lookups with unsafe ids simply miss.
 *
 * T-031 (DevLoop R17): user files persist the RAW uploaded document verbatim
 * (validated through the loader, stored byte-for-byte). The loader-NORMALIZED
 * definition used to be what got written, which silently stripped every field
 * the loader does not model — the geo `map` block, zone `polygon`s, device
 * `brand`/`position` — so a saved geo scenario re-imported as a grid world.
 * `StoredScenario.document` is the raw doc (served verbatim by the API);
 * `StoredScenario.definition` is the normalized form for internal use
 * (engine creation, list counts).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  loadScenarioFile,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '@active-collaboration/core';
import { localizedText } from '@active-collaboration/shared';

import { ApiError } from './errors.js';

export type ScenarioSource = 'seed' | 'user';

/**
 * T-033: one cached scenario file. `definition: null` means the file exists
 * but failed validation — cached so the skip verdict (and its warning) is
 * computed once per file version, not once per list request.
 */
interface CachedScenarioFile {
  mtimeMs: number;
  size: number;
  document: unknown;
  definition: ScenarioDefinition | null;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  source: ScenarioSource;
  counts: { zones: number; devices: number; agents: number; events: number };
  /**
   * Wave 2 / F3: marketing tagline for the scenario list UI. Optional —
   * older scenarios may not have one.
   */
  tagline?: { zh: string; en: string };
  /**
   * Wave 2 / F4: event id that should be the demo "hero moment". The
   * UI can auto-focus the camera on this event when the sim reaches it.
   */
  heroEventId?: string;
  /** Wave 2: demo playback rate hint (1 = real-time). */
  recommendedPlaybackRate?: number;
  /** Wave 2: short disclaimer about vendor names used illustratively. */
  vendorDisclaimer?: string;
}

export interface StoredScenario {
  /**
   * T-031: the raw uploaded document, exactly as persisted. Served verbatim
   * by GET /api/scenarios/:id so fields outside the loader's model (map
   * block, polygons, brand/position, …) survive the save→read round-trip.
   */
  document: unknown;
  /** Loader-normalized form — internal use only (engine creation, counts). */
  definition: ScenarioDefinition;
  source: ScenarioSource;
}

/** Ids usable as a single safe file name (no separators, no dot segments). */
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Minimal logger contract (satisfied by fastify's pino logger). */
export interface StoreLogger {
  warn: (obj: unknown, msg: string) => void;
}

export class ScenarioStore {
  /**
   * T-033 (DevLoop R17, EC-F12): per-file parse/validate cache keyed on
   * (path, mtimeMs, size). GET /api/scenarios re-validated every user file
   * on every anonymous request (~130ms with one 2MB saved replay) because
   * each load pays JSON.parse + a full ajv schema compile. PER-FILE mtime
   * (never dir mtime — appending to a file does not touch the dir) + size
   * makes the cache self-invalidating against both store writes and
   * out-of-band edits; `null` entries cache invalid files so a broken file
   * is warned about once, not once per request.
   */
  private readonly fileCache = new Map<string, CachedScenarioFile>();

  constructor(
    private readonly seedDir: string,
    private readonly userDir: string,
    private readonly log?: StoreLogger,
  ) {
    mkdirSync(userDir, { recursive: true });
  }

  /** Summaries of all scenarios, user entries shadowing same-id seeds. */
  list(): ScenarioSummary[] {
    const summaries: ScenarioSummary[] = [];
    const seen = new Set<string>();
    for (const source of ['user', 'seed'] as const) {
      const dir = source === 'user' ? this.userDir : this.seedDir;
      for (const definition of this.readDir(dir)) {
        if (seen.has(definition.meta.id)) continue;
        seen.add(definition.meta.id);
        summaries.push({
          id: definition.meta.id,
          name: localizedText(definition.meta.name, 'zh-CN'),
          description: localizedText(definition.meta.description, 'zh-CN'),
          source,
          counts: {
            zones: definition.zones.length,
            devices: definition.devices.length,
            agents: definition.agents.length,
            events: definition.events.length,
          },
          ...(definition.meta.tagline ? { tagline: definition.meta.tagline } : {}),
          ...(definition.meta.heroEventId ? { heroEventId: definition.meta.heroEventId } : {}),
          ...(definition.meta.recommendedPlaybackRate !== undefined ? { recommendedPlaybackRate: definition.meta.recommendedPlaybackRate } : {}),
          ...(definition.meta.vendorDisclaimer ? { vendorDisclaimer: localizedText(definition.meta.vendorDisclaimer, 'zh-CN') } : {}),
        });
      }
    }
    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Full stored scenario by id (user store first, then seeds). */
  get(id: string): StoredScenario | null {
    const user = this.readDocument(id, 'user');
    if (user) return user;
    return this.readDocument(id, 'seed');
  }

  /**
   * Validate + persist a new user scenario (T-031: the RAW document is what
   * gets written; the normalized form is derived for internal use).
   * @throws ApiError 400 on validation failure, 409 on duplicate id.
   */
  create(json: unknown): StoredScenario {
    const definition = validateScenario(json);
    assertSafeId(definition.meta.id);
    if (this.get(definition.meta.id) !== null) {
      throw new ApiError(
        409,
        'SCENARIO_EXISTS',
        `Scenario "${definition.meta.id}" already exists`,
      );
    }
    this.writeUser(definition.meta.id, json, definition);
    return { document: json, definition, source: 'user' };
  }

  /**
   * Replace an existing USER scenario. Seeds are read-only (403). The body
   * id must match the path id (no renames via PUT).
   */
  replace(id: string, json: unknown): StoredScenario {
    const existing = this.get(id);
    if (!existing) {
      throw new ApiError(404, 'SCENARIO_NOT_FOUND', `Scenario "${id}" not found`);
    }
    if (existing.source === 'seed') {
      throw new ApiError(
        403,
        'SCENARIO_READONLY',
        `Scenario "${id}" is a bundled seed and is read-only`,
      );
    }
    const definition = validateScenario(json);
    assertSafeId(definition.meta.id);
    if (definition.meta.id !== id) {
      throw new ApiError(
        400,
        'SCENARIO_ID_MISMATCH',
        `Body meta.id "${definition.meta.id}" does not match path id "${id}"`,
      );
    }
    this.writeUser(id, json, definition);
    return { document: json, definition, source: 'user' };
  }

  /** Delete a user scenario. Seeds are read-only (403). */
  remove(id: string): void {
    const existing = this.get(id);
    if (!existing) {
      throw new ApiError(404, 'SCENARIO_NOT_FOUND', `Scenario "${id}" not found`);
    }
    if (existing.source === 'seed') {
      throw new ApiError(
        403,
        'SCENARIO_READONLY',
        `Scenario "${id}" is a bundled seed and is read-only`,
      );
    }
    const file = join(this.userDir, `${id}.json`);
    unlinkSync(file);
    this.fileCache.delete(file);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Load every `*.json` in a directory; invalid files are skipped. */
  private readDir(dir: string): ScenarioDefinition[] {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(name => name.endsWith('.json'));
    } catch {
      return []; // directory missing/unreadable — treat as empty
    }
    const definitions: ScenarioDefinition[] = [];
    for (const entry of entries) {
      const cached = this.loadFile(join(dir, entry));
      if (cached !== null && cached.definition !== null) {
        definitions.push(cached.definition);
      }
    }
    return definitions;
  }

  /**
   * Load one scenario file by id (raw document + normalized definition), or
   * null when missing/invalid/unsafe id. The raw document is what GET serves;
   * the normalized form validates it is still loadable and powers the engine.
   */
  private readDocument(id: string, source: ScenarioSource): StoredScenario | null {
    if (!SAFE_ID_PATTERN.test(id)) return null;
    const dir = source === 'user' ? this.userDir : this.seedDir;
    const cached = this.loadFile(join(dir, `${id}.json`));
    if (cached === null || cached.definition === null) return null;
    if (cached.definition.meta.id !== id) {
      this.log?.warn(
        { file: `${id}.json`, actualId: cached.definition.meta.id },
        'Scenario file name / meta.id mismatch — ignoring',
      );
      return null;
    }
    return { document: cached.document, definition: cached.definition, source };
  }

  /**
   * Read + parse + validate one file through the (path, mtime, size) cache
   * (T-033). Cache hits skip JSON.parse and the ajv schema compile entirely;
   * a stat mismatch (store write or out-of-band edit) reloads that ONE file.
   * Invalid files cache as `definition: null` and warn exactly once.
   */
  private loadFile(file: string): CachedScenarioFile | null {
    let mtimeMs: number;
    let size: number;
    try {
      const stat = statSync(file);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      this.fileCache.delete(file); // file vanished — drop the stale entry
      return null;
    }
    const cached = this.fileCache.get(file);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached;
    }
    const entry: CachedScenarioFile = { mtimeMs, size, document: null, definition: null };
    try {
      entry.document = JSON.parse(readFileSync(file, 'utf-8'));
      entry.definition = loadScenarioFile(entry.document);
    } catch (error) {
      this.log?.warn(
        { file, err: error },
        `Skipping invalid scenario file "${basename(file)}"`,
      );
    }
    this.fileCache.set(file, entry);
    return entry;
  }

  /**
   * Persist the RAW document verbatim under `<id>.json` (T-031) and prime
   * the per-file cache with the already-validated pair (T-033) — a save must
   * not be followed by a re-parse of a multi-MB replay document.
   */
  private writeUser(id: string, json: unknown, definition: ScenarioDefinition): void {
    const file = join(this.userDir, `${id}.json`);
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    try {
      const stat = statSync(file);
      this.fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, document: json, definition });
    } catch {
      this.fileCache.delete(file);
    }
  }
}

/** Validate an untrusted body as a scenario; map loader errors to a 400. */
function validateScenario(json: unknown): ScenarioDefinition {
  try {
    return loadScenarioFile(json);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new ApiError(400, 'SCENARIO_VALIDATION_FAILED', 'Scenario validation failed', error.issues);
    }
    throw error;
  }
}

function assertSafeId(id: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new ApiError(
      400,
      'INVALID_SCENARIO_ID',
      `Scenario id "${id}" is not usable as a file name — ` +
      `use letters, digits, '.', '_' or '-' (starting with a letter or digit)`,
    );
  }
}
