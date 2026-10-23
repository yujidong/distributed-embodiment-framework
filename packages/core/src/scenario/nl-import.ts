/**
 * NL environment importer — one-sentence description → Building IR fragment
 * (UX wave-5: the fourth import draft lane).
 *
 * Pipeline (mirrors the floorplan vision lane, text in place of pixels):
 *
 * 1. LLM (`recognizeEnvironmentFromText`) — the sentence goes to a TEXT chat
 *    model (the NL function route, LLM_NL_MODEL, or the main deployment).
 *    Output is constrained via `ChatParams.format` to a small JSON schema:
 *    floors with `repeat` (identical storeys collapse into one pattern) and
 *    rooms with `count` (identical rooms collapse into one pattern), plus
 *    per-room device placements from the deployment's device-template
 *    vocabulary and an optional agent staff skeleton. The model NEVER emits
 *    scenario JSON directly — only this compact skeleton.
 * 2. `buildNLImportIR` — expands repeat/count deterministically, synthesizes
 *    a grid geometry per floor (the IR has no no-geometry form; cells are
 *    flagged `estimated: true` for the confirmation UI), derives circulation
 *    (same-floor star/chain adjacency, cross-floor stair shaft — a stairwell
 *    per floor is auto-added when the description mentions none), and
 *    returns the device/agent placements alongside the IR.
 * 3. The server route compiles the IR via `compileBuildingIR`, resolves
 *    device capabilities from the simulation package's template registry
 *    (core must not import simulation), re-validates the augmented draft
 *    with `loadScenarioFile`, and returns `{draft, warnings}` — nothing
 *    persists.
 *
 * Error handling follows the floorplan precedent: the constrained schema is
 * re-checked in code, parsing is lenient (code fences / surrounding prose
 * are stripped), and every failure mode raises `NLImportError` with an
 * actionable message. A sentence with no building cues at all is NOT an
 * error here — the recognition comes back with `floors: []` and the route
 * answers a teaching 422 with example phrasings.
 */

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import type {
  BuildingIR,
  IRConnection,
  IRRoom,
} from './building-ir.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Friendly, actionable failure of the NL pipeline. */
export class NLImportError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'NLImportError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Wire contract (LLM output)
// ---------------------------------------------------------------------------

/** The minimal slice of the LLM client this pipeline needs (mock-friendly). */
export interface NLImportChatClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}

/** A device placement inside a room pattern (type from the template vocab). */
export interface NLDevicePlacement {
  type: string;
  count: number;
}

/** A room pattern inside a floor pattern. */
export interface NLRoomPattern {
  ref: string;
  name?: string;
  type?: string;
  count: number;
  occupancy?: number;
  devices: NLDevicePlacement[];
}

/** A floor pattern; `repeat` identical storeys stack upward from `floor`. */
export interface NLFloorPattern {
  floor: number;
  repeat: number;
  rooms: NLRoomPattern[];
}

export interface NLAgentSkeleton {
  name: string;
  capabilities: string[];
}

/** Validated recognition (parse output, pre-expansion). */
export interface NLEnvironmentRecognition {
  name: string;
  description?: string;
  buildingName?: string;
  floors: NLFloorPattern[];
  agents: NLAgentSkeleton[];
  /** Non-fatal problems (clamped counts, dropped entries, …). */
  warnings: string[];
}

/** Constrained-decoding schema for the recognition (ChatParams.format). */
export const NL_IMPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    buildingName: { type: 'string' },
    floors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          floor: { type: 'integer' },
          repeat: { type: 'integer' },
          rooms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string' },
                count: { type: 'integer' },
                occupancy: { type: 'integer' },
                devices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      count: { type: 'integer' },
                    },
                    required: ['type'],
                  },
                },
              },
              required: ['ref'],
            },
          },
        },
        required: ['floor', 'rooms'],
      },
    },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
    },
  },
  required: ['name', 'floors'],
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Zone-type families (mirrors the web zoneVisual category families). */
export const NL_ZONE_TYPE_VOCABULARY: readonly string[] = [
  'classroom', 'office', 'meeting-room', 'ward', 'nurse-station', 'clinic',
  'operating-room', 'pharmacy', 'corridor', 'lobby', 'atrium', 'stairwell',
  'elevator', 'restroom', 'shop', 'restaurant', 'foodcourt', 'kitchen',
  'warehouse', 'aisle', 'bedroom', 'living-room', 'dormitory', 'guestroom',
  'parking', 'storage', 'lab', 'server-room', 'gym', 'library', 'outdoor',
];

