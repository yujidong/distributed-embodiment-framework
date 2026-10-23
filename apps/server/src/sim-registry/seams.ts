/**
 * Sim server seams (R21-W4 extraction from simulation-registry.ts; pure
 * move, zero semantic change).
 *
 * The post-construction wiring every LIVE runtime gets — flow-run ledger,
 * command audit, reputation persistence, ephemeral agreements, event tally,
 * agreement triggers, sim-timeline capture. create + every resume/rebuild
 * lane attach through here so no seam can be missed by a new lifecycle path.
 */

import { dirname } from 'node:path';

import { EventType, type AgentExperienceJSON, type EngineRuntime, type FlowRunRecord } from '@active-collaboration/core';

import type { ChangePipeline } from '../change-pipeline.js';
import type { AgentExperienceStore } from '../db/experience-store.js';
import type { FlowStore } from '../db/flow-store.js';
import type { ReputationStore } from '../db/reputation-store.js';
import type { ServiceStore } from '../db/service-store.js';
import {
  DeviceStateDedupe,
  deviceStateDataFields,
  simTimelineWriterOf,
  startZoneSampler,
} from '../sim-timeline.js';
import { sweepTrajectoryDir } from './timeline-compactor.js';
import type { EventTallySeam, RuntimeAttacher, SimulationRecord } from './types.js';

export interface SimSeamDeps {
  /** Flow-run ledger for env-backed sims (persistence faults never break the runtime). */
  flowStore?: FlowStore;
  /** Fix-44h: engine-issued device commands land in command_log. */
  commandLogPipeline?: ChangePipeline;
  /** P4-1: environment-backed reputation load/persist. */
  reputationStore?: ReputationStore;
  /** R6-E-F15: environment-backed private-experience load/persist. */
  experienceStore?: AgentExperienceStore;
  /** Fix-11 Phase 2: ephemeral agreements for AC handshakes (source='ac'). */
  agreementBridge?: RuntimeAttacher;
  /** R14 Wave-A: the injected-event tally (countSince window) for data services. */
  eventTally?: EventTallySeam;
  /**
   * R42-A/F3 §7.1: the env's service catalog. When set, every
   * environment-backed sim wires each agent's `listMyServices` seam to its
   * serviceStore rows (provider_agent_id = the agent, derived + published)
   * so the AC responder's prompt shows "YOUR SERVICES" — service semantics
   * finally enter the handshake decision path.
   */
  serviceStore?: ServiceStore;
  /**
   * P2: the world service catalog push-sync. When set, every
   * environment-backed sim gets the env's published/flow/aggregate services
   * mirrored into its runtime's EnvironmentCenter (attach-time snapshot +
   * live rebuild on catalog writes), so the in-core discovery paths see the
   * world-layer catalog unchanged.
   */
  serviceCatalogSync?: RuntimeAttacher;
  /**
   * FEAT-07: env-level occupantSchedule PATCH push-sync. When set, every
   * environment-backed sim registers its runtime so the PATCH route can
   * land schedule changes without an environment rebuild.
   */
  occupantScheduleSync?: RuntimeAttacher;
  /** Zone-parameter sampling cadence in simulated seconds (Fix-14 replay timeline). */
  zoneSampleEverySimSec: number;
  /** Per-SEGMENT cap for each simulation's sim-timeline log (T-011 → P2). */
  simTimelineMaxBytes: number;
  /**
   * Living-worlds P2: raw retention window (ms) for the rollup compactor;
   * 0 disables compaction entirely (raw kept until dir-level retention).
   */
  rollupWindowMs: number;
}

export class SimulationSeams {
  constructor(private readonly deps: SimSeamDeps) {}

  /**
   * Mechanism C (mixed-initiative flows §7): escalation delivery for
   * policy-envelope exhaustion. Late-assigned exactly like the T-035
   * agreement trigger (server.ts wires it once the notification store
   * exists; no simulation can run before the server listens). The sink turns
   * a run's policyEscalations into a notification to the env owner —
   * escalation only signals, it never modifies the flow.
   */
  private flowPolicyEscalationSink?: (escalation: {
    record: FlowRunRecord;
    environmentId: string;
  }) => void;

