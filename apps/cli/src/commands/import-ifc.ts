/**
 * `eaf import-ifc` — import an IFC (STEP) building model into a scenario
 * JSON v1.0 file. Local-only command: parses with web-ifc (WASM) through
 * @active-collaboration/core, compiles the Building IR to a scenario, and
 * writes it to disk (or stdout). No server involved — the resulting file
 * can be reviewed, then imported via the scenario endpoints.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BuildingCompileError,
  IfcParseError,
  compileBuildingIR,
  parseIfcToIR,
} from '@active-collaboration/core/scenario';

import { parse, stringFlag } from '../args.js';
import type { Ctx } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';

const USAGE = 'eaf import-ifc <file.ifc> [--out scenario.json] [--ir ir.json] [--name <n>] [--id <scenarioId>]';

export async function importIfcCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      out: { type: 'string', short: 'o' },
      ir: { type: 'string' },
      name: { type: 'string' },
      id: { type: 'string' },
    },
    USAGE,
  );
  if (positionals.length !== 1) {
    throw usageError(`expected exactly one IFC file argument\nusage: ${USAGE}`);
  }
  const file = positionals[0];
  const path = resolve(ctx.io.cwd, file);

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new CliError(`cannot read IFC file "${file}": ${(error as Error).message}`, EXIT.ERROR);
  }

  let result;
  try {
    result = await parseIfcToIR(new Uint8Array(bytes), { name: stringFlag(flags, 'name') });
  } catch (error) {
    if (error instanceof IfcParseError) {
      throw new CliError(`IFC import failed: ${error.message}`, EXIT.USAGE);
    }
    throw error;
  }
  for (const warning of result.warnings) {
    ctx.io.stderr(`warning: ${warning}\n`);
  }

  let scenario;
  try {
    scenario = compileBuildingIR(result.ir, { scenarioId: stringFlag(flags, 'id') });
  } catch (error) {
    if (error instanceof BuildingCompileError) {
      throw new CliError(error.message, EXIT.ERROR, error.issues);
    }
    throw error;
  }

  const irOut = stringFlag(flags, 'ir');
  if (irOut) {
    writeFileSync(resolve(ctx.io.cwd, irOut), JSON.stringify(result.ir, null, 2) + '\n');
  }

  const out = stringFlag(flags, 'out');
  const json = JSON.stringify(scenario, null, 2) + '\n';
  if (out) {
    writeFileSync(resolve(ctx.io.cwd, out), json);
  }

  const estimatedRooms = result.ir.rooms.filter(room => room.estimated).length;
  if (ctx.json) {
    ctx.out.data({
      input: file,
      scenario: out ?? null,
      ir: irOut ?? null,
      scenarioId: scenario.meta.id,
      floors: result.ir.floors.length,
      rooms: result.ir.rooms.length,
      estimatedRooms,
      connections: result.ir.connections.length,
      zones: scenario.zones.length,
      warnings: result.warnings,
    });
    return;
  }
  if (out) {
    ctx.out.line(
      `scenario written to ${out}: ${scenario.zones.length} zones ` +
      `(${result.ir.rooms.length} rooms on ${result.ir.floors.length} floors, ` +
      `${result.ir.connections.length} connections` +
      `${estimatedRooms > 0 ? `, ${estimatedRooms} estimated` : ''})`,
    );
    if (irOut) ctx.out.line(`IR written to ${irOut}`);
    ctx.out.line('review zone boxes and adjacency before loading it into an environment.');
  } else {
    ctx.io.stdout(json);
  }
}
