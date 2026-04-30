# Active Collaboration Framework

An IoT framework for **Distributed Embodiment**: enabling autonomous AI agent collaboration through physical IoT infrastructure.

This repository contains the core framework implementation and experimental results for the paper *"Distributed Embodiment: Enabling Autonomous AI Agent Collaboration through IoT Infrastructure"*.

## Architecture

The framework consists of three layers:

- **Physical Simulation Layer** — Continuous 3D spatial model with physics-based effect propagation (heat transfer, spatial propagation, state interpolation)
- **Agent Layer** — Cognitive agents with autonomous decision-making (dual-layer decision engine, three-phase resource matching, feedback learning)
- **Environment Management Layer** — Event-driven coordination (EventManager, CollaborationManager, ServiceBroker)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation.

## Project Structure

```
packages/
  core/                  # Agent, decision engine, collaboration management
    src/                 # Framework source code
    tests/
      experiments/       # Paper experiment test scripts (RQ1-RQ4)
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

Experiments are implemented as Vitest test files in `packages/core/tests/experiments/execution/`:

| File | Experiment | Research Question |
|------|-----------|-------------------|
| `exp-1-effectiveness.vitest.test.ts` | Decision accuracy across 6 scenarios | RQ1: Paradigm feasibility |
| `exp-2-mechanism.vitest.test.ts` | Quality-gradient ablation | RQ2: Mechanism analysis |
| `exp-3-cross-scenario.vitest.test.ts` | Cross-scenario distribution cost | RQ3: Distribution cost |
| `exp-4-broadcast.vitest.test.ts` | Broadcast resilience | RQ4: Robustness |
| `exp-5-efficiency.vitest.test.ts` | Token efficiency | RQ5: Efficiency |
| `exp-6-execution-phase.vitest.test.ts` | End-to-end execution | RQ6: Execution validation |
| `exp-7-multi-model.vitest.test.ts` | Multi-model evaluation | Generalizability |
| `exp-8-layer1-validation.vitest.test.ts` | Layer 1 noise filtering | Dual-layer validation |
| `exp-9-7b-n5.vitest.test.ts` | N=5 repetition runs | Statistical reliability |

Run a specific experiment:

```bash
npx vitest run packages/core/tests/experiments/execution/exp-1-effectiveness.vitest.test.ts
```

## Experiment Results

Raw experiment results are stored in `packages/core/tests/experiment-results/`. Each directory contains JSON output from a single run, with summary CSV files at the top level.

## Key Concepts

**Distributed Embodiment**: A paradigm where one cognitive AI agent interacts with the physical world through N IoT devices distributed across space (1 brain : N bodies).

**Active Collaboration (AC)**: When an agent's distributed "body" does not cover all physical capabilities needed for an event, the agent autonomously decides whether to collaborate with other agents.

**Dual-Layer Decision Engine**: Layer 1 uses rule-based spatial-temporal clustering and significance scoring to filter routine events. Layer 2 uses LLM reasoning for complex decisions.

**Three-Phase Resource Matching**: (1) match against self-resources, (2) match against partner services, (3) broadcast unmatched requirements.

## License

This code is made available for research and reproducibility purposes. See the accompanying paper for citation information.
