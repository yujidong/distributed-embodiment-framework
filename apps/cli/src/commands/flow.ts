/**
 * `eaf flow` — user-orchestrated business flows ("when <trigger> → run
 * <plan>"): list / get / add (from a YAML/JSON file) / update / rm /
 * enable / disable / runs. The server statically validates every create and
 * trigger/plan edit; 422 FLOW_INVALID issues are relayed to stderr.
 *
 * P2F (living-worlds §11): `adopt` promotes a fork-VALIDATED flow into the
 * authoritative environment through the governance pipeline — an
 * adopt-config proposal, reported truthfully per T-048 (the json channel
 * flags it `proposal: true`, never masquerading as the flow object).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { boolFlag, numberFlag, parse, requirePositional, requireString, stringFlag } from '../args.js';
import { getWithIdPrefix, type Ctx, type IdRosterEntry } from '../ctx.js';
import type { EnvDetail, EnvProposal, Flow, FlowCapabilityDrift, FlowIssue, FlowRun } from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';
import { translateFlowNamePins, type UnresolvedPin } from '../world/flow-refs.js';

const USAGE_LIST = 'eaf flow list --env <id|name>';
const USAGE_GET = 'eaf flow get <flowId>';
const USAGE_ADD = 'eaf flow add --env <id|name> --file flow.yaml';
const USAGE_ADOPT = 'eaf flow adopt --env <id|name> --file flow.yaml --fork <forkId> [--eval-run <evalRunId>]';
const USAGE_UPDATE = 'eaf flow update <flowId> [--file flow.yaml] [--name <n>] [--enable|--disable]';
const USAGE_RM = 'eaf flow rm <flowId>';
const USAGE_RUNS = 'eaf flow runs <flowId> [--limit <n>]';

interface FlowFile {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: Record<string, unknown>;
  /** MI-D: the declared input-parameter surface (validated server-side). */
  inputs?: Array<Record<string, unknown>>;
  /** MI-C: the per-flow policy envelope (validated server-side). */
  policy?: Record<string, unknown>;
  /** MI-B: the agent-invocation opt-in (default off). */
  agentInvocable?: boolean;
  plan: Record<string, unknown>;
}

export async function flowCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listFlows(ctx, argv);
    case 'get':
      return getFlow(ctx, argv);
    case 'add':
      return addFlow(ctx, argv);
    case 'adopt':
      return adoptFlow(ctx, argv);
    case 'update':
      return updateFlow(ctx, argv);
    case 'rm':
      return removeFlow(ctx, argv);
    case 'enable':
      return setEnabled(ctx, argv, true);
    case 'disable':
      return setEnabled(ctx, argv, false);
    case 'runs':
      return listRuns(ctx, argv);
    default:
      throw usageError(
        `unknown flow subcommand "${sub ?? ''}" (expected list|get|add|adopt|update|rm|enable|disable|runs)`,
      );
  }
}

// ---------------------------------------------------------------------------
// list / get / runs
// ---------------------------------------------------------------------------

/** 顺带② (R13, u1-F2): the visible flow roster for short-prefix resolution. */
function flowRoster(ctx: Ctx): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        for (const flow of await flowsOf(ctx, env.id)) entries.push({ id: flow.id, name: flow.name });
      } catch {
        // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}

async function listFlows(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_LIST);
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const detail = await ctx.resolveEnv(requireString(flags, 'env', USAGE_LIST));
  const flows = await flowsOf(ctx, detail.id);
  if (ctx.json) {
    ctx.out.data(flows);
    return;
  }
  // The "last run" column needs one extra call per flow — human mode only;
  // JSON mode stays the pure flows array.
  const latest = new Map<string, FlowRun>();
  for (const flow of flows) {
    const run = await latestRun(ctx, flow.id);
    if (run) latest.set(flow.id, run);
  }
  ctx.out.table(
    flows.map(flow => {
      const run = latest.get(flow.id);
      return {
        id: flow.id,
        name: flow.name,
        enabled: flow.enabled,
        trigger: flow.trigger.kind,
        lastRun: run ? `${run.status} ${run.startedAt}` : '-',
        // T1 (R2): current declaration drift on the stored flow (absent = none).
        drift: driftSummary(flow.capabilityDrift),
      };
    }),
    ['id', 'name', 'enabled', 'trigger', 'lastRun', 'drift'],
  );
  // T66d (R6, u4-F7): success and drift can coexist on one row (执行真相=设备
  // 面, R4 ruling) — the footnote stops "success+drift 并列" reading as a
  // contradiction or a hidden failure.
  ctx.out.info('注：drift 为治理面标注（声明与绑定的漂移），不代表执行失败。');
}

