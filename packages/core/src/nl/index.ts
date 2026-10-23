/**
 * Natural-language interface (cognitive architecture Phase 3, design
 * §12 Phase 3 / value layer L1).
 *
 * Public surface:
 * - command-parser: NL text → NLCommandIntent (rules + LLM hybrid)
 * - response-generator: CognitiveDecision + execution → human response
 * - nl-orchestrator: the four-stage pipeline (parse → decide → execute →
 *   respond) against an NLSeam
 */

export {
  NL_INTENT_SCHEMA,
  NL_INTENT_INSTRUCTION,
  bestNameFragmentMatches,
  buildIntentPromptContext,
  classifyAction,
  detectCommandContradictions,
  detectEmergency,
  // T100 (R15, u3-F2): the ask seam's jurisdiction disclosure reuses the ONE
  // zone matcher — the server routes match the question's zone mentions
  // against the FULL world zone list (not just the 32-view window).
  matchZones,
  // T106 (R17, u3-N2 / u1-F3): the zone-noun mention extractor for the
  // unresolvable-mention disclosure (「Z栋」 named but resolved to nothing).
  unresolvedZoneMentionOf,
  parseNLCommandIntent,
  ruleParseNLCommand,
} from './command-parser.js';
export {
  formatExecutedAction,
  generateAskResponse,
  generateEmergencyResponse,
  generateHelpResponse,
  generateNLResponse,
  generateStatusResponse,
  renderContradictionDeclaration,
  renderTemplateNLResponse,
} from './response-generator.js';
export { buildErrorFallbackDecision, NLDeviceGateError, runNLAsk, runNLCommand } from './nl-orchestrator.js';
export type { NLRunOptions } from './nl-orchestrator.js';
export type {
  NLAgentView,
  NLAskData,
  NLAskResult,
  NLCommandAction,
  NLCommandContradiction,
  NLCommandIntent,
  NLCommandPriority,
  NLCommandResult,
  NLDeviceView,
  NLExecutedAction,
  NLExecutionResult,
  NLInteractionTrace,
  NLSeam,
  NLZoneView,
} from './types.js';
