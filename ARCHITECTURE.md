# ActiveCollaboration IoT Framework - Core Architecture

**CRITICAL**: This document contains the authoritative architecture understanding. Any modifications to core systems MUST reference this document first.

---

## Fundamental Architecture Principles

### CRITICAL: Highly Distributed Architecture

**This is a HIGHLY DISTRIBUTED ARCHITECTURE where:**

1. **Each Agent is an INDEPENDENT decision-making core**
   - Agents make autonomous decisions
   - Agents are NOT controlled by any central authority
   - Agents decide their own behavior, collaborations, and lifecycle

2. **Agents can publish microservices through containers**
   - Agents dynamically create services via CodeGenerator
   - Agents deploy services as containerized microservices
   - Services are independently deployable units
   - Services can scale independently

3. **The system is built by many Agents and their controlled Devices**
   - System = Collection of autonomous Agents
   - Each Agent has its own devices/resources
   - Agents collaborate voluntarily through AC (Active Collaboration)
   - No central coordinator or orchestrator

4. **AC (Active Collaboration) is COMPLETELY spontaneous**
   - AC is spontaneously CONSTRUCTED by Agents themselves
   - AC is MANAGED throughout its lifecycle by Agents
   - AC is NOT forcefully specified from outside
   - Agents DECIDE FOR THEMSELVES whether to:
     - Initiate an AC
     - Participate in an AC
     - Maintain an AC
     - Dissolve an AC

**Implications of Distributed Architecture:**

- ✅ **Agent Autonomy**: Each agent is independent and self-governing
- ✅ **Spontaneous Collaboration**: ACs form organically based on agent decisions
- ✅ **No Central Control**: No central orchestrator tells agents what to do
- ✅ **Dynamic Service Creation**: Agents create services as needed via CodeGenerator
- ✅ **Containerized Microservices**: Services run as isolated containers
- ✅ **Resource Ownership**: Agents own and manage their own devices/resources
- ✅ **Voluntary Participation**: Agents choose whether to participate in ACs

---

### Three Core Abstractions (NOT the same as Agent layers)

1. **PhysicalEnvironment Layer** (Foundation) - Physics Simulation
   - PhysicalEnvironment: 73 environmental parameters (temperature, humidity, pressure, etc.)
   - PhysicsLayer: HeatTransferModel, StateInterpolator, SpatialManager
   - **CRITICAL**: This is the ONLY source of truth for environmental data
   - Device operations affect this layer (AC changes temperature, etc.)
   - **EXTENSIBILITY**: 73 parameters is an INITIAL baseline for demonstration
     - Different scenarios may require different parameter sets
     - Parameters can be added/removed based on specific use cases
     - Not all parameters are required in every scenario
     - Design supports flexible adaptation to diverse IoT environments

2. **Device Layer** (Physical/Virtual Devices)
   - SimulatedDevice: Physical/virtual device simulation
   - Has: state, **location**, type, capabilities
   - **ALL devices have spatiotemporal attributes!**
   - Executes: **`executeCommand(commandName, params)`** - basic device commands
   - **Commands are the most basic operations**, NOT services!
   - **Location-bound**: Device deployed at specific location
   - **Effects propagate spatially** via physics simulation!

   **Two Types of Devices**:
   - **Sensors**: DEPLOYED at specific location, READ data from PhysicalEnvironment
     - Example: TemperatureSensor at (2,3,0) reads `physicalEnv.getParameterValue('temperature', {x:2,y:3,z:0})`
     - **CANNOT generate data out of thin air!**
     - **CANNOT read other locations!** (room1 sensor CANNOT read room2)
     - Sensor reads value at its location (affected by nearby devices)

   - **Actuators**: DEPLOYED at specific location, WRITE to PhysicalEnvironment state
     - Example: AC at (2,3,0) executes command → changes temperature via HeatTransferModel
     - Example: Heater at (2,3,0) executes command → increases temperature at (2,3,0)
     - **CRITICAL**: Effects NOT limited to device location!
     - **CRITICAL**: Heat/cold/air propagates spatially via physics simulation!
     - Example: Heater at (2,3,0) → temperature increases at (2,3,0) → spreads to (3,3,0) → (4,3,0) → ...
     - **Physics simulation handles spatial propagation automatically**
     - **Complex full-environment simulation possible**

3. **Resource Layer** (Middle) - Agent's Available Resources
   - Resource: Anything Agent can access and control
   - **NOT just Device abstraction!**
   - Resources can be:
     - Device abstractions (DeviceResource wrapping devices)
     - Other Agents' Services (Agent can use them as resources)
     - External Services (APIs, cloud services, etc.)
     - Any capability Agent can access
   - Managed by ResourceManager
   - Purpose: Track what Agent can use to complete tasks and synthesize services
   - **Key insight**: Resource represents "what Agent has available to work with"

4. **Service Layer** (Top) - Agent Exposed Functionality
   - Service: Agent's exposed functionality to OTHER agents
   - **Services are Agent-level abstractions, NOT device commands!**
   - **Services are NOT bound to Devices!** (may or may not use devices)
   - Managed by ServiceRegistry
   - Purpose: Agent-to-agent communication and collaboration
   - Services can be:
     - Pure computation (no devices)
     - Pure logic (no devices)
     - Device-dependent (may call device commands)

---

## Correct Data Flow (Realism Requirement)

**CRITICAL**: The simulation MUST be compatible with real-world scenarios. No information appears out of thin air!

### Information Flow: Environment → Agent

