/**
 * `eaf apply` — reconcile a world document with the platform.
 */

import { resolve } from 'node:path';

import { boolFlag, parse, requireString } from '../args.js';
import type { Ctx } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';
import { applyDocument, type ApplySummary, type ChangeSet } from '../world/apply.js';
import { parseDocumentFile } from '../world/document.js';
import { validateDocument } from '../world/validate.js';

const USAGE = 'eaf apply -f world.yaml [--prune] [--reuse-sim]';

export async function applyCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { file: { type: 'string', short: 'f' }, prune: { type: 'boolean' }, 'reuse-sim': { type: 'boolean' } },
    USAGE,
  );
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE}`);
  const file = requireString(flags, 'file', USAGE);

  const raw = parseDocumentFile(ctx.io, resolve(ctx.io.cwd, file));
  const { document, issues } = validateDocument(raw);
  if (!document) {
    throw new CliError(`invalid world document "${file}" (${issues.length} problem${issues.length === 1 ? '' : 's'})`, EXIT.USAGE, issues);
  }

  const summary = await applyDocument(ctx, document, {
    prune: boolFlag(flags, 'prune'),
    reuseSim: boolFlag(flags, 'reuse-sim'),
  });
  if (summary.errors.length > 0) {
    if (ctx.json) {
      // --json prints exactly ONE document on stdout (scripts parse stdout).
      // The summary rides the throw as the apiBody — reportError emits it
      // verbatim, instead of summary + a second error document both landing
      // on stdout and breaking every JSON.parse.
      throw new CliError(
        `apply finished with ${summary.errors.length} error${summary.errors.length === 1 ? '' : 's'}`,
        EXIT.ERROR,
        summary.errors,
        summaryJson(summary),
      );
    }
    printSummary(ctx, summary);
    throw new CliError(
      `apply finished with ${summary.errors.length} error${summary.errors.length === 1 ? '' : 's'}`,
      EXIT.ERROR,
      summary.errors,
    );
  }
  printSummary(ctx, summary);
}

/** The --json summary shape (one document — success or, via apiBody, failure). */
function summaryJson(summary: ApplySummary): Record<string, unknown> {
  return {
    envId: summary.envId,
    envName: summary.envName,
    envAction: summary.envAction,
    devices: summary.devices,
    agents: summary.agents,
    ...(summary.simulationId
      ? {
          simulationId: summary.simulationId,
          simulationState: summary.simulationState,
          simulationReused: summary.simulationReused ?? false,
        }
      : {}),
    warnings: summary.warnings,
    errors: summary.errors,
    ok: summary.errors.length === 0,
  };
}

function counts(change: ChangeSet): string {
  const parts = [
    `${change.created.length} created`,
    `${change.updated.length} updated`,
    `${change.unchanged.length} unchanged`,
  ];
  if (change.deleted.length > 0) parts.push(`${change.deleted.length} deleted`);
  return parts.join(', ');
}

function printSummary(ctx: Ctx, summary: ApplySummary): void {
  if (ctx.json) {
    ctx.out.data(summaryJson(summary));
    return;
  }
  ctx.out.line(`environment ${summary.envId} "${summary.envName}": ${summary.envAction}`);
  ctx.out.line(`devices:  ${counts(summary.devices)}`);
  ctx.out.line(`agents:   ${counts(summary.agents)}`);
  // T-076 (CC-F07): governed creates name the CREATED object's id (the
  // createdIds echo), not the proposal wrapper's — callers chain from here.
  const governed = [
    ...summary.devices.created,
    ...summary.agents.created,
  ].filter(entry => entry.proposal !== undefined);
  if (governed.length > 0) {
    ctx.out.line(
      `  created via proposals: ${governed
        .map(entry => `${entry.name} → ${entry.id} (proposal ${entry.proposal!.id}, ${entry.proposal!.status})`)
        .join(', ')}`,
    );
  }
  if (summary.devices.deleted.length > 0) {
    ctx.out.line(`  pruned devices: ${summary.devices.deleted.map(d => d.name).join(', ')}`);
  }
  if (summary.agents.deleted.length > 0) {
    ctx.out.line(`  pruned agents:  ${summary.agents.deleted.map(a => a.name).join(', ')}`);
  }
  if (summary.simulationId) {
    if (summary.simulationReused) {
      ctx.out.line(`simulation ${summary.simulationId} reused (state=${summary.simulationState ?? 'unknown'}) — no new simulation created`);
    } else {
      ctx.out.line(`simulation ${summary.simulationId} created+started (state=${summary.simulationState ?? 'unknown'})`);
    }
  }
  if (summary.warnings.length > 0) {
    ctx.out.line('warnings:');
    for (const warning of summary.warnings) ctx.out.line(`  ${warning}`);
  }
  if (summary.errors.length > 0) {
    ctx.out.line(`errors: ${summary.errors.length}`);
  }
}
