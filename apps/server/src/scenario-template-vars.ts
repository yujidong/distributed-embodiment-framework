/**
 * Scenario-template parameterization (UX wave-3) — `meta.vars` declarations
 * plus deterministic expansion of a parameterized template file into a
 * concrete scenario JSON.
 *
 * Authoring contract (see config/scenarios/teaching-building-flex.json for
 * the reference sample):
 *
 * - `meta.vars`: array of `{name, label?, type:'int', min, max, default}`.
 *   `label` may be a localized `{zh,en}` text. Only int vars exist — the
 *   point is sizing knobs (floors, rooms per floor, …), not free text.
 * - Placeholders in any string value: `$var.<name>$`, with an optional
 *   single multiplication and/or addition of integer constants —
 *   `$var.r*8$`, `$var.f+1$`, `$var.r*8+8$` — enough to lay out grids.
 *   When the WHOLE string is one placeholder the substituted value is a
 *   number (for numeric fields like bounds); embedded placeholders become
 *   text (for ids/names).
 * - Repetition: an array element `{"$repeat": {"var": "floors", "as": "f",
 *   "body": {…}}}` expands its body once per integer in `[0, count)`
 *   (`from` shifts the start), with the loop index visible inside the body
 *   as `$var.f$`. Repeats nest (floors × classrooms per floor); a body that
 *   is itself an ARRAY is spliced into the parent per iteration (so one
 *   floor iteration can yield several zones).
 * - Adjacency pruning: loop-edge references (e.g. `stairwell-f$var.f+1$`
 *   on the top floor) dangle by construction; after expansion,
 *   `adjacentZoneIds` entries that name no zone are pruned. This is the
 *   ONLY silent rewrite — anything else unresolved (`$var.` left in any
 *   string, unknown var, bad repeat) is a loud TemplateVarsError.
 *
 * Error split: a broken TEMPLATE (bad decl, unresolved placeholder) throws
 * `TemplateVarsError` (→ 500, a bundled-content bug); bad caller VALUES
 * throw `TemplateVarValuesError` (→ 400 TEMPLATE_VARS_INVALID).
 */

import type { LocalizedText } from '@active-collaboration/shared';

export interface TemplateVarDecl {
  name: string;
  label?: LocalizedText | string;
  type: 'int';
  min: number;
  max: number;
  default: number;
}

export class TemplateVarsError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'TemplateVarsError';
    this.issues = issues;
  }
}

export class TemplateVarValuesError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'TemplateVarValuesError';
    this.issues = issues;
  }
}

const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `$var.name$`, `$var.name*8$`, `$var.name+1$`, `$var.f-1$`, `$var.r*8+8$`. */
const PLACEHOLDER_PATTERN = /\$var\.([A-Za-z_][A-Za-z0-9_]*)(?:\*(-?\d+))?([+-]\d+)?\$/g;
const FULL_PLACEHOLDER_PATTERN = /^\$var\.([A-Za-z_][A-Za-z0-9_]*)(?:\*(-?\d+))?([+-]\d+)?\$$/;

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

/**
 * Read + validate `meta.vars`. Returns undefined when the template declares
 * no vars (the common case — a plain scenario file).
 * @throws TemplateVarsError on a malformed declaration.
 */
