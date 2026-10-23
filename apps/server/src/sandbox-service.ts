/**
 * Sandbox service — P-C sandbox forks
 * (multi-user-simulation-design.md §3 Layer 0, §11 P-C; living-worlds §10)
 *
 * A sandbox is an isolated in-memory world forked from an environment:
 * the environment's current contents (base layer) are snapshotted into a
 * ScenarioDefinition via the environment bridge and fed to a private
 * EngineRuntime in the simulation registry. Everything that happens inside
 * stays inside — nothing is written back to the shared environment store,
 * and nothing is broadcast to the environment's world-sync channel (the
 * runtime never touches WorldSync; the registry's only shared-store write
 * path, P4-1 reputation persistence, is skipped because sandbox sims are
 * created WITHOUT an environmentId).
 *
 * Overlay selection (fork body `overlays: [proposalId...]`): each id must
 * name an APPLIED inject-scenario proposal of this environment; only the
 * map-data events that proposal injected (id prefix `<proposalId>:`) are
 * kept in the snapshot. Omitting `overlays` forks the world as-is (all
 * current events); passing `[]` forks the pure base layer (no proposal
 * events — events baked into the map data directly always stay).
 *
 * P2F (living-worlds §10):
 * - 便宜 fork (`fromCheckpoint: true`): fork from the authoritative world's
 *   CURRENT dynamics — a live session is paused-at-a-boundary + exported +
 *   resumed (sub-second, no hibernate churn); a hibernated session (or a
 *   checkpoint left by a previous process) is copied from its checkpoint
 *   file. Topology rebuilds from the env's CURRENT rows (§9's "sim owns
 *   dynamics, env owns topology"), so the fork starts from the world's
 *   moment instead of a frozen scenario. One-way copy: nothing flows back.
 * - Lineage (§10.4): every fork records `{overlays, policy,
 *   checkpointId?, scenarioFingerprint?}` in fork_base_json + the row's
 *   id/stamps; fork sims stamp their timeline records with forkId.
 * - Membership (§10.2): owner-invited builders/viewers (sandbox_members);
 *   joining changes where you experiment, never anyone's authoritative
 *   rights. Quota stays holder-based.
 *
 * Lifecycle: `stop` tears the registry instance down and marks the row
 * stopped (idempotent); `stopAllForEnvironment` is the cascade hook the
 * environment-delete route calls before the row removal cascades.
 */

import { randomUUID } from 'node:crypto';

import type { ScenarioDefinition } from '@active-collaboration/core';

import type { AuthUser } from './auth/index.js';
import { environmentToScenario } from './environment-bridge.js';
import { ApiError } from './errors.js';
import { forkLineageOf, scenarioFingerprintOf } from './fork-lineage.js';
import type { EnvironmentRow, EnvironmentStore } from './db/environment-store.js';
import { parseMapData } from './db/environment-store.js';
import type { ProposalStore } from './db/proposal-store.js';
import type {
  SandboxMemberRole,
  SandboxRow,
  SandboxStore,
} from './db/sandbox-store.js';
import { assertQuota, type QuotaConfig } from './quotas.js';
import type { CreateSimulationOptions } from './sim-registry/types.js';
import type { SimulationRegistry } from './simulation-registry.js';
import type { WorldCheckpointFile } from './world-checkpoint.js';
import { readWorldCheckpoint } from './world-checkpoint.js';

/** The deterministic id of an env's authoritative world session. */
export const worldSessionSimIdOf = (envId: string): string => `sim-${envId}-world-session`;

/**
 * HIL reverse-mapping P2 (shadow worlds, design-hil-reverse-mapping.md
 * §2-P2): optional fork customization for callers that need the fork's
 * scenario/runtime shaped differently from a plain sandbox. Everything else
 * — quota, lineage (fork_base_json), expiry, sweep, env-delete cascade —
 * stays on the shared sandbox path.
 */
export interface SandboxForkHooks {
  /** Transform the bridged scenario before the runtime build (e.g. a shadow neutralizes hass:// bindings). */
  transformScenario?: (scenario: ScenarioDefinition) => ScenarioDefinition;
  /** Engine create options for the fork build (e.g. a deviceFactory). */
  createOptions?: CreateSimulationOptions;
  /** Extra fork_base policy markers (e.g. { shadow: true }). */
  policyExtra?: Record<string, unknown>;
}