```
PhysicalEnvironment (73 parameters)
    ↓ [Sensor DEPLOYED at location reads value]
Sensor Device (reads environment)
    ↓ [Agent queries sensor or sensor provides data]
Resource (Agent's abstraction of sensor)
    ↓ [Agent processes data]
Agent Decision
```

### Control Flow: Agent → Environment

```
Agent Decision
    ↓ [Agent determines action needed]
Resource (Agent's abstraction of actuator)
    ↓ [Agent calls actuator command]
Actuator Device (executes command)
    ↓ [Device affects physics at its location]
PhysicalEnvironment (via PhysicsLayer)
    ↓ [Example: Heater at (2,3,0) ON]
    ↓ [HeatTransferModel simulates temperature increase]
    ↓ [Temperature rises at (2,3,0)]
    ↓ [Heat propagates to nearby locations]
    ↓ [(3,3,0) → (4,3,0) → (5,3,0) → ...]
    ↓ [Spatial propagation via physics simulation]
New Environmental State (global temperature distribution)
    ↓ [Sensors at various locations detect changes]
Agent observes changes via sensors
```

**Key Insight**: Actuator at one location affects environment globally over time via physics propagation

### Real-World Compatibility Rules

1. ✅ **Sensors MUST read from PhysicalEnvironment**
   - TemperatureSensor: `physicalEnv.getParameterValue('temperature', location)`
   - NO random data generation
   - NO hardcoded values
   - ONLY reads what's in the environment at sensor's location

2. ✅ **Actuators MUST affect PhysicalEnvironment**
   - AC ON → HeatTransferModel → temperature drops over time
   - Humidifier ON → humidity increases over time
   - Changes follow physical laws, not instant jumps

3. ✅ **Agent ONLY knows what sensors tell it**
   - Agent cannot "magically" know environment state
   - Agent must have Sensor deployed to read that parameter
   - Agent must query Sensor or Sensor must publish data

4. ✅ **Spatial consistency & Location awareness**
   - Sensor at location (2,3,0) reads environment at (2,3,0)
   - AC at location (2,3,0) affects environment at (2,3,0)
   - **CRITICAL**: Agent CANNOT use room1's sensor to read room2's information!
   - **CRITICAL**: Device effects NOT limited to device location!
   - **CRITICAL**: Effects propagate spatially via physics simulation!
   - Example: Heater at (2,3,0) → affects (2,3,0), then (3,3,0), then (4,3,0), ...
   - Physics simulation handles propagation automatically

5. ✅ **Context-aware decision making**
   - Agent MUST consider spatial context when understanding tasks
   - Task "lower temperature" → Agent checks: Where? Which room?
   - Task "activate alarm" → Agent checks: Where is the alarm? Can I reach it?
   - Environment context affects: functionality, task interpretation, final impact
   - **Agent must predict spatial effects** of device operations

6. ✅ **Spatiotemporal attributes in everything**
   - All Devices have: location, deployment context
   - All Sensor readings are: location-specific, time-specific
   - All Actuator operations are: location-bound, propagate over time
   - Agent decisions MUST consider: where, when, what's available
   - **Complex full-environment simulation possible via physics engine**

---

## Device State Update Architecture (Simulation → Real Deployment)

### CRITICAL: Separation of Simulation Events and Agent Notifications

**Problem**: The system previously conflated two different concepts:
1. **Physics/Simulation Events**: Internal changes in the simulated environment
2. **Agent Notifications**: Meaningful information agents receive about their devices

This coupling made the system difficult to port to real deployment.

### Solution: Two-Layer Event Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SIMULATION LAYER                             │
│                                                                     │
│   PhysicsEvent (internal to simulation)                             │
│   - temperature_change, humidity_change, etc.                       │
│   - Generated by PhysicalEnvironment                                │
│   - ONLY Devices receive these, NOT Agents                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          DEVICE LAYER                               │
│                                                                     │
│   Device receives PhysicsEvent (sim) OR real sensor data (real)     │
│   Device processes internally and interprets the change             │
│   Device emits DeviceStateUpdate                                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           AGENT LAYER                               │
│                                                                     │
│   Agent ONLY receives DeviceStateUpdate                             │
│   Agent is isolated from simulation details                         │
│   Same interface works in both simulation and real deployment       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Types

```typescript
// Internal to simulation - Agents NEVER see this
interface PhysicsEvent {
  type: 'temperature_change' | 'humidity_change' | ...;
  location: { x: number; y: number; z: number };
  oldValue: number;
  newValue: number;
  timestamp: Date;
}

// Agent-facing notification - Portable to real deployment
interface DeviceStateUpdate {
  deviceId: string;
  deviceType: string;
  timestamp: Date;
  stateChange: {
    property: string;        // e.g., 'temperature', 'power'
    oldValue: any;
    newValue: any;
    unit?: string;           // e.g., '°C', 'kW'
  };
  context?: {
    significance: 'normal' | 'warning' | 'critical';
    anomaly: boolean;
  };
}
```

### Device Responsibilities

The Device is the **abstraction layer** between simulation/real-world and agents:

1. **In Simulation Mode**:
   - Device receives internal PhysicsEvents from PhysicalEnvironment
   - Device interprets these events and converts to meaningful state changes
   - Device emits DeviceStateUpdate to agents

2. **In Real Deployment Mode**:
   - Device receives data from real hardware sensors
   - Device interprets hardware data into same DeviceStateUpdate format
   - Agent receives identical format - NO code changes needed!

### Agent Subscription Rules