export function parseTemplateVars(template: unknown): TemplateVarDecl[] | undefined {
  const meta = (template as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const raw = (meta as { vars?: unknown }).vars;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new TemplateVarsError('meta.vars must be an array of {name, type:"int", min, max, default}');
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `meta.vars[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new TemplateVarsError(`${where} must be an object`);
    }
    const decl = entry as Record<string, unknown>;
    if (typeof decl.name !== 'string' || !VAR_NAME_PATTERN.test(decl.name)) {
      throw new TemplateVarsError(
        `${where}.name must be an identifier (letters/digits/_, not starting with a digit)`,
      );
    }
    if (seen.has(decl.name)) {
      throw new TemplateVarsError(`${where}: duplicate var name "${decl.name}"`);
    }
    seen.add(decl.name);
    if (decl.type !== 'int') {
      throw new TemplateVarsError(`${where} ("${decl.name}").type must be "int" (the only supported var type)`);
    }
    for (const key of ['min', 'max', 'default'] as const) {
      if (!Number.isInteger(decl[key])) {
        throw new TemplateVarsError(`${where} ("${decl.name}").${key} must be an integer`);
      }
    }
    const min = decl.min as number;
    const max = decl.max as number;
    const defaultValue = decl.default as number;
    if (min > max) {
      throw new TemplateVarsError(`${where} ("${decl.name}"): min (${min}) > max (${max})`);
    }
    if (defaultValue < min || defaultValue > max) {
      throw new TemplateVarsError(
        `${where} ("${decl.name}"): default (${defaultValue}) outside [${min}, ${max}]`,
      );
    }
    if (decl.label !== undefined &&
      typeof decl.label !== 'string' &&
      (typeof decl.label !== 'object' || decl.label === null)) {
      throw new TemplateVarsError(`${where} ("${decl.name}").label must be a string or a localized {zh,en} object`);
    }
    return {
      name: decl.name,
      ...(decl.label !== undefined ? { label: decl.label as LocalizedText | string } : {}),
      type: 'int' as const,
      min,
      max,
      default: defaultValue,
    };
  });
}

// ---------------------------------------------------------------------------
// Caller values
// ---------------------------------------------------------------------------

/**
 * Validate caller-supplied values against the declarations and merge with
 * defaults. Unknown names / non-integers / out-of-range values are loud.
 * @throws TemplateVarValuesError
 */
export function resolveTemplateValues(
  vars: TemplateVarDecl[],
  values: Record<string, unknown>,
): Record<string, number> {
  const byName = new Map(vars.map(v => [v.name, v]));
  const issues: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const decl = byName.get(key);
    if (decl === undefined) {
      issues.push(
        `unknown var "${key}" — this template declares: ${vars.map(v => v.name).join(', ') || '(none)'}`,
      );
      continue;
    }
    if (!Number.isInteger(value)) {
      issues.push(`var "${key}" must be an integer — got ${JSON.stringify(value)}`);
      continue;
    }
    const n = value as number;
    if (n < decl.min || n > decl.max) {
      issues.push(`var "${key}" must be within [${decl.min}, ${decl.max}] — got ${n}`);
    }
  }
  if (issues.length > 0) {
    throw new TemplateVarValuesError('template parameter values failed validation', issues);
  }
  const scope: Record<string, number> = {};
  for (const decl of vars) {
    scope[decl.name] = values[decl.name] !== undefined ? (values[decl.name] as number) : decl.default;
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Expansion + substitution
// ---------------------------------------------------------------------------

interface RepeatSpec {
  var: string;
  as: string;
  from: number;
  body: unknown;
}

function isRepeatNode(value: unknown): value is { $repeat: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 1 &&
    '$repeat' in (value as object)
  );
}

function parseRepeatSpec(raw: unknown, scope: Record<string, number>): RepeatSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TemplateVarsError('"$repeat" must be an object {var, as, body, from?}');
  }
  const spec = raw as Record<string, unknown>;
  if (typeof spec.var !== 'string' || !VAR_NAME_PATTERN.test(spec.var)) {
    throw new TemplateVarsError('"$repeat".var must be a var name');
  }
  const count = scope[spec.var];
  if (count === undefined) {
    throw new TemplateVarsError(
      `"$repeat".var "${spec.var}" is not in scope (declared vars + enclosing loop indices)`,
    );
  }
  if (typeof spec.as !== 'string' || !VAR_NAME_PATTERN.test(spec.as)) {
    throw new TemplateVarsError(`"$repeat" ("${spec.var}").as must be an identifier for the loop index`);
  }
  if (spec.body === undefined) {
    throw new TemplateVarsError(`"$repeat" ("${spec.var}") needs a "body"`);
  }
  let from = 0;
  if (spec.from !== undefined) {
    if (!Number.isInteger(spec.from)) {
      throw new TemplateVarsError(`"$repeat" ("${spec.var}").from must be an integer`);
    }
    from = spec.from as number;
  }
  return { var: spec.var, as: spec.as, from, body: spec.body };
}

/** Phase 1+2 fused: expand `$repeat` nodes and substitute `$var.*$`
 *  placeholders at the leaves, while the loop-index scope is live. */
function expandNode(node: unknown, scope: Record<string, number>): unknown {
  if (typeof node === 'string') return substituteString(node, scope);
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const element of node) {
      if (isRepeatNode(element)) {
        const spec = parseRepeatSpec(element.$repeat, scope);
        const count = scope[spec.var];
        for (let i = 0; i < count; i++) {
          const inner = { ...scope, [spec.as]: spec.from + i };
          // An array body is SPLICED per iteration (one floor → several
          // zones); any other body appends one node per iteration.
          if (Array.isArray(spec.body)) {
            out.push(...(expandNode(spec.body, inner) as unknown[]));
          } else {
            out.push(expandNode(spec.body, inner));
          }
        }
      } else {
        out.push(expandNode(element, scope));
      }
    }
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    if (isRepeatNode(node)) {
      throw new TemplateVarsError('"$repeat" is only valid as an ARRAY ELEMENT (it produces N siblings)');
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = expandNode(value, scope);
    }
    return out;
  }
  return node;
}

function evalPlaceholder(name: string, mul: string | undefined, add: string | undefined, scope: Record<string, number>): number {
  const base = scope[name];
  if (base === undefined) {
    throw new TemplateVarsError(
      `placeholder "$var.${name}$" references a name that is not in scope ` +
      `(declared vars + enclosing loop indices: ${Object.keys(scope).join(', ') || '(none)'})`,
    );
  }
  let value = base;
  if (mul !== undefined) value *= Number(mul);
  if (add !== undefined) value += Number(add);
  return value;
}

/** Substitute `$var.*$` placeholders in one string under the live scope. */
function substituteString(node: string, scope: Record<string, number>): string | number {
  const full = FULL_PLACEHOLDER_PATTERN.exec(node);
  if (full !== null) {
    return evalPlaceholder(full[1], full[2], full[3], scope);
  }
  if (!node.includes('$var.')) return node;
  const substituted = node.replace(PLACEHOLDER_PATTERN, (_m, name: string, mul?: string, add?: string) =>
    String(evalPlaceholder(name, mul, add, scope)),
  );
  if (substituted.includes('$var.')) {
    throw new TemplateVarsError(
      `unresolved placeholder in "${substituted.slice(0, 120)}" — ` +
      'expected the form $var.name$, $var.name*8$, $var.name+1$ or $var.name*8+8$',
    );
  }
  return substituted;
}

/**
 * Loop-edge adjacency prune (the ONLY silent rewrite): after expansion,
 * `adjacentZoneIds` entries naming no zone in the document are dropped —
 * cross-floor links like `stairwell-f$var.f+1$` dangle on the top floor by
 * construction.
 */
function pruneDanglingAdjacency(scenario: Record<string, unknown>): void {
  if (!Array.isArray(scenario.zones)) return;
  const zoneIds = new Set<string>();
  for (const zone of scenario.zones as Array<{ id?: unknown }>) {
    if (typeof zone?.id === 'string') zoneIds.add(zone.id);
  }
  for (const zone of scenario.zones as Array<{ adjacentZoneIds?: unknown }>) {
    if (Array.isArray(zone.adjacentZoneIds)) {
      zone.adjacentZoneIds = (zone.adjacentZoneIds as unknown[]).filter(
        id => typeof id === 'string' && zoneIds.has(id),
      );
    }
  }
}

/**
 * Expand a parameterized template into a concrete scenario JSON.
 * `meta.vars` is stripped from the output (the declarations are authoring
 * metadata, exposed via GET /api/scenario-templates instead).
 *
 * @throws TemplateVarsError (broken template) / TemplateVarValuesError (bad values)
 */
export function instantiateTemplate(template: unknown, values: Record<string, unknown>): unknown {
  const vars = parseTemplateVars(template) ?? [];
  const scope = resolveTemplateValues(vars, values);
  const expanded = expandNode(template, scope) as Record<string, unknown>;
  if (typeof expanded.meta === 'object' && expanded.meta !== null) {
    delete (expanded.meta as Record<string, unknown>).vars;
  }
  pruneDanglingAdjacency(expanded);
  return expanded;
}
