/**
 * @vitest-environment node
 *
 * `eaf import-floorplan` tests (B-D). The vision LLM is ALWAYS a mock — the
 * command takes an injectable client factory for exactly this. Covers:
 * - the vision path end to end (image + scale → IR + scenario files)
 * - scale suggestion hinting when the caller forgot --scale/--calibrate
 * - the --from-ir confirmation round-trip (no LLM involved)
 * - usage/error paths (missing flags, bad calibrate values, missing file)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';

import { run } from '../cli.js';
import { importFloorplanCommand } from '../commands/import-floorplan.js';
import { makeCtx } from '../ctx.js';
import type { IO } from '../io.js';
import { Output } from '../output.js';

const tempDir = mkdtempSync(join(tmpdir(), 'eaf-import-floorplan-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

// A 1×1 transparent PNG — the mock LLM never looks at the bytes, but the
// command requires a readable image with a known extension.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const RECOGNITION_JSON = JSON.stringify({
  rooms: [
    { ref: 'r1', name: '308 Classroom', type: 'classroom', x: 0, y: 0, width: 80, height: 60 },
    { ref: 'r2', name: 'Corridor', type: 'corridor', x: 80, y: 0, width: 20, height: 120 },
  ],
  connections: [
    { a: 'r1', b: 'r2', kind: 'door' },
    { a: 'r1', kind: 'window-to-outdoor' },
  ],
  scale: { pixelsPerMeter: 12.5, note: 'scale bar "0 5 10m"' },
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function makeIo(): { io: IO; result: CliResult } {
  const result: CliResult = { code: -1, stdout: '', stderr: '' };
  const io: IO = {
    env: { EAF_HOME: tempDir },
    cwd: tempDir,
    homeDir: tempDir,
    isTTY: false,
    stdout: chunk => (result.stdout += chunk),
    stderr: chunk => (result.stderr += chunk),
  };
  return { io, result };
}

async function cli(...args: string[]): Promise<CliResult> {
  const { io, result } = makeIo();
  result.code = await run(args, io);
  return result;
}

/** Run the command with an injected mock vision client (no real LLM). */
async function cliWithMockLlm(mockContent: string, ...args: string[]): Promise<CliResult> {
  return cliWithClient(
    () => ({
      chat: (_params: ChatParams): Promise<ChatResponse> =>
        Promise.resolve({ content: mockContent, model: 'mock-vision' }),
    }),
    ...args,
  );
}

/** Run the command with an injected client factory; mirrors cli.ts reportError. */
async function cliWithClient(
  createClient: () => { chat: (params: ChatParams) => Promise<ChatResponse> },
  ...args: string[]
): Promise<CliResult> {
  const { io, result } = makeIo();
  const out = new Output(io, false);
  const ctx = makeCtx(io, out, undefined);
  try {
    await importFloorplanCommand(ctx, args, { createClient });
    result.code = 0;
  } catch (error) {
    // Mirror cli.ts reportError for CliError.
    const cliError = error as { message: string; exitCode?: number; issues?: string[] };
    result.stderr += `error: ${cliError.message}\n`;
    for (const issue of cliError.issues ?? []) result.stderr += `  - ${issue}\n`;
    result.code = cliError.exitCode ?? 1;
  }
  return result;
}

