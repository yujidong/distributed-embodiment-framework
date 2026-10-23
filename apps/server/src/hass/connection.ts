/**
 * HAWebSocketConnection — Home Assistant WebSocket API client
 *
 * Speaks the HA websocket protocol over a single socket:
 *   connect → `auth_required` → send `auth` → `auth_ok` → id-muxed commands
 *   (`get_states`, `subscribe_events`, `call_service`, `unsubscribe_events`).
 *
 * Responsibilities:
 * - auth flow (long-lived access token);
 * - id-muxed request/response with a per-request timeout;
 * - an entity-state cache, seeded by `get_states` on (re)connect and kept
 *   current by a single `state_changed` subscription fanned out to per-entity
 *   listeners (`onEntityState`);
 * - auto-reconnect with exponential backoff (1s → 30s cap): after an
 *   unexpected drop the connection re-auths, re-seeds the cache, and
 *   re-subscribes, then emits 'ready' again.
 *
 * Connection state events: 'connecting' | 'ready' | 'disconnected' via
 * `onStateChange`. Auth failure is treated as permanent (no reconnect loop).
 *
 * SAFETY: this class is a transport. Nothing here validates whether a
 * service call is wise — command-level restriction happens upstream
 * (entity-map allowlist in HADevice; the real safety gates are P3b).
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('HAWebSocketConnection');

/** Lifecycle states surfaced to listeners and the /api/hass/status route. */
export type HassConnectionState = 'connecting' | 'ready' | 'disconnected';

/** One HA entity state object as returned by get_states / state_changed. */
export interface HassEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
}

export interface HAWebSocketConnectionOptions {
  /** ws(s):// URL; http(s):// is accepted and converted. */
  url: string;
  /** Long-lived access token. */
  token: string;
  /** Auto-reconnect on unexpected drops (default true). */
  reconnect?: boolean;
  /** Per-request timeout in ms (default 10_000). */
  requestTimeoutMs?: number;
  /** Initial reconnect backoff in ms (default 1_000, doubles each attempt). */
  initialBackoffMs?: number;
  /** Backoff cap in ms (default 30_000). */
  maxBackoffMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Error with a `permanent` flag — permanent failures never auto-reconnect. */
class HassAuthError extends Error {
  readonly permanent = true;
}

export class HAWebSocketConnection {
  private readonly url: string;
  private readonly token: string;
  private readonly reconnectEnabled: boolean;
  private readonly requestTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws?: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly states = new Map<string, HassEntityState>();
  private readonly entityListeners = new Map<string, Set<(state: HassEntityState) => void>>();
  private readonly emitter = new EventEmitter();

  private state: HassConnectionState = 'disconnected';
  private subscriptionId?: number;
  private backoffMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;
  private connectPromise?: Promise<void>;

  constructor(options: HAWebSocketConnectionOptions) {
    this.url = normalizeUrl(options.url);
    this.token = options.token;
    this.reconnectEnabled = options.reconnect ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.backoffMs = this.initialBackoffMs;
  }

  /** Current lifecycle state. */
  getState(): HassConnectionState {
    return this.state;
  }

  /** Subscribe to lifecycle transitions. Returns an unsubscribe function. */
  onStateChange(listener: (state: HassConnectionState) => void): () => void {
    this.emitter.on('state', listener);
    return () => {
      this.emitter.off('state', listener);
    };
  }

  /**
   * Connect + authenticate + seed the state cache + subscribe to
   * state_changed. Idempotent while a connect attempt is in flight or the
   * connection is already ready.
   */
  connect(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.establish();
    return this.connectPromise;
  }

