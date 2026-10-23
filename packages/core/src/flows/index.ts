/**
 * Flows Module — user-orchestrated business flows.
 *
 * A Flow is a user-authored "when <trigger> → run <plan>" automation:
 * statically validated like a compiler artifact (validateFlow), driven by
 * events / environment edges / sim-time schedules (FlowEngine), and
 * executed deterministically through the P4-3 PlanExecutor with the
 * assignee agent's own devices as the only actuation surface
 * (createFlowNodeInvoker).
 */

export {
  FLOW_INPUT_REF_PATTERN,
  FLOW_JSON_SCHEMA,
  agentInvocableFlowOfferings,
  interpolateFlowInputs,
  isFlowInvocableByAgent,
  referencedInputNames,
  resolveFlowRunParams,
  securityFlagsForFlow,
  undeclaredEventTypeWarning,
  validateFlow,
  evaluateFlowCondition,
  evaluateFlowConditions,
  type FlowCondition,
  type FlowDefinition,
  type FlowInputSpec,
  type FlowPolicyEnvelope,
  type FlowSecurityFlag,
  type FlowTrigger,
  type InvocableFlowOffering,
} from './flow-types.js';
export {
  createFlowNodeInvoker,
  resolveFlowAssignments,
  deviceProvides,
  deviceProvidesExecutablePath,
  executableCommandPath,
  ownerEligibleForFlowAuthor,
  FLOW_BUILTIN_NODE_ASSIGNEE,
  FLOW_SERVICE_NODE_ASSIGNEE,
  type FlowAssignmentOptions,
  type FlowAssignmentResult,
} from './flow-invoker.js';
// T70 (R8, u1-F2): the ONE command-equivalence judgment (temperatureCommandRank
// stays exported via cognition → core index to avoid a duplicate core-index
// export path).
export { resolveCommandEquivalence } from './command-equivalence.js';
// validateFlow's return type (also the server API's FLOW_INVALID issue shape).
export type { PlanIssue } from '../workflow/plan-schema.js';
export {
  FlowEngine,
  FLOW_EVENT_TYPES,
  computeCapabilityDrift,
  type AgentFlowInvocationOutcome,
  type FlowCapabilityDrift,
  type FlowEngineOptions,
  type FlowEngineStateExport,
  type FlowEventInput,
  type FlowNotifyInvoker,
  type FlowPolicyEscalation,
  type FlowRunInvocationAttribution,
  type FlowRunRecord,
  type FlowRunStatus,
  type FlowRunTriggerKind,
  type FlowServiceInvoker,
  type FlowWaitContinuation,
} from './flow-engine.js';
export {
  createDelegateDispatchingInvoker,
  createBudgetDeviceLookup,
  runDelegateNode,
  parseDelegateAnswer,
  DELEGATE_DEFAULT_TIMEOUT_MS,
  type DelegateActuationRecord,
  type DelegateBudgetDevice,
  type DelegateDeviceSource,
  type DelegateNodeOutcome,
  type DelegatePolicyGate,
  type DelegateRejectedActuation,
  type DelegateRunContext,
  type DelegateRunnerDeps,
} from './flow-delegate.js';
// R28: the deterministic recommendation→actuation bridge (pure module).
// Phase 1 (cognitive architecture §14.1): bridgeCognitiveDeviceActions
// validates the LLM's structured deviceActions through the same machinery.
export {
  bridgeRecommendationsToActuations,
  bridgeCognitiveDeviceActions,
  type BridgedActuationProposal,
  type CognitiveDeviceAction,
  type CognitiveDeviceBridgeInput,
  type RecommendationBridgeBudget,
  type RecommendationBridgeInput,
  type RecommendationBridgeResult,
} from './delegate-recommendation-bridge.js';
export type {
  PlanDelegateBudget,
  PlanDelegateFallback,
  PlanDelegateSpec,
  PlanNotifySpec,
  PlanServiceSpec,
  PlanWaitSpec,
} from '../workflow/plan-schema.js';
