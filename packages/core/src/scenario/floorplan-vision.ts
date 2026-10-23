/**
 * Floorplan vision importer — raster floor-plan image → Building IR fragment
 * (design: docs/building-simulation-design.md §5.3, stage B-D).
 *
 * Pipeline (each step's output is meant to be human-reviewable):
 *
 * 1. Optional CV preprocessor (`FloorplanPreprocessor`) — classic CV
 *    (line/region detection) or a small segmentation model producing
 *    candidate room boxes. The interface is the seam; the default
 *    implementation is a no-op passthrough so the LLM sees the raw image.
 *    A real implementation (e.g. OpenCV.js) can be dropped in later without
 *    touching the rest of the pipeline.
 * 2. Multimodal LLM (`recognizeFloorplan`) — the image (+ CV candidates as
 *    text context) goes to a vision-capable chat model. Output is
 *    constrained via `ChatParams.format` to a small JSON schema: rooms as
 *    PIXEL-space rectangles (the compiler takes bounding boxes anyway),
 *    door/open/stair/elevator/window connections, and an optional scale
 *    hint read off the drawing.
 * 3. Scale calibration (`resolveFloorplanScale`) — pixelsPerMeter comes
 *    from the CALLER, either explicitly or derived from a known-dimension
 *    annotation (`pixelsPerMeterFromCalibration`). A scale the LLM read off
 *    the drawing is only ever a SUGGESTION surfaced to the caller — it is
 *    never applied silently.
 * 4. `buildFloorplanIR` converts the pixel-space recognition into a
 *    meter-space Building IR (one floor), ready for `compileBuildingIR`.
 *
 * Error handling follows the LLMReviewer precedent: the constrained schema
 * is re-checked in code, parsing is lenient (code fences / surrounding
 * prose are stripped), and every failure mode raises `FloorplanVisionError`
 * with an actionable message — nothing degrades silently.
 */

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import type {
  BuildingIR,
  IRConnection,
  IRConnectionKind,
  IRRoom,
} from './building-ir.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Friendly, actionable failure of the vision pipeline. */
export class FloorplanVisionError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'FloorplanVisionError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Input image + CV preprocessor seam
// ---------------------------------------------------------------------------

/** A raster floor plan. `base64` is the raw image bytes, base64-encoded. */
export interface FloorplanImage {
  base64: string;
  /** e.g. 'image/png', 'image/jpeg'. */
  mimeType: string;
}

/** Candidate room box in IMAGE PIXEL coordinates (origin top-left). */
export interface CandidateRoomBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional label from the detector (e.g. OCR'd room number). */
  label?: string;
}

export interface FloorplanPreprocessResult {
  candidateRooms?: CandidateRoomBox[];
  /**
   * Free-form notes for the LLM prompt (e.g. detected scale-bar text).
   * Kept short — they are inlined into the prompt verbatim.
   */
  notes?: string[];
}

/**
 * Optional CV preprocessing step (§5.3 step 1). Implementations may run
 * classic CV (line detection, connected components) or a light segmentation
 * model and return candidate room boxes that prime the LLM prompt.
 *
 * The default is a no-op: the LLM works on the raw image alone. A future
 * OpenCV.js-based implementation should plug in here without any change to
 * the pipeline.
 */
export interface FloorplanPreprocessor {
  readonly name: string;
  preprocess(image: FloorplanImage): Promise<FloorplanPreprocessResult>;
}

/** Default preprocessor: no CV, the raw image goes straight to the LLM. */
export const noopFloorplanPreprocessor: FloorplanPreprocessor = {
  name: 'noop',
  preprocess: () => Promise.resolve({}),
};

// ---------------------------------------------------------------------------
// Recognition (multimodal LLM)
// ---------------------------------------------------------------------------

/** The minimal slice of the LLM client this pipeline needs (mock-friendly). */
export interface VisionChatClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}

