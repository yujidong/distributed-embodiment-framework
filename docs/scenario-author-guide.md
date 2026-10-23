# Scenario Author Guide

This guide walks a new author from "what is AC?" to "I shipped a new event into a running sim". For reference schema see `packages/core/src/scenario/scenario-types.ts`; for validation run `eaf scenario validate <file>` (Wave 4).

## 1. Read this first — what makes a good scenario

An Active Collaboration (AC) scenario is a JSON file that describes:

- A **world** (zones + devices with capabilities + state)
- A set of **stakeholders** (agents, each owning a subset of devices privately)
- A schedule of **events** (zone + severity + requiredCapabilities + simTime)

The scenario's job is to create situations where **no single agent has everything needed to handle an event alone** — they must discover each other's published services, negotiate, and execute. If one agent could `handle_independently`, the scenario isn't demonstrating AC.

The best scenarios are honest about WHEN AC is necessary. Use the 3-condition diagnostic below to design + self-audit each event.

## 2. Schema overview (v1.0)

Top-level shape:

```json
{
  "version": "1.0",
  "meta": { "id": "...", "name": "...", "description": "...", ... },
  "map": { "type": "geo", "center": {...}, "zoom": 11 },     // optional
  "zones": [{ "id": "...", "name": "...", "bounds"|"polygon": ..., "baseline": {...} }],
  "devices": [{ "id": "...", "type": "...", "capabilities": [...], "zoneId": "..." }],
  "agents": [{ "id": "...", "name": "...", "capabilities": [...], "managesZoneIds": [...], "boundDeviceIds": [...] }],
  "events": [{ "id": "...", "type": "...", "zoneId": "...", "atSimTimeSec": N, "severity": "...", "requiredCapabilities": [...] }]
}
```

### 2a. Bilingual fields (zh/en, future-ja/ko-ready)

Five `meta` fields and `events[].humanNarrative` accept **either** a plain
string (legacy, single-language) **or** a `{zh, en}` object. The loader
passes both shapes through; web/cli/server consumers resolve the right side
via `localizedText(value, locale)` from `packages/shared/src/i18n.ts`. New
scenarios should prefer the `{zh, en}` object form for these fields:

| Field | Example |
|-------|---------|
| `meta.name` | `{ "zh": "十分钟最小世界", "en": "Ten-minute minimal world" }` |
| `meta.description` | `{ "zh": "...", "en": "..." }` |
| `meta.tagline` | `{ "zh": "...", "en": "..." }` (this one has always been an object) |
| `meta.vendorDisclaimer` | `{ "zh": "...", "en": "..." }` (only when vendor brands are mentioned) |
| `events[].humanNarrative` | `{ "zh": "张大爷 71 岁，独居...", "en": "Mr. Zhang, 71, lives alone..." }` |

**Do NOT use the `_en` suffix** (e.g. `humanNarrative_en`). It was an early
draft that never shipped. The `{zh, en}` object form is the only supported
bilingual pattern.

Adding a future language (ja, ko) means adding a key to the object — the
type already has an index signature, so no schema change is needed. Zones,
devices, and agents names stay plain strings today (they're author identity,
not display chrome); localize them only if your scenario truly needs it.



Key invariants:
- Every `device.zoneId` must point to a zone in `zones`.
- Every `agent.boundDeviceIds` entry must be a real device id.
- Every `agent.managesZoneIds` entry must be a real zone id.
- Every `event.zoneId` must be in **at least one** agent's `managesZoneIds` — otherwise no agent receives the event.

`eaf scenario validate` enforces all of the above + extra checks (see §6).

## 3. Event topology types

Pick a topology before writing capabilities. The topology drives the AC pattern.

- **Fan-out (1 initiator → N partners)** — one agent detects an event, fans out to N specialists. Example: `evt-zhang-stroke` → hospital + cardiology + pharmacy + EMS + property.
- **Multi-initiator (N detectors → convergence)** — multiple agents independently notice the same physical event; AC converges them. Example: `evt-plume-drift` → AQI sensors in multiple zones all fire.
- **Negotiation (N parties with conflicting goals)** — agents must agree despite disagreeing. Example: `evt-hospital-ups-fail` → hospital wants power, grid wants load-shed, health-commission wants CT prioritized.
- **Real-time verification (N parties in tight time window)** — every partner must say yes within a deadline. Example: `evt-zhang-afib` → 30-min window for pharmacy verify + insurance pre-auth + cardiology dose confirm.
- **Longitudinal reconciliation (N parties over long period)** — recurring weekly/monthly coordination. Example: `evt-zhang-recovery` → 90-day polypharmacy reconciliation.

