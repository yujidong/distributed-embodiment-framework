/**
 * Sim runtime builder (R21-W4 extraction from simulation-registry.ts; pure
 * move, zero semantic change).
 *
 * The ONE assembly path for EngineRuntime construction in the server:
 * LLM resolution (shared client + cache + triage), the hass:// device
 * factory, the flows provider, and every engine-option knob threading.
 * create + env-session + every resume/rebuild lane build through here so
 * wiring stays identical across all of them.
 */

import {
  EngineRuntime,
  type EngineRuntimeOptions,
  type LlmFunctionClients,
  type ScenarioDefinition,
  type TickTimer,
} from '@active-collaboration/core';
import {
  LLMClient,
  LLMCache,
  formatModelRoute,
  type ModelRoute,
  type LlmModelRoutes,
} from '@active-collaboration/llm-integration';
import { isCapabilityExecutable } from '@active-collaboration/simulation';
import { createLogger } from '@active-collaboration/shared';

import { ApiError } from '../errors.js';
import { instrumentLLMClient, type LlmTokenUsage } from '../metrics.js';
import type { HASService } from '../hass/service.js';
import type { FlowStore } from '../db/flow-store.js';
import type { LLMPreset, LlmResolution, CreateSimulationOptions } from './types.js';

/** Default model for small-model triage (P4-2). */
export const DEFAULT_TRIAGE_MODEL = 'ac-decision-15b-v2';

const logger = createLogger('SimRuntimeBuilder');

/**
 * R5-F12 (fault-injection drill visibility): (agentId|declared|deployed)
 * combos whose model-drift normalization was already warned about. The warn
 * fires ONCE per combo per process — runtime rebuilds (resume, env-session)
 * must not re-spam the log.
 */
const modelDriftWarned = new Set<string>();

function warnModelDriftOnce(key: string, message: string): void {
  if (modelDriftWarned.has(key)) return;
  modelDriftWarned.add(key);
  logger.warn(message);
}

/**
 * Per-function routing visibility: one assembly-time warn per (function,
 * route) combo per process — the route's request-time normalization
 * (deployedModel = route model) is otherwise only visible per request.
 */
const routeWarned = new Set<string>();

function warnRouteOnce(fn: 'decision' | 'eval' | 'nl', route: ModelRoute): void {
  const key = `${fn}|${formatModelRoute(route)}`;
  if (routeWarned.has(key)) return;
  routeWarned.add(key);
  logger.warn(
    `LLM function route active: ${fn} calls are served by "${formatModelRoute(route)}" ` +
    '(per-function model routing) — requests naming another model are normalized to the ' +
    'route model at request time (LLM_MODEL_STRICT=1 turns a mismatch into a hard error)',
  );
}

/**
 * T134 (R20-F, u1-F1): EAF_AC_HANDSHAKE_FAST_LANE — put the AC handshake
 * EVALUATION client (the responder's per-proposal accept/reject/defer call,
 * the only consumer of the `eval` function client) on the fast-lane request
 * queue. Default OFF. Why a queue flag: at ×300 the responders' evaluations
 * share the ONE global LLM request queue (LLM_MAX_CONCURRENT, default 3)
 * with every other agent's decision/triage/eval traffic — under the event
 * flood the handshake answers queue behind the pack and land slower than the
 * initiator's window (u1: failures 100% abandoned-before-response). The
 * R44-F1 fast-lane queue already exists for decision/triage call sites; this
 * knob extends the SAME mechanism to the handshake-evaluation call site.
 * OFF (default) = bit-identical wiring; ON affects only which queue the
 * evaluation requests are admitted to — no prompt, budget, or decision
 * semantics change.
 */
export function handshakeFastLaneFromEnv(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.EAF_AC_HANDSHAKE_FAST_LANE ?? '').trim());
}

