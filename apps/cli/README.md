# eaf — Active Collaboration CLI

`eaf` is the command-line interface for the Active Collaboration platform
(`apps/server`). It is a first-class interface: everything the web console
can do — accounts, shared environments, devices, agents, the hardware
catalog, simulations — is available from the terminal, with machine-readable
output everywhere.

It is built for two kinds of users:

- **power users** who want the whole platform workflow without a browser, and
- **AI agents**: an LLM agent can drive the whole platform via these
  commands. Every command supports `--json`; with it, stdout is always a
  single parseable JSON document (or NDJSON for `sim watch`) and every log
  line goes to stderr. **Agents: always pass `--json`.**

## Running

Requires Node.js >= 18 and the platform server (`apps/server`, default
`http://localhost:8100`; start it with `npm run dev -w @active-collaboration/server`).

```bash
# from the repo root — dev mode, no build needed:
npx tsx apps/cli/src/main.ts <command> ...
npm run eaf -- <command> ...          # same thing, via the root script

# or build + use the binary:
npm run build -w @active-collaboration/cli
node apps/cli/dist/main.js <command> ...
npm link -w @active-collaboration/cli  # optional: puts `eaf` on your PATH
```

Tests: `npm test -w @active-collaboration/cli` (boots the real server on a
temp port + temp SQLite DB; rule-only sims, no Ollama needed).

Production deployment (docker compose, backup/restore, config self-check,
health & metrics): see **[docs/deployment.md](docs/deployment.md)**.

## The contract

**Global flags** (accepted before or after the command):

| flag | meaning |
|---|---|
| `--server <url>` | API base URL. Default: `$EAF_SERVER`, else the saved config, else `http://localhost:8100`. |
| `--profile <name>` | session profile. Default: `$EAF_PROFILE`, else the default profile. |
| `--json` | machine output: pretty JSON on stdout, **all** logs on stderr. |
| `-h`, `--help` | help (`eaf help`, `eaf help sim`, `eaf sim --help`). |

**Exit codes** — stable, script them:

| code | meaning |
|---|---|
| 0 | success |
| 1 | runtime error (server unreachable, API error) |
| 2 | usage error (bad flags, invalid document, unresolvable references) |
| 3 | auth error (not logged in, or 401 from the API) |
| 4 | not found (unknown id or name) |

**Session** — `eaf auth login` persists `{server, token}` in
`~/.eaf/config.json` (mode 0600; override the directory with `$EAF_HOME`).
The token is never printed by any command. `eaf auth logout` clears it.

### Multiple accounts & parallel sessions

Two ways to keep sessions from clobbering each other:

- **`$EAF_HOME`** — point each shell/agent at its own config directory
  (`EAF_HOME=/tmp/eaf-a eaf auth login …`). Full isolation: server URL,
  token, everything.
- **`--profile <name>` / `$EAF_PROFILE`** — share one directory, one config
  file per profile: with a profile active the session lives in
  `~/.eaf/config-<name>.json` instead of `config.json`. Precedence:
  `--profile` flag > `$EAF_PROFILE` > default (no profile). Profile names
  are restricted to `[A-Za-z0-9_-]` (they become file names).

```bash
eaf auth login --email work@corp.com --profile work    # writes config-work.json
eaf auth login --email me@home.com                     # writes config.json
eaf auth whoami --profile work                         # shows user + profile
eaf --profile work env list                            # leading position works too
eaf notifications --profile work list                  # …and so does trailing a command group (Fix-18)
EAF_PROFILE=work eaf env list                          # …and so does the env var
```

`whoami` always reports the active profile (`(default)` when none); in
`--json` every auth payload carries `"profile"` (`null` for the default).

**id-or-name references** — everywhere an environment is expected
(`--env`, `env get`, `env export`, …) you may pass either its id or its
exact name. Exact-name matches that hit several environments are an error,
not a guess.

## Commands

### `eaf auth`

