/**
 * Environment import lanes (UX wave-3) — three DRAFT-producing endpoints.
 * None of them persists anything: each compiles the upload into a scenario
 * JSON draft the caller reviews, then imports through the standing
 * `POST /api/environments` scenario-import path.
 *
 * - `POST /api/environments/import-floorplan` — raster floor plan (base64
 *   JSON body) → multimodal LLM recognition → Building IR → compiled draft.
 *   This lane REQUIRES a vision-capable LLM; an unconfigured (rule-only)
 *   deployment gets an honest 503 FLOORPLAN_VISION_UNAVAILABLE teaching how
 *   to configure one, and a failed recognition gets 502
 *   FLOORPLAN_RECOGNITION_FAILED with the effective provider/model named.
 * - `POST /api/environments/import-ifc` — IFC (STEP) file (base64) → web-ifc
 *   → IR → draft. No LLM involved; a malformed file is 422 IFC_IMPORT_FAILED.
 * - `POST /api/environments/import-osm` — `{bbox:[s,w,n,e]}` or `{query}`
 *   → Overpass API proxy → building footprints → geo draft. Overpass down
 *   on every mirror is 503 OSM_IMPORT_UNAVAILABLE; a valid answer with no
 *   buildings is 404 OSM_NO_BUILDINGS_FOUND.
 * - `POST /api/environments/import-nl` — `{text, name?}` one-sentence
 *   description → text LLM (NL function route) → Building IR → compiled
 *   draft + devices/agents. No LLM configured is 503 NL_IMPORT_UNAVAILABLE;
 *   the LLM call failing is 502 NL_IMPORT_FAILED; a sentence with no
 *   building cues is 422 NL_IMPORT_NO_BUILDING (teaching, with examples).
 *
 * Bodies are JSON (base64 payloads) — the platform has no multipart parser
 * registered, and the standing T-111 body limit (default 32MB) bounds the
 * upload. Test seams: `visionClientFactory` (no real LLM in tests),
 * `overpassFetch` (no real Overpass in tests) and `nlClientFactory` (no
 * real LLM in tests).
 */

import type { FastifyInstance } from 'fastify';

import {
  BuildingCompileError,
  FloorplanVisionError,
  IfcParseError,
  NLImportError,
  ScenarioValidationError,
  buildFloorplanIR,
  buildNLImportIR,
  compileBuildingIR,
  inferDeviceRole,
  loadScenarioFile,
  noopFloorplanPreprocessor,
  parseIfcToIR,
  recognizeEnvironmentFromText,
  recognizeFloorplan,
  resolveFloorplanScale,
  type NLImportChatClient,
  type ScaleCalibrationSegment,
  type VisionChatClient,
} from '@active-collaboration/core/scenario';
import { DeviceTemplateRegistry } from '@active-collaboration/simulation';

import { ApiError } from '../errors.js';
import {
  OsmNoBuildingsError,
  OsmUnavailableError,
  buildOsmScenarioDraft,
} from '../osm-import.js';