  /**
   * Id-muxed command round-trip. Resolves with the message `result` on
   * success; rejects on an HA error result, socket failure, or timeout
   * (`timeoutMs` overrides the connection default for this call).
   */
  request<T = unknown>(message: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('HA connection is not ready'));
    }
    const id = ++this.seq;
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA request ${id} (${String(message.type)}) timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify({ ...message, id }));
    });
  }

  /** call_service helper: one entity target, optional service data + timeout. */
  async callService(
    domain: string,
    service: string,
    entityId: string,
    serviceData?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.request({
      type: 'call_service',
      domain,
      service,
      target: { entity_id: entityId },
      ...(serviceData !== undefined ? { service_data: serviceData } : {}),
    }, timeoutMs);
  }

  /** Snapshot of the entity-state cache (seeded on connect, live-updated). */
  listEntities(): HassEntityState[] {
    return [...this.states.values()];
  }

  /** One cached entity state, or undefined when HA has no such entity. */
  getEntity(entityId: string): HassEntityState | undefined {
    return this.states.get(entityId);
  }

  /**
   * Register a listener for one entity's state_changed pushes. The current
   * cached state (when present) is delivered synchronously. Returns an
   * unsubscribe function.
   */
  onEntityState(entityId: string, listener: (state: HassEntityState) => void): () => void {
    let set = this.entityListeners.get(entityId);
    if (!set) {
      set = new Set();
      this.entityListeners.set(entityId, set);
    }
    set.add(listener);
    const current = this.states.get(entityId);
    if (current) listener(current);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.entityListeners.delete(entityId);
    };
  }

  /** Permanently close: no reconnect, all pending requests rejected. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.failAllPending(new Error('HA connection closed'));
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        // Listeners stay attached: an in-flight handshake settles via its
        // close handler (which sees `closed` and skips the reconnect).
        ws.close();
      } catch {
        // Already gone
      }
    }
    this.setState('disconnected');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** One full connect attempt: socket → auth → get_states → subscribe. */
  private establish(): Promise<void> {
    this.setState('connecting');
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        ws.off('error', onError);
        if (error) {
          try { ws.close(); } catch { /* ignore */ }
          this.connectPromise = undefined;
          this.setState('disconnected');
          reject(error);
        } else {
          this.connectPromise = undefined;
          resolve();
        }
      };
      const onError = (error: Error) => {
        if (!settled) settle(error);
      };
      ws.on('error', onError);

      ws.on('message', (data: WebSocket.RawData) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          logger.warn('Ignoring non-JSON frame from HA');
          return;
        }
        this.handleMessage(message, {
          onAuthOk: () => {
            void this.seedAndSubscribe()
              .then(() => {
                this.backoffMs = this.initialBackoffMs;
                settle();
              })
              .catch(error => settle(error as Error));
          },
          onAuthInvalid: messageText => settle(new HassAuthError(messageText)),
        });
      });

      ws.on('close', () => {
        if (!settled) {
          // Dropped mid-handshake: fail the attempt; the retry decision is
          // the caller's (scheduleReconnect for drops after ready).
          settle(new Error('HA websocket closed during handshake'));
          return;
        }
        const wasReady = this.state === 'ready';
        if (this.state !== 'disconnected') this.setState('disconnected');
        this.failAllPending(new Error('HA websocket closed'));
        if (this.closed) return;
        if (this.reconnectEnabled && wasReady) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /** Route one inbound frame: auth handshake, command results, events. */
  private handleMessage(
    message: Record<string, unknown>,
    handshake: { onAuthOk: () => void; onAuthInvalid: (message: string) => void },
  ): void {
    switch (message.type) {
      case 'auth_required':
        this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_ok':
        handshake.onAuthOk();
        return;
      case 'auth_invalid':
        handshake.onAuthInvalid(
          typeof message.message === 'string' ? message.message : 'HA rejected the access token',
        );
        return;
      case 'result': {
        const id = message.id as number;
        const entry = this.pending.get(id);
        if (!entry) return; // late/unknown result
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.success === false) {
          const err = message.error as { code?: string; message?: string } | undefined;
          entry.reject(new Error(`HA command failed: ${err?.code ?? 'unknown'} — ${err?.message ?? 'no details'}`));
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      case 'event': {
        if (message.id !== this.subscriptionId) return;
        const event = message.event as {
          event_type?: string;
          data?: { entity_id?: string; new_state?: HassEntityState | null };
        } | undefined;
        if (event?.event_type !== 'state_changed') return;
        const newState = event.data?.new_state;
        if (!newState?.entity_id) return; // entity removed → new_state null
        this.states.set(newState.entity_id, newState);
        for (const listener of this.entityListeners.get(newState.entity_id) ?? []) {
          try {
            listener(newState);
          } catch (error) {
            logger.warn(`Entity listener failed for ${newState.entity_id}: ${(error as Error).message}`);
          }
        }
        return;
      }
      default:
        return; // pings and future message types
    }
  }

  /** Post-auth bootstrap: cache seed + the single state_changed subscription. */
  private async seedAndSubscribe(): Promise<void> {
    // During bootstrap the state is still 'connecting', so request() would
    // refuse to send. Flip to ready first; a failure reverts via settle().
    this.setState('ready');
    const states = await this.request<HassEntityState[]>({ type: 'get_states' });
    this.states.clear();
    for (const entity of states ?? []) {
      if (entity?.entity_id) this.states.set(entity.entity_id, entity);
    }
    const subscription = await this.request<unknown>({
      type: 'subscribe_events',
      event_type: 'state_changed',
    });
    // The subscription id is the request id that created it: HA delivers
    // matching events under that id. Re-derive it from the sequence counter.
    this.subscriptionId = this.seq;
    void subscription;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    logger.warn(`HA connection lost — reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.connectPromise = undefined;
      void this.connect().catch(error => {
        logger.warn(`HA reconnect failed: ${(error as Error).message}`);
        if (error instanceof HassAuthError) return; // permanent — stop trying
        this.scheduleReconnect();
      });
    }, delay);
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: HassConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit('state', state);
  }
}

/** Accept ws(s):// directly; convert http(s):// and append the API path. */
function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    throw new Error(`Invalid HASS_URL "${raw}" — expected ws(s):// or http(s):// URL`);
  }
  url = url.replace(/\/+$/, '');
  if (!url.endsWith('/api/websocket')) url = `${url}/api/websocket`;
  return url;
}
