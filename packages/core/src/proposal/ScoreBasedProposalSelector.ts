/**
 * Score-Based Proposal Selector
 *
 * Selects the best proposal from multiple accepted responses
 * using a multi-tier selection strategy:
 * 1. Primary: Score (higher is better)
 * 2. Secondary: Load (lower is better, if scores are close)
 * 3. Tertiary: Response time (faster is better, if scores and loads are close)
 */

import type {
  IProposalSelector,
  ProposalEvaluationResponse
} from './interfaces.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ScoreBasedProposalSelector');



export class ScoreBasedProposalSelector implements IProposalSelector {
  private readonly scoreThreshold: number;
  private readonly loadThreshold: number;

  constructor(options?: {
    scoreThreshold?: number;  // Score difference threshold for secondary criteria
    loadThreshold?: number;   // Load difference threshold for tertiary criteria
  }) {
    this.scoreThreshold = options?.scoreThreshold ?? 0.05;
    this.loadThreshold = options?.loadThreshold ?? 0.1;
    logger.info('[ScoreBasedSelector] Initialized');
  }

  select(responses: ProposalEvaluationResponse[]): ProposalEvaluationResponse | null {
    logger.info(`[ScoreBasedSelector] Selecting from ${responses.length} responses`);

    // Filter accepted proposals
    const accepted = responses.filter(r => r.decision === 'accept');

    if (accepted.length === 0) {
      logger.info(`[ScoreBasedSelector] No accepted proposals`);
      return null;
    }

    if (accepted.length === 1) {
      const selected = accepted[0];
      logger.info(`[ScoreBasedSelector] Only one accepted proposal: ${selected.fromAgent} (score: ${selected.score.toFixed(2)})`);
      return selected;
    }

    // Sort by multi-tier criteria
    const sorted = accepted.sort((a, b) => {
      // Tier 1: Score (higher is better)
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > this.scoreThreshold) {
        return scoreDiff; // Score difference is significant, use it
      }

      // Tier 2: Load (lower is better, if scores are close)
      const loadDiff = a.factors.currentLoad - b.factors.currentLoad;
      if (Math.abs(loadDiff) > this.loadThreshold) {
        return loadDiff; // Load difference is significant, use it
      }

      // Tier 3: Completion time (faster is better, if scores and loads are close)
      const timeDiff = a.factors.estimatedCompletionTime - b.factors.estimatedCompletionTime;
      return timeDiff;
    });

    const selected = sorted[0];

    logger.info(`[ScoreBasedSelector] Selected ${selected.fromAgent}:`);
    logger.info(`  - Score: ${selected.score.toFixed(2)}`);
    logger.info(`  - Load: ${selected.factors.currentLoad.toFixed(2)}`);
    logger.info(`  - Est. Time: ${selected.factors.estimatedCompletionTime.toFixed(0)}ms`);
    logger.info(`  - Confidence: ${selected.factors.confidence.toFixed(2)}`);

    // Log comparison with second best if applicable
    if (sorted.length > 1) {
      const second = sorted[1];
      logger.info(`[ScoreBasedSelector] Second best ${second.fromAgent}:`);
      logger.info(`  - Score: ${second.score.toFixed(2)}`);
      logger.info(`  - Load: ${second.factors.currentLoad.toFixed(2)}`);
    }

    return selected;
  }
}
