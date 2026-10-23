/**
 * Agreements service layer — context (R21-W1 extraction).
 *
 * The service-context shape shared by every agreements module. Carved out
 * of routes/agreements.ts as a PURE MOVE (DevLoop R21 W1): the route file
 * keeps only Fastify wiring; terms resolution, sim targeting, read
 * delivery, stream invocation and serialization live here. The existing
 * HTTP-level suites (agreements ×4, data-services, trigger-autoexec,
 * counter-offers) are the contract and must pass UNCHANGED.
 */

import type { AgreementStreamSessions } from '../agreement-stream-sessions.js';
import type { ChangePipeline } from '../change-pipeline.js';
import type { AgreementStore } from '../db/agreement-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { FlowStore } from '../db/flow-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { ReputationStore } from '../db/reputation-store.js';
import type { ServiceStore } from '../db/service-store.js';
import type { UserStore } from '../db/user-store.js';
import type { SettlementProvider } from '../settlement.js';
import type { SimulationRegistry, SimulationRecord } from '../simulation-registry.js';

export interface AgreementRoutesContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  agreementStore: AgreementStore;
  userStore: UserStore;
  registry: SimulationRegistry;
  /**
   * Living-worlds P1W: the env-owned authoritative world session. When set,
   * the DATA lanes (reads + computation streams) with no explicit
   * simulationId target the env's session — the authoritative frame
   * (DB-F06's divergence closes: both consumers evaluate the same world).
   * Structural on purpose: tests may omit it (legacy behavior).
   */
  worldSessions?: {
    targetFor(envId: string): Promise<SimulationRecord | undefined>;
    observe(envId: string): Promise<() => void>;
    noteFreshnessObligation(envId: string): Promise<void>;
  };
  /** Fix-1 shared tail: executed invoke device commands land in command_log. */
  pipeline: ChangePipeline;
  /** Settlement SPI assembly point (§3.4) — NullSettlementProvider by default. */
  settlement: SettlementProvider;
  /** Fix-11 Phase 2 (§5): failed invokes score the provider's reputation. */
  reputationStore: ReputationStore;
  /** Fix-16: the persistent doorbell for proposals/decisions/failures. */
  notificationStore: NotificationStore;
  /** Stream ping cadence (Fix-15, F-21) — one missed pong ends the session. */
  streamHeartbeatMs: number;
  /** Wave-6: live stream sessions per hosting sim — closed when the sim stops. */
  streamSessions: AgreementStreamSessions;
  /**
   * R14 Wave-A: per-sim injected-event tallies — the countSince window for
   * ComputationSpec evaluation (reads + the push lane share it).
   */
  simEventTallies: { eventsOf(simId: string): Array<{ eventType: string; simTimeSec: number }> };
  /**
   * Mechanism D: flow-service invocation needs the backing flow's definition
   * (inputs oracle) and the propose-time terms gate. Optional so degenerate
   * harnesses can omit it — the flow paths refuse loudly when absent.
   */
  flowStore?: Pick<FlowStore, 'getById'>;
  /**
   * T-505 (CB24-F02): the trigger executor's armed-reset view accessor —
   * `GET /api/agreements/:id` surfaces a pending autoReset arm (same
   * visibility as the agreement itself: both parties + env owner). Runtime
   * state only: the field is absent when nothing is armed and the arm
   * vanishes with the sim. Late-bound by server.ts exactly like the T-035
   * executor registration.
   */
  armedResetView?: (agreementId: string) => import('../agreement-trigger-executor.js').ArmedResetView | undefined;
  /**
   * T128 (R20-u2 F1): the invoke lane's honest wait floor — how long POST
   * /api/agreements/:id/invocations keeps holding the HTTP connection while
   * the provider agent decides. Past it the route answers 503
   * INVOKE_DECISION_PENDING (+ retryAfterSec) and lets the execution finish
   * in the background (metering + receipt still land). Default 90_000 ms —
   * deliberately under the public gateway's 100s kill, so a slow-LLM window
   * yields the platform's teaching envelope instead of a bare 504. Test
   * seam: suites inject a small value.
   */
  invokeDecisionWaitMs?: number;
  /**
   * T129 (R21-F1): the consumption lanes' honest TARGETING wait floor (ms) —
   * how long session-targeting (the world-session wake/catch-up behind
   * resolveConsumptionTargetSimForLane) may hold the read lane / the stream
   * upgrade before answering 503 (READ_TARGETING_PENDING /
   * CONSUMPTION_TARGET_PENDING) + retryAfterSec while the targeting keeps
   * completing server-side. The invoke lane covers targeting under its
   * existing invokeDecisionWaitMs race (one floor for the whole lane — the
   * connection must stay under the gateway's ~100s kill). Default 90_000 ms;
   * test seam: suites inject a small value.
   */
  consumptionTargetWaitMs?: number;
}
