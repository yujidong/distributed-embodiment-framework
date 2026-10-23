/**
 * CapabilityRelaxer — progressive synonym-group widening for fallback.
 *
 * Phase 7: When PartnerSelectionNegotiator finds no candidates for a
 * set of requiredCapabilities, the relaxer progressively widens the
 * search by substituting each capability with its synonym group members.
 * The groups come from capabilitySynonymGroups() — built-ins PLUS
 * scenario-registered extension groups (P3 `capabilitySynonyms`) — so
 * scenario-declared equivalences relax exactly like built-in ones.
 * This mirrors how a human dispatcher thinks: "I need
 * cath-lab-activation... but pci-procedure or coronary-intervention
 * would also work."
 *
 * Usage:
 *   const relaxer = new CapabilityRelaxer();
 *   const relaxed = relaxer.relax(['cath-lab-activation']);
 *   // → ['cath-lab-activation', 'pci-procedure', 'coronary-intervention', 'cardiac-intervention']
 *
 *   const further = relaxer.relax(relaxed);
 *   // → same group + any groups that share a member
 */

import { capabilitySynonymGroups } from '../utils/capabilityMatching.js';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('CapabilityRelaxer');

export class CapabilityRelaxer {
  /**
   * Relax a set of capabilities by expanding each to its full synonym group.
   * Returns a new array (superset of the input) with all synonyms included.
   * Idempotent: relaxing an already-relaxed set returns the same set.
   */
  relax(capabilities: string[]): string[] {
    const result = new Set(capabilities);

    for (const cap of capabilities) {
      const lower = cap.toLowerCase();
      for (const group of capabilitySynonymGroups()) {
        const lowerGroup = group.map(s => s.toLowerCase());
        if (lowerGroup.includes(lower)) {
          for (const synonym of group) {
            result.add(synonym);
          }
        }
      }
    }

    const expanded = [...result];
    if (expanded.length > capabilities.length) {
      logger.info(
        `Relaxed capabilities: ${capabilities.length} → ${expanded.length} ` +
        `(added: ${expanded.filter(c => !capabilities.includes(c)).join(', ')})`,
      );
    }
    return expanded;
  }

  /**
   * Multi-round relaxation: repeatedly apply relax() until the set stops
   * growing (fixpoint) or maxRounds is reached.
   */
  relaxDeep(capabilities: string[], maxRounds = 3): string[] {
    let current = [...capabilities];
    for (let i = 0; i < maxRounds; i++) {
      const next = this.relax(current);
      if (next.length === current.length) break; // fixpoint
      current = next;
    }
    return current;
  }

  /**
   * Given a set of required capabilities and a set of agent capabilities,
   * check if ANY required capability (after relaxation) matches ANY agent
   * capability. This is the "last resort" check before giving up.
   */
  hasAnyMatchAfterRelaxation(
    requiredCapabilities: string[],
    agentCapabilities: string[],
  ): boolean {
    const relaxed = this.relax(requiredCapabilities);
    return relaxed.some(req =>
      agentCapabilities.some(agentCap => {
        const a = agentCap.toLowerCase();
        const r = req.toLowerCase();
        return a === r || a.includes(r) || r.includes(a);
      }),
    );
  }
}
