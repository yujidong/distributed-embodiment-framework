/**
 * @vitest-environment node
 *
 * NL environment importer tests (UX wave-5). The LLM client is always a
 * stub — no real model is ever called. Covers:
 * - lenient parsing (code fences / prose) + non-compliant / call-failure
 *   paths and count clamping
 * - repeat/count expansion math (the "3 floors × 8 wards" collapse)
 * - synthesized grid geometry, hub/chain adjacency, stair-shaft synthesis
 *   (auto-added stairwell when the description names none)
 * - device placements + agent skeleton carried alongside the IR
 * - IR → compile → loadScenarioFile round-trip
 * - the guided-decoding schema + prompt vocabulary injection
 */

import { describe, expect, it } from 'vitest';

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import { compileBuildingIR } from './building-compiler.js';
import {
  NL_IMPORT_SCHEMA,
  NLImportError,
  buildNLImportIR,
  buildNLImportSystemPrompt,
  parseNLRecognition,
  recognizeEnvironmentFromText,
  type NLImportChatClient,
} from './nl-import.js';
import { loadScenarioFile } from './scenario-loader.js';

const HOSPITAL = {
  name: '医院',
  buildingName: '住院楼',
  floors: [
    {
      floor: 0,
      repeat: 3,
      rooms: [
        {
          ref: 'ward',
          name: '病房',
          type: 'ward',
          count: 8,
          devices: [{ type: 'smoke-sensor' }],
        },
        { ref: 'nurse-station', name: '护士站', type: 'nurse-station' },
        { ref: 'corridor', name: '走廊', type: 'corridor' },
      ],
    },
  ],
  agents: [{ name: '护士', capabilities: ['patient-care', 'monitoring'] }],
};

function stubClient(content: string = JSON.stringify(HOSPITAL)): NLImportChatClient & {
  lastParams?: ChatParams;
} {
  const client: NLImportChatClient & { lastParams?: ChatParams } = {
    chat: (params: ChatParams) => {
      client.lastParams = params;
      return Promise.resolve({ content, model: 'stub-nl' } as ChatResponse);
    },
  };
  return client;
}

const DEVICE_VOCAB = ['smoke-sensor', 'thermostat', 'surveillance-camera'];