/** The LLM backend knobs the builder resolves clients from (server env). */
export interface LlmEnv {
  llmCachePath?: string;
  /** R44-B: the OpenAI-compatible (vLLM) triple — the sole backend. */
  llmProvider?: 'openai-compatible';
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  /** P4-2: server-level triage model override (LLM_TRIAGE_MODEL). */
  llmTriageModel?: string;
  /**
   * Per-function model routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
   * LLM_NL_MODEL, parsed by loadConfig). Absent slots keep the shared
   * client — single-backend behavior unchanged.
   */
  llmRoutes?: LlmModelRoutes;
  /** S-vLLM (R20): LLM_TIMEOUT_MS override applied to every client. */
  llmTimeoutMs?: number;
  /**
   * T-022 (DevLoop R17): bounded degradation policy for LLM-backed AC
   * decisions (server env vars LLM_DECISION_*). Threaded into every
   * created runtime's EngineRuntimeOptions.llmFailure.
   */
  llmDecisionFailure?: {
    retryAttempts: number;
    retryBackoffMs: number;
    policy: 'rule-fallback' | 'drop';
  };
}

export class SimRuntimeBuilder {
  constructor(
    private readonly llmEnv: LlmEnv,
    /** Shared Home Assistant service (P3a); consulted only for hass:// bindings. */
    private readonly hass: HASService | undefined,
    /** User-orchestrated business flows (env-backed sims get a live provider). */
    private readonly flowStore: FlowStore | undefined,
    /** Shared LLM response cache (P4-2) — one cache for every client built. */
    private readonly llmCache: LLMCache,
    /** Token-usage sink (P4-4 observability); undefined = no instrumentation. */
    private readonly tokenUsageSink: ((usage: LlmTokenUsage) => void) | undefined,
    /** Latency sink (R15-A3): duration + success per chat call. */
    private readonly llmLatencySink: ((durationMs: number, success: boolean) => void) | undefined,
  ) {}

