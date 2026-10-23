/**
 * Consolidate Experiment Results into Unified Directory Structure
 *
 * This script consolidates experiment results from multiple separate experiment
 * runs into a unified directory structure for paper data export. It reads JSON
 * result files from various experiment directories, deduplicates by preferring
 * newer data, and writes them into a standardized naming convention.
 *
 * Usage:
 *   npx tsx packages/core/tests/experiments/infrastructure/consolidate-results.ts
 *
 * Output:
 *   experiment-results/unified/{BLOCK}-{condition}-iter{i}-{scenario}-{model}.json
 *   experiment-results/unified/{BLOCK}-summary.csv
 *
 * Blocks:
 *   A = Apartment core (RQ1 + RQ2): all conditions on apartment scenario
 *   B = Cross-scenario (RQ3): non-apartment scenarios (campus, factory, hospital, single-room, smart-city)
 *   D = Execution phase (RQ5): full-ac with execution metrics
 *   E = Multi-model: full-ac and oracle across 4 LLM models
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';

import type { PaperExperimentResult } from './types.js';
import { exportResultsCSV } from './result-persistence.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RESULTS_BASE_DIR = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'experiment-results',
);
const UNIFIED_DIR = join(RESULTS_BASE_DIR, 'unified');

/** The primary model used in Blocks A, B, D. */
const PRIMARY_MODEL = 'qwen3-14b-q4:latest';

/** Sanitized model name for filenames (replaces : with _). */
function sanitizeModel(model: string): string {
  return model.replace(/:/g, '_');
}

// ---------------------------------------------------------------------------
// Source Directories (ordered by priority -- later overrides earlier)
// ---------------------------------------------------------------------------

const SOURCE_DIRS = {
  // exp-1 (RQ1): full-ac, never-collaborate, rule-only on apartment
  exp1: '2026-05-07T19-44-32-exp-1-rq1-effectiveness',

  // exp-2 (RQ2): full-ac, vague-spatial, no-propagation, no-service, rule-only, coverage-aware
  exp2a: '2026-05-08T11-54-39-exp-2-rq2-mechanism',

  // exp-2 (RQ2 supplementary): concise-service
  exp2b: '2026-05-09T10-56-25-exp-2-rq2-mechanism',

  // exp-3 (RQ3 cross-scenario): full-ac, oracle, rule-only for all 6 scenarios
  exp3: '2026-05-08T23-31-03-exp-3-cross-scenario',

  // exp-5 (efficiency): rule-only from first dir, always-collaborate from second dir
  exp5RuleOnly: '2026-05-09T02-36-26-exp-5-efficiency',
  exp5AlwaysCollaborate: '2026-05-09T05-42-43-exp-5-efficiency',

  // exp-6 (execution phase): full-ac with execution metrics (1 iteration)
  exp6: '2026-05-09T06-56-27-exp-6-rq5-execution-phase',

  // exp-7 (multi-model): ds-32b and qwen3-14b-q4 data
  exp7: '2026-05-10T03-06-42-exp-7-multi-model',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  filePath: string;
  fileName: string;
  result: PaperExperimentResult;
  dirName: string;
  timestamp: string; // directory timestamp for recency comparison
}

