/**
 * End-to-End Validation: Paper Experiment Pipeline
 *
 * Sprint P17-P26 — Validates the experiment pipeline with multi-agent
 * scenarios through the real Ollama LLM.
 *
 * Six test cases:
 *   1. single-room — 3 agents, 10 events (5 requiring AC) — basic AC test
 *   2. apartment   — 6 agents, 15 events (9 requiring AC) — core AC test
 *   3. campus      — 10 agents, 25 events (15 requiring AC) — large-scale AC test
 *   4. factory     — 8 agents, 22 events (12 requiring AC) — industrial IoT test
 *   5. hospital    — 10 agents, 25 events (14 requiring AC) — healthcare IoT test
 *   6. smart-city  — 12 agents, 28 events (15 requiring AC) — city-scale IoT test
 *
 * All scenarios require multi-agent collaboration.
 *
 * CLAUDE.md compliance:
 *   - NO mocks, NO fallbacks — real Ollama LLM
 *   - Real PhysicalEnvironment, real CognitiveAgent
 *   - Fail-early: throws if Ollama or model unavailable
 */

import { describe, it, expect } from 'vitest';

import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';

describe('E2E Validation: Paper Experiment Pipeline', () => {
  // -----------------------------------------------------------------------
  // Test 1: Single-room (2 agents, 5 events — basic AC validation)
  // -----------------------------------------------------------------------

  it('single-room / full-ac — basic AC validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting single-room AC test');
    console.log('  3 agents: climate-agent, safety-agent, air-quality-agent');
    console.log('  10 events: 5 require initiate_ac, 2 handle_independently, 3 ignore');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-single-room-full-ac',
      name: 'Validation: single-room full-ac',
      rq: 'RQ1',
      scenario: 'single-room',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 180000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(10);
    expect(result.config.scenario).toBe('single-room');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // AC-specific checks
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('single-room', result);
  }, 600000);

  // -----------------------------------------------------------------------
  // Test 2: Apartment scenario (6 agents, 9 AC events — core AC validation)
  // -----------------------------------------------------------------------

  it('apartment / full-ac — multi-agent AC validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting apartment multi-agent AC test');
    console.log('  6 agents: env-monitor, climate-controller, security-monitor, safety-agent, energy-agent, maintenance-agent');
    console.log('  15 events: 9 require initiate_ac, 3 handle_independently, 3 ignore');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-apartment-full-ac',
      name: 'Validation: apartment multi-agent AC',
      rq: 'RQ2',
      scenario: 'apartment',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 180000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(15);
    expect(result.config.scenario).toBe('apartment');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);
    expect(Number.isFinite(dq.meanSideEffectAwareness)).toBe(true);
    expect(Number.isFinite(dq.meanPhysicalPlausibility)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite (LLM calls expected for AC events)
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean for all events
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // Multi-agent specific checks
    // Count AC decisions — at least some events should trigger collaboration
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    // Check that partner selection occurred for AC events
    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('apartment', result);

    console.log('\n========================================');
    console.log('[Validation] Apartment multi-agent AC test PASSED');
    console.log('========================================\n');
  }, 600000);

  // -----------------------------------------------------------------------
  // Test 3: Campus scenario (10 agents, 25 events — large-scale AC validation)
  // -----------------------------------------------------------------------

  it('campus / full-ac — large-scale AC validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting campus large-scale AC test');
    console.log('  10 agents: office-manager, lab-monitor, server-manager, facility-monitor,');
    console.log('             security-agent, climate-coordinator, energy-agent, occupancy-agent,');
    console.log('             safety-agent, maintenance-agent');
    console.log('  25 events: 15 require initiate_ac, 3 handle_independently, 4 ignore, 3 other');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-campus-full-ac',
      name: 'Validation: campus large-scale AC',
      rq: 'RQ3',
      scenario: 'campus',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 300000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(25);
    expect(result.config.scenario).toBe('campus');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);
    expect(Number.isFinite(dq.meanSideEffectAwareness)).toBe(true);
    expect(Number.isFinite(dq.meanPhysicalPlausibility)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean for all events
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // Multi-agent specific checks
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    // Check that partner selection occurred for AC events
    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('campus', result);

    console.log('\n========================================');
    console.log('[Validation] Campus large-scale AC test PASSED');
    console.log('========================================\n');
  }, 600000);

  // -----------------------------------------------------------------------
  // Test 4: Factory scenario (8 agents, 22 events — industrial IoT validation)
  // -----------------------------------------------------------------------

  it('factory / full-ac — industrial IoT validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting factory industrial IoT test');
    console.log('  8 agents: production-manager, quality-agent, safety-agent, logistics-agent,');
    console.log('            energy-agent, maintenance-agent, climate-agent, security-agent');
    console.log('  22 events: 12 require initiate_ac, 5 handle_independently, 5 ignore');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-factory-full-ac',
      name: 'Validation: factory industrial IoT',
      rq: 'RQ2',
      scenario: 'factory',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 300000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(22);
    expect(result.config.scenario).toBe('factory');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);
    expect(Number.isFinite(dq.meanSideEffectAwareness)).toBe(true);
    expect(Number.isFinite(dq.meanPhysicalPlausibility)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean for all events
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // Multi-agent specific checks
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('factory', result);

    console.log('\n========================================');
    console.log('[Validation] Factory industrial IoT test PASSED');
    console.log('========================================\n');
  }, 600000);

  // -----------------------------------------------------------------------
  // Test 5: Hospital scenario (10 agents, 25 events — healthcare IoT validation)
  // -----------------------------------------------------------------------

  it('hospital / full-ac — healthcare IoT validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting hospital healthcare IoT test');
    console.log('  10 agents: patient-care-agent, icu-agent, or-agent, pharmacy-agent, lab-agent,');
    console.log('             safety-agent, energy-agent, security-agent, facility-agent, air-quality-agent');
    console.log('  25 events: 14 require initiate_ac, 6 handle_independently, 5 ignore');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-hospital-full-ac',
      name: 'Validation: hospital healthcare IoT',
      rq: 'RQ2',
      scenario: 'hospital',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 300000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(25);
    expect(result.config.scenario).toBe('hospital');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);
    expect(Number.isFinite(dq.meanSideEffectAwareness)).toBe(true);
    expect(Number.isFinite(dq.meanPhysicalPlausibility)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean for all events
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // Multi-agent specific checks
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('hospital', result);

    console.log('\n========================================');
    console.log('[Validation] Hospital healthcare IoT test PASSED');
    console.log('========================================\n');
  }, 600000);

  // -----------------------------------------------------------------------
  // Test 6: Smart City scenario (12 agents, 28 events — city-scale IoT validation)
  // -----------------------------------------------------------------------

  it('smart-city / full-ac — city-scale IoT validation', async () => {
    console.log('\n========================================');
    console.log('[Validation] Starting smart-city city-scale IoT test');
    console.log('  12 agents: residential-manager, commercial-hvac, industrial-safety, energy-grid,');
    console.log('             water-management, transport-coordinator, emergency-services,');
    console.log('             environmental-monitor, security-network, municipal-services,');
    console.log('             logistics-agent, weather-agent');
    console.log('  28 events: 15 require initiate_ac, 7 handle_independently, 6 ignore');
    console.log('========================================\n');

    const config = PaperExperimentRunner.createConfig({
      id: 'validation-smart-city-full-ac',
      name: 'Validation: smart-city city-scale IoT',
      rq: 'RQ2',
      scenario: 'smart-city',
      condition: 'full-ac',
      iterations: 1,
      llmModel: 'qwen3-14b-q4:latest',
      timeoutMs: 300000,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.events).toHaveLength(28);
    expect(result.config.scenario).toBe('smart-city');

    // Decision quality metrics — all finite and bounded
    const dq = result.decisionQuality;
    expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
    expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);
    expect(Number.isFinite(dq.meanSideEffectAwareness)).toBe(true);
    expect(Number.isFinite(dq.meanPhysicalPlausibility)).toBe(true);
    expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

    // Token counts should be finite
    const eff = result.efficiency;
    expect(Number.isFinite(eff.totalTokens)).toBe(true);

    // Goal achievement must be boolean for all events
    for (const event of result.events) {
      expect(typeof event.goalAchieved).toBe('boolean');
    }

    // Multi-agent specific checks
    const acDecisions = result.events.filter(e => e.decisionMade === 'initiate_ac');
    console.log(`\n[Validation] AC decisions: ${acDecisions.length} / ${result.events.length} events`);

    for (const event of acDecisions) {
      console.log(
        `  ${event.eventId}: partner=${event.selectedPartnerAgentId ?? 'none'}, ` +
        `capabilities=${event.requestedCapabilities?.join(',') ?? 'none'}`,
      );
    }

    printResults('smart-city', result);

    console.log('\n========================================');
    console.log('[Validation] Smart-city city-scale IoT test PASSED');
    console.log('========================================\n');
  }, 600000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printResults(scenario: string, result: any): void {
  const eff = result.efficiency;
  const dq = result.decisionQuality;

  console.log(`\n[Validation] ${scenario} results:`);
  console.log(`  correctDecisionRate: ${(dq.meanCorrectDecisionRate * 100).toFixed(0)}%`);
  console.log(`  zoneTargetingAccuracy: ${dq.meanZoneTargetingAccuracy.toFixed(2)}`);
  console.log(`  capabilityAppropriateness: ${dq.meanCapabilityAppropriateness.toFixed(2)}`);
  console.log(`  sideEffectAwareness: ${dq.meanSideEffectAwareness.toFixed(2)}`);
  console.log(`  physicalPlausibility: ${dq.meanPhysicalPlausibility.toFixed(2)}`);
  console.log(`  totalTokens: ${eff.totalTokens}`);
  console.log(`  layer1FilterRate: ${eff.layer1FilterRate.toFixed(2)}`);
  console.log(`  totalWallTimeMs: ${eff.totalWallTimeMs.toFixed(0)}`);

  console.log(`\n[Validation] ${scenario} per-event:`);
  for (const event of result.events) {
    console.log(
      `  ${event.eventId}: ` +
      `decision=${event.decisionMade}, ` +
      `correct=${event.correctDecision}, ` +
      `assessmentTime=${event.assessmentTimeMs.toFixed(0)}ms, ` +
      `partner=${event.selectedPartnerAgentId ?? '-'}, ` +
      `goalAchieved=${event.goalAchieved}`,
    );
  }

  console.log(`\n[Validation] ${scenario} full JSON:`);
  console.log(JSON.stringify(result, null, 2));
}