  /**
   * Shared runtime assembly (create + P0 resume both build through here):
   * LLM resolution, triage, hass device factory, flows provider, engine
   * option threading. Resume additionally passes `trajectoryAppend` so the
   * rebuilt runtime keeps appending to the hibernated sim's trajectory file
   * (identity and history intact).
   */
  async build(args: {
    id: string;
    scenario: ScenarioDefinition;
    options: CreateSimulationOptions;
    environmentId?: string;
    environmentOwnerId?: string;
    trajectoryDir?: string;
    trajectoryAppend?: boolean;
    /** Living-worlds P2: per-segment cap of the trajectory segmented log. */
    trajectorySegmentBytes?: number;
    /**
     * T118 clock-injection seam: replaces the tick loop's wall timer for
     * every runtime this builder assembles. Tests only — omitted (the
     * default setTimeout scheduling) in every production lane.
     */
    tickTimer?: TickTimer;
    /**
     * T118 clock-anchor discipline pin: fixes every runtime's WALL anchor
     * (checkpoint `simStartEpochMs`) so separately constructed runtimes
     * share it and compare bit-wise. Tests only — omitted (anchor at the
     * construction moment) in every production lane.
     */
    simStartEpochMs?: number;
  }): Promise<{ runtime: EngineRuntime; llm: LlmResolution }> {
    const { scenario, options } = args;
    const environmentId = args.environmentId;
    const llm = this.resolveLLM(scenario, options.llmClient ?? 'auto', options.llmModel);

    const engineOptions: EngineRuntimeOptions = {};
    if (llm.client) {
      engineOptions.llmClient = llm.client;
      // Per-function model routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
      // LLM_NL_MODEL): routed clients override the shared/per-agent client
      // for their call-site class inside each agent.
      if (llm.functionClients !== undefined) {
        engineOptions.llmFunctionClients = llm.functionClients;
      }
      // R37-F3 (validation F3): populate the T-601 llmPerAgent seam from the
      // agents' own llm.model declarations — before this, no server code
      // populated the map, so resolveAgentLlmClient only honored llm:null
      // and every LLM decision ran on the shared (server-default) model.
      const llmPerAgent = this.buildLlmPerAgent(scenario, llm.client);
      if (llmPerAgent !== undefined) engineOptions.llmPerAgent = llmPerAgent;
    }
    if (args.trajectoryDir !== undefined) engineOptions.trajectoryDir = args.trajectoryDir;
    if (args.trajectoryAppend === true) engineOptions.trajectoryAppend = true;
    if (args.trajectorySegmentBytes !== undefined) {
      engineOptions.trajectorySegmentBytes = args.trajectorySegmentBytes;
    }
    if (options.tickMs !== undefined) engineOptions.tickMs = options.tickMs;
    // T118: the injected tick timer / wall-anchor pin are builder-args knobs
    // (like trajectorySegmentBytes), NOT client-facing create options — they
    // must never ride CreateSimulationOptions/checkpoints.
    if (args.tickTimer !== undefined) engineOptions.tickTimer = args.tickTimer;
    if (args.simStartEpochMs !== undefined) engineOptions.simStartEpochMs = args.simStartEpochMs;
    if (options.acMode !== undefined) engineOptions.acMode = options.acMode;
    // T-051: sim-level actuation override — per-agent precedence (sim option
    // > scenario decisionPolicy > default true) resolves in EngineRuntime.
    if (options.autoActuateIndependent !== undefined) {
      engineOptions.autoActuateIndependent = options.autoActuateIndependent;
    }
    if (options.llmSystemPrompt !== undefined) {
      engineOptions.assessorSystemPrompt = options.llmSystemPrompt;
    }
    // T-022: bounded degradation policy for LLM-backed decisions (server
    // env knobs; core defaults apply when the host supplies nothing).
    if (this.llmEnv.llmDecisionFailure !== undefined) {
      engineOptions.llmFailure = this.llmEnv.llmDecisionFailure;
    }

    // P4-2: small-model triage — only meaningful with an LLM-backed runtime;
    // silently ignored for rule-only sims (mirrors the 'auto' preset's
    // degrade-quietly philosophy).
    if (options.triage?.enabled && llm.client) {
      // T-113: the triage client hits the SAME configured backend as the
      // decision client (historically it was hardwired to the removed local
      // backend while decisions had already moved on — invisible errors).
      // options.triage.model overrides the MODEL only.
      // Per-function routing: without an explicit triage model the triage
      // lane follows the DECISION route (LLM_DECISION_MODEL), including its
      // @baseURL when the route pins another vLLM instance.
      const decisionRoute = this.llmEnv.llmRoutes?.decision;
      const triageFollowsDecisionRoute =
        options.triage.model === undefined &&
        this.llmEnv.llmTriageModel === undefined &&
        decisionRoute !== undefined;
      const triageModel = options.triage.model ??
        this.llmEnv.llmTriageModel ??
        decisionRoute?.model ??
        llm.model ??
        this.llmEnv.llmModel ??
        DEFAULT_TRIAGE_MODEL;
      // fastLane: the triage call site is a decision-lane call — the lane
      // follows the CALL SITE (client flag), not the model-name prefix
      // (the ac-decision prefix heuristic remains as compat fallback for
      // unmarked clients).
      let triageClient: LLMClient;
      if (triageFollowsDecisionRoute) {
        // buildLLMClient applies cache + instrumentation internally.
        triageClient = this.buildLLMClient(triageModel, { route: decisionRoute, fastLane: true });
      } else {
        triageClient = new LLMClient('openai-compatible', {
          baseURL: this.llmEnv.llmBaseUrl,
          apiKey: this.llmEnv.llmApiKey,
          model: triageModel,
          fastLane: true,
          ...(this.llmEnv.llmTimeoutMs !== undefined ? { timeout: this.llmEnv.llmTimeoutMs } : {}),
        });
        triageClient.enableCache(this.llmCache);
        this.instrument(triageClient);
      }
      engineOptions.triage = {
        enabled: true,
        client: triageClient,
        mode: options.triage.mode ?? 'shadow',
        trustIndependent: options.triage.trustIndependent ?? true,
      };
    }

    // P3a: hass:// bindings need the shared HA connection + deviceFactory.
    // sim://-only scenarios skip this entirely (default engine path).
    // HIL P2: an explicit options.deviceFactory (shadow forks) always wins.
    if (options.deviceFactory !== undefined) {
      engineOptions.deviceFactory = options.deviceFactory;
    } else if (scenario.devices.some(d => d.binding.startsWith('hass://'))) {      if (!this.hass?.isConfigured()) {
        throw new ApiError(
          503,
          'HASS_NOT_CONFIGURED',
          'Scenario uses hass:// device bindings but Home Assistant is not ' +
          'configured on this server — set HASS_URL and HASS_TOKEN',
        );
      }
      engineOptions.deviceFactory = await this.hass.createDeviceFactory(scenario.devices, {
        simId: args.id,
        envId: environmentId ?? null,
      });
    }

    // User-orchestrated flows: env-backed sims read the env's enabled flows
    // live from the store on every trigger evaluation (dynamic enable/edit);
    // an explicit flowsProvider always wins over scenario-declared flows.
    // T-201: the env owner id rides along so flow definitions carry the
    // author-scoped authorUserId stamp (omitted for owner-authored flows).
    if (environmentId !== undefined && this.flowStore) {
      const store = this.flowStore;
      const envOwnerId = args.environmentOwnerId;
      engineOptions.flowsProvider = () => store.listEnabled(environmentId, envOwnerId);
    }
    // T-051: the runtime assignment pass validates with the SAME
    // executability oracle as authoring (routes/flows.ts assertFlowValid),
    // so a flow's runtime verdict can never diverge from its 422 verdict.
    engineOptions.isExecutableCapability = isCapabilityExecutable;

    return { runtime: new EngineRuntime(scenario, engineOptions), llm };
  }

