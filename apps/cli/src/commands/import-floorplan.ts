/**
 * `eaf import-floorplan` — import a raster floor plan (PNG/JPEG/WebP) into a
 * scenario JSON v1.0 file through the B-D vision pipeline
 * (docs/building-simulation-design.md §5.3):
 *
 *   image ──▶ multimodal LLM (recognizeFloorplan) ──▶ pixel-space rooms /
 *   connections ──▶ caller-confirmed scale (resolveFloorplanScale) ──▶
 *   Building IR (buildFloorplanIR) ──▶ compileBuildingIR ──▶ scenario JSON.
 *
 * Human confirmation loop: `--ir` dumps the IR for review/editing, and
 * `--from-ir` recompiles an edited IR without touching the LLM. `--submit`
 * additionally posts the compiled scenario to a server's environment-import
 * endpoint (POST /api/environments) — note this creates a NEW environment
 * owned by the logged-in user; the proposal pipeline (inject-scenario)
 * cannot carry zones, so it is not used here (see design doc §5.3 status).
 *
 * LLM configuration follows env vars (EAF_VISION_PROVIDER / EAF_VISION_MODEL
 * / EAF_VISION_BASE_URL) with --provider/--model/--base-url overrides.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import {
  BuildingCompileError,
  FloorplanVisionError,
  buildFloorplanIR,
  compileBuildingIR,
  createVisionClientFromEnv,
  DEFAULT_VISION_MODEL,
  noopFloorplanPreprocessor,
  recognizeFloorplan,
  resolveFloorplanScale,
  type BuildingIR,
  type ScaleCalibrationSegment,
  type VisionChatClient,
} from '@active-collaboration/core/scenario';

import { csvFlag, numberFlag, parse, stringFlag } from '../args.js';
import { ApiClient, requireToken } from '../client.js';
import { loadConfig } from '../config.js';
import type { Ctx } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';

const USAGE =
  'eaf import-floorplan <image> --building <id> --floor <n>\n' +
  '               (--scale <pxPerM> | --calibrate x1,y1,x2,y2,<meters>)\n' +
  '               [--ir ir.json] [--out scenario.json] [--name <n>] [--id <scenarioId>]\n' +
  '               [--merge existing-ir.json] [--submit <server-url>]\n' +
  '               [--provider openai-compatible|siliconflow] [--model <m>] [--base-url <u>]\n' +
  '       eaf import-floorplan --from-ir ir.json [--out scenario.json] [--id <scenarioId>] [--submit <server-url>]';

/** Injectable seams for tests — production defaults hit the real pipeline. */
export interface ImportFloorplanDeps {
  createClient?: (ctx: Ctx, flags: Record<string, unknown>) => VisionChatClient;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export async function importFloorplanCommand(
  ctx: Ctx,
  argv: string[],
  deps: ImportFloorplanDeps = {},
): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      building: { type: 'string' },
      floor: { type: 'string' },
      scale: { type: 'string' },
      calibrate: { type: 'string' },
      ir: { type: 'string' },
      'from-ir': { type: 'string' },
      merge: { type: 'string' },
      out: { type: 'string', short: 'o' },
      name: { type: 'string' },
      id: { type: 'string' },
      submit: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'storey-height': { type: 'string' },
    },
    USAGE,
  );

  const fromIr = stringFlag(flags, 'from-ir');
  const ir: BuildingIR = fromIr !== undefined
    ? loadIrFile(ctx, fromIr, positionals)
    : await recognizePath(ctx, flags, positionals, deps);

  const irOut = stringFlag(flags, 'ir');
  if (irOut) {
    writeFileSync(resolve(ctx.io.cwd, irOut), JSON.stringify(ir, null, 2) + '\n');
  }

  let scenario;
  try {
    scenario = compileBuildingIR(ir, { scenarioId: stringFlag(flags, 'id') });
  } catch (error) {
    if (error instanceof BuildingCompileError) {
      throw new CliError(error.message, EXIT.ERROR, error.issues);
    }
    throw error;
  }

  const out = stringFlag(flags, 'out');
  const json = JSON.stringify(scenario, null, 2) + '\n';
  if (out) {
    writeFileSync(resolve(ctx.io.cwd, out), json);
  }

  const submitTo = stringFlag(flags, 'submit');
  let submittedEnvId: string | undefined;
  if (submitTo !== undefined) {
    submittedEnvId = await submitScenario(ctx, submitTo, scenario);
  }

  if (ctx.json) {
    ctx.out.data({
      scenario: out ?? null,
      ir: irOut ?? null,
      scenarioId: scenario.meta.id,
      floors: ir.floors.length,
      rooms: ir.rooms.length,
      connections: ir.connections.length,
      zones: scenario.zones.length,
      submittedEnvId: submittedEnvId ?? null,
    });
    return;
  }
  if (out) {
    ctx.out.line(
      `scenario written to ${out}: ${scenario.zones.length} zones ` +
        `(${ir.rooms.length} rooms on ${ir.floors.length} floors, ${ir.connections.length} connections)`,
    );
    if (irOut) ctx.out.line(`IR written to ${irOut}`);
  } else if (submittedEnvId === undefined) {
    ctx.io.stdout(json);
  }
  if (submittedEnvId !== undefined) {
    ctx.out.line(`submitted to ${submitTo}: environment ${submittedEnvId} created`);
  }
  if (out) {
    ctx.out.line('review zone boxes and adjacency before loading it into an environment.');
  }
}