**CRITICAL**: Agents should ONLY receive DeviceStateUpdates from devices they manage:

```typescript
// CORRECT: Agent receives updates only from managed devices
class CognitiveAgent {
  private managedDevices: Set<string>;  // Device IDs this agent manages

  private handleDeviceStateUpdate(event: SystemEvent): void {
    const update = event.payload as DeviceStateUpdate;

    // CRITICAL: Only process updates from devices this agent manages
    if (!this.managedDevices.has(update.deviceId)) {
      return;  // Ignore devices we don't manage
    }

    // Process the meaningful state update
    this.processDeviceUpdate(update);
  }
}
```

### Benefits of This Architecture

| Aspect | Before (Confused) | After (Clean Separation) |
|--------|------------------|--------------------------|
| Agent receives | Raw physics events | Processed device state |
| Coupling | Tightly coupled to simulation | Portable to real deployment |
| LLM calls | Many (evaluating irrelevant events) | Fewer (only relevant updates) |
| Device role | Passive event forwarder | Active state processor |
| Real deployment | Requires major refactoring | Drop-in replacement |
| No-device agents | Receive all events | Receive NO events |

### Migration Path

1. **Phase 1**: Add new `DeviceStateUpdate` type alongside existing events
2. **Phase 2**: Update SimulatedDevice to emit DeviceStateUpdate
3. **Phase 3**: Update CognitiveAgent to subscribe to DeviceStateUpdate
4. **Phase 4**: Remove direct physics event subscription from agents
5. **Phase 5**: Physics events become internal to simulation only

---

## Spatial Propagation & Physics Simulation

### Critical Concept: Device Effects Propagate Spatially

**Device operations are NOT single-point changes!**

When an Actuator executes a command at location (2,3,0):
1. **Immediate effect**: Environment changes at (2,3,0)
2. **Spatial propagation**: Change spreads to nearby locations
3. **Physics simulation**: HeatTransferModel, FluidDynamics, etc. handle propagation
4. **Global effect**: Over time, entire environment affected

### Example: Heater Operation

```
Time: T0
Heater at (2,3,0) executes command 'turnOn'
    ↓
Time: T0+1s
Temperature at (2,3,0): 25°C → 26°C (direct effect)
Temperature at (3,3,0): 25°C (no change yet)
    ↓
Time: T0+5s
Temperature at (2,3,0): 28°C (continues rising)
Temperature at (3,3,0): 25.5°C (heat propagating)
Temperature at (4,3,0): 25°C (no change yet)
    ↓
Time: T0+30s
Temperature at (2,3,0): 32°C (stabilizing)
Temperature at (3,3,0): 28°C (significant propagation)
Temperature at (4,3,0): 26°C (minor propagation)
Temperature at (5,3,0): 25.2°C (slight propagation)
```

### Physics Simulation Components

**HeatTransferModel**:
- Room volume: 100m³
- Thermal mass: 123.1kJ/K
- Surface area: 60m²
- Insulation: 80%
- Simulates heat conduction, convection, radiation

**SpatialManager**:
- Spatial resolution: 1m
- Tracks environmental state at each grid point
- Handles spatial interpolation

**StateInterpolator**:
- Linear interpolation between grid points
- Exponential smoothing for temporal consistency
- Max extrapolation time: 5s

### Implications for Agent Decision Making

**Agent MUST consider spatial propagation**:
1. **Direct effect**: Device at (2,3,0) affects (2,3,0)
2. **Indirect effect**: Device at (2,3,0) affects nearby locations over time
3. **Planning**: Agent must predict WHERE effects will propagate
4. **Monitoring**: Agent must monitor MULTIPLE locations to track full effect

**Example Scenario**:
- Task: "Maintain bedroom temperature at 22°C"
- Agent has: Heater at (2,3,0) (living room)
- Bedroom at: (6,2,0)
- Challenge: Heat from living room will propagate to bedroom
- Solution: Agent must anticipate propagation and adjust heating accordingly

---

## Agent Architecture (3 Layers Within Agent)

### Layer 1: Resource Layer (Bottom)
- **ResourceManager**: Manages all resources (device abstractions)
- **ResourceAllocator**: Allocates resources to tasks
- Device → Resource conversion happens here

### Layer 2: Management Layer (Middle)
- **TaskManager**: Task decomposition and execution
- **DialogueManager**: Agent-to-agent communication
- **CodeGenerator**: Generates microservice code (for dynamic service creation)
- **DeploymentManager**: Service deployment

### Layer 3: Service Layer (Top)
- **ServiceRegistry**: Agent's own services
- **ServicePublisher**: Publishes services to EnvironmentCenter
- **ServiceBroker**: Discovers services from other agents

---

## Task Processing Pipeline (5 Phases)

When Agent receives a task via `processRequest()`:

```
User Task
    ↓
┌─────────────────────────────────────────┐
│ Phase 1: Task Understanding              │
│ - Use LLM to parse task                  │
│ - Extract: serviceType, actionType,      │
│          entity, requiredCapabilities   │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Phase 2: Check Existing Services         │
│ - Search serviceRegistry.findServices()  │
│ - If matching service found:            │
│   → executeServiceDirectly() ✓           │
│ - If NOT found: Continue to Phase 3 →    │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Phase 3: Resource Synthesis              │
│ - Check resourceManager for resources    │
│ - If can compose from resources:         │
│   → synthesizeAndExecute() ✓             │
│ - If NOT possible: Continue to Phase 4 → │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Phase 4: External Service Discovery      │
│ - Use ServiceBroker to find other agents │
│ - Request collaboration                  │
│ - If found: Execute via collaboration    │
│ - If NOT: Continue to Phase 5 →          │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Phase 5: Global Proposal/Collaboration   │
│ - Broadcast proposal to all agents       │
│ - Form AC (Active Collaboration) if      │
│   multiple agents accept                 │
│ - Otherwise: Reject task                 │
└─────────────────────────────────────────┘
```