  resolveLLM(
    scenario: ScenarioDefinition,
    preset: LLMPreset,
    modelOverride?: string,
  ): LlmResolution {
    if (preset === 'none') return { mode: 'rule-only' };

    // R44-B: one backend — configured means LLM_BASE_URL is set.
    const configured = (this.llmEnv.llmBaseUrl ?? '').length > 0;
    // Fix-45a: an explicit "llm" preset on an unconfigured server DEGRADES
    // to rule-only with a prominent warning instead of a hard 400 — blocking
    // the classroom over a preset typo/config gap helped nobody, and the
    // warning keeps the degradation visible (P1-1: never degrade silently).
    // T-601 (R26): `llm: null` is an explicit opt-out, NOT a request.
    // R5-F02: an UNDECLARED llm block (key absent) DEFAULTS to the shared
    // client — the openapi CreateAgentBody.llm contract ("缺省不传 = 沿用
    // 共享 client") and the runtime's resolveAgentLlmClient fall-through
    // already read it that way; only the builder gate disagreed, silently
    // zeroing a no-declaration world's collaboration story. wantsLLM is
    // therefore "at least one agent did not explicitly opt out".
    const wantsLLM = scenario.agents.some(agent => agent.llm !== null);
    if (!configured) {
      // Fix-45a semantics preserved: warn on an explicit preset or when the
      // world would use the LLM — a world where every agent opted out stays
      // quietly rule-only (the Fix-45b branch below covers the configured
      // case).
      const warning = preset === 'llm'
        ? 'LLM preset "llm" was requested but LLM_BASE_URL is not configured on this server — ' +
          'running rule-only (deterministic rule decisions, no LLM calls). ' +
          'Set LLM_BASE_URL (vLLM, OpenAI-compatible) to enable LLM decisions.'
        : wantsLLM
          ? 'Agents in this world use LLM decisions (declared or by default) but LLM_BASE_URL is not configured on this server — ' +
            'running rule-only (deterministic rule decisions, no LLM calls).'
          : undefined;
      return { mode: 'rule-only', ...(warning !== undefined ? { warning } : {}) };
    }
    // Configured server, but every agent explicitly opted out of LLM
    // decisions (llm: null) — say so (Fix-45b, R5-F02): "everything Defer"
    // with zero signal is how the no-declaration gap (E2E A-F4) stayed
    // invisible; the opt-out world is the remaining rule-only landing and
    // keeps its llmWarning.
    if (!wantsLLM) {
      return {
        mode: 'rule-only',
        warning: scenario.agents.length === 0
          ? 'This environment has no agents — nothing can make LLM decisions; running rule-only.'
          : 'This environment runs rule-only: every agent explicitly opts out of LLM decisions ' +
            '(llm: null) — collaboration decisions are unavailable. Remove the llm:null opt-out (or add ' +
            'an llm block) on agents that should reason with a model.',
      };
    }

    // R44-B: build the shared client. The openai-compatible provider
    // REQUIRES a model (its constructor throws without one) — degrade
    // rule-only with a warning instead of 500ing.
    const scenarioModel = scenario.agents.find(agent => agent.llm != null)?.llm?.model;
    const model = modelOverride ?? this.llmEnv.llmModel ?? scenarioModel;
    if (model === undefined) {
      return {
        mode: 'rule-only',
        warning: 'The LLM backend is configured but no model is set — ' +
          'set LLM_MODEL (or an llm.model on the agents) to enable LLM decisions. Running rule-only.',
      };
    }
    const client = this.buildLLMClient(model);
    // Per-function routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
    // LLM_NL_MODEL) — undefined when no routes are configured AND the T134
    // handshake fast lane is off (the default keeps the wiring untouched).
    const functionClients = this.buildFunctionClients(model);
    return {
      client,
      ...(functionClients !== undefined ? { functionClients } : {}),
      mode: 'llm',
      // Report the model the client will actually call (explicit override,
      // the env knob, the scenario's llm.model, or the provider default).
      model: client.getModel(),
    };
  }