export interface NLVocabulary {
  /** Device-template ids (the ONLY legal device types). */
  deviceTypes: readonly string[];
  /** Zone-type suggestions; defaults to NL_ZONE_TYPE_VOCABULARY. */
  zoneTypes?: readonly string[];
}

/**
 * Compose the system prompt. The device vocabulary is injected verbatim so
 * the model cannot invent device types; the example teaches the repeat/count
 * collapse (the key to compact output for "N floors of M rooms" phrasings).
 */
export function buildNLImportSystemPrompt(vocab: NLVocabulary): string {
  const zoneTypes = vocab.zoneTypes ?? NL_ZONE_TYPE_VOCABULARY;
  return `You are a natural-language environment authoring component of a building simulator.
The user describes a built environment in one or two sentences (Chinese or English). Convert the description into a compact JSON skeleton for a zone-based simulation — floors, rooms (zones), devices, and optional agent staff.

Output schema (JSON object only):
{
  "name": string,                 // environment name, in the user's language
  "description"?: string,         // one sentence
  "buildingName"?: string,
  "floors": [{
    "floor": integer,             // 0 = ground floor
    "repeat"?: integer,           // this floor pattern repeats N times upward (use it INSTEAD of enumerating identical floors)
    "rooms": [{
      "ref": string,              // short stable slug, e.g. "ward", "nurse-station"
      "name"?: string,            // human-readable, user's language
      "type"?: string,            // functional zone type (vocabulary below)
      "count"?: integer,          // identical rooms on the floor (default 1; use it INSTEAD of enumerating copies)
      "occupancy"?: integer,
      "devices"?: [{"type": string, "count"?: integer}]
    }]
  }],
  "agents"?: [{"name": string, "capabilities"?: [string]}]   // optional staff skeleton (e.g. nurse, security guard)
}

Principles:
- Less is more (宁缺毋滥): emit only what the sentence states or clearly implies; sensible defaults everywhere else. The compiler synthesizes geometry, corridors and stairwells by itself.
- ALWAYS collapse repetition: "3 层医院，每层 8 个病房" is ONE floor pattern with repeat=3 and ONE room pattern with count=8 — never enumerate 3 floors or 8 rooms.
- Devices go inside the room they belong to (a smoke sensor per ward → the ward pattern's devices). Device types must come EXACTLY from this vocabulary: ${vocab.deviceTypes.join(', ')}.
- Zone types: prefer these families: ${zoneTypes.join(', ')}.
- If the sentence carries NO building/space cues at all (a poem, a question, small talk), answer exactly {"name":"","floors":[]} so the caller can teach the user with examples.

Example input: 我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感
Example output: {"name":"医院","buildingName":"住院楼","floors":[{"floor":0,"repeat":3,"rooms":[{"ref":"ward","name":"病房","type":"ward","count":8,"devices":[{"type":"smoke-sensor"}]},{"ref":"nurse-station","name":"护士站","type":"nurse-station"},{"ref":"corridor","name":"走廊","type":"corridor"}]}],"agents":[{"name":"护士","capabilities":["patient-care","monitoring"]}]}

Answer with the JSON object only.`;
}

// ---------------------------------------------------------------------------
// Recognition (LLM call)
// ---------------------------------------------------------------------------

export interface RecognizeNLOptions {
  text: string;
  deviceTypes: readonly string[];
  zoneTypes?: readonly string[];
  /** Model override (passed through to ChatParams.model). */
  model?: string;
  /** Wall-clock budget for the LLM call (default 60s — text-only). */
  timeoutMs?: number;
}

export const DEFAULT_NL_TIMEOUT_MS = 60_000;

/**
 * Run the NL recognition step. Throws `NLImportError` on call failure,
 * timeout, or output that does not satisfy the schema.
 */