---

## Key Relationships

### Device vs Resource vs Service

| Concept | Manager | Purpose | Examples |
|---------|---------|---------|----------|
| **Device** | EnvironmentCenter | Physical/virtual entity in environment | SimulatedDevice (AC, Sensor) |
| **Resource** | ResourceManager | What Agent can use to complete tasks | DeviceResource, ServiceResource, ExternalResource |
| **Service** | ServiceRegistry | What Agent exposes to other agents | "temperature-control" service |

**Key Insight**:
- Device: Physical entity in environment
- Resource: Anything Agent can access/use (Devices, other Services, APIs)
- Service: What Agent offers to other Agents

### Device → Resource → Service Flow

```
PhysicalEnvironment
    ↓ [Sensor reads, Actuator writes]
Device (SimulatedDevice)
    - Has: executeCommand(commandName, params)
    - Basic operations like "turnOn", "setTemperature"
    ↓ [Can become a resource]
Resource (can come from multiple sources)
    - DeviceResource (wrapping Device)
    - ServiceResource (wrapping other Agent's Service)
    - ExternalResource (wrapping external API)
    ↓ [Agent synthesizes from resources]
Service (AgentService)
    - Independently created by Agent
    - May OR MAY NOT use resources
    - Pure services can exist without any resources
```

**CRITICAL UNDERSTANDING**:
- Commands (Device) ≠ Services (Agent)
- Resources are "what Agent can use" (Devices, other Services, APIs)
- Services are "what Agent exposes to others"
- Services MAY be synthesized from Resources
- Services MAY use Devices, but NOT bound to them
- Pure services (computation/logic) can exist without any resources

---

## Resource-Service Ontology Architecture

### Overview

The Resource-Service Ontology system provides semantic understanding and reasoning capabilities for agents. It enables:
1. **Internal Reasoning**: Agent understands its own capabilities through Resource Ontology
2. **External Collaboration**: Agent understands others' offerings through Service Ontology
3. **Cross-layer Reasoning**: Combined reasoning across Resource and Service layers

### Service Types

| Type | Description | Ontology Source | Example |
|------|-------------|-----------------|---------|
| **Pure Logic** | No resource dependencies | Independent | Alert service, Data analysis |
| **Resource-backed** | Single or multiple resources | Derived from Resource | Temperature monitoring |
| **Composite** | Combines resources and services | Mixed derivation | Smart HVAC control |
| **External** | Calls third-party APIs | External reference | Weather API service |

### Ontology Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Ontology Layer                                   │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐  │
│  │    Resource Ontology        │  │    Service Ontology         │  │
│  │  (Source of Truth)          │  │  (Exposed Interface)        │  │
│  │                             │  │                             │  │
│  │  - OntologyClass            │  │  - ServiceType              │  │
│  │  - SemanticDescription      │  │  - OntologyClass            │  │
│  │  - SpatialContext           │  │  - BusinessCapability       │  │
│  │  - TemporalContext          │  │  - Dependencies[]           │  │
│  │  - RawCapabilities          │  │  - SpatialContext           │  │
│  └─────────────────────────────┘  │  - SemanticContext          │  │
│                │                   └─────────────────────────────┘  │
│                │ may derive                     │                    │
│                └────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Resource Ontology

Describes physical/logical entities with full semantic context:

```typescript
interface ResourceOntology {
  ontologyClass: ResourceOntologyClass;  // SSN/SAREF classification
  semanticDescription: {
    what: string;         // "Temperature Sensor"
    purpose: string;      // "Monitor ambient temperature"
    constraints: string[]; // ["Accuracy: ±0.5°C", "Range: -20~50°C"]
  };
  spatialContext: {
    location: string;     // "living-room"
    position?: { x, y, z };
    zone?: string;
    coverage?: string[];  // ["living-room", "dining-room"]
  };
  temporalContext?: {
    updateInterval?: number;
    validFrom?: Date;
    validUntil?: Date;
  };
  rawCapabilities: Array<{
    name: string;
    type: 'read' | 'write' | 'execute';
  }>;
}
```

### Service Ontology

Describes business capabilities exposed by agents:

```typescript
interface ServiceOntology {
  serviceType: ServiceType;  // pure-logic | resource-backed | composite | external
  ontologyClass: ServiceOntologyClass;  // Business function classification
  businessCapability: {
    name: string;           // "Temperature Monitoring"
    description: string;    // "Real-time temperature monitoring with alerts"
    inputs: Parameter[];
    outputs: Parameter[];
    guarantees?: string[];  // ["Response time < 100ms"]
  };
  dependencies: Array<{
    type: 'resource' | 'service' | 'external';
    id: string;
    requiredCapabilities?: string[];
    optional?: boolean;
  }>;
  spatialContext: {
    location?: string;
    zones?: string[];
    source: 'inherited' | 'composite' | 'none';
  };
  semanticContext: {
    businessDescription: string;
    applicableScenarios: string[];
    collaborationHints: string[];
  };
}
```

### Ontology Reasoning Engine

