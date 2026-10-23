# @active-collaboration/server

Fastify REST + WebSocket API server for the Active Collaboration engine (P0:
engine service-化). Wraps `EngineRuntime` (packages/core) in an HTTP service:
scenario CRUD, simulation lifecycle, event injection, manual device commands,
and a WebSocket state stream for a future frontend.

## Run

```bash
npm run dev      # tsx watch, sources
npm run build    # tsc --build → dist/ (also builds referenced packages/*)
npm start        # node dist/index.js
```

Listens on `PORT` (default **8100**) / `HOST` (default `0.0.0.0`).

Note: the **root `npm run build` intentionally builds `packages/*` only** —
the server is built with its own `npm run build -w @active-collaboration/server`
(turbo pipelines, e.g. `npm test`, pick it up automatically via the workspace).

## Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8100` / `0.0.0.0` | listen address |
| `SCENARIO_SEED_DIR` | `<repo>/config/scenarios` | bundled read-only scenarios |
| `SCENARIO_USER_DIR` | `<repo>/data/scenarios` | user scenario store (created on startup) |
| `SNAPSHOT_EVERY_SIM_SEC` | `5` | WS snapshot cadence, in simulated seconds |
| `OLLAMA_BASE_URL` | — | when set, Ollama counts as configured |
| `OLLAMA_MODEL` | — | model override for the shared client |

## REST API (prefix `/api`)

| Method | Path | Description |
|---|---|---|
| GET | `/scenarios` | list summaries: `{ id, name, description, source, counts }` |
| GET | `/scenarios/:id` | full validated scenario JSON |
| POST | `/scenarios` | create user scenario → 201; 400 + `issues` on validation failure; 409 on duplicate id |
| PUT | `/scenarios/:id` | replace a **user** scenario; 403 for bundled seeds; 400 if body id ≠ path id |
| DELETE | `/scenarios/:id` | delete a user scenario → 204; 403 for seeds |
| POST | `/simulations` | `{ scenarioId, options? }` → 201 `{ id, scenarioId, state, llm }` |
| GET | `/simulations` | list `{ id, scenarioId, state, simTimeSec, llm }` |
| GET | `/simulations/:id/snapshot` | full `EngineSnapshot` |
| POST | `/simulations/:id/start` | body `{ speed? }` (sim-seconds per tick) |
| POST | `/simulations/:id/pause` · `/resume` · `/stop` | lifecycle control |
| POST | `/simulations/:id/step` | body `{ n? }` — advance n ticks |
| POST | `/simulations/:id/events` | body = `InjectEventInput`; returns `InjectEventResult` |
| POST | `/simulations/:id/commands` | `{ deviceId, commandName, params? }` → engine's `{ success, result?, error? }` |
| GET | `/simulations/:id/stream` | WebSocket upgrade (see below) |

Errors always have the shape `{ error: { code, message, issues? } }`. Codes:
`SCENARIO_NOT_FOUND`, `SCENARIO_EXISTS`, `SCENARIO_READONLY`,
`SCENARIO_VALIDATION_FAILED`, `INVALID_SCENARIO_ID`, `SCENARIO_ID_MISMATCH`,
`SIMULATION_NOT_FOUND`, `SIMULATION_STOPPED` (409), `UNKNOWN_ZONE`,
`LLM_NOT_CONFIGURED`, `BAD_REQUEST`, `ROUTE_NOT_FOUND`, `ENGINE_ERROR`.

### Semantics worth knowing

- **Stopped simulations stay in the registry.** `/stop` halts the runtime but
  keeps the record queryable (list + snapshot) until process shutdown; further
  control calls then fail with 409 `SIMULATION_STOPPED`. There is no delete.
- **`snapshot.runtimeId` ≠ simulation id.** The registry assigns its own id
  (`sim-<scenario>-…`); the engine's snapshot carries `runtime-<scenarioId>`.
- **Scenario ids are file names.** User scenarios persist to
  `<userDir>/<id>.json`, so ids must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
  A user scenario whose id collides with a seed shadows it in listings
  (creation of such duplicates is rejected with 409).

## LLM wiring (thin, v1)

Simulations run **rule-only** (Layer-2 LLM disabled) by default and are fully
functional. `options.llmClient` is a *preset name*:

- `auto` (default): wire one shared `LLMClient('ollama', …)` into the runtime
  iff the scenario's agents carry `llm` blocks AND `OLLAMA_BASE_URL` is set.
- `ollama`: force the shared client; 400 `LLM_NOT_CONFIGURED` when the env is
  missing. The model is `OLLAMA_MODEL` ?? the first agent's `llm.model`.
- `none`: force rule-only.

There is deliberately **no health check** — a down Ollama server surfaces as
LLM-call failures in the engine's decision path, not at creation time.

## WebSocket stream

`GET /api/simulations/:id/stream` upgrades; unknown ids get a normal 404
*before* the upgrade. JSON messages:

- `{ kind: 'snapshot', data: EngineSnapshot }` — sent immediately on connect,
  then every `SNAPSHOT_EVERY_SIM_SEC` simulated seconds.
- `{ kind: 'event', data: SystemEvent[] }` — engine bus events, **batched**
  every 100 ms (≤10 messages/sec). Injected events travel directly to their
  managing agents, so they appear here only via downstream effects (device
  state changes, collaboration events); use `snapshot.recentDecisions` for
  the decision stream.

Subscriptions and the flush timer are cleaned up on socket close.

## Graceful shutdown

SIGINT/SIGTERM → `app.close()` → an `onClose` hook stops every EngineRuntime
(tick loops, stream subscriptions, agents) → the HTTP server drains.

`index.ts` then calls `process.exit(0)` explicitly: importing
`@active-collaboration/core` instantiates its `crossCenterRouter` singleton
(packages/core/src/environment/CrossCenterRouter.ts), which starts a 5 s
`setInterval` that is never cleared. Without the explicit exit the process
would linger after a clean close. Vitest is unaffected (workers are
terminated after the run), which the test suite verifies implicitly by
exiting.

## Tests

```bash
npm test -w @active-collaboration/server        # watch
npm run test:run -w @active-collaboration/server
```

`src/*.vitest.test.ts` — fastify `.inject()` for REST, a real `ws` client
against `127.0.0.1:0` for the stream. No Ollama, no external network. The
user scenario store is a temp dir per test; seeds come from the real
`config/scenarios` (read-only).