export interface SandboxServiceDeps {
  envStore: EnvironmentStore;
  proposalStore: ProposalStore;
  sandboxStore: SandboxStore;
  registry: SimulationRegistry;
  quotas: QuotaConfig;
  /**
   * P2F §10.1: locate a world-session checkpoint a previous process left on
   * disk for this env (used when no in-memory/hibernated session exists).
   */
  findSessionCheckpoint?: (envId: string) => string | undefined;
  /**
   * P2F §10.3: the deployment retention knob (EAF_FORK_MAX_AGE_DAYS in ms)
   * — stamped onto each fork row as its explicit expires_at ceiling.
   */
  forkMaxAgeMs?: number;
}

export class SandboxService {
  constructor(private readonly deps: SandboxServiceDeps) {}

  /**
   * Fork `env` into a fresh sandbox for `user`. `overlays === undefined`
   * keeps every current map event; a provided array selects which applied
   * inject-scenario proposals' events survive (`[]` = pure base layer).
   */
  async fork(
    env: EnvironmentRow,
    user: AuthUser,
    overlays?: string[],
    hooks?: SandboxForkHooks,
  ): Promise<SandboxRow> {
    const { sandboxStore, registry, quotas } = this.deps;

    if (overlays !== undefined) this.validateOverlays(env, overlays);
    assertQuota(
      'sandboxes_per_user_per_env',
      quotas.maxSandboxesPerUserPerEnv,
      sandboxStore.countActiveForUser(env.id, user.id),
      // S3 (Task 2): a bare "3/3 in use" teaches nothing — name the release
      // path AND the knob so the caller can self-correct either way.
      'stop a sandbox you no longer need (POST /api/sandboxes/:id/stop releases its ' +
        'slot) or ask the operator to raise QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV. ' +
        'Unused forks are also swept automatically after EAF_FORK_MAX_AGE_DAYS (default 7)',
    );

    const bridged = environmentToScenario(
      this.snapshotWithEvents(env, overlays),
      this.deps.envStore.devicesOf(env.id),
      this.deps.envStore.agentsOf(env.id),
    );
    const scenario = hooks?.transformScenario !== undefined ? hooks.transformScenario(bridged) : bridged;
    // No environmentId: a sandbox sim is NOT environment-backed — the
    // registry then skips the P4-1 reputation load/persist wiring, its only
    // path that would write learned state back into the shared store.
    // S2 (device privacy): sourceEnvId marks the fork's READS for the
    // privacy seam — creation still copies full device state (the ratified
    // fork trade-off: faithful private physics), but snapshot/timeline/
    // stream reads project foreign devices coarse, same as env-backed sims.
    // P2F: forkId pre-generated so the sim's timeline records carry the
    // explicit lineage key (§10.4) from their first line.
    const forkId = randomUUID();
    const record = await registry.create(
      scenario, hooks?.createOptions ?? {}, undefined, user.id, undefined, env.id, forkId,
    );

    return sandboxStore.create({
      envId: env.id,
      ownerId: user.id,
      id: forkId,
      // P2F §10.1/§10.4: the fork parameters — overlays (null = "the world
      // as it was"), the runtime policy the fork runs with, and the
      // fork-moment scenario fingerprint (machine-checkable provenance).
      forkBase: {
        overlays: overlays ?? null,
        policy: { scheduling: 'tick', ...hooks?.policyExtra },
        scenarioFingerprint: scenarioFingerprintOf(scenario),
      },
      simulationId: record.id,
      ...(this.deps.forkMaxAgeMs !== undefined
        ? { expiresAt: new Date(Date.now() + this.deps.forkMaxAgeMs).toISOString() }
        : {}),
    });
  }

