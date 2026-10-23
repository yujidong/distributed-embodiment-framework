/**
 * Agreements service layer — consumption sim targeting (R21-W1 extraction
 * from routes/agreements.ts, pure move).
 */

import type { AgreementRoutesContext } from './context.js';
import type { AgreementRow } from '../db/agreement-store.js';
import { worldSessionSimIdOf } from '../sandbox-service.js';
import { ApiError } from '../errors.js';
import type { SimulationRecord } from '../simulation-registry.js';

/**
 * T129 (R21-F1): the consumption lanes' honest targeting wait floor (ms).
 * The r21 outage: session-targeting (the world-session wake/catch-up behind
 * `resolveConsumptionTargetSimForLane`) could hold a caller far past the
 * public gateway's ~100s kill — a bare 504 with zero platform teaching. The
 * root fix lives in the world-session layer (the catch-up runs on a
 * background chain and callers stop waiting after its own sync cap); THIS
 * floor is the belt-and-braces over the whole resolver: past it the lane
 * answers 503 (lane-honest code) + retryAfterSec + a teaching pointer, and
 * whatever targeting was doing keeps running server-side. Default 90s —
 * under the gateway's 100s, the same envelope rationale as T128's invoke
 * decision floor. Injectable via ctx.consumptionTargetWaitMs (tests use
 * small values).
 */
export const CONSUMPTION_TARGET_WAIT_LIMIT_MS = 90_000;
/** How soon the 503 teaches the caller to re-check. */
export const CONSUMPTION_TARGET_RETRY_AFTER_SEC = 30;

/**
 * T129: race a consumption-lane targeting step against the lane's honest
 * wait floor. `onCap` crafts the lane's own 503 (code + message name the
 * lane: READ_TARGETING_PENDING on reads, CONSUMPTION_TARGET_PENDING on the
 * stream upgrade) so every face keeps its honest name. The raced op is NOT
 * cancelled — whatever it was materializing keeps completing server-side.
 */