```bash
eaf auth register --email a@b.c --password secret123 --display-name "Alice"  # registers AND logs in
eaf auth login --email a@b.c --password secret123   # prompts (hidden) when omitted on a TTY
eaf auth whoami                                     # exit 3 when logged out
eaf auth set-name "Alice Cooper"                    # rename (PATCH /api/me)
eaf auth logout
```

`--display-name` sets the API's `displayName` field (`POST /api/auth/register`
takes `{email, password, displayName}` — there is no `name` field on the wire);
`--name` is kept as a backwards-compatible alias.
`set-name` is the repair path when the registered name was mangled (e.g. an
encoding mishap on Windows — pass non-ASCII names via a UTF-8 terminal).

### `eaf env`

```bash
eaf env list [--mine|--public]          # counts: dev / agt / svc / members
eaf env get <id|name> [--full]          # --full: zones, devices, agents, members, events
eaf env create --name lab --desc "test world" --map-type grid --visibility public
eaf env delete <id|name>
eaf env join <id|name>                  # public envs → join as builder
eaf env leave <id|name>
eaf env export <id|name> [-o file] [--format yaml|json]
eaf env deployment <id|name>            # procurement manifest: devices/prices/links,
                                        # binding + deploymentStatus (bridged vs
                                        # simulation-only) and twin-sync summary,
                                        # services to offer, external services to sign
eaf env asks list <id|name> [--status open|mine|all]   # 需求板 (T-069): what members
                                        # WANT that does not exist yet; member-only
eaf env asks create <id|name> --type <semanticType> [--zone <zoneId>]
                   [--terms '<json>'] [--note <text>] [--auto-propose] [--expires <iso>]
                                        # "when you publish X, I want Y" — a matching
                                        # service publish/derivation rings ask.matched;
                                        # --auto-propose pre-fills a PROPOSED agreement
eaf env asks withdraw <id|name> <askId> # withdraw YOUR open ask (matched → 409, re-ask)
```

Member lists are perspective-redacted: owner/builder see user ids and
emails, viewers and non-members see displayName + role only.

`env export` writes a **world document** (see below) that round-trips
through `eaf apply`: zones and events from the map, devices as `spec:`
blocks (catalog model ids are not stored on instances), agent bindings as
device names. JSON when `--json` or `-o …​.json`, YAML otherwise.

### `eaf device`

```bash
eaf device list --env <id|name>
eaf device add --env <id|name> --zone living-room \
    --model <catalogId> [--name "Desk Lamp"] [--at "120.63,31.30"]
eaf device add --env <id|name> --zone living-room \
    --type light --brand Philips --capabilities lighting-control,turn-on \
    --name "Ceiling Light" [--initial-state '{"power":false}'] \
    [--binding hass://light.living_room]
eaf device update <deviceId> [--name <n>] [--type <t>] [--brand <b>] \
    [--capabilities a,b[,c]] [--zone <zoneId>] [--at "lng,lat"|"x,y"] \
    [--initial-state <json>] [--binding sim://…|hass://<entity>]
eaf device rm <deviceId>
```

`device update` renames / re-zones / re-capabilities a device. The env owner
edits directly; a builder updating THEIR OWN device is converted into a
`modify-object` proposal automatically (same governed lane as `device add` /
`device rm`, same patch semantics as the Web edit form) — `--json` flags the
response `proposal: true` with the proposal id.

