/**
 * mock-hass — in-process mock of the Home Assistant WebSocket API (tests)
 *
 * Speaks exactly the protocol slice HAWebSocketConnection relies on:
 * `auth_required` → `auth` → `auth_ok`/`auth_invalid`; id-muxed `get_states`
 * (fixture entity set), `subscribe_events`/`unsubscribe_events`, and
 * `call_service` (recorded in `serviceCalls`, success echo). `pushState`
 * (and service auto-apply) broadcast `state_changed` events to subscribed
 * sockets, and `dropConnections()` simulates an unexpected loss for
 * reconnect tests.
 *
 * Test helper only — no real Home Assistant anywhere in the suites.
 */

import { WebSocketServer, WebSocket } from 'ws';

import type { HassEntityState } from './connection.js';

export interface MockHassOptions {
  /** Fixture entities returned by get_states (default: mockHassEntities()). */
  entities?: HassEntityState[];
  /** Expected access token (default 'test-token'; others get auth_invalid). */
  token?: string;
  /**
   * Auto-apply call_service effects to the fixture entity and broadcast the
   * resulting state_changed (default true): turn_on/off/toggle set `state`,
   * any service_data keys merge into attributes.
   */
  autoApplyServices?: boolean;
  /** Command types the mock NEVER answers (timeout-path tests). */
  silentCommands?: string[];
}

export interface RecordedServiceCall {
  domain: string;
  service: string;
  target?: { entity_id?: string };
  service_data?: Record<string, unknown>;
}

/** The standard fixture set covering the entity-map domains under test. */
export function mockHassEntities(): HassEntityState[] {
  const now = new Date().toISOString();
  const entity = (
    entityId: string,
    state: string,
    attributes: Record<string, unknown>,
  ): HassEntityState => ({
    entity_id: entityId,
    state,
    attributes: { friendly_name: entityId, ...attributes },
    last_changed: now,
    last_updated: now,
  });
  return [
    entity('climate.living_room_ac', 'cool', {
      device_class: undefined,
      temperature: 24,
      current_temperature: 29,
      hvac_modes: ['cool', 'heat', 'off'],
    }),
    entity('light.living_room', 'off', { brightness: 0 }),
    entity('sensor.living_room_temperature', '21.5', {
      device_class: 'temperature',
      unit_of_measurement: '°C',
    }),
    entity('sensor.living_room_humidity', '55', {
      device_class: 'humidity',
      unit_of_measurement: '%',
    }),
    entity('binary_sensor.front_door', 'off', { device_class: 'door' }),
    entity('switch.air_purifier', 'off', {}),
    entity('cover.living_room_curtain', 'open', { current_position: 100 }),
    entity('fan.bedroom_fan', 'off', { percentage: 0 }),
    entity('humidifier.bedroom', 'off', { humidity: 45 }),
    entity('sensor.outdoor_illuminance', '12000', {
      device_class: 'illuminance',
      unit_of_measurement: 'lx',
    }),
  ];
}

interface Subscription {
  socket: WebSocket;
  id: number;
}

export class MockHassServer {
  readonly url: string;
  readonly serviceCalls: RecordedServiceCall[] = [];

  private readonly wss: WebSocketServer;
  private readonly token: string;
  private readonly autoApply: boolean;
  private readonly silentCommands: Set<string>;
  private readonly entities = new Map<string, HassEntityState>();
  private readonly subscriptions: Subscription[] = [];
  private readonly sockets = new Set<WebSocket>();

