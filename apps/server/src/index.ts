/**
 * Server bootstrap — build, listen, graceful shutdown
 *
 * `npm run dev` (tsx watch) and `npm start` (compiled) both enter here.
 * SIGINT/SIGTERM trigger `app.close()`, whose onClose hook stops all
 * simulation runtimes before the HTTP server drains.
 *
 * Why the explicit `process.exit`: importing `@active-collaboration/core`
 * instantiates its `crossCenterRouter` singleton
 * (packages/core/src/environment/CrossCenterRouter.ts), which starts a 5 s
 * `setInterval` that is never cleared or unref'd. The event loop would
 * therefore stay alive forever after a clean close, so we exit explicitly
 * once shutdown has completed.
 */

import { randomUUID } from 'node:crypto';

import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { warnIfDistStale } from './dist-freshness.js';

/**
 * Fix-46 (RC-E): startup anti-hijack self-probe. On dev machines a
 * docker-compose container or WSL relay squatting the configured port can
 * silently split traffic three ways — the server starts "fine" but some
 * connections land on the OTHER process (E2E 2026-08-15: login pages hung,
 * empty 500s from the vite proxy; nobody could tell why). The probe: after
 * listening, GET our own health-ish endpoint carrying a per-boot random
 * token and verify it comes back — a mismatch or unreachable self means
 * something else owns the port.
 */
async function selfProbe(app: import('fastify').FastifyInstance, url: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${url}/api/instance-token`, { headers: { 'x-eaf-instance-token': token } });
    if (!res.ok) {
      app.log.error(`self-probe: HTTP ${res.status} from ${url} — another process may be sharing this port`);
      return;
    }
    const body = await res.json() as { token?: string };
    if (body.token !== token) {
      app.log.error(
        `PORT HIJACKED: the response from ${url} was served by a DIFFERENT process (token mismatch). ` +
        'Check for a docker-compose container or WSL relay on this port (docker ps / netstat -ano) and stop it, ' +
        'or start this server on another port (PORT=8110).',
      );
    }
  } catch (error) {
    app.log.error(`self-probe failed (${(error as Error).message}) — another process may own the port`);
  }
}

/**
 * R44-B: teach (loudly, once) when the LLM backend is not fully configured.
 * The historical silent fallback — probing a local backend at boot and
 * adopting it when it answered — was removed in R44-B; an unconfigured
 * server now boots rule-only, but never silently: this warning names the
 * exact missing knobs.
 */
function warnIfLlmUnconfigured(config: import('./config.js').ServerConfig): void {
  if (config.llmUnconfiguredWarning === undefined) return;
  console.warn(`[llm] ${config.llmUnconfiguredWarning}`);
}

async function main(): Promise<void> {
  warnIfDistStale();
  const config = loadConfig();
  warnIfLlmUnconfigured(config);
  // S4: defer the boot seed writes past a successful listen — an EADDRINUSE
  // boot must fail fast WITHOUT touching the database (the seeds are
  // idempotent; they run below, right after the port is ours).
  config.deferBootSeeds = true;
  const app = await buildServer(config);

  // Fix-46: every boot carries a random instance token; GET /api/instance-token
  // echoes it back. The startup self-probe uses it to detect port squatters.
  const instanceToken = randomUUID();
  app.get('/api/instance-token', async request => {
    return { token: instanceToken, pid: process.pid };
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutdown requested — stopping simulations, closing server');
    app.close()
      .then(() => {
        app.log.info('graceful shutdown complete');
        process.exit(0);
      })
      .catch(error => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    // S4: a squatted port is an operator problem, not a crash — name the
    // port, the likely culprits, and the remedy instead of a bare node
    // stack. (The boot seeds have NOT run at this point.)
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(
        `Cannot start: port ${config.port} on ${config.host} is already in use (EADDRINUSE). ` +
          'Another EAF server, a docker-compose container, or a WSL relay is likely squatting it — ' +
          'find it with `netstat -ano | findstr :' + config.port + '` (or `docker ps`) and stop it, ' +
          `or start this server on another port (PORT=${
            config.port + 10
          }). No seed writes were made.`,
      );
      process.exit(1);
    }
    throw error;
  }
  // S4: the port is ours — now the idempotent boot seeds (blueprints,
  // template gallery, device catalog) may write.
  app.runBootSeeds?.();
  const address = app.server.address();
  const listenUrl = typeof address === 'object' && address !== null
    ? `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`
    : `http://${config.host}:${config.port}`;
  app.log.info(`listening on ${listenUrl} (instance token ${instanceToken})`);
  // 0.0.0.0 binds reach themselves via loopback.
  const probeHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  await selfProbe(app, `http://${probeHost}:${config.port}`, instanceToken);
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error);
  process.exit(1);
});