  setFlowPolicyEscalationSink(
    sink: (escalation: { record: FlowRunRecord; environmentId: string }) => void,
  ): void {
    this.flowPolicyEscalationSink = sink;
  }

  /**
   * Shared post-construction wiring (create + P0 resume): every server seam
   * a live runtime gets — flow-run ledger, command audit, reputation
   * persistence, ephemeral agreements, event tally, agreement triggers,
   * sim-timeline capture. Resume passes `rehydrating: true` to SKIP the
   * initial reputation load (the checkpoint's tracker is the truth the
   * hibernated run had learned). `agreementTrigger` is threaded per call —
   * the registry's late-assignment seam (T-035) reads its CURRENT value.
   */
  attach(
    record: SimulationRecord,
    options: {
      rehydrating?: boolean;
      agreementTrigger?: RuntimeAttacher;
      /** R40-A3：agent 升级事件 → env owner 通知桥（AGENT_ESCALATION）。 */
      agentEscalationBridge?: RuntimeAttacher;
      /** FEAT-05：flow notify 节点执行器（确定性通知车道）。 */
      flowNotifyExecutor?: RuntimeAttacher;
      /** R6-B-F03：flow service 节点执行器（合约中介的跨租户编排车道）。 */
      flowServiceExecutor?: RuntimeAttacher;
    } = {},
  ): void {
    const { runtime, id, environmentId, trajectoryDir } = record;

    // Flow run ledger: every execution of an env-backed sim lands a
    // flow_runs row (pruned per flow by the store). Persistence faults must
    // never break the runtime — the listener path is guarded.
    if (environmentId !== undefined && this.deps.flowStore) {
      const store = this.deps.flowStore;
      runtime.onFlowRun(rec => {
        try {
          store.recordRun({ ...rec, simulationId: id });
        } catch (error) {
          console.warn(`SimulationRegistry: flow run persist for sim ${id} failed:`, error);
        }
        // Mechanism C: surface policy-envelope exhaustion escalations to the
        // sink (best-effort by contract — a failed notification must never
        // break the runtime OR the ledger write above).
        if (rec.policyEscalations !== undefined && rec.policyEscalations.length > 0) {
          try {
            this.flowPolicyEscalationSink?.({ record: rec, environmentId });
          } catch (error) {
            console.warn(`SimulationRegistry: flow policy escalation for sim ${id} failed:`, error);
          }
        }
      });
    }

    // Fix-44h: engine-issued device commands (agent decisions, flow node
    // invocations) land in command_log so the audit trail covers EVERY
    // device action, not just user-issued ones. The synthetic actor is
    // self-describing ('engine:agent:<agentId>' / 'engine:flow:<flowId>');
    // the payload carries display names for serializers.
    if (environmentId !== undefined && this.deps.commandLogPipeline) {
      const pipeline = this.deps.commandLogPipeline;
      const simId = id;
      // T45 (R4 u3-F5): one logical command used to land TWICE here — the
      // device's own DEVICE_OPERATION_EXECUTED emission (richest: deviceName)
      // plus the DeviceCommandCoordinator echo ~2ms later (carries agentId,
      // no deviceName → the echo row rendered a bare UUID). Same T-102 dedupe
      // as the trajectory wiring: keyed (device|command|params|success), a
      // 2s wall-clock window; FIRST arrival (the device's, with deviceName)
      // wins. Wall-clock, not sim time: identical commands in a paused world
      // still both record.
      const seen = new Map<string, number>();
      const DEDUPE_WINDOW_MS = 2000;
      runtime.subscribe(event => {
        if (event.type !== EventType.DEVICE_OPERATION_EXECUTED) return;
        const payload = event.payload as {
          deviceId?: unknown; deviceName?: unknown;
          commandName?: unknown; params?: unknown;
          result?: { success?: unknown; error?: unknown };
          executionTime?: unknown;
        } | undefined;
        if (typeof payload?.deviceId !== 'string') return;
        const success = payload.result?.success !== false;
        if (!success) return; // failures are not audit-worthy state changes
        let paramsKey = '';
        try {
          paramsKey = payload.params === undefined ? '' : JSON.stringify(payload.params) ?? '';
        } catch { paramsKey = ''; }
        const dedupeKey =
          `${payload.deviceId}|${typeof payload.commandName === 'string' ? payload.commandName : ''}|${paramsKey}|${success}`;
        const now = Date.now();
        const last = seen.get(dedupeKey);
        if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return; // the coordinator echo
        if (seen.size > 512) seen.clear();
        seen.set(dedupeKey, now);
        try {
          pipeline.log({
            envId: environmentId,
            actorId: `engine:sim:${simId}`,
            kind: 'engine-device-command',
            payload: {
              deviceId: payload.deviceId,
              ...(typeof payload.deviceName === 'string' ? { deviceName: payload.deviceName } : {}),
              ...(typeof payload.commandName === 'string' ? { commandName: payload.commandName } : {}),
              ...(payload.params !== undefined ? { params: payload.params } : {}),
              simId,
            },
            simTime: runtime.getSimTimeSec(),
          });
        } catch {
          // Audit failures must never break the runtime
        }
      }, [EventType.DEVICE_OPERATION_EXECUTED]);
    }

    // T33 (R3 u3-F3): event-injection AUDIT rows — `sim inject` (and the
    // scenario script's own scheduled injections, which ride the same
    // injectEvent lane) land {kind:'event', action:'injected'} in
    // command_log, so "who pulled the fire alarm" is answerable from the
    // activity feed. actor = the injecting user's account id when a platform
    // user pulled the trigger (T33 injectedById), 'scenario' for script-
    // scheduled fires. Audit failures never break the runtime.
    if (environmentId !== undefined && this.deps.commandLogPipeline) {
      const pipeline = this.deps.commandLogPipeline;
      runtime.onInjectedEvent(record => {
        try {
          pipeline.log({
            envId: environmentId,
            actorId: record.injectedById ?? 'scenario',
            kind: 'event',
            payload: {
              action: 'injected',
              eventType: record.type,
              zoneId: record.zoneId,
              parameter: record.parameter,
              value: record.value,
              ...(record.severity !== undefined ? { severity: record.severity } : {}),
              eventId: record.eventId,
              ...(record.injectedBy !== undefined ? { injectedBy: record.injectedBy } : {}),
              ...(record.routingLevel !== undefined ? { routingLevel: record.routingLevel } : {}),
              simId: id,
            },
            simTime: record.simTimeSec,
          });
        } catch {
          // Audit failures must never break the runtime
        }
      });
    }

    // R6-E-F15: environment-backed sims carry PRIVATE agent experience
    // (learned meta-cognition: quality ring + partner trust) across runs —
    // load BEFORE the reputation load so the reputation push (R40-A2) still
    // refreshes the platform face of restored trust records, persist back
    // as outcomes arrive. Forks/sandboxes have no environmentId, so they
    // never load and never write back (S2 privacy, same as reputation).
    if (environmentId !== undefined && this.deps.experienceStore) {
      if (options.rehydrating !== true) {
        this.loadExperiences(environmentId, runtime);
      }
      runtime.subscribe(
        () => this.persistExperiences(environmentId, runtime),
        EventType.COLLABORATION_COMPLETED,
      );
    }

    // P4-1: environment-backed sims carry reputation across runs — load the
    // env's rows into the tracker now, persist back as outcomes arrive.
    if (environmentId !== undefined && this.deps.reputationStore) {
      if (options.rehydrating !== true) {
        this.loadReputation(environmentId, runtime);
      }
      runtime.subscribe(
        () => this.persistReputation(environmentId, runtime),
        EventType.COLLABORATION_COMPLETED,
      );
    }

    // Fix-11 Phase 2: ephemeral agreements for AC handshakes (source='ac').
    if (environmentId !== undefined && this.deps.agreementBridge) {
      this.deps.agreementBridge.attach(environmentId, runtime);
    }

    // R14 Wave-A: the injected-event tally (countSince window) for data
    // service computations — env-backed sims only (data services are env
    // concepts; legacy scenario sims keep the core behavior).
    if (environmentId !== undefined && this.deps.eventTally) {
      this.deps.eventTally.attach(id, runtime);
    }

    // R42-A/F3 §7.1: service semantics into the AC responder — each agent's
    // `listMyServices` seam reads its own serviceStore rows LIVE (derived +
    // published: servicesOf(envId) filtered by provider_agent_id = agent).
    // All agents are built before the runtime is returned, so the loop
    // covers everyone; store faults degrade to an empty face (the seam
    // itself is defensive) and never break the runtime.
    if (environmentId !== undefined && this.deps.serviceStore) {
      const store = this.deps.serviceStore;
      const envId = environmentId;
      const faceOf = (agentId: string) =>
        store.servicesOf(envId)
          .filter(row => row.provider_agent_id === agentId)
          // P5: origin rides the face — the handshake trajectory carries it
          // for the service-origin funnel (eval-report services section).
          .map(row => ({ name: row.name, semanticType: row.semantic_type, visibility: row.visibility, origin: row.origin }));
      for (const agentDef of record.scenario.agents) {
        runtime.getAgent(agentDef.id)?.setMyServicesProvider(() => faceOf(agentDef.id));
      }
    }

    // P2: the world service catalog enters the runtime's EnvironmentCenter
    // (published/flow/aggregate rows; derived rows the runtime derives
    // itself). After this, every in-core discovery path — ServiceBroker,
    // DualTriggerACManager, PartnerSelectionNegotiator — sees world-layer
    // services with zero changes of its own. The seam is defensive: store
    // faults degrade to an empty mirror, never break the runtime.
    if (environmentId !== undefined && this.deps.serviceCatalogSync) {
      this.deps.serviceCatalogSync.attach(environmentId, runtime);
    }

    // FEAT-07: register the runtime for env-level occupantSchedule PATCH
    // pushes (no snapshot work — the fresh runtime already carries the
    // env's current schedules; the seam only needs the live handle).
    if (environmentId !== undefined && this.deps.occupantScheduleSync) {
      this.deps.occupantScheduleSync.attach(environmentId, runtime);
    }

    // T-035: match injected events against the env's active agreements'
    // trigger clauses (metered auto-execution of the agreed action).
    // FEAT-08: the record id rides along — the metered usage rows attribute
    // the SIM, and runtime.id is the env id on env-backed worlds.
    if (environmentId !== undefined && options.agreementTrigger) {
      options.agreementTrigger.attach(environmentId, runtime, id);
    }

    // R40-A3（§7.5 升级通道）：agent 升级事件 → env owner 通知（只通知不
    // 执行的决策在这里获得"门铃"；env-backed 专属——通知是环境概念）。
    if (environmentId !== undefined && options.agentEscalationBridge) {
      options.agentEscalationBridge.attach(environmentId, runtime);
    }

    // FEAT-05（确定性通知车道）：flow notify 节点 → 环境通知管道
    // （agent→owner / role→members / owner；收件人回执进运行台账节点结果）。
    if (environmentId !== undefined && options.flowNotifyExecutor) {
      options.flowNotifyExecutor.attach(environmentId, runtime);
    }

    // R6-B-F03（跨租户编排车道）：flow service 节点 → 合约中介的统一
    // invocation 核心（配额/terms/审计/计量与手动 invoke 同道；env-backed
    // 专属——消费方身份来自 flow 作者，非 env-backed runtime 诚实失败）。
    if (environmentId !== undefined && options.flowServiceExecutor) {
      options.flowServiceExecutor.attach(environmentId, runtime);
    }

    // Fix-14: sim timeline capture (zone samples + device state changes) so
    // replays over a simulation window contain the sim-side timeline, not
    // just command_log entries. Legacy scenario sims keep trajectory-only.
    if (environmentId !== undefined && trajectoryDir !== undefined) {
      this.attachSimTimeline(environmentId, id, trajectoryDir, runtime);
    }
    // P2F (living-worlds §10.4, 缺口二): a SANDBOX sim (sourceEnvId set, no
    // env backing) also records its timeline — with environmentId carrying
    // the SOURCE env (parity with the trajectory records' scenario keying,
    // so the fork's timeline reaches env-level exports) and an EXPLICIT
    // forkId on every record. No other seam attaches: the fork writes no
    // learned state back (S2 privacy contract).
    if (
      environmentId === undefined &&
      record.sourceEnvId !== undefined &&
      record.forkId !== undefined &&
      trajectoryDir !== undefined
    ) {
      this.attachSimTimeline(record.sourceEnvId, id, trajectoryDir, runtime, record.forkId);
    }
  }

