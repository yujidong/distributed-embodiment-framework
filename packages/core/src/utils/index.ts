export {
  capabilityMatches,
  capabilitySynonymGroups,
  computeCapabilityGap,
  extendCapabilitySynonyms,
  hasAllCapabilities,
  serviceTextCapabilityMatch,
  CAPABILITY_SYNONYMS,
  SERVICE_TEXT_KEYWORDS,
} from './capabilityMatching.js';

export {
  CAPABILITY_DISPLAY_NAMES,
  displayCapability,
  type CapabilityDisplayName,
} from './capabilityDisplayNames.js';

export {
  DECISION_ALIASES,
  MAX_DECISION_ALIAS_TOKENS,
  canonicalizeLLMDecision,
  extractDecisionFromProse,
  normalizeDecisionPhrase,
  type CanonicalLLMDecision,
} from './decisionVocabulary.js';

export { STORED_LLM_TEXT_CAP, truncateForStorage } from './truncate.js';
