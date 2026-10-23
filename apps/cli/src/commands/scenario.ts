/**
 * `eaf scenario` — offline scenario file tooling.
 *
 * Subcommands:
 *   validate <file>   — schema + structural + capability-coverage validation.
 *                       Same loader the server uses, plus extra checks the
 *                       loader doesn't enforce (orphan events, missing
 *                       acRationale, capability-coverage gap).
 *   lint <file>       — best-practice warnings (missing tagline, missing
 *                       humanNarrative, vendorDisclaimer absent, etc.).
 *   list              — list scenarios on the connected server (online).
 *
 * Exit codes:
 *   0  success / no issues
 *   1  unexpected error
 *   2  usage error
 *   3  validation failed (errors found)
 */

import { resolve } from 'node:path';

import { parse, requirePositional } from '../args.js';
import type { Ctx } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';
import {
  loadScenarioFromFile,
  ScenarioValidationError,
  capabilityMatches,
  type ScenarioDefinition,
} from '@active-collaboration/core';
import { localizedText } from '@active-collaboration/shared';
const USAGE_VALIDATE = 'eaf scenario validate <file>';
const USAGE_LINT = 'eaf scenario lint <file>';
const USAGE_LIST = 'eaf scenario list';

export async function scenarioCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'validate':
      return validateScenario(ctx, argv);
    case 'lint':
      return lintScenario(ctx, argv);
    case 'list':
      return listScenarios(ctx, argv);
    default:
      throw usageError(
        `unknown scenario subcommand "${sub ?? ''}" (expected validate|lint|list)`,
      );
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  level: 'error' | 'warning';
  category: string;
  message: string;
}

/** UX-11: payload the validate face renders from (human and --json同源). */
export interface ScenarioValidationReport {
  file: string;
  valid: boolean;
  /** Entity counts — undefined when the scenario never loaded (schema failure). */
  counts?: {
    zones: number;
    devices: number;
    agents: number;
    flows: number;
    events: number;
  };
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function scenarioCounts(scenario: ScenarioDefinition): NonNullable<ScenarioValidationReport['counts']> {
  return {
    zones: scenario.zones.length,
    devices: scenario.devices.length,
    agents: scenario.agents.length,
    flows: scenario.flows?.length ?? 0,
    events: scenario.events.length,
  };
}

async function validateScenario(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_VALIDATE);
  const file = requirePositional(positionals, '<file>', USAGE_VALIDATE);
  const abs = resolve(ctx.io.cwd, file);

  const issues: ValidationIssue[] = [];

