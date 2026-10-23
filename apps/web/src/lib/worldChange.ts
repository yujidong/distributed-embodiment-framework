/**
 * World-change reducer — applies `/api/environments/:id/stream` messages to
 * the loaded environment detail (last-write-wins + broadcast, §11.6).
 *
 * Pure functions so the store stays thin and the semantics are unit-testable:
 * - `parseWorldMessage` / `parseWorldSessionMessage` — defensive wire parsing;
 *   a bad frame must not kill the stream;
 * - `applyWorldChange` — created → add (id-deduped, so an optimistic apply of
 *   the REST response followed by the broadcast is a no-op), updated → merge
 *   (upsert: a missed create must not lose the object), deleted → remove;
 * - `applyWorldSession` — world-session status frames (creation + ACTIVE/
 *   IDLE/HIBERNATED transitions) merge into `world.worldSession`;
 * - `describeWorldChange` — the toast line for someone else's edit.
 */

import type {
  EnvironmentDetail,
  EnvVisibility,
  EnvZone,
  WorldAgent,
  WorldChangeMessage,
  WorldDevice,
  WorldService,
  WorldSessionStatusMessage,
} from '../api/types';
import i18n from '../i18n/config';

export function parseWorldMessage(raw: unknown): WorldChangeMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Partial<WorldChangeMessage>;
  if (message.kind !== 'world') return null;
  if (message.action !== 'created' && message.action !== 'updated' && message.action !== 'deleted') {
    return null;
  }
  if (
    message.objectType !== 'device' &&
    message.objectType !== 'agent' &&
    message.objectType !== 'environment' &&
    message.objectType !== 'service'
  ) {
    return null;
  }
  if (typeof message.object !== 'object' || message.object === null) return null;
  return message as WorldChangeMessage;
}

function idOf(object: unknown): string | null {
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * R82 fix: world-session status frames (`kind: 'world-session'`) share the
 * env stream with world-change frames. Defensive parse — a malformed frame
 * must not kill the stream.
 */
export function parseWorldSessionMessage(raw: unknown): WorldSessionStatusMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Partial<WorldSessionStatusMessage>;
  if (message.kind !== 'world-session') return null;
  if (message.status !== 'active' && message.status !== 'idle' && message.status !== 'hibernated') {
    return null;
  }
  if (typeof message.simulationId !== 'string' || message.simulationId.length === 0) return null;
  if (typeof message.simTimeSec !== 'number' || !Number.isFinite(message.simTimeSec)) return null;
  return message as WorldSessionStatusMessage;
}

function isWorldDevice(object: unknown): object is WorldDevice {
  const d = object as Partial<WorldDevice>;
  return typeof d.id === 'string' && typeof d.name === 'string' && typeof d.zoneId === 'string';
}

function isWorldAgent(object: unknown): object is WorldAgent {
  const a = object as Partial<WorldAgent>;
  return (
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    Array.isArray(a.boundDeviceIds) &&
    Array.isArray(a.managedZoneIds)
  );
}

function isWorldService(object: unknown): object is WorldService {
  const s = object as Partial<WorldService>;
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.semanticType === 'string' &&
    typeof s.provider === 'object' &&
    s.provider !== null
  );
}

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  return list.some(existing => existing.id === item.id)
    ? list.map(existing => (existing.id === item.id ? item : existing))
    : [...list, item];
}

export function applyWorldChange(
  detail: EnvironmentDetail,
  message: WorldChangeMessage,
): EnvironmentDetail {
  const id = idOf(message.object);
  if (!id) return detail;

  if (message.objectType === 'device') {
    if (message.action === 'deleted') {
      return { ...detail, devices: detail.devices.filter(d => d.id !== id) };
    }
    if (!isWorldDevice(message.object)) return detail;
    if (message.action === 'created' && detail.devices.some(d => d.id === id)) return detail;
    return { ...detail, devices: upsertById(detail.devices, message.object) };
  }

  if (message.objectType === 'agent') {
    if (message.action === 'deleted') {
      return { ...detail, agents: detail.agents.filter(a => a.id !== id) };
    }
    if (!isWorldAgent(message.object)) return detail;
    if (message.action === 'created' && detail.agents.some(a => a.id === id)) return detail;
    return { ...detail, agents: upsertById(detail.agents, message.object) };
  }

  // Services (W3): the stream is already visibility-filtered server-side, so
  // every service frame we receive belongs in our marketplace view. When an
  // agent disappears its services are deleted individually by the server.
  if (message.objectType === 'service') {
    if (message.action === 'deleted') {
      return { ...detail, services: detail.services.filter(s => s.id !== id) };
    }
    if (!isWorldService(message.object)) return detail;
    if (message.action === 'created' && detail.services.some(s => s.id === id)) return detail;
    return { ...detail, services: upsertById(detail.services, message.object) };
  }

  // environment: the stream only carries `updated` (name/description/
  // visibility/mapType/zones) and `deleted` (handled by the store, which
  // routes away from the world view).
  if (message.action !== 'updated') return detail;
  const patch = message.object as Partial<{
    name: string;
    description: string;
    mapType: string;
    visibility: EnvVisibility;
    zones: EnvZone[];
    updatedAt: string;
  }>;
  return {
    ...detail,
    ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
    ...(typeof patch.description === 'string' ? { description: patch.description } : {}),
    ...(typeof patch.mapType === 'string' ? { mapType: patch.mapType } : {}),
    ...(patch.visibility === 'public' || patch.visibility === 'private'
      ? { visibility: patch.visibility }
      : {}),
    ...(Array.isArray(patch.zones) ? { zones: patch.zones } : {}),
    ...(typeof patch.updatedAt === 'string' ? { updatedAt: patch.updatedAt } : {}),
  };
}