#### Internal Reasoning (Own Capabilities)
```
Query: "Can I control living room temperature?"
    ↓
Check Service Ontology → businessCapability matches
    ↓
Check Dependencies → resource-backed, needs Resource
    ↓
Check Resource Ontology → spatialContext.location = "living-room"
    ↓
Result: YES, via TemperatureService backed by temp-sensor-001
```

#### External Reasoning (Peer Services)
```
Query: "Who can help with HVAC control?"
    ↓
Service Discovery → Find matching Service Ontology
    ↓
Match: businessCapability + spatialContext
    ↓
Return: Compatible peer services (Resource details hidden)
```

#### Cross-Layer Reasoning (Combined)
```
Query: "Control living room temperature"
    ↓
Internal Check: Do I have resources in living-room?
    ↓
External Check: Are there peer services available?
    ↓
Decision: Handle alone OR Collaborate
```

### Integration Points

| Component | Role | Integration |
|-----------|------|-------------|
| `Resource.ts` | Holds Resource Ontology | Add `ontology?: ResourceOntology` |
| `SemanticService.ts` | Holds Service Ontology | Extend with full `ServiceOntology` |
| `AgentContextBuilder.ts` | Builds LLM context | Collect ontology from Resources and Services |
| `TaskPlanner.ts` | Task planning | Use ontology for spatial/capability reasoning |
| `ServiceOntologyManager.ts` | Ontology operations | Extend to `OntologyReasoningEngine` |

### Key Design Principles

1. **Service Ontology is Independent**: Not forced to derive from Resource
2. **Dependencies are Explicit**: Services declare what they depend on
3. **Information Hiding**: External agents see Service Ontology, not Resource details
4. **Spatial Inheritance**: Resource-backed services inherit spatial context
5. **Flexible Composition**: Composite services can combine multiple sources

### Ontology-Context Integration for LLM

Ontology information is integrated with the dynamic context system through a **Section-based Architecture**.

#### ContextSection Abstraction

```typescript
interface ContextSection {
  readonly id: string;
  readonly priority: number;
  shouldInclude(context: SectionContext): boolean;
  build(context: SectionContext): Promise<string>;
}
```

#### Section Types (Priority Order)

| Priority | Section | Description |
|----------|---------|-------------|
| 100 | AgentIdentitySection | Agent ID, name, capabilities |
| 95 | EnvironmentSection | Physical environment state |
| 90 | ResourcesSection | Available devices and states |
| **85** | **OntologyResourcesSection** | Resource ontology semantics |
| 80 | ServicesSection | Available services |
| **75** | **OntologyServicesSection** | Service ontology semantics |
| 70 | PeersSection | Peer agents information |
| 60 | TaskSection | Current task description |
| **50** | **OntologyReasoningSection** | Reasoning results for LLM |
| 40 | TemporalSection | Time-related context |

#### Ontology Context Flow

```
Resources + Services + Task
         ↓
┌─────────────────────────┐
│ OntologyContextComposer │
│  - Internal Reasoning   │
│  - External Reasoning   │
│  - Combined Reasoning   │
└───────────┬─────────────┘
            ↓
    SectionContext with
    ontologyReasoning
            ↓
┌─────────────────────────┐
│  Ontology*Sections      │
│  Format for LLM         │
└───────────┬─────────────┘
            ↓
    Rich Context for LLM
```

#### Key Benefits

1. **Dynamic Context Preserved** - Context built at runtime, ontology added as dimension
2. **Token Efficiency** - Sections selectively included based on `shouldInclude()`
3. **Extensibility** - New context dimensions added as new sections
4. **Testability** - Each section tested independently

> **Detailed Design**: See `docs/ONTOLOGY-CONTEXT-INTEGRATION.md`

---

## Current Issue: Service-Device Integration

### Problem
Agent processes tasks correctly through 5 phases, BUT:
- Device states do NOT change
- Services execute successfully but don't affect actual devices

### Root Cause (UNDER INVESTIGATION)
When Agent executes a service (Phase 2) or synthesizes from resources (Phase 3):
- The service execution returns success
- BUT the underlying Device commands are NOT called
- The bridge from Service → Device.executeCommand() is missing or broken

### Required Investigation
1. How do Services call Device commands?
2. Where should the Service → Device bridge be implemented?
3. Is it in the Service's `execute()` method?
4. Or should Phase 3 directly call Device commands?

---

## Context-Aware Agent Decision Making

### Spatiotemporal Context in Task Understanding

When Agent receives a task like "lower the temperature", it MUST consider:

1. **Where? (Spatial context)**
   - Which room? (living room, bedroom, kitchen?)
   - What devices are available at that location?
   - Can I access devices at that location?

2. **When? (Temporal context)**
   - Current environment state
   - Time of day (affects temperature targets)
   - Urgency level

3. **What's available? (Resource context)**
   - Do I have sensors at that location?
   - Do I have actuators at that location?
   - Can I reach/control those devices?

### Example: Context-Aware Task Processing

**Task**: "Lower the temperature"

**Agent's Context Analysis**:
```
Phase 1 (LLM Understanding):
  - Extract: "temperature" → needs temperature control
  - Extract: "lower" → needs actuator (AC)
  - Question: WHERE? (not specified)

Phase 2 (Service Discovery):
  - Search for temperature-control services
  - Check: Which locations have temperature control?

Phase 3 (Resource Synthesis):
  - Check resources: Do I have AC devices?
  - Check locations: Where are the ACs?
  - Decision: Use AC at living room (2,3,0) if task implies living room

Phase 4 (Collaboration):
  - If no AC available at target location
  - Request help from agent who has AC there

Phase 5 (Execution):
  - Execute: ac.executeCommand('turnOn', {location: (2,3,0)})
  - Monitor: temperature at (2,3,0) via sensor
  - Verify: change propagates correctly
```