async function getFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GET);
  const id = requirePositional(positionals, 'flowId', USAGE_GET);
  // 顺带② (R13, u1-F2, T88 leftover): flow get joins the prefix family —
  // `flow get <short-id>` used to 404 while agreement/service/device/agent
  // get resolved the same input.
  const flow = await getWithIdPrefix(ctx, {
    kind: 'flow',
    ref: id,
    get: full => ctx.openClient().get(`/api/flows/${encodeURIComponent(full)}`) as Promise<Flow>,
    roster: flowRoster(ctx),
    listHint: 'eaf flow list --env <id|name>',
  });
  if (ctx.json) {
    ctx.out.data(flow);
    return;
  }
  ctx.out.line(`flow ${flow.id} "${flow.name}" (${flow.enabled ? 'enabled' : 'disabled'}) env=${flow.envId}`);
  if (flow.description) ctx.out.line(`  ${flow.description}`);
  ctx.out.line(`  trigger: ${JSON.stringify(flow.trigger)}`);
  if (flow.policy) ctx.out.line(`  policy:  ${JSON.stringify(flow.policy)}`);
  if (flow.agentInvocable) ctx.out.line('  agent-invocable: true (agents in the author scope may name this flow in decisions)');
  ctx.out.line(`  plan:    ${JSON.stringify(flow.plan)}`);
  // T119 (C1, G5) R102 fix: the GET payload carries `validationWarnings`
  // (the T78 ghost-trigger annotation rides every read face server-side),
  // but the human detail face rendered only the drift line — a flow that
  // reads as silently healthy while it can never fire, exactly the u4-P1-3
  // complaint, one layer up. Same channel `flow add`/`flow update` use.
  printValidationWarnings(ctx, flow);
  // T1 (R2): current declaration drift on the stored flow — same annotation
  // the JSON face carries, so human is never thinner than --json (R102).
  // T72 (R8): payload explanation belongs on the human stdout stream.
  const drift = driftSummary(flow.capabilityDrift);
  if (drift !== '-') ctx.out.explain(`  drift: ${drift}`);
}

/**
 * T107 (R17, u3-N3): the flow runs HUMAN row as a pure function — the --json
 * face carries `simulationId` and the human table must never be thinner
 * (R102). Env-level runs mix the authoritative world session with members'
 * private sims in one table; without the sim column a private-sim run reads
 * as "the world did this again" (u3 misread exactly that during a fire-drill
 * audit).
 *
 * The label is the sim id's DISTINCTING tail: every sim of one env shares the
 * `sim-<envId(36)>-` prefix, so the head is noise — `world-session` labels
 * the platform's authoritative world, anything else is the creator's short
 * suffix (e.g. `mu6o9dpx-1`). Other id shapes fall back to the tail 12.
 */
export function flowRunRow(run: FlowRun): { startedAt: string; trigger: string; triggerAt: string; sim: string; status: string; summary: string } {
  let sim = '-';
  if (run.simulationId !== null) {
    sim =
      run.simulationId.length > 41 && run.simulationId[40] === '-'
        ? run.simulationId.slice(41)
        : run.simulationId.slice(-12);
  }
  return {
    startedAt: run.startedAt,
    trigger: run.triggerKind,
    // UX-14 (R102): the --json face carries triggerSimTimeSec, so the table
    // shows the trigger's sim second; legacy/unknown reads 「未记录」, never
    // a bare null.
    triggerAt: run.triggerSimTimeSec !== null && run.triggerSimTimeSec !== undefined
      ? `${run.triggerSimTimeSec}s`
      : '未记录',
    sim,
    // T1 (R2): a drifted run keeps its status but is NEVER silent — the
    // degraded note rides the status cell so the ledger cannot be misread
    // as "authorized" (T36: the note also states the execution truth).
    status: `${run.status}${driftNote(run)}`,
    summary: run.summary,
  };
}

