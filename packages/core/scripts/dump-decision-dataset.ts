/**
 * dump-decision-dataset.ts — deterministic AC-necessity decision dataset dump.
 *
 * Produces a type-balanced fine-tuning dataset for the AC-necessity BINARY
 * decision (collaborate vs independent) covering EVERY (agent, event) pair of
 * the given scenarios — including the discriminating cases (Type A/D/E and
 * sensor-only pairs) that the live LLM path never sees because
 * ACNecessityAssessor.preCheck() short-circuits them (sensor-only →
 * initiate_ac; Type D → defer/ignore; Type E → initiate_ac; Type A →
 * handle_independently). Only Type B/C pairs ever reach the LLM in
 * production, so a dump of live traffic would contain no "independent"
 * examples to speak of. This tool renders the production prompt for ALL
 * pairs and labels them with the formal ground truth.
 *
 * How the production prompt is reproduced (exactly, not approximately):
 *   1. The world is instantiated by PaperExperimentRunner.setupIteration()
 *      itself (called via a structural cast — the method is private), with
 *      condition "full-ac", multiAgentEval=true (every agent gets the full
 *      dual-trigger config incl. actuator/adjacent zone ids), decisionOnly=true
 *      (no physics loop, no AC execution), and a stub LLM client (never
 *      called — we render prompts, we don't send them).
 *   2. For each (agent, event) pair the SystemEvent is rebuilt byte-identical
 *      to what PaperExperimentRunner.injectEvent() constructs (same
 *      resolveEventParameter() mapping, same payload/metadata literals).
 *   3. clusterSummary comes from the agent's own DualTriggerACManager via the
 *      real eventToClusterSummary(); agentContext from the real (public)
 *      buildAgentContext(); the user prompt from the real (private)
 *      ACNecessityAssessor.buildPrompt(); and the system prompt from the real
 *      getStructuredSystemPrompt() — the structured-output variant production
 *      uses (useStructuredOutput=true is the default and the experiment
 *      runner never overrides it). Oracle mode is OFF, so buildOracleSection
 *      contributes nothing (exactly like the full-ac condition).
 *
 * Binary label mapping:
 *   initiate_ac            → "collaborate"
 *   handle_independently   → "independent"
 *   defer                  → "independent"
 *   ignore                 → "independent"
 * Rationale: the fine-tuned model only decides whether to INITIATE
 * collaboration; handle_independently/defer/ignore all mean "do not
 * collaborate".
 *
 * Ground truth: GroundTruthCalculator.computeForAgentEvent() (coverage, gap,
 * interaction type A-E, correctDecision). The completion's reasoning is a
 * deterministic template derived from those GT factors (dataset-dump-lib.ts).
 *
 * Usage (from repo root or packages/core):
 *   npx tsx packages/core/scripts/dump-decision-dataset.ts \
 *     --scenarios all --holdout smart-city --holdout-event-rate 0.2
 *
 * Options:
 *   --scenarios <all|a,b,c>   scenarios to dump (default: all)
 *   --out <dir>               output directory
 *                             (default: packages/core/tests/experiment-results/datasets)
 *   --holdout <scenario>      scenario fully held out as transfer test; all its
 *                             pairs go to transfer-<scenario>.jsonl and it is
 *                             excluded from train/test
 *   --holdout-event-rate <r>  per-scenario event-level split rate: ceil-free
 *                             round(r * #events) events per non-holdout scenario
 *                             go to test.jsonl (with ALL their agent pairs),
 *                             the rest to train.jsonl. 0 disables (default 0)
 *   --seed <n>                split PRNG seed (default 42) — same seed, same split
 *
 * Output: JSONL, one record per (agent, event) pair:
 *   {"messages":[{"role":"system","content":...},{"role":"user","content":...}],
 *    "completion": "{\"decision\":\"collaborate\"|\"independent\",\"reasoning\":\"...\"}",
 *    "meta":{"scenario","eventId","agentId","type","correctDecision","label"}}
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EventType } from '@active-collaboration/shared';
import type { LLMClient } from '@active-collaboration/llm-integration';

import {
  PaperExperimentRunner,
  resolveEventParameter,
  severityToPriority,
} from '../tests/experiments/infrastructure/paper-experiment-runner.js';
import { SCENARIOS } from '../tests/experiments/infrastructure/scenario-definitions.js';
import { GroundTruthCalculator } from '../tests/experiments/infrastructure/ground-truth-calculator.js';
import type {
  AgentEventType,
  PaperExperimentConfig,
  ScenarioDefinition,
  ScenarioType,
  TestEventDef,
} from '../tests/experiments/infrastructure/types.js';
import type { SystemEvent } from '../src/events/EventManager.js';
import type { CognitiveAgent } from '../src/agent/CognitiveAgent.js';
import type { DualTriggerACManager } from '../src/decision/DualTriggerACManager.js';
import type { ACNecessityAssessor, AgentContext } from '../src/decision/ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../src/events/SpatialTemporalClusterEngine.js';

import {
  buildCompletion,
  buildReasoning,
  buildRecord,
  mapDecisionToLabel,
  splitEventIds,
  type BinaryLabel,
  type DatasetRecord,
} from './dataset-dump-lib.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  scenarios: ScenarioType[];
  outDir: string;
  holdout?: ScenarioType;
  holdoutEventRate: number;
  seed: number;
}

const DEFAULT_OUT_DIR = resolve(
  import.meta.dirname ?? __dirname,
  '..',
  'tests',
  'experiment-results',
  'datasets',
);

function parseArgs(argv: string[]): CliOptions {
  const allScenarios = Object.keys(SCENARIOS) as ScenarioType[];
  const opts: CliOptions = {
    scenarios: [...allScenarios],
    outDir: DEFAULT_OUT_DIR,
    holdoutEventRate: 0,
    seed: 42,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--scenarios': {
        const v = next();
        opts.scenarios = v === 'all'
          ? [...allScenarios]
          : v.split(',').map(s => s.trim()) as ScenarioType[];
        break;
      }
      case '--out':
        opts.outDir = resolve(next());
        break;
      case '--holdout':
        opts.holdout = next() as ScenarioType;
        break;
      case '--holdout-event-rate':
        opts.holdoutEventRate = Number(next());
        break;
      case '--seed':
        opts.seed = Number(next());
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const s of opts.scenarios) {
    if (!allScenarios.includes(s)) {
      throw new Error(`Unknown scenario "${s}". Available: ${allScenarios.join(', ')}`);
    }
  }
  if (opts.holdout && !allScenarios.includes(opts.holdout)) {
    throw new Error(`Unknown holdout scenario "${opts.holdout}". Available: ${allScenarios.join(', ')}`);
  }
  if (!(opts.holdoutEventRate >= 0 && opts.holdoutEventRate < 1)) {
    throw new Error(`--holdout-event-rate must be in [0, 1), got ${opts.holdoutEventRate}`);
  }
  if (!Number.isFinite(opts.seed)) {
    throw new Error(`--seed must be a number, got ${opts.seed}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Production-path access helpers (structural casts for private members)
// ---------------------------------------------------------------------------

/** Minimal structural view of PaperExperimentRunner's private IterationSetup. */
interface DumpIterationSetup {
  scenario: ScenarioDefinition;
  agents: Map<string, CognitiveAgent>;
  simulationLoopHandle?: ReturnType<typeof setInterval>;
}

