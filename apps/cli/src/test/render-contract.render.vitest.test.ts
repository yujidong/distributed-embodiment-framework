/**
 * T22 (R3) — the RENDER CONTRACT guard. Batch 3 produced two self-inflicted
 * regressions with one root cause: a server payload shape / render face
 * changed and NO human-render test existed (T6's restricted view crashed
 * `agreement get`; T11's unit headers blanked every zones reading). R102
 * established "human ≥ json" as output discipline; THIS file establishes the
 * engineering discipline that backs it:
 *
 *   Every human render face registers here with (a) the pure render function
 *   it is rendered by and (b) one fixture per payload SHAPE BRANCH the face
 *   must survive. The walk fails on any face whose fixtures throw, render a
 *   forbidden token, or lose an anchor. A face without fixtures cannot
 *   register (the walk rejects empty fixture lists).
 *
 * Adding a payload field / shape branch (a `view:'restricted'`, a backing
 * block, a new unit column)? Register the face and add a fixture — the
 * compiler guards the fields, this file guards the rendering.
 */

import { describe, expect, test } from 'vitest';

import {
  agreementListRow,
  readHumanLines,
  renderAgreementGetLines,
  terminatedDeliveryNote,
  usageTableRow,
  type AgreementGetDetail,
} from '../commands/agreement.js';
import { formatWatchValue, humanZoneTable, judgeZoneChange, renderSnapshotHumanLines, renderStatusHumanLines, renderEvalReportHuman, renderSimActionLine } from '../commands/sim.js';
import { renderAskLines, renderWhatIf } from '../commands/agent.js';
import { flowRunRow } from '../commands/flow.js';
import { renderServiceGetLines, reputationFace, serviceListRow } from '../commands/service.js';
import { renderOccupantScheduleLines, type OccupantSchedulePatchResult } from '../commands/env.js';
import { renderScenarioValidation } from '../commands/scenario.js';

interface RenderFace {
  /** Which user-visible face this is (the 对账 key). */
  face: string;
  /** The payload shapes (branches) the face must survive — one fixture each. */
  branches: Array<{
    shape: string;
    /** covering test file (documentation — where the deep assertions live). */
    coveredBy: string;
    fixture: () => unknown;
    render: (payload: unknown) => unknown;
    /** Tokens that must NEVER appear on this branch (crash/leak guards). */
    forbidden?: string[];
    /** Tokens that MUST appear (the face's anchors). */
    anchored?: string[];
  }>;
}

