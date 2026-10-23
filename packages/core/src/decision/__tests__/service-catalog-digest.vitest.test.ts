/**
 * R45-P4 — service-catalog digest for the AC-necessity prompt.
 *
 * Pins the digest contract:
 *
 * 1. Determinism — same semantic catalog in any registration order renders
 *    byte-identical CATALOG/SHORTLIST lines (LLM response-cache key stays
 *    stable, same A4 discipline as R32).
 * 2. Offer weighting — signable offers (origin aggregate/published) rank
 *    ahead of raw device services at EQUAL gap relevance, but never outrank
 *    a genuinely more gap-relevant partner (capabilityMatches stays the
 *    single truth for gap verdicts).
 * 3. Top-K budget — default 8, LLM_PARTNER_TOP_K override, invalid values
 *    fall back to the default.
 * 4. Topology signature — the PartnerSummaryIndex cache signature covers
 *    origin/semanticType: a world-layer re-sync that only flips provenance
 *    still forces a recompute.
 * 5. Gap honesty — an uncoverable gap sets hasGapMatch=false (the prompt
 *    renders the honest "0 of N cover this event's needs" line).
 * 6. Token win — on a campus-scale (~60-service) catalog the digest section
 *    is far cheaper than the pre-R32 full listing.
 * 7. Liveness — heartbeat-stale partners rank below live ones at equal gap
 *    relevance and carry a `,stale` marker on the SHORTLIST line; the
 *    topology signature covers the stale flag (a flip forces recompute).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildServiceCatalogDigest,
  renderCatalogStatsLine,
  renderShortlistLine,
  type ServiceCatalogDigest,
} from '../service-catalog-digest.js';
import {
  matchStrength,
  PartnerSummaryIndex,
  type PartnerSummary,
  type ServiceOrigin,
} from '../partner-summaries.js';
import { extendCapabilitySynonyms } from '../../utils/capabilityMatching.js';
import type { AgentContext } from '../ACNecessityAssessor.js';

const svc = (
  name: string,
  capabilities: string[],
  zone: string,
  origin?: ServiceOrigin,
  semanticType?: string,
): PartnerSummary => ({
  serviceName: name,
  semanticType: (semanticType ?? capabilities[0] ?? 'general').toLowerCase(),
  zone,
  ...(origin !== undefined ? { origin } : {}),
  capabilities,
  providerAgentId: 'other-agent',
});

const digestOf = (
  summaries: PartnerSummary[],
  declaredNeeds: string[] = ['cooling'],
  eventZone = 'zone-a',
): ServiceCatalogDigest =>
  buildServiceCatalogDigest(summaries, declaredNeeds, [], eventZone, ['monitoring']);

const rendered = (d: ServiceCatalogDigest): string =>
  `${renderCatalogStatsLine(d)}\n${renderShortlistLine(d)}`;

afterEach(() => {
  delete process.env.LLM_PARTNER_TOP_K;
});

describe('R45-P4: service-catalog digest', () => {
  it('1: deterministic — registration order never changes the rendered digest', () => {
    const catalog = [
      svc('ac-1', ['cooling'], 'zone-a'),
      svc('light-1', ['lighting-control'], 'zone-b'),
      svc('drainage', ['drainage-control'], 'zone-a', 'aggregate'),
      svc('lock-1', ['access-control'], 'zone-c'),
    ];
    const forward = rendered(digestOf(catalog));
    const reversed = rendered(digestOf([...catalog].reverse()));
    expect(forward).toBe(reversed);
    // ...and the digest object itself is order-stable where it matters.
    const d1 = digestOf(catalog);
    const d2 = digestOf([...catalog].reverse());
    expect(d1.domains).toEqual(d2.domains);
    expect(d1.shortlist.map(s => s.serviceName)).toEqual(d2.shortlist.map(s => s.serviceName));
  });

  it('2: offer weighting — equal gap relevance ranks aggregate/published ahead of derived', () => {
    const derived = svc('raw-pump', ['drainage-control'], 'zone-b');
    const aggregate = svc('campus-drainage', ['drainage-control'], 'zone-b', 'aggregate');
    const published = svc('published-drainage', ['drainage-control'], 'zone-b', 'published');
    const d = buildServiceCatalogDigest(
      [derived, aggregate, published],
      ['drainage-control'],
      [],
      'zone-a',
      ['monitoring'],
    );
    // Both offers outrank the equally-relevant raw device service...
    expect(d.shortlist.map(s => s.serviceName)).toEqual([
      'campus-drainage',
      'published-drainage',
      'raw-pump',
    ]);
    // ...and the offer marker rides the shortlist line.
    expect(renderShortlistLine(d)).toContain('campus-drainage(drainage-control@zone-b,offer)');
    expect(renderShortlistLine(d)).not.toContain('raw-pump(drainage-control@zone-b,offer)');
  });

  it('2b: offer bonus never outranks a genuinely more gap-relevant partner', () => {
    const noMatchOffer = svc('lighting-offer', ['lighting-control'], 'zone-a', 'published', 'lighting');
    const gapCoveringDerived = svc('pump-1', ['drainage-control'], 'zone-c');
    const d = buildServiceCatalogDigest(
      [noMatchOffer, gapCoveringDerived],
      ['drainage-control'],
      [],
      'zone-a',
      ['monitoring'],
    );
    // gapScore dominates: the derived service covering the gap stays first
    // even though the offer gets the bonus AND the event-zone proximity bonus.
    expect(d.shortlist[0]!.serviceName).toBe('pump-1');
    expect(d.shortlist[1]!.serviceName).toBe('lighting-offer');
  });

  it('3: top-K defaults to 8 and LLM_PARTNER_TOP_K overrides it', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      svc(`cooler-${String(i).padStart(2, '0')}`, ['cooling'], 'zone-b'),
    );
    expect(digestOf(many).shortlist).toHaveLength(8);

    process.env.LLM_PARTNER_TOP_K = '3';
    expect(digestOf(many).shortlist).toHaveLength(3);

    process.env.LLM_PARTNER_TOP_K = 'not-a-number';
    expect(digestOf(many).shortlist).toHaveLength(8);

    // An explicit opts.topK beats the env (call-site control).
    process.env.LLM_PARTNER_TOP_K = '3';
    const d = buildServiceCatalogDigest(many, ['cooling'], [], 'zone-a', ['monitoring'], { topK: 5 });
    expect(d.shortlist).toHaveLength(5);
  });

  it('4: topology signature covers origin/semanticType (world-layer re-sync recomputes)', () => {
    const index = new PartnerSummaryIndex();
    const base = {
      serviceName: 'Pump Service',
      capabilities: ['drainage-control'],
      providerAgentId: 'p1',
      location: 'zone-a',
      origin: 'derived' as ServiceOrigin,
    };
    const ctxFor = (services: unknown[]): AgentContext =>
      ({ agentId: 'a1', discoverableServices: services }) as unknown as AgentContext;

    index.summariesFor(ctxFor([base])); // recompute 1
    index.summariesFor(ctxFor([{ ...base }])); // reuse (identical topology)
    expect(index.getStats()).toEqual({ recomputes: 1, reuses: 1 });

    // Same name/location/caps, origin flipped derived → aggregate: recompute.
    const asOffer = index.summariesFor(ctxFor([{ ...base, origin: 'aggregate' as ServiceOrigin }]));
    expect(index.getStats()).toEqual({ recomputes: 2, reuses: 1 });
    expect(asOffer[0]!.origin).toBe('aggregate');

    // Same again but the declared semanticType lands: recompute + carried through.
    const typed = index.summariesFor(ctxFor([{ ...base, semanticType: 'drainage-control' }]));
    expect(index.getStats()).toEqual({ recomputes: 3, reuses: 1 });
    expect(typed[0]!.semanticType).toBe('drainage-control');
  });

  it('7: stale partners — demoted below live ones at equal gap relevance and annotated', () => {
    const live = svc('live-pump', ['drainage-control'], 'zone-b');
    const stale: PartnerSummary = { ...svc('dead-pump', ['drainage-control'], 'zone-b'), stale: true };
    const d = buildServiceCatalogDigest(
      [stale, live],
      ['drainage-control'],
      [],
      'zone-a',
      ['monitoring'],
    );
    // Equal gap relevance → the live partner ranks ahead of the stale one.
    expect(d.shortlist.map(s => s.serviceName)).toEqual(['live-pump', 'dead-pump']);
    // The stale marker rides the shortlist line.
    expect(renderShortlistLine(d)).toContain('dead-pump(drainage-control@zone-b,stale)');
    expect(renderShortlistLine(d)).not.toContain('live-pump(drainage-control@zone-b,stale)');
    // A stale service that genuinely covers the gap still counts for honesty.
    expect(d.hasGapMatch).toBe(true);
  });

  it('7b: staleness flip forces a summary recompute (topology signature covers stale)', () => {
    const index = new PartnerSummaryIndex();
    const base = {
      serviceName: 'Pump Service',
      capabilities: ['drainage-control'],
      providerAgentId: 'p1',
      location: 'zone-a',
    };
    const ctxFor = (services: unknown[]): AgentContext =>
      ({ agentId: 'a1', discoverableServices: services }) as unknown as AgentContext;

    index.summariesFor(ctxFor([base]));
    index.summariesFor(ctxFor([{ ...base }]));
    expect(index.getStats()).toEqual({ recomputes: 1, reuses: 1 });

    const flagged = index.summariesFor(ctxFor([{ ...base, stale: true }]));
    expect(index.getStats()).toEqual({ recomputes: 2, reuses: 1 });
    expect(flagged[0]!.stale).toBe(true);
  });

  it('5: uncoverable gap stays honest (hasGapMatch=false, gapNeeds carried)', () => {
    const d = buildServiceCatalogDigest(
      [svc('ac-1', ['cooling'], 'zone-a')],
      ['fire-suppression'],
      [],
      'zone-a',
      ['monitoring'],
    );
    expect(d.hasGapMatch).toBe(false);
    expect(d.gapNeeds).toEqual(['fire-suppression']);
  });

  it('5b: matchStrength reads scenario-registered synonym groups (P3 extension)', () => {
    extendCapabilitySynonyms([['p4-sandbag-deploy', 'p4-flood-barrier']]);
    expect(matchStrength('p4-flood-barrier', 'p4-sandbag-deploy')).toBe(2);
  });

  it('6: campus-scale catalog — digest section is far cheaper than the full listing', () => {
    // ~60-service campus catalog: 24 hvac, 18 lighting, 9 drainage offers, 9 access.
    const catalog: PartnerSummary[] = [];
    for (let i = 0; i < 24; i++) catalog.push(svc(`hvac-unit-${i}`, ['hvac-control', 'temperature-monitoring'], `zone-${i % 10}`));
    for (let i = 0; i < 18; i++) catalog.push(svc(`light-${i}`, ['lighting-control'], `zone-${i % 10}`));
    for (let i = 0; i < 9; i++) catalog.push(svc(`drainage-offer-${i}`, ['drainage-control'], `zone-${i % 5}`, 'aggregate'));
    for (let i = 0; i < 9; i++) catalog.push(svc(`door-lock-${i}`, ['access-control'], `zone-${i % 10}`));

    // Pre-R32 style: EVERY service listed with its full capability roster.
    const oldSection = catalog
      .map(s => `${s.serviceName}(${s.capabilities.join(',')}@${s.zone})`)
      .join(', ');
    const digest = buildServiceCatalogDigest(catalog, ['drainage-control'], [], 'zone-1', ['monitoring']);
    const newSection = rendered(digest);

    // Rough token estimate (chars/4 — the standard GPT-style approximation).
    const tokens = (text: string): number => Math.ceil(text.length / 4);
    // The R32 (pre-P4) shape for the same catalog: top-3 line, no catalog stats.
    const r32Section = `AVAILABLE_PARTNERS: top 3 of ${catalog.length} by relevance (other agents' services, NOT yours): ` +
      digest.shortlist.slice(0, 3)
        .map(s => `${s.serviceName}(${s.matchedNeed ?? s.semanticType}${s.zone ? `@${s.zone}` : ''})`)
        .join(', ');
    const oldTokens = tokens(oldSection);
    const r32Tokens = tokens(r32Section);
    const newTokens = tokens(newSection);
    console.log(
      `[R45-P4 token-compare] 60-service campus catalog: ` +
      `pre-R32 full listing ≈ ${oldTokens} tokens (${oldSection.length} chars), ` +
      `R32 top-3 line ≈ ${r32Tokens} tokens (${r32Section.length} chars), ` +
      `P4 digest ≈ ${newTokens} tokens (${newSection.length} chars)`,
    );
    expect(newTokens).toBeLessThan(oldTokens / 3);

    // The stats line carries the whole catalog at a glance.
    expect(renderCatalogStatsLine(digest)).toBe(
      'CATALOG: 60 services (9 signable offers) — 24 hvac-control, 18 lighting-control, ' +
      '9 access-control, 9 drainage-control(offer)',
    );
    // Shortlist prefers the gap-relevant drainage offers.
    expect(digest.shortlist.every(s => s.semanticType === 'drainage-control')).toBe(true);
    expect(digest.shortlist[0]!.origin).toBe('aggregate');
  });
});
