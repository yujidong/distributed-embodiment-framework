/**
 * @vitest-environment node
 *
 * Building IR compiler tests (no LLM, no network, no WASM).
 *
 * Covers: rectangle passthrough and polygon bounding boxes, shaft-zone
 * generation from stair connections (including missing intermediate
 * floors), outdoor-zone generation with envelopeU passthrough, same-floor
 * door/open adjacency, and the guarantee that every compiled document
 * passes `loadScenarioFile` (schema + semantics).
 */

import { describe, it, expect } from 'vitest';

import type { BuildingIR } from './building-ir.js';
import { BuildingCompileError, compileBuildingIR } from './building-compiler.js';
import { loadScenarioFile } from './scenario-loader.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseIR(): BuildingIR {
  return {
    meta: { name: 'Test Building', storeyHeight: 3.5 },
    buildings: [{ id: 'main', name: 'Main' }],
    floors: [
      { buildingId: 'main', floor: 0 },
      { buildingId: 'main', floor: 1 },
    ],
    rooms: [],
    connections: [],
    envelope: [],
  };
}

// ---------------------------------------------------------------------------
// Room → zone
// ---------------------------------------------------------------------------

describe('compileBuildingIR: rooms → zones', () => {
  it('passes rectangle bounds through and collapses polygons to their bbox', () => {
    const ir = baseIR();
    ir.rooms.push(
      { id: 'rect-room', buildingId: 'main', floor: 0, name: 'Rect', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } },
      {
        id: 'poly-room',
        buildingId: 'main',
        floor: 0,
        name: 'Poly',
        // L-shaped polygon → axis-aligned bounding box
        polygon: [[2, 1], [10, 1], [10, 4], [6, 4], [6, 9], [2, 9]],
      },
    );

    const scenario = compileBuildingIR(ir);
    const rect = scenario.zones.find(z => z.id === 'rect-room')!;
    const poly = scenario.zones.find(z => z.id === 'poly-room')!;

    expect(rect.bounds).toEqual({ minX: 0, maxX: 8, minY: 0, maxY: 6 });
    expect(poly.bounds).toEqual({ minX: 2, maxX: 10, minY: 1, maxY: 9 });
    expect(rect.buildingId).toBe('main');
    expect(rect.floor).toBe(0);
    expect(scenario.meta.storeyHeight).toBe(3.5);
    expect(scenario.meta.id).toBe('test-building');

    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('rejects rooms without any geometry', () => {
    const ir = baseIR();
    ir.rooms.push({ id: 'ghost', buildingId: 'main', floor: 0 });
    expect(() => compileBuildingIR(ir)).toThrow(BuildingCompileError);
  });

  it('rejects an IR with no rooms as a compile issue, not a raw validation stack (Fix-6)', () => {
    // Regression for usability F-06: spaces that fail to map to storeys left
    // an empty IR, which surfaced as a ScenarioValidationError stack trace.
    const ir = baseIR();
    expect(() => compileBuildingIR(ir)).toThrow(BuildingCompileError);
    expect(() => compileBuildingIR(ir)).toThrow(/no rooms/);
  });
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('compileBuildingIR: connections', () => {
  it('door/open connections become symmetric same-floor adjacency', () => {
    const ir = baseIR();
    ir.rooms.push(
      { id: 'r1', buildingId: 'main', floor: 0, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } },
      { id: 'r2', buildingId: 'main', floor: 0, bounds: { minX: 5, maxX: 10, minY: 0, maxY: 5 } },
      { id: 'r3', buildingId: 'main', floor: 0, bounds: { minX: 0, maxX: 10, minY: 5, maxY: 9 } },
    );
    ir.connections.push(
      { a: 'r1', b: 'r2', kind: 'door' },
      { a: 'r2', b: 'r3', kind: 'open' },
    );

    const scenario = compileBuildingIR(ir);
    const byId = new Map(scenario.zones.map(z => [z.id, z]));
    expect(byId.get('r1')!.adjacentZoneIds).toEqual(['r2']);
    expect(byId.get('r2')!.adjacentZoneIds).toEqual(['r1', 'r3']);
    expect(byId.get('r3')!.adjacentZoneIds).toEqual(['r2']);

    const loaded = loadScenarioFile(scenario);
    expect(loaded.zones.find(z => z.id === 'r1')!.adjacentZoneIds).toEqual(['r2']);
  });

  it('stair connections generate shaft zones for missing floors and chain adjacency', () => {
    const ir = baseIR();
    ir.floors.push({ buildingId: 'main', floor: 2 });
    ir.rooms.push(
      { id: 'stair-f0', buildingId: 'main', floor: 0, type: 'stairwell', bounds: { minX: 16, maxX: 24, minY: 0, maxY: 6 } },
      { id: 'stair-f2', buildingId: 'main', floor: 2, type: 'stairwell', bounds: { minX: 16, maxX: 24, minY: 0, maxY: 6 } },
    );
    // The stair shaft spans floors 0..2 but no room exists on floor 1.
    ir.connections.push({ a: 'stair-f0', b: 'stair-f2', kind: 'stair' });

    const scenario = compileBuildingIR(ir);
    const byId = new Map(scenario.zones.map(z => [z.id, z]));

    // Auto-generated shaft zone on the missing floor, bounds copied.
    const generated = byId.get('stair-f1');
    expect(generated).toBeDefined();
    expect(generated!.type).toBe('stairwell');
    expect(generated!.floor).toBe(1);
    expect(generated!.bounds).toEqual({ minX: 16, maxX: 24, minY: 0, maxY: 6 });

    // Chained one floor at a time: f0 ↔ f1 ↔ f2, never f0 ↔ f2 directly.
    expect(byId.get('stair-f0')!.adjacentZoneIds).toEqual(['stair-f1']);
    expect(generated!.adjacentZoneIds).toEqual(['stair-f0', 'stair-f2']);
    expect(byId.get('stair-f2')!.adjacentZoneIds).toEqual(['stair-f1']);

    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('window-to-outdoor creates one shared outdoor zone with envelopeU passthrough', () => {
    const ir = baseIR();
    ir.rooms.push(
      { id: 'r1', buildingId: 'main', floor: 0, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } },
      { id: 'r2', buildingId: 'main', floor: 0, bounds: { minX: 8, maxX: 16, minY: 0, maxY: 6 } },
      { id: 'r3', buildingId: 'main', floor: 1, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } },
    );
    ir.connections.push(
      { a: 'r1', kind: 'window-to-outdoor' },
      { a: 'r3', kind: 'window-to-outdoor' },
    );
    ir.envelope.push({ roomId: 'r1', uValue: 0.4 }, { roomId: 'r3', uValue: 0.25 });

    const scenario = compileBuildingIR(ir);
    const byId = new Map(scenario.zones.map(z => [z.id, z]));

    const outdoor = byId.get('outdoor');
    expect(outdoor).toBeDefined();
    expect(outdoor!.type).toBe('outdoor');
    expect(outdoor!.floor).toBeUndefined();
    // Outdoor bounds sit to the right of the whole plan.
    expect(outdoor!.bounds!.minX).toBeGreaterThan(16);

    expect(byId.get('r1')!.adjacentZoneIds).toEqual(['outdoor']);
    expect(byId.get('r3')!.adjacentZoneIds).toEqual(['outdoor']);
    expect(byId.get('r2')!.adjacentZoneIds).toBeUndefined();
    // Exactly one outdoor zone even with two boundary rooms.
    expect(scenario.zones.filter(z => z.type === 'outdoor')).toHaveLength(1);

    expect(byId.get('r1')!.envelopeU).toBe(0.4);
    expect(byId.get('r3')!.envelopeU).toBe(0.25);
    expect(byId.get('r2')!.envelopeU).toBeUndefined();

    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('rejects connections and envelope entries referencing unknown rooms', () => {
    const ir = baseIR();
    ir.rooms.push({ id: 'r1', buildingId: 'main', floor: 0, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } });
    ir.connections.push({ a: 'r1', b: 'nope', kind: 'door' });
    ir.envelope.push({ roomId: 'ghost', uValue: 0.3 });

    try {
      compileBuildingIR(ir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BuildingCompileError);
      const issues = (error as BuildingCompileError).issues;
      expect(issues.some(i => i.includes('"nope"'))).toBe(true);
      expect(issues.some(i => i.includes('"ghost"'))).toBe(true);
    }
  });
});