  /**
   * Fix-14: record the sim-side timeline of an environment-backed run into
   * `<trajectoryDir>/sim-timeline/` (P2 segmented log) — periodic
   * zone-parameter samples plus device state changes. The bus exposes two
   * seams: DEVICE_STATE_CHANGE (EnvironmentCenter.executeService path) and
   * DEVICE_OPERATION_EXECUTED (DeviceCommandCoordinator path — the one
   * manual/agent commands actually take); both are recorded as
   * `device-state` records (failed operations are not state changes and are
   * skipped; T-102 dedupes the same command's two emissions by
   * (simTimeSec, deviceId, service) — first wins). The sampler self-clears
   * once the runtime stops; the bus subscription is cleaned up by
   * runtime.stop().
   *
   * Living-worlds P2: every timeline write carries the rotation hook — when
   * the active segment seals at the cap, the compactor sweeps THIS sim's dir
   * (bounded batch; rotation cadence = compaction cadence for hot writers).
   */
  private attachSimTimeline(
    environmentId: string,
    simId: string,
    trajectoryDir: string,
    runtime: EngineRuntime,
    forkId?: string,
  ): void {
    // Living-worlds P2: on-rotation compaction hook (rollup window from the
    // registry-threaded knob; 0 disables). Failures inside sweepTrajectoryDir
    // are contained; the append that triggered the rotation already landed.
    const onRotate = this.deps.rollupWindowMs > 0
      ? (info: { segmentDir: string }): void => {
          sweepTrajectoryDir(dirname(info.segmentDir), {
            rollupWindowMs: this.deps.rollupWindowMs,
          });
        }
      : undefined;
    // R30 Task 5: both timeline lanes (zone samples + device states) ride
    // ONE batched writer per sim — flushed every 100 records / 1s and
    // drained by the registry's stop paths (closeSimTimelineWriter).
    const writer = simTimelineWriterOf(simId, trajectoryDir, {
      maxFileBytes: this.deps.simTimelineMaxBytes,
      ...(onRotate !== undefined ? { onRotate } : {}),
    });
    startZoneSampler({
      runtime,
      dir: trajectoryDir,
      environmentId,
      simId,
      ...(forkId !== undefined ? { forkId } : {}),
      everySimSec: this.deps.zoneSampleEverySimSec,
      writer,
    });
    // T-102 (F-PH24): one command lands on BOTH bus seams — the device's own
    // DEVICE_OPERATION_EXECUTED emission and the coordinator/EnvironmentCenter
    // echo ~2ms later (R29 measured 23/28 timeline keys duplicated). The
    // recorder dedupes by (simTimeSec, deviceId, service): first arrival wins
    // (it is the device's own, richest record), the echo is dropped.
    const dedupe = new DeviceStateDedupe();
    runtime.subscribe(event => {
      const payload = event.payload as {
        deviceId?: unknown;
        service?: unknown;
        commandName?: unknown;
        success?: unknown;
        error?: unknown;
        actor?: unknown;
      } | undefined;
      if (typeof payload?.deviceId !== 'string') return;
      if (payload.success === false || payload.error !== undefined) return; // 失败 ≠ 状态变化
      const service = typeof payload.service === 'string' ? payload.service
        : typeof payload.commandName === 'string' ? payload.commandName
        : undefined;
      const simTimeSec = runtime.getSimTimeSec();
      if (!dedupe.admit(DeviceStateDedupe.keyOf({ simTimeSec, deviceId: payload.deviceId, service }))) {
        return; // T-102: the second seam's echo of an already-recorded command
      }
      writer.append({
        kind: 'device-state',
        environmentId,
        simId,
        ...(forkId !== undefined ? { forkId } : {}),
        simTimeSec,
        recordedAt: new Date().toISOString(),
        deviceId: payload.deviceId,
        ...(service !== undefined ? { service } : {}),
        // T-039 (FF-F10 residue): the changed fields ride the record —
        // command params (intent) + the reported result (effect), bounded
        // JSON clones so the 50MB file cap stays meaningful.
        ...deviceStateDataFields(payload as Record<string, unknown>),
        // R17 params-purity: the invocation-context actor rides the record's
        // TOP-LEVEL `actor` field (params stay the pure semantic arguments).
        ...(typeof payload.actor === 'string' && payload.actor.length > 0
          ? { actor: payload.actor }
          : {}),
      });
    }, [EventType.DEVICE_STATE_CHANGE, EventType.DEVICE_OPERATION_EXECUTED]);
  }

