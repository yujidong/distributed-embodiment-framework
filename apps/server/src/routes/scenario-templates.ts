/**
 * Scenario-template routes — read-only onboarding surface over the bundled
 * scenario files (`config/scenarios/*.json`, a.k.a. the seed dir).
 *
 * - `GET /api/scenario-templates`      summaries (id from the file name,
 *                                      name/description from meta, array
 *                                      counts, mapType; `vars` when the
 *                                      template declares parameters)
 * - `GET /api/scenario-templates/:id`  the scenario JSON, ready to POST to
 *                                      /api/environments as an import body —
 *                                      parameterized templates (meta.vars)
 *                                      come back DEFAULT-instantiated
 * - `POST /api/scenario-templates/:id/instantiate`  UX wave-3: body
 *                                      `{values?: {<var>: int}}` → validated
 *                                      (400 TEMPLATE_VARS_INVALID) and
 *                                      expanded scenario JSON (never
 *                                      persisted; same import path after)
 *
 * Unlike the LEGACY `/api/scenarios*` store these read ONLY the seed dir
 * (no user-dir merge, no validation) and require authentication — they exist
 * so the create-environment dialog can offer built-in templates without the
 * user pasting JSON.
 *
 * The directory scan happens on the first list request and is cached for the
 * process lifetime (the seed dir is read-only bundled content); `/:id` reads
 * the file on demand behind a strict id pattern (no path traversal). The
 * cache holds the RAW meta — name/description are localized per request via
 * `request.locale` (resolved by the i18n plugin: `?lang=` → Accept-Language
 * → zh-CN), so one cache serves every language.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { localizedText, type LocalizedText, type UiLocale } from '@active-collaboration/shared';

import { ApiError } from '../errors.js';
import {
  TemplateVarValuesError,
  TemplateVarsError,
  instantiateTemplate,
  parseTemplateVars,
  type TemplateVarDecl,
} from '../scenario-template-vars.js';

export interface ScenarioTemplateVar {
  name: string;
  label: string;
  type: 'int';
  min: number;
  max: number;
  default: number;
}

export interface ScenarioTemplateSummary {
  id: string;
  name: string;
  description: string;
  counts: { zones: number; devices: number; agents: number; events: number; derivedServices: number };
  /** 'geo' for geo-tier maps, 'grid' otherwise (same rule as env import). */
  mapType: string;
  /**
   * UX wave-3: declared sizing parameters (meta.vars) — present only on
   * parameterized templates. Values go to POST …/instantiate; GET /:id on
   * such a template returns the DEFAULT-instantiated scenario.
   */
  vars?: ScenarioTemplateVar[];
}

interface IdParams {
  id: string;
}

/** Template ids come from file names — word chars and dashes only. */
const TEMPLATE_ID_PATTERN = /^[\w-]+$/;

/** Minimal logger contract (satisfied by fastify's pino logger). */
export interface TemplateLogger {
  warn: (obj: unknown, msg: string) => void;
}