async function listRuns(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { limit: { type: 'string' } }, USAGE_RUNS);
  const id = requirePositional(positionals, 'flowId', USAGE_RUNS);
  const limit = numberFlag(flags, 'limit', USAGE_RUNS);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw usageError(`--limit must be an integer between 1 and 200\nusage: ${USAGE_RUNS}`);
  }
  // T110 (R18, u2-F-18-U2-1): runs joins the T88 prefix family — the roster
  // habit (`flow get <8-char-prefix>` resolved one second earlier) used to
  // die here with a bare FLOW_NOT_FOUND that read as "the flow vanished".
  // Same resolver, same teaching faces as every other family member.
  const runs = await getWithIdPrefix(ctx, {
    kind: 'flow',
    ref: id,
    get: full => runsOf(ctx, full, limit),
    roster: flowRoster(ctx),
    listHint: 'eaf flow list --env <id|name>',
  });
  if (ctx.json) {
    ctx.out.data(runs);
    return;
  }
  ctx.out.table(
    runs.map(flowRunRow),
    ['startedAt', 'trigger', 'triggerAt', 'sim', 'status', 'summary'],
  );
  // T107: the column's 口径 — world-session is the authoritative world, the
  // rest are members' sims (the audit-误读 the column exists to prevent).
  if (runs.some(run => run.simulationId !== null && flowRunRow(run).sim !== 'world-session' && run.simulationId.length > 0)) {
    ctx.out.info('注：sim 列 = 执行所在仿真（world-session = 平台权威世界会话；其余为成员仿真的短标识，--json 有完整 id）。');
  }
}

// ---------------------------------------------------------------------------
// add / adopt / update / rm / enable / disable
// ---------------------------------------------------------------------------

async function addFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' }, file: { type: 'string' } }, USAGE_ADD);
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_ADD}`);
  }
  const envRef = requireString(flags, 'env', USAGE_ADD);
  const file = requireString(flags, 'file', USAGE_ADD);
  const doc = parseFlowFile(resolve(ctx.io.cwd, file));
  const detail = await ctx.resolveEnv(envRef);
  // R1 (B1-12 / P-11): `env export` writes flow pins as NAMES
  // (deviceName/assigneeAgentName); translate them to the ids the server
  // schema accepts — the export document feeds `flow add` directly.
  const pins = translateFlowDoc(doc, detail);
  const flow = (await flowRequest(() =>
    ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/flows`, {
      name: doc.name,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
      ...(doc.enabled !== undefined ? { enabled: doc.enabled } : {}),
      trigger: pins.trigger,
      // MI-D: the inputs surface rides the file (absent = no surface).
      ...(doc.inputs !== undefined ? { inputs: doc.inputs } : {}),
      // MI-C: the policy envelope rides the file (absent = no envelope).
      ...(doc.policy !== undefined ? { policy: doc.policy } : {}),
      // MI-B: the agent-invocation opt-in rides the file (absent = off).
      ...(doc.agentInvocable !== undefined ? { agentInvocable: doc.agentInvocable } : {}),
      plan: pins.plan,
    }),
  )) as Flow;
  if (ctx.json) {
    ctx.out.data(flow);
  } else {
    ctx.out.line(
      `flow ${flow.id} "${flow.name}" added (${flow.enabled ? 'enabled' : 'disabled'}, ` +
      `trigger=${flow.trigger.kind}, ${flow.plan.nodes.length} nodes)`,
    );
    printValidationWarnings(ctx, flow);
  }
}

/**
 * P2F (living-worlds §11) 提案式晋升: promote a fork-VALIDATED flow into the
 * authoritative environment — one adopt-config proposal carrying the flow
 * definition + the source fork's lineage (+ optional eval-run evidence).
 * T-048 honesty: the answer is the PROPOSAL, never a fake flow object.
 */
