/**
 * Result Persistence for PAPER_DESIGN_V5 Experiments (Sprint P33)
 *
 * Saves and loads experiment results to/from JSON files.
 * Results are stored in timestamped directories for reproducibility.
 */

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  PaperExperimentResult,
  ExperimentCondition,
  ScenarioType,
} from './types.js';
import type { CrossScenarioResult } from './cross-scenario-runner.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base directory for experiment results (relative to packages/core). */
const RESULTS_BASE_DIR = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'experiment-results',
);

// ---------------------------------------------------------------------------
// Save functions
// ---------------------------------------------------------------------------

/**
 * Save a single experiment result to a JSON file.
 * Creates the directory if it doesn't exist.
 */
export function saveExperimentResult(
  result: PaperExperimentResult,
  pilotDir: string,
): string {
  const dir = join(RESULTS_BASE_DIR, pilotDir);
  mkdirSync(dir, { recursive: true });

  const filename = `${result.config.condition}-iter${result.iteration}-${result.config.scenario}.json`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf-8');
  return filepath;
}

/**
 * Save multiple experiment results for a pilot study.
 */
export function savePilotResults(
  results: PaperExperimentResult[],
  pilotName: string,
): string[] {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pilotDir = `${timestamp}-${pilotName}`;

  const savedPaths: string[] = [];
  for (const result of results) {
    savedPaths.push(saveExperimentResult(result, pilotDir));
  }

  // Save a summary index file
  const summaryPath = savePilotSummary(results, pilotDir);
  savedPaths.push(summaryPath);

  return savedPaths;
}

/**
 * Save a summary index for a set of experiment results.
 */
function savePilotSummary(
  results: PaperExperimentResult[],
  pilotDir: string,
): string {
  const dir = join(RESULTS_BASE_DIR, pilotDir);
  mkdirSync(dir, { recursive: true });

  const summary = results.map(r => ({
    condition: r.config.condition,
    scenario: r.config.scenario,
    iteration: r.iteration,
    totalEvents: r.efficiency.totalEvents,
    correctDecisionRate: r.decisionQuality.meanCorrectDecisionRate,
    initiationRate: r.collaboration.initiationRate,
    goalAchievementRate: r.collaboration.goalAchievementRate,
    totalTokens: r.efficiency.totalTokens,
    wallTimeMs: r.efficiency.totalWallTimeMs,
    timestamp: r.timestamp,
  }));

  const filepath = join(dir, '_summary.json');
  writeFileSync(filepath, JSON.stringify(summary, null, 2), 'utf-8');
  return filepath;
}

/**
 * Save a cross-scenario result to JSON.
 */
export function saveCrossScenarioResult(
  result: CrossScenarioResult,
  pilotName: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pilotDir = `${timestamp}-${pilotName}`;

  const dir = join(RESULTS_BASE_DIR, pilotDir);
  mkdirSync(dir, { recursive: true });

  // Convert Maps to plain objects for JSON serialization
  const serializable = {
    conditions: result.conditions,
    scenarios: result.scenarios,
    llmModel: result.llmModel,
    iterations: result.iterations,
    timestamp: result.timestamp,
    failures: result.failures,
    conditionSummaries: Object.fromEntries(
      Array.from(result.conditionSummaries.entries()).map(([cond, summary]) => [
        cond,
        {
          ...summary,
          scenarioResults: Object.fromEntries(summary.scenarioResults),
          typeWiseMetrics: summary.typeWiseMetrics
            ? {
                mergedCount: summary.typeWiseMetrics.mergedCount,
                totalSupport: summary.typeWiseMetrics.totalSupport,
                byType: summary.typeWiseMetrics.byType,
              }
            : undefined,
        },
      ]),
    ),
    rawResultCount: result.rawResults.length,
  };

  const filepath = join(dir, 'cross-scenario-result.json');
  writeFileSync(filepath, JSON.stringify(serializable, null, 2), 'utf-8');

  // Also save individual raw results
  for (const r of result.rawResults) {
    saveExperimentResult(r, pilotDir);
  }

  return filepath;
}

