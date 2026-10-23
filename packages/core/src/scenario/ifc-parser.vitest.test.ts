/**
 * @vitest-environment node
 *
 * IFC parser tests (web-ifc, no network — WASM runs locally).
 *
 * The fixture is an inline minimal IFC2X3 STEP document: one building, two
 * storeys (0 m / 3.5 m), two spaces per floor, one door between the two
 * ground-floor spaces, one external window on an upper space. Space 102
 * carries an IfcLocalPlacement offset; space 202 has no representation at
 * all and must degrade to the estimated grid fallback.
 */

import { describe, it, expect } from 'vitest';

import { IfcParseError, parseIfcToIR } from './ifc-parser.js';
import { compileBuildingIR } from './building-compiler.js';
import { loadScenarioFile } from './scenario-loader.js';

// ---------------------------------------------------------------------------
// Minimal IFC fixture (valid IFC2X3 STEP text)
// ---------------------------------------------------------------------------

const MINIMAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mini.ifc','2026-07-30T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0uYwg$uR55LAAAAAAABBB1',$,'MiniProject',$,$,$,$,(#10),#11);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$);
#12=IFCAXIS2PLACEMENT3D(#13,$,$,$);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCUNITASSIGNMENT((#14));
#14=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCBUILDING('0uYwg$uR55LAAAAAAABBB2',$,'MainBuilding',$,$,$,$,$,.ELEMENT.,$,$,$);
#30=IFCBUILDINGSTOREY('0uYwg$uR55LAAAAAAABBB3',$,'1F',$,$,$,$,$,.ELEMENT.,0.);
#31=IFCBUILDINGSTOREY('0uYwg$uR55LAAAAAAABBB4',$,'2F',$,$,$,$,$,.ELEMENT.,3.5);
#40=IFCRELAGGREGATES('0uYwg$uR55LAAAAAAABBB5',$,$,$,#1,(#20));
#41=IFCRELAGGREGATES('0uYwg$uR55LAAAAAAABBB6',$,$,$,#20,(#30,#31));
#100=IFCSPACE('0uYwg$uR55LAAAAAAABB10',$,'101',$,$,$,#110,$,.ELEMENT.,.INTERNAL.,$);
#110=IFCPRODUCTDEFINITIONSHAPE($,$,(#111));
#111=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#112));
#112=IFCBOUNDINGBOX(#113,8.,6.,3.);
#113=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCSPACE('0uYwg$uR55LAAAAAAABB11',$,'102',$,$,#150,#120,$,.ELEMENT.,.INTERNAL.,$);
#150=IFCLOCALPLACEMENT($,#151);
#151=IFCAXIS2PLACEMENT3D(#152,$,$,$);
#152=IFCCARTESIANPOINT((8.,0.,0.));
#120=IFCPRODUCTDEFINITIONSHAPE($,$,(#121));
#121=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#122));
#122=IFCBOUNDINGBOX(#123,8.,6.,3.);
#123=IFCCARTESIANPOINT((0.,0.,0.));
#102=IFCSPACE('0uYwg$uR55LAAAAAAABB12',$,'201',$,$,$,#130,$,.ELEMENT.,.INTERNAL.,$);
#130=IFCPRODUCTDEFINITIONSHAPE($,$,(#131));
#131=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#132));
#132=IFCBOUNDINGBOX(#133,8.,6.,3.);
#133=IFCCARTESIANPOINT((0.,0.,3.5));
#103=IFCSPACE('0uYwg$uR55LAAAAAAABB13',$,'202',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#50=IFCRELCONTAINEDINSPATIALSTRUCTURE('0uYwg$uR55LAAAAAAABB14',$,$,$,(#100,#101),#30);
#51=IFCRELCONTAINEDINSPATIALSTRUCTURE('0uYwg$uR55LAAAAAAABB15',$,$,$,(#102,#103),#31);
#200=IFCDOOR('0uYwg$uR55LAAAAAAABB16',$,'D1',$,$,$,$,$,$,$);
#60=IFCRELSPACEBOUNDARY('0uYwg$uR55LAAAAAAABB17',$,$,$,#100,#200,$,.PHYSICAL.,.INTERNAL.);
#61=IFCRELSPACEBOUNDARY('0uYwg$uR55LAAAAAAABB18',$,$,$,#101,#200,$,.PHYSICAL.,.INTERNAL.);
#201=IFCWINDOW('0uYwg$uR55LAAAAAAABB19',$,'W1',$,$,$,$,$,$,$);
#62=IFCRELSPACEBOUNDARY('0uYwg$uR55LAAAAAAABB20',$,$,$,#102,#201,$,.PHYSICAL.,.EXTERNAL.);
ENDSEC;
END-ISO-10303-21;
`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseIfcToIR', () => {
  it('extracts the building/storey/space tree into IR', async () => {
    const { ir, warnings } = await parseIfcToIR(MINIMAL_IFC);

    expect(ir.meta.name).toBe('MiniProject');
    expect(ir.meta.storeyHeight).toBe(3.5);
    expect(ir.buildings).toEqual([{ id: 'mainbuilding', name: 'MainBuilding' }]);
    expect(ir.floors).toHaveLength(2);
    expect(ir.floors[0]).toMatchObject({ buildingId: 'mainbuilding', floor: 0, elevation: 0 });
    expect(ir.floors[1]).toMatchObject({ buildingId: 'mainbuilding', floor: 1, elevation: 3.5 });

    expect(ir.rooms).toHaveLength(4);
    const byId = new Map(ir.rooms.map(room => [room.id, room]));

    const r101 = byId.get('101-f0')!;
    expect(r101).toMatchObject({ floor: 0, name: '101', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } });
    expect(r101.estimated).toBeUndefined();

    // Space 102's IfcLocalPlacement offset is applied to its bounding box.
    const r102 = byId.get('102-f0')!;
    expect(r102.bounds).toEqual({ minX: 8, maxX: 16, minY: 0, maxY: 6 });

    // The upper-floor bbox's z coordinate does not leak into the 2D footprint.
    const r201 = byId.get('201-f1')!;
    expect(r201).toMatchObject({ floor: 1, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } });

    // One fallback warning for the geometry-less space 202.
    expect(warnings.some(w => w.includes('floor 1') && w.includes('estimated'))).toBe(true);
  });

  it('degrades spaces without geometry to estimated grid cells', async () => {
    const { ir } = await parseIfcToIR(MINIMAL_IFC);
    const r202 = ir.rooms.find(room => room.id === '202-f1')!;
    expect(r202.estimated).toBe(true);
    expect(r202.bounds).toEqual({ minX: 0, maxX: 8, minY: 0, maxY: 6 });
  });

  it('derives door and window-to-outdoor connections from space boundaries', async () => {
    const { ir } = await parseIfcToIR(MINIMAL_IFC);
    expect(ir.connections).toContainEqual({ a: '101-f0', b: '102-f0', kind: 'door' });
    expect(ir.connections).toContainEqual({ a: '201-f1', kind: 'window-to-outdoor' });
    expect(ir.connections).toHaveLength(2);
  });

  it('compiled IR passes full scenario validation', async () => {
    const { ir } = await parseIfcToIR(MINIMAL_IFC);
    const scenario = compileBuildingIR(ir);

    // 4 rooms + 1 auto-generated outdoor zone.
    expect(scenario.zones).toHaveLength(5);
    const outdoor = scenario.zones.find(zone => zone.type === 'outdoor')!;
    expect(outdoor.id).toBe('outdoor');
    const r201 = scenario.zones.find(zone => zone.id === '201-f1')!;
    expect(r201.adjacentZoneIds).toEqual(['outdoor']);

    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('rejects non-STEP input with a friendly error', async () => {
    await expect(parseIfcToIR('this is not an IFC file at all')).rejects.toThrow(IfcParseError);
    await expect(parseIfcToIR('this is not an IFC file at all')).rejects.toThrow(/ISO-10303-21/);
  });

  it('rejects corrupt STEP bodies with a friendly error', async () => {
    const corrupt = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#1=IFCBROKEN(((\nENDSEC;\nEND-ISO-10303-21;\n`;
    await expect(parseIfcToIR(corrupt)).rejects.toThrow(IfcParseError);
  });
});