async function adoptFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      env: { type: 'string' },
      file: { type: 'string' },
      fork: { type: 'string' },
      'eval-run': { type: 'string' },
    },
    USAGE_ADOPT,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_ADOPT}`);
  }
  const envRef = requireString(flags, 'env', USAGE_ADOPT);
  const file = requireString(flags, 'file', USAGE_ADOPT);
  const forkId = requireString(flags, 'fork', USAGE_ADOPT);
  const evalRunId = stringFlag(flags, 'eval-run');
  const doc = parseFlowFile(resolve(ctx.io.cwd, file));
  const detail = await ctx.resolveEnv(envRef);
  // R1 (B1-12): the adopt file may be an export artifact — same vocabulary
  // translation as `flow add`.
  const pins = translateFlowDoc(doc, detail);

  const proposal = (await flowRequest(() =>
    ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/proposals`, {
      kind: 'adopt-config',
      payload: {
        sourceFork: { forkId, envId: detail.id },
        ...(evalRunId !== undefined ? { evidence: { evalRunId } } : {}),
        artifacts: [
          {
            type: 'flow-definition',
            definition: {
              name: doc.name,
              ...(doc.description !== undefined ? { description: doc.description } : {}),
              ...(doc.enabled !== undefined ? { enabled: doc.enabled } : {}),
              trigger: pins.trigger,
              ...(doc.inputs !== undefined ? { inputs: doc.inputs } : {}),
              ...(doc.policy !== undefined ? { policy: doc.policy } : {}),
              ...(doc.agentInvocable !== undefined ? { agentInvocable: doc.agentInvocable } : {}),
              plan: pins.plan,
            },
          },
        ],
      },
    }),
  )) as EnvProposal;

  // T-048: report the governed truth — json flags `proposal: true`, human
  // mode names the id + funnel state; a rule-check rejection teaches.
  if (ctx.json) {
    ctx.out.data({ ...proposal, proposal: true });
    return;
  }
  if (proposal.status === 'rejected') {
    throw new CliError(
      `proposal ${proposal.id} was rejected by the rule check`,
      EXIT.USAGE,
      proposal.ruleCheck?.issues,
    );
  }
  if (proposal.status === 'applied') {
    ctx.out.line(
      `proposal ${proposal.id} applied — flow "${doc.name}" adopted into env ${detail.id}` +
      (proposal.createdIds?.flows ? ` (${proposal.createdIds.flows.join(', ')})` : ''),
    );
    return;
  }
  ctx.out.line(
    `proposal ${proposal.id} submitted (adopt-config → ${proposal.status}) — ` +
    `flow "${doc.name}" enters ${detail.id} when the pipeline approves it`,
  );
}

async function updateFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { file: { type: 'string' }, name: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' } },
    USAGE_UPDATE,
  );
  const id = await resolveFlowRef(ctx, requirePositional(positionals, 'flowId', USAGE_UPDATE)); // T124 prefix family
  const body: Record<string, unknown> = {};
  // A --file supplies the base document; the scalar flags override it.
  const file = stringFlag(flags, 'file');
  if (file !== undefined) {
    const doc = parseFlowFile(resolve(ctx.io.cwd, file));
    // R1 (B1-12): same export-vocabulary translation as `flow add` — the
    // flow's own env is the resolution scope (fetched after the id parse).
    const existing = (await ctx.openClient().get(`/api/flows/${encodeURIComponent(id)}`)) as Flow;
    const detail = (await ctx.authedClient().get(`/api/environments/${encodeURIComponent(existing.envId)}`)) as EnvDetail;
    const pins = translateFlowDoc(doc, detail);
    body.name = doc.name;
    if (doc.description !== undefined) body.description = doc.description;
    if (doc.enabled !== undefined) body.enabled = doc.enabled;
    body.trigger = pins.trigger;
    // MI-D: a file with an explicit `inputs:` array replaces the surface
    // (an empty array = the zero-arg signature); files without the key
    // leave it untouched (the flow may still be published on it).
    if (doc.inputs !== undefined) body.inputs = doc.inputs;
    // MI-C: a file with an explicit `policy:` object replaces the envelope;
    // files without the key leave it untouched (same semantics as inputs).
    if (doc.policy !== undefined) body.policy = doc.policy;
    // MI-B: a file with an explicit `agentInvocable:` boolean toggles the
    // agent-invocation opt-in; files without the key leave it untouched.
    if (doc.agentInvocable !== undefined) body.agentInvocable = doc.agentInvocable;
    body.plan = pins.plan;
  }
  const name = stringFlag(flags, 'name');
  if (name !== undefined) body.name = name;
  if (boolFlag(flags, 'enable') && boolFlag(flags, 'disable')) {
    throw usageError(`--enable and --disable are mutually exclusive\nusage: ${USAGE_UPDATE}`);
  }
  if (boolFlag(flags, 'enable')) body.enabled = true;
  if (boolFlag(flags, 'disable')) body.enabled = false;
  if (Object.keys(body).length === 0) {
    throw usageError(`nothing to update — pass --file, --name, --enable or --disable\nusage: ${USAGE_UPDATE}`);
  }
  const flow = (await flowRequest(() =>
    ctx.authedClient().patch(`/api/flows/${encodeURIComponent(id)}`, body),
  )) as Flow;
  if (ctx.json) {
    ctx.out.data(flow);
  } else {
    ctx.out.line(`flow ${flow.id} "${flow.name}" updated (${flow.enabled ? 'enabled' : 'disabled'})`);
    printValidationWarnings(ctx, flow);
  }
}

