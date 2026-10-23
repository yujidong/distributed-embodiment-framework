/**
 * @vitest-environment node
 *
 * R6-C-F01: `eaf scenario validate` is the recommended authoring gate — it
 * must actually run the server-side loader (plus the CLI-only referential /
 * coverage checks) and answer with a verdict + non-zero exit on bad input.
 * The R6 probes (missing file / invalid JSON / bad offer rule / dangling
 * zone reference) previously sailed through with exit 0 and zero output.
 *
 * Offline: validate never touches the network, so the runner is bound to a
 * dummy server URL.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCli } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function validScenario(): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id: 'home', name: 'Smart Home' },
    zones: [{ id: 'living-room' }],
    devices: [
      { id: 'hvac-1', type: 'hvac', capabilities: ['temperature-control'], zoneId: 'living-room' },
    ],
    agents: [
      {
        id: 'climate-agent',
        name: 'Climate Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['living-room'],
        boundDeviceIds: ['hvac-1'],
      },
    ],
    events: [
      {
        id: 'evt-heat',
        type: 'temperature-spike',
        zoneId: 'living-room',
        parameter: 'temperature',
        value: 33,
        atSimTimeSec: 10,
        requiredCapabilities: ['temperature-control'],
        acRationale: 'needs cooling cooperation',
      },
    ],
  };
}

function writeFixture(home: string, name: string, content: unknown): string {
  const path = join(home, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return name;
}

const cli = () => {
  const runner = makeCli('http://127.0.0.1:1');
  tempDirs.push(runner.home);
  return runner;
};

describe('eaf scenario validate (R6-C-F01)', () => {
  it('a valid scenario exits 0 with a verdict', async () => {
    const runner = cli();
    writeFixture(runner.home, 'good.json', validScenario());
    const result = await runner.cli('scenario', 'validate', 'good.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no issues');
    // UX-11: the success summary carries the entity counts + warning count.
    expect(result.stdout).toContain('✓ valid — 1 zones, 1 devices, 1 agents, 0 flows, 1 events; 0 warnings');
  });

  it('unknown top-level keys are tolerated (server loader parity), exit 0', async () => {
    const runner = cli();
    writeFixture(runner.home, 'unknown-key.json', { ...validScenario(), unknownTopLevel: true });
    const result = await runner.cli('scenario', 'validate', 'unknown-key.json');
    expect(result.code).toBe(0);
  });

  it('invalid JSON exits non-zero with the parse error', async () => {
    const runner = cli();
    writeFixture(runner.home, 'syntax-error.json', '{ not json');
    const result = await runner.cli('scenario', 'validate', 'syntax-error.json');
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/invalid JSON|failed validation/);
  });

  it('a bad semanticOfferRule exits non-zero with the loader issue', async () => {
    const runner = cli();
    writeFixture(runner.home, 'bad-rule.json', {
      ...validScenario(),
      semanticOfferRules: [{ when: ['temperature-control'], actuates: [] }],
    });
    const result = await runner.cli('scenario', 'validate', 'bad-rule.json');
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/actuates/);
  });

  it('an event referencing a dangling zone exits non-zero naming the zone', async () => {
    const runner = cli();
    const scenario = validScenario();
    (scenario.events as Array<{ zoneId: string }>)[0].zoneId = 'nonexistent-zone';
    writeFixture(runner.home, 'bad-zone-ref.json', scenario);
    const result = await runner.cli('scenario', 'validate', 'bad-zone-ref.json');
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/nonexistent-zone/);
  });

  it('an event zone no agent manages exits non-zero (CLI-only coverage check)', async () => {
    const runner = cli();
    const scenario = validScenario();
    (scenario.events as Array<{ zoneId: string }>)[0].zoneId = 'living-room';
    (scenario.agents as Array<{ managesZoneIds: string[] }>)[0].managesZoneIds = [];
    scenario.zones = [{ id: 'living-room' }, { id: 'attic' }];
    (scenario.events as Array<{ zoneId: string }>)[0].zoneId = 'attic';
    writeFixture(runner.home, 'unmanned-zone.json', scenario);
    const result = await runner.cli('scenario', 'validate', 'unmanned-zone.json');
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/unmanned-zone|managesZoneIds/);
  });

  it('a missing file exits non-zero with a clean one-line error (no stack dump)', async () => {
    const runner = cli();
    const result = await runner.cli('scenario', 'validate', 'does-not-exist.json');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/cannot validate "does-not-exist\.json"/);
    expect(result.stderr).not.toMatch(/at loadScenarioFromFile|unexpected failure/);
  });

  it('--json reports valid:false with the error list on failures', async () => {
    const runner = cli();
    writeFixture(runner.home, 'bad.json', '{ not json');
    const result = await runner.cli('scenario', 'validate', '--json', 'bad.json');
    expect(result.code).not.toBe(0);
    const report = result.json();
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('UX-11: the success summary counts flows too (flows ride the same line)', async () => {
    const runner = cli();
    writeFixture(runner.home, 'with-flow.json', {
      ...validScenario(),
      flows: [{
        id: 'flow-1', name: 'auto-cool', description: 'cool on heat', enabled: true,
        trigger: {
          kind: 'condition', zoneId: 'living-room',
          conditions: [{ path: 'temperature', op: '>', value: 30 }],
          cooldownSimSec: 300,
        },
        plan: { goal: 'cool the room', nodes: [{ id: 'n1', capability: 'temperature-control', params: { targetTemperature: 26 } }] },
      }],
    });
    const result = await runner.cli('scenario', 'validate', 'with-flow.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 flows');
  });

  it('UX-11: a dangling meta.heroEventId warns (meta-reference), still exit 0', async () => {
    const runner = cli();
    const scenario = validScenario();
    (scenario.meta as Record<string, unknown>).heroEventId = 'evt-ghost';
    writeFixture(runner.home, 'dangling-hero.json', scenario);
    const result = await runner.cli('scenario', 'validate', 'dangling-hero.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('meta-reference');
    expect(result.stdout).toContain('meta.heroEventId "evt-ghost" does not match any of the 1 declared events');
    expect(result.stdout).toContain('0 errors, 1 warning');
    expect(result.stdout).toContain('1 events; 1 warning');
  });

  it('UX-11: a matching meta.heroEventId produces no meta-reference warning', async () => {
    const runner = cli();
    const scenario = validScenario();
    (scenario.meta as Record<string, unknown>).heroEventId = 'evt-heat';
    writeFixture(runner.home, 'good-hero.json', scenario);
    const result = await runner.cli('scenario', 'validate', 'good-hero.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no issues');
  });

  it('UX-11: a non-positive meta.recommendedPlaybackRate warns (meta-reference)', async () => {
    const runner = cli();
    const scenario = validScenario();
    (scenario.meta as Record<string, unknown>).recommendedPlaybackRate = 0;
    writeFixture(runner.home, 'bad-rate.json', scenario);
    const result = await runner.cli('scenario', 'validate', 'bad-rate.json');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('meta-reference');
    expect(result.stdout).toContain('meta.recommendedPlaybackRate 0 is not a finite positive number');
  });

  it('UX-11: --json success carries counts matching the human summary', async () => {
    const runner = cli();
    writeFixture(runner.home, 'good-json.json', validScenario());
    const result = await runner.cli('scenario', 'validate', '--json', 'good-json.json');
    expect(result.code).toBe(0);
    const report = result.json();
    expect(report.valid).toBe(true);
    expect(report.counts).toEqual({ zones: 1, devices: 1, agents: 1, flows: 0, events: 1 });
    expect(report.warnings).toEqual([]);
  });
});
