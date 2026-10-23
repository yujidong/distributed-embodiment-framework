/**
 * L1 Perception — the Agent World Model (cognitive architecture §3.1, §14.2).
 *
 * A SINGLE structured representation of what the agent knows about the
 * world: identity/capabilities, bound devices, visible zones (managed +
 * adjacent) with live parameters, the goal stack, and a bounded ring of
 * recently digested events. Design decision R14.2 ("world model as single
 * source"): the three legacy context views —
 *   `CognitiveAgent.environmentStateSnapshot`,
 *   `DualTriggerACManager.buildAgentContext`,
 *   `context/AgentContextBuilder`
 * — converge onto THIS module as projections instead of each maintaining a
 * private drift-prone view of the same world.
 *
 * `AgentWorldModel` itself is a PURE data structure (JSON-serializable, no
 * logic, size budgetable). The `AgentWorldModelStore` below is the thin
 * incremental WRITE face for the agent's passive perception channel
 * (event-stream updates); everything else is rebuilt per cognitive round by
 * the pure builder (world-model-builder.ts).
 *
 * Bounded-ness is a design invariant (R32 prompt-slimming's cognitive-layer
 * version): zones/devices key sets are scenario-bounded, the event ring is
 * capped, and every projection that reaches an LLM prompt is further sliced
 * (last N) at render time.
 */

// ============================================================================
// Types — the pure data structure
// ============================================================================

/**
 * A device the agent BOUND (its own internal resource — never visible to
 * other agents; the architecture red line "devices private, services
 * public" is unchanged by the world model).
 */
export interface WorldModelDevice {
  deviceId: string;
  type: string;
  zoneId: string;
  /** Live device state (primitives map; bounded by the device's own shape). */
  state: Record<string, unknown>;
  /** Actuation command surface (the non-sensor-style capabilities). */
  commands: string[];
}

/** A zone the agent can see (managed + adjacent propagation face). */
export interface WorldModelZone {
  zoneId: string;
  name: string;
  /** Latest per-parameter values (temperature, humidity, …). */
  parameters: Record<string, number | boolean>;
  /** Zones sharing a physical boundary (T-708 propagation face). */
  adjacentZoneIds: string[];
}

/** One entry of the agent's prioritized goal stack (1 = highest). */
export interface WorldModelGoal {
  goal: string;
  priority: number;
  /** Deadline in sim-time seconds when one is known. */
  deadline?: number;
}

/** A digested world event in the bounded working-memory ring. */
export interface WorldModelEvent {
  type: string;
  zoneId?: string;
  parameter?: string;
  value?: number | boolean;
  simTimeSec: number;
}

/**
 * The agent's world model — what L2/L3 read instead of re-deriving context
 * from raw sources (§3.1 "单一来源": L1 is the only layer touching raw
 * event streams; L2/L3 consume projections of this object).
 */
export interface AgentWorldModel {
  agentId: string;
  capabilities: string[];
  /** Capability classes this agent must NOT deliver (T-036 scope-of-practice). */
  scopeOfPractice?: string[];
  devices: WorldModelDevice[];
  zones: WorldModelZone[];
  goalStack: WorldModelGoal[];
  recentEvents: WorldModelEvent[];
  simTimeSec: number;
}

// ============================================================================
// Store — the incremental L1 write face (passive perception channel)
// ============================================================================

/** Ring-buffer cap for digested events (32 = design default, §3.1). */
export const WORLD_MODEL_EVENT_RING_CAP = 32;

/** Events rendered into an LLM prompt (tighter than the ring; R32 discipline). */
export const WORLD_MODEL_PROMPT_EVENT_CAP = 5;

/** One ENVIRONMENT_PARAM_CHANGED observation (legacy snapshot parity face). */
export interface EnvironmentParamUpdate {
  location: string;
  parameter: string;
  newValue: number | boolean;
  timestamp: Date;
}

/**
 * R40-C3: one checkpointed parameter-face entry. Keyed `location:parameter`;
 * `atSimTimeSec` is the sim time the face was CAPTURED at (the store keeps a
 * wall timestamp per entry but has no sim-clock seam — per-entry sim time is
 * not observable, the capture stamp is the honest bound).
 */
export interface EnvironmentParamFaceCheckpoint {
  value: number | boolean;
  atSimTimeSec: number;
}

/**
 * Per-agent incremental world-model store — the structured WRITE face that
 * replaces CognitiveAgent's flat `environmentStateSnapshot` Map (§3.5:
 * "订阅面不动，写入面换成结构化模型"). The legacy getters become projections
 * with byte-compatible behavior (pinned by tests):
 *
 * - parameter face keyed `location:parameter` with Map semantics (re-setting
 *   an existing key OVERWRITES the value but keeps the original insertion
 *   position — pinned by the legacy snapshot tests);
 * - a bounded event ring (WORLD_MODEL_EVENT_RING_CAP, drop-oldest);
 * - `simTimeSec` best-effort: callers that know the sim clock pass it per
 *   event; otherwise wall-seconds-since-store-birth is used (documented
 *   approximation — CognitiveAgent has no sim-clock seam today).
 */
export class AgentWorldModelStore {
  private readonly parameters = new Map<
    string,
    { value: number | boolean; location: string; parameter: string; timestamp: Date }
  >();
  private readonly events: WorldModelEvent[] = [];
  private readonly wallBirthMs = Date.now();