  /**
   * P2F §10.1 便宜 fork (create-from-checkpoint): fork the world's CURRENT
   * dynamics into a private sandbox — "from the world's moment", not "from
   * a frozen scenario". Source resolution order:
   *
   * 1. a LIVE authoritative session (in-registry) → pause-at-boundary +
   *    export + resume (§6.3's clean-boundary discipline, minus the swap);
   * 2. a HIBERNATED session (in-registry) → its checkpoint file;
   * 3. a checkpoint a PREVIOUS process left on disk (findSessionCheckpoint).
   *
   * Topology always rebuilds from the env's CURRENT rows (overlays applied
   * on top, same semantics as the static fork); the copied world state
   * carries the dynamics (physical fields, RNG, fired dues, tally ring).
   * Single-copy boundary: the authoritative world is untouched; the fork
   * never flows back (§1).
   */
  async forkFromCheckpoint(
    env: EnvironmentRow,
    user: AuthUser,
    overlays?: string[],
    hooks?: SandboxForkHooks,
  ): Promise<SandboxRow> {
    const { sandboxStore, registry, quotas } = this.deps;
    if (overlays !== undefined) this.validateOverlays(env, overlays);
    assertQuota(
      'sandboxes_per_user_per_env',
      quotas.maxSandboxesPerUserPerEnv,
      sandboxStore.countActiveForUser(env.id, user.id),
      'stop a sandbox you no longer need (POST /api/sandboxes/:id/stop releases its ' +
        'slot) or ask the operator to raise QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV. ' +
        'Unused forks are also swept automatically after EAF_FORK_MAX_AGE_DAYS (default 7)',
    );

    const sessionSimId = worldSessionSimIdOf(env.id);
    let world: WorldCheckpointFile['world'];
    let eventTally: WorldCheckpointFile['eventTally'] | undefined;
    let checkpointId: string;

    const live = registry.get(sessionSimId);
    const hibernated = live === undefined ? registry.getHibernated(sessionSimId) : undefined;
    if (live !== undefined) {
      const exported = await registry.exportLiveSessionWorld(sessionSimId);
      world = exported.world;
      eventTally = exported.eventTally;
      checkpointId = `${sessionSimId}@live:${exported.world.simTimeSec}`;
    } else if (hibernated !== undefined) {
      const checkpoint = readWorldCheckpoint(hibernated.checkpoint.path);
      world = checkpoint.world;
      eventTally = checkpoint.eventTally;
      checkpointId = `${sessionSimId}@${checkpoint.world.simTimeSec}`;
    } else {
      const path = this.deps.findSessionCheckpoint?.(env.id);
      if (path === undefined) {
        throw new ApiError(
          409,
          'NO_WORLD_CHECKPOINT',
          `Environment "${env.id}" has no authoritative world session to fork from — ` +
            'its world has never run (no session, no checkpoint on disk). Fork from the ' +
            'frozen scenario instead (drop "fromCheckpoint"), or wake the world first ' +
            '(any env data read/stream creates the session).',
        );
      }
      // readWorldCheckpoint's teaching errors (corrupt / foreign version)
      // propagate: an unusable checkpoint must not silently degrade into a
      // t=0 fork (design §12.3 — the slow path stays available via replay).
      const checkpoint = readWorldCheckpoint(path);
      world = checkpoint.world;
      eventTally = checkpoint.eventTally;
      checkpointId = `${sessionSimId}@${checkpoint.world.simTimeSec}`;
    }

    // Topology: the env's CURRENT rows with the overlay selection applied —
    // same semantics as the static fork path (schema drift resolves to the
    // current world, §9).
    const bridged = environmentToScenario(
      this.snapshotWithEvents(env, overlays),
      this.deps.envStore.devicesOf(env.id),
      this.deps.envStore.agentsOf(env.id),
    );
    const scenario = hooks?.transformScenario !== undefined ? hooks.transformScenario(bridged) : bridged;

    const forkId = randomUUID();
    const record = await registry.createForkFromWorldState({
      scenario,
      world,
      ...(eventTally !== undefined ? { eventTally } : {}),
      sourceEnvId: env.id,
      forkId,
      createdBy: user.id,
      ...(hooks?.createOptions !== undefined ? { options: hooks.createOptions } : {}),
    });

    return sandboxStore.create({
      envId: env.id,
      ownerId: user.id,
      id: forkId,
      forkBase: {
        overlays: overlays ?? null,
        policy: { scheduling: 'tick', fromCheckpoint: true, ...hooks?.policyExtra },
        checkpointId,
        scenarioFingerprint: scenarioFingerprintOf(scenario),
      },
      simulationId: record.id,
      ...(this.deps.forkMaxAgeMs !== undefined
        ? { expiresAt: new Date(Date.now() + this.deps.forkMaxAgeMs).toISOString() }
        : {}),
    });
  }

  /** Stop a sandbox: release the registry instance, mark the row (idempotent). */
  stop(sandbox: SandboxRow): SandboxRow {
    if (sandbox.status === 'stopped') return sandbox;
    if (sandbox.simulation_id !== null) {
      this.deps.registry.stopAndRemove(sandbox.simulation_id);
    }
    return this.deps.sandboxStore.markStopped(sandbox.id);
  }

