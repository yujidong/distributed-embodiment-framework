# Distributed Embodiment Framework

> Code repository for *"Distributed Embodiment: Enabling Autonomous AI Agent Collaboration through IoT Infrastructure"*

**Distributed Embodiment** proposes a paradigm where one cognitive AI agent interacts with the physical world through N IoT devices distributed across space (**1 brain : N bodies**). Because no single agent's distributed "body" covers all physical capabilities, agents must autonomously decide when and how to collaborate. This framework implements **Active Collaboration (AC)**, the mechanism by which agents make these decisions.

---

## Why Distributed Embodiment?

Existing IoT platforms assume **static orchestration** — rules or central controllers decide what happens. Distributed Embodiment takes a different approach:

| Traditional IoT | Distributed Embodiment |
|---|---|
| Central controller decides actions | Each agent decides autonomously |
| Devices are passive endpoints | Devices are an agent's "body" |
| Collaboration is pre-programmed | Agents **choose** to collaborate based on context |
| Single-tenant, single-brand | Cross-brand, cross-user by default |

The framework provides a **complete simulation environment** for studying how autonomous AI agents make collaboration decisions in physically realistic IoT scenarios — including spatial physics, device capabilities, and spatiotemporal constraints.

---

## Architecture

The framework implements three layers connected by event-driven data flow:

```
┌──────────────────────────────────────────────────────┐
│           Environment Management Layer                │
│  EnvironmentCenter (EventManager, ServiceBroker,     │
│  CollaborationManager, MessageBroker)                │
│                    ↕ Cross-Center Router              │
├──────────────────────────────────────────────────────┤
│                  Agent Layer                          │
│  CognitiveAgent (per agent)                          │
│  ├─ Dual-Trigger Decision Engine                     │
│  │   Layer 1: Rule-based event filtering             │
│  │   Layer 2: LLM reasoning for complex decisions    │
│  ├─ ResourceManager → ServiceRegistry                │
│  ├─ ProposalHandler → ACExecutor                     │
│  └─ ContextBuilder → OntologyEngine                  │
│                    ↕ LLM API                         │
├──────────────────────────────────────────────────────┤
│           Physical Simulation Layer                   │
│  PhysicalEnvironment (3D spatial, 8+ parameters)     │
│  Device (Sensors · Actuators)                        │
│  PhysicsEngine (heat transfer, light propagation)    │
│  Spatiotemporal Constraints                          │
└──────────────────────────────────────────────────────┘
```

![Framework Architecture](./docs/fig-architecture.png)

### How It Works

1. **Devices** (sensors, actuators) populate a `PhysicalEnvironment` with 3D spatial coordinates and simulated physics (heat transfer, humidity diffusion, etc.)
2. Each **CognitiveAgent** is assigned a subset of devices — its "body". Agents only perceive what their sensors read and only affect what their actuators can reach.
3. When an environmental event occurs (e.g., temperature spike), the agent's **Dual-Trigger Decision Engine** evaluates:
   - **Layer 1** (rules): Can I handle this alone? Is it noise? Should I escalate?
   - **Layer 2** (LLM): If Layer 1 is uncertain, the LLM reasons about capabilities, context, and available partners
4. If collaboration is needed, the agent autonomously discovers partner agents via **ServiceRegistry**, proposes collaboration through the **AC protocol**, and executes coordinated actions

---

## Project Structure

```
packages/
  core/
    src/
      agent/              # CognitiveAgent — autonomous decision-making core
      decision/           # ACNecessityAssessor, DualTriggerACManager
      resource/           # ResourceManager — device/capability mapping
      service/            # ServiceRegistry — semantic service discovery
      management/         # CollaborationManager — AC lifecycle tracking
      proposal/           # MultiFactorProposalEvaluator — proposal scoring
      execution/          # ACExecutor — goal dispatch and tracking
      context/            # ContextBuilder — LLM prompt assembly
      ontology/           # OntologyEngine — capability semantics
      events/             # Event types and routing
      utils/              # text-similarity (TF-IDF baseline)
    tests/
      experiments/
        execution/        # Experiment test scripts (exp-1 through exp-9)
        infrastructure/   # PaperExperimentRunner, ground truth, metrics
      experiment-results/
        unified/          # Final results (193 JSON files)
  simulation/
    src/
      environment/        # PhysicalEnvironment — 3D spatial simulation
      physics/            # PhysicsEngine — heat, humidity, light transfer
      devices/            # SimulatedDevice — sensors and actuators
      spatial/            # Spatial indexing and proximity queries
  shared/                 # Cross-package types and utilities
  llm-integration/        # LLM client (Ollama, OpenAI-compatible APIs)
config/
  scenarios/              # JSON scenario definitions
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 18, **npm** >= 9
- [Ollama](https://ollama.ai) running locally with `qwen3-14b-q4`

### Installation

```bash
git clone https://github.com/yujidong/distributed-embodiment-framework.git
cd distributed-embodiment-framework
npm install
npm run build
```

### Run an Experiment

```bash
# Run a single experiment (e.g., RQ1: decision accuracy)
npx vitest run packages/core/tests/experiments/execution/exp-1-effectiveness.vitest.test.ts

# Run all experiments
npx vitest run packages/core/tests/experiments/execution/

