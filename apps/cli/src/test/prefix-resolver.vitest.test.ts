/**
 * T88 (R12, u2-F1) unit tests — the shared short-prefix id resolver behind
 * the get faces (agreement get/usage/receipts, service get, device get,
 * agent get). e2e coverage of the happy path lives in
 * prefix-get.vitest.test.ts; THIS file pins the decision table
 * deterministically (unique / ambiguous / zero / roster-failure / non-404).
 */

import { describe, expect, test } from 'vitest';

import { getWithIdPrefix, type Ctx, type IdRosterEntry } from '../ctx.js';
import { CliError, EXIT } from '../errors.js';

/** Minimal ctx stub — the resolver only touches `json` and `out.explain`. */
function stubCtx(json: boolean): { ctx: Ctx; notes: string[] } {
  const notes: string[] = [];
  const ctx = {
    json,
    out: { explain: (message: string): void => { notes.push(message); } },
  } as unknown as Ctx;
  return { ctx, notes };
}

/**
 * A get face stub that answers 404 for anything that is not a KNOWN FULL id
 * — mirroring the API: a prefix is not an addressable id.
 */
function recorder(validIds: string[] = []): { get: (id: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (id: string) => {
      calls.push(id);
      if (!validIds.includes(id)) {
        throw new CliError(`${id} not found [NOT_FOUND]`, EXIT.NOT_FOUND);
      }
      return `payload-of-${id}`;
    },
  };
}

const ROSTER: IdRosterEntry[] = [
  { id: 'abc12345-full-id-one', name: 'First Offer' },
  { id: 'abc99999-full-id-two', name: 'Second Offer' },
  { id: 'fed00000-unrelated', name: 'Other' },
];

describe('T88: getWithIdPrefix decision table', () => {
  test('a full id takes the zero-extra-roundtrip path (no note, single call)', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get, calls } = recorder(['abc12345-full-id-one']);
    const result = await getWithIdPrefix(ctx, {
      kind: 'service',
      ref: 'abc12345-full-id-one',
      get,
      roster: async () => ROSTER,
      listHint: 'list hint',
    });
    expect(result).toBe('payload-of-abc12345-full-id-one');
    expect(calls).toEqual(['abc12345-full-id-one']);
    expect(notes).toEqual([]);
  });

  test('a unique prefix resolves and declares the mapping (human note names id + name)', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get, calls } = recorder(['fed00000-unrelated']);
    const result = await getWithIdPrefix(ctx, {
      kind: 'service',
      ref: 'fed',
      get,
      roster: async () => ROSTER,
      listHint: 'list hint',
    });
    expect(result).toBe('payload-of-fed00000-unrelated');
    expect(calls).toEqual(['fed', 'fed00000-unrelated']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('fed00000-unrelated');
    expect(notes[0]).toContain('(Other)');
    expect(notes[0]).toContain('unique prefix match');
  });

  test('several extensions are a teaching USAGE error listing candidates (full id + name), never a guess', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get, calls } = recorder();
    const error = await getWithIdPrefix(ctx, {
      kind: 'agreement',
      ref: 'abc',
      get,
      roster: async () => ROSTER,
      listHint: 'list hint',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.exitCode).toBe(EXIT.USAGE);
    expect(cliError.message).toContain('matches 2 agreements you can see');
    expect(cliError.issues).toEqual([
      'abc12345-full-id-one  (First Offer)',
      'abc99999-full-id-two  (Second Offer)',
    ]);
    expect(calls).toEqual(['abc']); // the single direct attempt — no retry
    expect(notes).toEqual([]);
  });

  test('zero extensions teach the honest not-found (roster size + where to copy ids from), exit 4', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get } = recorder();
    const error = await getWithIdPrefix(ctx, {
      kind: 'device',
      ref: 'zzz',
      get,
      roster: async () => ROSTER,
      listHint: 'eaf device list --env <id|name>',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.exitCode).toBe(EXIT.NOT_FOUND);
    expect(cliError.message).toContain('device "zzz" not found');
    expect(cliError.message).toContain('none of the 3 device(s) you can see');
    expect(cliError.message).toContain('eaf device list --env <id|name>');
    expect(notes).toEqual([]);
  });

  test('a failed roster scan rethrows the ORIGINAL 404 (resolution is best-effort)', async () => {
    const { ctx } = stubCtx(false);
    const original = new CliError('service "fed" not found [SERVICE_NOT_FOUND]', EXIT.NOT_FOUND);
    const error = await getWithIdPrefix(ctx, {
      kind: 'service',
      ref: 'fed',
      get: async () => {
        throw original;
      },
      roster: async () => {
        throw new Error('roster scan exploded');
      },
      listHint: 'list hint',
    }).catch((caught: unknown) => caught);
    expect(error).toBe(original);
  });

  test('non-404 errors pass through untouched (no resolution attempt)', async () => {
    const { ctx } = stubCtx(false);
    const forbidden = new CliError('not your env [FORBIDDEN]', EXIT.AUTH);
    let rosterCalls = 0;
    const error = await getWithIdPrefix(ctx, {
      kind: 'device',
      ref: 'abc',
      get: async () => {
        throw forbidden;
      },
      roster: async () => {
        rosterCalls += 1;
        return ROSTER;
      },
      listHint: 'list hint',
    }).catch((caught: unknown) => caught);
    expect(error).toBe(forbidden);
    expect(rosterCalls).toBe(0);
  });

  test('--json mode still declares the resolution (explain rides stderr there)', async () => {
    const { ctx, notes } = stubCtx(true);
    const { get } = recorder(['fed00000-unrelated']);
    const result = await getWithIdPrefix(ctx, {
      kind: 'service',
      ref: 'fed',
      get,
      roster: async () => ROSTER,
      listHint: 'list hint',
    });
    expect(result).toBe('payload-of-fed00000-unrelated');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('unique prefix match');
  });
});

