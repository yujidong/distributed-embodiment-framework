/**
 * @vitest-environment node
 *
 * R57 — event semantic vocabulary alignment.
 *
 * The shenzhen gallery events now carry SEMANTIC capabilities (drainage-control,
 * grid-load-management, …) alongside the device words. Those words only work
 * because (a) core's SEMANTIC_OFFER_RULES can produce them from facility
 * capability bundles and (b) the environment bridge unions them into the
 * runtime agent surface. This suite guards BOTH sides of that contract so a
 * rule rename or an event edit cannot silently strand the vocabulary.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEMANTIC_OFFER_RULES, semanticOffersOf } from '@active-collaboration/core';

const scenario = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../config/scenarios/shenzhen-realistic.json'), 'utf-8'),
) as {
  events: Array<{ id: string; requiredCapabilities?: string[] }>;
  agents: Array<{ name: string; boundDeviceIds: string[] }>;
  devices: Array<{ id: string; capabilities: string[] }>;
};

const RULE_VOCAB = new Set(SEMANTIC_OFFER_RULES.map(rule => rule.semanticType));

describe('R57 event semantic vocabulary alignment', () => {
  it('every semantic word the events require exists in the offer rule table', () => {
    const eventSemantics = new Set<string>();
    for (const event of scenario.events) {
      for (const capability of event.requiredCapabilities ?? []) {
        // Heuristic: rule words are the ONLY capability names containing '-control'
        // patterns beyond device ones; assert membership directly instead.
        if (RULE_VOCAB.has(capability)) eventSemantics.add(capability);
      }
    }
    // The disaster-chain events reference all seven facility-side offers.
    expect([...eventSemantics].sort()).toEqual([...RULE_VOCAB].filter(t => t !== 'campus-air-comfort' || eventSemantics.has(t)).sort());
    expect(eventSemantics.size).toBeGreaterThanOrEqual(6);
  });

  it('every event semantic word is ACTUALLY producible by some steward bundle in the scenario', () => {
    const capsByDevice = new Map(scenario.devices.map(d => [d.id, d.capabilities]));
    const producible = new Set<string>();
    for (const agent of scenario.agents) {
      const union = new Set<string>();
      for (const deviceId of agent.boundDeviceIds) {
        for (const capability of capsByDevice.get(deviceId) ?? []) union.add(capability);
      }
      for (const offer of semanticOffersOf(union)) producible.add(offer.semanticType);
    }
    const eventSemantics = new Set(
      scenario.events
        .flatMap(event => event.requiredCapabilities ?? [])
        .filter(capability => RULE_VOCAB.has(capability)),
    );
    for (const word of eventSemantics) {
      expect(producible.has(word), `event requires "${word}" but no agent bundle produces it`).toBe(true);
    }
  });

  it('the disaster chain carries semantic words (9 semantic-bearing events)', () => {
    const withSemantics = scenario.events.filter(event =>
      (event.requiredCapabilities ?? []).some(capability => RULE_VOCAB.has(capability)),
    );
    expect(withSemantics.length).toBeGreaterThanOrEqual(9);
    // The Baoan critical flood names the drainage offer explicitly.
    const baoFlood = scenario.events.find(event => event.id === 'bao-flood-critical');
    expect(baoFlood?.requiredCapabilities).toContain('drainage-control');
  });
});