## 4. The 3-condition AC-necessity diagnostic

For each event, fill in `acRationale` honestly. AC is **necessary** only when ALL THREE conditions hold:

| Condition | Question | True when... |
|---|---|---|
| `partnerSetUnpredictable` | Is the right partner set dynamic at runtime? | The right partner depends on real-time state (who has CT open, which AV is closest, who's on call) |
| `noCentralAuthority` | Do participants span independent orgs with no boss? | Stakeholders are separate legal entities or business units that can refuse |
| `combinatorialStateSpace` | Are there too many state combinations to pre-encode? | 2^N events × M partners × K time-decaying states > any workflow engine can enumerate |

Score 3/3 → `AC-necessary`. Score 2/3 → `AC-valuable` (faster than workflow, but workflow could in principle do it). Score 0–1/3 → `AC-overkill` (workflow is enough; don't claim AC is needed).

```json
"acRationale": {
  "partnerSetUnpredictable": true,
  "noCentralAuthority": true,
  "combinatorialStateSpace": true,
  "score": "3/3",
  "verdict": "AC-necessary",
  "reasoning": "<2-3 sentences on what specifically breaks without AC>"
}
```

**Do not claim 3/3 lightly.** Reviewers will read `reasoning`. If `partnerSetUnpredictable=false` (the partner list is fixed by regulation or SOP), say so and downgrade to AC-valuable.

## 5. Common authoring pitfalls

### 5.1 Silent failures — events that don't trigger AC

**Symptom**: event fires (visible in event log) but no collaboration proposal appears.

**Causes**:
1. Event's `requiredCapabilities` don't intersect any agent's capabilities. → Run `eaf scenario validate`; it flags this as `partial-coverage` warning.
2. Event's `zoneId` isn't in any agent's `managesZoneIds`. → Validator flags as `unmanned-zone` error.
3. The managing agent has both the event's zone in `managesZoneIds` AND has all required capabilities in its own `capabilities` → engine decides `handle_independently`, no AC. Solution: split the capability — let one agent sense, another actuate.
4. Multiple agents manage the zone AND have overlapping capabilities → each initiates; most get cancelled by competition. Wave 1's `InitiatorCoordinator` dedupes this but may pick the wrong winner.

### 5.2 Wrong-class partner selection

**Symptom**: stroke event selects retail pharmacy for `tpa-dispense` instead of hospital.

**Cause**: `PartnerSelectionNegotiator.calculateCapabilityScore` uses semantic capability matching; if `pharmacy-agent.capabilities` lists `controlled-substance-dispense`, it could match events requiring `tpa-dispense` via substring (they share "dispense").

**Fix**: tag the pharmacy agent with `cannotDeliverClasses: ["tpa-dispense", "cath-lab-activation", ...]`. The negotiator's scope-of-practice filter (Wave 1 A3) drops candidates whose cannotDeliverClasses intersects event.requiredCapabilities.

### 5.3 Sensor-only agent wins every event

**Symptom**: a sensor-heavy agent (e.g., meteorology bureau with weather stations everywhere) initiates every event.

**Cause**: `ACNecessityAssessor.preCheck` STEP 0a makes sensor-only agents (no actuator zones) auto-`initiate_ac`. Combined with `InitiatorCoordinator`'s first-come-first-served claim, the sensor agent wins.

**Fix (partial)**: ensure each event has a domain-specific capability in `requiredCapabilities` that ONLY the right initiator has. Example: chem-fire event should require `smoke-detection` (only env-protection-bureau has it) before generic `emergency-alert`.

Full fix (future engine work): add tiebreak preferring actuator-bearing agents over sensor-only.

### 5.4 Capability naming collisions

Capability strings are matched bidirectionally case-insensitive + via `CAPABILITY_SYNONYMS` groups (in `packages/core/src/utils/capabilityMatching.ts`). Two unrelated capabilities sharing a substring will match — `controlled-substance-dispense` and `tpa-dispense` are intentionally NOT in the same synonym group, so pharmacy's `controlled-substance-dispense` does NOT match `tpa-dispense` automatically. Be careful when naming new capabilities: check the synonym table.

## 6. The `eaf scenario` CLI

```bash
eaf scenario validate <file>    # schema + referential + capability coverage
eaf scenario lint <file>        # best-practice warnings (missing tagline, etc.)
eaf scenario list               # online: list scenarios on the server
```

### Validator output levels

- `[error/schema]` — JSON doesn't conform to v1.0 schema.
- `[error/reference]` — boundDeviceIds / managesZoneIds / event.zoneId points to a non-existent id.
- `[error/orphan-event]` — event.requiredCapabilities matches no agent's capabilities.
- `[error/unmanned-zone]` — event.zoneId is in no agent's managesZoneIds.
- `[warning/partial-coverage]` — some required capabilities match no agent (but others do).
- `[warning/acRationale]` — event has no `acRationale` field documented.

Validator exits 0 on success / 2 on errors / 1 on internal error.

## 7. Worked example — adding an event to starter-home

Let's say you want to add a "smoke-detected" event to `config/scenarios/starter-home.json`. Steps:

1. **Identify the topology**. Smoke → HVAC shutdown + occupant alert. Fan-out (1 initiator → 2 partners).
2. **Identify partners**. The agent that detects smoke (sensor-only) and the agent that has HVAC control.
3. **Pick capabilities**. `smoke-detection` (detector), `hvac-control` + `emergency-alert` (responder).
4. **Verify capability coverage** — does any agent have these? If not, add them to the relevant agent.
5. **Write the event**:
   ```json
   {
     "id": "evt-smoke-livingroom",
     "type": "smoke-detected",
     "zoneId": "living-room",
     "parameter": "smoke",
     "value": true,
     "atSimTimeSec": 60,
     "severity": "high",
     "requiredCapabilities": ["smoke-detection", "hvac-control", "emergency-alert"],
     "focusZoneId": "living-room",
     "humanNarrative": "厨房里飘出烟雾。",
     "acRationale": {
       "partnerSetUnpredictable": false,
       "noCentralAuthority": false,
       "combinatorialStateSpace": false,
       "score": "0/3",
       "verdict": "AC-overkill",
       "reasoning": "Single-home smoke response is a pre-defined workflow (detector → alarm → HVAC off). Kept as a smoke-test baseline."
     }
   }
   ```
6. **Validate**: `eaf scenario validate config/scenarios/starter-home.json` — should pass.
7. **Run**: create a sim, watch the event log at t=60s. You should see a collaboration proposal from the smoke-detecting agent to the HVAC-owning agent.

## 8. Declaring semantic services (P3): `services` / `semanticOfferRules` / `capabilitySynonyms`

Device-derived services expose one service per bound device × capability — a
hardware listing. Semantic services are the agent-level, outcome-named face
that other agents contract for ("drainage dispatch", not "open valve 1").
Three scenario fields feed that layer; the schema source of truth is
`packages/core/src/scenario/scenario-schema.ts`.

**`agents[].services`** — declare an agent's semantic services directly:

```json
{
  "id": "steward-a",
  "name": "Steward A",
  "capabilities": ["valve-control", "water-level-monitoring"],
  "boundDeviceIds": ["pump-1", "level-sensor-1"],
  "services": [
    {
      "semanticType": "drainage-control",
      "label": "区域排涝调度",
      "description": "水位告警时按梯度开阀、跨泵站联动排水。",
      "requires": ["valve-control", "water-level-monitoring"],
      "actuates": ["valve-control"]
    }
  ]
}
```

**`semanticOfferRules`** (top level) — rules evaluated against EVERY agent's
capability union: an agent qualifies when it holds ALL of `requires` and at
least one of `actuates`. `actuates` is the offer's executable surface —
agreements authorize exactly that set. Scenario rules merge with the built-in
rules in `packages/core/src/service/semantic-offers.ts`. Both lists must be
non-empty: an empty `requires` would match every agent, an empty `actuates`
authorizes nothing.

```json
"semanticOfferRules": [
  {
    "semanticType": "flood-response",
    "label": "积涝应急响应",
    "description": "水位超限即开阀排水并联动广播告警。",
    "requires": ["water-level-monitoring", "valve-control"],
    "actuates": ["valve-control"]
  }
]
```

**`capabilitySynonyms`** (top level) — scenario-authored capability
equivalence groups (≥2 members each), registered at load time and merged
with the built-in table; they feed gap analysis, partner ranking, and the
fallback relaxer (`CapabilityRelaxer`) alike:

```json
"capabilitySynonyms": [
  ["water-level-monitoring", "water-level-reading"],
  ["drainage-control", "flood-dispatch"]
]
```

Qualifying offers register as `origin='aggregate'` services (runtime key
`aggregate:<agentId>:<semanticType>`); in an env-backed world they also land
in the service catalog and the live runtime mirror — see
[service-consumption-design.md](service-consumption-design.md) §8.

## 9. Zone parameter semantics

What a `zones[].baseline` key MEANS at runtime. The physics layer is under
active construction (batch D: BUG-09 landed; FEAT-02 zone-power coupling and
FEAT-03 custom-parameter dynamics are landing in parallel) — where this
section and the code disagree, **the code wins**
(`packages/simulation/src/physics/SpatialField.ts`,
`.../PhysicsLayer.ts`, `packages/simulation/src/environment/PhysicalEnvironment.ts`).

### 9.1 Standard (enum) parameters

Keys in the `PhysicalParameter` enum (`packages/simulation/src/devices/types.ts`)
get physics: a default value model (day cycle / noise), field relaxation toward
the seeded baseline, and inter-zone diffusion. Groups and units:

| Group | Keys (unit) |
|---|---|
| Environmental | `temperature` (°C), `humidity` (%), `pressure` (hPa), `light` (lux) |
| Air quality | `air_quality` (0-500), `co2` (ppm), `pm2_5`/`pm10` (µg/m³), `voc`/`no2`/`so2`/`o3` (ppb), `co` (ppm), `formaldehyde` (mg/m³) |
| Weather | `wind_speed` (m/s), `wind_direction` (deg), `uv_index`, `rainfall` (mm), `visibility` (km), `cloud_cover` (%), `dew_point` (°C), `barometric_pressure` (hPa) |
| Motion & presence | `motion`/`presence` (boolean), `occupancy` (%), `people_count` |
| Energy | `energy_consumption` (kWh), `power` (W), `voltage` (V), `current` (A), `frequency` (Hz), `power_factor` (0-1) |
| Traffic | `traffic_flow` (veh/h), `traffic_density` (veh/km), `vehicle_speed` (km/h) |
| Safety | `noise_level` (dB), `vibration` (mm/s), `smoke` (ppm), `gas_leak` (ppm), `door_state`/`window_state` |

### 9.2 Baselines, relaxation, diffusion

A zone `baseline` entry seeds the field's per-location attractor — a freshly
seeded zone starts AT its baseline and relaxes back toward it (exponentially)
after any disturbance. Rates (`SpatialField.ts`, 1/s = fraction of the gap
closed per second):

| Parameter | Relaxation rate | Time constant | Diffusion (at distance 0) |
|---|---|---|---|
| `temperature` | 0.0004 | ~42 min | 0.0015 |
| `humidity` | 0.003 | ~5.5 min | 0.008 |
| `light` | 0.1 | ~10 s | — |
| `co2` | 0.005 | ~3.3 min | 0.02 |
| `pm2_5` | 0.008 | ~2 min | 0.02 |
| `smoke` | 0.01 | ~1.7 min | 0.02 |
| any other field parameter | 0.005 (default) | ~3.3 min | 0.005 (default) |

Diffusion falls off linearly to a 5 m coupling range (same floor; cross-floor
only through declared adjacency — see the `SpatialField.ts` header).
`occupancy` / `people_count` are LATCHED (UX-15): headcounts don't relax —
they hold until written again (landing with batch D; code is authoritative).

### 9.3 Custom (non-enum) keys — T-304 static semantics

Any baseline key OUTSIDE the enum (e.g. `powerW`, `pvOutputW`, `gas`,
domain counters) is a STATIC point value: it holds until written again —
no relaxation physics, no coupling with the standard models, reads as 0
when never seeded. FEAT-03 adds the opt-in `meta.parameterPhysics`
declaration (per-key `relaxRatePerSec` / `relaxToBaseline`) that routes a
custom key through the field instead of the static store; undeclared keys
keep the T-304 static semantics regardless
(regression anchor: `PhysicalEnvironment.determinism.vitest.test.ts`).
Declaring a STANDARD (enum) key in `parameterPhysics` is rejected at load —
those parameters already have dedicated physics.

### 9.3.1 Device coupling onto custom parameters — `meta.parameterEffects`

FEAT-03 stage 2 couples DEVICES to declared custom parameters: while a zone
device holding the declared `capability` (or of the declared `deviceType`)
is ON, the zone's parameter drifts at `ratePerSec` × dt on top of any
declared relaxation (negative = removal):

```json
{
  "meta": {
    "id": "lab-safety",
    "name": "…",
    "parameterPhysics": { "gas": { "relaxRatePerSec": 0.003, "relaxToBaseline": true } },
    "parameterEffects": [
      { "capability": "ventilation", "zoneParameter": "gas", "ratePerSec": -1 }
    ]
  }
}
```

With that declaration, a lab fume hood (`capabilities: […, "ventilation"]`)
turned ON in a zone drains the zone's `gas` at 1 unit/s while it runs —
a gas leak injected to 800 decays visibly faster than with the hood off;
turn-off stops the coupling (the device's physics effects unregister through
the standard path). Notes:

- The target MUST be declared in `meta.parameterPhysics` — a coupling onto
  an undeclared custom key would silently never move anything (static
  store), so the load rejects it with the fix spelled out. Same for
  standard (enum) targets (`temperature` & friends have dedicated physics —
  device effects already drive them).
- Rates are per SIMULATED second and dt-normalized (BUG-09 discipline) —
  the drain is identical at any engine tick stride.
- Multiple matching devices in one zone each register their own coupling
  (rates stack per device); multiple declarations onto one parameter from
  the SAME device sum into one effect.
- The coupling only moves parameters that actually LIVE in the zone's
  field (seeded baseline or an injected value) — a drain never invents
  value out of thin air.
- Match is exact (case-insensitive) on capability name or device type;
  a typo'd selector matches nothing, so keep the declaration and the
  device list in step.

### 9.4 What drives `power` / `light` / `co2` today

- **`power`**: the default global model is a static 500 W ± 100 noise —
  it does NOT follow your devices. Device draws go into a per-zone ledger
  (`zonePowerSums`) that historically only fed meter state; FEAT-02
  (landing with batch D) writes the ledger into the zone's `power` field
  each tick, so zones with reporting devices read the sum of their
  devices' draws (switching loads off visibly drops zone power). Until
  that lands, a `power` baseline is the only way to pin a zone's reading.
- **`light`**: ambient follows a day cycle (base 500 ± 450 lux, peak at
  noon). Luminaires add a STEADY-STATE contribution mapped from device
  brightness via `brightnessToLuxContribution`
  (`packages/simulation/src/physics/illuminance.ts`, BUG-09):

  | brightness (0-100) | 0 | 10 | 25 | 50 | 75 | 100 |
  |---|---|---|---|---|---|---|
  | contribution (lux) | 0 | 50 | 125 | 250 | 375 | 500 |

  Legacy 0-1 fraction inputs are normalized first (0.8 → 80% → 400 lux;
  on that scale 1 means FULL — 1% is not expressible). While a lamp runs,
  the zone's light attractor becomes `baseline + contribution` and the
  reading converges to exactly that, independent of engine tick dt; when
  the last lamp leaves, the zone relaxes back at the 0.1/s light rate.
- **`co2`**: occupancy respiration is an emission RATE (ppm/s, integrated
  as rate×dt); running ventilation (air handlers / `air_flow` effects)
  decays the excess exponentially toward outdoor air (~420 ppm, never
  below it). Between drives the field relaxes at 0.005/s toward baseline.

## 10. Where to look in the codebase

| Concern | File |
|---|---|
| Schema types | `packages/core/src/scenario/scenario-types.ts` |
| Loader / validation | `packages/core/src/scenario/scenario-loader.ts` |
| Semantic offer rules | `packages/core/src/service/semantic-offers.ts` |
| Capability synonyms | `packages/core/src/utils/capabilityMatching.ts` |
| AC necessity decision | `packages/core/src/decision/ACNecessityAssessor.ts:481` (`preCheck`) |
| Partner selection | `packages/core/src/decision/PartnerSelectionNegotiator.ts:330` (`findCandidatePartners`) |
| Primary-initiator dedup | `packages/core/src/decision/InitiatorCoordinator.ts` (Wave 1 A1) |
| Event routing | `packages/core/src/runtime/EngineRuntime.ts:1097` (`injectEvent`) |
| Zone parameter physics | `packages/simulation/src/physics/SpatialField.ts` (rates), `.../PhysicsLayer.ts` (drives), `.../illuminance.ts` (brightness→lux), `packages/simulation/src/environment/PhysicalEnvironment.ts` (T-304 custom store) |
| CLI tooling | `apps/cli/src/commands/scenario.ts` |
| Examples | `config/scenarios/shenzhen-resilience.json`, `config/scenarios/personal-health.json`, `config/scenarios/suzhou-city.json` |