describe('parseNLRecognition', () => {
  it('parses a compliant document (repeat/count preserved)', () => {
    const recognition = parseNLRecognition(JSON.stringify(HOSPITAL));
    expect(recognition.name).toBe('医院');
    expect(recognition.buildingName).toBe('住院楼');
    expect(recognition.floors).toHaveLength(1);
    expect(recognition.floors[0]).toMatchObject({ floor: 0, repeat: 3 });
    expect(recognition.floors[0].rooms[0]).toMatchObject({ ref: 'ward', count: 8 });
    expect(recognition.floors[0].rooms[0].devices).toEqual([{ type: 'smoke-sensor', count: 1 }]);
    expect(recognition.agents).toEqual([{ name: '护士', capabilities: ['patient-care', 'monitoring'] }]);
  });

  it('strips code fences / surrounding prose', () => {
    const wrapped = `好的，这是结果：\n\`\`\`json\n${JSON.stringify(HOSPITAL)}\n\`\`\`\n请查收。`;
    expect(parseNLRecognition(wrapped).floors).toHaveLength(1);
  });

  it('throws NLImportError on unparseable output and missing floors', () => {
    expect(() => parseNLRecognition('not json at all')).toThrow(NLImportError);
    expect(() => parseNLRecognition('{"name":"x"}')).toThrow(/"floors" must be an array/);
  });

  it('returns floors: [] for the no-building-cues contract (route turns it into 422)', () => {
    const recognition = parseNLRecognition('{"name":"","floors":[]}');
    expect(recognition.floors).toEqual([]);
  });

  it('clamps runaway counts with warnings instead of failing the draft', () => {
    const recognition = parseNLRecognition(JSON.stringify({
      name: 'x',
      floors: [
        { floor: 0, repeat: 99, rooms: [{ ref: 'r', count: 500, devices: [{ type: 'smoke-sensor', count: 42 }] }] },
      ],
    }));
    expect(recognition.floors[0].repeat).toBe(20);
    expect(recognition.floors[0].rooms[0].count).toBe(50);
    expect(recognition.floors[0].rooms[0].devices[0].count).toBe(10);
    expect(recognition.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('drops malformed entries with warnings (bad floor, missing ref, bad device)', () => {
    const recognition = parseNLRecognition(JSON.stringify({
      name: 'x',
      floors: [
        { floor: 'ground', rooms: [{ ref: 'a' }] },
        { floor: 0, rooms: [{ name: 'no ref' }, { ref: 'ok', devices: [{ count: 2 }] }] },
      ],
    }));
    expect(recognition.floors).toHaveLength(1);
    expect(recognition.floors[0].rooms).toHaveLength(1);
    expect(recognition.floors[0].rooms[0].ref).toBe('ok');
    expect(recognition.warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildNLImportIR', () => {
  it('expands repeat × count into concrete rooms (3 floors × 10 patterns)', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    const wards = built.ir.rooms.filter(room => room.type === 'ward');
    expect(wards).toHaveLength(24); // 3 floors × 8 wards
    expect(built.ir.rooms.filter(room => room.type === 'nurse-station')).toHaveLength(3);
    expect(built.ir.floors).toHaveLength(3);
    // Numbered names: 病房 1..8 per floor.
    expect(wards.filter(room => room.floor === 0).map(room => room.name)).toContain('病房 8');
    // All geometry is synthesized + flagged for the confirmation UI.
    expect(built.ir.rooms.every(room => room.estimated === true && room.bounds !== undefined)).toBe(true);
  });

  it('stars same-floor rooms onto the corridor hub', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    const corridor = built.ir.rooms.find(room => room.type === 'corridor' && room.floor === 0)!;
    const ward = built.ir.rooms.find(room => room.type === 'ward' && room.floor === 0)!;
    expect(built.ir.connections).toContainEqual({ a: ward.id, b: corridor.id, kind: 'open' });
  });

  it('auto-adds a stairwell per floor and chains a stair shaft when none is described', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    const stairwells = built.ir.rooms.filter(room => room.type === 'stairwell');
    expect(stairwells).toHaveLength(3);
    const stairLinks = built.ir.connections.filter(c => c.kind === 'stair');
    expect(stairLinks).toHaveLength(2); // f0→f1, f1→f2
    expect(built.warnings.some(w => w.includes('auto-added one stairwell per floor'))).toBe(true);
  });

  it('uses described stairwells/elevators instead of synthesizing', () => {
    const recognition = parseNLRecognition(JSON.stringify({
      name: 'mall',
      floors: [
        {
          floor: 0,
          repeat: 2,
          rooms: [
            { ref: 'shop', type: 'shop', count: 4 },
            { ref: 'stairs', name: '楼梯', type: 'stairwell' },
            { ref: 'lift', name: '电梯', type: 'elevator' },
          ],
        },
      ],
    }));
    const built = buildNLImportIR({ recognition });
    expect(built.ir.rooms.filter(room => room.type === 'stairwell')).toHaveLength(2);
    expect(built.warnings.some(w => w.includes('auto-added'))).toBe(false);
    expect(built.ir.connections.filter(c => c.kind === 'stair')).toHaveLength(1);
    expect(built.ir.connections.filter(c => c.kind === 'elevator')).toHaveLength(1);
  });

  it('chains rooms when no hub type exists on the floor', () => {
    const recognition = parseNLRecognition(JSON.stringify({
      name: 'x',
      floors: [{ floor: 0, rooms: [{ ref: 'a', type: 'storage' }, { ref: 'b', type: 'lab' }] }],
    }));
    const built = buildNLImportIR({ recognition });
    const opens = built.ir.connections.filter(c => c.kind === 'open');
    expect(opens).toHaveLength(1);
    expect(opens[0].a).not.toBe(opens[0].b);
  });

  it('expands device placements onto every replicated room', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    expect(built.devices).toHaveLength(24); // one smoke-sensor per ward
    expect(built.devices[0]).toMatchObject({ type: 'smoke-sensor' });
    const wardZoneIds = new Set(built.ir.rooms.filter(r => r.type === 'ward').map(r => r.id));
    expect(built.devices.every(d => wardZoneIds.has(d.zoneId))).toBe(true);
    expect(new Set(built.devices.map(d => d.id)).size).toBe(24);
  });

  it('carries the agent skeleton with slugged ids', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    expect(built.agents).toEqual([{ id: 'agent-1', name: '护士', capabilities: ['patient-care', 'monitoring'] }]);
  });

  it('compiles into a loadable scenario (round-trip contract)', () => {
    const built = buildNLImportIR({ recognition: parseNLRecognition(JSON.stringify(HOSPITAL)) });
    const draft = compileBuildingIR(built.ir);
    draft.devices.push(
      ...built.devices.map(d => ({ id: d.id, name: d.name, type: d.type, capabilities: ['detect-smoke'], zoneId: d.zoneId })),
    );
    draft.agents.push(...built.agents);
    expect(() => loadScenarioFile(draft)).not.toThrow();
    // Adjacency made it into the zones.
    const corridor = draft.zones.find(z => z.type === 'corridor' && z.floor === 0)!;
    expect(corridor.adjacentZoneIds?.length).toBeGreaterThan(0);
  });

  it('throws NLImportError when expansion yields zero rooms', () => {
    expect(() =>
      buildNLImportIR({ recognition: { name: 'x', floors: [], agents: [], warnings: [] } }),
    ).toThrow(NLImportError);
  });
});

describe('recognizeEnvironmentFromText', () => {
  it('sends the guided schema + vocabulary-injected system prompt', async () => {
    const client = stubClient();
    const recognition = await recognizeEnvironmentFromText(client, {
      text: '我要一个 3 层医院',
      deviceTypes: DEVICE_VOCAB,
    });
    expect(recognition.floors).toHaveLength(1);
    const params = client.lastParams!;
    expect(params.format).toBe(NL_IMPORT_SCHEMA);
    expect(params.temperature).toBe(0);
    const system = params.messages[0];
    expect(typeof system.content === 'string' && system.content).toContain('smoke-sensor');
    expect(typeof system.content === 'string' && system.content).toContain('宁缺毋滥');
    const user = params.messages[1];
    expect(typeof user.content === 'string' && user.content).toContain('我要一个 3 层医院');
  });

  it('wraps call failures in NLImportError', async () => {
    const client: NLImportChatClient = {
      chat: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8000')),
    };
    await expect(
      recognizeEnvironmentFromText(client, { text: 'x', deviceTypes: DEVICE_VOCAB }),
    ).rejects.toThrow(NLImportError);
  });
});

describe('buildNLImportSystemPrompt', () => {
  it('injects the device vocabulary verbatim and teaches the repeat/count collapse', () => {
    const prompt = buildNLImportSystemPrompt({ deviceTypes: DEVICE_VOCAB });
    expect(prompt).toContain('smoke-sensor, thermostat, surveillance-camera');
    expect(prompt).toContain('repeat=3');
    expect(prompt).toContain('count=8');
    expect(prompt).toContain('"floors":[]');
  });
});