export async function recognizeEnvironmentFromText(
  client: NLImportChatClient,
  options: RecognizeNLOptions,
): Promise<NLEnvironmentRecognition> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NL_TIMEOUT_MS;

  let response: ChatResponse;
  try {
    response = await withTimeout(
      client.chat({
        messages: [
          {
            role: 'system',
            content: buildNLImportSystemPrompt({
              deviceTypes: options.deviceTypes,
              ...(options.zoneTypes !== undefined ? { zoneTypes: options.zoneTypes } : {}),
            }),
          },
          { role: 'user', content: `Environment description: ${options.text}` },
        ],
        format: NL_IMPORT_SCHEMA,
        temperature: 0,
        ...(options.model !== undefined ? { model: options.model } : {}),
      }),
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof NLImportError) throw error;
    throw new NLImportError(
      `NL environment recognition LLM call failed: ${(error as Error).message}`,
    );
  }

  return parseNLRecognition(response.content);
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

const MAX_FLOOR_REPEAT = 20;
const MAX_ROOM_COUNT = 50;
const MAX_DEVICE_COUNT = 10;

/**
 * Parse + validate the structured response. Lenient like the floorplan
 * lane: code fences and surrounding prose are stripped; every field is
 * re-checked because `format` is only a best-effort constraint. Counts are
 * clamped (with warnings) rather than rejected — a model that says "200
 * rooms" should not kill the whole draft.
 */