// ---------------------------------------------------------------------------
// T102 (R16, u1/u2/u4): the display-NAME lane — an exact roster name resolves
// like a unique prefix did; several carriers are the honest ambiguity face;
// the zero-match teaching names BOTH hypotheses (id prefix OR display name).
// ---------------------------------------------------------------------------

describe('T102: getWithIdPrefix display-name lane', () => {
  test('an exact display name resolves with the explain note (single roster carrier)', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get, calls } = recorder(['fed00000-unrelated']);
    const result = await getWithIdPrefix(ctx, {
      kind: 'agent',
      ref: 'Other',
      get,
      roster: async () => ROSTER,
      listHint: 'list hint',
    });
    expect(result).toBe('payload-of-fed00000-unrelated');
    expect(calls).toEqual(['Other', 'fed00000-unrelated']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Other');
    expect(notes[0]).toContain('fed00000-unrelated');
    expect(notes[0]).toContain('unique display-name match');
  });

  test('a name carried by SEVERAL roster entries is a USAGE error listing the full ids', async () => {
    const { ctx } = stubCtx(false);
    const { get, calls } = recorder();
    const roster: IdRosterEntry[] = [
      { id: 'agent-1', name: 'twin' },
      { id: 'agent-2', name: 'twin' },
    ];
    const error = await getWithIdPrefix(ctx, {
      kind: 'agent',
      ref: 'twin',
      get,
      roster: async () => roster,
      listHint: 'list hint',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.exitCode).toBe(EXIT.USAGE);
    expect(cliError.message).toContain('display name of 2 agents');
    expect(cliError.issues).toEqual(['agent-1', 'agent-2']);
    expect(calls).toEqual(['twin']);
  });

  test('zero prefix AND zero name hits: the teaching names both hypotheses', async () => {
    const { ctx } = stubCtx(false);
    const { get } = recorder();
    const error = await getWithIdPrefix(ctx, {
      kind: 'agent',
      ref: '赵青能耗助手',
      get,
      roster: async () => ROSTER,
      listHint: 'eaf agent list --env <id|name>',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.exitCode).toBe(EXIT.NOT_FOUND);
    expect(cliError.message).toContain('id with this prefix or this exact display name');
    expect(cliError.message).toContain('none of the 3 agent(s) you can see');
  });

  test('an exact id-prefix match still outranks the name lane (existing behavior preserved)', async () => {
    const { ctx, notes } = stubCtx(false);
    const { get, calls } = recorder(['abc12345-full-id-one']);
    const roster: IdRosterEntry[] = [
      { id: 'abc12345-full-id-one', name: 'First Offer' },
      { id: 'zzz-unrelated', name: 'abc' },
    ];
    const result = await getWithIdPrefix(ctx, {
      kind: 'agent',
      ref: 'abc',
      get,
      roster: async () => roster,
      listHint: 'list hint',
    });
    expect(result).toBe('payload-of-abc12345-full-id-one');
    expect(calls).toEqual(['abc', 'abc12345-full-id-one']);
    expect(notes[0]).toContain('unique prefix match');
  });
});
