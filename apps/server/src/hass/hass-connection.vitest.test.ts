/**
 * @vitest-environment node
 *
 * HAWebSocketConnection tests against the in-process MockHassServer (no real
 * Home Assistant). Covers: auth handshake → ready with a seeded entity
 * cache; auth rejection; state_changed subscription fan-out; call_service
 * round-trip; request timeout; and auto-reconnect (state cache re-seeded,
 * subscription re-established) after an unexpected drop.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HAWebSocketConnection } from './connection.js';
import { MockHassServer } from './mock-hass.js';

const TOKEN = 'test-token';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('HAWebSocketConnection', () => {
  let mock: MockHassServer | undefined;
  let connection: HAWebSocketConnection | undefined;

  afterEach(async () => {
    connection?.close();
    connection = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('authenticates, becomes ready, and seeds the entity cache', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });

    const transitions: string[] = [];
    connection.onStateChange(state => transitions.push(state));

    await connection.connect();

    expect(connection.getState()).toBe('ready');
    expect(transitions).toEqual(['connecting', 'ready']);
    expect(connection.listEntities().length).toBeGreaterThan(5);
    expect(connection.getEntity('light.living_room')?.state).toBe('off');
  });

  it('rejects a bad token as a permanent auth failure (no reconnect loop)', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({
      url: mock.url,
      token: 'wrong-token',
      initialBackoffMs: 50,
    });

    await expect(connection.connect()).rejects.toThrow(/access token|Invalid/i);
    expect(connection.getState()).toBe('disconnected');

    // No silent retry: still disconnected, still no socket on the mock.
    // DevLoop R21 test-debt: negative window (proving NO reconnect) — no
    // positive signal exists; 400ms is ~8 backoff cycles of 50ms, generous
    // enough that a retrying implementation would certainly be caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(connection.getState()).toBe('disconnected');
    expect(mock.connectionCount()).toBe(0);
  });

  it('fans pushed state_changed events out to per-entity listeners', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();

    const seen: Array<{ state: string; attributes: Record<string, unknown> }> = [];
    connection.onEntityState('sensor.living_room_temperature', entity => {
      seen.push({ state: entity.state, attributes: entity.attributes });
    });
    // Current cache value is delivered synchronously on subscribe.
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toBe('21.5');

    mock.pushState('sensor.living_room_temperature', '22.0', { unit_of_measurement: '°C' });
    await waitFor(() => seen.length === 2);
    expect(seen[1].state).toBe('22.0');
    // The connection cache moved too.
    expect(connection.getEntity('sensor.living_room_temperature')?.state).toBe('22.0');
  });

  it('round-trips call_service through the mock', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();

    await connection.callService('light', 'turn_on', 'light.living_room', { brightness_pct: 80 });

    expect(mock.serviceCalls).toEqual([
      {
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
        service_data: { brightness_pct: 80 },
      },
    ]);
    // Mock auto-apply pushed the new state back over the subscription.
    await waitFor(() => connection.getEntity('light.living_room')?.state === 'on');
  });

  it('rejects a request when the connection is not ready', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });

    await expect(connection.request({ type: 'get_states' })).rejects.toThrow(/not ready/);
  });

  it('times out a request HA never answers', async () => {
    mock = await MockHassServer.start({ silentCommands: ['call_service'] });
    connection = new HAWebSocketConnection({
      url: mock.url,
      token: TOKEN,
      requestTimeoutMs: 150,
    });
    await connection.connect();

    await expect(
      connection.callService('light', 'turn_on', 'light.living_room'),
    ).rejects.toThrow(/timed out after 150ms/);
  });

  it('auto-reconnects after an unexpected drop and re-seeds state', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({
      url: mock.url,
      token: TOKEN,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
    });

    const transitions: string[] = [];
    connection.onStateChange(state => transitions.push(state));

    await connection.connect();
    expect(connection.getState()).toBe('ready');

    // Change entity state while "away", then drop the socket abruptly.
    mock.pushState('light.living_room', 'on');
    await waitFor(() => connection!.getEntity('light.living_room')?.state === 'on');
    mock.dropConnections();

    await waitFor(() => connection!.getState() === 'disconnected');
    // Reconnect (backoff ≈ 50ms) → ready again, cache re-seeded, and the
    // subscription is live: a fresh push arrives without any re-setup.
    await waitFor(() => connection!.getState() === 'ready', 5000);

    mock.pushState('light.living_room', 'off');
    await waitFor(() => connection!.getEntity('light.living_room')?.state === 'off');

    expect(transitions).toContain('disconnected');
    expect(transitions.filter(s => s === 'ready').length).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('stays down when reconnect is disabled', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN, reconnect: false });
    await connection.connect();

    mock.dropConnections();
    await waitFor(() => connection!.getState() === 'disconnected');
    // Negative window (R21 test-debt): proves NO reconnect fires after the
    // drop — reconnect is disabled, so any re-connection attempt within a
    // generous window would fail the assertion.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(connection.getState()).toBe('disconnected');
    expect(mock.connectionCount()).toBe(0);
  });
});