  /** Digest one ENVIRONMENT_PARAM_CHANGED payload into the parameter face. */
  applyEnvironmentParamChanged(update: EnvironmentParamUpdate): void {
    if (
      typeof update.location !== 'string' ||
      typeof update.parameter !== 'string' ||
      update.location.length === 0 ||
      update.parameter.length === 0
    ) {
      return; // same guard as the legacy snapshot write (payload?.parameter && location !== undefined)
    }
    this.parameters.set(`${update.location}:${update.parameter}`, {
      value: update.newValue,
      location: update.location,
      parameter: update.parameter,
      timestamp: update.timestamp,
    });
  }

  /** Append a digested event to the bounded ring (drop-oldest). */
  recordEvent(event: Omit<WorldModelEvent, 'simTimeSec'> & { simTimeSec?: number }): void {
    this.events.push({
      ...event,
      simTimeSec: event.simTimeSec ?? this.fallbackSimTimeSec(),
    });
    if (this.events.length > WORLD_MODEL_EVENT_RING_CAP) {
      this.events.splice(0, this.events.length - WORLD_MODEL_EVENT_RING_CAP);
    }
  }

  /**
   * LEGACY projection (behavior-pinned): the pre-cognition
   * `getEnvironmentStateSnapshot()` array — insertion-ordered entries with
   * key/value/location/timestamp.
   */
  projectEnvironmentSnapshot(): ReadonlyArray<{
    key: string;
    value: number | boolean;
    location: string;
    timestamp: Date;
  }> {
    return Array.from(this.parameters.entries()).map(([key, val]) => ({
      key,
      value: val.value,
      location: val.location,
      timestamp: val.timestamp,
    }));
  }

  /**
   * LEGACY projection (behavior-pinned): the pre-cognition
   * `getEnvironmentState(parameter?, location?)` record. The full record
   * maps key → {value, location, timestamp} exactly as the old Map did
   * (the store's internal `parameter` field is an implementation detail).
   */
  projectEnvironmentState(
    parameter?: string,
    location?: string,
  ): Record<string, unknown> {
    if (parameter && location) {
      const entry = this.parameters.get(`${location}:${parameter}`);
      return entry ? { value: entry.value, timestamp: entry.timestamp } : {};
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of this.parameters) {
      result[key] = { value: val.value, location: val.location, timestamp: val.timestamp };
    }
    return result;
  }

  /** Latest N events (oldest→newest), default the prompt cap. */
  recentEvents(max = WORLD_MODEL_PROMPT_EVENT_CAP): WorldModelEvent[] {
    return this.events.slice(-max);
  }

  /**
   * Per-zone parameter projection of the parameter face — the zone inputs
   * the world-model builder merges with live zone topology. Zones appear in
   * first-seen order; later writes overwrite parameters in place.
   */
  zoneParameterProjection(): Array<{ zoneId: string; parameters: Record<string, number | boolean> }> {
    const zones = new Map<string, Record<string, number | boolean>>();
    for (const val of this.parameters.values()) {
      let params = zones.get(val.location);
      if (params === undefined) {
        params = {};
        zones.set(val.location, params);
      }
      params[val.parameter] = val.value;
    }
    return Array.from(zones.entries()).map(([zoneId, parameters]) => ({ zoneId, parameters }));
  }

  /** Drop everything (stop()/reset parity with the legacy Map.clear()). */
  clear(): void {
    this.parameters.clear();
    this.events.length = 0;
  }

  /**
   * R40-C3: checkpoint export of the parameter face — every key the agent
   * has observed, insertion-ordered, JSON-serializable. Rides the manager's
   * cognition checkpoint so a resumed run's legacy projections
   * (`projectEnvironmentSnapshot` / `projectEnvironmentState`) start from the
   * hibernated face instead of zero (the pre-C3 drift).
   */
  exportParameterFace(atSimTimeSec: number): Record<string, EnvironmentParamFaceCheckpoint> {
    const face: Record<string, EnvironmentParamFaceCheckpoint> = {};
    for (const [key, entry] of this.parameters) {
      face[key] = { value: entry.value, atSimTimeSec };
    }
    return face;
  }

  /**
   * R40-C3: checkpoint restore — re-applies the face through the SAME
   * write path as live observation (`applyEnvironmentParamChanged`), in the
   * checkpoint's key order (insertion order preserved). The wall timestamp
   * of each restored entry is the restore moment (the original wall stamp is
   * not part of the checkpoint; `atSimTimeSec` carries sim-time provenance).
   * A missing face (pre-C3 checkpoint) is an honest no-op: the face starts
   * empty until the next observed event.
   */
  restoreParameterFace(face: Record<string, EnvironmentParamFaceCheckpoint> | undefined): void {
    if (face === undefined) return;
    this.parameters.clear();
    for (const [key, entry] of Object.entries(face)) {
      const separator = key.indexOf(':');
      if (separator <= 0 || separator === key.length - 1) continue; // malformed key — skip
      this.applyEnvironmentParamChanged({
        location: key.slice(0, separator),
        parameter: key.slice(separator + 1),
        newValue: entry.value,
        timestamp: new Date(),
      });
    }
  }

  private fallbackSimTimeSec(): number {
    return Math.max(0, Math.round((Date.now() - this.wallBirthMs) / 1000));
  }
}