### Critical Design Principle

**Agent decisions MUST be spatiotemporally aware**:
- Task "activate alarm" → Check: Where is alarm? Can I reach it?
- Task "read temperature" → Check: Which room? Do I have sensor there?
- Task "lower humidity" → Check: Where? Do I have humidifier there?

**Agent cannot magically transcend space**:
- Living room AC CANNOT affect bedroom temperature
- Kitchen sensor CANNOT read bedroom temperature
- Agent must consider location constraints

---

## PhysicalEnvironment Integration

### Components
- **PhysicalEnvironment**: 73 environmental parameters (temperature, humidity, etc.)
- **PhysicsLayer**: HeatTransferModel, StateInterpolator, SpatialManager
- **SpatialGrid**: 1m resolution spatial indexing

### Device → Environment Interaction
Devices SHOULD affect environment parameters when they execute services.
Example: AC turning on should change temperature via HeatTransferModel.

**STATUS**: Needs verification - currently not seeing environment changes in tests.

---

## Multi-Agent Collaboration (AC Formation)

### CRITICAL: AC is Spontaneously Constructed and Managed by Agents

**Active Collaboration (AC) is NOT centrally orchestrated:**

1. **Agent-Initiated AC Formation**
   - Agent recognizes need for collaboration (autonomous decision)
   - Agent creates proposal (spontaneous, not requested)
   - Agent broadcasts proposal via MessageBroker
   - Agent evaluates responses from other agents
   - Agent decides whether to form AC (voluntary)