  /**
   * R37-F3: one LLM client for the configured backend with an explicit model
   * — the single construction resolveLLM's shared client AND the per-agent
   * clients below use (cache + instrumentation applied identically).
   *
   * P1 config-drift fix: every decision-path client carries deployedModel =
   * LLM_MODEL, so a stale per-agent/scenario model name is rewritten to the
   * model the backend actually serves (warn) instead of 404ing — strict mode
   * (LLM_MODEL_STRICT=1) errors instead of rewriting.
   */
  private buildLLMClient(model: string, opts?: { route?: ModelRoute; fastLane?: boolean }): LLMClient {
    const client = new LLMClient('openai-compatible', {
      // A route with @baseURL pins this function's calls to ANOTHER vLLM
      // instance; the main deployment's apiKey is NOT sent there (the key
      // belongs to LLM_BASE_URL — forwarding a bearer to an arbitrary
      // route URL would be a credential leak, same rule the provider's
      // apiKey doc states).
      baseURL: opts?.route?.baseURL ?? this.llmEnv.llmBaseUrl,
      ...(opts?.route?.baseURL === undefined && this.llmEnv.llmApiKey !== undefined
        ? { apiKey: this.llmEnv.llmApiKey }
        : {}),
      model,
      // Per-route normalization: a routed client rewrites any mismatching
      // request model to the ROUTE model (strict mode errors) — the same
      // semantics LLM_MODEL has on the shared client, applied per route.
      ...(opts?.route !== undefined
        ? { deployedModel: opts.route.model }
        : this.llmEnv.llmModel !== undefined
          ? { deployedModel: this.llmEnv.llmModel }
          : {}),
      ...(opts?.fastLane !== undefined ? { fastLane: opts.fastLane } : {}),
      ...(this.llmEnv.llmTimeoutMs !== undefined ? { timeout: this.llmEnv.llmTimeoutMs } : {}),
    });
    client.enableCache(this.llmCache);
    this.instrument(client);
    return client;
  }

  /**
   * Per-function routed clients (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
   * LLM_NL_MODEL). The decision client takes the fast lane by CALL SITE
   * (fastLane flag) — the lane no longer depends on the ac-decision name
   * prefix for routed deployments. Undefined when no routes are configured
   * and the T134 handshake fast lane is off.
   *
   * T134 (R20-F, u1-F1): with EAF_AC_HANDSHAKE_FAST_LANE=1 the EVAL client —
   * the AC handshake evaluation, the `eval` function client's ONLY consumer
   * (CognitiveAgent hands it to CollaborationProposalHandler alone) — is
   * marked fastLane. Without an eval route the knob mints a DEDICATED
   * handshake-evaluation client (same model/normalization as the shared
   * client, its own fastLane marking) so the lane never widens to the other
   * call sites that share the base llmClient.
   */
  private buildFunctionClients(sharedModel: string): LlmFunctionClients | undefined {
    const routes = this.llmEnv.llmRoutes;
    const handshakeFastLane = handshakeFastLaneFromEnv();
    if (routes === undefined && !handshakeFastLane) return undefined;
    const clients: LlmFunctionClients = {};
    if (routes?.decision !== undefined) {
      clients.decision = this.buildLLMClient(routes.decision.model, {
        route: routes.decision,
        fastLane: true,
      });
      warnRouteOnce('decision', routes.decision);
    }
    if (routes?.eval !== undefined) {
      clients.eval = this.buildLLMClient(routes.eval.model, {
        route: routes.eval,
        ...(handshakeFastLane ? { fastLane: true } : {}),
      });
      warnRouteOnce('eval', routes.eval);
    } else if (handshakeFastLane) {
      logger.info(
        'EAF_AC_HANDSHAKE_FAST_LANE=1: the AC handshake-evaluation client takes the fast-lane ' +
        'request queue (no LLM_EVAL_MODEL route — a dedicated client on the shared deployment ' +
        'was minted for the lane; other call sites keep the global queue)',
      );
      clients.eval = this.buildLLMClient(sharedModel, { fastLane: true });
    }
    if (routes?.nl !== undefined) {
      clients.nl = this.buildLLMClient(routes.nl.model, { route: routes.nl });
      warnRouteOnce('nl', routes.nl);
    }
    return Object.keys(clients).length > 0 ? clients : undefined;
  }

