/**
 * @vitest-environment node
 *
 * T124 (E1): the「id 命令 × 前缀支持」对账测试 — every CLI face that takes an
 * id positional is either WIRED to the T88 prefix-resolution family
 * (`getWithIdPrefix` / the per-kind helpers) or carries a WRITTEN EXEMPTION
 * here. The registry below is the contract: the sweep re-derives the
 * id-taking faces from the command sources and fails when a face is missing
 * from (or contradicting) this table.
 *
 * Why a source sweep: the family grew one face per usability round (T88 →
 * T110 → this batch), always by "the flagged face joins" — nothing prevented
 * the NEXT face from silently 404ing on a copied short id while its sibling
 * resolved (R19-u2 F1/F4 exactly). The sweep makes the remaining gaps a
 * DECISION (register or exempt) instead of an accident.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = join(__dirname, '..', 'commands');

/** The resolution families that count as "wired". */
const FAMILY = /getWithIdPrefix|RefGet|resolveServiceRef|resolveAgreementRef|resolveFlowRef/;
/** Env refs speak their own family: `id|name` refs through ctx.resolveEnv. */
const ENV_FAMILY = /resolveEnv\(/;

type Status = 'wired' | 'exempt';
/**
 * `${file}::${enclosingFunction}` → registry row. A `file::*` key is a
 * FILE-LEVEL row covering every face of that file; exact keys win over it.
 */
const REGISTRY: Record<string, { status: Status; note?: string }> = {
  // ----- agreement family (T88 + T110 + T124: fully wired) -----
  'agreement.ts::propose': { status: 'wired' }, // serviceId + --consumer-agent both resolve (T124)
  'agreement.ts::getAgreement': { status: 'wired' },
  'agreement.ts::counter': { status: 'wired' },
  'agreement.ts::remind': { status: 'wired' },
  'agreement.ts::lifecycleAction': { status: 'wired' }, // suspend + terminate (R19-u1 F2)
  'agreement.ts::hold': { status: 'wired' },
  'agreement.ts::resume': { status: 'wired' },
  'agreement.ts::invoke': { status: 'wired' },
  'agreement.ts::usage': { status: 'wired' },
  'agreement.ts::receipts': { status: 'wired' },
  'agreement.ts::read': { status: 'wired' },
  'agreement.ts::stream': { status: 'wired' }, // probe-resolve BEFORE the socket (T124)
  // ----- service family (T88 + T124) -----
  'service.ts::getService': { status: 'wired' },
  'service.ts::subscribe': { status: 'wired' }, // R19-u2 F1
  'service.ts::unsubscribe': { status: 'wired' },
  'service.ts::getComputation': { status: 'wired' },
  'service.ts::revokeComputation': { status: 'wired' },
  'service.ts::registerComputation': { status: 'wired' },
  'service.ts::accessRequest': { status: 'wired' },
  'service.ts::accessRequests': { status: 'wired' },
  'service.ts::accessClose': { status: 'wired' }, // serviceId slot; requestId stays full (copied from THIS face's roster output)
  'service.ts::accessRemind': { status: 'wired' }, // same requestId note
  'service.ts::accessGrant': { status: 'wired' },
  'service.ts::accessGrants': { status: 'wired' },
  'service.ts::accessRevoke': { status: 'wired' }, // serviceId slot; userId names a grantee, not a service
  // ----- the other read families (T88/T110) -----
  'agent.ts::getAgent': { status: 'wired' },
  'device.ts::getDevice': { status: 'wired' },
  'flow.ts::getFlow': { status: 'wired' },
  'flow.ts::listRuns': { status: 'wired' },
  'flow.ts::updateFlow': { status: 'wired' },
  'flow.ts::removeFlow': { status: 'wired' },
  'flow.ts::setEnabled': { status: 'wired' },
  // ----- this batch's new members (T124) -----
  'notifications.ts::read': { status: 'wired' }, // roster = the caller's own inbox (private by contract)
  'sandbox.ts::stopSandbox': { status: 'wired' },
  // ----- env-ref family (id|name through ctx.resolveEnv) — wired by design -----
  'env.ts::*': {
    status: 'wired',
    note: 'env refs speak the resolveEnv family (id fast-path + exact-name fallback); exact keys below override.',
  },
  'env.ts::proposalDecide': {
    status: 'exempt',
    note: 'deferred: `env proposals` prints full proposal ids; the governance decide lane copies from the same table. Not user-flagged.',
  },
  'env.ts::proposalRemind': {
    status: 'exempt',
    note: 'deferred: same proposal-id copy source as proposalDecide.',
  },
  'env.ts::proposalRevert': {
    status: 'exempt',
    note: 'deferred: same proposal-id copy source as proposalDecide.',
  },
  'env.ts::evalRunStatus': {
    status: 'exempt',
    note: 'deferred: the jobId is the synchronous `eval-run` response payload, not a copied roster id.',
  },
  // ----- written exemptions (deferred, with reasons) -----
  'agent.ts::updateAgent': {
    status: 'exempt',
    note: 'deferred: world-object management lane; ids are copied full from `agent get`/`agent list` (the read face resolves). Register when a user round flags it.',
  },
  'agent.ts::removeAgent': {
    status: 'exempt',
    note: 'deferred: same world-object lane as updateAgent.',
  },
  'device.ts::updateDevice': {
    status: 'exempt',
    note: 'deferred: same world-object lane as updateAgent.',
  },
  'device.ts::removeDevice': {
    status: 'exempt',
    note: 'deferred: same world-object lane as updateAgent.',
  },
  'sim.ts::*': {
    status: 'exempt',
    note: 'deferred: `sim list` prints full ids and sim ids are env-prefixed (self-identifying); no user round flagged them. The whole sim command file is one exemption pending its roster.',
  },
  'blueprint.ts::*': {
    status: 'exempt',
    note: 'deferred: blueprint ids are stable gallery/app rows copied full from `blueprint list/show`; not user-flagged.',
  },
  'catalog.ts::getModel': {
    status: 'exempt',
    note: 'deferred: catalog model ids are stable reference data printed in full by `catalog list`.',
  },
  'asks.ts::withdrawAsk': {
    status: 'exempt',
    note: 'deferred: `asks list` (the asker\'s own board) prints full ids; low-frequency face.',
  },
};

interface IdFace {
  file: string;
  fn: string;
  idArg: string;
}

/** Find id-named positionals + their enclosing top-level function per command file. */
function sweepIdFaces(): IdFace[] {
  const files = [
    'agent.ts', 'agreement.ts', 'asks.ts', 'blueprint.ts', 'catalog.ts', 'device.ts',
    'env.ts', 'flow.ts', 'notifications.ts', 'sandbox.ts', 'service.ts', 'sim.ts',
  ];
  const faces: IdFace[] = [];
  for (const file of files) {
    const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
    const idPositional =
      /requirePositional\([^,]+,\s*'([^']*[Ii]d|id\|name)'/g;
    const twoPositionals = /requireTwoPositionals\([^,]+,\s*'([^']*)',\s*'([^']*)'/g;
    const matches: Array<{ index: number; idArg: string }> = [];
    for (const m of source.matchAll(idPositional)) {
      matches.push({ index: m.index ?? 0, idArg: m[1] ?? '' });
    }
    for (const m of source.matchAll(twoPositionals)) {
      matches.push({ index: m.index ?? 0, idArg: m[1] ?? '' });
    }
    for (const match of matches) {
      const fn = enclosingFunction(source, match.index);
      if (fn === null) continue; // not inside a named function (helpers) — skip
      faces.push({ file, fn, idArg: match.idArg });
    }
  }
  return faces;
}

/** The nearest `function NAME` / `const NAME = async` before `index`. */
function enclosingFunction(source: string, index: number): string | null {
  const before = source.slice(0, index);
  const matches = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const last = matches[matches.length - 1];
  return last !== undefined ? (last[1] ?? null) : null;
}

/** The source slice of one top-level function (to the next function or EOF). */
function functionBody(source: string, fn: string): string {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${fn}\\b`, 'm'));
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function \w+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('T124: id-command × prefix-support reconciliation', () => {
  const faces = sweepIdFaces();

  it('sweeps a meaningful inventory (guard against the sweep itself going blind)', () => {
    expect(faces.length).toBeGreaterThanOrEqual(40);
    const files = new Set(faces.map(f => f.file));
    expect(files.has('agreement.ts')).toBe(true);
    expect(files.has('service.ts')).toBe(true);
  });

  it('every id-taking face is registered (wired or exempt-with-note)', () => {
    const unregistered: string[] = [];
    for (const face of faces) {
      const row = lookup(face.file, face.fn);
      if (row === undefined) {
        unregistered.push(`${face.file}::${face.fn} (id positional "${face.idArg}")`);
        continue;
      }
      if (row.status === 'exempt' && (row.note === undefined || row.note.length === 0)) {
        unregistered.push(`${face.file}::${face.fn} — exemption without a written reason`);
      }
    }
    expect(unregistered).toEqual([]);
  });

  /** Exact key first, then the file-level `file::*` row. */
  function lookup(file: string, fn: string): { status: Status; note?: string } | undefined {
    return REGISTRY[`${file}::${fn}`] ?? REGISTRY[`${file}::*`];
  }

  it('registry keys point at real faces (no stale rows)', () => {
    const presentFiles = new Set(faces.map(f => f.file));
    const present = new Set(faces.map(f => `${f.file}::${f.fn}`));
    const stale = Object.keys(REGISTRY).filter(key => {
      const [file, fn] = key.split('::');
      if (file === undefined || fn === undefined) return true;
      if (fn === '*') return !presentFiles.has(file); // file-level row
      return !present.has(key);
    });
    expect(stale).toEqual([]);
  });

  it('every face marked wired actually resolves through a family', () => {
    const sourceOf = new Map<string, string>();
    const violations: string[] = [];
    for (const face of faces) {
      const row = lookup(face.file, face.fn);
      if (row === undefined || row.status !== 'wired' || row.note !== undefined) continue;
      const source = sourceOf.get(face.file) ?? readFileSync(join(COMMANDS_DIR, face.file), 'utf8');
      sourceOf.set(face.file, source);
      const body = functionBody(source, face.fn);
      if (!FAMILY.test(body) && !ENV_FAMILY.test(body)) {
        violations.push(`${face.file}::${face.fn} is marked wired but calls no resolver (getWithIdPrefix family / resolveEnv)`);
      }
    }
    expect(violations).toEqual([]);
  });
});
