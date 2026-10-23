/**
 * Agreements service layer — barrel (R21-W1).
 *
 * Route-facing surface of the extracted service modules. Consumers import
 * from here (routes/agreements.ts keeps Fastify wiring only;
 * agreement-trigger-executor.ts shares the invocation core).
 */

export type { AgreementRoutesContext } from './context.js';
export {
  assertFlowServiceTerms,
  assertReadClauseWithinSchema,
  computationFieldNames,
  consumptionQuotaStatus,
  dataSchemaFieldNames,
  effectiveTermsOf,
  fieldsAbsentFromComputation,
  parseTermsBody,
  quotaWindowStartIso,
  readWindowStartIso,
  summarizeTerms,
  termsDiff,
  type ConsumptionQuotaStatus,
} from './terms.js';
export {
  CONSUMPTION_TARGET_RETRY_AFTER_SEC,
  CONSUMPTION_TARGET_WAIT_LIMIT_MS,
  raceConsumptionTargeting,
  resolveConsumptionTargetSim,
  resolveConsumptionTargetSimForLane,
  resolveConsumptionTargetForLaneWithNote,
  defaultSimNoteOf,
  readDefaultWorldChoiceOf,
  type ReadDefaultWorldChoice,
  type StaleDefaultBinding,
} from './targeting.js';
export {
  aggregateBackingView,
  assertBackingUnambiguous,
  backingDeviceDriftOf,
  getProposableServiceOrThrow,
  resolveBackingDevice,
} from './backing.js';
export { assertDeliverableAtSigning } from './signing-gates.js';
export {
  assessProviderDeliverability,
  type ProviderDecisionVerdict,
} from './provider-decision.js';
export {
  agreementToJson,
  getAgreementReadView,
  getVisibleAgreementOrThrow,
  ownerRefFor,
  terminatedAgreementRestrictedJson,
  usageToJson,
  type AgreementReadView,
} from './view.js';
export {
  actuationPairsOf,
  contentionSummaryOfEnv,
  contentionsOf,
  withContentions,
  type ActuationContext,
  type ActuationPair,
  type ContentionContext,
  type ContentionMark,
  type ContentionSummary,
} from './contentions.js';
export { deliverRead, evaluateFrameNow } from './read-delivery.js';
export {
  executeAgreementInvocation,
  requireRunnableFlow,
  unwrapDeviceFailure,
  type AgreementInvocationActor,
  type AgreementInvocationOutcome,
} from './invoke-lane.js';
export {
  parseStreamParamFilter,
  runAgreementStreamSession,
  type AgreementStreamSessionArgs,
} from './stream-invocation.js';