With `--model` the device is instantiated from the catalog (type, brand and
capabilities copied). Without it, `--type` + `--capabilities` are required.
`--at` is `"lng,lat"` for geo environments and `"x,y"` for grid ones.
`--binding` wires the device to a real backend at creation time (Fix-18): a
`hass://<entity>` binding is high-risk, so a builder's create force-escalates
to the environment owner for approval (an owner's create binds immediately).

### `eaf agent`

```bash
eaf agent list --env <id|name>
eaf agent add --env <id|name> --file agent.yaml
eaf agent rm <agentId>
```

`agent.yaml` — device names in `bind` are resolved to ids within the env
(all failures reported together):

```yaml
name: Climate Manager
capabilities: [temperature-control, cooling]
bind: [Living Room HVAC]        # device names or raw ids
zones: [living-room]            # managed zone ids
llm: {provider: openai-compatible, model: ac-decision-v5}   # optional
```

### `eaf catalog`

```bash
eaf catalog list [--type light] [--vendor Philips] [--q hue]
eaf catalog get <modelId>
```

### `eaf service`

The service marketplace — what agents **offer** across environments, and
your personal subscriptions ("我依赖的服务"):

```bash
eaf service list (--env <id|name> | --all) [--provider <agentId>] \
    [--type <semanticType>] [--origin derived|published] [--q <搜索词>]
eaf service get <serviceId>          # origin, visibility, provider, reputation
eaf service subscribe <serviceId>    # idempotent; says "already subscribed"
eaf service unsubscribe <serviceId>
```

The scope flag is required (Wave-1a, R8 F-03): `--env` limits the listing
to one environment — the common case right after joining a world; `--all`
aggregates every environment you can see (one that fails to answer is
skipped with a warning on stderr) and heads the human table with a scope
summary line. Services are either `derived` (auto-generated from an agent's
device bindings) or `published` (explicit offers). `--q` runs the full-text
marketplace search (Fix-20 + Wave-1a): Latin tokens match as
case-insensitive substrings over name / description / semantic type, and
Chinese text matches as an in-order character subsequence, so `--q 温度`
also hits `温湿度计`. Composable with the exact filters.

### `eaf blueprint`

Application blueprints (Fix-38) — one-click device+agent+flow templates,
the CLI face of the Web sidebar's Blueprint tab:

```bash
eaf blueprint list [--builtin-only]    # id/name/kind + device-agent-flow counts
eaf blueprint show <blueprintId>       # full definition JSON (template vars included)
eaf blueprint create --name <n> [--desc <d>] --file definition.yaml
eaf blueprint rm <blueprintId>         # custom blueprints only (built-ins refused)
eaf blueprint install <blueprintId> --env <id|name> --zone <zoneId>
```

`install` resolves the definition's `${zoneId}` template variables and
creates the blueprint's devices, agents and flows in the target zone in one
atomic call (builder/owner), printing every created id. The created objects
keep their `installed_from` lineage on the server; deleting a blueprint
does not uninstall its past installs (there is no uninstall endpoint yet).

### `eaf sim`

```bash
eaf sim create --env <id|name> [--llm auto|ollama|none] [--tick-ms 100]   # prints the sim id
eaf sim start <simId> [--speed 5]      # speed = sim-seconds per tick
eaf sim pause <simId> ; eaf sim resume <simId> ; eaf sim stop <simId>
eaf sim step <simId> [--n 10]          # manual ticks …
eaf sim step <simId> --to 120          # …or advance until simTimeSec >= 120
eaf sim status <simId>                 # state + simTime
eaf sim snapshot <simId>               # full EngineSnapshot JSON
eaf sim snapshot <simId> --zones       # compact per-zone parameter table
eaf sim inject <simId> --type temperature-spike --zone living-room \
    --parameter temperature --value 38 --severity high
eaf sim command <simId> --device <deviceId> --cmd turn-on --params '{}'
eaf sim watch <simId> [--interval 2000]
```

`sim watch` is a WebSocket-free follower: it polls the snapshot and prints
one-line diffs — changed zone parameters, new agent decisions, state
transitions — until Ctrl+C:

```
[t=15s] living-room.temperature: 31.5 → 33.5
[t=15s] decision climate-agent on temperature-spike: handle_independently (rule)
[t=20s] state: running → paused
```

With `--json` it emits NDJSON (one `{"kind":"zone"|"decision"|"state",…}`
object per line) — handy for an agent monitoring a run. Use `--llm none`
for deterministic rule-only simulations (no Ollama required): high-severity
events still produce rule decisions (source `rule`) and the agent actuates
its climate devices toward a 24°C comfort target. If agents requested an
LLM that isn't configured, `sim create` prints a warning instead of
silently degrading. The commands a device actually accepts are listed in
`eaf sim snapshot` (per-device `commands`) and `eaf device list`.

`sim command --cmd <name>` maps to the API body
`{deviceId, commandName, params?}` (`POST /api/simulations/:id/commands`) —
the wire field is `commandName`, not `command`.

`sim step --to <sec>` and `--n` are mutually exclusive; the server advances
whole ticks (each worth `--speed` sim-seconds) and may overshoot the target
by less than one tick.

### Governance proposals (builders in shared envs)

When you hold the **builder** role (not owner), structural changes —
`device add`, `device rm`, `agent add` — become governance proposals instead
of landing directly. Under `--json` the output is the proposal object with
`"proposal": true` attached; in human output a proposal the pipeline has
already applied prints the new object ids straight from its `createdIds`
(`proposal p-1 applied — device d-9 created`), so no follow-up `list` is
needed.

### `eaf import-ifc` / `eaf import-floorplan`

Local importers that compile building models into scenario JSON v1.0 files
(review them, then load via `POST /api/environments` or
`import-floorplan --submit`). Neither needs a simulation running.

```bash
# IFC (STEP) building model → scenario JSON (parses locally via web-ifc WASM):
eaf import-ifc building.ifc --out scenario.json [--ir ir.json] [--name n] [--id scenarioId]

# Raster floor plan (PNG/JPEG/WebP) → scenario JSON via a multimodal LLM:
eaf import-floorplan plan.png --building EB --floor 2 \
    (--scale <pxPerM> | --calibrate x1,y1,x2,y2,<meters>) \
    [--ir ir.json] [--out scenario.json] [--merge base-ir.json] \
    [--from-ir ir.json] [--submit <server-url>] \
    [--provider ollama|openai-compatible|siliconflow] [--model m] [--base-url u]
```

The floor-plan command calls a **vision-capable** LLM, configured by
`EAF_VISION_PROVIDER` (default `ollama`) / `EAF_VISION_MODEL` /
`EAF_VISION_BASE_URL` or the `--provider/--model/--base-url` flags. The
default Ollama vision model is `qwen2.5vl:7b` (`ollama pull qwen2.5vl:7b`) —
deliberately NOT the `OLLAMA_MODEL` text model used for agent decisions.
The scale is caller-confirmed only: pass `--scale` or `--calibrate` up
front (invalid values are rejected before the LLM call); when both are
missing the LLM's drawing-read scale is surfaced as a *hint*, never applied
silently. Multi-floor buildings: import each floor and combine with
`--merge`; review/edit the IR and recompile with `--from-ir`.

## World documents — `eaf apply`

kubectl-style declarative environments. YAML or JSON (by extension),
versioned, validated with path-prefixed errors, and documented by a JSON
Schema at [`schema/world-document.schema.json`](./schema/world-document.schema.json).

```yaml
version: "1.0"
environment:
  name: my-lab                     # identity: exact-name match among YOUR envs
  description: two rooms and a bot
  visibility: private
  map:                             # required to create; patched in when changed
    type: grid                     # or geo (then center + polygon zones)
    zones:
      - id: room-a
        name: Room A
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
        adjacentZoneIds: [room-b]
        baseline: {temperature: 30, humidity: 60}
      - id: room-b
        bounds: {minX: 5, maxX: 10, minY: 0, maxY: 5}
devices:
  - model: xiaomi-thermo-2         # catalog model id (eaf catalog list) …
    name: Room Sensor              # …or inline spec:
    zone: room-a
  - name: Room HVAC                #   (name is required with spec)
    zone: room-a
    spec:
      type: hvac
      brand: Gree
      capabilities: [temperature-control, cooling, turn-on, turn-off]
    initialState: {power: false}
agents:
  - name: Climate Bot
    capabilities: [temperature-monitoring, temperature-control]
    bind: [Room Sensor, Room HVAC] # device names (or raw ids)
    zones: [room-a, room-b]
events:                            # scheduled events, baked into the world
  - id: heat-wave
    type: temperature-spike
    zoneId: room-a
    parameter: temperature
    value: 38
    severity: high
    atSimTimeSec: 30
simulation:                        # optional: create+start a run on apply
  llm: none
  speed: 5
```

Apply semantics:

```bash
eaf apply -f world.yaml [--prune] [--reuse-sim]
```

- The environment is found by **exact name among your environments**;
  created (with the map) when missing, otherwise its `mapData` is patched
  **only if changed**.
- Devices and agents are **upserted by name** — created when missing,
  patched when changed. Existing objects that are not in the document are
  **never deleted** (additive only), unless `--prune` is passed, which
  deletes them and prints the list. `--prune` also unbinds pruned devices
  from kept agents first, so no dangling bindings remain.
- With a `simulation:` block, apply checks the environment for LIVE
  (running/paused) simulations first. Without a flag it **warns and lists
  them** (each apply creates ANOTHER sim — repeated applies stack running
  sims until the `running_sims_per_user` quota rejects the create); with
  `--reuse-sim` it **attaches to the newest live sim** instead of creating
  one (a paused sim is resumed; stop sims with `eaf sim stop <simId>`).
- `bind:` names, catalog models and zone ids are validated against the
  environment; **all** problems (document errors + unresolved references +
  per-object API failures) are collected and reported together — the first
  error never hides the rest.
- Human output is a summary (`environment …: created/updated/unchanged`,
  per-kind counts, the simulation id). `--json` adds the resolved ids:

```json
{
  "envId": "d3f1…", "envAction": "created",
  "devices": {"created": [{"id": "…", "name": "Room Sensor"}], "updated": [], "unchanged": [], "deleted": []},
  "agents":  {"created": [{"id": "…", "name": "Climate Bot"}], "updated": [], "unchanged": [], "deleted": []},
  "simulationId": "9ab2…", "simulationReused": false,
  "warnings": [], "errors": [], "ok": true
}
```

- Applying the same document twice is a no-op for the WORLD (everything
  `unchanged`) — but a `simulation:` block still creates a fresh run each
  time; that is exactly what the live-sim warning / `--reuse-sim` cover.
- Geo worlds: `map: {type: geo, center: {lat, lng}, zoom, zones: [{id,
  polygon: [[lat, lng], …≥3]}]}`; device positions are `{lat, lng}`.

### For AI authors

- The schema is the contract — read `schema/world-document.schema.json`
  (or this section) and emit exactly those fields; unknown fields are
  rejected with `path: unknown field (allowed: …)` errors.
- Every validation issue carries its document path (`devices[2].zone:
  …`) and you always get the complete list in one run — fix them all,
  don't iterate one at a time.
- A document is **idempotent**: apply it, inspect the JSON summary, and
  only iterate on entries that are not `created`/`unchanged` as expected.
- Full loop: `env export` an existing world → edit the document →
  `apply` it under a new `environment.name` to clone a world.

## Quickstart (copy-paste)

```bash
alias eaf="npx tsx apps/cli/src/main.ts"     # or: npm link -w @active-collaboration/cli
eaf auth register --email me@example.com --password secret123 --name Me --json
eaf apply -f apps/cli/examples/world.grid.yaml --json          # → envId + simulationId
eaf env get my-lab --full
eaf sim status <simId> --json
eaf sim step <simId> --n 20 --json
eaf sim snapshot <simId> --zones
eaf sim inject <simId> --type temperature-spike --zone room-a --parameter temperature --value 40
eaf sim watch <simId> --json        # Ctrl+C to stop
```

## Development

```
apps/cli/
  src/main.ts        entry (shebang) — wires run() to the process
  src/cli.ts         dispatch, global flags, error → exit-code mapping
  src/commands/      auth, env, device, agent, catalog, service, sim, apply,
                     import-ifc, import-floorplan
  src/world/         document parse/validate/export/apply engine
  src/test/          vitest e2e (real server subprocess, in-process CLI)
  schema/            world-document JSON Schema
  examples/          ready-to-apply world documents
```

Conventions worth knowing: native `fetch` + `node:util` `parseArgs` (no
commander); `yaml` is the only runtime dependency; output discipline lives
in `src/output.ts` (JSON mode ⇒ stdout is payload-only); tests boot
`apps/server` exactly like `apps/web/scripts/multiuser-check.mjs`.