type BlockKey = 'A' | 'B' | 'D' | 'E';

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[consolidate] ${message}`);
}

function warn(message: string): void {
  console.warn(`[consolidate] WARNING: ${message}`);
}

/**
 * Read all JSON experiment result files from a directory.
 * Skips files starting with _ (summary files).
 */
function readResultsFromDir(dirPath: string): FileEntry[] {
  if (!existsSync(dirPath)) {
    warn(`Directory not found: ${dirPath}`);
    return [];
  }

  const dirName = basename(dirPath);
  // Extract timestamp prefix (e.g., "2026-05-07T19-44-32" from directory name)
  const timestamp = dirName.slice(0, 19);

  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  const entries: FileEntry[] = [];
  for (const fileName of files) {
    const filePath = join(dirPath, fileName);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const result = JSON.parse(raw) as PaperExperimentResult;

      // Validate required fields
      if (!result.config || typeof result.iteration !== 'number') {
        warn(`Skipping malformed file (missing config/iteration): ${filePath}`);
        continue;
      }

      entries.push({ filePath, fileName, result, dirName, timestamp });
    } catch (err) {
      warn(`Failed to read/parse ${filePath}: ${(err as Error).message}`);
    }
  }

  return entries;
}

/**
 * Read results from multiple directories. Later entries in the array override
 * earlier ones for the same (condition, scenario, model, iteration) key.
 */
function readResultsFromDirs(dirNames: string[]): FileEntry[] {
  const allEntries: FileEntry[] = [];
  for (const dirName of dirNames) {
    const dirPath = join(RESULTS_BASE_DIR, dirName);
    const entries = readResultsFromDir(dirPath);
    log(`  Read ${entries.length} files from ${dirName}`);
    allEntries.push(...entries);
  }
  return allEntries;
}

/**
 * Build a deduplicated map keyed by (condition, scenario, model, iteration).
 * When duplicates exist, prefer the entry from the newer directory (later timestamp).
 * Also allows an explicit override via the overrideEntries parameter.
 */
function deduplicateEntries(
  primaryEntries: FileEntry[],
  overrideEntries: FileEntry[] = [],
): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();

  function entryKey(e: FileEntry): string {
    return `${e.result.config.condition}|${e.result.config.scenario}|${e.result.config.llmModel ?? 'unknown'}|${e.result.iteration}`;
  }

  // Insert primary entries
  for (const entry of primaryEntries) {
    const key = entryKey(entry);
    const existing = map.get(key);
    if (!existing || entry.timestamp >= existing.timestamp) {
      map.set(key, entry);
    }
  }

  // Insert overrides (always win)
  for (const entry of overrideEntries) {
    const key = entryKey(entry);
    map.set(key, entry);
  }

  return map;
}

/**
 * Generate the unified filename for a file entry in the given block.
 * Pattern: {BLOCK}-{condition}-iter{i}-{scenario}-{model}.json
 */
function unifiedFileName(block: BlockKey, entry: FileEntry): string {
  const { condition, scenario, llmModel } = entry.result.config;
  const model = sanitizeModel(llmModel ?? 'unknown');
  return `${block}-${condition}-iter${entry.result.iteration}-${scenario}-${model}.json`;
}

/**
 * Write a file entry to the unified directory, optionally adjusting the iteration field.
 */
function writeToUnified(
  block: BlockKey,
  entry: FileEntry,
  iterationOverride?: number,
): string {
  const result = { ...entry.result };
  if (iterationOverride !== undefined) {
    result.iteration = iterationOverride;
  }

  const fileName = unifiedFileName(block, { ...entry, result });
  const filePath = join(UNIFIED_DIR, fileName);

  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  return fileName;
}

/**
 * Write a block's entries to the unified directory and generate a CSV summary.
 */
function writeBlock(
  block: BlockKey,
  entries: FileEntry[],
  description: string,
): void {
  log(`\n=== Block ${block}: ${description} (${entries.length} files) ===`);

  const written: string[] = [];
  const results: PaperExperimentResult[] = [];

  for (const entry of entries) {
    const fileName = writeToUnified(block, entry);
    written.push(fileName);
    results.push({ ...entry.result });
  }

  // Sort results for consistent CSV output
  results.sort((a, b) => {
    const condComp = a.config.condition.localeCompare(b.config.condition);
    if (condComp !== 0) return condComp;
    const scenComp = a.config.scenario.localeCompare(b.config.scenario);
    if (scenComp !== 0) return scenComp;
    const modelComp = (a.config.llmModel ?? '').localeCompare(b.config.llmModel ?? '');
    if (modelComp !== 0) return modelComp;
    return a.iteration - b.iteration;
  });

  // Generate CSV summary
  const csvPath = join(UNIFIED_DIR, `${block}-summary.csv`);
  exportResultsCSV(results, csvPath);

  log(`  Wrote ${written.length} JSON files to unified/`);
  log(`  Wrote CSV summary: ${block}-summary.csv`);

  // Log condition/scenario/model coverage
  const conditions = new Set(results.map(r => r.config.condition));
  const scenarios = new Set(results.map(r => r.config.scenario));
  const models = new Set(results.map(r => r.config.llmModel ?? 'unknown'));
  log(`  Conditions: ${Array.from(conditions).sort().join(', ')}`);
  log(`  Scenarios: ${Array.from(scenarios).sort().join(', ')}`);
  log(`  Models: ${Array.from(models).sort().join(', ')}`);
}

// ---------------------------------------------------------------------------
// Block Processors
// ---------------------------------------------------------------------------

/**
 * BLOCK A: Apartment core (RQ1 + RQ2)
 *
 * All conditions on the apartment scenario.
 * Sources: exp-1, exp-2, exp-3 (apartment data), exp-5 (always-collaborate, rule-only),
 *          exp-7 (oracle for non-primary models if available).
 *
 * Conditions expected: full-ac, never-collaborate, rule-only, always-collaborate,
 *   oracle, vague-spatial, no-propagation, no-service, coverage-aware, concise-service
 */
function processBlockA(): void {
  log('\nProcessing Block A (Apartment core: RQ1 + RQ2)...');

  // Collect all apartment data from all sources
  const allEntries: FileEntry[] = [];

  // Primary sources (ordered by priority)
  const sourceDirNames = [
    SOURCE_DIRS.exp1,
    SOURCE_DIRS.exp2a,
    SOURCE_DIRS.exp2b,
    SOURCE_DIRS.exp3,
    SOURCE_DIRS.exp5RuleOnly,
    SOURCE_DIRS.exp5AlwaysCollaborate,
  ];

  for (const dirName of sourceDirNames) {
    const entries = readResultsFromDir(join(RESULTS_BASE_DIR, dirName));
    // Filter to apartment only
    const apartmentEntries = entries.filter(
      e => e.result.config.scenario === 'apartment',
    );
    log(`  ${dirName}: ${apartmentEntries.length} apartment files`);
    allEntries.push(...apartmentEntries);
  }

  // Special override: always-collaborate data from exp-5
  const alwaysCollaborateEntries = readResultsFromDir(
    join(RESULTS_BASE_DIR, SOURCE_DIRS.exp5AlwaysCollaborate),
  ).filter(
    e => e.result.config.condition === 'always-collaborate' &&
         e.result.config.scenario === 'apartment',
  );
  log(`  always-collaborate override: ${alwaysCollaborateEntries.length} files`);

  // Special override: oracle data from exp-3
  const oracleEntries = readResultsFromDir(
    join(RESULTS_BASE_DIR, SOURCE_DIRS.exp3),
  ).filter(
    e => e.result.config.condition === 'oracle' &&
         e.result.config.scenario === 'apartment',
  );
  log(`  oracle from exp-3: ${oracleEntries.length} files`);

  // Deduplicate: later directories override earlier ones
  const deduped = deduplicateEntries(allEntries, [
    ...alwaysCollaborateEntries,
    ...oracleEntries,
  ]);

  // Filter to PRIMARY_MODEL only for Block A
  const blockAEntries = Array.from(deduped.values())
    .filter(e => (e.result.config.llmModel ?? '') === PRIMARY_MODEL)
    .sort((a, b) => {
      const condComp = a.result.config.condition.localeCompare(b.result.config.condition);
      if (condComp !== 0) return condComp;
      return a.result.iteration - b.result.iteration;
    });

  writeBlock('A', blockAEntries, 'Apartment core (RQ1 + RQ2)');
}

/**
 * BLOCK B: Cross-scenario (RQ3)
 *
 * Non-apartment scenarios from exp-3.
 * Conditions: full-ac, oracle, rule-only
 * Scenarios: single-room, campus, hospital, factory, smart-city
 */
function processBlockB(): void {
  log('\nProcessing Block B (Cross-scenario: RQ3)...');

  const entries = readResultsFromDir(
    join(RESULTS_BASE_DIR, SOURCE_DIRS.exp3),
  );

  // Filter to non-apartment scenarios and PRIMARY_MODEL
  const blockBEntries = entries
    .filter(e =>
      e.result.config.scenario !== 'apartment' &&
      (e.result.config.llmModel ?? '') === PRIMARY_MODEL,
    )
    .sort((a, b) => {
      const condComp = a.result.config.condition.localeCompare(b.result.config.condition);
      if (condComp !== 0) return condComp;
      const scenComp = a.result.config.scenario.localeCompare(b.result.config.scenario);
      if (scenComp !== 0) return scenComp;
      return a.result.iteration - b.result.iteration;
    });

  writeBlock('B', blockBEntries, 'Cross-scenario (RQ3)');
}

/**
 * BLOCK D: Execution phase (RQ5)
 *
 * Full-ac with execution-phase evaluation enabled.
 * Sources: exp-6 (latest single-iter), plus earlier multi-iter exp-6 runs.
 */
function processBlockD(): void {
  log('\nProcessing Block D (Execution phase: RQ5)...');

  // Collect all execution-phase data from all exp-6 directories
  const allEntries: FileEntry[] = [];

  // Scan all exp-6 non-incremental directories for execution-phase data
  const dirs = readdirSync(RESULTS_BASE_DIR)
    .filter(d =>
      d.includes('exp-6') &&
      d.includes('execution-phase') &&
      !d.includes('incr'),
    )
    .filter(d => {
      try { return existsSync(join(RESULTS_BASE_DIR, d)) && readdirSync(join(RESULTS_BASE_DIR, d)).length > 0; }
      catch { return false; }
    })
    .sort()
    .reverse();

  for (const dirName of dirs) {
    const entries = readResultsFromDir(join(RESULTS_BASE_DIR, dirName));
    // Only include files with executionPhaseEval=true and PRIMARY_MODEL
    const execEntries = entries.filter(e =>
      e.result.config.executionPhaseEval === true &&
      (e.result.config.llmModel ?? '') === PRIMARY_MODEL &&
      e.result.executionMetrics !== undefined,
    );
    if (execEntries.length > 0) {
      log(`  ${dirName}: ${execEntries.length} execution-phase files`);
      allEntries.push(...execEntries);
    }
  }

  // Deduplicate: prefer newer directories
  const deduped = deduplicateEntries(allEntries);

  const blockDEntries = Array.from(deduped.values())
    .sort((a, b) => a.result.iteration - b.result.iteration);

  writeBlock('D', blockDEntries, 'Execution phase (RQ5)');
}

/**
 * BLOCK E: Multi-model
 *
 * Full-ac and oracle data across 4 LLM models.
 * Sources: exp-7 (ds-32b, qwen3-14b-q4), plus exp-6-incremental directories for
 *   qwen2.5-7b-q4, llama3.1-8b-q4, qwen3-32b-q4, ds-32b.
 *
 * The multi-model data is scattered across many incremental directories.
 * We scan all directories looking for non-primary model data.
 */
function processBlockE(): void {
  log('\nProcessing Block E (Multi-model)...');

  const NON_PRIMARY_MODELS = [
    'qwen2.5-7b-q4:latest',
    'llama3.1-8b-q4:latest',
    'qwen3-32b-q4:latest',
    'ds-32b:latest',
  ];

  const TARGET_CONDITIONS = ['full-ac', 'oracle', 'rule-only'];

  const allEntries: FileEntry[] = [];

  // Scan all directories for non-primary model apartment data
  const dirs = readdirSync(RESULTS_BASE_DIR)
    .filter(d => {
      try { return existsSync(join(RESULTS_BASE_DIR, d)) && readdirSync(join(RESULTS_BASE_DIR, d)).length > 0; }
      catch { return false; }
    })
    .sort();

  for (const dirName of dirs) {
    const dirPath = join(RESULTS_BASE_DIR, dirName);
    try {
      const files = readdirSync(dirPath)
        .filter(f => f.endsWith('.json') && !f.startsWith('_'));

      for (const fileName of files) {
        try {
          const raw = readFileSync(join(dirPath, fileName), 'utf-8');
          const result = JSON.parse(raw) as PaperExperimentResult;

          if (!result.config || typeof result.iteration !== 'number') continue;

          const model = result.config.llmModel ?? '';
          const condition = result.config.condition;
          const scenario = result.config.scenario;

          if (
            NON_PRIMARY_MODELS.includes(model) &&
            TARGET_CONDITIONS.includes(condition) &&
            scenario === 'apartment'
          ) {
            const timestamp = dirName.slice(0, 19);
            allEntries.push({
              filePath: join(dirPath, fileName),
              fileName,
              result,
              dirName,
              timestamp,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  log(`  Found ${allEntries.length} non-primary model files across all directories`);

  // Deduplicate: prefer newer directories
  const deduped = deduplicateEntries(allEntries);

  const blockEEntries = Array.from(deduped.values())
    .sort((a, b) => {
      const modelComp = (a.result.config.llmModel ?? '').localeCompare(b.result.config.llmModel ?? '');
      if (modelComp !== 0) return modelComp;
      const condComp = a.result.config.condition.localeCompare(b.result.config.condition);
      if (condComp !== 0) return condComp;
      return a.result.iteration - b.result.iteration;
    });

  writeBlock('E', blockEEntries, 'Multi-model');

  // Report coverage per model
  for (const model of NON_PRIMARY_MODELS) {
    const modelFiles = blockEEntries.filter(e => (e.result.config.llmModel ?? '') === model);
    const conditions = new Set(modelFiles.map(e => e.result.config.condition));
    const iters = new Set(modelFiles.map(e => e.result.iteration));
    log(`  ${model}: ${modelFiles.length} files (${Array.from(conditions).join(', ')}), iters: ${Array.from(iters).sort().join(',')}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  log('========================================');
  log('Experiment Results Consolidation');
  log('========================================');
  log(`Results base: ${RESULTS_BASE_DIR}`);
  log(`Unified dir:  ${UNIFIED_DIR}`);
  log('');

  // Ensure unified directory exists
  if (!existsSync(UNIFIED_DIR)) {
    mkdirSync(UNIFIED_DIR, { recursive: true });
    log('Created unified directory.');
  }

  // Verify all source directories exist
  let allSourcesExist = true;
  for (const [key, dirName] of Object.entries(SOURCE_DIRS)) {
    const fullPath = join(RESULTS_BASE_DIR, dirName);
    if (!existsSync(fullPath)) {
      warn(`Source directory missing: ${key} => ${dirName}`);
      allSourcesExist = false;
    }
  }

  if (!allSourcesExist) {
    warn('Some source directories are missing. Results may be incomplete.');
    warn('Continuing with available data...\n');
  }

  // Process each block
  processBlockA();
  processBlockB();
  processBlockD();
  processBlockE();

  // Final summary
  log('\n========================================');
  log('Consolidation Complete');
  log('========================================');

  // Count output files
  const outputFiles = readdirSync(UNIFIED_DIR)
    .filter(f => f.endsWith('.json') || f.endsWith('.csv'))
    .sort();

  const jsonFiles = outputFiles.filter(f => f.endsWith('.json'));
  const csvFiles = outputFiles.filter(f => f.endsWith('.csv'));

  log(`Total JSON files in unified/: ${jsonFiles.length}`);
  log(`Total CSV files in unified/: ${csvFiles.length}`);

  // Report per-block counts
  for (const block of ['A', 'B', 'D', 'E'] as BlockKey[]) {
    const blockFiles = jsonFiles.filter(f => f.startsWith(`${block}-`));
    log(`  Block ${block}: ${blockFiles.length} files`);
  }

  log('\nDone.');
}

// Run
main();
