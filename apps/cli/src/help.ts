/**
 * Help text — `eaf help`, `eaf --help`, `eaf <command> --help`.
 *
 * T48 (R5, u1-F1): the what-if paragraph's example sentences are 收编 into
 * the core's UNMAPPED_WHAT_IF_EXAMPLES table — ONE data table feeds the
 * unmapped error AND this help, and the copy-consistency gate parses every
 * entry. The help can no longer teach a shape the parser rejects.
 * T68b (R7, u1-F1): the EN examples joined the 收编 — the "building D"
 * sentence the help quotes is the table's own entry (parsed by the
 * consistency gate against the D-building device), never a second copy.
 */
import { UNMAPPED_WHAT_IF_EXAMPLES } from '@active-collaboration/core';

export const GENERAL_HELP = `eaf — command line for the Active Collaboration platform

Usage: eaf [--server <url>] [--json] [--version] <command> <subcommand> [flags]
  eaf --version    artifact fingerprint (version / loaded-build mtime / git rev) —
                   record it with every bug report and acceptance capture

Commands:
  auth      login, logout, whoami, register, set-name
  env       list, get, create, delete, join, leave, members, delegates,
            proposals, session, export, deployment, guide, set-guide,
            set-default-sim, set-occupant-schedule, activity, training-export,
            eval-run, asks
  device    list, get, add, rm
  agent     list, add, update, rm, command, ask, what-if
  catalog   list, get
  service   list, get, publish, subscribe, unsubscribe, computation …, access … (hidden-service grants)
  flow      list, get, add, adopt, update, rm, enable, disable, runs
  blueprint list, show, create, rm, install, uninstall (application templates)
  agreement propose, list, get, decide, counter, remind, suspend, hold,
            resume, terminate, invoke, read, usage, receipts, stream
  notifications  list, read, read-all
  admin     backup, invites, users (ADMIN_EMAILS-gated operator actions)
  me        workbench overview + todo counts (待办门铃); quotas;
            webhook set/show/clear
  sim       create, start, pause, resume, hibernate, step, stop, status,
            snapshot, inject, command, run-flow, watch, eval
  sandbox   create, list, stop (环境只读副本演练 + adopt-config 晋升回路)
  scenario  validate, lint, list (offline scenario file tooling)
  scenario-templates  list, show (built-in scenario templates, online)
  apply     apply a declarative world document (-f world.yaml)
  import-ifc  import an IFC (BIM/STEP) building model to scenario JSON
  import-floorplan  import a floor-plan image (PNG/JPEG) via a vision LLM
  help      this help

Global flags (accepted before OR after the command):
  --server <url>   API base URL (default: $EAF_SERVER, else saved config,
                   else http://localhost:8100)
  --profile <name> session profile (default: $EAF_PROFILE, else the default
                   profile) — the session lives in config-<name>.json
  --lang <locale>  human-mode output language (default: $EAF_LANG, else
                   en-US; e.g. zh-CN) — JSON output is never localized
  --json           machine output: pretty JSON on stdout, logs on stderr
  -h, --help       help for the current command

Exit codes: 0 ok · 1 runtime error · 2 usage error · 3 auth error · 4 not found

--json error contract (T58): when a command FAILS under --json, stdout
carries the structured error — the server's error body VERBATIM for API
failures (same code/details as the REST face, e.g. COMPUTATION_SCHEMA_DRIFT),
or {error:{code:"CLI_USAGE"|"CLI_AUTH"|"CLI_NOT_FOUND"|"CLI_ERROR"}} for
CLI-local failures — while stderr keeps the human line. Scripts: parse
stdout, branch on error.code; do not scrape stderr.

Config: ~/.eaf/config.json (override dir with $EAF_HOME) stores server+token,
mode 0600; --profile <name> uses config-<name>.json instead. The token is
never printed.

Run "eaf help <command>" for per-command details.`;