  // 1. Schema + loader-level validation (same path the server uses).
  let scenario: ScenarioDefinition;
  try {
    scenario = await loadScenarioFromFile(abs);
  } catch (err: unknown) {
    if (err instanceof ScenarioValidationError) {
      for (const issue of err.issues ?? []) {
        issues.push({ level: 'error', category: 'schema', message: issue });
      }
      // Also surface the top-level message in case issues is empty.
      if (issues.length === 0) {
        issues.push({ level: 'error', category: 'schema', message: err.message });
      }
      throwValidationFailure(ctx, file, issues);
    }
    // R6-C-F01: unreadable/missing files get the same clean one-line error
    // as validation failures (never an "unexpected failure" stack dump) —
    // the recommended authoring gate must always answer with a verdict.
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`cannot validate "${file}": ${msg}`, EXIT.USAGE);
  }

  // 2. Referential integrity: boundDeviceIds, managesZoneIds, event.zoneId.
  const zoneIds = new Set(scenario.zones.map(z => z.id));
  const deviceIds = new Set(scenario.devices.map(d => d.id));

  for (const agent of scenario.agents) {
    for (const did of agent.boundDeviceIds ?? []) {
      if (!deviceIds.has(did)) {
        issues.push({
          level: 'error',
          category: 'reference',
          message: `agent "${agent.id}" lists boundDeviceId "${did}" but no such device exists`,
        });
      }
    }
    for (const zid of agent.managesZoneIds ?? []) {
      if (!zoneIds.has(zid)) {
        issues.push({
          level: 'error',
          category: 'reference',
          message: `agent "${agent.id}" managesZoneId "${zid}" but no such zone exists`,
        });
      }
    }
  }

  // 3. Capability coverage: every event's requiredCapabilities must intersect
  //    SOME agent's capabilities, else the event is an orphan (will fire but
  //    no agent will pick it up).
  for (const evt of scenario.events) {
    const reqs = evt.requiredCapabilities ?? [];
    if (reqs.length === 0) continue;
    const matched = reqs.filter(req =>
      scenario.agents.some(a => a.capabilities.some(c => capabilityMatches(c, req))),
    );
    if (matched.length === 0) {
      issues.push({
        level: 'error',
        category: 'orphan-event',
        message: `event "${evt.id}" requiredCapabilities ${JSON.stringify(reqs)} match no agent's capabilities — event will fire but trigger no AC`,
      });
    } else if (matched.length < reqs.length) {
      const unmatched = reqs.filter(
        req => !scenario.agents.some(a => a.capabilities.some(c => capabilityMatches(c, req))),
      );
      issues.push({
        level: 'warning',
        category: 'partial-coverage',
        message: `event "${evt.id}" has ${unmatched.length} unmatched required capabilities: ${JSON.stringify(unmatched)}`,
      });
    }
  }

  // 4. Zone-event coverage: every event's zoneId must be in `managesZoneIds`
  //    of at least one agent — otherwise no agent receives the event.
  for (const evt of scenario.events) {
    const managers = scenario.agents.filter(a => (a.managesZoneIds ?? []).includes(evt.zoneId));
    if (managers.length === 0) {
      issues.push({
        level: 'error',
        category: 'unmanned-zone',
        message: `event "${evt.id}" zoneId "${evt.zoneId}" is not in any agent's managesZoneIds — no agent will receive the event`,
      });
    }
  }

  // 5. Author-discipline warnings (acRationale, focusZoneId presence).
  for (const evt of scenario.events) {
    if (!evt.acRationale) {
      issues.push({
        level: 'warning',
        category: 'acRationale',
        message: `event "${evt.id}" has no acRationale — authors should document why AC is necessary (or honestly mark as overkill)`,
      });
    }
  }

  // 6. Meta dangling references (UX-11): meta fields pointing at declared
  //    content that isn't there — warning, not error (the schema passes meta
  //    through unvalidated).
  if (scenario.meta.heroEventId !== undefined
    && !scenario.events.some(e => e.id === scenario.meta.heroEventId)) {
    issues.push({
      level: 'warning',
      category: 'meta-reference',
      message: `meta.heroEventId "${scenario.meta.heroEventId}" does not match any of the ${scenario.events.length} declared events — the demo hero window will find no event; point it at a declared event id`,
    });
  }
  if (scenario.meta.recommendedPlaybackRate !== undefined) {
    const rate = scenario.meta.recommendedPlaybackRate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      issues.push({
        level: 'warning',
        category: 'meta-reference',
        message: `meta.recommendedPlaybackRate ${JSON.stringify(rate)} is not a finite positive number — the demo player will ignore it; use a positive rate (e.g. 1, 5, 60)`,
      });
    }
  }

  const errors = issues.filter(i => i.level === 'error');
  if (errors.length > 0) {
    throwValidationFailure(ctx, file, issues, scenarioCounts(scenario));
  }
  reportValidation(ctx, file, issues, scenarioCounts(scenario));
}

/**
 * Fail the validate lane. --json prints exactly ONE document on stdout
 * (scripts parse stdout): the report rides the throw as the apiBody —
 * reportError emits it verbatim — instead of report + a second error
 * document both landing on stdout and breaking every JSON.parse.
 */
function throwValidationFailure(ctx: Ctx, file: string, issues: ValidationIssue[], counts?: ScenarioValidationReport['counts']): never {
  const issuesLines = issues.map(i => `[${i.level}/${i.category}] ${i.message}`);
  const errors = issues.filter(i => i.level === 'error');
  const message = errors.length > 0
    ? `scenario "${file}" failed validation (${errors.length} error${errors.length === 1 ? '' : 's'})`
    : `scenario "${file}" failed validation`;
  if (ctx.json) {
    throw new CliError(message, EXIT.USAGE, issuesLines, {
      file,
      valid: false,
      counts,
      errors,
      warnings: issues.filter(i => i.level === 'warning'),
    });
  }
  reportValidation(ctx, file, issues, counts);
  throw new CliError(message, EXIT.USAGE, issuesLines);
}

function reportValidation(ctx: Ctx, file: string, issues: ValidationIssue[], counts?: ScenarioValidationReport['counts']): void {
  const report: ScenarioValidationReport = {
    file,
    valid: !issues.some(i => i.level === 'error'),
    counts,
    errors: issues.filter(i => i.level === 'error'),
    warnings: issues.filter(i => i.level === 'warning'),
  };
  if (ctx.json) {
    ctx.out.data(report);
    return;
  }
  for (const line of renderScenarioValidation(report)) {
    ctx.io.stdout(`${line}\n`);
  }
}

/**
 * UX-11: pure human renderer for the validate verdict (R102 discipline —
 * human never thinner than --json; registered in the render contract).
 * On success (0 errors) a summary line carries the entity counts + warning
 * count, same source as the --json `counts` field.
 */