export async function raceConsumptionTargeting<T>(
  waitLimitMs: number,
  onCap: () => ApiError,
  op: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onCap()), waitLimitMs);
    timer.unref?.();
  });
  const work = op(); // started exactly once
  // If the cap wins, `work` may still be pending — its late outcome (the
  // targeting completing, or failing) must never become an unhandled
  // rejection. The extra handler does not change what Promise.race awaits.
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * T86 (R11, u1-F1): the READ default lane's world adjudication as ONE pure
 * decision — the contract both the read lane and the T84 signability probe
 * speak, so a pre-signing verdict can never be minted against a world the
 * read would never target (u1: the probe named another member's sim while
 * her default read landed on the authoritative world session).
 *
 * T96 (R14, u4-P2): the default candidates are the caller's OWN running
 * sims — STRICTLY. The old env-owner clause let a member's default read
 * silently land on the ENV OWNER's running sim whenever it was the only
 * candidate (u4's meter read switched its world from the authoritative
 * session to another member's sim the moment she started it — data source
 * drifting with other testers' sim churn). Now: another member's sim — the
 * owner's included — is never a default candidate; reading it needs an
 * EXPLICIT simulationId (the legacy resolver keeps the T-052 ownership
 * carve-outs). Platform rows (createdBy undefined — public infrastructure,
 * nobody's "other") stay targetable. An ambiguous default means ≥2 OWN sims
 * — the honest 409 lists them (the session is NOT a silent tiebreak).
 *
 * Adjudication for a DEFAULT read (no explicit simulationId), in priority
 * order:
 * - 'default-binding' — T122 (R17-u3/R19-u4): the environment owner bound a
 *   default simulation (`defaultSimulationId`) and it is RUNNING in this env
 *   — the shared multi-sim world has an answer that does not depend on who
 *   happens to be calling. HIGHEST priority (an explicit owner decision
 *   outranks per-caller heuristics); the response discloses it;
 * - 'own-sim'      — the caller runs EXACTLY ONE targetable own sim
 *   (T51: that sim IS the world she is watching);
 * - 'ambiguous'    — several such sims → the honest 409;
 * - 'world-session'— no own sim → the authoritative world session (the read
 *   lane then creates/wakes it on demand; a GET probe only ever inspects an
 *   ALREADY-LIVE session — never a created/woken one).
 *
 * Honest boundary: a binding naming a STOPPED/DELETED sim (or another env's)
 * is INERT — the adjudication falls through to the legs below and carries
 * `staleBinding` so the caller's answer can disclose the fall-back and point
 * at `eaf env set-default-sim <env> --clear` (never a silent world switch,
 * never a binding that lies).
 */
export type ReadDefaultWorldChoice =
  | { kind: 'default-binding'; record: SimulationRecord }
  | { kind: 'own-sim'; record: SimulationRecord; /** T127 (R20-u2 F2): present when the binding that SHOULD have answered is dead — the leg this fall landed on discloses it. */ staleBinding?: StaleDefaultBinding }
  | { kind: 'ambiguous'; records: SimulationRecord[]; staleBinding?: StaleDefaultBinding }
  | { kind: 'world-session'; staleBinding?: StaleDefaultBinding };

/** T122: why the env's default-simulation binding is NOT being honored. */
export interface StaleDefaultBinding {
  simulationId: string;
  reason: 'not-running' | 'missing' | 'wrong-env' | 'world-session';
}

/** Minimal structural deps so the probe site (server.ts) can share the lane's exact adjudication. */
export type ReadDefaultWorldDeps = {
  envStore: {
    getEnvironment(environmentId: string):
      | { owner_id: string; default_simulation_id?: string | null }
      | undefined;
  };
  registry: {
    runningAllForEnvironment(environmentId: string): SimulationRecord[];
    get(simulationId: string): SimulationRecord | undefined;
  };
};

/** T122: read the env's default binding + judge its current liveness honestly. */
export function judgeDefaultSimBinding(
  deps: ReadDefaultWorldDeps,
  envId: string,
): { simulationId: string } | StaleDefaultBinding | undefined {
  const bound = deps.envStore.getEnvironment(envId)?.default_simulation_id;
  if (bound === undefined || bound === null || bound.length === 0) return undefined;
  const record = deps.registry.get(bound);
  if (record === undefined) return { simulationId: bound, reason: 'missing' };
  if (record.environmentId !== envId) return { simulationId: bound, reason: 'wrong-env' };
  if (record.envSession === true) return { simulationId: bound, reason: 'world-session' };
  if (record.runtime.getState() !== 'running') return { simulationId: bound, reason: 'not-running' };
  return { simulationId: record.id };
}

/** T122: internal alias — the adjudication reads the same judgment. */
const defaultBindingOf = judgeDefaultSimBinding;

/**
 * T122: the disclosure line for a default-lane answer, from the SAME
 * adjudication that picked the world — zh first (the human faces), English
 * in the parenthetical (the R102 bilingual discipline). `default-binding`
 * discloses the binding; a stale binding discloses the fall-back and the
 * clear/rebind command. Undefined when no binding is involved.
 */
export function defaultSimNoteOf(choice: ReadDefaultWorldChoice): string | undefined {
  if (choice.kind === 'default-binding') {
    return (
      `使用环境默认仿真 ${choice.record.id}。 ` +
      `(Using the environment's default simulation ${choice.record.id} — ` +
      'set by the environment owner; pass an explicit simulationId to target another world.)'
    );
  }
  const stale = choice.kind === 'ambiguous' || choice.kind === 'world-session' || choice.kind === 'own-sim'
    ? choice.staleBinding
    : undefined;
  if (stale === undefined) return undefined;
  const whyZh: Record<StaleDefaultBinding['reason'], string> = {
    'not-running': '已停止运行',
    missing: '已不存在（仿真删除或服务器重启）',
    'wrong-env': '不属于本环境',
    'world-session': '是权威 world session（不可作为默认绑定）',
  };
  const whyEn: Record<StaleDefaultBinding['reason'], string> = {
    'not-running': 'is not running',
    missing: 'no longer exists (deleted, or the server restarted)',
    'wrong-env': 'belongs to another environment',
    'world-session': 'is the authoritative world session (not bindable)',
  };
  const fallbackZh =
    choice.kind === 'ambiguous'
      ? `本次回退到歧义裁决（${choice.records.length} 个候选）`
      : choice.kind === 'own-sim'
        ? `本次回退到你自己唯一运行中的仿真 ${choice.record.id}`
        : '本次回退到权威 world session';
  const fallbackEn =
    choice.kind === 'ambiguous'
      ? 'fell back to the standard default-world adjudication'
      : choice.kind === 'own-sim'
        ? `fell back to your single running simulation ${choice.record.id}`
        : 'fell back to the standard default-world adjudication';
  return (
    `⚠ 环境默认仿真 ${stale.simulationId} ${whyZh[stale.reason]}——${fallbackZh}；` +
    '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
    `(The environment's default simulation ${stale.simulationId} ${whyEn[stale.reason]} — ` +
    `${fallbackEn}; ` +
    'clear or rebind it with `eaf env set-default-sim <env> --clear`.)'
  );
}

export function readDefaultWorldChoiceOf(
  deps: ReadDefaultWorldDeps,
  envId: string,
  userId: string | undefined,
): ReadDefaultWorldChoice {
  // T122: the owner's default binding is the HIGHEST-priority leg — an
  // explicit owner decision about "which world does this env's default lane
  // mean" outranks the per-caller heuristics below. Liveness is re-judged on
  // every call (a stopped/deleted binding falls through + annotates).
  const binding = defaultBindingOf(deps, envId);
  if (binding !== undefined && !('reason' in binding)) {
    const record = deps.registry.get(binding.simulationId)!;
    return { kind: 'default-binding', record };
  }
  const staleBinding = binding as StaleDefaultBinding | undefined;
  const ownRunning = deps.registry
    .runningAllForEnvironment(envId)
    .filter(
      sim =>
        sim.envSession !== true &&
        // T96: own strictly — the env-owner carve-out lives only on the
        // EXPLICIT simulationId lanes (resolveConsumptionTargetSim), never
        // on the default world choice.
        (sim.createdBy === undefined || (userId !== undefined && sim.createdBy === userId)),
    );
  // T127 (R20-u2 F2): the own-sim leg carries the stale annotation too — a
  // dead binding falling through to the caller's single own sim is EXACTLY
  // the silent world switch the contract forbids (the bound world silently
  // became HER world). `defaultSimNoteOf` renders the disclosure; the read
  // lane's resolver already surfaces it.
  if (ownRunning.length === 1) {
    return { kind: 'own-sim', record: ownRunning[0]!, ...(staleBinding !== undefined ? { staleBinding } : {}) };
  }
  if (ownRunning.length > 1) return { kind: 'ambiguous', records: ownRunning, staleBinding };
  return { kind: 'world-session', staleBinding };
}

/**
 * T91 (R13, u2-F1): the read-source probe's ONE target-selection table — the
 * exact consumer of `readDefaultWorldChoiceOf` the catalog probe speaks, so
 * a pre-signing verdict can never be minted against (or withheld from) a
 * world the default read would not target.
 *
 * - exactly one targetable own sim → probe it ('own-sim');
 * - own sim ABSENT or AMBIGUOUS → the read lane's fallback world, the
 *   authoritative session, probed ONLY when already LIVE (a GET never
 *   creates/wakes a session: absent/hibernated/stopped stays honest
 *   unknown — the read would create/wake it, and a rebuilt session's
 *   checkpoint-restore marks its device keys written, so a live-session
 *   probe is the only honest one);
 * - nothing live to judge → undefined (the caller renders no readSource
 *   face — never a guess, never a foreign sim).
 */
export function readSourceProbeTargetOf(
  deps: ReadDefaultWorldDeps & {
    /** Optional so degenerate harnesses can omit the session service. */
    worldSessions?: {
      statusOf(envId: string): { state?: string; simulationId: string } | undefined;
    };
  },
  envId: string,
  userId: string | undefined,
): { record: SimulationRecord; probedLane: 'own-sim' | 'world-session' } | undefined {
  const choice = readDefaultWorldChoiceOf(deps, envId, userId);
  if (choice.kind === 'own-sim' || choice.kind === 'default-binding') {
    // T122: a default-binding sim is a USER sim (the world-session leg is
    // excluded at bind time and at use time) — the probe lane word stays
    // 'own-sim' (the signability disclosure's two-lane vocabulary).
    return { record: choice.record, probedLane: 'own-sim' };
  }
  // own-sim absent OR ambiguous — the read lane's fallback world is the
  // session; probe it when LIVE only (see above).
  const session = deps.worldSessions?.statusOf(envId);
  if (session === undefined || session.state === 'hibernated') return undefined;
  const live = deps.registry.get(session.simulationId);
  if (live === undefined || live.runtime.getState() === 'stopped') return undefined;
  return { record: live, probedLane: 'world-session' };
}

/**
 * T-311 (EN-F10) + R14 (design-data-services.md §4): ONE sim-targeting
 * contract for every consumption lane — invoke (body.simulationId), the
 * observation stream (?simulationId) and data reads (body.simulationId).
 * The shared contract (T-205/T-052): explicit simulationId must be a RUNNING
 * sim of this env the caller may target; omitted + exactly one targetable
 * running sim → that one (legacy default); omitted + several → 409
 * SIMULATION_AMBIGUOUS listing them (never a silent first-match); none →
 * 409 SIMULATION_NOT_RUNNING / 403 foreign-only. `noun` names the lane in
 * the teaching messages ("invocations", "observation streams", "data
 * reads") — the WS upgrade and the HTTP twins have shared one function
 * since T-311; the read lane joins it rather than drift a third copy.
 */
export function resolveConsumptionTargetSim(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  userId: string,
  simulationId: string | undefined,
  noun: string,
): SimulationRecord {
  const envRow = ctx.envStore.getEnvironment(agreement.env_id)!;
  const mayTarget = (sim: SimulationRecord): boolean =>
    sim.createdBy === undefined ||
    sim.createdBy === userId ||
    sim.createdBy === envRow.owner_id;
  const runningSims = ctx.registry.runningAllForEnvironment(agreement.env_id);
  const targetable = runningSims.filter(mayTarget);
  const foreignTargetTeaching =
    `${noun} may only target a simulation you created (or the environment owner's) — ` +
    `create your own (POST /api/simulations { environmentId: "${agreement.env_id}" }), ` +
    'start it, and pass its id as simulationId';

  if (simulationId !== undefined) {
    if (typeof simulationId !== 'string' || simulationId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', '"simulationId" must be a non-empty string when provided');
    }
    const record = targetable.find(sim => sim.id === simulationId);
    if (record !== undefined) return record;
    if (runningSims.some(sim => sim.id === simulationId)) {
      throw new ApiError(403, 'FORBIDDEN', `Simulation "${simulationId}" was created by another user — ${foreignTargetTeaching}`);
    }
    const known = ctx.registry.get(simulationId);
    if (known === undefined) {
      throw new ApiError(404, 'SIMULATION_NOT_FOUND', `Simulation "${simulationId}" not found`);
    }
    // T-501 (CB24-F01): an explicit id naming THIS env's live authoritative
    // world session is targetable — platform-created (no creator to be
    // foreign to), excluded from the per-user lists above BY DESIGN. Without
    // this branch a running session fell through to the self-contradictory
    // 409 below ("is running — … require a running simulation"). A non-running
    // session record still gets the honest state-named 409. A FOREIGN env's
    // session keeps the wrong-env diagnosis.
    if (known.envSession === true && known.environmentId === agreement.env_id) {
      if (known.runtime.getState() === 'running') return known;
      throw new ApiError(
        409,
        'SIMULATION_NOT_RUNNING',
        `Simulation "${simulationId}" is ${known.runtime.getState()} — ${noun} require a running simulation`,
      );
    }
    throw new ApiError(
      409,
      'SIMULATION_NOT_RUNNING',
      known.environmentId === agreement.env_id
        ? `Simulation "${simulationId}" is ${known.runtime.getState()} — ${noun} require a running simulation`
        : `Simulation "${simulationId}" belongs to environment "${known.environmentId}", not "${agreement.env_id}"`,
    );
  }
  if (targetable.length === 1) return targetable[0];
  if (targetable.length === 0) {
    if (runningSims.length === 0) {
      throw new ApiError(
        409,
        'SIMULATION_NOT_RUNNING',
        `Environment "${agreement.env_id}" has no running simulation — ` +
          `${noun} read the live simulation runtime; ` +
          'create and start one first (POST /api/simulations { environmentId }, then /start)',
      );
    }
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Environment "${agreement.env_id}" has ${runningSims.length} running simulation(s), ` +
      `none created by you — ${foreignTargetTeaching}`,
    );
  }
  throw new ApiError(
    409,
    'SIMULATION_AMBIGUOUS',
    `Environment "${agreement.env_id}" has ${targetable.length} running simulations you may target — ` +
      'pass simulationId to target one: ' +
      targetable.map(sim => `${sim.id} (created ${sim.createdAt})`).join(', '),
    undefined,
    { simulations: targetable.map(sim => sim.id) },
  );
}

/**
 * Living-worlds P1W: the session-aware wrapper the DATA lanes use
 * (reads + computation streams). With no explicit simulationId the env's
 * authoritative world session is the default target — created on demand and
 * materialized to wall-now (the first-observer creation rule, design §4.3;
 * DB-F06's frame divergence closes: every consumer evaluates the same
 * world). When the session cannot exist (invalid env, store fault) or the
 * caller passed an explicit simulationId, resolution falls through to the
 * legacy per-user-sim contract unchanged.
 *
 * T-501 (CB24-F01): the INVOKE lane joins this contract. Additionally, an
 * EXPLICIT simulationId that names THIS env's world session (the
 * deterministic `sim-<envId>-world-session` id) resolves through the session
 * service too — waking a hibernated session and materializing it to
 * wall-now — instead of the legacy foreign/running checks (the session is
 * platform-created: there is no creator whose permission to ask for).
 * Caller-created sims keep the T-052 semantics in the legacy resolver.
 */
export async function resolveConsumptionTargetSimForLane(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  userId: string,
  simulationId: string | undefined,
  noun: string,
  options: { preferSession?: boolean; preferOwnRunningSim?: boolean } = {},
): Promise<SimulationRecord> {
  const resolved = await resolveConsumptionTargetForLaneWithNote(
    ctx, agreement, userId, simulationId, noun, options,
  );
  return resolved.record;
}

/**
 * T122: the lane resolver's DISCLOSING twin — the read lane uses it so an
 * answer that rode (or fell off) the environment's default-simulation
 * binding says so (`defaultSimNote`). The record semantics are IDENTICAL to
 * `resolveConsumptionTargetSimForLane` (this is the same body, one choice).
 */
export async function resolveConsumptionTargetForLaneWithNote(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  userId: string,
  simulationId: string | undefined,
  noun: string,
  options: { preferSession?: boolean; preferOwnRunningSim?: boolean } = {},
): Promise<{ record: SimulationRecord; defaultSimNote?: string }> {
  // T51 (R5, u4-P1-1): the READ lane prefers the caller's OWN RUNNING sim —
  // u4 read her meter while watching her accelerated sim and every fresh
  // reading came from the idle 1x world session instead ("你模拟的是哪一个
  // 世界"). When the caller runs exactly one targetable sim of her own, that
  // sim IS the world she means; several → the honest ambiguous teaching
  // (the session is NOT a silent tiebreak); none → the authoritative world
  // session below, exactly as P1W designed. An explicit simulationId always
  // wins and keeps the legacy ownership checks.
  // T122: the choice is the T86 shared table — the env owner's default
  // binding is its highest-priority leg (honored with disclosure; a stale
  // binding annotates the ambiguous leg's 409 and this note).
  // T127 (R20-u2 F2): a stale binding annotates EVERY leg it falls off of —
  // the note declared here rides the own-sim hit above (its choice carries
  // staleBinding now) or the world-session/legacy resolution below.
  let staleBindingNote: string | undefined;
  if (options.preferOwnRunningSim === true && simulationId === undefined) {
    const choice = readDefaultWorldChoiceOf(
      { envStore: ctx.envStore, registry: ctx.registry },
      agreement.env_id,
      userId,
    );
    if (choice.kind === 'own-sim' || choice.kind === 'default-binding') {
      return { record: choice.record, defaultSimNote: defaultSimNoteOf(choice) };
    }
    if (choice.kind === 'ambiguous') {
      throw new ApiError(
        409,
        'SIMULATION_AMBIGUOUS',
        `Environment "${agreement.env_id}" has ${choice.records.length} running simulations you may target — ` +
          'pass simulationId to target one: ' +
          choice.records.map(sim => `${sim.id} (created ${sim.createdAt})`).join(', ') +
          (choice.staleBinding !== undefined
            ? ` — ${defaultSimNoteOf(choice)}`
            : ''),
        undefined,
        { simulations: choice.records.map(sim => sim.id) },
      );
    }
    // T127 (R20-u2 F2): the world-session leg remembers a stale binding —
    // the fall-through below resolves the actual world (the session, or the
    // legacy lanes when the session cannot exist), and the note rides
    // WHICHEVER record answers. Before this, a dead binding + no own sim
    // switched the read's world silently — the exact T122 promise breach.
    staleBindingNote = defaultSimNoteOf(choice);
  }
  if (options.preferSession === true && ctx.worldSessions !== undefined) {
    if (
      simulationId === undefined ||
      simulationId === worldSessionSimIdOf(agreement.env_id)
    ) {
      const record = await ctx.worldSessions.targetFor(agreement.env_id);
      if (record !== undefined) {
        return { record, ...(staleBindingNote !== undefined ? { defaultSimNote: staleBindingNote } : {}) };
      }
      // Session unavailable — honest fallback to the legacy lanes below.
    }
  }
  const legacyRecord = await resolveConsumptionTargetSim(ctx, agreement, userId, simulationId, noun);
  return { record: legacyRecord, ...(staleBindingNote !== undefined ? { defaultSimNote: staleBindingNote } : {}) };
}