2. **Agent-Managed AC Lifecycle**
   - Agents themselves manage AC throughout its lifecycle
   - **NOT** CollaborationManager telling agents what to do
   - **NOT** external system orchestrating agent behavior
   - CollaborationManager only TRACKS AC state (doesn't control it)

3. **Agent Decision-Making in AC**
   - Each agent decides independently whether to participate
   - Each agent uses MultiFactorProposalEvaluator to evaluate proposals
   - Each agent can accept OR reject proposals (autonomous choice)
   - Each agent decides when to leave AC

4. **Spontaneous AC Dissolution**
   - Agents decide when AC is no longer needed
   - Agents voluntarily withdraw from AC
   - AC dissolves when agents stop collaborating
   - **NOT** forced shutdown by external system

### Proposal System (Agent-to-Agent Communication)
- Agent broadcasts proposal via MessageBroker
- Other agents evaluate using MultiFactorProposalEvaluator
- Factors: capabilityMatch (40%), resourceAvailability (30%), currentLoad (15%), serviceComplexity (10%), requirementCompliance (15%)
- **Each agent makes independent decision** to accept or reject

### CollaborationManager (TRACKING, NOT CONTROLLING)
- Tracks AC state (forming → active → dissolved)
- Logs AC lifecycle events
- **DOES NOT control agent behavior**
- **DOES NOT force AC formation**
- **DOES NOT orchestrate agent actions**

### AC Lifecycle (Agent-Managed)

```
Agent recognizes need for collaboration
    ↓ [Agent's autonomous decision]
Agent creates proposal
    ↓ [Agent's spontaneous action]
Agent broadcasts proposal via MessageBroker
    ↓ [Peer-to-peer communication]
Other agents receive proposal
    ↓ [Each agent evaluates independently]
Agent A: Accepts (autonomous decision)
Agent B: Accepts (autonomous decision)
Agent C: Rejects (autonomous decision)
    ↓
AC forms (Agent A + Agent B)
    ↓ [Agents collaborate voluntarily]
AC executes collaboration goals
    ↓ [Agents coordinate their actions]
Agent A: Goals achieved, leaving AC
Agent B: Goals achieved, leaving AC
    ↓
AC dissolves (no external shutdown)
```

### Critical Distinction: Tracking vs Controlling

| Aspect | CollaborationManager DOES | CollaborationManager DOES NOT DO |
|--------|---------------------------|----------------------------------|
| AC State | Track state transitions | Force state changes |
| Agent Decisions | Log agent decisions | Make decisions for agents |
| AC Formation | Record when AC forms | Force AC to form |
| AC Dissolution | Record when AC dissolves | Force AC to dissolve |
| Agent Behavior | Observe agent actions | Control agent actions |

---

## Service Lifecycle Management

### Strategies
1. **temporary**: Short-lived, auto-cleanup
2. **persistent**: Long-lived, manual cleanup
3. **usage-based**: Auto-remove after N uses
4. **promote-on-use**: Promote to persistent after N uses

### Service Types
1. **Static Services**: Pre-defined, registered at agent initialization
2. **Dynamic Services**: Generated at runtime via CodeGenerator
3. **Device-Derived Services**: Exposed from device resources

---

## Critical Invariants

### Architecture
1. ✅ PhysicalEnvironment is foundation (source of truth for environmental data)
2. ✅ Device ≠ Resource ≠ Service (three distinct abstractions)
3. ✅ Device commands are NOT the same as Agent services
4. ✅ Services are NOT bound to Devices (can exist independently)
5. ✅ Sensors READ from environment, Actuators WRITE to environment
6. ✅ NO information appears out of thin air (realism requirement)

### Component Management
7. ✅ ResourceManager manages what Agent can use (Devices, Services, APIs)
8. ✅ ServiceRegistry contains Agent's exposed services
9. ✅ EnvironmentCenter manages global service registry
10. ✅ Phase 2 searches Agent's own ServiceRegistry
11. ✅ Phase 3 searches Agent's ResourceManager
12. ✅ Device command execution: `device.executeCommand(commandName, params)`
13. ✅ Services MAY use resources (Devices, other Services, APIs), but NOT required
14. ✅ Resources can be: DeviceResource, ServiceResource, ExternalResource

### Real-World Compatibility
15. ✅ Sensors MUST read from PhysicalEnvironment (no random data)
16. ✅ Actuators MUST affect PhysicalEnvironment (via PhysicsLayer)
17. ✅ Agent ONLY knows what sensors tell it (no magical knowledge)
18. ✅ Spatial consistency matters (location-based physics)
19. ✅ Changes propagate over time (not instant)
20. ✅ Agent CANNOT use room1's sensor for room2's data (location-bound!)
21. ✅ All Devices have spatiotemporal attributes (location, deployment context)
22. ✅ Agent MUST consider context: where, when, what's available
23. ✅ Environment context affects: functionality, task interpretation, final impact
24. ✅ **Device effects NOT limited to device location (spatial propagation!)**
25. ✅ **Physics simulation handles propagation automatically**
26. ✅ **Agent must predict WHERE effects will propagate**
27. ✅ **Complex full-environment simulation possible**

---

## User-Facing Platform Architecture

### Platform Vision

**This is a USER-FACING SAAS PLATFORM**, not just an IoT framework!

Users can:
1. Create and configure Devices through UI
2. Import maps visually
3. Deploy devices on map with drag-and-drop
4. Create Agents with visual configuration
5. Build Resources & Services declaratively
6. Facilitate cross-user, cross-agent AC (Active Collaboration)

### User Workflow

```
User Login
    ↓
Create Environment Center
    ↓
Import Map (Visual)
    - Upload floor plan/image
    - Calibrate spatial coordinates
    - Define rooms, zones
    ↓
Deploy Devices (Visual Drag-and-Drop)
    - Drag sensors to locations
    - Drag actuators to locations
    - Configure device parameters
    ↓
Create Agents (Visual Builder)
    - Select capabilities
    - Assign devices to agent
    - Define services
    - Configure resources
    ↓
Define Collaboration Rules
    - When should agents collaborate?
    - What services to expose?
    - Cross-user permissions
    ↓
Execute Applications
    - Create IoT applications visually
    - Define workflows
    - Monitor execution
    - View results
```

### Key User Interfaces

**1. Map Editor**
```
Visual Map Interface:
- Upload floor plan image
- Set spatial scale (e.g., 1 pixel = 10cm)
- Draw zones (living room, bedroom, kitchen)
- Set environmental parameters per zone
- Drag devices from palette to map
- Configure device location (x, y, z)
- Visual feedback: devices shown on map
```

**2. Device Configuration Panel**
```
Device Properties:
- Name: "Living Room AC"
- Type: AC Controller
- Location: (x: 2.5, y: 3.2, z: 0)
- Capabilities: [temperature-control, power-control]
- Initial State: {power: false, temperature: 24}
- Behaviors: []
- Deploy to Environment Center: [Select]
```

**3. Agent Builder**
```
Agent Configuration:
- Name: "Climate Controller"
- Capabilities: [temperature-control, humidity-control]
- Resources:
  ✓ Device: Living Room AC
  ✓ Device: Bedroom Humidifier
  ✓ External API: Weather Service
- Services:
  ✓ "control-temperature" (exposed to other agents)
  ✓ "monitor-climate" (internal service)
- Collaboration Settings:
  ✓ Accept proposals from: [Emergency Responder]
  ✓ Reject proposals from: [Unknown agents]
```

**4. Application Builder**
```
Visual Workflow Builder:
- Trigger: Temperature > 28°C
- Action 1: Turn on AC (Living Room)
- Action 2: Monitor temperature (Living Room Sensor)
- Action 3: When temperature < 24°C, turn off AC
- Collaboration: Request help from Humidity Controller if needed
```

### Cross-User, Cross-Agent Collaboration

**Environment Center as Collaboration Boundary**:

```
Environment Center: "Smart Home - User A"
    │
    ├── Agent A1 (Climate Controller) - Owner: User A
    ├── Agent A2 (Emergency Responder) - Owner: User A
    └── [Devices owned by User A]

Environment Center: "Smart Office - User B"
    │
    ├── Agent B1 (Energy Manager) - Owner: User B
    └── [Devices owned by User B]

Cross-Center Collaboration:
- Agent A1 needs energy data
- Agent A1 discovers Agent B1 (Energy Manager) via MessageBroker
- Agent A1 sends proposal to Agent B1
- Agent B1 accepts proposal
- AC formed: Agent A1 + Agent B1
- Collaboration executes across environment centers
```

**Collaboration Types**:

1. **Same User, Same Environment Center**
   - Multiple agents by same user
   - Easy collaboration (same permissions)
   - Fast AC formation

2. **Same User, Different Environment Centers**
   - Agent in "Home" needs device in "Office"
   - Cross-center routing via CrossCenterRouter
   - Collaboration across environments

3. **Different Users, Different Environment Centers**
   - User A's agent needs User B's device
   - Permission-based access control
   - Trust and reputation systems
   - AC formation with explicit user consent

### User Experience Flow

**Scenario: User creates smart home application**

```
1. User registers and logs in
    ↓
2. User creates "My Home" Environment Center
    ↓
3. User imports house floor plan (image)
    - Sets scale: 100 pixels = 10 meters
    - Draws rooms: living room, kitchen, 3 bedrooms
    ↓
4. User deploys devices (drag-and-drop)
    - Drag AC to living room (2, 3)
    - Drag temperature sensor to living room (2, 2)
    - Drag humidity sensor to bedroom (6, 2)
    - Drag smoke sensor to kitchen (3, 6)
    - Drag alarm to kitchen (3, 7)
    ↓
5. User creates "Climate Controller" Agent
    - Adds capabilities: temperature-control, humidity-control
    - Assigns devices: living room AC, bedroom humidifier
    - Adds services: "control-temperature"
    ↓
6. User creates "Emergency Responder" Agent
    - Adds capabilities: emergency-response, alarm-control
    - Assigns devices: smoke sensor, alarm
    - Adds services: "emergency-alarm"
    ↓
7. User creates application: "Comfort Monitor"
    - Trigger: Temperature > 28°C
    - Action: Turn on AC
    - Monitor: Temperature sensor
    - Collaboration: Request help if smoke detected
    ↓
8. User deploys application
    - Application runs continuously
    - Agents collaborate automatically
    - User monitors via dashboard
```

### Platform Features

**Visual Map Management**:
- Floor plan upload (PNG, JPG, PDF)
- Spatial calibration
- Zone definition (rooms, areas)
- Device palette (drag devices to map)
- Visual feedback (temperature heatmap, etc.)

**Agent Configuration**:
- Visual agent builder
- Capability selector
- Device assignment (drag-and-drop)
- Service definition (declarative)
- Collaboration rules (who can collaborate?)

**Application Builder**:
- Visual workflow builder (drag-and-drop blocks)
- Trigger definition (when to start?)
- Action sequence (what to do?)
- Collaboration specification (when to ask for help?)
- Monitoring dashboard (real-time status)

**Cross-User Collaboration**:
- Share environment centers (invite other users)
- Share devices (permission-based)
- Share services (API-based)
- Form ACs across users (trust-based)

---

## File Locations

### Core Agent
- `packages/core/src/agent/CognitiveAgent.ts` - Main agent implementation
- `packages/core/src/resource/ResourceManager.ts` - Resource management
- `packages/core/src/service/ServiceRegistry.ts` - Service management

### Device & Environment
- `packages/simulation/src/devices/SimulatedDevice.ts` - Device simulation
- `packages/simulation/src/environment/PhysicalEnvironment.ts` - Physical environment
- `packages/simulation/src/physics/PhysicsLayer.ts` - Physics simulation

### Collaboration
- `packages/core/src/collaboration/CollaborationManager.ts` - AC management
- `packages/core/src/proposal/MultiFactorProposalEvaluator.ts` - Proposal evaluation

---

## Testing Policy (From CLAUDE.md)

**ABSOLUTE PROHIBITION**: No simplified tests, no mocks, no fallbacks.

All tests MUST use:
- Real Ollama LLM (qwen3-14b-q4:latest)
- Full CognitiveAgent with all 3 layers
- Real SimulatedDevice with actual state changes
- Real PhysicalEnvironment with physics

---

## Last Updated
- Date: 2025-02-22
- Updated by: Claude (after critical user corrections)
- Key corrections:
  - **CRITICAL**: This is a USER-FACING SAAS PLATFORM!
  - **CRITICAL**: Users create devices/environments/agents via UI
  - **CRITICAL**: Visual map import and device deployment
  - **CRITICAL**: Cross-user, cross-agent collaboration
  - **CRITICAL**: Highly DISTRIBUTED ARCHITECTURE!
  - **CRITICAL**: Each Agent is an INDEPENDENT decision-making core!
  - **CRITICAL**: Agents can publish microservices through containers!
  - **CRITICAL**: AC is spontaneously CONSTRUCTED and MANAGED by Agents!
  - **CRITICAL**: Agents DECIDE FOR THEMSELVES whether to build/maintain AC!
  - **CRITICAL**: NO central control or orchestration!
  - **CRITICAL**: CollaborationManager TRACKS state, does NOT control behavior!
  - Device executes `commands`, NOT `services`
  - Services are NOT bound to Devices
  - Services can exist independently
  - **CRITICAL**: Resources are NOT just Device abstractions!
  - **CRITICAL**: Resources = what Agent can use (Devices, other Agents' Services, External APIs)
  - **CRITICAL**: All Devices have spatiotemporal attributes (location, deployment context)
  - **CRITICAL**: Agent CANNOT use room1's sensor for room2's data!
  - **CRITICAL**: Agent MUST consider context: where, when, what's available
  - **CRITICAL**: Environment context affects: functionality, task interpretation, final impact
  - **CRITICAL**: Device effects NOT limited to device location!
  - **CRITICAL**: Effects propagate spatially via physics simulation!
  - **CRITICAL**: Heater at (2,3,0) affects (2,3,0) → (3,3,0) → (4,3,0) → ...
  - **CRITICAL**: Complex full-environment simulation possible!
  - **CRITICAL**: Agent must predict WHERE effects will propagate
  - **CRITICAL**: Sensors READ from PhysicalEnvironment, Actuators WRITE to PhysicalEnvironment
  - **CRITICAL**: NO information appears out of thin air (realism requirement)
  - **CRITICAL**: Agent ONLY knows what sensors tell it
- Status: Awaiting user confirmation of architecture understanding