export interface RecognizeFloorplanOptions {
  image: FloorplanImage;
  /** Optional CV candidates to prime the prompt with. */
  preprocessed?: FloorplanPreprocessResult;
  /** Model override (passed through to ChatParams.model). */
  model?: string;
  /** Wall-clock budget for the LLM call (default 120s — vision is slow). */
  timeoutMs?: number;
}

/** A recognized room, still in IMAGE PIXEL coordinates. */
export interface RecognizedRoom {
  /** LLM-local reference used by connections; resolved to IR ids later. */
  ref: string;
  name?: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  occupancy?: number;
}

export interface RecognizedConnection {
  a: string;
  b?: string;
  kind: IRConnectionKind;
}

/** Scale hint the LLM read off the drawing — a SUGGESTION, never auto-applied. */
export interface ScaleSuggestion {
  pixelsPerMeter: number;
  /** What the model saw, e.g. 'scale bar "0 5 10m"'. */
  note?: string;
}

export interface FloorplanRecognition {
  rooms: RecognizedRoom[];
  connections: RecognizedConnection[];
  scaleSuggestion?: ScaleSuggestion;
  /** Non-fatal problems (dropped connections, clamped values, …). */
  warnings: string[];
}

export const DEFAULT_VISION_TIMEOUT_MS = 120_000;

const CONNECTION_KINDS: readonly IRConnectionKind[] = [
  'door',
  'open',
  'stair',
  'elevator',
  'shaft',
  'window-to-outdoor',
];

/** Constrained-decoding schema for the recognition (ChatParams.format). */
export const FLOORPLAN_RECOGNITION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          occupancy: { type: 'number' },
        },
        required: ['ref', 'x', 'y', 'width', 'height'],
      },
    },
    connections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          kind: { type: 'string', enum: CONNECTION_KINDS },
        },
        required: ['a', 'kind'],
      },
    },
    scale: {
      type: 'object',
      properties: {
        pixelsPerMeter: { type: 'number' },
        note: { type: 'string' },
      },
    },
  },
  required: ['rooms', 'connections'],
};

const SYSTEM_PROMPT = `You are a floor-plan reading component of a building simulator.
Given a raster architectural floor plan, extract the floor's structure for a zone-based simulation:

- Rooms: axis-aligned bounding rectangles in IMAGE PIXEL coordinates (origin at the top-left corner of the image, x right, y down). The coordinates MUST be pixels of the image itself — e.g. a room spanning the left quarter of a 720-pixel-wide image has x≈60, width≈150. NEVER output meters or normalized 0-1 fractions as coordinates; dimension labels printed on the drawing (e.g. "4.0m x 3.0m") are real-world sizes, not pixels. Approximate non-rectangular rooms with their bounding box. Give each room a short stable "ref" (e.g. "r1"), its human-readable name copied VERBATIM from the drawing's labels (a room labeled "101" is named "101" — never invent names that are not printed), and a functional type (classroom, office, corridor, restroom, stairwell, elevator, lobby, ...). Include corridors and halls as rooms too.
- Connections between rooms: "door" (a door leaf is drawn), "open" (open passage, no door). Use "stair"/"elevator"/"shaft" for the vertical-circulation rooms themselves (connect the stairwell room to the corridor it opens onto, kind "open", and mark the room type accordingly). Use "window-to-outdoor" for rooms with windows or doors on the exterior wall (omit "b" for these).
- Scale: if the drawing carries a legible scale bar or dimension annotation, report it as scale.pixelsPerMeter (image pixels represented by one real-world meter) with a note quoting what you saw. Examples: a scale bar 250 pixels long labeled "5m" means 250/5 = 50 pixelsPerMeter; a room 200 pixels wide labeled "4.0m" means 200/4 = 50 pixelsPerMeter. If none is legible, omit "scale" entirely — never guess.

Answer with the JSON object only.`;

/**
 * Run the multimodal recognition step. Throws `FloorplanVisionError` on
 * call failure, timeout, or output that does not satisfy the schema.
 */