# Run the TF-IDF non-LLM baseline
npx vitest run packages/core/tests/experiments/execution/tfidf-baseline-experiment.vitest.test.ts
```

Results are written as JSON to `packages/core/tests/experiment-results/unified/`.

---

## Defining Scenarios

Scenarios are defined as JSON files in `config/scenarios/`. A scenario specifies:

- **Environment** — name, owner, description
- **Devices** — sensors and actuators with types, capabilities, locations (3D coordinates), and behavior patterns
- **Agents** — cognitive agents with bound devices, capabilities, and LLM config
- **Expected outcomes** — for validation

Example (cross-brand smart home):

```json
{
  "version": "1.0",
  "environment": {
    "id": "cross-brand-smart-home",
    "name": "Cross-Brand Smart Home",
    "owner": "demo-user"
  },
  "devices": [
    {
      "id": "temp-sensor",
      "type": "temperature-sensor",
      "capabilities": ["temperature-monitoring"],
      "location": {
        "room": "living-room",
        "coordinates": { "x": 100, "y": 100, "z": 0 }
      },
      "behavior": {
        "type": "periodic",
        "interval": 60000,
        "initialState": { "temperature": 25 }
      }
    },
    {
      "id": "hvac",
      "type": "hvac",
      "capabilities": ["temperature-control", "cooling"],
      "location": {
        "room": "living-room",
        "coordinates": { "x": 110, "y": 100, "z": 0 }
      },
      "behavior": {
        "type": "event-driven",
        "initialState": { "power": false, "mode": "off", "targetTemperature": 24 }
      }
    }
  ],
  "agents": [
    {
      "id": "temp-monitor-agent",
      "type": "cognitive",
      "boundDevices": ["temp-sensor"],
      "capabilities": ["temperature-monitoring"],
      "config": {
        "llmModel": "qwen3-14b-q4:latest",
        "enableAutoCollaboration": true
      }
    },
    {
      "id": "hvac-control-agent",
      "type": "cognitive",
      "boundDevices": ["hvac"],
      "capabilities": ["temperature-control"],
      "config": {
        "llmModel": "qwen3-14b-q4:latest",
        "enableAutoCollaboration": true
      }
    }
  ]
}
```

When the temperature sensor detects an anomaly, the monitoring agent (which lacks cooling capability) autonomously decides to collaborate with the HVAC agent through the AC protocol.

---

## Experiment Suite

| Experiment | Description | Research Question |
|---|---|---|
| exp-1 | Decision accuracy vs. 5 baselines | RQ1: How accurate are AC decisions? |
| exp-2 | Mechanism ablation (service discovery, spatial precision) | RQ2: Which mechanisms matter? |
| exp-3 | Cross-scenario distribution cost | RQ3: Does the result generalize? |
| exp-4 | Broadcast resilience under noise | RQ4: Robustness to event noise? |
| exp-5 | Token consumption and decision latency | RQ5: What is the computational cost? |
| exp-6 | End-to-end collaboration execution | RQ6: Does execution match decisions? |
| exp-7 | Multi-model evaluation (5 LLMs) | Model generality |
| exp-8 | Layer 1 noise filtering effectiveness | Filter quality |
| exp-9 | N=5 statistical reliability | Reproducibility |
| tfidf-baseline | Non-LLM baseline (character n-gram Jaccard) | Lower bound comparison |

### Experiment Conditions

The framework supports controlled ablation through condition flags:

| Condition | Description |
|---|---|
| `full-ac` | Complete AC pipeline (L1 + L2) |
| `oracle` | Perfect information (upper bound) |
| `rule-only` | L1 rules only, no LLM |
| `always-collaborate` | Unconditional collaboration |
| `never-collaborate` | Never collaborate |
| `no-service` | Disable service discovery |
| `no-propagation` | Disable physics propagation context |
| `vague-spatial` | Replace precise coordinates with room names |
| `coverage-aware` | Coverage-based heuristic |
| `smart-rules` | Enhanced rule baseline |
| `tfidf-baseline` | Text similarity matching (no LLM) |

---

## Key Results

### Decision Accuracy (RQ1)

| Condition | Decision Accuracy |
|---|--:|
| Full AC (qwen3-14b) | 93.3% |
| Oracle (perfect info) | 94.2% |
| TF-IDF baseline | 64.0% |
| Always collaborate | 68.3% |
| Never collaborate | 36.7% |
| Rule-only | 23.0% |

### Mechanism Ablation (RQ2)

Removing **service discovery** drops accuracy by **42.5 percentage points**, confirming it as the primary mechanism. Removing spatial precision or physics propagation causes smaller but measurable degradation.

### Distribution Cost (RQ3)

The accuracy gap between the full-AC system and the Oracle is **near zero** across all five scenarios (apartment, campus, factory, hospital, smart city) and all five tested LLMs (7B local to state-of-the-art API models).

---

## Result Format

Each experiment produces a JSON result file named:

```
A-{condition}-iter{N}-{scenario}-{model}.json    # Apartment (exp-1,2,4,5,8,9)
B-full-ac-iter{N}-{scenario}-{model}.json         # Cross-scenario (exp-3)
B-oracle-iter{N}-{scenario}-{model}.json          # Cross-scenario Oracle
```

Each result file contains:

```json
{
  "config": {
    "id": "exp3-full-ac-apartment",
    "scenario": "apartment",
    "condition": "full-ac",
    "llmModel": "qwen3-14b-q4:latest"
  },
  "iteration": 0,
  "decisionQuality": {
    "meanCorrectDecisionRate": 0.933
  },
  "events": [
    {
      "eventId": "evt-apt-1",
      "interactionType": "B",
      "decisionMade": "initiate_ac",
      "decisionSource": "llm",
      "correctDecision": true,
      "selectedPartnerAgentId": "climate-controller",
      "requestedCapabilities": ["cooling"],
      "llmReasoning": "...",
      "assessmentTimeMs": 35325
    }
  ]
}
```

---

## Citation

If you use this framework in your research, please cite:

```bibtex
@article{yu2026distributed,
  title={Distributed Embodiment: Enabling Autonomous {AI} Agent Collaboration through {IoT} Infrastructure},
  author={Yu, Jidong},
  journal={Internet of Things},
  year={2026}
}
```

## License

[MIT](./LICENSE)
