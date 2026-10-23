/**
 * Architecture guards (R21-W5) — core side, institutionalized as tests so
 * `npm test` / CI enforces them.
 *
 * Guards in this file:
 *   (a) FILE-SIZE BUDGET — tracked non-test core sources stay under
 *       FILE_BUDGET_LINES; grandfathered files carry explicit ceilings
 *       (ratchet: growth fails, ceilings may only go down).
 *   (b) IMPORT DIRECTION — the runtime layering of
 *       docs/architecture-runtime.md as executable rules:
 *         R2: shaping/* (L2) imports only L1 (../contract), same-layer
 *             (./...), and L0 domain modules; NEVER L3 (../EngineRuntime,
 *             ../fault-seam) and never logger/fs/net (purity).
 *         Package direction: core never VALUE-imports
 *         @active-collaboration/simulation (only the documented lazy
 *         require() in contract.ts is allowed).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const CORE_SRC = join(process.cwd(), 'src');

interface SourceFile {
  abs: string;
  /** repo-relative display path, forward slashes. */
  rel: string;
  text: string;
}

function walkSources(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      const text = readFileSync(full, 'utf8');
      out.push({
        abs: full,
        rel: relative(join(process.cwd(), '..', '..'), full).split(sep).join('/'),
        text,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) File-size budget
// ---------------------------------------------------------------------------

const FILE_BUDGET_LINES = 2200;

/**
 * Grandfathered files (ratchet; ceilings recorded at R21-W5). A file fails
 * when it grows beyond its ceiling; shrink it and lower the ceiling in the
 * same commit. The failure message names this table — entries cannot
 * appear silently.
 */
const GRANDFATHERED: Record<string, number> = {
  // Legacy (a)-class debt from before the budget (audit §2.1) — zero
  // growth since the architecture round.
  'packages/core/src/execution/ACExecutor.ts': 3186,
  // Post-W2 size (2653 → 2466 by wc -l). The audit's W2 scope is applied;
  // further shrinkage lowers this ceiling.
  // R32 (T-103, F-PH21): +63 — the power-outage envelope's ENGINE wiring
  // (constructor seam predicate, injectEvent hook, tick application). Every
  // pure part lives in runtime/power-outage.ts (state machine, transition
  // application, device collection); what remains here is orchestration
  // (devices + sim time + bus) that has no shaping home. Ceiling tracks the
  // post-extraction size — keep shrinking toward the W2 number.
  // R40-B2: +10 — getMetaCognitionSummaries(), a one-line read-only
  // projection delegating to CognitiveAgent.getMetaCognitionSummary (the
  // derivation lives in cognition/meta.ts; nothing else grew).
  // R42-C: +33 — hypothetical device lane (what-if forks) + cognition
  // checkpoint parameter face. Pure helpers live in shaping/.
  // T54 (R6): +14 — getDeviceWrittenPaths(), a read-only accessor handing
  // the data-read lane the per-device written-state oracle (the pure
  // tracking lives in packages/simulation BaseDevice; what remains here is
  // the runtime-scoped lookup).
  'packages/core/src/runtime/EngineRuntime.ts': 2589,
  // R43-B lever-b: +37 — precheck pass-through config (mode/rate/sampler)
  // + F3 service terms. Pure gate extracted to assessor-passthrough.ts.
  // R45-P1: +18 — decisionRole 'coordinator' (AgentContext field, precheck
  // Type-A guard, prompt role line). Pure role instruction extracted to
  // assessor-prompts.ts (COORDINATOR_ROLE_INSTRUCTION).
  // R45-P5 (8087 落账): +21 — initiator-side deterministic request face
  // (model-omitted initiate_ac carries the event's gap needs; the model's
  // own partnerCapabilities win when named). The pure logic lives in
  // assessor-passthrough.ts (initiatorRequestFace/modelOrInferredCapabilities)
  // + partner-summaries.ts (computeGapNeeds); what remains here is the
  // assess()/parseLLMResponse wiring.
  'packages/core/src/decision/ACNecessityAssessor.ts': 2276,
  // R43-A: +23 — escalation-collaboration interlock fix + F3 service
  // context wiring. Pure shaping in event-cluster-summary.ts.
  // R45-P1: +12 — decisionRole 'coordinator' config field (DualTriggerConfig)
  // + AgentContext projection. No logic; the gate lives in the assessor.
  'packages/core/src/decision/DualTriggerACManager.ts': 2235,
};

describe('arch guard (a): core file-size budget', () => {
  const sources = walkSources(CORE_SRC);

  it('walks a non-trivial source tree', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources.map(f => [f.rel, f] as const))(
    '%s stays within its size ceiling',
    (rel, f) => {
      const ceiling = GRANDFATHERED[rel] ?? FILE_BUDGET_LINES;
      const lines = f.text.split('\n').length;
      expect(
        lines,
        `${rel} is ${lines} lines (ceiling ${ceiling}). ` +
          'Extract a pure segment (shaping for runtime, utils for domains) or, ' +
          'for recorded legacy debt only, adjust GRANDFATHERED in ' +
          'packages/core/src/arch-guards.vitest.test.ts — ceilings may only go DOWN.',
      ).toBeLessThanOrEqual(ceiling);
    },
  );

  it('has no stale grandfather entries', () => {
    const paths = new Set(sources.map(f => f.rel));
    for (const rel of Object.keys(GRANDFATHERED)) {
      expect(paths, `${rel} is grandfathered but no longer exists`).toContain(rel);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Import direction (runtime layering)
// ---------------------------------------------------------------------------

describe('arch guard (b): import direction (core)', () => {
  const shaping = walkSources(join(CORE_SRC, 'runtime', 'shaping'));

  it('found the shaping layer', () => {
    expect(shaping.length).toBeGreaterThan(5);
  });

  it.each(shaping.map(f => [f.rel, f] as const))(
    '%s (L2 shaping) stays pure: no L3 runtime, no IO, no logger',
    (rel, f) => {
      expect(
        f.text,
        `${rel} references the L3 orchestration layer — shaping (L2) must not ` +
          'import EngineRuntime/fault-seam (docs/architecture-runtime.md R2).',
      ).not.toMatch(/from\s+'\.\.\/(EngineRuntime|fault-seam)\.js'/);
      expect(
        f.text,
        `${rel} performs IO or logging — L2 shaping is deterministic and pure ` +
          '(no createLogger, no node:fs/net/http/child_process).',
      ).not.toMatch(/createLogger|from\s+'node:(fs|net|http|child_process)'/);
    },
  );

  it('core never imports @active-collaboration/simulation (value OR type)', () => {
    // Strictest form of the package-direction rule: today core has ZERO
    // non-test imports from simulation (only the documented lazy require()
    // in runtime/contract.ts:168, which is not an import statement). A
    // future need relaxes this deliberately, not silently.
    for (const f of walkSources(CORE_SRC)) {
      expect(
        f.text,
        `${f.rel} imports @active-collaboration/simulation — the package ` +
          'direction is simulation → core. Only the documented lazy require() ' +
          'in runtime/contract.ts is allowed.',
      ).not.toMatch(/from\s+'@active-collaboration\/simulation'/);
    }
  });
});