export function parseNLRecognition(content: string): NLEnvironmentRecognition {
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
    throw new NLImportError(
      'NL environment recognition returned unparseable output (not JSON)',
      [content.slice(0, 300)],
    );
  }

  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.floors)) {
    throw new NLImportError(
      'NL environment recognition returned a non-compliant result: "floors" must be an array',
      [content.slice(0, 300)],
    );
  }

  const warnings: string[] = [];
  const floors: NLFloorPattern[] = [];
  for (const [index, entry] of raw.floors.entries()) {
    const where = `floors[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`${where}: dropped (not an object)`);
      continue;
    }
    const floorEntry = entry as Record<string, unknown>;
    const floorNum = floorEntry.floor;
    if (typeof floorNum !== 'number' || !Number.isInteger(floorNum) || floorNum < 0 || floorNum > 100) {
      warnings.push(`${where}: dropped ("floor" must be an integer in 0..100)`);
      continue;
    }
    let repeat = 1;
    if (typeof floorEntry.repeat === 'number' && Number.isFinite(floorEntry.repeat)) {
      const r = Math.round(floorEntry.repeat);
      if (r > MAX_FLOOR_REPEAT) {
        warnings.push(`${where}: repeat ${r} clamped to ${MAX_FLOOR_REPEAT}`);
        repeat = MAX_FLOOR_REPEAT;
      } else if (r >= 1) {
        repeat = r;
      }
    }
    if (!Array.isArray(floorEntry.rooms) || floorEntry.rooms.length === 0) {
      warnings.push(`${where}: dropped (no rooms)`);
      continue;
    }
    const rooms: NLRoomPattern[] = [];
    for (const [roomIndex, roomEntry] of floorEntry.rooms.entries()) {
      const roomWhere = `${where}.rooms[${roomIndex}]`;
      if (
        typeof roomEntry !== 'object' ||
        roomEntry === null ||
        typeof (roomEntry as Record<string, unknown>).ref !== 'string' ||
        ((roomEntry as Record<string, unknown>).ref as string).trim().length === 0
      ) {
        warnings.push(`${roomWhere}: dropped (missing string "ref")`);
        continue;
      }
      const room = roomEntry as Record<string, unknown>;
      let count = 1;
      if (typeof room.count === 'number' && Number.isFinite(room.count)) {
        const c = Math.round(room.count);
        if (c > MAX_ROOM_COUNT) {
          warnings.push(`${roomWhere} ("${room.ref}"): count ${c} clamped to ${MAX_ROOM_COUNT}`);
          count = MAX_ROOM_COUNT;
        } else if (c >= 1) {
          count = c;
        }
      }
      const devices: NLDevicePlacement[] = [];
      if (room.devices !== undefined && !Array.isArray(room.devices)) {
        warnings.push(`${roomWhere} ("${room.ref}"): "devices" must be an array — ignored`);
      }
      for (const [devIndex, devEntry] of (Array.isArray(room.devices) ? room.devices : []).entries()) {
        const devWhere = `${roomWhere}.devices[${devIndex}]`;
        if (
          typeof devEntry !== 'object' ||
          devEntry === null ||
          typeof (devEntry as Record<string, unknown>).type !== 'string' ||
          ((devEntry as Record<string, unknown>).type as string).trim().length === 0
        ) {
          warnings.push(`${devWhere}: dropped (missing string "type")`);
          continue;
        }
        const dev = devEntry as Record<string, unknown>;
        let devCount = 1;
        if (typeof dev.count === 'number' && Number.isFinite(dev.count)) {
          const c = Math.round(dev.count);
          if (c > MAX_DEVICE_COUNT) {
            warnings.push(`${devWhere}: count ${c} clamped to ${MAX_DEVICE_COUNT}`);
            devCount = MAX_DEVICE_COUNT;
          } else if (c >= 1) {
            devCount = c;
          }
        }
        devices.push({ type: (dev.type as string).trim().toLowerCase(), count: devCount });
      }
      rooms.push({
        ref: (room.ref as string).trim(),
        ...(typeof room.name === 'string' && room.name.trim().length > 0 ? { name: room.name.trim() } : {}),
        ...(typeof room.type === 'string' && room.type.trim().length > 0
          ? { type: room.type.trim().toLowerCase() }
          : {}),
        count,
        ...(typeof room.occupancy === 'number' && Number.isFinite(room.occupancy) && room.occupancy >= 0
          ? { occupancy: Math.round(room.occupancy) }
          : {}),
        devices,
      });
    }
    if (rooms.length > 0) floors.push({ floor: floorNum, repeat, rooms });
  }

  const agents: NLAgentSkeleton[] = [];
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) {
    warnings.push('"agents" must be an array when present — ignored');
  }
  for (const [index, entry] of (Array.isArray(raw.agents) ? raw.agents : []).entries()) {
    const where = `agents[${index}]`;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).name !== 'string' ||
      ((entry as Record<string, unknown>).name as string).trim().length === 0
    ) {
      warnings.push(`${where}: dropped (missing string "name")`);
      continue;
    }
    const agent = entry as Record<string, unknown>;
    const capabilities = Array.isArray(agent.capabilities)
      ? agent.capabilities.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : [];
    agents.push({ name: (agent.name as string).trim(), capabilities });
  }

  return {
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    ...(typeof raw.description === 'string' && raw.description.trim().length > 0
      ? { description: raw.description.trim() }
      : {}),
    ...(typeof raw.buildingName === 'string' && raw.buildingName.trim().length > 0
      ? { buildingName: raw.buildingName.trim() }
      : {}),
    floors,
    agents,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Recognition → IR (expansion + synthesized geometry/circulation)
// ---------------------------------------------------------------------------

/** An expanded device instance bound to a concrete (expanded) zone id. */
export interface NLExpandedDevice {
  id: string;
  name: string;
  /** Device-template id — the server resolves capabilities/role from it. */
  type: string;
  zoneId: string;
}

export interface NLExpandedAgent {
  id: string;
  name: string;
  capabilities: string[];
}

export interface NLBuildResult {
  ir: BuildingIR;
  devices: NLExpandedDevice[];
  agents: NLExpandedAgent[];
  warnings: string[];
}

/** Fallback grid cell size (same as the IFC importer's fallback). */
const CELL_W = 8;
const CELL_H = 6;

const HUB_PATTERN = /corridor|hall|lobby|atrium|aisle|走廊|大厅|中庭/;
/** Fallback hubs when no corridor-like room exists (ward-floor stations…). */
const SECONDARY_HUB_PATTERN = /nurse-station|reception|护士站|前台/;
const STAIR_PATTERN = /stair|楼梯/;
const ELEVATOR_PATTERN = /elevator|lift|电梯/;

/** The circulation hub of a floor: corridor-like first, station-like second. */
function findHub(floorRooms: IRRoom[], exclude?: IRRoom): IRRoom | undefined {
  const haystack = (room: IRRoom) => `${room.type ?? ''} ${room.name ?? ''}`;
  return (
    floorRooms.find(room => room !== exclude && HUB_PATTERN.test(haystack(room))) ??
    floorRooms.find(room => room !== exclude && SECONDARY_HUB_PATTERN.test(haystack(room)))
  );
}

export interface BuildNLImportIROptions {
  recognition: NLEnvironmentRecognition;
  /** Overrides recognition.name (caller-supplied env name wins). */
  name?: string;
  /** Building id; defaults to "main". */
  buildingId?: string;
}

/**
 * Expand a recognition into a Building IR. Geometry is a synthesized
 * per-floor grid (every room flagged `estimated: true`); circulation is
 * derived: same-floor rooms link to a corridor-like hub (or chain when no
 * hub exists), and multi-floor buildings get a stair shaft — auto-adding a
 * stairwell room per floor when the description named none (warning).
 */
export function buildNLImportIR(options: BuildNLImportIROptions): NLBuildResult {
  const { recognition } = options;
  const warnings = [...recognition.warnings];
  const buildingId = options.buildingId ?? 'main';

  // --- expand floor × room patterns -----------------------------------------
  const rooms: IRRoom[] = [];
  const usedIds = new Set<string>();
  const uniqueRoomId = (base: string, floor: number): string => {
    const slug = slugify(base) || 'room';
    let id = `${slug}-f${floor}`;
    for (let n = 2; usedIds.has(id); n++) id = `${slug}-f${floor}-${n}`;
    usedIds.add(id);
    return id;
  };

  /** floor → rooms on that floor (expansion order). */
  const byFloor = new Map<number, IRRoom[]>();
  /** Per expanded room: device placements inherited from its pattern. */
  const devicePlan = new Map<string, { patternName: string; devices: NLDevicePlacement[] }>();

  for (const floorPattern of recognition.floors) {
    for (let r = 0; r < floorPattern.repeat; r++) {
      const floorNum = floorPattern.floor + r;
      for (const roomPattern of floorPattern.rooms) {
        for (let c = 0; c < roomPattern.count; c++) {
          const base = roomPattern.name ?? roomPattern.ref;
          const numbered = roomPattern.count > 1 ? `${base} ${c + 1}` : base;
          // IDs slug from the REF (a stable ASCII slug by contract) — names
          // are display text and may be non-Latin (slugifying "病房 1" would
          // leave a bare "1-f0"). Counted rooms get the index in the ref.
          const idBase = roomPattern.count > 1 ? `${roomPattern.ref}-${c + 1}` : roomPattern.ref;
          const room: IRRoom = {
            id: uniqueRoomId(idBase, floorNum),
            buildingId,
            floor: floorNum,
            name: numbered,
            ...(roomPattern.type !== undefined ? { type: roomPattern.type } : {}),
            ...(roomPattern.occupancy !== undefined ? { occupancy: roomPattern.occupancy } : {}),
            estimated: true,
          };
          rooms.push(room);
          if (!byFloor.has(floorNum)) byFloor.set(floorNum, []);
          byFloor.get(floorNum)!.push(room);
          if (roomPattern.devices.length > 0) {
            devicePlan.set(room.id, { patternName: numbered, devices: roomPattern.devices });
          }
        }
      }
    }
  }

  if (rooms.length === 0) {
    throw new NLImportError(
      'the recognition expanded to zero rooms — nothing to compile',
      ['check the import warnings: floors/rooms may have been dropped during validation'],
    );
  }

  // --- synthesized grid geometry per floor ------------------------------------
  warnings.push(
    'geometry auto-synthesized: rooms are placed on a per-floor grid ' +
    `(${CELL_W}×${CELL_H}m cells) — adjust the layout in the environment builder after import`,
  );
  for (const floorRooms of byFloor.values()) {
    const cols = Math.ceil(Math.sqrt(floorRooms.length));
    floorRooms.forEach((room, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      room.bounds = {
        minX: col * CELL_W,
        maxX: (col + 1) * CELL_W,
        minY: row * CELL_H,
        maxY: (row + 1) * CELL_H,
      };
    });
  }

  // --- circulation -------------------------------------------------------------
  const connections: IRConnection[] = [];
  const floors = [...byFloor.keys()].sort((a, b) => a - b);

  // Same-floor: star to a corridor-like hub, chain when no hub exists.
  for (const floorRooms of byFloor.values()) {
    if (floorRooms.length < 2) continue;
    const hub = findHub(floorRooms);
    if (hub !== undefined) {
      for (const room of floorRooms) {
        if (room !== hub) connections.push({ a: room.id, b: hub.id, kind: 'open' });
      }
    } else {
      for (let i = 0; i < floorRooms.length - 1; i++) {
        connections.push({ a: floorRooms[i].id, b: floorRooms[i + 1].id, kind: 'open' });
      }
    }
  }

  // Cross-floor: stair/elevator shafts (the compiler chains consecutive
  // floors and fills gaps with auto shaft zones).
  if (floors.length > 1) {
    const roomOnFloor = (floor: number, pattern: RegExp): IRRoom | undefined =>
      byFloor.get(floor)?.find(room => pattern.test(`${room.type ?? ''} ${room.name ?? ''}`));

    let stairRooms = floors.map(floor => roomOnFloor(floor, STAIR_PATTERN));
    if (stairRooms.every(room => room === undefined)) {
      // No vertical circulation in the description — auto-add a stairwell
      // per floor so the building is traversable (缺省合理默认).
      warnings.push(
        `multi-floor building with no stairwell in the description — auto-added one stairwell per floor ` +
        `(${floors.length} floors) and chained them as a stair shaft`,
      );
      stairRooms = floors.map(floor => {
        const room: IRRoom = {
          id: uniqueRoomId('stairwell', floor),
          buildingId,
          floor,
          name: `楼梯间 Stairwell (F${floor + 1})`,
          type: 'stairwell',
          estimated: true,
        };
        // Grid corner, one cell below the existing layout.
        room.bounds = { minX: 0, maxX: CELL_W, minY: -CELL_H, maxY: 0 };
        rooms.push(room);
        byFloor.get(floor)!.push(room);
        // Connect the stairwell to the floor's hub (or first room).
        const floorRooms = byFloor.get(floor)!;
        const anchor = findHub(floorRooms, room) ?? floorRooms.find(r => r !== room);
        if (anchor !== undefined) connections.push({ a: room.id, b: anchor.id, kind: 'open' });
        return room;
      });
    }
    for (let i = 0; i < floors.length - 1; i++) {
      const lower = stairRooms[i];
      const upper = stairRooms[i + 1];
      if (lower !== undefined && upper !== undefined) {
        connections.push({ a: lower.id, b: upper.id, kind: 'stair' });
      }
    }
    const elevatorRooms = floors.map(floor => roomOnFloor(floor, ELEVATOR_PATTERN));
    for (let i = 0; i < floors.length - 1; i++) {
      const lower = elevatorRooms[i];
      const upper = elevatorRooms[i + 1];
      if (lower !== undefined && upper !== undefined) {
        connections.push({ a: lower.id, b: upper.id, kind: 'elevator' });
      }
    }
  }

  // --- devices -------------------------------------------------------------------
  const devices: NLExpandedDevice[] = [];
  const usedDeviceIds = new Set<string>();
  for (const [zoneId, plan] of devicePlan) {
    for (const placement of plan.devices) {
      for (let n = 0; n < placement.count; n++) {
        const slug = slugify(placement.type) || 'device';
        let id = `${slug}@${zoneId}`;
        if (placement.count > 1) id = `${slug}-${n + 1}@${zoneId}`;
        for (let k = 2; usedDeviceIds.has(id); k++) id = `${slug}-${n + 1}@${zoneId}-${k}`;
        usedDeviceIds.add(id);
        devices.push({
          id,
          name: `${placement.type} (${plan.patternName})`,
          type: placement.type,
          zoneId,
        });
      }
    }
  }

  // --- agents -------------------------------------------------------------------
  const agents: NLExpandedAgent[] = [];
  const usedAgentIds = new Set<string>();
  for (const [index, skeleton] of recognition.agents.entries()) {
    let id = slugify(skeleton.name) || `agent-${index + 1}`;
    for (let k = 2; usedAgentIds.has(id); k++) id = `${slugify(skeleton.name) || 'agent'}-${k}`;
    usedAgentIds.add(id);
    agents.push({ id, name: skeleton.name, capabilities: skeleton.capabilities });
  }

  const ir: BuildingIR = {
    meta: {
      name: options.name ?? (recognition.name !== '' ? recognition.name : 'NL 环境'),
      units: 'm',
      ...(recognition.description !== undefined ? { description: recognition.description } : {}),
    },
    buildings: [
      {
        id: buildingId,
        ...(recognition.buildingName !== undefined ? { name: recognition.buildingName } : {}),
      },
    ],
    floors: floors.map(floor => ({ buildingId, floor })),
    rooms,
    connections,
    envelope: [],
  };

  return { ir, devices, agents, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** kebab-case slug; empty when nothing usable remains. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Race the LLM call against the budget; the timer never leaks. */
async function withTimeout(promise: Promise<ChatResponse>, timeoutMs: number): Promise<ChatResponse> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new NLImportError(`NL environment recognition LLM timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