/**
 * Instantiate the experiment world EXACTLY like PaperExperimentRunner does for
 * the full-ac condition in multi-agent eval mode, without touching an LLM.
 */
async function setupWorld(scenarioId: ScenarioType): Promise<DumpIterationSetup> {
  // Stub LLM client: satisfies setupIteration (provider name + logging hooks).
  // chat()/quickChat() throw — this tool renders prompts, it never sends them.
  const stubLlmClient = {
    getProviderName: () => 'dataset-dump-stub',
    setLoggingCallback: () => {},
    setContextProvider: () => {},
    quickChat: async () => {
      throw new Error('LLM must not be called by the dataset dump');
    },
    chat: async () => {
      throw new Error('LLM must not be called by the dataset dump');
    },
  } as unknown as LLMClient;

  const config: PaperExperimentConfig = {
    id: `dataset-dump-${scenarioId}`,
    name: `Dataset dump (${scenarioId})`,
    rq: 'RQ1',
    scenario: scenarioId,
    condition: 'full-ac',
    iterations: 1,
    llmModel: 'dataset-dump-stub',
    timeoutMs: 0,
    multiAgentEval: true, // every agent gets the full dual-trigger config
    decisionOnly: true,   // no physics simulation loop, no AC execution
    llmClient: stubLlmClient,
  };

  const runner = new PaperExperimentRunner(config);
  const setup = await (
    runner as unknown as { setupIteration(iteration?: number): Promise<DumpIterationSetup> }
  ).setupIteration(0);
  return setup;
}

