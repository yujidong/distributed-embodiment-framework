/**
 * UX-W3 import-draft review helpers (lib/importDraft.ts): zone extraction,
 * rename/remove edits (immutably, keeping the draft consistent), summary
 * counts, and the scale suggestion the floorplan lane embeds in 400 messages.
 */

import { describe, expect, it } from 'vitest';

import {
  draftCounts,
  draftName,
  extractDraftZones,
  parseScaleSuggestionFromMessage,
  removeDraftZone,
  renameDraftZone,
} from '../lib/importDraft';

const DRAFT = {
  version: '1.0',
  meta: { id: 'demo', name: 'Demo Building' },
  zones: [
    { id: 'z1', name: 'Lobby', type: 'hall', bounds: { floor: 0 } },
    { id: 'z2', name: 'Room 201', type: 'room', bounds: { floor: 2 } },
    { id: 'z3' },
  ],
  devices: [
    { id: 'd1', zoneId: 'z1' },
    { id: 'd2', zoneId: 'z2' },
  ],
  agents: [{ id: 'a1', zoneIds: ['z1', 'z2'] }, { id: 'a2' }],
};

describe('extractDraftZones / draftCounts / draftName', () => {
  it('reads the zone table rows (name falls back to id; floor only when declared)', () => {
    expect(extractDraftZones(DRAFT)).toEqual([
      { id: 'z1', name: 'Lobby', type: 'hall', floor: 0 },
      { id: 'z2', name: 'Room 201', type: 'room', floor: 2 },
      { id: 'z3', name: 'z3', type: '', floor: null },
    ]);
    expect(draftCounts(DRAFT)).toEqual({ zones: 3, devices: 2, agents: 2 });
    expect(draftName(DRAFT)).toBe('Demo Building');
  });

  it('tolerates a draft without the arrays', () => {
    expect(extractDraftZones({})).toEqual([]);

    expect(draftCounts({})).toEqual({ zones: 0, devices: 0, agents: 0 });
    expect(draftName({})).toBe('');
  });

  it('prefers the building-tier zone-level floor (compileBuildingIR / NL drafts), bounds as fallback', () => {
    expect(
      extractDraftZones({
        zones: [
          { id: 'ward-1-f0', name: '病房 1', type: 'ward', floor: 0, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } },
          { id: 'ward-1-f2', name: '病房 1', type: 'ward', floor: 2 },
          { id: 'legacy', bounds: { floor: 1 } },
        ],
      }),
    ).toEqual([
      { id: 'ward-1-f0', name: '病房 1', type: 'ward', floor: 0 },
      { id: 'ward-1-f2', name: '病房 1', type: 'ward', floor: 2 },
      { id: 'legacy', name: 'legacy', type: '', floor: 1 },
    ]);
  });
});

describe('renameDraftZone / removeDraftZone', () => {
  it('renames without mutating the original draft', () => {
    const renamed = renameDraftZone(DRAFT, 'z1', 'Main Lobby');
    expect(extractDraftZones(renamed)[0]!.name).toBe('Main Lobby');
    expect(extractDraftZones(DRAFT)[0]!.name).toBe('Lobby');
  });

  it('removing a zone drops its devices and unbinds it from agents', () => {
    const removed = removeDraftZone(DRAFT, 'z1');
    expect(extractDraftZones(removed).map(z => z.id)).toEqual(['z2', 'z3']);
    expect((removed.devices as Array<{ id: string }>).map(d => d.id)).toEqual(['d2']);
    const agents = removed.agents as Array<{ id: string; zoneIds?: string[] }>;
    expect(agents[0]!.zoneIds).toEqual(['z2']);
    // An agent without zoneIds is untouched.
    expect(agents[1]!.zoneIds).toBeUndefined();
    // The original draft is unchanged.
    expect((DRAFT.devices as unknown[]).length).toBe(2);
  });

  it('removing a zone prunes dangling adjacency references (ux-w3 probe P1)', () => {
    const linked = {
      ...DRAFT,
      zones: [
        { id: 'z1', name: 'Lobby', adjacentZoneIds: ['z2'] },
        { id: 'z2', name: 'Room 201', adjacentZoneIds: ['z1'] },
        { id: 'z3', adjacentZoneIds: ['z2'] },
      ],
    };
    const removed = removeDraftZone(linked, 'z2');
    const zones = removed.zones as Array<{ id: string; adjacentZoneIds?: string[] }>;
    expect(zones.map(z => z.id)).toEqual(['z1', 'z3']);
    // No surviving zone references the removed one — the server import would
    // 422 SCENARIO_VALIDATION_FAILED otherwise.
    expect(zones[0]!.adjacentZoneIds).toEqual([]);
    expect(zones[1]!.adjacentZoneIds).toEqual([]);
  });
});

describe('parseScaleSuggestionFromMessage', () => {
  it('parses the retry-with phrasing the server embeds in 400s', () => {
    const message =
      'a scale is required — the LLM read a scale off the drawing: 42.5 px/m (read from the title block); ' +
      'verify it against the drawing, then retry with "pixelsPerMeter": 42.5 to accept';
    expect(parseScaleSuggestionFromMessage(message)).toBe(42.5);
  });

  it('returns null when the message carries no suggestion', () => {
    expect(parseScaleSuggestionFromMessage('Body field "floor" must be an integer')).toBeNull();
    expect(parseScaleSuggestionFromMessage('"pixelsPerMeter": -3')).toBeNull();
  });
});