  /** Load an env's persisted reputation rows into the runtime's tracker (P4-1). */
  loadReputation(environmentId: string, runtime: EngineRuntime): void {
    if (!this.deps.reputationStore) return;
    try {
      const rows = this.deps.reputationStore.rowsForEnv(environmentId);
      // R101: keep the load-time baseline — persistReputation merges the
      // tracker's DELTA additively instead of wholesale-overwriting rows
      // the invoke lane may have incremented while the sim ran (zhao-17).
      // T71: the baseline covers the integer event buckets too.
      const baseline = new Map<string, {
        attempts: number; successes: number; failures: number;
        successEvents: number; partialEvents: number; failureEvents: number;
      }>();
      for (const row of rows) {
        baseline.set(`${row.agent_id}::${row.capability}`, {
          attempts: row.attempts,
          successes: row.successes,
          failures: row.failures,
          successEvents: row.success_events ?? 0,
          partialEvents: row.partial_events ?? 0,
          failureEvents: row.failure_events ?? 0,
        });
      }
      this.reputationBaselines.set(runtime, baseline);
      runtime.loadReputationJSON({
        version: 2,
        records: rows.map(row => ({
          agentId: row.agent_id,
          capability: row.capability,
          attempts: row.attempts,
          successes: row.successes,
          failures: row.failures,
          ...(row.success_events !== null || row.partial_events !== null || row.failure_events !== null
            ? {
                successEvents: row.success_events ?? 0,
                partialEvents: row.partial_events ?? 0,
                failureEvents: row.failure_events ?? 0,
              }
            : {}),
          lastAt: row.last_at,
        })),
      });
    } catch (error) {
      // Persistence failures must never block a simulation from starting.
      console.warn(`SimulationRegistry: reputation load for env ${environmentId} failed:`, error);
    }
  }