/**
 * R82 fix: merge a world-session status frame into `world.worldSession`
 * (immutable update, same pattern as `applyWorldChange`). Covers both the
 * page-open transition stream AND a session CREATED while the page was
 * already open (the frame carries `simulationId` — the「进入世界仿真」button
 * gates on it, so previously the entry stayed missing until a reload).
 */
export function applyWorldSession(
  detail: EnvironmentDetail,
  message: WorldSessionStatusMessage,
): EnvironmentDetail {
  const previous = detail.worldSession;
  return {
    ...detail,
    worldSession: {
      status: message.status,
      simTimeSec: message.simTimeSec,
      simulationId: message.simulationId,
      // The frame omits the compression rate + wall anchor (constants of the
      // session): carry them over from the loaded view; a fresh view (the
      // create-while-open case) takes the server's default wall rate.
      simPerWallSec: previous?.simPerWallSec ?? 1,
      ...(previous?.simStartEpochMs !== undefined
        ? { simStartEpochMs: previous.simStartEpochMs }
        : {}),
      // observers belongs to the live states, the checkpoint pair to
      // hibernated — mirror viewOf() so a transition drops the stale half.
      ...(message.status !== 'hibernated' && message.observers !== undefined
        ? { observers: message.observers }
        : {}),
      ...(message.status === 'hibernated'
        ? {
            ...(message.checkpointAtSec !== undefined
              ? { checkpointAtSec: message.checkpointAtSec }
              : {}),
            ...(message.hibernatedAt !== undefined ? { hibernatedAt: message.hibernatedAt } : {}),
          }
        : {}),
      // driftWarning only rides the wake's env-detail response — the frame
      // does not repeat it, so keep the loaded one.
      ...(previous?.driftWarning !== undefined ? { driftWarning: previous.driftWarning } : {}),
    },
  };
}

/** Owner id embedded in a created/updated object message (null for deletes). */
export function actorOf(message: WorldChangeMessage): string | null {
  const object = message.object as {
    owner?: { id?: unknown };
    provider?: { owner?: { id?: unknown } };
  };
  const owner = object.owner ?? object.provider?.owner;
  return owner && typeof owner.id === 'string' ? owner.id : null;
}

const ACTION_KEY: Record<string, string> = {
  created: 'worldChangeLib:actionCreated',
  updated: 'worldChangeLib:actionUpdated',
  deleted: 'worldChangeLib:actionDeleted',
};

const TYPE_KEY: Record<string, string> = {
  device: 'worldChangeLib:typeDevice',
  agent: 'worldChangeLib:typeAgent',
  environment: 'worldChangeLib:typeEnvironment',
  service: 'worldChangeLib:typeService',
};

/** Toast line for a world change; null when there is nothing worth saying. */
export function describeWorldChange(message: WorldChangeMessage): string | null {
  if (message.objectType === 'environment') {
    return message.action === 'updated' ? i18n.t('worldChangeLib:envUpdated') : null;
  }
  const object = message.object as {
    name?: unknown;
    owner?: { displayName?: unknown };
    provider?: { owner?: { displayName?: unknown } };
  };
  const displayName = object.owner?.displayName ?? object.provider?.owner?.displayName;
  const actor = typeof displayName === 'string' ? `${displayName} ` : '';
  const name = typeof object.name === 'string' ? i18n.t('worldChangeLib:nameQuote', { name: object.name }) : '';
  return `${actor}${i18n.t(ACTION_KEY[message.action])}${i18n.t(TYPE_KEY[message.objectType])}${name}`;
}
