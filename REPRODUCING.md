# Reproducing the Paper

> **Status: scaffold.** The experiment entry points below are wired as the
> corresponding experiments land (see the paper revision plan). The replay
> mechanism described here is the agreed design; this document is updated as
> each experiment runner ships.

Two reproduction lanes are provided. Lane A requires no GPU and no LLM backend;
Lane B re-runs everything against a live LLM.

## Lane A — recorded replay (no GPU)

The LLM client ships a VCR-style replay mode (`packages/llm-integration/src/client.ts`,
covered by `replay.vitest.test.ts`):

- **Record** (on a GPU machine, once): run the experiment suite against the
  live backend with `LLM_CACHE_PATH` pointing at a SQLite file — every LLM
  response is persisted into the shared response cache.
- **Replay** (anywhere): set `LLM_CACHE_PATH` to the recorded cache and
  `LLM_REPLAY=1` — `chat()` serves **only** from the cache; a miss throws
  `LLMReplayMissError` with the request fingerprint, so replay fails loudly
  rather than silently degrading. Deterministic per experiment, because all
  non-LLM components (physics, ground-truth derivation, agreement lifecycle,
  metering) are deterministic under a fixed event schedule.

Per-function routing (`LLM_DECISION_MODEL` / `LLM_EVAL_MODEL` / `LLM_NL_MODEL`)
is replayed the same way — routed clients share the cache layer.

The recorded caches for the paper's experiment suite ship under
`packages/core/tests/experiment-results/recordings/` (tracked; they are part
of the artifact). Entry point: `npm run exp:replay` (added as the E1–E9
runners land — see the claim map below).

## Lane B — full run (live LLM backend)

1. Deploy an OpenAI-compatible backend (we used vLLM with Qwen2.5-7B-Instruct;
   ~24 GB VRAM). Any compatible endpoint works.
2. Copy `.env.example` to `.env` and set `LLM_BASE_URL` / `LLM_MODEL`
   (per-function routes `LLM_DECISION_MODEL` / `LLM_EVAL_MODEL` / `LLM_NL_MODEL`
   are optional and fall back to `LLM_MODEL`).
3. `npm install && npm run build`, then `npm run test:experiments`
   (per-experiment entry points are listed in the claim map below).

## Claim map

Every quantitative claim in the paper maps to one command and one expected
output file. The table is filled in as experiment runners land:

| Paper claim | Command | Expected output | Status |
|---|---|---|---|
| (per-experiment entries added with E1–E9 runners) | `npm run exp:eN` | `experiment-results/...` | scaffold |

## Environment notes

- Node ≥ 18, npm ≥ 9. Tested on Windows 11 (Git Bash) and Linux (WSL2).
- `npm run test:fast` runs the deterministic fast lane (no LLM required).
- The web UI is not required for reproduction; it is included for
  demonstration and interactive exploration.
