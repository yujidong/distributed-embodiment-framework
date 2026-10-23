/**
 * @vitest-environment node
 *
 * `eaf import-ifc` smoke tests — fully local (no server): writes a minimal
 * IFC fixture to a temp dir, runs the command in-process, and checks the
 * emitted scenario/IR files. Also covers the friendly failure on garbage
 * input.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { run } from '../cli.js';
import type { IO } from '../io.js';

// Same minimal IFC2X3 document as packages/core's ifc-parser tests:
// 1 building, 2 storeys, 2 spaces per floor, 1 door, 1 external window,
// one space (202) without geometry.
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
#101=IFCSPACE('0uYwg$uR55LAAAAAAABB11',$,'102',$,$,$,#120,$,.ELEMENT.,.INTERNAL.,$);
#120=IFCPRODUCTDEFINITIONSHAPE($,$,(#121));
#121=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#122));
#122=IFCBOUNDINGBOX(#123,8.,6.,3.);
#123=IFCCARTESIANPOINT((8.,0.,0.));
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

const tempDir = mkdtempSync(join(tmpdir(), 'eaf-import-ifc-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

interface CliResult { code: number; stdout: string; stderr: string }

async function cli(...args: string[]): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const io: IO = {
    env: { EAF_HOME: tempDir },
    cwd: tempDir,
    homeDir: tempDir,
    isTTY: false,
    stdout: chunk => (stdout += chunk),
    stderr: chunk => (stderr += chunk),
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

describe('eaf import-ifc', () => {
  it('compiles an IFC file to a scenario JSON + optional IR dump', async () => {
    writeFileSync(join(tempDir, 'mini.ifc'), MINIMAL_IFC);

    const result = await cli('import-ifc', 'mini.ifc', '--out', 'scenario.json', '--ir', 'ir.json');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('warning: floor 1'); // space 202 fallback

    const scenario = JSON.parse(readFileSync(join(tempDir, 'scenario.json'), 'utf-8'));
    expect(scenario.version).toBe('1.0');
    expect(scenario.meta.id).toBe('miniproject');
    expect(scenario.meta.storeyHeight).toBe(3.5);
    // 4 rooms + auto-generated outdoor zone.
    expect(scenario.zones).toHaveLength(5);
    const ids = scenario.zones.map((z: any) => z.id);
    expect(ids).toContain('outdoor');
    const r101 = scenario.zones.find((z: any) => z.id === '101-f0');
    expect(r101.floor).toBe(0);
    expect(r101.adjacentZoneIds).toEqual(['102-f0']);

    const ir = JSON.parse(readFileSync(join(tempDir, 'ir.json'), 'utf-8'));
    expect(ir.rooms).toHaveLength(4);
    expect(ir.rooms.find((r: any) => r.id === '202-f1').estimated).toBe(true);
    expect(ir.connections).toHaveLength(2);
  });

  it('prints the scenario to stdout when --out is omitted', async () => {
    const result = await cli('import-ifc', 'mini.ifc');
    expect(result.code).toBe(0);
    const scenario = JSON.parse(result.stdout);
    expect(scenario.version).toBe('1.0');
    expect(scenario.zones).toHaveLength(5);
  });

  it('fails friendly on non-IFC input', async () => {
    writeFileSync(join(tempDir, 'junk.ifc'), 'definitely not ifc');
    const result = await cli('import-ifc', 'junk.ifc');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('IFC import failed');
    expect(result.stderr).toContain('ISO-10303-21');
  });

  it('reports missing files and missing arguments as usage/runtime errors', async () => {
    const missing = await cli('import-ifc', 'nope.ifc');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read IFC file');

    const noArgs = await cli('import-ifc');
    expect(noArgs.code).toBe(2);
  });
});