/**
 * Rebuild the SystemEvent EXACTLY as PaperExperimentRunner.injectEvent()
 * constructs it (targeted-delivery shape; the broadcast shape shares the same
 * payload/metadata literals). The event id is deterministic — it only feeds
 * clusterSummary.clusterId, which never appears in the prompt.
 */
function buildSystemEvent(event: TestEventDef, agentId: string): SystemEvent {
  const { parameter, value } = resolveEventParameter(event);

  // MUST stay identical to injectEvent()'s eventPayload literal.
  const eventPayload = {
    parameter,
    location: event.location,
    zoneId: event.zoneId,
    newValue: value,
    eventId: event.id,
    eventType: event.type,
    severity: event.severity,
    requiredCapabilities: event.requiredCapabilities ?? [],
    // Propagate target values to AC monitor for correct feedback control
    expectedTargetValue: event.expectedOutcome?.targetValue,
    expectedTolerance: event.expectedOutcome?.tolerance ?? 3,
  };

  return {
    id: `evt_dump_${agentId}_${event.id}`,
    type: EventType.ENVIRONMENT_PARAM_CHANGED,
    source: `experiment:${event.id}`,
    timestamp: new Date(0), // never reaches the prompt; fixed for determinism
    payload: eventPayload,
    priority: severityToPriority(event.severity),
    metadata: { eventId: event.id, eventType: event.type, requiredCapabilities: event.requiredCapabilities ?? [] },
  };
}