// ---------------------------------------------------------------------------
// Load functions
// ---------------------------------------------------------------------------

/**
 * Load all experiment results from a pilot directory.
 */
export function loadPilotResults(pilotDir: string): PaperExperimentResult[] {
  const dir = join(RESULTS_BASE_DIR, pilotDir);
  if (!existsSync(dir)) {
    throw new Error(`Pilot directory not found: ${dir}`);
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  const results: PaperExperimentResult[] = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    results.push(JSON.parse(content) as PaperExperimentResult);
  }

  return results;
}

/**
 * List all available pilot directories.
 */
export function listPilotDirs(): string[] {
  if (!existsSync(RESULTS_BASE_DIR)) {
    return [];
  }

  return readdirSync(RESULTS_BASE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse(); // Most recent first
}

/**
 * Load the most recent pilot results for a given pilot name prefix.
 */
export function loadLatestPilotResults(prefix: string): PaperExperimentResult[] {
  const dirs = listPilotDirs();
  const matching = dirs.find(d => d.includes(prefix));

  if (!matching) {
    throw new Error(`No pilot directory found matching prefix: ${prefix}`);
  }

  return loadPilotResults(matching);
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

/** Row format for CSV export of experiment results. */
export interface ExperimentCSVRow {
  condition: ExperimentCondition;
  scenario: ScenarioType;
  iteration: number;
  llmModel: string;
  totalEvents: number;
  correctDecisionRate: number;
  zoneTargetingAccuracy: number;
  capabilityAppropriateness: number;
  sideEffectAwareness: number;
  physicalPlausibility: number;
  initiationRate: number;
  formationSuccessRate: number;
  goalAchievementRate: number;
  totalTokens: number;
  layer1FilterRate: number;
  llmCallCount: number;
  avgAssessmentTimeMs: number;
  wallTimeMs: number;
}

/**
 * Convert experiment results to CSV rows.
 */
export function resultsToCSVRows(
  results: PaperExperimentResult[],
): ExperimentCSVRow[] {
  return results.map(r => ({
    condition: r.config.condition,
    scenario: r.config.scenario,
    iteration: r.iteration,
    llmModel: r.config.llmModel ?? 'unknown',
    totalEvents: r.efficiency.totalEvents,
    correctDecisionRate: r.decisionQuality.meanCorrectDecisionRate,
    zoneTargetingAccuracy: r.decisionQuality.meanZoneTargetingAccuracy,
    capabilityAppropriateness: r.decisionQuality.meanCapabilityAppropriateness,
    sideEffectAwareness: r.decisionQuality.meanSideEffectAwareness,
    physicalPlausibility: r.decisionQuality.meanPhysicalPlausibility,
    initiationRate: r.collaboration.initiationRate,
    formationSuccessRate: r.collaboration.formationSuccessRate,
    goalAchievementRate: r.collaboration.goalAchievementRate,
    totalTokens: r.efficiency.totalTokens,
    layer1FilterRate: r.efficiency.layer1FilterRate,
    llmCallCount: r.efficiency.llmCallCount,
    avgAssessmentTimeMs: r.efficiency.avgAssessmentTimeMs,
    wallTimeMs: r.efficiency.totalWallTimeMs,
  }));
}

/**
 * Export experiment results to a CSV file.
 */
export function exportResultsCSV(
  results: PaperExperimentResult[],
  filepath: string,
): void {
  const rows = resultsToCSVRows(results);
  if (rows.length === 0) {
    writeFileSync(filepath, '', 'utf-8');
    return;
  }

  const headers = Object.keys(rows[0]) as (keyof ExperimentCSVRow)[];
  const csvLines: string[] = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map(h => {
      const val = row[h];
      return typeof val === 'string' ? val : String(val);
    });
    csvLines.push(values.join(','));
  }

  writeFileSync(filepath, csvLines.join('\n'), 'utf-8');
}

/**
 * Get the base results directory path.
 */
export function getResultsBaseDir(): string {
  return RESULTS_BASE_DIR;
}