export function renderScenarioValidation(report: ScenarioValidationReport): string[] {
  const lines = [`Scenario: ${report.file}`];
  const { errors, warnings, counts } = report;
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('  ✓ no issues');
  }
  for (const issue of [...errors, ...warnings]) {
    const tag = issue.level === 'error' ? '✗ ERROR' : '⚠ WARN ';
    lines.push(`  ${tag} [${issue.category}] ${issue.message}`);
  }
  if (errors.length === 0 && counts) {
    lines.push(
      `  ✓ valid — ${counts.zones} zones, ${counts.devices} devices, ${counts.agents} agents, ` +
      `${counts.flows} flows, ${counts.events} events; ` +
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    );
  }
  if (errors.length > 0 || warnings.length > 0) {
    lines.push('');
    lines.push(
      `${errors.length} error${errors.length === 1 ? '' : 's'}, ` +
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

interface LintFinding {
  rule: string;
  message: string;
}

async function lintScenario(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_LINT);
  const file = requirePositional(positionals, '<file>', USAGE_LINT);
  const abs = resolve(ctx.io.cwd, file);

  let scenario: ScenarioDefinition;
  try {
    scenario = await loadScenarioFromFile(abs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`cannot lint "${file}": ${msg}`, EXIT.USAGE);
  }

  const findings: LintFinding[] = [];

  // meta.tagline
  if (!scenario.meta.tagline) {
    findings.push({ rule: 'meta.tagline', message: 'no tagline — adds a 60-char marketing line for the scenario list UI' });
  }

  // meta.heroEventId
  if (!scenario.meta.heroEventId) {
    findings.push({ rule: 'meta.heroEventId', message: 'no heroEventId — mark the event that should be the demo "hero moment"' });
  }

  // meta.vendorDisclaimer
  if (!scenario.meta.vendorDisclaimer) {
    const brandPattern = /(华为|Vaisala|Honeywell|海康|大华|Hisense|国网|美团|滴滴|Apple|Huawei|BD Pyxis|ZOLL|Philips|Siemens|Mindray|Dräger|GE|Cummins|Oura)/;
    const allText = JSON.stringify(scenario);
    if (brandPattern.test(allText)) {
      findings.push({ rule: 'meta.vendorDisclaimer', message: 'vendor brand names detected but no vendorDisclaimer field — add a one-line "names used illustratively" disclaimer' });
    }
  }

  // events[].humanNarrative (only warn if all events are missing)
  const eventsMissing = scenario.events.filter(e => !e.humanNarrative);
  if (eventsMissing.length === scenario.events.length && scenario.events.length > 0) {
    findings.push({ rule: 'event.humanNarrative', message: `none of the ${scenario.events.length} events have humanNarrative — add a one-sentence human-stakes line per event` });
  }

  // events[].focusZoneId
  const eventsNoFocus = scenario.events.filter(e => !e.focusZoneId);
  if (eventsNoFocus.length > 0) {
    findings.push({ rule: 'event.focusZoneId', message: `${eventsNoFocus.length} event(s) lack focusZoneId — needed by the cinematography UI auto-focus` });
  }

  // Description length (lint runs CLI-side; default to zh side for the
  // length check since that's the source-of-truth content today)
  const desc = localizedText(scenario.meta.description, 'zh-CN');
  if (desc.length > 600) {
    findings.push({ rule: 'meta.description', message: `description is ${desc.length} chars — consider ≤ 600; move detail to docs/scenario-<id>.md` });
  }

  // Print
  if (ctx.json) {
    ctx.out.data({ file, findings });
    return;
  }
  ctx.io.stdout(`Scenario: ${file}\n`);
  if (findings.length === 0) {
    ctx.io.stdout('  ✓ no lint findings\n');
    return;
  }
  for (const f of findings) {
    ctx.io.stdout(`  • [${f.rule}] ${f.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// list (online — calls server API)
// ---------------------------------------------------------------------------

interface ApiScenario {
  id: string;
  name: string;
  description?: string;
  source?: string;
  counts?: { zones: number; devices: number; agents: number; events: number };
}

async function listScenarios(ctx: Ctx, _argv: string[]): Promise<void> {
  const result = (await ctx.openClient().get('/api/scenarios')) as { scenarios?: ApiScenario[] };
  const scenarios = result.scenarios ?? [];
  if (ctx.json) {
    ctx.out.data({ scenarios });
    return;
  }
  if (scenarios.length === 0) {
    ctx.io.stdout('(no scenarios on server)\n');
    return;
  }
  const rows = scenarios.map(s => ({
    id: s.id,
    name: s.name,
    zones: s.counts?.zones ?? 0,
    devices: s.counts?.devices ?? 0,
    agents: s.counts?.agents ?? 0,
    events: s.counts?.events ?? 0,
    source: s.source ?? '',
  }));
  const idW = Math.max(3, ...rows.map(r => r.id.length));
  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  ctx.io.stdout(
    `${'id'.padEnd(idW)}  ${'name'.padEnd(nameW)}  z  d  a  e  source\n`,
  );
  for (const r of rows) {
    ctx.io.stdout(
      `${r.id.padEnd(idW)}  ${r.name.padEnd(nameW)}  ${String(r.zones).padStart(1)}  ${String(r.devices).padStart(1)}  ${String(r.agents).padStart(1)}  ${String(r.events).padStart(1)}  ${r.source}\n`,
    );
  }
}