export async function recognizeFloorplan(
  client: VisionChatClient,
  options: RecognizeFloorplanOptions,
): Promise<FloorplanRecognition> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  let response: ChatResponse;
  try {
    response = await withTimeout(
      client.chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(options) },
        ],
        format: FLOORPLAN_RECOGNITION_SCHEMA,
        temperature: 0,
        ...(options.model !== undefined ? { model: options.model } : {}),
      }),
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof FloorplanVisionError) throw error;
    throw new FloorplanVisionError(
      `floor-plan recognition LLM call failed: ${(error as Error).message}`,
    );
  }

  return parseRecognition(response.content);
}

/** Compose the multimodal user message: instructions + CV candidates + image. */
function buildUserContent(
  options: RecognizeFloorplanOptions,
): ChatParams['messages'][number]['content'] {
  const lines = ['Extract the structure of this floor plan.'];
  const candidates = options.preprocessed?.candidateRooms ?? [];
  if (candidates.length > 0) {
    lines.push(
      'A CV preprocessing pass suggests these candidate room boxes (pixel coordinates; may be incomplete or wrong — verify against the image):',
      JSON.stringify(candidates),
    );
  }
  for (const note of options.preprocessed?.notes ?? []) {
    lines.push(`Preprocessor note: ${note}`);
  }
  return [
    { type: 'text', text: lines.join('\n') },
    {
      type: 'image_url',
      image_url: { url: `data:${options.image.mimeType};base64,${options.image.base64}` },
    },
  ];
}

/**
 * Parse + validate the structured response. Lenient like the LLMReviewer:
 * code fences and surrounding prose are stripped; the result is re-checked
 * field by field because `format` is only a best-effort constraint.
 */
export function parseRecognition(content: string): FloorplanRecognition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = /\{[\s\S]*\}/.exec(content);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = undefined;
      }
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FloorplanVisionError(
      'floor-plan recognition returned unparseable output (not JSON)',
      [content.slice(0, 300)],
    );
  }

  const raw = parsed as {
    rooms?: unknown;
    connections?: unknown;
    scale?: unknown;
  };
  if (!Array.isArray(raw.rooms)) {
    throw new FloorplanVisionError(
      'floor-plan recognition returned a non-compliant result: "rooms" must be an array',
      [content.slice(0, 300)],
    );
  }

  const warnings: string[] = [];
  const issues: string[] = [];
  const rooms: RecognizedRoom[] = [];
  const refs = new Set<string>();

  raw.rooms.forEach((entry, index) => {
    const room = entry as Record<string, unknown>;
    const where = `rooms[${index}]`;
    if (typeof room !== 'object' || room === null || typeof room.ref !== 'string' || room.ref.length === 0) {
      issues.push(`${where}: missing string "ref"`);
      return;
    }
    const numbers = ['x', 'y', 'width', 'height'] as const;
    const values: Record<string, number> = {};
    for (const key of numbers) {
      const value = room[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(`${where} ("${room.ref}"): "${key}" must be a finite number`);
        return;
      }
      values[key] = value;
    }
    if (values.width <= 0 || values.height <= 0) {
      issues.push(`${where} ("${room.ref}"): width/height must be positive`);
      return;
    }
    if (refs.has(room.ref as string)) {
      issues.push(`${where}: duplicate ref "${room.ref}"`);
      return;
    }
    refs.add(room.ref as string);
    rooms.push({
      ref: room.ref as string,
      ...(typeof room.name === 'string' && room.name.length > 0 ? { name: room.name } : {}),
      ...(typeof room.type === 'string' && room.type.length > 0 ? { type: room.type } : {}),
      x: values.x,
      y: values.y,
      width: values.width,
      height: values.height,
      ...(typeof room.occupancy === 'number' && Number.isFinite(room.occupancy) && room.occupancy >= 0
        ? { occupancy: Math.round(room.occupancy) }
        : {}),
    });
  });

  const connections: RecognizedConnection[] = [];
  if (raw.connections !== undefined && !Array.isArray(raw.connections)) {
    issues.push('"connections" must be an array when present');
  }
  for (const [index, entry] of (Array.isArray(raw.connections) ? raw.connections : []).entries()) {
    const connection = entry as Record<string, unknown>;
    const where = `connections[${index}]`;
    if (
      typeof connection !== 'object' ||
      connection === null ||
      typeof connection.a !== 'string' ||
      !CONNECTION_KINDS.includes(connection.kind as IRConnectionKind)
    ) {
      warnings.push(`${where}: dropped (needs "a" and a known "kind")`);
      continue;
    }
    const kind = connection.kind as IRConnectionKind;
    const b = typeof connection.b === 'string' && connection.b.length > 0 ? connection.b : undefined;
    if (kind === 'window-to-outdoor') {
      if (!refs.has(connection.a)) {
        warnings.push(`${where}: dropped (unknown room ref "${connection.a}")`);
        continue;
      }
      connections.push({ a: connection.a, kind });
      continue;
    }
    if (b === undefined || !refs.has(connection.a) || !refs.has(b)) {
      warnings.push(`${where}: dropped (kind "${kind}" needs two known room refs)`);
      continue;
    }
    connections.push({ a: connection.a, b, kind });
  }

  let scaleSuggestion: ScaleSuggestion | undefined;
  if (typeof raw.scale === 'object' && raw.scale !== null) {
    const scale = raw.scale as Record<string, unknown>;
    if (
      typeof scale.pixelsPerMeter === 'number' &&
      Number.isFinite(scale.pixelsPerMeter) &&
      scale.pixelsPerMeter > 0
    ) {
      scaleSuggestion = {
        pixelsPerMeter: scale.pixelsPerMeter,
        ...(typeof scale.note === 'string' && scale.note.length > 0 ? { note: scale.note } : {}),
      };
    }
  }

  if (issues.length > 0) {
    throw new FloorplanVisionError(
      'floor-plan recognition returned a non-compliant result',
      issues,
    );
  }
  if (rooms.length === 0) {
    throw new FloorplanVisionError(
      'floor-plan recognition found no rooms — check that the image is a legible floor plan',
    );
  }

  return { rooms, connections, ...(scaleSuggestion !== undefined ? { scaleSuggestion } : {}), warnings };
}