async function removeFlow(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RM);
  const id = requirePositional(positionals, 'flowId', USAGE_RM);
  // T124: the rm face joins the prefix family (probe-GET + roster resolve).
  const fullId = await resolveFlowRef(ctx, id);
  await ctx.authedClient().delete(`/api/flows/${encodeURIComponent(fullId)}`);
  if (ctx.json) ctx.out.data({ deleted: fullId });
  else ctx.out.line(`deleted flow ${fullId}`);
}

/**
 * T124: resolve a flow ref to its FULL id — probe-GETs the ref (a flow GET
 * is the family's read face); a 404 engages the visible-roster resolver.
 */
async function resolveFlowRef(ctx: Ctx, ref: string): Promise<string> {
  return getWithIdPrefix(ctx, {
    kind: 'flow',
    ref,
    get: async candidate => {
      await ctx.openClient().get(`/api/flows/${encodeURIComponent(candidate)}`);
      return candidate;
    },
    roster: flowRoster(ctx),
    listHint: 'eaf flow list --env <id|name>',
  });
}

async function setEnabled(ctx: Ctx, argv: string[], enabled: boolean): Promise<void> {
  const usage = `eaf flow ${enabled ? 'enable' : 'disable'} <flowId>`;
  const { positionals } = parse(argv, {}, usage);
  const id = requirePositional(positionals, 'flowId', usage);
  const fullId = await resolveFlowRef(ctx, id); // T124 prefix family
  const flow = (await flowRequest(() =>
    ctx.authedClient().patch(`/api/flows/${encodeURIComponent(fullId)}`, { enabled }),
  )) as Flow;
  if (ctx.json) ctx.out.data(flow);
  else {
    ctx.out.line(`flow ${flow.id} "${flow.name}" ${enabled ? 'enabled' : 'disabled'}`);
    // R102: re-ENABLING re-validates server-side (Fix-44f) and the PATCH
    // payload now carries `validationWarnings` (e.g. the UX-16 multi-writer
    // contention warning) — human must not be thinner than --json.
    printValidationWarnings(ctx, flow);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flowsOf(ctx: Ctx, envId: string): Promise<Flow[]> {
  const body = (await ctx.openClient().get(`/api/environments/${encodeURIComponent(envId)}/flows`)) as {
    flows: Flow[];
  };
  return body.flows;
}

async function runsOf(ctx: Ctx, flowId: string, limit?: number): Promise<FlowRun[]> {
  const query = limit !== undefined ? `?limit=${limit}` : '';
  const body = (await ctx.openClient().get(`/api/flows/${encodeURIComponent(flowId)}/runs${query}`)) as {
    runs: FlowRun[];
  };
  return body.runs;
}

async function latestRun(ctx: Ctx, flowId: string): Promise<FlowRun | undefined> {
  try {
    return (await runsOf(ctx, flowId, 1))[0];
  } catch {
    return undefined;
  }
}

/**
 * Run a mutating flow request; on a 422 FLOW_INVALID rethrow with the core
 * PlanIssue list ({level, nodeId?, message} objects) formatted as readable
 * detail lines — the client's generic issue passthrough would print
 * "[object Object]".
 */
async function flowRequest(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CliError && Array.isArray(error.issues)) {
      // R1 (B1-12 / P-11): identical validation lines printed twice read as
      // a glitch — dedupe while keeping order and multiplicity >= 1.
      const seen = new Set<string>();
      const issues = error.issues.map(formatIssue).filter(issue => {
        if (seen.has(issue)) return false;
        seen.add(issue);
        return true;
      });
      // T7 (R2 u2-F1): the cross-tenant authorship refusal is the env-export
      // slice shape — name the two legitimate routes right where it bites
      // (the world-document import lane for cross-environment rebuilding;
      // agreement invoke / flow service nodes for orchestrating foreign
      // assets in-place). Teaching only — the FLOW_INVALID verdict stands.
      if (issues.some(issue => issue.includes('another tenant') || issue.includes("flow author's own"))) {
        issues.push(
          'This definition looks like an env export slice. A world document rebuilds a NEW environment ' +
            'through the import lane (eaf apply -f world.yaml — flows re-pin by capability there); to orchestrate ' +
            "another user's assets in THIS environment, use an agreement invocation or a flow service node instead.",
        );
        issues.push(
          '这份定义像是 env export 的切片——世界文档（跨环境重建）请走环境级导入道' +
            '（eaf apply -f world.yaml，能力在导入侧重钉）；要在本环境编排他人资产，' +
            '请走 agreement invoke / flow service 节点。',
        );
      }
      throw new CliError(error.message, error.exitCode, issues);
    }
    throw error;
  }
}

