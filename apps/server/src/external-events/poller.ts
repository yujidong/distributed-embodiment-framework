/**
 * External event source poller (R58) — the subscription direction.
 *
 * One tick scans the due sources, fetches each URL (optional auth headers,
 * bounded timeout), maps the payload into world events (mapping.ts), dedupes
 * against the persisted seen ledger, and injects through the SAME runtime
 * lane as webhook pushes (world session → active sim). The loop is a plain
 * interval in server bootstrap; pollOnce is exported for routes (poll-now)
 * and tests.
 */

import { mapPayload, type EventSourceMapping, type MappedEvent } from './mapping.js';
import type { ExternalEventSourceStore, EventSourceRow } from './source-store.js';
import type { SimulationRecord } from '../sim-registry/types.js';
import type { ChangePipeline } from '../change-pipeline.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('EventSourcePoller');

export interface PollerContext {
  sources: ExternalEventSourceStore;
  registry: SimulationRegistry;
  worldSessions?: { targetFor(envId: string): Promise<SimulationRecord | undefined> };
  pipeline: ChangePipeline;
  /** Tests inject a fetch stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface PollResult {
  sourceId: string;
  status: 'ok' | 'skipped' | 'error';
  fetchedItems: number;
  injected: number;
  deduped: number;
  skippedItems: number;
  error?: string;
}

/** Resolve the injection target for an env: world session, else active sim. */
async function targetOf(ctx: PollerContext, envId: string): Promise<SimulationRecord | undefined> {
  const session = await ctx.worldSessions?.targetFor(envId);
  if (session !== undefined) return session;
  return ctx.registry.activeForEnvironment(envId);
}

/** Poll one source once. Never throws — failures land in last_error. */
export async function pollOnce(ctx: PollerContext, source: EventSourceRow): Promise<PollResult> {
  const result: PollResult = { sourceId: source.id, status: 'ok', fetchedItems: 0, injected: 0, deduped: 0, skippedItems: 0 };
  const doFetch = ctx.fetchImpl ?? fetch;
  let payload: unknown;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    try {
      Object.assign(headers, JSON.parse(source.auth_headers_json) as Record<string, string>);
    } catch { /* malformed stored headers degrade to plain fetch */ }
    const response = await doFetch(source.url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`upstream responded ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    const message = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    ctx.sources.markPoll(source.id, 'error', 0, message);
    logger.warn(`[source:${source.name}] ${message}`);
    return { ...result, status: 'error', error: message };
  }

  let mapping: EventSourceMapping = {};
  try {
    mapping = JSON.parse(source.mapping_json) as EventSourceMapping;
  } catch { /* empty mapping = passthrough defaults */ }
  const mapped = mapPayload(payload, mapping);
  result.fetchedItems = mapped.events.length + mapped.skipped;
  result.skippedItems = mapped.skipped;

  const target = await targetOf(ctx, source.env_id);
  if (target === undefined) {
    // No world to feed yet — record and retry next interval (keys NOT
    // claimed, so the backlog fires once a sim exists).
    const message = 'no target simulation (world session or running sim)';
    ctx.sources.markPoll(source.id, 'skipped', 0, message);
    return { ...result, status: 'skipped', error: message };
  }

  for (const event of mapped.events) {
    if (!ctx.sources.claimSeen(source.id, event.dedupeKey)) {
      result.deduped += 1;
      continue;
    }
    try {
      const injected = await target.runtime.injectEvent(
        {
          type: event.type,
          zoneId: event.zoneId,
          ...(event.parameter !== undefined ? { parameter: event.parameter } : {}),
          ...(event.value !== undefined ? { value: event.value } : {}),
          ...(event.severity !== undefined ? { severity: event.severity } : {}),
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.requiredCapabilities !== undefined ? { requiredCapabilities: event.requiredCapabilities } : {}),
        },
        // Poller injections must not hold the tick on agent delivery —
        // deadline 0 lets the chain resolve in the engine's own time.
        { deliveryDeadlineMs: 0 },
      );
      ctx.pipeline.log({
        envId: source.env_id,
        actorId: `event-source:${source.id}`,
        kind: 'webhook-event',
        payload: {
          simulationId: target.id,
          eventId: injected.eventId,
          type: event.type,
          zoneId: event.zoneId,
          lane: 'poller',
          source: source.name,
        },
        simTime: target.runtime.getSimTimeSec(),
      });
      result.injected += 1;
    } catch (error) {
      const message = `inject failed for "${event.type}": ${error instanceof Error ? error.message : String(error)}`;
      result.error = message;
      ctx.sources.markPoll(source.id, 'partial', result.injected, message);
      logger.warn(`[source:${source.name}] ${message}`);
      return { ...result, status: 'error' };
    }
  }
  ctx.sources.markPoll(source.id, 'ok', result.injected, null);
  return result;
}

/** The background loop — one interval, sequential ticks, never overlapping. */
export function startPoller(ctx: PollerContext, tickSec: number): { stop(): void } {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        for (const source of ctx.sources.dueSources(new Date())) {
          await pollOnce(ctx, source);
        }
      } catch (error) {
        logger.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    })();
  }, tickSec * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