  /**
   * R101: load-time baselines per runtime (WeakMap — the runtime owns the
   * entry's lifetime). Used by persistReputation's additive delta merge.
   */
  private readonly reputationBaselines = new WeakMap<
    EngineRuntime,
    Map<string, {
      attempts: number; successes: number; failures: number;
      successEvents: number; partialEvents: number; failureEvents: number;
    }>
  >();

  /**
   * Persist the runtime's learned reputation back to its env's rows (P4-1).
   * R101: ADDITIVE delta merge — the tracker loaded a baseline at sim start;
   * only what it LEARNED since is merged in, so increments written by the
   * invoke lane while the sim ran (recordOutcome on explicit metered usage)
   * are never clobbered by a stale snapshot.
   */
  persistReputation(environmentId: string, runtime: EngineRuntime): void {
    if (!this.deps.reputationStore) return;
    try {
      const baseline = this.reputationBaselines.get(runtime);
      const records = runtime.getReputationJSON().records;
      if (baseline === undefined) {
        // No baseline (load never ran — legacy scenario sim): the additive
        // merge of the full contents is exactly the old wholesale upsert.
        this.deps.reputationStore.saveForEnv(environmentId, records);
        return;
      }
      const deltas = records
        .map(record => {
          const base = baseline.get(`${record.agentId}::${record.capability}`) ?? {
            attempts: 0,
            successes: 0,
            failures: 0,
            successEvents: 0,
            partialEvents: 0,
            failureEvents: 0,
          };
          return {
            ...record,
            attempts: Math.max(0, record.attempts - base.attempts),
            successes: Math.max(0, record.successes - base.successes),
            failures: Math.max(0, record.failures - base.failures),
            // T71: the event buckets ride the same delta discipline. A legacy
            // baseline row (loaded with implicit 0 buckets) yields an
            // integerized-full delta on the first persist — bounded by the
            // row's own counts, never negative.
            successEvents: Math.max(0, (record.successEvents ?? 0) - base.successEvents),
            partialEvents: Math.max(0, (record.partialEvents ?? 0) - base.partialEvents),
            failureEvents: Math.max(0, (record.failureEvents ?? 0) - base.failureEvents),
          };
        })
        .filter(record =>
          record.attempts > 0 || record.successes > 0 || record.failures > 0 ||
          record.successEvents > 0 || record.partialEvents > 0 || record.failureEvents > 0);
      if (deltas.length > 0) this.deps.reputationStore.mergeForEnv(environmentId, deltas);
      // The baseline ADVANCES with every persist — COLLABORATION_COMPLETED
      // persists mid-sim too, and a load-time-only baseline would re-apply
      // the same learned increments on every call (the 10-instead-of-5
      // double count).
      for (const record of records) {
        baseline.set(`${record.agentId}::${record.capability}`, {
          attempts: record.attempts,
          successes: record.successes,
          failures: record.failures,
          successEvents: record.successEvents ?? 0,
          partialEvents: record.partialEvents ?? 0,
          failureEvents: record.failureEvents ?? 0,
        });
      }
    } catch (error) {
      console.warn(`SimulationRegistry: reputation persist for env ${environmentId} failed:`, error);
    }
  }

