/**
 * @vitest-environment node
 *
 * Floorplan vision importer tests (B-D). The LLM client is always a mock —
 * no real model is ever called. Covers:
 * - recognition → IR fragment structure (pixel → meter conversion, ids,
 *   connection ref resolution)
 * - the constrained-output schema + multimodal message shape sent to the LLM
 * - lenient parsing (code fences) and the non-compliant / call-failure paths
 * - both scale calibration modes and the never-auto-apply-suggestion rule
 * - IR → compile → loadScenarioFile round-trip
 */

import { describe, expect, it } from 'vitest';

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import { compileBuildingIR } from './building-compiler.js';
import {
  FLOORPLAN_RECOGNITION_SCHEMA,
  FloorplanVisionError,
  buildFloorplanIR,
  parseRecognition,
  pixelsPerMeterFromCalibration,
  recognizeFloorplan,
  resolveFloorplanScale,
  type FloorplanRecognition,
  type VisionChatClient,
} from './floorplan-vision.js';
import { loadScenarioFile } from './scenario-loader.js';

const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };

const RECOGNITION_JSON = JSON.stringify({
  rooms: [
    { ref: 'r1', name: '308 Classroom', type: 'classroom', x: 10, y: 20, width: 80, height: 60, occupancy: 40 },
    { ref: 'r2', name: 'Corridor', type: 'corridor', x: 90, y: 20, width: 20, height: 120 },
  ],
  connections: [
    { a: 'r1', b: 'r2', kind: 'door' },
    { a: 'r1', kind: 'window-to-outdoor' },
  ],
  scale: { pixelsPerMeter: 12.5, note: 'scale bar "0 5 10m"' },
});

function mockClient(content: string | Error): VisionChatClient & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  return {
    calls,
    chat: (params: ChatParams): Promise<ChatResponse> => {
      calls.push(params);
      if (content instanceof Error) return Promise.reject(content);
      return Promise.resolve({ content, model: 'mock-vision' });
    },
  };
}

