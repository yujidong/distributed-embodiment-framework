# Distributed Embodiment — Active Collaboration (AC) Framework

**Paper artifact.** This repository accompanies the paper
*Distributed Embodiment: Enabling Autonomous AI Agent Collaboration through IoT Infrastructure*.

Distributed Embodiment is a paradigm in which one LLM-based cognitive agent
(**1 brain**) perceives and acts through many IoT devices it does not necessarily
own (**N bodies**), and collaborates with other agents through the
**Active Collaboration (AC)** protocol: devices stay private, services are
published, and cooperation is established through explicit, metered agreements.

This repository is the curated public release. It is self-contained: install,
build, run the tutorial world, and reproduce the paper's experiments (see
[REPRODUCING.md](REPRODUCING.md)). Development history lives in a separate
private repository; this snapshot is intentionally flattened.

## Quick start

```bash
npm install && npm run build        # turbo builds all workspaces
cd apps/server && node dist/index.js   # API server on :8100
npm run dev -w @active-collaboration/web   # web UI
npm run test:fast                      # fast-lane tests (<5 min)
```

Then open the web UI, register, and import the **starter-home** world
(3 zones, 3 devices, 1 agent, a scripted demo event arc). Rule-only mode runs
without any LLM backend; LLM mode works with any OpenAI-compatible endpoint
(see `.env.example`).

- Tutorials: [docs/tutorial.md](docs/tutorial.md),
  [docs/tutorial-smart-campus.md](docs/tutorial-smart-campus.md)
- Scenario authoring: [docs/scenario-author-guide.md](docs/scenario-author-guide.md)
- Formal model: [formal/](formal/) (TLA+ specification of the collaboration protocol)

## Repository map

| Path | Contents |
|---|---|
| `packages/core` | Agent cognition, decision engine, AC protocol, ground-truth derivation |
| `packages/simulation` | Physics layer (spatial fields, propagation, device simulation) |
| `packages/llm-integration` | OpenAI-compatible clients, guided decoding, model routing |
| `packages/shared` | Stream-frame protocol and shared contracts |
| `apps/server` | REST API, persistence, simulation registry |
| `apps/cli` | `eaf` CLI (`--json` three-channel parity) |
| `apps/web` | Web UI (world view, simulation console, campus 3D) |
| `config/scenarios` | Benchmark scenario definitions |
| `scripts/eval` | Evaluation gate runners |
| `formal` | TLA+ specification and model-checking instructions |

## Reproducing the paper

See [REPRODUCING.md](REPRODUCING.md). Two lanes are provided: a **recorded-replay
lane** that reproduces every reported number on a machine without a GPU, and a
**full lane** that re-runs experiments against a live LLM backend.

## License & citation

See [LICENSE](LICENSE). If you use this framework or benchmark, please cite the
paper (see [CITATION.cff](CITATION.cff)).
