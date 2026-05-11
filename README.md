# Active Collaboration Framework

An IoT framework for **Distributed Embodiment**: enabling autonomous AI agent collaboration through physical IoT infrastructure.

This repository contains the core framework implementation and experimental results for the paper *"Distributed Embodiment: Enabling Autonomous AI Agent Collaboration through IoT Infrastructure"*.

## Architecture

The framework consists of three layers:

- **Physical Simulation Layer** -- Continuous 3D spatial model with physics-based effect propagation (heat transfer, spatial propagation, state interpolation)
- **Agent Layer** -- Cognitive agents with autonomous decision-making (dual-layer decision engine, three-phase resource matching, feedback learning)
- **Environment Management Layer** -- Event-driven coordination (EventManager, CollaborationManager, ServiceBroker)

![Framework Architecture](./docs/fig-architecture.png)

## Project Structure

```
packages/
  core/                  # Agent, decision engine, collaboration management
    src/
      decision/          # ACNecessityAssessor, DualTriggerACManager
      utils/
        text-similarity.ts   # TF-IDF character n-gram similarity
    tests/
      experiments/
        execution/       # Main experiment test scripts
        infrastructure/  # Shared experiment runner, types, ground truth, metrics
      experiment-results/
        unified/         # Final unified results (193 JSON files)
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

Experiments are implemented as Vitest test files in `packages/core/tests/experiments/execution/`:

| File | Experiment | Research Question |
|------|-----------|-------------------|
| `exp-1-effectiveness.vitest.test.ts` | Decision accuracy vs. baselines (5 conditions, N=5) | RQ1: Paradigm feasibility |
| `exp-2-mechanism.vitest.test.ts` | Quality-gradient ablation (service discovery, spatial precision) | RQ2: Mechanism analysis |
| `exp-3-cross-scenario.vitest.test.ts` | Cross-scenario distribution cost | RQ3: Distribution cost |
| `exp-4-broadcast.vitest.test.ts` | Broadcast resilience under noise | RQ4: Robustness |
| `exp-5-efficiency.vitest.test.ts` | Token consumption and decision latency | RQ5: Efficiency |
| `exp-6-execution-phase.vitest.test.ts` | End-to-end collaboration execution | RQ6: Execution validation |
| `exp-7-multi-model.vitest.test.ts` | Evaluation across multiple LLMs | Generalizability |
| `exp-8-layer1-validation.vitest.test.ts` | Layer 1 noise filtering effectiveness | Dual-layer validation |
| `exp-9-7b-n5.vitest.test.ts` | N=5 repetition runs for statistical reliability | Statistical reliability |
| `tfidf-baseline-experiment.vitest.test.ts` | TF-IDF (character trigram Jaccard) non-LLM baseline | Non-LLM baseline comparison |

### How to Run

Run a specific experiment:

```bash
npx vitest run packages/core/tests/experiments/execution/exp-1-effectiveness.vitest.test.ts
```

Run all experiments:

```bash
npx vitest run packages/core/tests/experiments/execution/
```

Experiments output results to `packages/core/tests/experiment-results/unified/`. Note: experiments require a running Ollama instance and can take significant time (some experiments run N=5 iterations across multiple scenarios).

## Experiment Results

Results are stored in `packages/core/tests/experiment-results/unified/` as individual JSON files, one per condition-iteration-scenario combination. File naming convention:

```
A-{condition}-iter{N}-apartment-{model}.json
```

### Conditions

| Condition | Description |
|-----------|-------------|
| `full-ac` | Full Active Collaboration system |
| `rule-only` | Rule-based decisions (no LLM) |
| `always-collaborate` | Always initiate AC regardless of context |
| `never-collaborate` | Never initiate AC regardless of context |
| `oracle` | Perfect information baseline |
| `no-service-discovery` | Ablation: service discovery disabled |
| `no-propagation` | Ablation: spatial propagation disabled |
| `concise-service` | Ablation: minimal service descriptions |
| `coverage-aware` | Ablation: coverage-aware matching |
| `tfidf-baseline` | Character trigram Jaccard similarity (no LLM) |

### Result JSON Structure

Each result file contains:

| Field | Description |
|-------|-------------|
| `config` | Experiment configuration (condition, scenario, model) |
| `decisionQuality.meanCorrectDecisionRate` | Fraction of correct collaboration decisions |
| `decisionQuality.meanInitiationRate` | Fraction of events where AC was initiated |
| `events[]` | Per-event results with agent reasoning, decision, and ground truth |
| `tokenUsage` | Total LLM token consumption |
| `layer1FilterRate` | Fraction of events filtered by Layer 1 |

### Experiment Infrastructure

Shared experiment infrastructure in `packages/core/tests/experiments/infrastructure/`:

| File | Purpose |
|------|---------|
| `types.ts` | Type definitions for experiment configs and results |
| `paper-experiment-runner.ts` | Unified experiment runner for all conditions |
| `ground-truth-calculator.ts` | Automatic ground truth computation per event |
| `metrics-collector.ts` | Decision quality, efficiency, and robustness metrics |

## Key Concepts

**Distributed Embodiment**: A paradigm where one cognitive AI agent interacts with the physical world through N IoT devices distributed across space (1 brain : N bodies).

**Active Collaboration (AC)**: When an agent's distributed "body" does not cover all physical capabilities needed for an event, the agent autonomously decides whether to collaborate with other agents.

**Dual-Layer Decision Engine**: Layer 1 uses rule-based spatial-temporal clustering and significance scoring to filter routine events. Layer 2 uses LLM reasoning for complex decisions.

**Three-Phase Resource Matching**: (1) match against self-resources, (2) match against partner services, (3) broadcast unmatched requirements.

## License

[MIT](./LICENSE)