  /**
   * R37-F3 (validation F3): populate the T-601 `llmPerAgent` seam from the
   * agents' own `llm.model` declarations. Entries:
   *   - `null` for `llm: null` agents (explicit rule-only opt-out — same
   *     resolution resolveAgentLlmClient's scenario check gives, stated once);
   *   - a dedicated client (one per DISTINCT declared model, cached) for
   *     agents whose llm.model differs from the shared client's model;
   *   - ABSENT for agents on the shared model (resolveAgentLlmClient falls
   *     through to the shared llmClient — legacy behavior byte-identical).
   *
   * The per-agent model always wins FOR THAT AGENT: it is the author's most
   * specific declaration, so create-time options.llmModel, resume's recorded
   * shared model and eval run models shape only the SHARED default (agents
   * without their own model). This also makes resume consistent with create:
   * llmPerAgent is re-derived from the scenario on every build.
   */
  private buildLlmPerAgent(
    scenario: ScenarioDefinition,
    sharedClient: LLMClient,
  ): Record<string, LLMClient | null> | undefined {
    const sharedModel = sharedClient.getModel();
    const clientsByModel = new Map<string, LLMClient>();
    const perAgent: Record<string, LLMClient | null> = {};
    let entries = 0;
    for (const agent of scenario.agents) {
      if (agent.llm === null) {
        perAgent[agent.id] = null;
        entries++;
        continue;
      }
      const declared = typeof agent.llm?.model === 'string' ? agent.llm.model.trim() : '';
      if (declared.length === 0 || declared === sharedModel) continue;
      let client = clientsByModel.get(declared);
      if (client === undefined) {
        client = this.buildLLMClient(declared);
        clientsByModel.set(declared, client);
      }
      perAgent[agent.id] = client;
      entries++;
      // R5-F12 (fault-injection drill visibility): the declared model will be
      // normalized to the deployed one at request time (buildLLMClient pins
      // deployedModel = LLM_MODEL) — say so ONCE per (agent, declared,
      // deployed) combo in the server log, at assembly, where the agent
      // attribution is exact. Without this the rewrite only showed in
      // per-request trajectory context and drill operators injecting a stale
      // llm.model saw nothing on the API/log surface.
      if (this.llmEnv.llmModel !== undefined && declared !== this.llmEnv.llmModel) {
        warnModelDriftOnce(
          `${agent.id}|${declared}|${this.llmEnv.llmModel}`,
          `Model drift normalized: agent "${agent.id}" declares llm.model "${declared}" but the ` +
          `deployment serves "${this.llmEnv.llmModel}" (LLM_MODEL) — its requests are rewritten ` +
          'to the deployed model at request time (LLM_MODEL_STRICT=1 turns this mismatch into ' +
          'a hard error instead)',
        );
      }
    }
    return entries > 0 ? perAgent : undefined;
  }

  /** Feed the client's token usage into the P4-4 metrics sink (no-op when unset). */
  private instrument(client: LLMClient): void {
    if (this.tokenUsageSink === undefined && this.llmLatencySink === undefined) return;
    instrumentLLMClient(
      client,
      this.tokenUsageSink ?? (() => {}),
      this.llmLatencySink,
    );
  }
}
