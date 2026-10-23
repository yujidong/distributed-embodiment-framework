/**
 * Production SPA serving (P3c) — serve the built web console at `/`
 *
 * In production the Fastify server also hosts the frontend bundle
 * (`apps/web/dist`, overridable via WEB_DIST), so the whole platform runs as
 * ONE process: `npm run build:all && npm start`, open http://localhost:8100.
 *
 * - Files are served by @fastify/static with a wildcard route; exact `/api/*`
 *   routes always win in find-my-way, and WebSocket upgrades
 *   (`/api/simulations/:id/stream`, `/api/environments/:id/stream`) are
 *   intercepted by @fastify/websocket before routing, so neither is shadowed.
 * - The web console uses client-side view switching (no server routes), so
 *   any GET that isn't `/api*` and isn't a real file falls back to
 *   index.html — see the SPA branch in the global not-found handler.
 * - When the dist is missing (fresh clone, frontend not built yet), `/`
 *   answers with a JSON note instead of crashing; the API works regardless.
 *   The note lives in the not-found handler (no extra route is registered)
 *   so the OpenAPI route-reconciliation test never sees it.
 *
 * The index.html content is cached once per boot — the bundle only changes
 * on deploy. Registration is deliberately NOT awaited: awaiting a register()
 * boots the instance immediately, which would freeze the global error /
 * not-found handlers installed in server.ts out of the booted contexts
 * (same pattern as the legacy route scope).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Wire dist serving into the app. Returns the cached index.html for the SPA
 * fallback, or null when the dist is missing (note route registered instead).
 */
export function registerStaticWeb(app: FastifyInstance, webDist: string): Buffer | null {
  const indexFile = join(webDist, 'index.html');
  if (!existsSync(indexFile)) {
    app.log.warn(
      { webDist },
      'web console dist not found — serving API only; run npm run build -w @active-collaboration/web',
    );
    return null;
  }

  const spaIndex = readFileSync(indexFile);
  // NB: NOT awaited — see the module header (booted contexts would miss the
  // global error / not-found handlers installed later in buildServer).
  void app.register(fastifyStatic, { root: webDist, wildcard: true });
  return spaIndex;
}

/** JSON note served at `/` when the web console dist has not been built. */
export function frontendNotBuiltNote(): { note: string; api: string } {
  return {
    note: 'frontend not built; run npm run build -w @active-collaboration/web, then restart the server',
    api: '/api/docs',
  };
}