function recognition(overrides: Partial<FloorplanRecognition> = {}): FloorplanRecognition {
  return {
    rooms: [
      { ref: 'r1', name: '308 Classroom', x: 10, y: 20, width: 80, height: 60 },
      { ref: 'r2', name: 'Corridor', x: 90, y: 20, width: 20, height: 120 },
    ],
    connections: [
      { a: 'r1', b: 'r2', kind: 'door' },
      { a: 'r1', kind: 'window-to-outdoor' },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('recognizeFloorplan', () => {
  it('sends the constrained schema and a multimodal message, returns the parsed recognition', async () => {
    const client = mockClient(RECOGNITION_JSON);
    const result = await recognizeFloorplan(client, { image: IMAGE });

    expect(client.calls).toHaveLength(1);
    const params = client.calls[0];
    expect(params.format).toBe(FLOORPLAN_RECOGNITION_SCHEMA);
    expect(params.temperature).toBe(0);
    const user = params.messages[1];
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.map(part => part.type)).toEqual(['text', 'image_url']);
    expect(parts[1].image_url!.url).toBe(`data:${IMAGE.mimeType};base64,${IMAGE.base64}`);

    expect(result.rooms).toHaveLength(2);
    expect(result.rooms[0]).toMatchObject({ ref: 'r1', name: '308 Classroom', x: 10, width: 80 });
    expect(result.connections).toEqual([
      { a: 'r1', b: 'r2', kind: 'door' },
      { a: 'r1', kind: 'window-to-outdoor' },
    ]);
    expect(result.scaleSuggestion).toEqual({ pixelsPerMeter: 12.5, note: 'scale bar "0 5 10m"' });
  });

  it('inlines preprocessor candidates into the prompt text', async () => {
    const client = mockClient(RECOGNITION_JSON);
    await recognizeFloorplan(client, {
      image: IMAGE,
      preprocessed: {
        candidateRooms: [{ x: 1, y: 2, width: 3, height: 4, label: '308' }],
        notes: ['detected 12 wall segments'],
      },
    });
    const parts = client.calls[0].messages[1].content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain('"label":"308"');
    expect(parts[0].text).toContain('detected 12 wall segments');
  });

  it('parses leniently when the model wraps JSON in prose + code fences', () => {
    const wrapped = `Here is the extraction:\n\`\`\`json\n${RECOGNITION_JSON}\n\`\`\`\nHope this helps!`;
    const result = parseRecognition(wrapped);
    expect(result.rooms).toHaveLength(2);
  });

  it('drops invalid connections with warnings instead of failing', () => {
    const result = parseRecognition(
      JSON.stringify({
        rooms: [{ ref: 'r1', x: 0, y: 0, width: 10, height: 10 }],
        connections: [
          { a: 'r1', b: 'ghost', kind: 'door' },
          { a: 'r1', kind: 'teleport' },
          { a: 'r1', kind: 'window-to-outdoor' },
        ],
      }),
    );
    expect(result.connections).toEqual([{ a: 'r1', kind: 'window-to-outdoor' }]);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects unparseable output with a friendly error', async () => {
    const client = mockClient('sorry, I cannot see any floor plan');
    await expect(recognizeFloorplan(client, { image: IMAGE })).rejects.toThrow(FloorplanVisionError);
    await expect(recognizeFloorplan(client, { image: IMAGE })).rejects.toThrow(/unparseable/);
  });

  it('rejects schema-breaking output (bad room geometry) with issues', async () => {
    const client = mockClient(
      JSON.stringify({ rooms: [{ ref: 'r1', x: 0, y: 0, width: -5, height: 10 }], connections: [] }),
    );
    const error = await recognizeFloorplan(client, { image: IMAGE }).catch(e => e);
    expect(error).toBeInstanceOf(FloorplanVisionError);
    expect(error.message).toContain('non-compliant');
    expect(error.issues[0]).toContain('width/height must be positive');
  });

  it('rejects an empty room list (nothing recognized)', () => {
    expect(() => parseRecognition(JSON.stringify({ rooms: [], connections: [] }))).toThrow(
      /no rooms/,
    );
  });

  it('wraps LLM call failures in FloorplanVisionError', async () => {
    const client = mockClient(new Error('connection refused'));
    await expect(recognizeFloorplan(client, { image: IMAGE })).rejects.toThrow(
      /LLM call failed: connection refused/,
    );
  });
});

describe('scale calibration', () => {
  it('derives pixelsPerMeter from a known-dimension segment (3-4-5 triangle)', () => {
    // 300-400 px segment → 500 px; the segment is annotated as 8 m → 62.5 px/m.
    expect(pixelsPerMeterFromCalibration({ x1: 0, y1: 0, x2: 300, y2: 400, meters: 8 })).toBe(62.5);
  });

  it('rejects degenerate calibration input', () => {
    expect(() =>
      pixelsPerMeterFromCalibration({ x1: 5, y1: 5, x2: 5, y2: 5, meters: 8 }),
    ).toThrow(/zero pixel distance/);
    expect(() =>
      pixelsPerMeterFromCalibration({ x1: 0, y1: 0, x2: 10, y2: 0, meters: 0 }),
    ).toThrow(/"meters" must be positive/);
  });

  it('resolves explicit or calibrated scale, never the LLM suggestion', () => {
    expect(resolveFloorplanScale({ pixelsPerMeter: 20 })).toEqual({
      pixelsPerMeter: 20,
      source: 'explicit',
    });
    expect(
      resolveFloorplanScale({ calibration: { x1: 0, y1: 0, x2: 0, y2: 160, meters: 8 } }),
    ).toEqual({ pixelsPerMeter: 20, source: 'calibration' });
    expect(() =>
      resolveFloorplanScale({
        pixelsPerMeter: 20,
        calibration: { x1: 0, y1: 0, x2: 0, y2: 160, meters: 8 },
      }),
    ).toThrow(/not both/);
    // No caller input → error, even though a suggestion might exist: the
    // suggestion is never consulted here.
    expect(() => resolveFloorplanScale({})).toThrow(/never|confirmed|required/);
    expect(() => resolveFloorplanScale({ pixelsPerMeter: -1 })).toThrow(/positive/);
  });
});

describe('buildFloorplanIR + compile round-trip', () => {
  it('converts pixel rooms to meter bounds and compiles to a valid scenario', () => {
    const ir = buildFloorplanIR({
      name: 'Vision Building',
      buildingId: 'VB',
      floor: 2,
      pixelsPerMeter: 10,
      recognition: recognition(),
      planImage: 'data:image/png;base64,aGVsbG8=',
    });

    expect(ir.buildings).toEqual([{ id: 'VB' }]);
    expect(ir.floors).toEqual([
      { buildingId: 'VB', floor: 2, planImage: 'data:image/png;base64,aGVsbG8=', scale: { pixelsPerMeter: 10 } },
    ]);
    expect(ir.rooms).toHaveLength(2);
    const classroom = ir.rooms.find(room => room.name === '308 Classroom')!;
    expect(classroom.id).toBe('308-classroom-f2');
    expect(classroom.bounds).toEqual({ minX: 1, maxX: 9, minY: 2, maxY: 8 });
    expect(ir.connections).toEqual([
      { a: '308-classroom-f2', b: 'corridor-f2', kind: 'door' },
      { a: '308-classroom-f2', kind: 'window-to-outdoor' },
    ]);

    // The compiled scenario passes full scenario validation (compiler runs
    // loadScenarioFile internally; run it again to assert the round-trip).
    const scenario = compileBuildingIR(ir, { scenarioId: 'vision-building' });
    expect(() => loadScenarioFile(scenario)).not.toThrow();
    const zone = scenario.zones.find(z => z.id === '308-classroom-f2')!;
    expect(zone.floor).toBe(2);
    expect(zone.buildingId).toBe('VB');
    expect(scenario.zones.some(z => z.type === 'outdoor')).toBe(true);
    // The plan-image underlay rides the non-validated `map` block (B-D).
    expect(scenario.map).toEqual({
      floorPlans: [
        {
          buildingId: 'VB',
          floor: 2,
          image: 'data:image/png;base64,aGVsbG8=',
          pixelsPerMeter: 10,
        },
      ],
    });
  });
});