/**
 * R1 (B1-12 / P-11): translate the EXPORT vocabulary (deviceName /
 * assigneeAgentName pins) into the server ids, using the target
 * environment's current devices/agents. A name that cannot resolve is a
 * teaching ERROR naming the exact string (the server schema would only say
 * "additional properties"); ids already in the file pass through
 * untouched, so hand-written id-style files behave exactly as before.
 */
function translateFlowDoc(
  doc: FlowFile,
  detail: EnvDetail,
): { trigger: Record<string, unknown>; plan: Record<string, unknown> } {
  const deviceNameToId = new Map(detail.devices.map(device => [device.name, device.id]));
  const agentNameToId = new Map(detail.agents.map(agent => [agent.name, agent.id]));
  const trigger = translateFlowNamePins(doc.trigger, deviceNameToId, agentNameToId);
  const plan = translateFlowNamePins(doc.plan, deviceNameToId, agentNameToId);
  const unresolved: UnresolvedPin[] = [...trigger.unresolved, ...plan.unresolved];
  if (unresolved.length > 0) {
    const named = unresolved.map(pin => `${pin.field} "${pin.name}"`);
    throw new CliError(
      `flow file references unknown names in environment "${detail.name}" (${detail.id}) — ` +
        `no device/agent carries ${named.join(', ')}`,
      EXIT.USAGE,
      [
        ...named.map(name => `unresolved: ${name}`),
        'Check the exact spelling with `eaf device list --env <id|name>` / `eaf agent list --env <id|name>`, ' +
          'or pin by id (deviceId / assigneeAgentId) instead.',
      ],
    );
  }
  return {
    trigger: trigger.translated as Record<string, unknown>,
    plan: plan.translated as Record<string, unknown>,
  };
}

function formatIssue(issue: unknown): string {
  if (typeof issue === 'object' && issue !== null) {
    const { level, nodeId, message } = issue as Partial<FlowIssue>;
    const where = nodeId !== undefined ? ` [${nodeId}]` : '';
    return `${level ?? 'error'}${where}: ${message ?? JSON.stringify(issue)}`;
  }
  return String(issue);
}

/**
 * T1 (R2): the human-mode degraded note for a run's capability drift.
 * T36 (R3 u2-F-06/u1-F10) wording calibration: "not declared by" (no
 * temporal claim — the capability may NEVER have been declared), and the
 * degraded note carries the EXECUTION truth in the same breath
 * (`12/12 nodes executed via bound devices`) so a success line with drift
 * cannot be misread as degraded execution — the run DID execute; only the
 * declaration face drifted. Empty string on clean runs.
 */