  /**
   * Cascade hook for environment deletion: stop every active sandbox's
   * runtime before the environment row (and its sandbox rows) disappear.
   */
  stopAllForEnvironment(envId: string): void {
    for (const sandbox of this.deps.sandboxStore.activeForEnv(envId)) {
      this.stop(sandbox);
    }
  }

  // ---------------------------------------------------------------------------
  // P2F §10.2: membership join
  // ---------------------------------------------------------------------------

  /**
   * Invite (or re-role) a member. Inviter must be the fork owner or the env
   * owner (§10.2: "owner（fork 持有者）可邀请 builder/viewer"); the env owner
   * is the governance principal over every fork of their world.
   */
  inviteMember(
    sandbox: SandboxRow,
    inviter: AuthUser,
    userId: string,
    role: SandboxMemberRole,
  ): void {
    this.assertForkManageAccess(sandbox, inviter);
    if (userId === sandbox.owner_id) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'The fork owner already holds every role — invite a different user',
      );
    }
    const env = this.deps.envStore.getEnvironment(sandbox.env_id);
    if (env === undefined) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${sandbox.env_id}" not found`);
    }
    if (this.deps.envStore.roleOf(sandbox.env_id, userId) === undefined) {
      throw new ApiError(
        409,
        'NOT_AN_ENV_MEMBER',
        `User "${userId}" is not a member of environment "${sandbox.env_id}" — forks are ` +
          'joinable world contexts INSIDE an environment; join the environment first ' +
          '(POST /api/environments/:id/join or an owner invite)',
      );
    }
    this.deps.sandboxStore.addMember({
      sandboxId: sandbox.id,
      userId,
      role,
      invitedBy: inviter.id,
    });
  }

  /** Remove a member: fork owner / env owner, or the member themself (leave). */
  removeMember(sandbox: SandboxRow, actor: AuthUser, userId: string): void {
    if (actor.id !== userId) {
      this.assertForkManageAccess(sandbox, actor);
    }
    if (!this.deps.sandboxStore.removeMember(sandbox.id, userId)) {
      throw new ApiError(404, 'SANDBOX_MEMBER_NOT_FOUND', `Member "${userId}" not found on sandbox "${sandbox.id}"`);
    }
  }

  /**
   * The acting user's fork role: 'owner' (fork holder), the env owner's
   * implicit 'owner', a member's builder/viewer, or undefined. This is the
   * §10.2 authorization vocabulary — it NEVER changes authoritative-world
   * rights.
   */
  roleInFork(sandbox: SandboxRow, userId: string): 'owner' | SandboxMemberRole | undefined {
    if (sandbox.owner_id === userId) return 'owner';
    if (this.deps.envStore.getEnvironment(sandbox.env_id)?.owner_id === userId) return 'owner';
    return this.deps.sandboxStore.memberOf(sandbox.id, userId)?.role;
  }

  /** Fork owner or env owner — who may invite/remove members and stop the fork. */
  private assertForkManageAccess(sandbox: SandboxRow, user: AuthUser): void {
    if (this.roleInFork(sandbox, user.id) === 'owner') return;
    const env = this.deps.envStore.getEnvironment(sandbox.env_id);
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the fork owner or the environment owner may manage members of sandbox "${sandbox.id}"`,
    );
  }

  // ---------------------------------------------------------------------------
  // S3 retention sweep
  // ---------------------------------------------------------------------------

  /**
   * S3 (Task 2): age-based retention sweep for sandbox forks (the minimal
   * honest v1 of the P2F lifecycle). An ACTIVE sandbox row whose LAST
   * ACTIVITY — the later of the row's creation and the newest file mtime
   * under its registry-managed trajectory dir — exceeds `maxAgeMs` is swept:
   * the registry sim is stopped+removed (taking its trajectory dir with it,
   * T-011 ownership) and the row is marked STOPPED, which releases its
   * sandboxes_per_user_per_env quota slot. Live (running/paused) runtimes
   * are never swept regardless of age — activity is activity.
   *
   * P2F §10.3: a row's explicit `expires_at` (stamped at fork time from the
   * retention knob) is an ADDITIONAL ceiling — a non-live fork past its own
   * expiry is swept even when its disk activity is fresh.
   *
   * Ownership rules (mirrors T-011): only platform-created fork artifacts
   * are touched — the `sandboxes` rows this service itself writes and their
   * registry sims. Fork SOURCE environments are user-authored rows and are
   * never modified here; non-sandbox simulations do not appear in the
   * candidate set at all. Dirs of sims that died with a previous process
   * are reaped by the T-011 boot sweep on their own age schedule.
   *
   * @returns counts for the boot/periodic log lines.
   */
  sweepStaleForks(options: { maxAgeMs: number; now?: number }): { swept: number; kept: number } {
    const now = options.now ?? Date.now();
    let swept = 0;
    let kept = 0;
    for (const row of this.deps.sandboxStore.listActive()) {
      if (row.simulation_id !== null) {
        const live = this.deps.registry.get(row.simulation_id);
        if (live !== undefined) {
          const state = live.runtime.getState();
          // Only a LIVE world (running/paused, the quota LIVE states) counts
          // as present activity — a 'created'-never-started fork is exactly
          // the abandonment this sweep exists to reclaim.
          if (state === 'running' || state === 'paused') {
            kept += 1;
            continue;
          }
        }
      }
      const createdAtMs = Date.parse(row.created_at);
      const lastActivityMs = Math.max(
        Number.isFinite(createdAtMs) ? createdAtMs : 0,
        row.simulation_id !== null ? this.deps.registry.lastDiskActivityMs(row.simulation_id) : 0,
      );
      const expiredAtMs = row.expires_at !== null ? Date.parse(row.expires_at) : Number.NaN;
      // `>=` not `>`: expires_at is a DEADLINE — at the boundary the row
      // is due (an in-process fork+sweep in one wall millisecond must not
      // read as "still fresh").
      const pastOwnExpiry = Number.isFinite(expiredAtMs) && now >= expiredAtMs;
      if (
        !pastOwnExpiry &&
        (lastActivityMs === 0 || now - lastActivityMs <= options.maxAgeMs)
      ) {
        kept += 1;
        continue;
      }
      try {
        this.stop(row);
        swept += 1;
      } catch (error) {
        kept += 1; // a stuck row gets another chance on the next sweep
        console.warn(
          `SandboxService: fork retention sweep could not stop sandbox ${row.id}:`,
          error,
        );
      }
    }
    return { swept, kept };
  }

  /** Load a sandbox or throw the standard 404. */
  getOrThrow(id: string): SandboxRow {
    const row = this.deps.sandboxStore.get(id);
    if (!row) throw new ApiError(404, 'SANDBOX_NOT_FOUND', `Sandbox "${id}" not found`);
    return row;
  }

  /** The §10.4 lineage record of a fork row (serializer + exports surface). */
  lineageOf(sandbox: SandboxRow, window: { from: string | null; to: string | null } = { from: null, to: null }) {
    return forkLineageOf(sandbox, window);
  }

  /**
   * Every overlay id must name an APPLIED inject-scenario proposal of THIS
   * environment — anything else (unknown, wrong env, wrong kind, not yet
   * applied) is a 400.
   */
  private validateOverlays(env: EnvironmentRow, overlays: string[]): void {
    for (const proposalId of overlays) {
      const proposal = this.deps.proposalStore.get(proposalId);
      if (
        proposal === undefined ||
        proposal.env_id !== env.id ||
        proposal.kind !== 'inject-scenario' ||
        proposal.status !== 'applied'
      ) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Overlay "${proposalId}" is not an applied inject-scenario proposal of environment "${env.id}"`,
        );
      }
    }
  }

  /**
   * The environment row with its map events filtered per the overlay
   * selection. Proposal-injected events carry the `<proposalId>:` id prefix
   * (proposal-service.ts); events without that prefix are base-layer and
   * always survive. `overlays === undefined` keeps everything.
   */
  private snapshotWithEvents(env: EnvironmentRow, overlays: string[] | undefined): EnvironmentRow {
    if (overlays === undefined) return env;
    const mapData = parseMapData(env);
    const current = mapData.events ?? [];
    if (current.length === 0) return env;

    // Prefixes of every applied inject-scenario proposal of this env, so a
    // base event that merely LOOKS namespaced is not mistaken for an overlay
    // event (and a reverted proposal's events, already removed, don't matter).
    const injectedPrefixes = this.deps.proposalStore
      .listForEnv(env.id, { status: 'applied' })
      .filter(proposal => proposal.kind === 'inject-scenario')
      .map(proposal => `${proposal.id}:`);
    const selected = new Set(overlays.map(proposalId => `${proposalId}:`));
    const events = current.filter(event => {
      const injectedBy = injectedPrefixes.find(prefix => event.id.startsWith(prefix));
      return injectedBy === undefined || selected.has(injectedBy);
    });
    return {
      ...env,
      map_data_json: JSON.stringify({ ...mapData, events }),
    };
  }
}