// ---------------------------------------------------------------------------
// Scale calibration
// ---------------------------------------------------------------------------

/** A caller-supplied known-dimension annotation on the image. */
export interface ScaleCalibrationSegment {
  /** Segment endpoints in IMAGE PIXEL coordinates. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Real-world length of that segment, in meters. */
  meters: number;
}

/**
 * pixelsPerMeter from a known-dimension annotation ("the segment
 * (x1,y1)-(x2,y2) on the image is N meters").
 */
export function pixelsPerMeterFromCalibration(segment: ScaleCalibrationSegment): number {
  const { x1, y1, x2, y2, meters } = segment;
  for (const [key, value] of Object.entries({ x1, y1, x2, y2, meters })) {
    if (!Number.isFinite(value)) {
      throw new FloorplanVisionError(`scale calibration: "${key}" must be a finite number`);
    }
  }
  if (meters <= 0) {
    throw new FloorplanVisionError('scale calibration: "meters" must be positive');
  }
  const pixels = Math.hypot(x2 - x1, y2 - y1);
  if (pixels === 0) {
    throw new FloorplanVisionError(
      'scale calibration: the two segment endpoints coincide — zero pixel distance',
    );
  }
  return pixels / meters;
}

export interface ResolvedScale {
  pixelsPerMeter: number;
  source: 'explicit' | 'calibration';
}

/**
 * Resolve the caller-confirmed scale. Exactly one of `pixelsPerMeter`
 * (explicit) or `calibration` (known-dimension segment) must be given; the
 * LLM's `scaleSuggestion` is NEVER consulted here — it is the caller's job
 * to review the suggestion and pass it explicitly when accepted.
 */