function driftNote(run: Pick<FlowRun, 'capabilityDrift' | 'nodeResults'>): string {
  const drift = run.capabilityDrift;
  if (!drift || drift.length === 0) return '';
  const items = drift.map(
    d => `capability '${d.capability}' not declared by '${d.assigneeAgentId}'`,
  );
  const results = Object.values(run.nodeResults ?? {}) as Array<{ status?: string }>;
  const executed = results.filter(result => result.status === 'succeeded').length;
  const executionTruth = results.length > 0
    ? `; ${executed}/${results.length} nodes executed via bound devices`
    : '';
  return ` (degraded: ${items.join('; ')}${executionTruth})`;
}

/** T1 (R2): compact drift summary for flow list/get cells; '-' when clean. */
function driftSummary(drift: FlowCapabilityDrift[] | undefined): string {
  if (!drift || drift.length === 0) return '-';
  // T66c (R6, u1-F9): the LIST cell summarizes — 24 drifted segments blew the
  // table apart. The count + pointer keeps the row one line; `flow get`
  // renders the full per-node detail (which the list never could).
  if (drift.length > 3) {
    return `${drift.length} 处（详见 flow get）`;
  }
  return drift
    .map(d => `${d.nodeId}: '${d.capability}' not declared by '${d.assigneeAgentId}'`)
    .join('; ');
}

/**
 * T1 (R2): surface non-blocking authoring warnings (the declaration-drift
 * warning among them) in human mode — the JSON face carries
 * `validationWarnings` on the flow object, so human must not be thinner
 * (R102 output discipline).
 */
function printValidationWarnings(ctx: Ctx, flow: Flow): void {
  for (const warning of flow.validationWarnings ?? []) {
    // T72 (R8): these explain the flow payload — human stdout (stderr under --json).
    ctx.out.explain(`warning: ${warning}`);
  }
}

function parseFlowFile(path: string): FlowFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read flow file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw usageError(`cannot parse flow file "${path}": ${message}`);
  }
  // T7 (R2 u2-F3): an env-export slice often lands on disk as a LIST (the
  // document's `flows:` section copied verbatim). A ONE-element list is
  // unambiguous — take the single flow; a MULTI-element list stays an error,
  // but the error now shows the object skeleton to slice toward instead of
  // an opaque "must contain an object".
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'object' && raw[0] !== null && !Array.isArray(raw[0])) {
      raw = raw[0];
    } else {
      throw usageError(
        `flow file "${path}" is a list of ${raw.length} flow definitions — flow add takes ONE flow object`,
        [
          'Slice out a single element, shaped like:',
          '{ name: ..., description?: ..., enabled?: ..., trigger: {kind: event|condition|schedule, ...}, plan: {goal, nodes: [...]} }',
          '(yaml: `- name: ...` under the list, or delete the outer list and keep one flow\u2019s mapping)',
        ],
      );
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw usageError(`flow file "${path}" must contain an object {name, description?, enabled?, trigger, plan}`);
  }
  const doc = raw as Partial<FlowFile>;
  const issues: string[] = [];
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) issues.push('name: required non-empty string');
  if (doc.description !== undefined && typeof doc.description !== 'string') issues.push('description: must be a string');
  if (doc.enabled !== undefined && typeof doc.enabled !== 'boolean') issues.push('enabled: must be a boolean');
  if (doc.inputs !== undefined && (!Array.isArray(doc.inputs) || doc.inputs.some(i => typeof i !== 'object' || i === null))) {
    issues.push('inputs: must be an array of {name, type, required?, default?, min?, max?, enum?} objects');
  }
  if (doc.policy !== undefined && (typeof doc.policy !== 'object' || Array.isArray(doc.policy))) {
    issues.push('policy: must be an object {maxDelegationsPerRun?, minConfidenceToActuate?, onBudgetExhausted?, escalate?}');
  }
  if (doc.agentInvocable !== undefined && typeof doc.agentInvocable !== 'boolean') {
    issues.push('agentInvocable: must be a boolean (MI-B agent-invocation opt-in)');
  }
  if (typeof doc.trigger !== 'object' || doc.trigger === null || Array.isArray(doc.trigger)) {
    issues.push('trigger: required object ({kind: event|condition|schedule, ...})');
  }
  if (typeof doc.plan !== 'object' || doc.plan === null || Array.isArray(doc.plan)) {
    issues.push('plan: required object ({goal, nodes: [...]})');
  }
  if (issues.length > 0) {
    throw usageError(`invalid flow file "${path}"`, issues);
  }
  return doc as FlowFile;
}
