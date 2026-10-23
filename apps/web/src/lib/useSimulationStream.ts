/**
 * Simulation event stream hook — one WebSocket per simulation, same-origin
 * relative path so the Vite dev proxy (`/api`, ws:true) forwards it.
 *
 * Resilience model: the REST snapshot poll stays the ground truth, so this
 * stream is allowed to fail. On unexpected close it reconnects with
 * exponential backoff (1s → 2s → 4s → 8s → 15s cap); after MAX_ATTEMPTS it
 * gives up and surfaces `streamStatus 'down'` (the console shows a
 * "事件流已断开" badge — polling continues underneath).
 */

import { useEffect } from 'react';

import { useAppStore } from '../store/useAppStore';
import { parseStreamMessage } from './stream';

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

export function useSimulationStream(simulationId: string | null): void {
  const applyStreamSnapshot = useAppStore(s => s.applyStreamSnapshot);
  const appendStreamEvents = useAppStore(s => s.appendStreamEvents);
  const applyZoneDelta = useAppStore(s => s.applyZoneDelta);
  const applyDeviceDelta = useAppStore(s => s.applyDeviceDelta);
  const setStreamStatus = useAppStore(s => s.setStreamStatus);

  useEffect(() => {
    if (!simulationId) return;

    let socket: WebSocket | null = null;
    let attempts = 0;
    let closedByUs = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      setStreamStatus(attempts === 0 ? 'connecting' : 'reconnecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${window.location.host}/api/simulations/${encodeURIComponent(simulationId)}/stream`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        attempts = 0;
        setStreamStatus('open');
      };

      socket.onmessage = message => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return; // Non-JSON frame — ignore, keep the stream alive.
        }
        const streamMessage = parseStreamMessage(parsed);
        if (!streamMessage) return;
        // R31 SF10: cadence ticks arrive as additive zone-delta/device-delta
        // frames (75× less bandwidth than full snapshots, R30 Task 4) — the
        // store patches the affected zone/device in place; full snapshots
        // (initial sync, 30s resync, topology changes) replace everything.
        if (streamMessage.kind === 'snapshot') {
          applyStreamSnapshot(streamMessage.data);
        } else if (streamMessage.kind === 'event') {
          appendStreamEvents(streamMessage.data);
        } else if (streamMessage.kind === 'zone-delta') {
          applyZoneDelta(streamMessage.data);
        } else {
          applyDeviceDelta(streamMessage.data);
        }
      };

      socket.onclose = (event: CloseEvent) => {
        if (closedByUs) return;
        // T-007: 1001 'simulation stopped' is the server's TERMINAL close —
        // the sim ended (we already applied its final state:'stopped'
        // snapshot). Reconnecting would only re-fetch a stopped snapshot
        // six times; treat it as a clean end and go idle.
        if (event.code === 1001) {
          setStreamStatus('idle');
          return;
        }
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          setStreamStatus('down');
          return;
        }
        const delay = Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // Let onclose drive the reconnect logic (it always follows onerror).
        socket?.close();
      };
    };

    connect();

    return () => {
      closedByUs = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      setStreamStatus('idle');
    };
  }, [
    simulationId,
    applyStreamSnapshot,
    appendStreamEvents,
    applyZoneDelta,
    applyDeviceDelta,
    setStreamStatus,
  ]);
}
