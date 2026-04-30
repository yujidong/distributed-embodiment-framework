# Active Collaboration Framework

An IoT framework for **Distributed Embodiment**: enabling autonomous AI agent collaboration through physical IoT infrastructure.

This repository contains the core framework implementation and experimental results for the paper *"Distributed Embodiment: Enabling Autonomous AI Agent Collaboration through IoT Infrastructure"*.

## Architecture

The framework consists of three layers:

- **Physical Simulation Layer** — Continuous 3D spatial model with physics-based effect propagation (heat transfer, spatial propagation, state interpolation)
- **Agent Layer** — Cognitive agents with autonomous decision-making (dual-layer decision engine, three-phase resource matching, feedback learning)
- **Environment Management Layer** — Event-driven coordination (EventManager, CollaborationManager, ServiceBroker)

![Framework Architecture](./docs/fig-architecture.png)

## Project Structure

```
packages/
  core/                  # Agent, decision engine, collaboration management
    src/                 # Framework source code
    tests/
      experiments/       # Paper experiment test scripts
        execution/       # Main experiments (exp-1 through exp-9)
        ablation/        # Ablation studies
        comparison/      # Baseline comparisons
        benchmark/       # Performance benchmarks
        scalability/     # Scalability tests
        validation/      # Validation experiments
      experiment-results/# Raw experiment output data
  simulation/            # Physical environment, physics engine, simulated devices
  shared/                # Shared types, contracts, and utilities
  llm-integration/       # LLM client integration (Ollama)
config/
  scenarios/             # Experiment scenario configurations
```

## Prerequisites

- Node.js >= 18
- npm >= 9
- [Ollama](https://ollama.ai) running locally with a compatible model (e.g., `qwen3-14b-q4`)

## Setup

```bash
npm install
npm run build
```

## Running Experiments

### Main Experiments

Experiments are implemented as Vitest test files in `packages/core/tests/experiments/execution/`:

| File | Experiment | Research Question |
|------|-----------|-------------------|
| `exp-1-effectiveness.vitest.test.ts` | Decision accuracy vs. baselines (5 conditions) | RQ1: Paradigm feasibility |
| `exp-2-mechanism.vitest.test.ts` | Quality-gradient ablation (service discovery, spatial precision) | RQ2: Mechanism analysis |
| `exp-3-cross-scenario.vitest.test.ts` | Cross-scenario distribution cost | RQ3: Distribution cost |
| `exp-4-broadcast.vitest.test.ts` | Broadcast resilience under noise | RQ4: Robustness |
| `exp-5-efficiency.vitest.test.ts` | Token consumption and decision latency | RQ5: Efficiency |
| `exp-6-execution-phase.vitest.test.ts` | End-to-end collaboration execution | RQ6: Execution validation |
| `exp-7-multi-model.vitest.test.ts` | Evaluation across 5 LLMs | Generalizability |
| `exp-8-layer1-validation.vitest.test.ts` | Layer 1 noise filtering effectiveness | Dual-layer validation |
| `exp-9-7b-n5.vitest.test.ts` | N=5 repetition runs for statistical reliability | Statistical reliability |

### Pilot Studies

Pilot experiments in the same directory were used during development to validate experiment design:

| File | Purpose |
|------|---------|
| `pilot-1-paradigm-validation.vitest.test.ts` | Initial paradigm validation |
| `pilot-2-mechanism-analysis.vitest.test.ts` | Mechanism analysis prototype |
| `pilot-3-multi-model.vitest.test.ts` | Multi-model feasibility |
| `pilot-4-cross-scenario-cost.vitest.test.ts` | Cross-scenario cost prototype |
| `pilot-5-efficiency-analysis.vitest.test.ts` | Efficiency analysis prototype |

### How to Run

Run a specific experiment:

```bash
npx vitest run packages/core/tests/experiments/execution/exp-1-effectiveness.vitest.test.ts
```

Run all experiments:

```bash
npx vitest run packages/core/tests/experiments/execution/
```

Each experiment outputs results to `packages/core/tests/experiment-results/` in a timestamped directory. Note: experiments require a running Ollama instance and can take significant time (some experiments run multiple iterations across multiple scenarios).

## Understanding Experiment Results

Results are stored in `packages/core/tests/experiment-results/` with the following structure:

```
experiment-results/
  exp-1-rq1-effectiveness-summary.csv    # Summary CSV for each experiment
  exp-2-rq2-mechanism-summary.csv
  ...
  2026-04-27T17-25-08-exp-1-rq1-.../     # Individual run (timestamped)
    _summary.json                         # Aggregated summary for this run
    full-ac-iter0-apartment.json          # Per-condition per-iteration results
    rule-only-iter0-apartment.json
    ...
```

### Summary CSV Files

Top-level `*-summary.csv` files aggregate results across all runs of an experiment. Key columns:

| Column | Description |
|--------|-------------|
| `condition` | Experimental condition (full-ac, rule-only, always-collaborate, never-collaborate, oracle) |
| `scenario` | Physical scenario (apartment, factory, hospital, etc.) |
| `iteration` | Repetition number |
| `llmModel` | LLM model used |
| `totalEvents` | Number of events evaluated |
| `correctDecisionRate` | Fraction of events where the correct decision was made |
| `initiationRate` | Fraction of events where AC was initiated |
| `goalAchievementRate` | Fraction of events where the physical goal was achieved |
| `totalTokens` | Total LLM token consumption |
| `layer1FilterRate` | Fraction of events filtered by Layer 1 (no LLM call needed) |
| `avgAssessmentTimeMs` | Average LLM assessment latency |

### Individual Run Data

Each timestamped directory contains JSON files with detailed per-event results, including the agent's reasoning, decision context, and physical state at the time of each event.

## Key Concepts

**Distributed Embodiment**: A paradigm where one cognitive AI agent interacts with the physical world through N IoT devices distributed across space (1 brain : N bodies).

**Active Collaboration (AC)**: When an agent's distributed "body" does not cover all physical capabilities needed for an event, the agent autonomously decides whether to collaborate with other agents.

**Dual-Layer Decision Engine**: Layer 1 uses rule-based spatial-temporal clustering and significance scoring to filter routine events. Layer 2 uses LLM reasoning for complex decisions.

**Three-Phase Resource Matching**: (1) match against self-resources, (2) match against partner services, (3) broadcast unmatched requirements.

## License

[MIT](./LICENSE)