  private constructor(wss: WebSocketServer, port: number, options: MockHassOptions) {
    this.wss = wss;
    this.url = `ws://127.0.0.1:${port}/api/websocket`;
    this.token = options.token ?? 'test-token';
    this.autoApply = options.autoApplyServices ?? true;
    this.silentCommands = new Set(options.silentCommands ?? []);
    for (const entity of options.entities ?? mockHassEntities()) {
      // Strip undefined attribute values (JSON round-trip would drop them).
      entity.attributes = Object.fromEntries(
        Object.entries(entity.attributes).filter(([, v]) => v !== undefined),
      );
      this.entities.set(entity.entity_id, entity);
    }

    wss.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
        for (let i = this.subscriptions.length - 1; i >= 0; i--) {
          if (this.subscriptions[i].socket === socket) this.subscriptions.splice(i, 1);
        }
      });
      this.send(socket, { type: 'auth_required' });
      socket.on('message', raw => this.handleMessage(socket, String(raw)));
    });
  }

  /** Start on an ephemeral port; resolves once listening. */
  static async start(options: MockHassOptions = {}): Promise<MockHassServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/websocket' });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const address = wss.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return new MockHassServer(wss, port, options);
  }

  /** Number of currently connected sockets (authed or not). */
  connectionCount(): number {
    return this.sockets.size;
  }

  /** Update a fixture entity and broadcast the state_changed to subscribers. */
  pushState(entityId: string, state: string, attributes?: Record<string, unknown>): void {
    const current = this.entities.get(entityId);
    const now = new Date().toISOString();
    const next: HassEntityState = {
      entity_id: entityId,
      state,
      attributes: { ...(current?.attributes ?? {}), ...(attributes ?? {}) },
      last_changed: now,
      last_updated: now,
    };
    this.entities.set(entityId, next);
    this.broadcastStateChanged(next);
  }

  /** Abruptly terminate every socket (server side) — reconnect test hook. */
  dropConnections(): void {
    for (const socket of [...this.sockets]) {
      socket.terminate();
    }
  }

  /** Stop the mock server (terminates clients first so close() resolves). */
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>(resolve => {
      this.wss.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // Protocol
  // -------------------------------------------------------------------------

  private handleMessage(socket: WebSocket, raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // ignore malformed frames
    }

    switch (message.type) {
      case 'auth':
        if (message.access_token === this.token) {
          this.send(socket, { type: 'auth_ok' });
        } else {
          this.send(socket, { type: 'auth_invalid', message: 'Invalid access token' });
        }
        return;

      default:
        if (this.silentCommands.has(message.type as string)) return; // never answered
        break;
    }

    switch (message.type) {
      case 'get_states':
        this.send(socket, {
          id: message.id,
          type: 'result',
          success: true,
          result: [...this.entities.values()],
        });
        return;

      case 'subscribe_events':
        this.subscriptions.push({ socket, id: message.id as number });
        this.send(socket, { id: message.id, type: 'result', success: true, result: null });
        return;

      case 'unsubscribe_events':
        for (let i = this.subscriptions.length - 1; i >= 0; i--) {
          if (this.subscriptions[i].socket === socket &&
              this.subscriptions[i].id === message.subscription) {
            this.subscriptions.splice(i, 1);
          }
        }
        this.send(socket, { id: message.id, type: 'result', success: true, result: null });
        return;

      case 'call_service': {
        const call: RecordedServiceCall = {
          domain: message.domain as string,
          service: message.service as string,
          ...(message.target !== undefined
            ? { target: message.target as { entity_id?: string } }
            : {}),
          ...(message.service_data !== undefined
            ? { service_data: message.service_data as Record<string, unknown> }
            : {}),
        };
        this.serviceCalls.push(call);
        this.send(socket, {
          id: message.id,
          type: 'result',
          success: true,
          result: { context: { id: `mock-${this.serviceCalls.length}` } },
        });
        if (this.autoApply) this.applyServiceCall(call);
        return;
      }

      default:
        // Unknown command: HA answers with an error result, not silence.
        this.send(socket, {
          id: message.id,
          type: 'result',
          success: false,
          error: { code: 'unknown_command', message: `Unsupported command ${String(message.type)}` },
        });
    }
  }

  /** Reflect a service call into fixture state + broadcast (see options). */
  private applyServiceCall(call: RecordedServiceCall): void {
    const entityId = call.target?.entity_id;
    if (!entityId || !this.entities.has(entityId)) return;
    const current = this.entities.get(entityId)!;

    let state = current.state;
    if (call.service === 'turn_on') state = 'on';
    else if (call.service === 'turn_off') state = 'off';
    else if (call.service === 'toggle') state = current.state === 'on' ? 'off' : 'on';
    else if (call.service === 'set_hvac_mode' && typeof call.service_data?.hvac_mode === 'string') {
      state = call.service_data.hvac_mode;
    } else if (call.service === 'open_cover') state = 'open';
    else if (call.service === 'close_cover') state = 'closed';

    this.pushState(entityId, state, call.service_data);
  }

  private broadcastStateChanged(entity: HassEntityState): void {
    for (const sub of this.subscriptions) {
      this.send(sub.socket, {
        id: sub.id,
        type: 'event',
        event: {
          event_type: 'state_changed',
          data: { entity_id: entity.entity_id, new_state: entity },
        },
      });
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