  /**
   * Load an env's persisted private-experience snapshots into the agents'
   * meta-cognition (R6-E-F15). A corrupt row is skipped (one bad snapshot
   * must not deny every other agent its experience); a store failure only
   * warns — persistence faults never block a simulation from starting.
   */
  loadExperiences(environmentId: string, runtime: EngineRuntime): void {
    if (!this.deps.experienceStore) return;
    try {
      const rows = this.deps.experienceStore.rowsForEnv(environmentId);
      const agents: AgentExperienceJSON['agents'] = [];
      for (const row of rows) {
        try {
          agents.push({
            agentId: row.agent_id,
            metaCognition: JSON.parse(row.experience_json),
          });
        } catch {
          console.warn(
            `SimulationRegistry: experience row for agent ${row.agent_id} in env ${environmentId} ` +
            'is not valid JSON — skipped',
          );
        }
      }
      runtime.loadAgentExperienceJSON({ version: 1, agents });
    } catch (error) {
      console.warn(`SimulationRegistry: experience load for env ${environmentId} failed:`, error);
    }
  }

  /**
   * Upsert the runtime's learned private experience back to its env's rows
   * (R6-E-F15). Only agents that learned something appear in the runtime's
   * snapshot — all-zero agents neither write rows nor get polluted.
   */
  persistExperiences(environmentId: string, runtime: EngineRuntime): void {
    if (!this.deps.experienceStore) return;
    try {
      const snapshot = runtime.getAgentExperienceJSON();
      this.deps.experienceStore.saveForEnv(
        environmentId,
        snapshot.agents.map(entry => ({
          agentId: entry.agentId,
          experienceJson: JSON.stringify(entry.metaCognition),
        })),
      );
    } catch (error) {
      console.warn(`SimulationRegistry: experience persist for env ${environmentId} failed:`, error);
    }
  }
}