export interface EnvironmentImportRoutesContext {
  /**
   * Builds the vision chat client for the floorplan lane. Throwing
   * FloorplanVisionError means "no vision backend configured" → 503.
   * Production wires createVisionClientFromEnv; tests inject a stub client.
   */
  visionClientFactory: () => VisionChatClient;
  /** Overpass fetch seam (tests must never hit the real API). */
  overpassFetch?: typeof fetch;
  /**
   * Builds the text chat client for the NL lane (UX wave-5). Throwing
   * NLImportError means "no LLM backend configured" → 503. Production wires
   * the NL function route (LLM_NL_MODEL) / the main deployment; tests inject
   * a stub client.
   */
  nlClientFactory: () => NLImportChatClient;
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Decoded-image cap — comfortably inside the 32MB JSON body limit. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_IFC_BYTES = 24 * 1024 * 1024;
/** Bbox edge cap (degrees) — bounds the Overpass payload per request. */
const MAX_BBOX_SPAN_DEG = 0.5;

export function registerEnvironmentImportRoutes(
  app: FastifyInstance,
  ctx: EnvironmentImportRoutesContext,
): void {
  // ------------------------------------------------------------- floorplan
  app.post('/api/environments/import-floorplan', { preHandler: app.authenticate }, async request => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const image = body.image;
    if (typeof image !== 'object' || image === null) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "image" must be an object {base64, mimeType} — ' +
        `mimeType one of ${[...IMAGE_MIME_TYPES].join(', ')}`,
      );
    }
    const { base64, mimeType } = image as Record<string, unknown>;
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "image.base64" must be a non-empty base64 string');
    }
    if (typeof mimeType !== 'string' || !IMAGE_MIME_TYPES.has(mimeType)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "image.mimeType" must be one of ${[...IMAGE_MIME_TYPES].join(', ')}`,
      );
    }
    const imageBytes = Buffer.from(base64, 'base64');
    if (imageBytes.length === 0 || imageBytes.length > MAX_IMAGE_BYTES) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `image decodes to ${imageBytes.length} bytes — expected 1..${MAX_IMAGE_BYTES} ` +
        '(the floor-plan lane accepts images up to 24MB)',
      );
    }

    const buildingId = requireNonEmptyString(body.buildingId, 'buildingId');
    const floor = body.floor;
    if (!Number.isInteger(floor)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "floor" must be an integer (0 = ground floor)');
    }
    const name = optionalString(body.name, 'name');
    const scenarioId = optionalString(body.scenarioId, 'scenarioId');
    const calibration = parseCalibration(body.calibration);
    const pixelsPerMeter = body.pixelsPerMeter;
    if (pixelsPerMeter !== undefined &&
      (typeof pixelsPerMeter !== 'number' || !Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "pixelsPerMeter" must be a positive number');
    }
    // Fail fast on malformed scale input BEFORE the (expensive) LLM call —
    // a missing scale is fine here: the LLM may read one off the drawing.
    if (pixelsPerMeter !== undefined || calibration !== undefined) {
      try {
        resolveFloorplanScale({
          ...(pixelsPerMeter !== undefined ? { pixelsPerMeter } : {}),
          ...(calibration !== undefined ? { calibration } : {}),
        });
      } catch (error) {
        if (error instanceof FloorplanVisionError) {
          throw new ApiError(400, 'BAD_REQUEST', error.message, error.issues);
        }
        throw error;
      }
    }

    let client: VisionChatClient;
    try {
      client = ctx.visionClientFactory();
    } catch (error) {
      if (error instanceof FloorplanVisionError) {
        throw new ApiError(
          503,
          'FLOORPLAN_VISION_UNAVAILABLE',
          'The floor-plan import lane needs a VISION-capable LLM and this deployment has none ' +
          `configured (${error.message}). ` +
          'Point EAF_VISION_BASE_URL at an OpenAI-compatible endpoint serving a multimodal model ' +
          '(e.g. Qwen2.5-VL) and set EAF_VISION_MODEL, or import an IFC file / OSM footprints ' +
          'instead — those lanes need no LLM.',
        );
      }
      throw error;
    }

    let recognition;
    try {
      recognition = await recognizeFloorplan(client, {
        image: { base64, mimeType },
        preprocessed: await noopFloorplanPreprocessor.preprocess({ base64, mimeType }),
      });
    } catch (error) {
      if (error instanceof FloorplanVisionError) {
        throw new ApiError(
          502,
          'FLOORPLAN_RECOGNITION_FAILED',
          `floor-plan recognition failed: ${error.message}`,
          [
            ...error.issues,
            'is the LLM endpoint running, and does it serve a VISION-capable model under the ' +
            'configured name (EAF_VISION_MODEL / EAF_VISION_BASE_URL)?',
          ],
        );
      }
      throw error;
    }

    // Scale: caller-confirmed only. A missing scale fails AFTER recognition
    // so the LLM's drawing-read suggestion rides the error as a hint (never
    // applied silently).
    let resolved;
    try {
      resolved = resolveFloorplanScale({
        ...(pixelsPerMeter !== undefined ? { pixelsPerMeter } : {}),
        ...(calibration !== undefined ? { calibration } : {}),
      });
    } catch (error) {
      if (error instanceof FloorplanVisionError) {
        let message = error.message;
        if (recognition.scaleSuggestion) {
          const suggestion = recognition.scaleSuggestion;
          message +=
            ` — the LLM read a scale off the drawing: ${suggestion.pixelsPerMeter} px/m` +
            (suggestion.note ? ` (${suggestion.note})` : '') +
            '; verify it against the drawing, then retry with "pixelsPerMeter": ' +
            `${suggestion.pixelsPerMeter} to accept`;
        }
        throw new ApiError(400, 'BAD_REQUEST', message, error.issues);
      }
      throw error;
    }

    const warnings = [...recognition.warnings];
    if (recognition.scaleSuggestion) {
      warnings.push(
        `LLM-read scale suggestion ${recognition.scaleSuggestion.pixelsPerMeter} px/m` +
        (recognition.scaleSuggestion.note ? ` (${recognition.scaleSuggestion.note})` : '') +
        `; using caller-confirmed ${resolved.pixelsPerMeter} px/m (${resolved.source})`,
      );
    }

    const ir = buildFloorplanIR({
      name: name ?? `${buildingId} F${floor}`,
      buildingId,
      floor: floor as number,
      pixelsPerMeter: resolved.pixelsPerMeter,
      recognition,
      planImage: `data:${mimeType};base64,${base64}`,
    });
    try {
      const draft = compileBuildingIR(ir, { ...(scenarioId !== undefined ? { scenarioId } : {}) });
      return {
        draft,
        warnings,
        ...(recognition.scaleSuggestion !== undefined
          ? { scaleSuggestion: recognition.scaleSuggestion }
          : {}),
      };
    } catch (error) {
      if (error instanceof BuildingCompileError) {
        throw new ApiError(502, 'FLOORPLAN_RECOGNITION_FAILED', error.message, error.issues);
      }
      throw error;
    }
  });

  // ------------------------------------------------------------------ IFC
  app.post('/api/environments/import-ifc', { preHandler: app.authenticate }, async request => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const ifcBase64 = body.ifc;
    if (typeof ifcBase64 !== 'string' || ifcBase64.length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "ifc" must be a non-empty base64 string (the IFC STEP file bytes)',
      );
    }
    const bytes = Buffer.from(ifcBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IFC_BYTES) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `ifc decodes to ${bytes.length} bytes — expected 1..${MAX_IFC_BYTES} ` +
        '(the IFC lane accepts files up to 24MB)',
      );
    }
    const name = optionalString(body.name, 'name');
    const scenarioId = optionalString(body.scenarioId, 'scenarioId');

    let result;
    try {
      result = await parseIfcToIR(new Uint8Array(bytes), { ...(name !== undefined ? { name } : {}) });
    } catch (error) {
      if (error instanceof IfcParseError) {
        throw new ApiError(422, 'IFC_IMPORT_FAILED', `IFC import failed: ${error.message}`);
      }
      throw error;
    }

    try {
      const draft = compileBuildingIR(result.ir, { ...(scenarioId !== undefined ? { scenarioId } : {}) });
      return { draft, warnings: result.warnings };
    } catch (error) {
      if (error instanceof BuildingCompileError) {
        throw new ApiError(422, 'IFC_IMPORT_FAILED', error.message, error.issues);
      }
      throw error;
    }
  });

  // ------------------------------------------------------------------ OSM
  app.post('/api/environments/import-osm', { preHandler: app.authenticate }, async request => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hasBbox = body.bbox !== undefined;
    const hasQuery = body.query !== undefined;
    if (hasBbox === hasQuery) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body must carry exactly ONE of "bbox" ([south, west, north, east] in degrees) or ' +
        '"query" (a place name resolved through Overpass)',
      );
    }

    let input: { bbox: [number, number, number, number] } | { query: string };
    if (hasBbox) {
      const bbox = body.bbox;
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "bbox" must be [south, west, north, east] — four finite numbers in degrees',
        );
      }
      const [south, west, north, east] = bbox as [number, number, number, number];
      if (south >= north || west >= east) {
        throw new ApiError(400, 'BAD_REQUEST', `bbox needs south < north and west < east — got [${bbox.join(', ')}]`);
      }
      if (north > 90 || south < -90 || east > 180 || west < -180) {
        throw new ApiError(400, 'BAD_REQUEST', 'bbox out of range — latitudes within [-90, 90], longitudes within [-180, 180]');
      }
      if (north - south > MAX_BBOX_SPAN_DEG || east - west > MAX_BBOX_SPAN_DEG) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `bbox spans more than ${MAX_BBOX_SPAN_DEG}° on an edge — narrow the area ` +
          '(the OSM lane is for a campus / a few blocks, not a whole city)',
        );
      }
      input = { bbox: [south, west, north, east] };
    } else {
      const query = body.query;
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > 100) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "query" must be a place name (1..100 chars)');
      }
      if (/["\\\r\n]/.test(query)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "query" must not contain quotes, backslashes or newlines');
      }
      input = { query: query.trim() };
    }

    try {
      return await buildOsmScenarioDraft(input, {
        ...(ctx.overpassFetch !== undefined ? { fetchImpl: ctx.overpassFetch } : {}),
      });
    } catch (error) {
      if (error instanceof OsmUnavailableError) {
        throw new ApiError(503, 'OSM_IMPORT_UNAVAILABLE', error.message);
      }
      if (error instanceof OsmNoBuildingsError) {
        throw new ApiError(404, 'OSM_NO_BUILDINGS_FOUND', error.message);
      }
      throw error;
    }
  });

  // ------------------------------------------------------------------- NL
  const MAX_NL_TEXT_CHARS = 2000;
  app.post('/api/environments/import-nl', { preHandler: app.authenticate }, async request => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const text = body.text;
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_NL_TEXT_CHARS) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "text" must be a 1..${MAX_NL_TEXT_CHARS}-char description of the environment ` +
        '(e.g. "我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感")',
      );
    }
    const name = optionalString(body.name, 'name');
    const scenarioId = optionalString(body.scenarioId, 'scenarioId');

    let client: NLImportChatClient;
    try {
      client = ctx.nlClientFactory();
    } catch (error) {
      if (error instanceof NLImportError) {
        throw new ApiError(
          503,
          'NL_IMPORT_UNAVAILABLE',
          'The NL import lane needs a text LLM and this deployment has none configured ' +
          `(${error.message}). ` +
          'Set LLM_BASE_URL + LLM_MODEL (or an LLM_NL_MODEL route) and retry, or use the ' +
          'LLM-free IFC / OSM import lanes instead.',
        );
      }
      throw error;
    }

    // The device-type vocabulary comes from the SAME registry the rest of
    // the platform deploys from — the model cannot invent device types.
    const deviceTypes = DeviceTemplateRegistry.listTemplates().map(t => t.name.toLowerCase());

    let recognition;
    try {
      recognition = await recognizeEnvironmentFromText(client, {
        text: text.trim(),
        deviceTypes,
      });
    } catch (error) {
      if (error instanceof NLImportError) {
        throw new ApiError(
          502,
          'NL_IMPORT_FAILED',
          `NL environment recognition failed: ${error.message}`,
          [
            ...error.issues,
            'is the LLM endpoint running, and does it serve the configured model ' +
            '(LLM_MODEL / LLM_NL_MODEL)?',
          ],
        );
      }
      throw error;
    }

    if (recognition.floors.length === 0) {
      throw new ApiError(
        422,
        'NL_IMPORT_NO_BUILDING',
        'the description carries no building/space cues the importer can map — ' +
        'name a building type, its floors and its rooms. Examples: ' +
        '"我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感" · ' +
        '"2 层商场，一层餐饮一层零售" · ' +
        '"a 4-storey office building with 10 offices and a meeting room per floor"',
      );
    }

    let built;
    try {
      built = buildNLImportIR({
        recognition,
        ...(name !== undefined ? { name } : {}),
      });
    } catch (error) {
      if (error instanceof NLImportError) {
        throw new ApiError(502, 'NL_IMPORT_FAILED', error.message, error.issues);
      }
      throw error;
    }

    let draft;
    try {
      draft = compileBuildingIR(built.ir, { ...(scenarioId !== undefined ? { scenarioId } : {}) });
    } catch (error) {
      if (error instanceof BuildingCompileError) {
        throw new ApiError(502, 'NL_IMPORT_FAILED', error.message, error.issues);
      }
      throw error;
    }

    // Devices/agents ride alongside the IR (the IR has no device concept):
    // capabilities + role are resolved from the template registry; a type
    // the registry does not know is dropped with a warning (honest, never
    // silently capability-less).
    const warnings = [...built.warnings];
    for (const device of built.devices) {
      const template = DeviceTemplateRegistry.getTemplate(device.type);
      if (template === undefined) {
        warnings.push(
          `device "${device.id}": unknown type "${device.type}" (not in the device-template ` +
          'registry) — dropped; re-add it in the environment builder',
        );
        continue;
      }
      (draft.devices as unknown[]).push({
        id: device.id,
        name: device.name,
        type: template.name.toLowerCase(),
        capabilities: template.capabilities,
        role: inferDeviceRole(template.capabilities),
        zoneId: device.zoneId,
      });
    }
    for (const agent of built.agents) {
      (draft.agents as unknown[]).push({
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
      });
    }

    // The augmented draft must keep the compiler's loadable contract.
    try {
      loadScenarioFile(draft);
    } catch (error) {
      if (error instanceof ScenarioValidationError) {
        throw new ApiError(
          502,
          'NL_IMPORT_FAILED',
          `the generated draft failed scenario validation: ${error.message}`,
        );
      }
      throw error;
    }

    return { draft, warnings };
  });
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string when present`);
  }
  return value.trim();
}

function parseCalibration(value: unknown): ScaleCalibrationSegment | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "calibration" must be {x1, y1, x2, y2, meters} — a known-dimension segment on the image',
    );
  }
  const segment = value as Record<string, unknown>;
  for (const key of ['x1', 'y1', 'x2', 'y2', 'meters'] as const) {
    if (typeof segment[key] !== 'number' || !Number.isFinite(segment[key] as number)) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "calibration.${key}" must be a finite number`);
    }
  }
  return segment as unknown as ScaleCalibrationSegment;
}
