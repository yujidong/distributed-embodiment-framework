/**
 * World stream hook — one WebSocket per open environment
 * (`GET /api/environments/:id/stream`), applying world-change messages to the
 * store incrementally (§11.6: last-write-wins + broadcast).
 *
 * Resilience mirrors the simulation stream: exponential backoff reconnect
 * (1s → 2s → 4s → 8s → 15s cap, 6 attempts); when the stream gives up
 * (`worldStreamStatus 'down'`) the hook falls back to a silent REST refetch
 * on the next window focus, so a dropped connection never leaves the world
 * permanently stale.
 */

import { useEffect } from 'react';

import { parseWorldStreamFrame } from './worldStreamRouter';
import { useAppStore } from '../store/useAppStore';

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

export function useWorldStream(envId: string | null): void {
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const applyWorldSessionMessage = useAppStore(s => s.applyWorldSessionMessage);
  const applyPresenceMessage = useAppStore(s => s.applyPresenceMessage);
  const setWorldStreamStatus = useAppStore(s => s.setWorldStreamStatus);

  useEffect(() => {
    if (!envId) return;

    let socket: WebSocket | null = null;
    let attempts = 0;
    let closedByUs = false;
    let reconnectTimer: number | undefined;

    const refetchOnFocus = () => {
      void useAppStore.getState().reloadWorld();
    };

    const connect = () => {
      setWorldStreamStatus(attempts === 0 ? 'connecting' : 'reconnecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${window.location.host}/api/environments/${encodeURIComponent(envId)}/stream`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        attempts = 0;
        setWorldStreamStatus('open');
      };

      socket.onmessage = message => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return; // Non-JSON frame — ignore, keep the stream alive.
        }
        // F0-1: the dispatch chain lives in lib/worldStreamRouter.ts so the
        // contract test exercises this exact parsing; unknown kinds are
        // ignored (additive-compat), known-unhandled ones by design.
        const frame = parseWorldStreamFrame(parsed);
        if (!frame) return;
        switch (frame.kind) {
          case 'world':
            applyWorldMessage(frame);
            break;
          case 'world-session':
            applyWorldSessionMessage(frame);
            break;
          case 'presence':
            applyPresenceMessage(frame);
            break;
        }
      };

      socket.onclose = (event: CloseEvent) => {
        if (closedByUs) return;
        // T-007: 1001 'environment deleted' is the server's TERMINAL close —
        // the world channel ended on purpose (the deletion frame arrived
        // just before the close). Mark down + keep the focus-refetch
        // fallback so the page discovers the 404, but never churn reconnects
        // against a world that no longer exists.
        if (event.code === 1001) {
          setWorldStreamStatus('down');
          window.addEventListener('focus', refetchOnFocus);
          return;
        }
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          setWorldStreamStatus('down');
          // Silent fallback: refetch the world on the next window focus.
          window.addEventListener('focus', refetchOnFocus);
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
      window.removeEventListener('focus', refetchOnFocus);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      setWorldStreamStatus('idle');
    };
  }, [envId, applyWorldMessage, applyWorldSessionMessage, applyPresenceMessage, setWorldStreamStatus]);
}