export function registerScenarioTemplateRoutes(
  app: FastifyInstance,
  opts: { templateDir: string; log?: TemplateLogger },
): void {
  let cache: RawTemplate[] | null = null;

  const listTemplates = (): RawTemplate[] => {
    if (cache !== null) return cache;
    const templates: RawTemplate[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(opts.templateDir).filter(name => name.endsWith('.json'));
    } catch {
      entries = []; // directory missing/unreadable — treat as empty
    }
    for (const entry of entries) {
      const id = entry.slice(0, -'.json'.length);
      try {
        const raw: unknown = JSON.parse(readFileSync(join(opts.templateDir, entry), 'utf-8'));
        templates.push(parseTemplate(id, raw));
      } catch (error) {
        opts.log?.warn({ file: entry, err: error }, `Skipping invalid scenario template "${entry}"`);
      }
    }
    cache = templates.sort((a, b) => a.id.localeCompare(b.id));
    return cache;
  };

  app.get('/api/scenario-templates', { preHandler: app.authenticate }, async request => ({
    templates: listTemplates().map(template => summarize(template, request.locale)),
  }));

  app.get('/api/scenario-templates/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      throw new ApiError(
        400,
        'INVALID_TEMPLATE_ID',
        `Template id "${id}" is invalid — use letters, digits, '_' or '-'`,
      );
    }
    const template = readTemplate(id);
    const vars = parseTemplateVars(template);
    if (vars === undefined) return template;
    // Parameterized template: the direct-import contract (POST this JSON to
    // /api/environments) is kept by expanding with the declared DEFAULTS.
    return instantiateOrThrow(template, {});
  });

  /**
   * UX wave-3: parameterize-then-import. Body `{values?: {<var>: int}}`
   * (omitted vars take their declared default) → the expanded scenario JSON
   * (never persisted — review, then POST it to /api/environments).
   */
  app.post('/api/scenario-templates/:id/instantiate', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      throw new ApiError(
        400,
        'INVALID_TEMPLATE_ID',
        `Template id "${id}" is invalid — use letters, digits, '_' or '-'`,
      );
    }
    const template = readTemplate(id);
    const vars = parseTemplateVars(template);
    if (vars === undefined) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Scenario template "${id}" declares no parameters (meta.vars) — ` +
        'GET /api/scenario-templates/{id} returns its scenario JSON directly.',
      );
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    let values: Record<string, unknown> = {};
    if (body.values !== undefined) {
      if (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "values" must be an object {<varName>: integer}');
      }
      values = body.values as Record<string, unknown>;
    }
    try {
      return instantiateTemplate(template, values);
    } catch (error) {
      if (error instanceof TemplateVarValuesError) {
        throw new ApiError(
          400,
          'TEMPLATE_VARS_INVALID',
          error.message +
            ` — declared vars: ${vars.map(v => `${v.name} int [${v.min},${v.max}] default ${v.default}`).join('; ')}`,
          error.issues,
        );
      }
      if (error instanceof TemplateVarsError) {
        throw new ApiError(500, 'INTERNAL', `template "${id}" is broken: ${error.message}`, error.issues);
      }
      throw error;
    }
  });

  function readTemplate(id: string): unknown {
    let raw: string;
    try {
      raw = readFileSync(join(opts.templateDir, `${id}.json`), 'utf-8');
    } catch {
      throw new ApiError(404, 'TEMPLATE_NOT_FOUND', `Scenario template "${id}" not found`);
    }
    return JSON.parse(raw) as unknown;
  }

  /** Instantiate or translate a broken-template error into a 500. */
  function instantiateOrThrow(template: unknown, values: Record<string, unknown>): unknown {
    try {
      return instantiateTemplate(template, values);
    } catch (error) {
      if (error instanceof TemplateVarsError) {
        throw new ApiError(500, 'INTERNAL', `template is broken: ${error.message}`, error.issues);
      }
      throw error;
    }
  }
}

/**
 * The cached form: raw localized meta + the locale-independent counts, so
 * one scan serves every request language.
 */
interface RawTemplate {
  id: string;
  name: LocalizedText | string | undefined;
  description: LocalizedText | string | undefined;
  counts: { zones: number; devices: number; agents: number; events: number; derivedServices: number };
  mapType: string;
  vars?: TemplateVarDecl[];
}

function parseTemplate(id: string, raw: unknown): RawTemplate {
  // A broken vars declaration is a broken template — let it throw into the
  // scan's warn-and-skip (same discipline as invalid JSON). Parameterized
  // templates are counted on their DEFAULT-instantiated expansion.
  const vars = parseTemplateVars(raw);
  const effective = vars !== undefined ? instantiateTemplate(raw, {}) : raw;
  const scenario = effective as {
    meta?: { name?: LocalizedText | string; description?: LocalizedText | string };
    map?: unknown;
    zones?: unknown;
    devices?: unknown;
    agents?: unknown;
    events?: unknown;
  };
  const meta = typeof scenario.meta === 'object' && scenario.meta !== null ? scenario.meta : {};
  return {
    id,
    name: meta.name,
    description: meta.description,
    counts: {
      zones: arrayLength(scenario.zones),
      devices: arrayLength(scenario.devices),
      agents: arrayLength(scenario.agents),
      events: arrayLength(scenario.events),
      // R53 transparency: the service face materializes at IMPORT (bound
      // device × capability) — templates carried no service count, which
      // read as "this world has no services". This is the upper bound of
      // the device-derived rows (the executable filter trims a few).
      derivedServices: (Array.isArray(scenario.devices) ? scenario.devices : [])
        .reduce(
          (total, device) =>
            total +
            (Array.isArray((device as { capabilities?: unknown[] }).capabilities)
              ? ((device as { capabilities: unknown[] }).capabilities.length)
              : 0),
          0,
        ),
    },
    mapType: templateMapType(scenario.map),
    ...(vars !== undefined ? { vars } : {}),
  };
}

function summarize(template: RawTemplate, locale: UiLocale): ScenarioTemplateSummary {
  return {
    id: template.id,
    name: localizedText(template.name, locale),
    description: localizedText(template.description, locale),
    counts: template.counts,
    mapType: template.mapType,
    ...(template.vars !== undefined
      ? {
          vars: template.vars.map(decl => ({
            name: decl.name,
            label: localizedText(decl.label, locale),
            type: decl.type,
            min: decl.min,
            max: decl.max,
            default: decl.default,
          })),
        }
      : {}),
  };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Same derivation as environment-import's scenarioMapType. */
function templateMapType(map: unknown): string {
  if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
    const type = (map as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return 'grid';
}