const FACES: RenderFace[] = [
  {
    face: 'agreement get (human)',
    branches: [
      {
        shape: "full view — active with owner parties (T21 full-view regression guard)",
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-1', envId: 'e', serviceId: 'svc', service: { id: 'svc', name: 'S', semanticType: 't' },
          backingDeviceId: null, callableActions: null,
          consumerAgentId: 'a1', consumer: { id: 'u1', displayName: 'Consumer' },
          providerAgentId: 'a2', provider: { id: 'u2', displayName: 'Provider' },
          terms: {}, counteredTerms: null, effectiveTerms: {}, termsEnforced: false,
          status: 'active', createdAt: 'c', updatedAt: 'u',
        }),
        render: payload => renderAgreementGetLines(payload as AgreementGetDetail),
        anchored: ['Consumer', 'Provider', 'effective terms'],
      },
      {
        shape: "restricted terminated view (T6/T21 — the crash regression)",
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-r', envId: 'e', status: 'terminated', source: 'explicit', collaborationId: null,
          service: { id: 'svc', name: 'S' },
          consumerAgentId: 'a1', consumerAgentName: 'A1', providerAgentId: 'a2', providerAgentName: null,
          outcome: 'cancelled', terminatedAt: 't', view: 'restricted',
        }),
        render: payload => renderAgreementGetLines(payload as AgreementGetDetail),
        forbidden: ['effective terms', 'displayName'],
        anchored: ['restricted view', 'A1'],
      },
      {
        shape: "full view with declaration drift (T40a — shared ⚠ wording with service get)",
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-drift', envId: 'e', serviceId: 'svc', service: { id: 'svc', name: 'S', semanticType: 'turn-on' },
          backingDeviceId: null, callableActions: null,
          consumerAgentId: 'a1', consumer: { id: 'u1', displayName: 'Consumer' },
          providerAgentId: 'a2', provider: { id: 'u2', displayName: 'Provider' },
          terms: {}, counteredTerms: null, effectiveTerms: {}, termsEnforced: false,
          status: 'active', createdAt: 'c', updatedAt: 'u',
          declaredByProvider: false,
          declarationDrift: { capability: 'turn-on', note: 'provider agent does not declare' },
        }),
        render: payload => renderAgreementGetLines(payload as AgreementGetDetail),
        anchored: ['⚠ provider 未声明', "'turn-on'", 'declaredByProvider:false'],
      },
      {
        shape: "full view + delivery companion on the outcome line (T40h — collaboration-only success)",
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-ac', envId: 'e', serviceId: 'svc', service: { id: 'svc', name: 'S', semanticType: 't' },
          backingDeviceId: null, callableActions: null,
          consumerAgentId: 'a1', consumer: { id: 'u1', displayName: 'Consumer' },
          providerAgentId: 'a2', provider: { id: 'u2', displayName: 'Provider' },
          terms: {}, counteredTerms: null, effectiveTerms: {}, termsEnforced: false,
          status: 'terminated', outcome: 'success', terminatedAt: 't', createdAt: 'c', updatedAt: 'u',
        }),
        render: payload =>
          renderAgreementGetLines(
            payload as AgreementGetDetail,
            terminatedDeliveryNote(payload as { status: string }, [{ kind: 'ac' }]),
          ),
        anchored: ['outcome: success', '（协作完成、未见服务调用）'],
      },
    ],
  },
  {
    face: 'agreement list row / usage row (T40c/T40e + T79: drift marker)',
    branches: [
      {
        shape: 'terminated row shows the outcome 口径; live row shows —',
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-t', envId: 'e', serviceId: 'svc', status: 'terminated', outcome: 'completed',
          service: { id: 'svc', name: 'S' },
          consumerAgentId: 'a1', consumerAgentName: 'A1', providerAgentId: 'a2', providerAgentName: 'P2',
          terminatedAt: 't', view: 'restricted',
        }),
        render: payload => agreementListRow(payload as Parameters<typeof agreementListRow>[0]),
        anchored: ['completed'],
      },
      {
        shape: 'T79 walker catch: a drifted service (row-level declaredByProvider:false) marks the cell with the shared ⚠',
        coveredBy: 'render-walk (agreement list face over the real server)',
        fixture: () => ({
          id: 'agt-d', envId: 'e', serviceId: 'svc', status: 'active',
          declaredByProvider: false,
          declarationDrift: { capability: 'hvac-control' },
          service: { id: 'svc', name: 'Hvac Control', semanticType: 'hvac-control' },
          consumer: { displayName: 'Consumer Owner' },
          provider: { displayName: 'Provider Owner' },
          consumerAgentId: 'a1', consumerAgentName: 'A1', providerAgentId: 'a2', providerAgentName: 'P2',
          updatedAt: 't',
        }),
        render: payload => agreementListRow(payload as Parameters<typeof agreementListRow>[0]),
        anchored: ['⚠'],
        forbidden: ['declaredByProvider'],
      },
      {
        shape: 'usage row: legacy failure without reason renders （未记录）, success stays bare',
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'u1', agreementId: 'a', kind: 'invoke', action: 'turn-on', quantity: 1, unit: 'call',
          outcome: 'failure', effectRef: null, startedAt: 's', endedAt: 'e',
        }),
        render: payload => usageTableRow(payload as Parameters<typeof usageTableRow>[0]),
        anchored: ['（未记录）'],
      },
      {
        shape: 'usage row: FEAT-08/UX-04 attribution columns (origin/source/simulationId) render verbatim',
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'u2', agreementId: 'a', kind: 'invoke', action: 'turn-on', quantity: 1, unit: 'action',
          outcome: 'success', origin: 'derived', source: 'autoTrigger', simulationId: 'sim-world-1',
          effectRef: null, startedAt: 's', endedAt: 'e',
        }),
        render: payload => usageTableRow(payload as Parameters<typeof usageTableRow>[0]),
        anchored: ['derived', 'autoTrigger', 'sim-world-1'],
        forbidden: ['（未记录）'],
      },
      {
        shape: 'UX-16: a contending list row carries the ⚠×N marker; non-contending stays bare',
        coveredBy: 'agreement-get.render.vitest.test.ts',
        fixture: () => ({
          id: 'agt-c', envId: 'e', serviceId: 'svc', status: 'active',
          contentionSummary: { count: 2, pairs: 3 },
          service: { id: 'svc', name: 'Hvac Control', semanticType: 'hvac-control' },
          consumer: { displayName: 'Consumer Owner' },
          provider: { displayName: 'Provider Owner' },
          consumerAgentId: 'a1', consumerAgentName: 'A1', providerAgentId: 'a2', providerAgentName: 'P2',
          updatedAt: 't',
        }),
        render: payload => agreementListRow(payload as Parameters<typeof agreementListRow>[0]),
        anchored: ['⚠×2'],
      },
    ],
  },
  {
    face: 'sim action — start/resume speed echo (DOC-02: the response itself says what speed MEANS)',
    branches: [
      {
        shape: 'pace echo present — speed sim-s/tick + nominal wall multiplier on the human line (R102 parity)',
        coveredBy: 'sim-action.render.vitest.test.ts',
        fixture: () => ({ id: 'sim-1', state: 'running', speed: 5, nominalSpeedPerSec: 500 }),
        render: payload => renderSimActionLine(payload as Parameters<typeof renderSimActionLine>[0], 'start'),
        anchored: ['running sim-1 (start)', 'speed=5 sim-s/tick', '≈ 500 sim-s/wall-s', 'nominal ×500 wall'],
      },
      {
        shape: 'no pace face (pause/stop/lazy) — bare action line, no dangling separator',
        coveredBy: 'sim-action.render.vitest.test.ts',
        fixture: () => ({ id: 'sim-1', state: 'paused' }),
        render: payload => renderSimActionLine(payload as Parameters<typeof renderSimActionLine>[0], 'pause'),
        anchored: ['paused sim-1 (pause)'],
        forbidden: ['sim-s', '—'],
      },
    ],
  },
  {
    face: 'sim status — speed calibers (T3/T32 → T83: window average only on the human face)',
    branches: [
      {
        shape: 'window + instant both present — the window figure is THE schedule face, the instant figure is gone (T83)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ state: 'running', simTimeSec: 1, tickCount: 1, speed: 60, scenarioName: 'S', effectiveSpeedPerSec: 100, effectiveSpeedWindowPerSec: 28, effectiveSpeedWindowSec: 60 }),
        render: payload => renderStatusHumanLines(payload as Parameters<typeof renderStatusHumanLines>[0]),
        anchored: ['28.0 sim-s/s (60s avg — schedule with this one', 'nominal speed=60'],
        forbidden: ['(instant)', '100'],
      },
      {
        shape: 'no window figure — honest dash naming the --json instant figure as non-reproducible (T83, u4-P2-4)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ state: 'running', simTimeSec: 1, tickCount: 1, speed: 60, scenarioName: 'S', effectiveSpeedPerSec: 247.93 }),
        render: payload => renderStatusHumanLines(payload as Parameters<typeof renderStatusHumanLines>[0]),
        anchored: ['effectiveSpeed: — (no window average this tick', 'non-reproducible'],
        forbidden: ['247.93', '(instant)', 'effectiveSpeed≈'],
      },
      {
        shape: 'window-only figure (0ms tick: instant honestly absent) — the schedule face still reaches the human (T43)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ state: 'running', simTimeSec: 30, tickCount: 6, speed: 5, scenarioName: 'S', effectiveSpeedWindowPerSec: 4.8, effectiveSpeedWindowSec: 0.24 }),
        render: payload => renderStatusHumanLines(payload as Parameters<typeof renderStatusHumanLines>[0]),
        anchored: ['4.8 sim-s/s (<1s avg — schedule with this one', 'nominal speed=5'],
        forbidden: ['(instant)', '0s avg'],
      },
      {
        shape: 'paused / never ticked — the dash explains the missing rate, never a fabricated zero',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ state: 'paused', simTimeSec: 0, tickCount: 0, speed: 60, scenarioName: 'S' }),
        render: payload => renderStatusHumanLines(payload as Parameters<typeof renderStatusHumanLines>[0]),
        anchored: ['effectiveSpeed: —'],
        forbidden: ['effectiveSpeed≈'],
      },
      {
        shape: 'T123: the handshake honesty note rides every status face (rate-gated real-time floor)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ state: 'running', simTimeSec: 1, tickCount: 1, speed: 60, scenarioName: 'S', effectiveSpeedWindowPerSec: 28, effectiveSpeedWindowSec: 60 }),
        render: payload => renderStatusHumanLines(payload as Parameters<typeof renderStatusHumanLines>[0]),
        anchored: ['handshakes.failures.byCause', '伙伴握手窗有真实时间下限保底', 'real-time floor', 'EAF_AC_RESPONSE_MIN_WALL_MS'],
      },
    ],
  },
  {
    face: 'sim snapshot summary + zones table (T76 — the bare-dump face is retired)',
    branches: [
      {
        shape: 'the human snapshot face is a summary + unit zones table, not a JSON dump',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({
          runtimeId: 'sim-1', scenarioId: 'sc-1', scenarioName: 'Campus', state: 'running',
          simTimeSec: 67080, simTime: 'x', speed: 60, tickCount: 100,
          zones: [
            { id: 'bldg-d-f1', parameters: { temperature: 28.72498000506343, co2: 587.9, motion: true } },
            { id: 'bldg-m-f1', parameters: { temperature: 24.4, co2: 620.512, wind_speed: 3.21, motion: false } },
          ],
          devices: [{ id: 'd', name: 'D', type: 'hvac', role: 'hvac', zoneId: 'bldg-d-f1', state: {} }],
          agents: [],
          recentDecisions: [], scheduledEvents: [],
        }),
        render: payload => {
          const snap = payload as Parameters<typeof renderSnapshotHumanLines>[0];
          const table = humanZoneTable(snap.zones, snap.simTimeSec);
          return [...renderSnapshotHumanLines(snap), table.columns.join('|'), JSON.stringify(table.rows)];
        },
        anchored: [
          'snapshot sim-1',
          'state=running simTime=67080s',
          'zones=2 devices=1',
          'temperature (°C)',
          'wind_speed (m/s)',
          'motion (flag)',
        ],
        forbidden: ['28.72498000506343', 'e-24', '620.512'],
      },
      {
        shape: 'a snapshot without a window rate renders the honest speed dash',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({
          runtimeId: 'sim-2', scenarioId: 'sc-1', scenarioName: 'Campus', state: 'running',
          simTimeSec: 10, simTime: 'x', speed: 60, tickCount: 2,
          zones: [], devices: [], agents: [], recentDecisions: [], scheduledEvents: [],
        }),
        render: payload => renderSnapshotHumanLines(payload as Parameters<typeof renderSnapshotHumanLines>[0]),
        anchored: ['effectiveSpeed: — (no window average'],
        forbidden: ['effectiveSpeed≈'],
      },
      {
        shape: 'T79: a rule-only snapshot renders the server llm warning on the human face (R102)',
        coveredBy: 'render-walk (sim snapshot face over the real server)',
        fixture: () => ({
          runtimeId: 'sim-3', scenarioId: 'sc-1', scenarioName: 'Campus', state: 'running',
          simTimeSec: 20, simTime: 'x', speed: 60, tickCount: 3,
          llmWarning: 'Agents in this world use LLM decisions but no LLM backend is configured — decisions use the rule/fallback lane.',
          zones: [], devices: [], agents: [], recentDecisions: [], scheduledEvents: [],
        }),
        render: payload => renderSnapshotHumanLines(payload as Parameters<typeof renderSnapshotHumanLines>[0]),
        anchored: ['⚠ Agents in this world use LLM decisions'],
      },
    ],
  },
  {
    face: 'sim watch change judgment (T73 — float dust never emits)',
    branches: [
      {
        shape: '1e-65 dust between two snapshots is suppressed at the rendered precision',
        coveredBy: 'render-walk (stream face) + sim-status.render.vitest.test.ts',
        fixture: () => ({ from: 2.17e-65, to: 4.82e-66, parameter: 'co2', options: {} }),
        render: payload => {
          const p = payload as { from: unknown; to: unknown; parameter: string; options: { allChanges?: boolean; minDelta?: number } };
          return judgeZoneChange(p.from, p.to, p.parameter, p.options);
        },
        anchored: ['"emit":false'],
      },
      {
        shape: 'T88 (R11, u3-F1): a formatted-equal move NEVER emits — no "24.71 → 24.71" row can exist (the delta still rides --json for scripts)',
        coveredBy: 'render-contract (this walk)',
        // 24.706→24.713: both render "24.71" while the raw delta (0.007)
        // sits in the old half-grid leak band (u3's 22-row evidence).
        fixture: () => ({ from: 24.706, to: 24.713, parameter: 'temperature', options: {} }),
        render: payload => {
          const p = payload as { from: unknown; to: unknown; parameter: string; options: { allChanges?: boolean; minDelta?: number } };
          return judgeZoneChange(p.from, p.to, p.parameter, p.options);
        },
        anchored: ['"emit":false', '"delta"'],
      },
      {
        shape: '--all-changes re-opens the raw stream (the dust emits with its delta)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ from: 2.17e-65, to: 4.82e-66, parameter: 'co2', options: { allChanges: true } }),
        render: payload => {
          const p = payload as { from: unknown; to: unknown; parameter: string; options: { allChanges?: boolean; minDelta?: number } };
          return judgeZoneChange(p.from, p.to, p.parameter, p.options);
        },
        anchored: ['"emit":true', '"delta"'],
      },
      {
        shape: 'a real jump (+6°C) always emits regardless of policy',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ from: 21, to: 27, parameter: 'temperature', options: { minDelta: 0.01 } }),
        render: payload => {
          const p = payload as { from: unknown; to: unknown; parameter: string; options: { allChanges?: boolean; minDelta?: number } };
          return judgeZoneChange(p.from, p.to, p.parameter, p.options);
        },
        anchored: ['"emit":true', '"delta":6'],
      },
    ],
  },
  {
    face: 'sim snapshot --zones table (T11/T23)',
    branches: [
      {
        shape: 'float readings under unit-labelled columns (the T23 blank-table regression)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ zones: [{ id: 'z1', parameters: { temperature: 31.567, co2: 587.9 } }], simTimeSec: 40123 }),
        render: payload => {
          const p = payload as { zones: Array<{ id: string; parameters: Record<string, number | boolean> }>; simTimeSec: number };
          return humanZoneTable(p.zones, p.simTimeSec);
        },
        anchored: ['temperature (°C)', 'co2 (ppm)'],
      },
      {
        shape: 'unitless parameters render bare (no invented units)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ zones: [{ id: 'z1', parameters: { motion: 1, smoke: 0 } }], simTimeSec: 5 }),
        render: payload => {
          const p = payload as { zones: Array<{ id: string; parameters: Record<string, number | boolean> }>; simTimeSec: number };
          return humanZoneTable(p.zones, p.simTimeSec);
        },
        anchored: ['motion', 'smoke'],
      },
    ],
  },
  {
    face: 'sim watch zone diff (T38.2)',
    branches: [
      {
        shape: 'known parameter → unit + ≤2 decimals',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ value: 24.503, parameter: 'temperature' }),
        render: payload => {
          const p = payload as { value: unknown; parameter: string };
          return formatWatchValue(p.value, p.parameter);
        },
        anchored: ['°C'],
      },
    ],
  },
  {
    face: 'sim eval report (B1-1 hardening — survives ANY shape)',
    branches: [
      {
        shape: 'full report with effectChecks/recordKinds (T19)',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({ simId: 's', decisions: { total: 1, accuracy: 1 }, handshakes: { initiated: 0, successRate: null }, metaAgents: [] }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['decisions'],
      },
      {
        shape: 'disk-rebuilt report without live sections — honest "—" lines',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({}),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['—'],
      },
      {
        shape: 'FEAT-04/UX-02: succeededUnmetered spoken + effectChecks failure drill-down lines',
        coveredBy: 'sim-status.render.vitest.test.ts',
        fixture: () => ({
          simId: 's',
          decisions: { total: 3, accuracy: 1 },
          handshakes: {
            initiated: 4, succeeded: 3, succeededUnmetered: 1, failed: 1, successRate: 0.75,
            cancelledByCoordinator: 0, negotiationSuccessRate: 0.75,
            failures: { total: 1, byCause: { 'no-partner': 1 } },
          },
          effectChecks: {
            attempts: 5, successes: 3, partial: 0, failures: 2, passRate: 0.6,
            deviceExecutions: { attempts: 5, successes: 3, failures: 2 },
            failureBreakdown: {
              byKind: { 'device-execution': 1, 'goal-unachieved': 1 },
              byCause: { 'value out of range': 1, 'goal not achieved (world-feedback recheck settled false)': 1 },
              records: [
                { kind: 'device-execution', eventId: 'ev-1', agentId: 'a1', deviceId: 'dev-1', command: 'set-temperature', error: 'value out of range', recordedAt: 't1' },
                { kind: 'goal-unachieved', eventId: 'ev-2', agentId: 'a2', decision: 'handle_independently', recordedAt: 't2' },
              ],
            },
          },
          metaAgents: [],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['succeededUnmetered 1', '失败下钻', 'goal-unachieved 1', 'value out of range', '[device-execution] ev-1/a1 dev-1 set-temperature'],
      },
      {
        shape: 'T29-annotated metaAgents rows — scope line + 全历史/本窗口/样本量小 markers (T40f)',
        coveredBy: 'sim-eval.render.vitest.test.ts',
        fixture: () => ({
          simId: 's',
          decisions: { total: 28, accuracy: 0.61 },
          metaAgents: [
            { agentName: 'hvac-keeper', calibrationScore: 0.8, successRate: 0.13, evaluatedDecisions: 8, decisionCount: 19, window: 'all-history', windowDecisionCount: 2, capabilityBoundary: { strong: ['hvac-control'], weak: [], mustEscalate: [] } },
            { agentName: 'smoke-warden', calibrationScore: null, successRate: 1, evaluatedDecisions: 2, decisionCount: 2, window: 'report-window', smallSample: true, capabilityBoundary: { strong: [], weak: [], mustEscalate: [] } },
          ],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: [
          '不同源不可相加',
          '[全历史]',
          '[本窗口]',
          '（样本量小）',
          '本窗口决策 2 条',
        ],
      },
      {
        shape: 'T134 (R20-F, u1-F1): abandoned-before-response DOMINANT failures carry the queue-backlog attribution line (window-scoped, never "partners unwilling")',
        coveredBy: 'render-contract (this walk)',
        // Fixture mirrors the server's real failures wire shape
        // (eval-report.ts failures: { total, byCause }) — u1's ×300 funnel.
        fixture: () => ({
          simId: 's',
          decisions: { total: 8, accuracy: null },
          handshakes: {
            initiated: 8,
            successRate: 0.625,
            cancelledByCoordinator: 0,
            negotiationSuccessRate: 0.625,
            failures: {
              total: 3,
              byCause: {
                'no-partner': 0,
                'abandoned-before-response': 3,
                'all-rejected': 0,
                timeout: 0,
                superseded: 0,
              },
            },
          },
          metaAgents: [],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: [
          '归因: abandoned-before-response 主导（3/3 次失败）',
          '窗口收口',
          '非伙伴无意愿',
          'EAF_AC_HANDSHAKE_FAST_LANE=1',
        ],
        forbidden: ['伙伴拒绝协作', '伙伴均无意愿'],
      },
      {
        shape: 'T134: a report whose dominant cause is NOT abandoned renders NO attribution line (the line never lies about the top cause)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          simId: 's',
          decisions: { total: 1, accuracy: null },
          handshakes: {
            initiated: 4,
            successRate: 0,
            failures: {
              total: 4,
              byCause: {
                'no-partner': 4,
                'abandoned-before-response': 0,
                'all-rejected': 0,
                timeout: 0,
                superseded: 0,
              },
            },
          },
          metaAgents: [],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['handshakes: 4 (0%)'],
        forbidden: ['归因: abandoned-before-response 主导'],
      },
      {
        shape: 'BUG-07: pendingAtSampling > 0 renders the window-open line (undecided, not dead) and SUPPRESSES the abandoned attribution when it is the top cause',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          simId: 's',
          decisions: { total: 3, accuracy: null },
          handshakes: {
            initiated: 5,
            successRate: 0.4,
            failures: {
              total: 3,
              byCause: {
                'no-partner': 0,
                'abandoned-before-response': 1,
                'all-rejected': 0,
                timeout: 0,
                superseded: 0,
                aborted: 0,
                pendingAtSampling: 2,
              },
            },
          },
          metaAgents: [],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['归因: pendingAtSampling 2 次', '尚未闭合', '未决而非消亡'],
        forbidden: ['归因: abandoned-before-response 主导'],
      },
      {
        shape: 'BUG-07: aborted > 0 renders the runtime-teardown line (explained death — reason names runtime-rebuild / runtime-stopped)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          simId: 's',
          decisions: { total: 3, accuracy: null },
          handshakes: {
            initiated: 6,
            successRate: 0.5,
            failures: {
              total: 3,
              byCause: {
                'no-partner': 0,
                'abandoned-before-response': 0,
                'all-rejected': 1,
                timeout: 0,
                superseded: 0,
                aborted: 2,
                pendingAtSampling: 0,
              },
            },
          },
          metaAgents: [],
        }),
        render: payload => {
          const out: string[] = [];
          renderEvalReportHuman(payload, t => out.push(t));
          return out.join('\n');
        },
        anchored: ['归因: aborted 2 次', 'runtime-rebuild', '非协商失败'],
        forbidden: ['归因: abandoned-before-response 主导'],
      },
    ],
  },
  {
    face: 'service list row (T40d drift marker) / reputation face (T40j rounding)',
    branches: [
      {
        shape: 'a declaration-drifted offer carries the ⚠ marker in the marketplace table',
        coveredBy: 'service-list.render.vitest.test.ts',
        fixture: () => ({
          id: 'svc-d', name: '空调启停（D栋）', semanticType: 'turn-on', origin: 'derived', envId: 'e1',
          declaredByProvider: false,
          provider: { id: 'a1', name: 'D栋空调管家', owner: { id: 'u1', displayName: 'Owner' } },
        }),
        render: payload => serviceListRow(payload as Parameters<typeof serviceListRow>[0], '校园'),
        anchored: ['⚠'],
      },
      {
        shape: 'a healthy offer renders an empty drift cell (no phantom markers)',
        coveredBy: 'service-list.render.vitest.test.ts',
        fixture: () => ({
          id: 'svc-h', name: '照明服务', semanticType: 'lighting-control', origin: 'published', envId: 'e1',
          provider: { id: 'a2', name: '灯光管家', owner: { id: 'u2', displayName: 'Owner' } },
        }),
        render: payload => serviceListRow(payload as Parameters<typeof serviceListRow>[0], undefined),
        forbidden: ['⚠'],
      },
      {
        shape: 'a 16-digit measured score rounds to two decimals (T40j, u2#3)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({ score: 0.6818455374547898, attempts: 13, successes: 9 }),
        render: payload => reputationFace(payload as Parameters<typeof reputationFace>[0]),
        anchored: ['score 0.68'],
        forbidden: ['0.6818455374547898'],
      },
    ],
  },
  {
    face: 'agent what-if (T27 fork provenance + T109 jurisdiction disclosure)',
    branches: [
      {
        shape: 'forkSource + simTimeSec + window — provenance line required',
        coveredBy: 'agent-what-if.render.vitest.test.ts',
        fixture: () => ({ simTimeSec: 270, forkSource: { kind: 'world-session', simulationId: 'sim-ws' }, result: { verdict: 'neutral', scenario: { durationSec: 600 } } }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        anchored: ['fork 来源', 'sim-ws'],
      },
      {
        shape: 'pre-R81 response without fork fields — no line, no crash',
        coveredBy: 'agent-what-if.render.vitest.test.ts',
        fixture: () => ({ result: { verdict: 'neutral' } }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        forbidden: ['fork 来源'],
      },
      {
        shape: 'T109: a cross-district intervention — the jurisdiction disclosure LEADS the human face (never json-only)',
        coveredBy: 'agent-what-if.render.vitest.test.ts',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          jurisdictionNote:
            '⚠ 你点名的干预目标分区「B栋1F」不在该 agent 的辖区——下面的预演是对他人辖区设备的 fork 演练，' +
            '不代表该 agent 有操作权；真正执行需经辖区管理方（合约或提案）。该分区由 B栋管家 管理' +
            '（`eaf agent list --env` 查看花名册）。 (The intervention target zone(s) are outside this ' +
            "agent's jurisdiction — the prediction below is a fork simulation of another district's device, " +
            "not an authority to act; executing it for real requires the district's manager (an agreement or a proposal).)",
          simTimeSec: 12,
          forkSource: { kind: 'world-session', simulationId: 'sim-ws' },
          result: {
            verdict: 'neutral',
            delta: { temperature_bldg_b_f1: 0.024, energy_bldg_b_f1: 156.25 },
            scenario: { durationSec: 600 },
          },
        }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        anchored: ['不在该 agent 的辖区', 'B栋管家', 'fork 演练', 'what-if: neutral'],
      },
      {
        shape: 'T109: an in-jurisdiction intervention — no disclosure line, zero打扰 (the normal path)',
        coveredBy: 'agent-what-if.render.vitest.test.ts',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          simTimeSec: 12,
          forkSource: { kind: 'world-session', simulationId: 'sim-ws' },
          result: { verdict: 'improvement', delta: { temperature_zone_a: -0.5 }, scenario: { durationSec: 600 } },
        }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        forbidden: ['不在该 agent 的辖区', 'jurisdictionNote'],
        anchored: ['what-if: improvement'],
      },
      {
        shape: 'T122 (R17-u3/R19-u4): the env default-simulation disclosure leads the header — which world the resolved agent came from',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-default',
          defaultSimNote:
            '使用环境默认仿真 sim-default。 (Using the environment\'s default simulation sim-default — ' +
            'set by the environment owner; pass an explicit simulationId to target another world.)',
          simTimeSec: 30,
          forkSource: { kind: 'world-session', simulationId: 'sim-ws' },
          result: { verdict: 'neutral', delta: { temperature_zone_a: 0.1 }, scenario: { durationSec: 600 } },
        }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        anchored: ['使用环境默认仿真 sim-default', 'what-if: neutral'],
      },
      {
        shape: 'T130 (R21-F2): an INERT default-sim binding — the ⚠ fall-back disclosure LEADS the header with the --clear guidance (never a silent fall-back, never the live-binding wording)',
        coveredBy: 'agent-what-if.render.vitest.test.ts',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-env-world-session',
          defaultSimNote:
            '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到权威 world session；' +
            '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
            "(The environment's default simulation sim-owner-1 is not running — fell back to " +
            'the standard default-world adjudication; clear or rebind it with ' +
            '`eaf env set-default-sim <env> --clear`.)',
          simTimeSec: 42,
          forkSource: { kind: 'world-session', simulationId: 'sim-env-world-session' },
          result: { verdict: 'neutral', delta: { temperature_zone_a: 0 }, scenario: { durationSec: 600 } },
        }),
        render: payload => renderWhatIf(payload as Record<string, unknown>),
        anchored: ['⚠', '已停止运行', 'env set-default-sim', '--clear', 'what-if: neutral', 'fork 来源: world-session'],
        forbidden: ['使用环境默认仿真'],
      },
    ],
  },
  {
    face: 'service get (human) — T49 drift face + T68a signability verdicts + detail sections',
    branches: [
      {
        shape: 'a declaration-drifted offer renders the SHARED ⚠ wording (same helper as agreement get / list column)',
        coveredBy: 'render-contract (this walk) + service-list.render.vitest.test.ts',
        fixture: () => ({
          id: 'svc-gd', name: 'M栋环境传感器 co2-reading', semanticType: 'co2-reading', origin: 'published', envId: 'e1',
          visibility: 'members', declaredByProvider: false,
          computation: { kind: 'device-aggregate', refreshSec: 60, schemaVersion: 1 },
          provider: { id: 'a1', name: 'WD-值守-M栋', owner: { id: 'u1', displayName: '王盾' } },
          reputation: { score: 0.75, attempts: 1, successes: 1 },
          usageSummary: { windowDays: 30, invocations: 1, succeeded: 1, failed: 0, partial: 0, other: 0, successRate: 1 },
          trackRecord: 'established',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: ['⚠ provider 未声明', "'co2-reading'", 'declaredByProvider:false'],
      },
      {
        shape: 'a healthy offer renders NO drift marker (the ⚠ appears only when declaredByProvider === false)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gh', name: '温度数据服务', semanticType: 'temperature-reading', origin: 'published', envId: 'e1',
          visibility: 'members',
          provider: { id: 'a2', name: '陈功设备商', owner: { id: 'u2', displayName: '陈功' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          usageSummary: { windowDays: 30, invocations: 0, succeeded: 0, failed: 0, partial: 0, other: 0, successRate: null },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        forbidden: ['provider 未声明'],
      },
      {
        shape: 'T121 (R10-u4): a card with reputation AND usage renders the methodology note (all-history vs rolling window — two denominators, never a silent contradiction)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gm', name: '空调调节服务', semanticType: 'air-quality-improvement', origin: 'published', envId: 'e1',
          visibility: 'members',
          provider: { id: 'a5', name: '老牌设备商', owner: { id: 'u3', displayName: '老王' } },
          reputation: { score: 0.82, attempts: 12, successes: 9 },
          usageSummary: { windowDays: 30, invocations: 5, succeeded: 4, failed: 1, partial: 0, other: 0, successRate: 0.8 },
          trackRecord: 'established',
          methodologyNote:
            'methodology: reputation (score/attempts/succeeded) is the provider agent\'s ALL-HISTORY ' +
            'invoke ledger (score time-decayed, per semantic type); usageSummary counts the rolling ' +
            'last-30-days window of THIS service only — the two numbers have different denominators ' +
            'and are not expected to reconcile',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: ['口径: reputation=全历史', 'usage=近 30 天滚动窗口', '不可直接对账'],
      },
      {
        shape: 'T121: a card WITHOUT the methodology note renders no 口径 line (the note rides only when usageSummary does)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gn', name: '无计量摘要服务', semanticType: 'temperature-reading', origin: 'published', envId: 'e1',
          visibility: 'members',
          provider: { id: 'a6', name: '新设备商', owner: { id: 'u4', displayName: '小李' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        forbidden: ['口径:'],
      },
      {
        shape: 'T68a (R7, u2): an ambiguous offer renders the verdict + candidate devices + the gate reason (u2 saw them on --json only)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-ga', name: '教室空气质量改善', semanticType: 'air-quality-improvement', origin: 'published', envId: 'e1',
          visibility: 'public',
          signability: {
            verdict: 'ambiguous',
            candidateDevices: ['米家净化器D2F', '米家净化器D3F'],
            reason: 'resolves to 2 backing devices of provider agent "教室空气管家" ("米家净化器D2F", "米家净化器D3F") — proposing an agreement will refuse with SERVICE_BACKING_AMBIGUOUS',
          },
          provider: { id: 'a3', name: '教室空气管家', owner: { id: 'u1', displayName: 'Owner' } },
          reputation: { score: 0.8, attempts: 3, successes: 2 },
          trackRecord: 'established',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: ambiguous',
          '米家净化器D2F', '米家净化器D3F',
          'SERVICE_BACKING_AMBIGUOUS',
          'signability reason: resolves to 2 backing devices',
        ],
      },
      {
        shape: 'T68a (R7, u2-F-5): an unbacked AGGREGATE offer renders the verdict + the gate reason — the signing refusal promise is TRUE here (assertAggregateDeliverable)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gu', name: '校园空气环境保障', semanticType: 'air-quality-management', origin: 'aggregate', envId: 'e1',
          visibility: 'members', unbacked: true,
          signability: {
            verdict: 'unbacked',
            reason: "no bound device of the provider agent holds any of the offer rule's actuation capabilities (pm2_5-control) — proposing will refuse with SERVICE_NOT_BACKED.",
          },
          backing: { kind: 'rule', rule: 'air-quality-management', actuates: ['pm2_5-control'], devices: [], callableActions: [] },
          provider: { id: 'a4', name: '校园环境管家', owner: { id: 'u2', displayName: 'Owner' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: unbacked',
          'SERVICE_NOT_BACKED',
          'signability reason: no bound device of the provider agent',
        ],
      },
      {
        shape: "T103 (R16, u2-#2): an unbacked PUBLISHED offer signs (T84: speculative agreements are legitimate) — the face promises the RUNTIME refusals, never a signing rejection the gate doesn't enforce",
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gp', name: '陈功R13·T81幽灵探针', semanticType: 'temperature-reading', origin: 'published', envId: 'e1',
          visibility: 'members', unbacked: true,
          signability: {
            verdict: 'unbacked',
            reason: 'no bound device of provider agent "陈功设备商" covers "temperature-reading" — there is nothing to execute; every invoke will refuse with SERVICE_NOT_BACKED until a device holding the capability is bound (PATCH /api/agents/:id boundDeviceIds)',
          },
          computation: { kind: 'device-aggregate', refreshSec: 60, schemaVersion: 1 },
          provider: { id: 'a7', name: '陈功设备商', owner: { id: 'u2', displayName: '陈功' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: unbacked',
          '签约不拦',
          'invoke 将诚实拒绝 SERVICE_NOT_BACKED',
          'read 同样诚实拒绝',
        ],
        forbidden: ['签约将被拒'],
      },
      {
        shape: "T108 (R17, u2-F2): an unbacked PUBLISHED offer with a ZONE-QUERY computation — the read rides the zone parameter face and SUCCEEDS with metering, so the face must NOT promise a read refusal (the half-broken promise u2 caught: 2ac326da read fine with zero backing devices)",
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gz', name: '2ac326da 分区温度查询', semanticType: 'temperature-reading', origin: 'published', envId: 'e1',
          visibility: 'members', unbacked: true,
          signability: {
            verdict: 'unbacked',
            reason: 'no bound device of provider agent "陈功设备商" covers "temperature-reading" — there is nothing to execute; every invoke will refuse with SERVICE_NOT_BACKED until a device holding the capability is bound (PATCH /api/agents/:id boundDeviceIds)',
          },
          computation: { kind: 'zone-query', refreshSec: 60, schemaVersion: 3 },
          provider: { id: 'a7', name: '陈功设备商', owner: { id: 'u2', displayName: '陈功' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: unbacked',
          '签约不拦',
          'invoke 将诚实拒绝 SERVICE_NOT_BACKED',
          'read 走 zone 参数面',
          '正常计量落账',
        ],
        forbidden: ['read 同样诚实拒绝', '签约将被拒'],
      },
      {
        shape: 'T68a (R7): a backed offer renders the quiet positive line — the precheck ran and passed (no phantom ⚠)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-gb', name: 'D栋图书馆空调机组 air-conditioning', semanticType: 'air-conditioning', origin: 'derived', envId: 'e1',
          visibility: 'members',
          signability: { verdict: 'backed' },
          provider: { id: 'a5', name: 'D栋空调管家', owner: { id: 'u1', displayName: 'Owner' } },
          reputation: { score: 0.9, attempts: 4, successes: 4 },
          trackRecord: 'established',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: ['signability: backed（签约预检通过）'],
        forbidden: ['signability: unbacked', 'signability: ambiguous', 'signability reason:'],
      },
      {
        shape: 'T84 (R10, u1-F1) + T86 (R11) + T91 (R13): a never-written READ SOURCE probed on the WORLD-SESSION lane renders the read-source ambiguity ⚠ with the lands-on-this-session refusal promise (honest for both no-own-sim and several-own-sims viewers) — never the backing-ambiguity copy',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-ru', name: 'D栋温度读数', semanticType: 'temperature-monitoring', origin: 'derived', envId: 'e1',
          visibility: 'members',
          signability: {
            verdict: 'ambiguous',
            reason: 'read 源从未被写：the computation behind "D栋温度读数" reads device state ("temperature") that the authoritative world session "sim-e1-world-session" has NEVER written — a read that lands on this session (the read lane\'s fallback world when you have NO targetable own sim; with several, the default read first asks you to disambiguate) will honestly refuse with COMPUTATION_DEVICE_STATE_UNWRITTEN (the scenario holds the paths as initialization placeholders only) — Signing is NOT refused (speculative agreements are legitimate) — sign with that expectation. Remedies: re-register the metric against the zone parameter face (source:"zone", POST /api/services/:id/computation), or make the scenario / device physics actually write the state path, or re-bind a device whose world writes its state',
            readSource: { status: 'never-written', fields: ['temperature'], simulationId: 'sim-e1-world-session', probedLane: 'world-session' },
          },
          computation: { kind: 'device-aggregate', refreshSec: 60, schemaVersion: 1, registeredAt: '2026-09-18T00:00:00Z' },
          provider: { id: 'a6', name: 'D栋空调管家', owner: { id: 'u1', displayName: 'Owner' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: ambiguous（读源从未被写）',
          '权威 world-session（sim-e1-world-session）',
          '落到该会话的读将诚实拒绝',
          '无自有 sim 时默认读即落到该会话',
          'COMPUTATION_DEVICE_STATE_UNWRITTEN',
          'signability reason: read 源从未被写',
        ],
        forbidden: ['SERVICE_BACKING_AMBIGUOUS', 'propose 将拒绝'],
      },
      {
        shape: 'T86 (R11, u1-F1): the OWN-SIM lane layers the promise honestly — own-sim reads refuse, the sim-less world-session fallback may return the frozen initialization value (never a blanket "every read refuses")',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'svc-ru2', name: 'M栋温度读数', semanticType: 'temperature-monitoring', origin: 'derived', envId: 'e1',
          visibility: 'members',
          signability: {
            verdict: 'ambiguous',
            reason: 'read 源从未被写：the computation behind "M栋温度读数" reads device state ("temperature") that your running simulation "sim-e1-mine" has NEVER written — reads while your own sim runs will honestly refuse with COMPUTATION_DEVICE_STATE_UNWRITTEN (the scenario holds the paths as initialization placeholders only). Lane honesty: with NO own running sim the default read falls to the authoritative world session instead — a world this probe did not judge — where the same read can SUCCEED with the world\'s initialization value (a placeholder that may stay frozen rather than refuse) — Signing is NOT refused (speculative agreements are legitimate) — sign with that expectation. Remedies: re-register the metric against the zone parameter face (source:"zone", POST /api/services/:id/computation), or make the scenario / device physics actually write the state path, or re-bind a device whose world writes its state',
            readSource: { status: 'never-written', fields: ['temperature'], simulationId: 'sim-e1-mine', probedLane: 'own-sim' },
          },
          computation: { kind: 'device-aggregate', refreshSec: 60, schemaVersion: 1, registeredAt: '2026-09-18T00:00:00Z' },
          provider: { id: 'a6', name: 'D栋空调管家', owner: { id: 'u1', displayName: 'Owner' } },
          reputation: { score: 0.7, attempts: 0, successes: 0, prior: 0.7 },
          trackRecord: 'none',
        }),
        render: payload => renderServiceGetLines(payload as Parameters<typeof renderServiceGetLines>[0]),
        anchored: [
          'signability: ambiguous（读源从未被写）',
          '你的自有 sim（sim-e1-mine）',
          '带自有 sim 的 read 将诚实拒绝',
          '无自有 sim 时默认读会落到权威 world-session',
          '初始化值',
          'COMPUTATION_DEVICE_STATE_UNWRITTEN',
          'signability reason: read 源从未被写',
          'Lane honesty',
        ],
        forbidden: ['SERVICE_BACKING_AMBIGUOUS', 'propose 将拒绝', '每次 read'],
      },
    ],
  },
  {
    face: 'agreement read (human) — T51 units + empty-event-window honesty + T57 window clock & cached provenance',
    branches: [
      {
        shape: 'an empty event window names the 0 as "no events", never a real reading',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r1', simulationId: 'sim-1',
          frame: {
            kind: 'data', agreementId: 'agt-r1', serviceId: 'svc-r', schemaVersion: 1,
            data: { power: 0 },
            units: { power: 'W' },
            emptyEventWindow: true,
            // T57a: the window's clock semantics ride the frame — the ⚠
            // converts the sim-seconds window into ≈real seconds.
            eventWindowSec: 600,
            effectiveSpeedPerSec: 10,
            provenance: {
              computationKind: 'device-aggregate',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-17T00:00:00Z',
              simTimeSec: 67080, simulationId: 'sim-1', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['power'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u1', outcome: 'success' },
          receiptId: 'rc1',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['power=0 W', '事件窗为空', '不是真实读数', 'events=0', '600 仿真秒 ≈ 当前倍速下 60 真实秒'],
      },
      {
        shape: 'a unit-bearing real reading renders the unit inline and no window warning',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r2', simulationId: 'sim-2',
          frame: {
            kind: 'data', agreementId: 'agt-r2', serviceId: 'svc-r', schemaVersion: 1,
            data: { temperature: 24.4007 },
            units: { temperature: '°C' },
            emptyEventWindow: false,
            provenance: {
              computationKind: 'zone-query',
              inputsSummary: { zones: 2, devices: 1, eventsWindowed: 3 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-17T00:00:00Z',
              simTimeSec: 120, simulationId: 'sim-2', cached: false,
            },
            freshnessSec: 2, stale: false,
          },
          applied: { fields: ['temperature'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u2', outcome: 'success' },
          receiptId: 'rc2',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['temperature=24.4 °C', 'fresh'],
        forbidden: ['事件窗为空', '24.4007'],
      },
      {
        shape: 'a null value renders null (never a bare blank) and unknown units stay bare',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r3',
          // T68c (R7): the cached delivery carries the computing sim on the
          // top level too (no targeted sim runs; `cached` names the mode).
          simulationId: 'sim-origin-9',
          frame: {
            kind: 'data', agreementId: 'agt-r3', serviceId: 'svc-r', schemaVersion: 1,
            data: { avgTemperature: null },
            units: { avgTemperature: '°C' },
            provenance: {
              computationKind: 'zone-query',
              inputsSummary: { zones: 0, devices: 0, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-17T00:00:00Z',
              // T57b: the cached face KEEPS the computing sim's provenance.
              simTimeSec: 0, simulationId: 'sim-origin-9', cached: true,
            },
            freshnessSec: 90, stale: true,
          },
          applied: { fields: ['avgTemperature'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u3', outcome: 'success' },
          receiptId: null,
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['avgTemperature=null °C', 'STALE', 'cached, computed from sim sim-origin-9 @'],
      },
      {
        shape: 'T83+T133: a GHOST event type (never declared in this world) renders the WINDOW-scoped suggestion + declaration-table note, never a world-history claim',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r5', simulationId: 'sim-5',
          frame: {
            kind: 'data', agreementId: 'agt-r5', serviceId: 'svc-r', schemaVersion: 1,
            data: { meteors: 0 },
            units: { meteors: null },
            emptyEventWindow: true,
            // T83: the server attaches the ghost annotation ONLY when the
            // spec references types this world's scenario never declares.
            undeclaredEventTypes: ['meteor-strike'],
            declaredEventTypes: ['power-peak', 'temperature-spike', 'occupancy'],
            eventWindowSec: 600,
            effectiveSpeedPerSec: 10,
            provenance: {
              computationKind: 'device-aggregate',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-17T00:00:00Z',
              simTimeSec: 600, simulationId: 'sim-5', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['meteors'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u5', outcome: 'success' },
          receiptId: 'rc5',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: [
          '事件窗为空', '不是真实读数', 'meteor-strike', '本次窗口内未观测到',
          '本世界场景未声明该类型', '仿真秒 ≈ 当前倍速下',
          'power-peak, temperature-spike, occupancy', '重新注册计算',
        ],
        // T133 (R20-F, u4-F1): window + declaration-table facts only — the
        // copy must never assert world history or the future (the two
        // forbidden tokens below), and keeps the widen-window advice out of
        // the ghost face.
        forbidden: ['从未产生', '永远', '加宽 windowSec'],
      },
      {
        shape: 'T85 (R10, u4-F1): a MIXED delivery (ghost + declared fields) renders the ghost copy AND the T57a plain-window advice — the declared sibling keeps its own warning',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r6', simulationId: 'sim-6',
          frame: {
            kind: 'data', agreementId: 'agt-r6', serviceId: 'svc-rm', schemaVersion: 1,
            data: { ghostHits: 0, peaks: 0 },
            units: { ghostHits: null, peaks: null },
            emptyEventWindow: true,
            // T85: the server scopes the ghost annotation to the DELIVERED
            // fields and names the declared-but-empty siblings separately.
            undeclaredEventTypes: ['ghost-r10-never-declared'],
            declaredEventTypes: ['intrusion-detected', 'power-peak'],
            ghostEventFields: ['ghostHits'],
            declaredEmptyEventFields: ['peaks'],
            eventWindowSec: 600,
            effectiveSpeedPerSec: 10,
            provenance: {
              computationKind: 'device-aggregate',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-18T00:00:00Z',
              simTimeSec: 600, simulationId: 'sim-6', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['ghostHits', 'peaks'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u6', outcome: 'success' },
          receiptId: 'rc6',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: [
          '事件窗为空', '本次窗口内未观测到', 'ghost-r10-never-declared',
          '加宽 windowSec', // the T57a advice for the declared sibling (peaks)
        ],
        forbidden: ['从未产生', '永远', 'intrusion-detected, power-peak, ghost-r10-never-declared'],
      },
      {
        shape: 'T85 (R10, u4-F1): a DECLARED field delivered on a mixed spec renders ONLY the T57a advice — no ghost mislabel, no terms-outside type leak',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r7', simulationId: 'sim-7',
          frame: {
            kind: 'data', agreementId: 'agt-r7', serviceId: 'svc-rm', schemaVersion: 1,
            data: { peaks: 0 },
            units: { peaks: null },
            emptyEventWindow: true,
            // T85: the declared delivery carries NO ghost annotation at all
            // (the spec's other ghost metric is outside terms.read.fields —
            // its type name must not leak either).
            declaredEmptyEventFields: ['peaks'],
            eventWindowSec: 600,
            effectiveSpeedPerSec: 10,
            provenance: {
              computationKind: 'device-aggregate',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-18T00:00:00Z',
              simTimeSec: 600, simulationId: 'sim-7', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['peaks'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u7', outcome: 'success' },
          receiptId: 'rc7',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['事件窗为空', '不是真实读数', '加宽 windowSec'],
        forbidden: ['从未产生', '永远', 'ghost-r10-never-declared'],
      },
      {
        shape: 'T57a: an event window without a usable rate renders the ⚠ without a fabricated conversion',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r4', simulationId: null,
          frame: {
            kind: 'data', agreementId: 'agt-r4', serviceId: 'svc-r', schemaVersion: 1,
            data: { fallsLastHour: 0 },
            units: { fallsLastHour: null },
            emptyEventWindow: true,
            // No effectiveSpeedPerSec (server predates T57a or sim idle) —
            // the conversion must NOT be invented.
            provenance: {
              computationKind: 'device-aggregate',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 0 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-17T00:00:00Z',
              simTimeSec: 600, simulationId: 'sim-4', cached: false,
            },
            freshnessSec: 1, stale: false,
          },
          applied: { fields: ['fallsLastHour'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u4', outcome: 'success' },
          receiptId: 'rc4',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['事件窗为空', '不是真实读数'],
        forbidden: ['真实秒'],
      },
      {
        shape: 'T122/T127: the read rode the env default simulation — the disclosure renders as a plain line (never json-only)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r9', simulationId: 'sim-default',
          defaultSimNote:
            '使用环境默认仿真 sim-default。 (Using the environment\'s default simulation sim-default — ' +
            'set by the environment owner; pass an explicit simulationId to target another world.)',
          frame: {
            kind: 'data', agreementId: 'agt-r9', serviceId: 'svc-r', schemaVersion: 1,
            data: { temperature: 22.5 },
            units: { temperature: '°C' },
            emptyEventWindow: false,
            provenance: {
              computationKind: 'zone-query',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 2 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-20T00:00:00Z',
              simTimeSec: 90, simulationId: 'sim-default', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['temperature'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u9', outcome: 'success' },
          receiptId: 'rc9',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['使用环境默认仿真 sim-default'],
      },
      {
        shape: 'T127 (R20-u2 F2): the binding went STALE and the read fell through to the reader\'s own sim — the disclosure renders as a ⚠ warn line naming the dead binding, the world that answered, and the fix',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agreementId: 'agt-r10', simulationId: 'sim-mine',
          defaultSimNote:
            '⚠ 环境默认仿真 sim-bound 已停止运行——本次回退到你自己唯一运行中的仿真 sim-mine；' +
            '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
            "(The environment's default simulation sim-bound is not running — fell back to your single running " +
            'simulation sim-mine; clear or rebind it with `eaf env set-default-sim <env> --clear`.)',
          frame: {
            kind: 'data', agreementId: 'agt-r10', serviceId: 'svc-r', schemaVersion: 1,
            data: { temperature: 21.0 },
            units: { temperature: '°C' },
            emptyEventWindow: false,
            provenance: {
              computationKind: 'zone-query',
              inputsSummary: { zones: 1, devices: 1, eventsWindowed: 1 },
              providerAgentId: 'a1', registeredBy: 'a1', computedAtWall: '2026-09-20T00:00:00Z',
              simTimeSec: 90, simulationId: 'sim-mine', cached: false,
            },
            freshnessSec: 0, stale: false,
          },
          applied: { fields: ['temperature'], meteringUnit: 'reading' },
          termsEnforced: true,
          usage: { id: 'u10', outcome: 'success' },
          receiptId: 'rc10',
        }),
        render: payload => readHumanLines(payload as Parameters<typeof readHumanLines>[0]),
        anchored: ['⚠', 'sim-bound', '已停止运行', 'sim-mine', 'set-default-sim'],
      },
    ],
  },
  {
    face: 'service reputation (T37 zero-sample prior)',
    branches: [
      {
        shape: 'attempts=0 — prior, never a bare measured-looking 0.7',
        coveredBy: 'render-contract (this walk) + reputationFace tests',
        fixture: () => ({ score: 0.7, attempts: 0, successes: 0, prior: 0.7 }),
        render: payload => reputationFace(payload as Parameters<typeof reputationFace>[0]),
        forbidden: ['score 0.7'],
        anchored: ['无履约样本', '0.7'],
      },
      {
        shape: 'attempts>0 — the measured score renders plainly',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({ score: 0.85, attempts: 4, successes: 3 }),
        render: payload => reputationFace(payload as Parameters<typeof reputationFace>[0]),
        anchored: ['score 0.85'],
      },
    ],
  },
  {
    face: 'agent ask (human) — T101 jurisdiction disclosure on the main output stream',
    branches: [
      {
        shape: 'out-of-jurisdiction question — the disclosure rides the human body (never json-only)',
        coveredBy: 'render-contract (this walk) + agent-nl.vitest (server join)',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          jurisdictionNote:
            '⚠ 你点名的分区「B栋1F」不在该 agent 的辖区——下面是它自己辖区（A栋1F）的读数，' +
            '不是你点名分区的数据。该分区由 B栋管家 管理（`eaf agent list --env` 查看花名册）。 ' +
            "(The named zone(s) are outside this agent's jurisdiction — the answer below reads its OWN zones, " +
            'not the one you named.)',
          naturalLanguageResponse:
            '⚠ 你点名的分区「B栋1F」不在该 agent 的辖区——下面是它自己辖区（A栋1F）的读数，' +
            '不是你点名分区的数据。该分区由 B栋管家 管理（`eaf agent list --env` 查看花名册）。 ' +
            "(The named zone(s) are outside this agent's jurisdiction — the answer below reads its OWN zones, " +
            'not the one you named.)\nA栋1F (zone-a): temperature 21°C',
        }),
        render: payload => renderAskLines(payload as Record<string, unknown>),
        anchored: ['不在该 agent 的辖区', 'B栋管家'],
      },
      {
        shape: 'server sends the standalone note only (pre-join payload) — the face still renders it (R102)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          jurisdictionNote: '⚠ 你点名的分区「B栋1F」不在该 agent 的辖区——下面是它自己辖区（A栋1F）的读数。',
          naturalLanguageResponse: 'A栋1F (zone-a): temperature 21°C',
        }),
        render: payload => renderAskLines(payload as Record<string, unknown>),
        anchored: ['不在该 agent 的辖区', 'A栋1F (zone-a)'],
      },
      {
        shape: 'own-zone question — no disclosure, zero打扰 (the normal path)',
        coveredBy: 'render-contract (this walk) + agent-nl.vitest (server join)',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          naturalLanguageResponse: 'A栋1F (zone-a): temperature 21°C',
        }),
        render: payload => renderAskLines(payload as Record<string, unknown>),
        forbidden: ['不在该 agent 的辖区', 'jurisdictionNote'],
        anchored: ['A栋1F (zone-a)'],
      },
      {
        shape: 'T106 (R17, u3-N2/u1-F3): a question naming an UNRESOLVABLE zone (「Z栋」) — the substitution onto the own jurisdiction is disclosed on the human body, never silent',
        coveredBy: 'render-contract (this walk) + agent-nl.vitest (server join)',
        fixture: () => ({
          agentId: 'keeper-a',
          simulationId: 'sim-1',
          jurisdictionNote:
            '⚠ 你点名的「Z栋」未能定位到任何真实分区——下面是它自己辖区（A栋1F）的读数，' +
            '不是你点名分区的数据；请核对分区名后再问（`eaf env get --full` 的 zones 表有全部分区）。' +
            ' (The named zone "Z栋" did not match any real zone — the answer below reads this agent\'s OWN ' +
            'jurisdiction, not the zone you named.)',
          naturalLanguageResponse:
            '⚠ 你点名的「Z栋」未能定位到任何真实分区——下面是它自己辖区（A栋1F）的读数，' +
            '不是你点名分区的数据；请核对分区名后再问（`eaf env get --full` 的 zones 表有全部分区）。' +
            ' (The named zone "Z栋" did not match any real zone — the answer below reads this agent\'s OWN ' +
            'jurisdiction, not the zone you named.)\nA栋1F (zone-a): temperature 21°C',
        }),
        render: payload => renderAskLines(payload as Record<string, unknown>),
        anchored: ['未能定位到任何真实分区', 'A栋1F (zone-a)'],
      },
      {
        shape: 'T130 (R21-F2): an INERT default-sim binding — the ⚠ fall-back disclosure rides the human body with the rebind/--clear guidance (R21 leg B: the silent-200 regression)',
        coveredBy: 'agent-ask.render.vitest.test.ts',
        fixture: () => {
          const note =
            '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到权威 world session；' +
            '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
            "(The environment's default simulation sim-owner-1 is not running — fell back to " +
            'the standard default-world adjudication; clear or rebind it with ' +
            '`eaf env set-default-sim <env> --clear`.)';
          return {
            agentId: 'keeper-a',
            simulationId: 'sim-env-world-session',
            defaultSimNote: note,
            naturalLanguageResponse: `${note}\nA栋1F (zone-a): temperature 21°C`,
            intent: { action: 'answer' },
          };
        },
        render: payload => renderAskLines(payload as Record<string, unknown>),
        anchored: ['⚠', '已停止运行', 'env set-default-sim', '--clear', 'A栋1F (zone-a): temperature 21°C'],
        forbidden: ['使用环境默认仿真'],
      },
    ],
  },
  {
    face: 'flow runs (human) — T107 sim attribution column (R102: the json face carries simulationId, the table must not be thinner)',
    branches: [
      {
        shape: 'a run on the authoritative world session — the sim cell reads the world-session tail; the triggerAt cell shows the trigger sim second (UX-14)',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'run-1', flowId: 'fl-1',
          simulationId: 'sim-a6a43ee5-5468-43df-9ec4-df34950e8b73-world-session',
          triggerKind: 'event', triggerSimTimeSec: 28740, status: 'success', summary: '12/12 ok',
          nodeResults: {}, startedAt: '2026-09-18T07:59:05Z', finishedAt: '2026-09-18T07:59:06Z',
        }),
        render: payload => flowRunRow(payload as Parameters<typeof flowRunRow>[0]),
        anchored: ['world-session', 'success', '28740s'],
      },
      {
        shape: "a run on a member's private sim — the sim cell is the distinguishing tail (the audit-误读 fix: it must not read as the world's run)",
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'run-2', flowId: 'fl-1',
          simulationId: 'sim-a6a43ee5-5468-43df-9ec4-df34950e8b73-mu6o9dpx-1',
          triggerKind: 'event', triggerSimTimeSec: 30012, status: 'partial', summary: '11/12 ok, 1 skipped',
          nodeResults: {}, startedAt: '2026-09-18T08:11:23Z', finishedAt: '2026-09-18T08:11:24Z',
        }),
        render: payload => flowRunRow(payload as Parameters<typeof flowRunRow>[0]),
        anchored: ['mu6o9dpx-1', '30012s'],
        forbidden: ['world-session'],
      },
      {
        shape: 'a run without a sim attribution and without a known trigger time (manual / pre-v30 row) — the cells render 「-」/「未记录」, never a bare null',
        coveredBy: 'render-contract (this walk)',
        fixture: () => ({
          id: 'run-3', flowId: 'fl-1', simulationId: null,
          triggerKind: 'manual', triggerSimTimeSec: null, status: 'failed', summary: '0/1 ok',
          nodeResults: {}, startedAt: '2026-09-18T08:00:00Z', finishedAt: '2026-09-18T08:00:01Z',
        }),
        render: payload => flowRunRow(payload as Parameters<typeof flowRunRow>[0]),
        anchored: ['-', 'failed', '未记录'],
        forbidden: ['null'],
      },
    ],
  },
  {
    face: 'env set-occupant-schedule (human) — FEAT-07 runtime schedule PATCH echo',
    branches: [
      {
        shape: 'install/update — schedule + live-push note (R102: the human face carries appliedRuntimes like --json)',
        coveredBy: 'env-occupant-schedule.render.vitest.test.ts',
        fixture: () => ({
          envId: 'env-1', zoneId: 'library',
          occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 64800 },
          cleared: false, appliedRuntimes: 1,
        }),
        render: payload => renderOccupantScheduleLines(payload as OccupantSchedulePatchResult),
        anchored: ['library', '40 people', '28800s → 64800s', '(daily)', 'applied to 1 live runtime(s)'],
      },
      {
        shape: 'cleared — says the headcount is untouched, never fabricates a schedule',
        coveredBy: 'env-occupant-schedule.render.vitest.test.ts',
        fixture: () => ({
          envId: 'env-1', zoneId: 'library',
          occupantSchedule: null, cleared: true, appliedRuntimes: 0,
        }),
        render: payload => renderOccupantScheduleLines(payload as OccupantSchedulePatchResult),
        anchored: ['cleared', 'current headcount untouched', 'no live world session — stored'],
        forbidden: ['people', 'null'],
      },
      {
        shape: 'overlay install (FEAT-07 phase-2) — overlay schedule + absolute window ride the human lines',
        coveredBy: 'env-occupant-schedule.render.vitest.test.ts',
        fixture: () => ({
          envId: 'env-1', zoneId: 'library',
          occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 82800 },
          occupantScheduleOverlay: {
            schedule: { count: 60, startSimTimeSec: 21600, endSimTimeSec: 86400 },
            startsAtSimSec: 86400, endsAtSimSec: 691200,
          },
          cleared: false, overlayCleared: false, appliedRuntimes: 1,
        }),
        render: payload => renderOccupantScheduleLines(payload as OccupantSchedulePatchResult),
        anchored: ['overlay — 60 people 21600s → 86400s (daily), window [86400s, 691200s)', '40 people 28800s → 82800s'],
      },
      {
        shape: 'overlay cleared (FEAT-07 phase-2) — says the base schedule governs again, never fabricates a window',
        coveredBy: 'env-occupant-schedule.render.vitest.test.ts',
        fixture: () => ({
          envId: 'env-1', zoneId: 'library',
          occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 82800 },
          occupantScheduleOverlay: null,
          cleared: false, overlayCleared: true, appliedRuntimes: 1,
        }),
        render: payload => renderOccupantScheduleLines(payload as OccupantSchedulePatchResult),
        anchored: ['overlay cleared — the base schedule governs again immediately'],
        forbidden: ['window [', 'null'],
      },
    ],
  },
  {
    face: 'scenario validate (human) — UX-11 success summary (counts + warnings ride the human line, same source as --json `counts`)',
    branches: [
      {
        shape: 'success, zero warnings — keeps the ✓ no issues line AND appends the entity-count summary (0 warnings)',
        coveredBy: 'scenario-validate.render.vitest.test.ts',
        fixture: () => ({
          file: 'demo.json', valid: true,
          counts: { zones: 2, devices: 3, agents: 4, flows: 5, events: 6 },
          errors: [], warnings: [],
        }),
        render: payload => renderScenarioValidation(payload as Parameters<typeof renderScenarioValidation>[0]),
        anchored: ['✓ no issues', '✓ valid — 2 zones, 3 devices, 4 agents, 5 flows, 6 events; 0 warnings'],
        forbidden: ['✗ ERROR', '⚠ WARN'],
      },
      {
        shape: 'success with warnings (meta-reference etc.) — warns listed, summary reports the warning count, still ✓ valid',
        coveredBy: 'scenario-validate.render.vitest.test.ts',
        fixture: () => ({
          file: 'demo.json', valid: true,
          counts: { zones: 1, devices: 1, agents: 1, flows: 0, events: 1 },
          errors: [],
          warnings: [{ level: 'warning', category: 'meta-reference', message: 'meta.heroEventId "evt-x" does not match any of the 1 declared events' }],
        }),
        render: payload => renderScenarioValidation(payload as Parameters<typeof renderScenarioValidation>[0]),
        anchored: ['⚠ WARN', '[meta-reference]', 'evt-x', '✓ valid — 1 zones', '1 warning', '0 errors, 1 warning'],
        forbidden: ['✗ ERROR', '✓ no issues'],
      },
      {
        shape: 'failure with errors (post-load) — every error with ✗, totals footer, no success summary',
        coveredBy: 'scenario-validate.render.vitest.test.ts',
        fixture: () => ({
          file: 'demo.json', valid: false,
          counts: { zones: 1, devices: 1, agents: 1, flows: 0, events: 1 },
          errors: [{ level: 'error', category: 'unmanned-zone', message: 'event "evt-1" zoneId "attic" is not in any agent\'s managesZoneIds' }],
          warnings: [],
        }),
        render: payload => renderScenarioValidation(payload as Parameters<typeof renderScenarioValidation>[0]),
        anchored: ['✗ ERROR', '[unmanned-zone]', 'attic', '1 error, 0 warnings'],
        forbidden: ['✓ valid', '✓ no issues'],
      },
    ],
  },
];

describe('render contract (T22): every human face survives every payload shape branch', () => {
  test('the inventory is non-empty and every face registers at least one branch', () => {
    expect(FACES.length).toBeGreaterThanOrEqual(6);
    for (const face of FACES) {
      expect(face.branches.length, `face "${face.face}" must register its shape branches`).toBeGreaterThan(0);
      for (const branch of face.branches) {
        expect(branch.coveredBy, `branch "${branch.shape}" must name its covering test file`).toBeTruthy();
      }
    }
  });

  for (const face of FACES) {
    for (const branch of face.branches) {
      test(`${face.face} :: ${branch.shape}`, () => {
        const rendered = JSON.stringify(branch.render(branch.fixture()));
        for (const token of branch.forbidden ?? []) {
          expect(rendered.includes(token), `forbidden token "${token}" leaked onto this branch`).toBe(false);
        }
        for (const token of branch.anchored ?? []) {
          expect(rendered.includes(token), `anchor token "${token}" missing from this branch`).toBe(true);
        }
      });
    }
  }
});