/** Render the production system + user prompt for one (agent, event) pair. */
async function renderPrompts(
  manager: DualTriggerACManager,
  event: TestEventDef,
  agentId: string,
): Promise<{ systemPrompt: string; userPrompt: string }> {
  // Public production method — builds the agent's Resource/Service-layer view.
  const agentContext: AgentContext = await manager.buildAgentContext();

  // Private production methods, reached structurally (same object the live
  // path uses — the manager's own ACNecessityAssessor with default config,
  // useStructuredOutput=true).
  const systemEvent = buildSystemEvent(event, agentId);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const clusterSummary: SpatialClusterSummary = (manager as any).eventToClusterSummary(systemEvent);
  const assessor = (manager as any).acNecessityAssessor as ACNecessityAssessor | undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (!assessor) {
    throw new Error(`Agent ${agentId} has no ACNecessityAssessor (Layer 2 disabled?)`);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const userPrompt: string = (assessor as any).buildPrompt(clusterSummary, agentContext);
  const systemPrompt: string = (assessor as any).getStructuredSystemPrompt();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface LabelCounts { collaborate: number; independent: number }
interface ScenarioStats {
  pairs: number;
  agents: number;
  events: number;
  typeCounts: Record<AgentEventType, number>;
  labelCounts: LabelCounts;
}

function newScenarioStats(agents: number, events: number): ScenarioStats {
  return {
    pairs: 0,
    agents,
    events,
    typeCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    labelCounts: { collaborate: 0, independent: 0 },
  };
}

function pct(part: number, total: number): string {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

function printStatsTable(stats: Map<string, ScenarioStats>): void {
  const header = ['scenario', 'pairs', 'agents', 'events', 'A', 'B', 'C', 'D', 'E', 'collab', 'indep', '%collab'];
  const rows: string[][] = [];
  const total = newScenarioStats(0, 0);

  for (const [name, s] of stats) {
    rows.push([
      name,
      String(s.pairs),
      String(s.agents),
      String(s.events),
      String(s.typeCounts.A),
      String(s.typeCounts.B),
      String(s.typeCounts.C),
      String(s.typeCounts.D),
      String(s.typeCounts.E),
      String(s.labelCounts.collaborate),
      String(s.labelCounts.independent),
      pct(s.labelCounts.collaborate, s.pairs),
    ]);
    total.pairs += s.pairs;
    total.agents += s.agents;
    total.events += s.events;
    for (const t of ['A', 'B', 'C', 'D', 'E'] as AgentEventType[]) total.typeCounts[t] += s.typeCounts[t];
    total.labelCounts.collaborate += s.labelCounts.collaborate;
    total.labelCounts.independent += s.labelCounts.independent;
  }
  rows.push([
    'TOTAL',
    String(total.pairs),
    String(total.agents),
    String(total.events),
    String(total.typeCounts.A),
    String(total.typeCounts.B),
    String(total.typeCounts.C),
    String(total.typeCounts.D),
    String(total.typeCounts.E),
    String(total.labelCounts.collaborate),
    String(total.labelCounts.independent),
    pct(total.labelCounts.collaborate, total.pairs),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padStart(widths[i])).join('  ');
  console.log('\n=== Dataset stats: scenario × interaction type + label balance ===');
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

function printFileStats(path: string, records: DatasetRecord[]): void {
  const collab = records.filter(r => r.meta.label === 'collaborate').length;
  console.log(
    `  ${path}\n    ${records.length} records — collaborate: ${collab} (${pct(collab, records.length)}), independent: ${records.length - collab} (${pct(records.length - collab, records.length)})`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[dump] scenarios=${opts.scenarios.join(',')} out=${opts.outDir} holdout=${opts.holdout ?? '-'} eventRate=${opts.holdoutEventRate} seed=${opts.seed}`);

  const trainRecords: DatasetRecord[] = [];
  const testRecords: DatasetRecord[] = [];
  const transferRecords: DatasetRecord[] = [];
  const stats = new Map<string, ScenarioStats>();

  // Deterministic per-scenario event split (same seed → same split). The split
  // is computed up-front so record emission order stays scenario/agent/event.
  const testEventIds = new Map<string, Set<string>>();
  for (const scenarioId of opts.scenarios) {
    if (scenarioId === opts.holdout) continue;
    const eventIds = SCENARIOS[scenarioId].events.map(e => e.id);
    const { test } = splitEventIds(eventIds, opts.holdoutEventRate, opts.seed);
    testEventIds.set(scenarioId, new Set(test));
  }

  for (const scenarioId of opts.scenarios) {
    const isTransfer = scenarioId === opts.holdout;
    const scenario = SCENARIOS[scenarioId];
    const setup = await setupWorld(scenarioId);
    const gtCalc = new GroundTruthCalculator(scenario);
    const scenarioStats = newScenarioStats(scenario.agents.length, scenario.events.length);

    for (const agentDef of scenario.agents) {
      const agent = setup.agents.get(agentDef.id);
      if (!agent) throw new Error(`Agent ${agentDef.id} missing from iteration setup`);
      const manager = agent.getDualTriggerACManager();
      if (!manager) throw new Error(`Agent ${agentDef.id} has no DualTriggerACManager`);

      for (const event of scenario.events) {
        const gt = gtCalc.computeForAgentEvent(agentDef.id, event.id);
        const label: BinaryLabel = mapDecisionToLabel(gt.correctDecision);
        const reasoning = buildReasoning(gt, event);
        const { systemPrompt, userPrompt } = await renderPrompts(manager, event, agentDef.id);

        const record = buildRecord(systemPrompt, userPrompt, buildCompletion(label, reasoning), {
          scenario: scenarioId,
          eventId: event.id,
          agentId: agentDef.id,
          type: gt.type,
          correctDecision: gt.correctDecision,
          label,
        });

        if (isTransfer) {
          transferRecords.push(record);
        } else if (testEventIds.get(scenarioId)?.has(event.id)) {
          testRecords.push(record);
        } else {
          trainRecords.push(record);
        }

        scenarioStats.pairs++;
        scenarioStats.typeCounts[gt.type]++;
        scenarioStats.labelCounts[label]++;
      }
    }

    stats.set(scenarioId, scenarioStats);
    console.log(`[dump] ${scenarioId}: ${scenarioStats.pairs} pairs rendered`);
    if (setup.simulationLoopHandle) clearInterval(setup.simulationLoopHandle);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const written: Array<[string, DatasetRecord[]]> = [];
  if (opts.holdout) {
    const path = resolve(opts.outDir, `transfer-${opts.holdout}.jsonl`);
    writeFileSync(path, transferRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
    written.push([path, transferRecords]);
  }
  if (trainRecords.length > 0 || opts.holdoutEventRate === 0) {
    const path = resolve(opts.outDir, 'train.jsonl');
    writeFileSync(path, trainRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
    written.push([path, trainRecords]);
  }
  if (opts.holdoutEventRate > 0) {
    const path = resolve(opts.outDir, 'test.jsonl');
    writeFileSync(path, testRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
    written.push([path, testRecords]);
  }

  printStatsTable(stats);
  console.log('\n=== Files written ===');
  for (const [path, records] of written) printFileStats(path, records);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[dump] FAILED:', err);
    process.exit(1);
  });