describe('eaf import-floorplan', () => {
  it('runs the vision path: image + --scale → IR + scenario files', async () => {
    writeFileSync(join(tempDir, 'f2.png'), PNG_BYTES);

    const result = await cliWithMockLlm(
      RECOGNITION_JSON,
      'f2.png',
      '--building', 'EB',
      '--floor', '2',
      '--scale', '10',
      '--ir', 'ir.json',
      '--out', 'scenario.json',
    );
    expect(result.code).toBe(0);
    // The drawing-read suggestion is reported but NOT applied (caller gave 10).
    expect(result.stderr).toContain('suggestion 12.5 px/m');
    expect(result.stderr).toContain('caller-confirmed 10 px/m');

    const ir = JSON.parse(readFileSync(join(tempDir, 'ir.json'), 'utf8'));
    expect(ir.buildings).toEqual([{ id: 'EB' }]);
    expect(ir.floors[0]).toMatchObject({ buildingId: 'EB', floor: 2, scale: { pixelsPerMeter: 10 } });
    expect(ir.floors[0].planImage).toMatch(/^data:image\/png;base64,/);
    expect(ir.rooms).toHaveLength(2);
    expect(ir.rooms[0].bounds).toEqual({ minX: 0, maxX: 8, minY: 0, maxY: 6 });

    const scenario = JSON.parse(readFileSync(join(tempDir, 'scenario.json'), 'utf8'));
    expect(scenario.version).toBe('1.0');
    const zoneIds = scenario.zones.map((z: any) => z.id);
    expect(zoneIds).toContain('308-classroom-f2');
    expect(zoneIds).toContain('outdoor');
    expect(scenario.map.floorPlans).toHaveLength(1);
    expect(scenario.map.floorPlans[0]).toMatchObject({ buildingId: 'EB', floor: 2, pixelsPerMeter: 10 });
  });

  it('supports --calibrate as the scale source', async () => {
    writeFileSync(join(tempDir, 'f1.png'), PNG_BYTES);
    const result = await cliWithMockLlm(
      RECOGNITION_JSON,
      'f1.png', '--building', 'EB', '--floor', '1',
      '--calibrate', '0,0,0,160,8', // 160 px segment = 8 m → 20 px/m
      '--ir', 'ir-cal.json',
    );
    expect(result.code).toBe(0);
    const ir = JSON.parse(readFileSync(join(tempDir, 'ir-cal.json'), 'utf8'));
    expect(ir.floors[0].scale).toEqual({ pixelsPerMeter: 20 });
    expect(ir.rooms[0].bounds).toEqual({ minX: 0, maxX: 4, minY: 0, maxY: 3 });
  });

  it('refuses to guess the scale and surfaces the LLM suggestion as a hint', async () => {
    writeFileSync(join(tempDir, 'f3.png'), PNG_BYTES);
    const result = await cliWithMockLlm(
      RECOGNITION_JSON,
      'f3.png', '--building', 'EB', '--floor', '3',
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pixelsPerMeter');
    expect(result.stderr).toContain('12.5 px/m');
    expect(result.stderr).toContain('--scale 12.5');
  });

  it('recompiles an edited IR via --from-ir without any LLM', async () => {
    const ir = {
      meta: { name: 'Round Trip' },
      buildings: [{ id: 'EB' }],
      floors: [{ buildingId: 'EB', floor: 0, scale: { pixelsPerMeter: 10 } }],
      rooms: [
        { id: 'a-f0', buildingId: 'EB', floor: 0, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 4 } },
        { id: 'b-f0', buildingId: 'EB', floor: 0, bounds: { minX: 5, maxX: 9, minY: 0, maxY: 4 } },
      ],
      connections: [{ a: 'a-f0', b: 'b-f0', kind: 'open' }],
      envelope: [],
    };
    writeFileSync(join(tempDir, 'edited.json'), JSON.stringify(ir));

    const result = await cli('import-floorplan', '--from-ir', 'edited.json', '--out', 'rt-scenario.json');
    expect(result.code).toBe(0);
    const scenario = JSON.parse(readFileSync(join(tempDir, 'rt-scenario.json'), 'utf8'));
    expect(scenario.zones).toHaveLength(2);
    expect(scenario.zones[0].adjacentZoneIds).toEqual(['b-f0']);
  });

  it('merges a second floor into an existing IR with --merge', async () => {
    writeFileSync(join(tempDir, 'f1m.png'), PNG_BYTES);
    const result = await cliWithMockLlm(
      RECOGNITION_JSON,
      'f1m.png', '--building', 'EB', '--floor', '1', '--scale', '10',
      '--merge', 'edited.json', '--ir', 'merged.json',
    );
    expect(result.code).toBe(0);
    const merged = JSON.parse(readFileSync(join(tempDir, 'merged.json'), 'utf8'));
    expect(merged.floors).toHaveLength(2);
    expect(merged.rooms).toHaveLength(4);
  });

  it('rejects a malformed --scale BEFORE any LLM call (Fix-6)', async () => {
    writeFileSync(join(tempDir, 'f5.png'), PNG_BYTES);
    let chatCalls = 0;
    const result = await cliWithClient(
      () => ({
        chat: (_params: ChatParams): Promise<ChatResponse> => {
          chatCalls += 1;
          return Promise.resolve({ content: RECOGNITION_JSON, model: 'mock-vision' });
        },
      }),
      'f5.png', '--building', 'EB', '--floor', '1', '--scale', '0',
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pixelsPerMeter');
    expect(chatCalls).toBe(0);
  });

  it('reports an LLM failure with provider/model guidance instead of a bare 404 (Fix-6)', async () => {
    writeFileSync(join(tempDir, 'f6.png'), PNG_BYTES);
    const result = await cliWithClient(
      () => ({
        chat: (): Promise<ChatResponse> =>
          Promise.reject(new Error('[openai-compatible] API request failed: 404 Not Found')),
      }),
      'f6.png', '--building', 'EB', '--floor', '1', '--scale', '10',
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('floor-plan recognition failed');
    expect(result.stderr).toContain('404 Not Found');
    expect(result.stderr).toContain('Qwen/Qwen2.5-VL-7B-Instruct');
    expect(result.stderr).toContain('EAF_VISION_MODEL');
  });

  it('reports usage and runtime errors cleanly', async () => {
    const noArgs = await cli('import-floorplan');
    expect(noArgs.code).toBe(2);

    const missing = await cli(
      'import-floorplan', 'nope.png', '--building', 'EB', '--floor', '1', '--scale', '10',
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read floor-plan image');

    writeFileSync(join(tempDir, 'f.txt'), 'not an image');
    const badType = await cli(
      'import-floorplan', 'f.txt', '--building', 'EB', '--floor', '1', '--scale', '10',
    );
    expect(badType.code).toBe(2);
    expect(badType.stderr).toContain('unsupported image type');

    writeFileSync(join(tempDir, 'f4.png'), PNG_BYTES);
    const badCalibrate = await cli(
      'import-floorplan', 'f4.png', '--building', 'EB', '--floor', '1', '--calibrate', '1,2,3',
    );
    expect(badCalibrate.code).toBe(2);
    expect(badCalibrate.stderr).toContain('--calibrate');
  });
});