// ---------------------------------------------------------------------------
// Vision path
// ---------------------------------------------------------------------------

async function recognizePath(
  ctx: Ctx,
  flags: Record<string, unknown>,
  positionals: string[],
  deps: ImportFloorplanDeps,
): Promise<BuildingIR> {
  if (positionals.length !== 1) {
    throw usageError(`expected exactly one floor-plan image argument\nusage: ${USAGE}`);
  }
  const file = positionals[0];
  const path = resolve(ctx.io.cwd, file);

  const buildingId = stringFlag(flags, 'building');
  if (!buildingId) {
    throw usageError(`missing required flag --building\nusage: ${USAGE}`);
  }
  const floor = numberFlag(flags, 'floor', USAGE);
  if (floor === undefined || !Number.isInteger(floor)) {
    throw usageError(`missing or invalid required flag --floor (integer)\nusage: ${USAGE}`);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new CliError(`cannot read floor-plan image "${file}": ${(error as Error).message}`, EXIT.ERROR);
  }
  const mimeType = MIME_BY_EXT[extname(file).toLowerCase()];
  if (!mimeType) {
    throw new CliError(
      `unsupported image type "${extname(file)}" — expected one of ${Object.keys(MIME_BY_EXT).join(', ')}`,
      EXIT.USAGE,
    );
  }

  // Parse + validate the scale flags BEFORE the (expensive) LLM call so
  // malformed input fails fast. A MISSING scale is not rejected here: the
  // LLM may read a scale off the drawing, surfaced as a hint afterwards.
  const scale = numberFlag(flags, 'scale', USAGE);
  const calibration = calibrationFlag(flags);
  if (scale !== undefined || calibration !== undefined) {
    try {
      resolveFloorplanScale({
        ...(scale !== undefined ? { pixelsPerMeter: scale } : {}),
        ...(calibration !== undefined ? { calibration } : {}),
      });
    } catch (error) {
      if (error instanceof FloorplanVisionError) {
        throw new CliError(error.message, EXIT.USAGE, error.issues);
      }
      throw error;
    }
  }

  const createClient =
    deps.createClient ??
    ((c: Ctx, f: Record<string, unknown>): VisionChatClient =>
      createVisionClientFromEnv(c.io.env, {
        ...(stringFlag(f, 'provider') !== undefined ? { provider: stringFlag(f, 'provider') } : {}),
        ...(stringFlag(f, 'model') !== undefined ? { model: stringFlag(f, 'model') } : {}),
        ...(stringFlag(f, 'base-url') !== undefined ? { baseURL: stringFlag(f, 'base-url') } : {}),
      }));

  let client: VisionChatClient;
  try {
    client = createClient(ctx, flags);
  } catch (error) {
    if (error instanceof FloorplanVisionError) {
      throw new CliError(error.message, EXIT.USAGE);
    }
    throw error;
  }

  let recognition;
  try {
    const preprocessed = await noopFloorplanPreprocessor.preprocess({
      base64: bytes.toString('base64'),
      mimeType,
    });
    recognition = await recognizeFloorplan(client, {
      image: { base64: bytes.toString('base64'), mimeType },
      preprocessed,
      ...(stringFlag(flags, 'model') !== undefined ? { model: stringFlag(flags, 'model') } : {}),
    });
  } catch (error) {
    if (error instanceof FloorplanVisionError) {
      // Usability F-07: a bare "API request failed: 404 Not Found" (model
      // not served / server down) sends users chasing the wrong 404. Attach
      // the effective provider/model and how to configure them.
      const provider = stringFlag(flags, 'provider') ?? ctx.io.env.EAF_VISION_PROVIDER ?? 'openai-compatible';
      const model =
        stringFlag(flags, 'model') ??
        ctx.io.env.EAF_VISION_MODEL ??
        (provider === 'openai-compatible' ? DEFAULT_VISION_MODEL : '(none set)');
      throw new CliError(`floor-plan recognition failed: ${error.message}`, EXIT.ERROR, [
        ...error.issues,
        `vision provider "${provider}", model "${model}" — is the LLM server running, and is a ` +
          `VISION-capable model served (e.g. vllm serve ${DEFAULT_VISION_MODEL})?`,
        'configure via EAF_VISION_PROVIDER / EAF_VISION_MODEL / EAF_VISION_BASE_URL or --provider/--model/--base-url',
      ]);
    }
    throw error;
  }
  for (const warning of recognition.warnings) {
    ctx.io.stderr(`warning: ${warning}\n`);
  }

  // Scale: caller-confirmed only. When the caller gave nothing, surface the
  // LLM's drawing-read suggestion as a HINT in the error — never apply it.
  let resolved;
  try {
    resolved = resolveFloorplanScale({
      ...(scale !== undefined ? { pixelsPerMeter: scale } : {}),
      ...(calibration !== undefined ? { calibration } : {}),
    });
  } catch (error) {
    if (error instanceof FloorplanVisionError) {
      let message = error.message;
      if (recognition.scaleSuggestion) {
        const suggestion = recognition.scaleSuggestion;
        message +=
          `\nthe LLM read a scale off the drawing: ${suggestion.pixelsPerMeter} px/m` +
          (suggestion.note ? ` (${suggestion.note})` : '') +
          ` — verify it against the drawing, then re-run with --scale ${suggestion.pixelsPerMeter} to accept`;
      }
      throw new CliError(message, EXIT.USAGE);
    }
    throw error;
  }
  if (recognition.scaleSuggestion) {
    const suggestion = recognition.scaleSuggestion;
    ctx.io.stderr(
      `note: LLM-read scale suggestion ${suggestion.pixelsPerMeter} px/m` +
        (suggestion.note ? ` (${suggestion.note})` : '') +
        `; using caller-confirmed ${resolved.pixelsPerMeter} px/m (${resolved.source})\n`,
    );
  }

  const storeyHeight = numberFlag(flags, 'storey-height', USAGE);
  let ir = buildFloorplanIR({
    name: stringFlag(flags, 'name') ?? `${buildingId} F${floor}`,
    buildingId,
    floor,
    pixelsPerMeter: resolved.pixelsPerMeter,
    recognition,
    // The source image becomes the floor's plan-image underlay (B-D): it
    // rides the IR floor into the compiled scenario's map block and, on
    // --submit, into the environment's map_data.floorPlans.
    planImage: `data:${mimeType};base64,${bytes.toString('base64')}`,
    ...(storeyHeight !== undefined ? { storeyHeight } : {}),
  });

  const mergePath = stringFlag(flags, 'merge');
  if (mergePath !== undefined) {
    ir = mergeIr(loadIrFile(ctx, mergePath, []), ir);
  }
  return ir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse --calibrate "x1,y1,x2,y2,meters". */
function calibrationFlag(flags: Record<string, unknown>): ScaleCalibrationSegment | undefined {
  const parts = csvFlag(flags, 'calibrate');
  if (parts === undefined) return undefined;
  if (parts.length !== 5) {
    throw usageError(
      `flag --calibrate expects "x1,y1,x2,y2,meters" (5 numbers), got ${parts.length} values\nusage: ${USAGE}`,
    );
  }
  const [x1, y1, x2, y2, meters] = parts.map(part => {
    const value = Number(part);
    if (!Number.isFinite(value)) {
      throw usageError(`flag --calibrate values must be numbers, got ${JSON.stringify(part)}\nusage: ${USAGE}`);
    }
    return value;
  });
  return { x1: x1!, y1: y1!, x2: x2!, y2: y2!, meters: meters! };
}

/** Read + lightly validate an IR JSON file (the --ir / --from-ir round-trip). */
function loadIrFile(ctx: Ctx, file: string, positionals: string[]): BuildingIR {
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments with --from-ir/--merge: ${positionals.join(' ')}\nusage: ${USAGE}`);
  }
  const path = resolve(ctx.io.cwd, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError(`cannot read IR file "${file}": ${(error as Error).message}`, EXIT.ERROR);
  }
  const ir = parsed as Partial<BuildingIR>;
  if (
    typeof ir !== 'object' ||
    ir === null ||
    typeof ir.meta !== 'object' ||
    ir.meta === null ||
    !Array.isArray(ir.rooms) ||
    !Array.isArray(ir.connections)
  ) {
    throw new CliError(
      `IR file "${file}" is not a Building IR document (needs meta, rooms, connections)`,
      EXIT.USAGE,
    );
  }
  const full = ir as BuildingIR;
  return {
    meta: full.meta,
    buildings: Array.isArray(full.buildings) ? full.buildings : [],
    floors: Array.isArray(full.floors) ? full.floors : [],
    rooms: full.rooms,
    connections: full.connections,
    envelope: Array.isArray(full.envelope) ? full.envelope : [],
  };
}

/** Append a freshly recognized floor to an existing IR (multi-floor imports). */
function mergeIr(base: BuildingIR, next: BuildingIR): BuildingIR {
  const floorKeys = new Set(base.floors.map(floor => `${floor.buildingId}:${floor.floor}`));
  for (const floor of next.floors) {
    if (floorKeys.has(`${floor.buildingId}:${floor.floor}`)) {
      throw new CliError(
        `--merge: floor ${floor.floor} of building "${floor.buildingId}" already exists in the base IR`,
        EXIT.USAGE,
      );
    }
  }
  const roomIds = new Set(base.rooms.map(room => room.id));
  for (const room of next.rooms) {
    if (roomIds.has(room.id)) {
      throw new CliError(`--merge: duplicate room id "${room.id}" across the merged IRs`, EXIT.USAGE);
    }
  }
  const buildingIds = new Set(base.buildings.map(building => building.id));
  return {
    meta: base.meta,
    buildings: [...base.buildings, ...next.buildings.filter(building => !buildingIds.has(building.id))],
    floors: [...base.floors, ...next.floors],
    rooms: [...base.rooms, ...next.rooms],
    connections: [...base.connections, ...next.connections],
    envelope: [...base.envelope, ...next.envelope],
  };
}

/** POST the compiled scenario to the server's environment-import endpoint. */
async function submitScenario(
  ctx: Ctx,
  serverUrl: string,
  scenario: unknown,
): Promise<string> {
  const url = serverUrl.replace(/\/+$/, '');
  const token = requireToken(loadConfig(ctx.io, ctx.profile).token);
  const client = new ApiClient(url, token);
  const detail = (await client.post('/api/environments', scenario)) as { id?: string } | undefined;
  if (!detail || typeof detail.id !== 'string') {
    throw new CliError(`submit: unexpected response from ${url} (no environment id)`, EXIT.ERROR);
  }
  return detail.id;
}
