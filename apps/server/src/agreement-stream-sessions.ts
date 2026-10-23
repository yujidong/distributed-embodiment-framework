/**
 * Agreement stream session registry (Wave-6, Fix-11/15 遗留)
 *
 * Tracks the live WebSocket sessions of `GET /api/agreements/:id/stream`
 * keyed by the hosting simulation id, so the SimulationRegistry can actively
 * close them when that simulation stops: without this the runtime stops
 * pushing observations but the socket keeps ping/pong-heartbeating forever
 * (Fix-15's heartbeat only kills DEAD peers, not orphaned live ones), and
 * the session is metered only when the client eventually disconnects.
 *
 * Closing here sends a real close frame (1001 going away) — the route's own
 * 'close' handler then unsubscribes and appends the kind='stream' usage
 * record, exactly as if the client had hung up.
 *
 * T-007: the same registry now also backs `GET /api/simulations/:id/stream`
 * (same lifecycle problem — a stopped runtime left that stream silent and
 * open forever). `closeForSimulation` accepts an optional `finalMessage`
 * sent BEFORE the close frame so those subscribers end on a terminal
 * snapshot (`state:'stopped'`) instead of having to infer the stop from the
 * close code alone.
 */

import { WebSocket } from 'ws';

export class AgreementStreamSessions {
  private readonly bySimulation = new Map<string, Set<WebSocket>>();
  /**
   * S2 (device privacy): optional per-socket serializer for final messages —
   * a stopping simulation's terminal snapshot projects through the SAME
   * viewer-aware seam the live stream used (foreign device detail must not
   * leak on the last frame).
   */
  private readonly serializers = new WeakMap<WebSocket, (message: unknown) => string>();

  /** Register a freshly upgraded stream socket under its hosting simulation. */
  track(
    simulationId: string,
    socket: WebSocket,
    serialize?: (message: unknown) => string,
  ): void {
    let sockets = this.bySimulation.get(simulationId);
    if (sockets === undefined) {
      sockets = new Set();
      this.bySimulation.set(simulationId, sockets);
    }
    sockets.add(socket);
    if (serialize !== undefined) this.serializers.set(socket, serialize);
  }

  /** Drop a closed socket (called from the route's cleanup; idempotent). */
  release(simulationId: string, socket: WebSocket): void {
    const sockets = this.bySimulation.get(simulationId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.bySimulation.delete(simulationId);
  }

  /**
   * Close every session the simulation hosts (close frame → the route's
   * close handler meters the session). Returns the number of sockets closed.
   *
   * Living-worlds P1W: `options.reason` lets the authoritative world session
   * close its hosted streams with a teaching reason ('world session
   * hibernated/reloaded — reconnect fast-forwards to now') instead of the
   * generic 'simulation stopped' (the P1 polish note).
   *
   * S2: `finalMessage` may be an OBJECT — each socket then serializes it
   * with its registered per-socket serializer (viewer-aware projection);
   * sockets without one fall back to plain JSON.
   */
  closeForSimulation(
    simulationId: string,
    finalMessage?: string | unknown,
    options: { reason?: string } = {},
  ): number {
    const sockets = this.bySimulation.get(simulationId);
    if (sockets === undefined) return 0;
    this.bySimulation.delete(simulationId);
    let closed = 0;
    for (const socket of sockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          if (finalMessage !== undefined) {
            const serialize = this.serializers.get(socket);
            socket.send(
              serialize !== undefined && typeof finalMessage !== 'string'
                ? serialize(finalMessage)
                : typeof finalMessage === 'string'
                  ? finalMessage
                  : JSON.stringify(finalMessage),
            );
          }
          socket.close(1001, options.reason ?? 'simulation stopped');
        } else {
          socket.terminate();
        }
        closed += 1;
      } catch {
        // Already closing/closed — the route's cleanup is idempotent
      }
    }
    return closed;
  }
}