export const COMMAND_HELP: Record<string, string> = {
  auth: `eaf auth — account session

  eaf auth register --email <e> --password <p> --display-name <display> [--invite-code <code>]
      Create an account, then log in (token saved to config).
      --display-name maps to the API field displayName; --name is kept as a
      backwards-compatible alias. --invite-code carries a platform invite
      code — required only when the server runs invite-only
      (EAF_INVITE_ONLY; the server's 403 INVITE_REQUIRED says so).
  eaf auth login [--email <e>] [--password <p>]
      Log in; prompts (hidden) for missing values on a TTY. Persists the
      token and server URL in ~/.eaf/config.json (0600).
  eaf auth whoami
      Print the current user and the active profile (exit 3 when logged out).
  eaf auth set-name <displayName>
      Rename the current account (PATCH /api/me) — the repair path when a
      name was mangled at registration.
  eaf auth logout
      Clear the stored token (best-effort server-side cookie clear).

  Profiles: pass --profile <name> (or set $EAF_PROFILE) on any auth command
  to use a separate session file (config-<name>.json) — log several
  accounts in side by side. --json output carries "profile" (null for the
  default profile).`,

  env: `eaf env — environments (shared worlds)

  eaf env list [--mine|--public]
  eaf env get <id|name> [--full]
      --full also prints zones, devices, agents, members. Zones carry their
      consent class (T-058a, R14): 'supervised' zones — wards, clinics,
      machine rooms — force every proposal touching them to escalate to the
      environment owner (AI review advises, never auto-applies there); the
      summary names the supervised zones so you see the gate BEFORE
      proposing an install.
  eaf env create --name <n> [--desc <d>] [--map-type grid|geo]
                 [--visibility public|private]
  eaf env create --from-template <id> --name <n> [--visibility public|private]
      Create an environment from a built-in scenario template (see
      'eaf scenario-templates list') in one step — the template's
      meta.name→env-name detail is handled for you. --desc/--map-type do
      not combine with --from-template.
  eaf env delete <id|name>
  eaf env join <id|name> | eaf env leave <id|name>
  eaf env members <id|name>
      List members. Owner/builder see ids + emails; viewers and non-members
      see a redacted view (displayName + role only).
  eaf env members add <id|name> (--email <e>|--user-id <u>) --role builder|viewer
      Owner invites a registered user. Immediate effect: the env appears in
      the invitee's "env list" (private envs included), no accept step.
  eaf env members invite <id|name> --email <e>[,<e2>…] [--role builder|viewer]
      Owner invites by email, registered or not (pending invite): an
      unregistered email is held as a pending invite and joins the env
      AUTOMATICALLY when that email registers; a registered email is added
      immediately. Several emails in one call.
  eaf env members set-role <id|name> <userId> --role builder|viewer
      Owner changes a role (the owner role itself cannot change).
  eaf env members remove <id|name> <userId>
      Owner removes a member; a member may remove themselves.
  eaf env delegates <id|name>
      Active decision delegations (T-072): who besides the owner may decide
      what. v1: zone-claim decisions, one delegate at a time, optionally
      narrowed to specific zones.
  eaf env delegates grant <id|name> (--email <e>|--user-id <u>) [--zones z1,z2|--all-zones]
      Owner delegates zone-claim decide rights to a member (default: all
      zones; re-grant to the same member refreshes the zone scope; a
      different member requires revoke first — the 409 teaches it). The
      delegate is notified and can then decide escalated zone-claim
      proposals in scope; membership removal/leave revokes automatically.
  eaf env delegates revoke <id|name> <userId>
      Owner revokes the delegation (the delegate is notified).
  eaf env proposals <id|name> [--status <status>]
      The environment's proposals (members see all, strangers their own).
      Rows the CALLER may decide right now are marked decide=* (owner: every
      escalated proposal; a zone-claims delegate: escalated zone-claims in
      their zone scope).
  eaf env proposals decide <proposalId> (--approve|--reject) [--reason <text>]
      Close the governance loop from the CLI (R40-A1): the escalated
      proposal's decider approves or rejects it. Owner decides everything; a
      zone-claims delegate decides in-scope zone-claims. --approve applies
      the change immediately (created objects are named); teaching 403/409s
      name the right holder and the proposal's state.
  eaf env proposals remind <proposalId>
      The AUTHOR's polite nudge on a still-escalated proposal: one
      proposal.reminded notification to the decider (owner + covering
      delegate for zone-claims). Rate-limited to one per 10 minutes,
      anchored at proposal CREATION or the last reminder (429 names the
      earliest retry time).
  eaf env proposals revert <proposalId>
      Proposal author or env owner undoes an APPLIED proposal: the inverse
      operation runs against the world (install removes, modify restores
      before-state…) and a revert entry lands in the command log.
  eaf env session status <id|name>
      The environment's authoritative world session (living-worlds P1W),
      READ-ONLY: status / sim time / simulation id / wall anchor / observers
      / checkpoint info, plus any schema-drift notes from the last hibernate
      window. Never materializes a session — when none exists yet it says so
      (one is created on demand by the world-needing lanes).
  eaf env export <id|name> [-o file] [--format yaml|json]
      Export a world document that round-trips through "eaf apply".
      Format defaults to the -o extension, else YAML on stdout.
  eaf env deployment <id|name>
      Your deployment manifest for the environment (member only): agents to
      run, devices to procure (vendor/model/price/purchase URL), services to
      offer, external services to sign. Human mode prints a procurement
      summary; --json prints the raw manifest.
  eaf env guide <id|name>
      Show the owner's structured world guide (purpose / zone tour /
      per-role directions / service map) — the latecomer's intro. Human
      mode appends a generated 服务速查: the offers visible to you
      (public + members) with the service ids "eaf agreement propose"
      takes (one-hop signing).
  eaf env set-guide <id|name> [--purpose <t>] [--zone-guide <t>]
                    [--service-map <t>] [--role-builder <t>] [--role-viewer <t>]
                    | -f <guide.json> | --clear
      Owner writes the world guide (Fix-19). Flags set individual fields;
      -f reads a full guide JSON object from a file; --clear removes it.
  eaf env set-default-sim <id|name> <simId|--clear>
      Owner binds the environment's DEFAULT simulation (T122): the ask /
      what-if / read default lanes target it while it is RUNNING, so shared
      multi-sim worlds stop hitting AMBIGUOUS on every call. Answers
      disclose "使用环境默认仿真 X"; if the bound sim stops or is deleted
      the binding is honestly inert — the lanes fall back to the standard
      adjudication, disclose it, and point here to rebind or --clear.
      An explicit --simulation / simId on a call always wins over the
      binding.
  eaf env set-occupant-schedule <id|name> <zoneId> --count <n> --start <sec> --end <sec> [--one-shot]
  eaf env set-occupant-schedule <id|name> <zoneId> --clear
  eaf env set-occupant-schedule <id|name> <zoneId> --overlay '<json>' | --clear-overlay
      Owner installs/replaces a zone's occupantSchedule at RUNTIME (FEAT-07)
      — no environment rebuild: the change lands in the live world session
      (and any env-backed sim) and persists for the next materialize.
      --start/--end are sim-time seconds of the day (28800 = 08:00,
      64800 = 18:00); --one-shot marks the window non-repeating. --clear
      drops the timetable (the standing headcount is untouched). The echo
      reports how many live runtimes took the change (0 = stored only).
      --overlay (FEAT-07 phase-2) installs a TEMPORARY calendar overlay —
      '{"schedule":{"count":40,"startSimTimeSec":21600,"endSimTimeSec":86400},
      "startsAtSimSec":86400,"endsAtSimSec":691200}' replaces the base
      schedule inside that ABSOLUTE sim-second window (exam-week extended
      hours; the base timetable governs again at the window end);
      --clear-overlay drops it (the base takes over immediately). Overlay
      flags combine with the base-schedule flags in one call.
  eaf env activity <id|name> [--limit <n>] [--before <iso>] [--kind <k>] [--actor <substr>]
      The environment's newest-first activity feed: executed changes,
      proposal lifecycle, agreement lifecycle (default limit 50).
      Summaries name their objects (device/service names next to ids).
      --before pages backwards: entries strictly older than the ISO
      timestamp (e.g. the last entry of the previous page). --kind filters
      to one entry kind (command|proposal|agreement|event|flow — same
      vocabulary as the entries); --actor filters by actor name or id
      substring. R15-u4 F2: both flags existed and now appear in this help.
  eaf env training-export <id|name> [--sim <id>] [--from <iso>] [--to <iso>] [--format sft|dpo|structured] [-o out.jsonl]
      Owner-only training-data export (Fix-22): an NDJSON stream whose first
      line is the manifest (environment snapshot + record counts + window),
      followed by decision/collaboration/zone-sample/device-state/usage/
      reputation-snapshot records. --format (Wave-3b) switches the data lines
      to a training view: sft = {instruction, response, meta} pairs (LLM
      decisions only), dpo = {prompt, chosen, rejected, meta} preference
      pairs (effect-labelled, pairing rules in the manifest), structured =
      {instruction, response, meta} with the FULL CognitiveDecision object
      as the response (multi-field labels: situation/goals/actionPlan/
      explanation/uncertainty — cognitive architecture Phase 1). stdout
      unless -o writes a file.
  eaf env eval-run <id|name> -f runs.yaml [--no-wait] [--interval <ms>]
      Batch evaluation (Wave-3a): submit N simulation runs of the same event
      script with per-run LLM overrides, then poll until the batch finishes
      and print the cross-run comparison table. The YAML file carries
      { runs: [{label, llmClient?, llmModel?, llmPromptVariant?,
      agentOverrides?, speed?, steps?}], events: [...], promptVariants? }.
      agentOverrides (Wave-3b agent A/B) = [{agentId, capabilities?,
      llmModel?, systemPrompt?}] applied only to that run's scenario copy —
      the shared world is never touched. --no-wait prints the
      created job and exits (check later with "eaf env eval-run status <id>").
  eaf env eval-run status <jobId>
      One batch job's current state (GET /api/eval-runs/<id>): status and,
      once done, the cross-run comparison table (same rendering as the
      submitting command's wait mode). --json prints the raw job document.
  eaf env asks list <id|name> [--status open|mine|all]
      The standing-ask 需求板 (T-069): what members WANT that does not
      exist yet ("when you publish X, I want Y"). --status slices the board:
      open (default, everyone's open asks) | mine (yours, every status) |
      all (open of others + every status of yours). Member-only surface.
  eaf env asks create <id|name> --type <semanticType> [--zone <zoneId>] [--terms '<json>'] [--note <text>] [--auto-propose] [--expires <iso>]
      Post an ask: semanticType (the same vocabulary services/reputation
      key on), an optional zone (must exist — derived services match by
      their source device's zone), desired terms (the same closed schema as
      agreement propose), and --auto-propose to receive a pre-filled
      PROPOSED agreement when a matching service appears (the provider
      decides as usual; provenance is noted in terms.notes). --auto-propose
      REQUIRES terms.action: a flow-service contract only accepts
      {command: "run"} (params optional) — without an action clause every
      flow-service match skips auto-propose while still consuming the ask's
      single match (400 at creation; drop --auto-propose and propose
      manually instead). A derived-service action names the capability
      ({command: "<capability>"}). Expiry
      defaults to +30d (ceiling 365d); 10 open asks per member per env.
  eaf env asks withdraw <id|name> <askId>
      Withdraw YOUR open ask (a matched ask consumed its single match —
      409; re-ask instead).`,

  device: `eaf device — device instances inside an environment

  eaf device list --env <id|name>
  eaf device get <deviceId>
      One device's full detail (type/brand/capabilities/commands/zone/
      position/owner) — the privacy projection applies, so strangers see
      the redacted view. <deviceId> may be a short PREFIX (T88): exactly one
      visible device extends it → resolved (the mapping is declared);
      zero or several → the teaching error lists candidates (full id +
      name) — never a guess.
  eaf device add --env <id|name> --zone <zoneId> [--name <n>] [--at "a,b"]
                 (--model <catalogId> | --type <t> --capabilities a,b[,c] [--brand <b>])
      With --model: instantiate a catalog model (type/brand/capabilities
      copied). Without it: raw create; --type and --capabilities required.
      --at: "lng,lat" for geo environments, "x,y" for grid.
  eaf device update <deviceId> [--name <n>] [--type <t>] [--brand <b>]
                 [--capabilities a,b[,c]] [--zone <zoneId>] [--at "a,b"]
                 [--initial-state <json>] [--binding sim://…|hass://<entity>]
      Rename / re-zone / re-capability a device. env owner: direct edit.
      A builder updating THEIR OWN device is converted into a modify-object
      proposal automatically (same governed lane as add/rm) — --json flags
      it proposal: true with the proposal id.
  eaf device rm <deviceId>`,

  agent: `eaf agent — agent instances inside an environment

  eaf agent list --env <id|name>
  eaf agent get <agentId> [--env <id|name>]
      One agent's detail + 履约档案 (R101): per-capability reputation rows
      (score / attempts / successes / failures — the SAME P4-1 rows the
      market's service reputation reads; explicit agreement invokes score
      success AND failure, AC collaborations score via the runtime) and
      its services with trackRecord (established|none — 暂无履约记录 is
      never visually identical to a proven service) + 30-day usageSummary.
      <agentId> may be a short PREFIX (T88: unique extension resolves;
      zero/ambiguous → the candidates are named, never guessed) or the
      agent's exact DISPLAY NAME (T102: one carrier resolves; several
      sharing the name → the candidates are named).
  eaf agent add --env <id|name> --file agent.yaml
      Document: {name, capabilities: [...], bind: [device names or ids],
                 zones: [zoneIds], llm?: {...}}
      Device names in bind are resolved to ids within the environment.
  eaf agent update <agentId> [--name <n>] [--capabilities a,b] [--bind d1,d2]
                   [--zones z1,z2] [--enable|--disable] [--llm-file llm.yaml]
      Patch an agent (env owner only). --bind takes device IDS (use
      "eaf device list --env ..." to find them). --llm-file is a YAML/JSON
      document {provider, model, params?, systemPrompt?} — systemPrompt is a
      per-agent prompt override. At least one change flag is required.
  eaf agent rm <agentId>
  eaf agent command <agentId> <text...> [--sim <simId>]
      Command a RUNNING agent in plain language (cognitive architecture
      Phase 3). The agent parses the text, decides (LLM or rules), executes
      validated device actions and answers in plain language. --sim picks
      the simulation when the same agent runs in several. Emergency words
      (fire, evacuate) escalate immediately without device actions.
      <agentId> accepts the full id, a unique short prefix (T98), or the
      agent's exact display NAME (T102: one carrier resolves; several →
      AGENT_AMBIGUOUS names them).
      PERMISSION (R99): command drives the agent's full decision pipeline,
      so the requester must be the agent's owner, the environment owner, an
      admin, or the consumer of an ACTIVE agreement whose provider is this
      agent — anyone else is refused at the entry gate (403, before any
      decision runs). Unlike ask, command is NOT open to every member.
  eaf agent ask <agentId> <text...> [--sim <simId>]
      Ask a running agent a question (status, explanations). Read-only —
      never executes device commands, and open to every member (unlike
      command, which requires ownership or an active agreement — see above).
      <agentId> accepts the full id, a unique short prefix (T98), or the
      agent's exact display NAME (T102: one carrier resolves; several →
      AGENT_AMBIGUOUS names them). The answer reads the agent's OWN
      jurisdiction: a question naming an out-of-jurisdiction zone is answered
      from the agent's managed zones with an explicit ⚠ disclosure naming
      who DOES manage the zone you named (T100/T101).
      Multi-turn: a follow-up naming no zone ("那湿度呢？") inherits the zone
      of the previous turn for 10 minutes (per agent); naming a new zone
      switches; "全部/全楼/all zones" answers the whole jurisdiction. The
      answer leads with the parameter you asked about.
  eaf agent what-if <agentId> <text...> [--sim <simId>]
      Predict, don't act (cognitive architecture Phase 4): run a
      hypothetical on a private FORK of the live world (never mutates it).
      <agentId> accepts the full id, a unique short prefix (T98), or the
      agent's exact display NAME (T102).
      Accepted question shapes (T25): open with "what if …" / "what-if …" /
      "suppose …" / "如果…", or use a zh tail question "……会怎样 / 会怎么样"
      (it must carry a mappable intervention: a device, or an adjust/toggle
      verb). Absolute setpoints work without the 温度 noun too (T42):
      「${UNMAPPED_WHAT_IF_EXAMPLES.zh.join('」「')}」.
      A type/zone reference works too — ${UNMAPPED_WHAT_IF_EXAMPLES.en
        .map(example => `"${example}"`)
        .join(', ')} (the AC named
      by type, the building by name; <device> = a device name or id).
      Relative asks (「调高/调低 N 度」) resolve only when
      the device's live state exposes its current setpoint — otherwise
      state the ABSOLUTE target. T87 (R11, u1-F3): the examples above —
      zh AND en — are the parser's own promise AS SHAPES (one shared
      example table feeds help and errors); a type/zone example
      ("the AC in building D" / 「<分区> 的空调」) then resolves its target
      against the world's REAL device roster — when several devices match
      and the asking agent binds none of them, the parse honestly refuses
      NAMING the candidates (name one device and ask again — never a
      single-sided verdict about a device the question did not name).
      Prints the verdict (improvement/neutral/degradation; inconclusive =
      all-zero deltas, low signal — the explanation names the likely causes
      in checking order and WHICH device was simulated), confidence, the
      FORK PROVENANCE line (which world was simulated, its sim-time anchor
      and window — T27: pass --sim to fork YOUR named sim instead of the
      env's authoritative world session), and a per-metric delta table;
      the text lane also accepts --text "…". --json carries the full
      series + contributions. The lookahead cap comes from the scenario's
      meta.whatIfQuota.`,

  flow: `eaf flow — 业务流（"when <trigger> → run <plan>" 自动化）

  eaf flow list --env <id|name>
      Table: id / name / enabled / trigger kind / 最近运行. --json prints the
      flows array.
  eaf flow get <flowId>
      Full detail including the trigger and plan JSON. <flowId> may be a
      short PREFIX (T88: unique extension resolves against the flows you
      can see, the mapping is declared; zero or several → the teaching
      error — never a guess).
  eaf flow add --env <id|name> --file flow.yaml
      Document: {name, description?, enabled?, trigger, plan}.
      trigger: {kind: event, eventType?, zoneId?, parameter?, conditions?}
             | {kind: condition, zoneId, conditions: [{path, op, value}],
                cooldownSimSec?, activeWindowSimSec?: [startSec, endSec]
                — FEAT-01 日内活动窗（秒-of-day），start > end 跨午夜，
                窗外谓词读 false（凌晨物理噪声不误触）}
             | {kind: schedule, atSimTimeSec?, everySimSec?,
                startAtSimTimeSec?, endAtSimTimeSec?,
                atTimeOfDaySec? — FEAT-01 日内时刻锚点（84600 = 每天 23:30）,
                relativeToOccupancy?: {zoneId?, before: arrive|depart,
                offsetSec} — FEAT-01 作息相对锚点（到馆前 30 分钟预冷 =
                {before: arrive, offsetSec: 1800}）}
      plan: {goal, nodes: [{id, capability, assigneeAgentId?, params?,
             dependsOn?, condition?, onFail?, crossZone?}]}
      crossZone: R1（B1-8/P-17）显式跨区声明。zone 收敛的运行拒绝驱动另一
        分区的设备；crossZone: true 声明钉定就是有意跨出触发 zone（典型：
        消防疏散广播），authoring 的 zone 检查与运行期 invoker 同口径放行
        （详见 docs/flow-authoring.md「同属主内的显式跨区」）。
      The server statically validates every flow; a 422 FLOW_INVALID prints
      each issue (level / nodeId / message) on stderr and exits non-zero.
      Non-blocking warnings (e.g. capability drift T1; an eventType this
      world's scenario never declares — the flow may never fire unless that
      type is injected, T78) ride the create/patch response as
      validationWarnings.
  eaf flow adopt --env <id|name> --file flow.yaml --fork <forkId> [--eval-run <id>]
      P2F 提案式晋升: promote a fork-VALIDATED flow into the authoritative
      environment through the governance pipeline (an adopt-config proposal
      carrying the definition + the source fork lineage; --eval-run attaches
      A/B evidence). The answer is the PROPOSAL (id/status), never a fake
      flow — the flow enters the env when the pipeline approves it.
  eaf flow update <flowId> [--file flow.yaml] [--name <n>] [--enable|--disable]
      --file supplies a full new document (name/description/enabled/trigger/
      plan); --name and --enable/--disable override individual fields.
      At least one of them is required.
  eaf flow enable <flowId> | eaf flow disable <flowId>
      Shortcut for PATCH enabled. Takes effect immediately in running
      simulations; a disabled flow never triggers (manual runs included).
  eaf flow rm <flowId>
  eaf flow runs <flowId> [--limit <n>]
      The flow's execution ledger, newest first (the server keeps at most 50).
      <flowId> may be a short PREFIX (T88 — same resolution as flow get).
      Table: startedAt / triggerKind / sim / status / summary; the sim column
      attributes the run's world (world-session = the platform's
      authoritative world session; otherwise the member sim's short tail —
      full ids on --json). A drifted run shows
      "status (degraded: capability 'x' not declared by 'agent'; N/M nodes
      executed via bound devices)" (T36 wording). Drift is a governance-face
      annotation, NEVER an execution failure: 漂移≠失败 — the status and the
      N/M count still tell the execution truth. --json prints the runs
      array. Manual trigger:
      "eaf sim run-flow <simId> <flowId>".`,

  catalog: `eaf catalog — real-hardware device catalog

  eaf catalog list [--type <t>] [--vendor <v>] [--q <text>]
  eaf catalog get <modelId>`,

  service: `eaf service — service marketplace (what agents OFFER)

  eaf service list (--env <id|name> | --all) [--provider <agentId>]
                   [--type <semanticType>] [--origin derived|published]
                   [--q <搜索词>]
      The scope flag is required: --env limits the listing to one
      environment (the common case after joining a world); --all aggregates
      the services of every environment you can see (an environment that
      fails to answer is skipped with a warning) and heads the human table
      with a scope summary line.
      --q runs the full-text marketplace search over name / description /
      semantic type: Latin tokens match as case-insensitive substrings,
      Chinese text matches as an in-order character subsequence, so
      "温度" also hits "温湿度计" (Wave-1a, R8 F-02).
  eaf service get <serviceId>
      One offer's full detail: origin, visibility, provider agent + owner,
      reputation (learned track record) + trackRecord marker + usageSummary
      (R101: 30-day verifiable履约摘要 — invocations/succeeded/failed/
      successRate, aggregate-only, same source as the parties' usage rows).
      <serviceId> may be a short PREFIX (T88: unique extension resolves;
      zero/ambiguous → the candidates are named, never guessed).
      T49 (R5, u3-F1): when the provider agent does not declare the
      offer's capability, the detail carries the SAME drift line as the
      "service list" ⚠ column — "provider 未声明 '<type>'（设备仍可
      执行）" (drift is a governance-face annotation, 漂移≠失败; the JSON
      field is declaredByProvider:false, and the marker disappears once the
      capability is re-declared).
      T68a (R7, u2): the detail also renders the signing gate's verdict
      (signability) — backed（签约预检通过）/ ambiguous（⚠ 点名候选承载设备，
      propose 将 409 SERVICE_BACKING_AMBIGUOUS；T84 起另一种 ambiguous：
      读源从未被写——签约不拦；T86 起预警按读道分层：探测世界就是你的默认
      读道（有自有 sim → 你的 sim；无 → 权威 world-session，GET 只看已存活
      会话、从不创建），带自有 sim 的 read 将诚实拒绝
      COMPUTATION_DEVICE_STATE_UNWRITTEN，而无自有 sim 时默认读落到
      world-session、可能成功返回世界初始化值（占位、可能长期不变），
      ⚠ 行点名字段、读道与修复路径）/ unbacked（⚠ 无可履约承载，口径按
      origin 分道（T103）：aggregate 行按 rule 道判定——签约将 409
      SERVICE_NOT_BACKED；published 行签约不拦（T84：投机合约是合法
      的，按此预期签约），但 invoke 将诚实拒绝 SERVICE_NOT_BACKED，
      read 按读源分道（T108）：zone-query 计算走 zone 参数面、世界参数
      在即成功返回并计量，设备态读源则诚实拒绝），each with
      the gate's reason verbatim — the same judgment the "service list"
      signability column marks.
      Reputation 口径: every metered invoke of an EXPLICIT agreement scores
      the provider (success AND failure); AC collaborations score via the
      runtime's Fix-12 pipeline (never double-counted); consumer probing
      errors (vocabulary/capability) never count; a service with zero
      attempts shows trackRecord='none' (暂无履约记录) — never identical
      to a proven one. Flow-services (MI-D) add the generated run surface:
      the flow's input parameters and the delegate-node count.
  eaf service publish --env <id|name> --agent <agentId> --name <text>
                      --type <semanticType> [--flow <flowId>]
                      [--description <text>] [--visibility public|members|hidden]
      Publish an explicit offer through one of your agents. --flow (MI-D,
      mechanism D) publishes a FLOW-SERVICE: the flow must be enabled with
      a declared inputs surface ([] = zero-arg) and the agent must sit in
      the flow author's T-201 scope; the interface is generated from the
      surface (actions: [run] + parameter schema + delegate count), flow
      edits refresh it, deleting the flow unpublishes. Invocation delivers
      one metered run (unit flow-run): eaf agreement invoke <id> --action
      run --params '<json>'.
  eaf service subscribe <serviceId>
      Bookmark an offer as "我依赖的服务" (idempotent — says so when you
      were already subscribed). Login required.
  eaf service unsubscribe <serviceId>
      Drop the bookmark. Login required.
  eaf service computation register <serviceId> --spec '<json>'
                        [--interface '<{"dataSchema":{"fields":[...]}}>')
      Register the declarative computation that makes a PUBLISHED data
      service readable (idempotent replace). The spec is a closed schema:
      kind zone-query|device-aggregate, refreshSec, inputs { zones,
      devices?, metrics }. inputs.devices (T-065) scopes the computation to
      EXACT device ids — the per-bed form names only that bed's device
      (must be devices bound to the provider agent; the frame's
      inputsSummary.devices then counts exactly the scoped set).
      interface.dataSchema must list exactly the spec's "as" fields.
  eaf service computation get <serviceId>
      The registered spec (or "no registered computation").
  eaf service computation revoke <serviceId>
      consumable flips back; active data agreements keep reading 409
      COMPUTATION_UNREGISTERED (both parties get notified).
  eaf service access request <serviceId> [--purpose <text>] [--days <n>]
      T-058b (R14): request access to a HIDDEN service (members only —
      outsiders get a plain 404). The provider decides; there is no SLA
      (remind is the only nudge, 10-minute rate limit).
  eaf service access requests <serviceId>
      The provider-side request queue (provider agent owner / env owner).
  eaf service access close <serviceId> <requestId>
      Withdraw your own request, or (provider) explicitly reject one.
  eaf service access remind <serviceId> <requestId>
      Nudge a pending request of yours (10-minute rate limit, anchored at
      request creation).
  eaf service access grant <serviceId> (--request <id> | --user <userId>)
                        --expires <iso> [--basis <text>]
                        [--data-subject '{"ref":"resident-101-2"}']
      Provider agent owner / env owner: open the door for one member until
      the expiry (a repeat grant EXTENDS). The grant opens visibility
      (list/get/propose); consumption scope still needs an agreement with
      terms.read. --data-subject labels the data subject declaratively.
  eaf service access grants <serviceId>
      The provider-side grant ledger (who, until when, on what basis).
  eaf service access revoke <serviceId> <userId>
      Close the door: the service answers 404 for them again; active
      agreements keep their status but reads answer 409 ACCESS_GRANT_REVOKED.`,

  'blueprint': `eaf blueprint — application blueprints (one-click app templates, Fix-38)

  eaf blueprint list [--builtin-only]
      Built-in + custom blueprints (the Web sidebar's Blueprint tab). Table:
      id / name / kind / device-agent-flow counts / description; --json prints
      the blueprints array. --builtin-only hides custom ones.
  eaf blueprint show <blueprintId>
      The full blueprint JSON (definition with template variables like
      \${zoneId}) — paste/edit/repost material for "blueprint create".
  eaf blueprint create --name <n> [--desc <d>] --file definition.yaml
      Register a custom blueprint. The file is the definition document
      {devices: [...], agents: [...], flows?: [...]}; .yaml or .json.
  eaf blueprint rm <blueprintId>
      Delete a CUSTOM blueprint (built-in ones are refused by the server).
      Deleting a blueprint does not uninstall its past installs.
  eaf blueprint install <blueprintId> --env <id|name> --zone <zoneId>
      Install into a target zone of an environment (builder/owner):
      resolves \${zoneId} template variables and creates the devices, agents
      and flows in one atomic call, then prints every created id. The objects
      keep their blueprint lineage (installed_from) on the server.
  eaf blueprint uninstall <blueprintId> --env <id|name>
      Remove every object installed from this blueprint in the environment
      (builder/owner): flows + agents + devices matched by their
      installed_from lineage. Idempotent — a repeat uninstall reports zeros;
      works even after the (custom) blueprint itself was deleted.`,

  agreement: `eaf agreement — service agreements (contract-grade consumption, Fix-11)

  eaf agreement propose <serviceId> [--consumer-agent <agentId>] [--terms '{}']
      Propose a bilateral agreement on a visible offer (the heavyweight
      upgrade of "service subscribe"). All terms are optional (absent =
      unlimited); price fields are unit-neutral passive data. Fields:
      meteringUnit/quotaPerWindow/windowSec/windowKind/pricePerUnit/priceUnit/
      notes, plus structured trigger {eventType?,parameter?,threshold?,zoneId?}
      and action {command,params?} (Wave-4a: contract data only — nothing
      auto-executes on the trigger yet). Unknown fields are rejected (400).
      R6-C-F02: targetZoneId claims the zone the action must physically reach
      (signing-time reachability gate: same/adjacent zone or 422
      SERVICE_ZONE_UNREACHABLE; delivery:'propagation' is the declared
      system-level exemption).
      windowKind: 'sliding' (default, last windowSec seconds) | 'fixed'
      (tumbling windows anchored at the moment the agreement went active).
      LIFECYCLE NOTE (R99): this command creates an EXPLICIT agreement — it
      terminates only by a party's decision (suspend/terminate). The other
      kind, AC ephemeral agreements (landed automatically when an agent
      collaboration completes a handshake), AUTO-TERMINATE when the
      collaboration completes or is cancelled — by design. Either way a
      terminated agreement stays queryable forever: agreement get / usage /
      receipts keep working and report terminatedAt + outcome; your newest
      terminated agreements also ride every 'eaf agreement list' response
      (recentlyTerminated) and the --include terminated view.
  eaf agreement list --env <id|name> [--role consumer|provider] [--status <s>]
      Agreements you are a party to (env owners see their env's). Status:
      proposed|countered|active|held|rejected|suspended|terminated.
      Human mode also prints a "recently terminated" hint when your own
      agreements just reached the terminal state (R99 — an auto-terminated
      agreement must never look vanished); --include terminated lists the
      env's terminated history (members: full view; public-env strangers:
      the restricted anonymized view).
  eaf agreement get <agreementId>
      One agreement's full detail: status, parties, effective terms
      (countered terms win while countered), hold expiry while held, plus
      the server's pre-flight hints (backing-device drift, contended
      device-param warnings). Visible to both parties and the env owner.
      TERMINATED agreements are also readable as world history: env members
      and public-env strangers get the RESTRICTED view (participants named
      as agents, service/outcome/time only — no owner identities, no
      terms); parties and the env owner keep the full view.
      <agreementId> may be a short PREFIX (T88) — get, usage, receipts,
      decide, read and invoke resolve it against the agreements you can
      see: unique extension resolves (the mapping is declared); zero or
      several → the teaching error lists candidates (full id + service
      name) — never a guess.
  eaf agreement decide <agreementId> accept|reject [--reason <text>]
      Decides the agreement IN ITS CURRENT STATE (T-059): proposed → the
      provider decides; countered → the CONSUMER decides the provider's
      counter-offer (accept = the countered terms become the contract).
      R102: --reason (optional, ≤500 chars) writes the decision reason into
      statusReason — the other side sees it in their notification and in
      agreement get (human AND --json; without one the field shows
      未记录原因, never a bare null).
  eaf agreement counter <agreementId> --terms '{}'
      Provider only, from proposed (T-059): answer with FULL new terms
      (same validation as propose; identical terms are rejected). Depth 1 —
      after a counter the consumer decides; renegotiation means terminate
      and re-propose. Countering a prose-only proposal with structured
      terms.action / terms.read tightens the contract on acceptance.
  eaf agreement remind <agreementId>
      Nudge the current decider (T-309/T-059, symmetric): the consumer
      reminds while proposed, the PROVIDER reminds while countered.
      Rate-limited to one nudge per 10 minutes (anchored at proposal
      creation).
  eaf agreement suspend <agreementId> [--reason <text>]
      Provider only, from active. IRREVERSIBLE (R99, by design — no
      suspended→active edge): the agreement stays suspended until
      terminate (you may then re-propose). If you need pause-AND-resume
      semantics, use the consumer's hold instead — a hold auto-expires
      back to active. The human-mode output and the --json response
      (irreversible:true + note) both say so; resume on a suspended
      agreement errors with this same guidance. R102: --reason writes
      the suspension reason into statusReason (consumer's notification
      + agreement get carry it).
  eaf agreement hold <agreementId> [--duration <sec>]
      The consumer's bounded circuit breaker (D3, T-080): suspends
      auto-trigger execution and manual invokes for THIS agreement only —
      quota untouched, provider notified, auto-expires at the hold's expiry
      (default 600s, server cap 3600s). Consumer only, from active.
  eaf agreement resume <agreementId>
      End your own hold early (back to active).
  eaf agreement terminate <agreementId> [--reason <text>]
      Either party, from any non-terminal state. R102: --reason writes
      the termination reason into statusReason (other side's notification
      + agreement get carry it).
  eaf agreement invoke <agreementId> --action <a> [--params '{}']
      Consumer only, active agreements only. Executes synchronously inside
      the environment's RUNNING simulation — the provider agent commands its
      own backing device. No running simulation → error (start one first:
      eaf sim create --env ... && eaf sim start <simId>). Every invoke is
      metered (usage record) and settled (Null provider archives a receipt).
  eaf agreement usage <agreementId>
      The agreement's append-only usage records (both parties + env owner).
      <agreementId> may be a short PREFIX (see agreement get, T88).
      --json passes the REST envelope through: { usage: [...], view?:
      'restricted' } (T38.3 — was a legacy bare array; scripts consuming the
      CLI's --json must read .usage now).
  eaf agreement receipts <agreementId>
      The agreement's settlement receipts (§3.4; both parties + env owner).
      <agreementId> may be a short PREFIX (see agreement get, T88).
      The default Null provider archives metering batches as status=recorded
      receipts (quote=null — no amounts, no money moves).
  eaf agreement read <agreementId> [--fields a,b] [--simulation <simId>] [--latest]
      Pull one data frame from a computation-backed data service (R14,
      design-data-services.md §4) — metered as kind=read, settled with a
      receipt. --latest takes the cache-first cheap path; --fields narrows
      (never widens) the terms.read.fields scope; --simulation targets a
      specific running sim. Human mode prints the frame + freshness/
      provenance — values carry their platform units (T46), and an empty
      event window is called out explicitly: "0 = 无事件，不是真实读数"
      (T51). With no --simulation the read targets YOUR running sim when
      you have one, else the env's authoritative world session (T51) —
      which world served the frame is on the provenance line and in --json.
      A value metric with no usable input refuses 409 instead of serving a
      null-into-success delivery (T50); --json carries the full
      DataReadResult.
  eaf agreement stream <agreementId> [--params temperature,co2]
      Follow the agreement's observation stream (§3.2.2, WebSocket): the
      provider device's parameter changes inside the running simulation.
      --params narrows the push to frames where a listed parameter changed
      (server-side filter, Fix-20). The server closes the stream when the
      hosting simulation stops (Wave-6). NDJSON under --json (aligned with
      \`sim watch\`); Ctrl+C to stop.`,

  sandbox: `eaf sandbox — 沙箱（环境副本·只读演练）生命周期（R101）

  eaf sandbox create --env <id|name> [--from-checkpoint] [--overlays p1[,p2]]
      Fork the environment into an isolated sandbox — ANY member incl.
      viewers (the tutorial's promise), same gate as running a simulation.
      The fork is a READ-ONLY rehearsal copy: nothing inside writes back to
      the authoritative world; experiment via its simulation (sim commands
      / what-if), promote changes back via adopt-config proposals.
      --from-checkpoint copies the authoritative world's CURRENT dynamics;
      --overlays selects which applied inject-scenario proposals' events
      the fork keeps (omitted = the world as-is, empty = pure base layer).
      NOTE: 沙箱 ≠ 蓝图——「蓝图」是应用模板安装包（一键装设备+Agent+
      业务流），沙箱是把当前环境存成副本。
  eaf sandbox list --env <id|name>
      The env's sandboxes (env owner: all; others: own + joined).
  eaf sandbox stop <sandboxId>
      Stop the runtime and release it (sandbox owner or env owner;
      idempotent). All commands --json-capable.`,

  me: `eaf me — 我的工作台（Fix-16）

  eaf me [--json]
      Workbench overview: per-env ownership totals plus the todo doorbell —
      待批提案 (escalated proposals in envs you own), 待处理合约 (agreements
      awaiting your accept), 未读通知. Human mode prints a summary; --json
      prints the raw /api/me/overview payload.
  eaf me quotas
      Your quota usage (P4-4): each quota's configured limit and your
      current usage — environments per user, devices/agents per env (the
      used count is your FULLEST owned environment), running sims, active
      sandboxes. Human mode prints a table; --json the raw payload.
  eaf me webhook set <url> | show | clear
      Outbound notification webhook (Wave-4b): every notification of yours is
      POSTed to <url> as JSON (http(s) only; 5s timeout, one retry, then
      dropped — the pull inbox stays the durable copy). NOTE: the webhook
      receives the FULL notification payload, sensitive content included.
      There is no email channel (no SMTP infrastructure) — bridge any channel
      you want through the webhook.`,

  admin: `eaf admin — operator actions (R15-A2)

  eaf admin backup
      Consistent live snapshot of the server's SQLite database
      (POST /api/admin/backup; requires an ADMIN_EMAILS account).
      Lands in <DB-dir>/backups/eaf-<timestamp>.db — WAL-safe, no
      downtime. Restore procedure: docs/deployment.md.
  eaf admin invites list
      Platform registration invites (alpha gate EAF_INVITE_ONLY, schema
      v57) with usage statistics: uses/max, status (active/exhausted/
      expired/revoked), expiry, creator.
  eaf admin invites create [--max-uses <n>] [--expires-in-days <d>]
      Mint a new invite code (default: 1 use, no expiry). The plaintext
      code (EAF-XXXXX-XXXXX) prints ONCE — hand it to the invitee; they
      register via the web form or \`eaf auth register --invite-code\`.
  eaf admin invites revoke <code>
      Disable a code immediately (idempotent). Registrations holding it
      afterwards get 410 INVITE_GONE.
  eaf admin users list
      The registered-account roster behind the invite gate (GET
      /api/admin/users): email, display name, registration time, and an
      [admin] marker for ADMIN_EMAILS accounts. Human mode prints one row
      per user; --json prints the raw list.`,

  notifications: `eaf notifications — 通知收件箱（Fix-16）
  eaf notifications list [--unread] [--kind <k>] [--limit <n>]
      Your inbox, newest first (proposal verdicts, agreement proposals and
      decisions, collaboration answers). --unread shows only unread; the
      header line always reports the unread count. Same-key unread repeats
      arrive pre-aggregated — one row, marked ×N (R68); T59: the applied-
      class kinds (proposal.applied / auto_applied / delegate-applied)
      aggregate per environment — one row with a ×N badge and a recent-items
      digest, instead of one row per proposal. --kind <k> narrows the list
      to one kind (the mute face — e.g. --kind proposal.auto_applied);
      server-side, so limit and pagination describe the filtered view.
      --before <iso> pages
      backwards (strictly older rows — pass the createdAt of the last
      row shown; T-030). Agreement notifications
      carry a machine-readable replyHint (--json); rows marked "← your move"
      await YOUR decision (T-059: a proposed agreement waits on the
      provider, a counter-offer on the consumer — eaf agreement decide /
      counter / remind are the reply channels).
  eaf notifications read <notificationId>     Mark one notification read.
  eaf notifications read-all                  Mark everything read.

  The inbox is the persistent doorbell: events the live environment stream
  broadcast in real time land here too, so anything missed while offline
  (or on a dropped websocket) is one pull away.`,

  sim: `eaf sim — simulation runs
  eaf sim create --env <id|name> [--llm auto|llm|none] [--tick-ms <ms>] [--scheduling tick|lazy]
      scheduling=lazy runs due-driven (living-worlds P1): no fixed-interval
      tick timer — the world advances only at due moments (scheduled events,
      flow schedules, freshness floors), bit-identically to a tick run.
  eaf sim start <simId> [--speed <simSecPerTick>]
  eaf sim list --env <id|name>
      The environment's sim roster (T52): id / state / sim-time / creator /
      llm, stopped and hibernated rows included — the disambiguation view
      behind AGENT_AMBIGUOUS ("multiple sims" asks which one you meant).
  eaf sim pause <simId> | eaf sim resume <simId> [--speed <simSecPerTick>]
                 | eaf sim stop <simId>
      resume accepts --speed too (change the rate while resuming).
  eaf sim hibernate <simId>
      Freeze the world into a versioned checkpoint and release the runtime
      (living-worlds). Same sim id + history resume via \`eaf sim resume\`;
      real-device (hass://) sims refuse — their worlds keep live obligations.
  eaf sim step <simId> [--n <ticks> | --to <sec>]
      --n: manual ticks. --to: advance until simTimeSec reaches <sec>
      (mutually exclusive; may overshoot by less than one tick's speed).
  eaf sim status <simId>                 state + sim time + speed calibers
      The human face carries only reproducible rates (T83): the NOMINAL
      simSecPerTick and the sliding-window average — schedule with the
      window figure. The instant estimate stays on --json only (it is a
      non-reproducible figure; four samples in one session differed 4.4×).
      NOTE: at high world speeds (nominal rate ≥ EAF_AC_RESPONSE_FLOOR_MIN_RATE,
      default ×60 sim-sec per wall-sec) partner response windows carry a
      real-time FLOOR — the handshake window is guaranteed at least
      EAF_AC_RESPONSE_MIN_WALL_MS (default 5 real minutes); below that rate
      behavior is unchanged (120s wall-clock window). Attribution:
      handshakes.failures.byCause in sim eval. EAF_AC_HANDSHAKE_FAST_LANE=1
      (default off) puts handshake evaluations on the fast-lane LLM queue to
      relieve peak-hour backlog; off = baseline behavior.
      （注：高倍速世界（名义倍率 ≥ EAF_AC_RESPONSE_FLOOR_MIN_RATE，默认 ×60
      仿真秒/真实秒）下伙伴握手窗有真实时间下限保底——至少
      EAF_AC_RESPONSE_MIN_WALL_MS（默认 5 真实分钟）；低于该倍率行为不变
      （120 秒墙钟窗）。归因见 sim eval 的 handshakes.failures.byCause。
      EAF_AC_HANDSHAKE_FAST_LANE=1（默认关）把握手评估切到快车道 LLM 队列
      缓释洪峰积压；关闭即基线行为。）
  eaf sim snapshot <simId> [--zones] [--full]
      Human face: a summary + the per-zone params table with units
      (2-decimal display precision, stable column order, boolean flags
      grouped last). The bare full-precision dump is --json (byte-identical
      to pre-T76); --full prints it in human mode too. --zones: the table
      alone.
  eaf sim inject <simId> --type <t> --zone <z>
                 [--parameter <p>] [--value <v>] [--severity low|medium|high|critical]
  eaf sim command <simId> --device <deviceId> --cmd <name> [--params '{}']
  eaf sim run-flow <simId> <flowId>
      Manually trigger a business flow inside a RUNNING env-backed simulation
      (bypasses the flow's own trigger; recorded with triggerKind 'manual').
      Prints the run status/summary and per-node results. Disabled flow →
      FLOW_NOT_RUNNABLE; stopped sim → SIMULATION_STOPPED; a flow of another
      environment → FLOW_NOT_FOUND.
  eaf sim eval <simId>
      The evaluation report (R40-B2): decision accuracy / handshake success +
      per-agent METACOGNITION — calibration score, capability boundary
      (strong/weak/must-escalate) and trust partners. --json carries the
      full report incl. topUncalibratedActions.
  eaf sim watch <simId> [--interval <ms>] [--min-delta <n>] [--all-changes]
      Follow a run: poll the snapshot and print one-line diffs (zone
      parameter changes, new agent decisions, state transitions) until
      Ctrl+C. The poll interval defaults to 2000ms; --interval <ms>
      overrides it (minimum 100ms). T73/T88 noise discipline: a change
      that would render as the SAME 2-decimal value never emits by
      default (same-value "24.71 → 24.71" rows are impossible);
      --min-delta <n> raises the threshold to an explicit absolute
      delta, --all-changes shows every raw change again. --json
      emits NDJSON (one JSON object per line; numeric zone events carry a
      delta field).`,

  scenario: `eaf scenario — offline scenario file tooling
  eaf scenario validate <file>
      Schema + referential + capability-coverage validation. Same loader
      the server uses, plus checks the loader does not enforce: every
      event's requiredCapabilities must intersect some agent's
      capabilities (no orphan events); every event's zoneId must be in
      some agent's managesZoneIds (no unmanned zones); missing acRationale
      flagged as a warning. Exits 0 on success, 2 on errors.
  eaf scenario lint <file>
      Best-practice warnings: missing tagline/heroEventId/vendorDisclaimer,
      description too long, missing humanNarrative / focusZoneId.
  eaf scenario list
      Online: list scenarios registered on the connected server.`,

  'scenario-templates': `eaf scenario-templates — built-in scenario templates (online, auth required)

  eaf scenario-templates list
      List the server's built-in templates (id, name, zone/device/agent/
      event counts, mapType) — the same picker the create-environment
      dialog shows.
  eaf scenario-templates show <id>
      Print the full scenario JSON of one template; it can be posted to
      /api/environments as-is to create an environment from the template.`,

  apply: `eaf apply — declarative world documents (kubectl-style)

  eaf apply -f world.yaml [--prune] [--reuse-sim]

  Finds an environment you own by exact name; creates it (with the map)
  when missing, otherwise patches mapData when it changed. Devices and
  agents are upserted BY NAME — created when missing, patched when
  changed, never deleted unless --prune (which prints what it deletes).

  All document/validation errors are collected and reported together.
  When the document has a simulation: block, a simulation is created and
  started, and its id printed. If the environment already has LIVE
  (running/paused) simulations, apply warns and lists them with stop
  commands — every apply with a simulation: block creates ANOTHER sim,
  and repeated applies stack them until the running_sims_per_user quota
  rejects the create. Pass --reuse-sim to attach to the newest live
  simulation instead of creating one (a paused sim is resumed; stop
  sims with "eaf sim stop <simId>").

  Document schema: apps/cli/schema/world-document.schema.json
  Guide: apps/cli/README.md (world documents for humans and AI authors)`,

  'import-ifc': `eaf import-ifc — import an IFC (BIM/STEP) building model

  eaf import-ifc <file.ifc> [--out scenario.json] [--ir ir.json]
               [--name <n>] [--id <scenarioId>]

  Parses the IfcBuilding → IfcBuildingStorey → IfcSpace tree with web-ifc
  (WASM, local), compiles the resulting Building IR into a scenario JSON
  v1.0 file, and validates it against the full scenario schema.

  --out   scenario output path (default: stdout)
  --ir    also dump the intermediate Building IR JSON to this path
  --name  override the scenario/building name
  --id    override the scenario id (default: slug of the name)

  Rooms without extractable geometry get fallback grid cells and are
  flagged estimated in the IR — review them (and add stair/shaft
  connections, which IFC extraction does not derive yet) before loading
  the scenario into an environment.`,

  'import-floorplan': `eaf import-floorplan — import a floor-plan image via a vision LLM (B-D)

  eaf import-floorplan <image.png|jpg|webp> --building <id> --floor <n>
                 (--scale <pxPerM> | --calibrate x1,y1,x2,y2,<meters>)
                 [--ir ir.json] [--out scenario.json] [--name <n>] [--id <scenarioId>]
                 [--merge existing-ir.json] [--submit <server-url>]
                 [--provider openai-compatible|siliconflow] [--model <m>]
                 [--base-url <u>] [--storey-height <m>]
  eaf import-floorplan --from-ir ir.json [--out scenario.json] [--id <scenarioId>]
                 [--submit <server-url>]

  Sends the floor plan to a multimodal LLM (env: EAF_VISION_PROVIDER /
  EAF_VISION_MODEL / EAF_VISION_BASE_URL; default provider
  openai-compatible), turns
  the recognized rooms/connections into a Building IR with caller-confirmed
  scale, and compiles it to scenario JSON v1.0.

  Scale is NEVER taken from the drawing automatically: pass --scale
  (pixels per meter) or --calibrate with the pixel endpoints of a segment
  whose real length you know. A scale the LLM reads off the drawing is
  printed as a suggestion only.

  Confirmation loop: --ir dumps the IR for review; edit it (room boxes,
  names, cross-floor stair connections) and recompile with --from-ir.
  Multi-floor buildings: import one floor per run and chain with --merge.
  --submit posts the scenario to the server's environment import endpoint
  (POST /api/environments, requires login) — it creates a NEW environment.`,
};