export function resolveFloorplanScale(options: {
  pixelsPerMeter?: number;
  calibration?: ScaleCalibrationSegment;
}): ResolvedScale {
  const { pixelsPerMeter, calibration } = options;
  if (pixelsPerMeter !== undefined && calibration !== undefined) {
    throw new FloorplanVisionError(
      'scale: pass either an explicit pixelsPerMeter or a calibration segment, not both',
    );
  }
  if (pixelsPerMeter !== undefined) {
    if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0) {
      throw new FloorplanVisionError('scale: pixelsPerMeter must be a positive finite number');
    }
    return { pixelsPerMeter, source: 'explicit' };
  }
  if (calibration !== undefined) {
    return { pixelsPerMeter: pixelsPerMeterFromCalibration(calibration), source: 'calibration' };
  }
  throw new FloorplanVisionError(
    'scale: a pixelsPerMeter value is required — pass it explicitly or derive it from a ' +
      'known-dimension calibration segment (a scale read off the drawing by the LLM is only ' +
      'a suggestion and must be confirmed by the caller)',
  );
}

// ---------------------------------------------------------------------------
// Recognition → IR
// ---------------------------------------------------------------------------

export interface FloorplanIRInput {
  name: string;
  buildingId: string;
  buildingName?: string;
  floor: number;
  /** Confirmed scale (output of resolveFloorplanScale). */
  pixelsPerMeter: number;
  recognition: FloorplanRecognition;
  /** Plan-image underlay reference kept on the IR floor (URL or data URI). */
  planImage?: string;
  storeyHeight?: number;
  description?: string;
}

/**
 * Convert a pixel-space recognition into a meter-space Building IR for one
 * floor. Room ids are derived from names/refs and suffixed with the floor
 * (`-f<n>`), matching the IFC importer's convention.
 */
export function buildFloorplanIR(input: FloorplanIRInput): BuildingIR {
  const { recognition, pixelsPerMeter } = input;
  const toMeters = (pixels: number) => round2(pixels / pixelsPerMeter);

  const usedIds = new Set<string>();
  const roomIdByRef = new Map<string, string>();
  const rooms: IRRoom[] = recognition.rooms.map((room, index) => {
    const base = slugify(room.name ?? '') || slugify(room.ref) || `room${index + 1}`;
    let id = `${base}-f${input.floor}`;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-f${input.floor}-${n}`;
    usedIds.add(id);
    roomIdByRef.set(room.ref, id);
    return {
      id,
      buildingId: input.buildingId,
      floor: input.floor,
      ...(room.name !== undefined ? { name: room.name } : {}),
      ...(room.type !== undefined ? { type: room.type } : {}),
      bounds: {
        minX: toMeters(room.x),
        maxX: toMeters(room.x + room.width),
        minY: toMeters(room.y),
        maxY: toMeters(room.y + room.height),
      },
      ...(room.occupancy !== undefined ? { occupancy: room.occupancy } : {}),
    };
  });

  const connections: IRConnection[] = recognition.connections.map(connection => {
    const a = roomIdByRef.get(connection.a)!;
    if (connection.kind === 'window-to-outdoor') return { a, kind: connection.kind };
    return { a, b: roomIdByRef.get(connection.b!)!, kind: connection.kind };
  });

  return {
    meta: {
      name: input.name,
      ...(input.storeyHeight !== undefined ? { storeyHeight: input.storeyHeight } : {}),
      units: 'm',
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    buildings: [
      {
        id: input.buildingId,
        ...(input.buildingName !== undefined ? { name: input.buildingName } : {}),
      },
    ],
    floors: [
      {
        buildingId: input.buildingId,
        floor: input.floor,
        ...(input.planImage !== undefined ? { planImage: input.planImage } : {}),
        scale: { pixelsPerMeter },
      },
    ],
    rooms,
    connections,
    envelope: [],
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** kebab-case slug; empty when nothing usable remains. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Race the LLM call against the budget; the timer never leaks. */
async function withTimeout(promise: Promise<ChatResponse>, timeoutMs: number): Promise<ChatResponse> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FloorplanVisionError(`floor-plan recognition LLM timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
