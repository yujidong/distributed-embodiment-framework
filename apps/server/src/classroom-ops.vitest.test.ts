/**
 * @vitest-environment node
 *
 * Fix-37: classroom operations — batch roster import + grading export.
 *
 * The classroom scenario: a teacher imports 30 student emails in one call,
 * then exports a per-student app inventory for grading at the end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('Fix-37: classroom operations', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Classroom Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  describe('POST /members:batch (roster import)', () => {
    it('imports a multi-user roster in one call', async () => {
      const students = await Promise.all([
        registerUser(ctx.app, { email: 's1@test.local', displayName: 'Student 1' }),
        registerUser(ctx.app, { email: 's2@test.local', displayName: 'Student 2' }),
        registerUser(ctx.app, { email: 's3@test.local', displayName: 'Student 3' }),
      ]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['s1@test.local', 's2@test.local', 's3@test.local'], role: 'builder' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary).toEqual({ total: 3, added: 3, skipped: 0, failed: 0, invited: 0 });
      expect(body.results.every((r: { status: string }) => r.status === 'added')).toBe(true);
    });

    it('reports unregistered emails without failing the batch', async () => {
      await registerUser(ctx.app, { email: 'known@test.local', displayName: 'Known' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['known@test.local', 'ghost@test.local'] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary.added).toBe(1);
      // R15-D10: the ghost email becomes a pending invite, not a failure.
      expect(body.summary.failed).toBe(0);
      expect(body.summary.invited).toBe(1);
      const ghost = body.results.find((r: { email: string }) => r.email === 'ghost@test.local');
      expect(ghost.status).toBe('invited');
    });

    it('skips already-members idempotently', async () => {
      await registerUser(ctx.app, { email: 'dup@test.local', displayName: 'Dup' });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['dup@test.local'] },
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['dup@test.local'] },
      });
      expect(res.json().summary.skipped).toBe(1);
      expect(res.json().summary.added).toBe(0);
    });

    it('rejects non-array emails', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: 'not-an-array' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-owner callers', async () => {
      const student = await registerUser(ctx.app, { displayName: 'Student' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${student.token}` },
        payload: { emails: ['x@test.local'] },
      });
      expect(res.statusCode).toBe(403);
    });

    // R13 (IB-F05/CB-F05): locks the batch-add = FULL membership contract.
    // The round-13 bootstrap's members:batch actually 404'd on a literal
    // "undefined" env id (server.log), so both builders hit the "not a
    // member" 403 until they self-joined — the platform was right, but the
    // semantics deserve a regression test so scripted rounds can trust that
    // a batch-added member NEVER needs POST /join first.
    it('batch-added members can WRITE immediately — no /join required', async () => {
      const builder = await registerUser(ctx.app, { email: 'batchbuilder@test.local', displayName: 'Batch Builder' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members:batch`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['batchbuilder@test.local'], role: 'builder' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.added).toBe(1);

      // First governed call right after the batch — must NOT 403.
      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}`,
        headers: { authorization: `Bearer ${builder.token}` },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().myRole).toBe('builder');

      const device = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: { authorization: `Bearer ${builder.token}` },
        payload: { name: 'Batch Meter', type: 'smart-meter', capabilities: ['energy-monitoring'], zoneId: 'zone-a' },
      });
      expect(device.statusCode).toBe(201);

      // Join afterwards is idempotent (already a member).
      const join = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: { authorization: `Bearer ${builder.token}` },
      });
      expect(join.statusCode).toBe(200);
      expect(join.json()).toMatchObject({ role: 'builder', alreadyMember: true });
    });

    // R13 (IB-F05/CB-F05): the literal-void id gets the teaching hint, so a
    // failed create + interpolated `undefined` is attributable from the body.
    it('a literal "undefined" env id teaches the client-side cause', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments/undefined/members:batch',
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { emails: ['x@test.local'] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('ENVIRONMENT_NOT_FOUND');
      expect(res.json().error.message).toContain('literal string "undefined"');
      expect(res.json().error.message).toContain('creating call failed');
    });
  });

  describe('GET /roster-report (grading export)', () => {
    it('returns per-student app inventory with counts', async () => {
      const student = await registerUser(ctx.app, { email: 'grader@test.local', displayName: 'Grader Student' });
      // Student joins and creates a device.
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: { authorization: `Bearer ${student.token}` },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: { authorization: `Bearer ${student.token}` },
        payload: { name: 'Student Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/roster-report`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalMembers).toBeGreaterThanOrEqual(2);
      const entry = body.entries.find((e: { userId: string }) => e.userId === student.id);
      expect(entry).toBeDefined();
      expect(entry.counts.devices).toBeGreaterThanOrEqual(1);
      expect(entry.inventory.devices.some((d: { name: string }) => d.name === 'Student Lamp')).toBe(true);
    });

    it('supports CSV export', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/roster-report?format=csv`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.body).toContain('userId,displayName,email,role');
      expect(res.body).toContain(owner.id);
    });

    it('rejects non-owner (it reveals all inventories)', async () => {
      const student = await registerUser(ctx.app, { displayName: 'Peeker' });
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/roster-report`,
        headers: { authorization: `Bearer ${student.token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('roster CSV hygiene (T-112)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    // Builder device creates become (auto-approved) proposals — same setup
    // as the grading-export suite above.
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'CSV Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    envId = created.json().id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  async function csv(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/roster-report?format=csv`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  /** Minimal RFC 4180 parser: quotes, doubled quotes, CRLF/LF rows. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
  }

  it('a comma email parses back to exactly 8 fields (counts no longer shift)', async () => {
    const student = await registerUser(ctx.app, {
      email: 'dupe,name@school.test',
      displayName: 'Comma Email',
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: { authorization: `Bearer ${student.token}` },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: { authorization: `Bearer ${student.token}` },
      payload: { name: 'Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });

    const body = await csv();
    const rows = parseCsv(body);
    expect(rows[0]).toHaveLength(8);
    const studentRow = rows.find(r => r.includes('dupe,name@school.test'))!;
    expect(studentRow).toHaveLength(8);
    expect(studentRow[2]).toBe('dupe,name@school.test');
    expect(studentRow[3]).toBe('builder');
    expect(studentRow[4]).toBe('1'); // devices — not shifted by the comma
  });

  it('neutralizes formula-prefixed display names (CSV injection)', async () => {
    const formula = await registerUser(ctx.app, { displayName: '=SUM(A1:A9)' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: { authorization: `Bearer ${formula.token}` },
    });
    const body = await csv();
    expect(body).toContain("'=SUM(A1:A9)");
    for (const row of parseCsv(body)) {
      for (const cell of row) {
        expect(cell.startsWith('='), `un-neutralized formula cell: ${cell}`).toBe(false);
      }
    }
  });

  it('plain rows are unchanged; header row and CRLF line endings asserted', async () => {
    const body = await csv();
    const lines = body.split('\r\n');
    expect(lines[0]).toBe('userId,displayName,email,role,devices,agents,flows,services');
    expect(body).not.toContain('\n"'); // no bare-LF separators
    const ownerRow = parseCsv(body).find(r => r[0] === owner.id)!;
    expect(ownerRow).toHaveLength(8);
    expect(ownerRow[1]).toBe('Teacher');
    expect(ownerRow[2]).toMatch(/@/);
    expect(ownerRow[3]).toBe('owner');
  });
});
