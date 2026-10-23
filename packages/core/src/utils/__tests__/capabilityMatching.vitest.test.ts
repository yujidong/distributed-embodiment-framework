import { describe, it, expect } from 'vitest';
import {
  capabilityMatches,
  computeCapabilityGap,
  hasAllCapabilities,
  CAPABILITY_SYNONYMS,
} from '../capabilityMatching.js';

/**
 * Scope-of-practice filter helpers (Workstream A3).
 * The readCannotDeliverClasses helper lives in PartnerSelectionNegotiator.ts;
 * here we test the public capabilityMatches logic the filter relies on.
 */
describe('scope-of-practice filtering (Workstream A3)', () => {
  it('controlled-substance-dispense does NOT semantically match tpa-dispense', () => {
    // Critical boundary: a pharmacy can claim 'controlled-substance-dispense'
    // but cannotDeliverClasses=['tpa-dispense'] must still block it.
    expect(capabilityMatches('tpa-dispense', 'tpa-dispense')).toBe(true);
    // And the broader 'controlled-substance-dispense' is NOT auto-matched:
    expect(capabilityMatches('controlled-substance-dispense', 'tpa-dispense')).toBe(false);
  });

  it('cath-lab-activation and pci-procedure are in the same synonym group (both blocked together)', () => {
    expect(capabilityMatches('cath-lab-activation', 'pci-procedure')).toBe(true);
    // So if cannotDeliverClasses=['pci-procedure'], an event requiring
    // 'cath-lab-activation' will match via the synonym group and be blocked.
    expect(
      ['pci-procedure'].some(c => capabilityMatches(c, 'cath-lab-activation')),
    ).toBe(true);
  });

  it('retail pharmacy cannotDeliverClasses blocks tPA selection even though pharmacy has dispensing capability', () => {
    const pharmacyCannotDeliver = ['tpa-dispense', 'cath-lab-activation', 'pci-procedure'];
    const strokeEventRequires = ['tpa-dispense', 'cath-lab-activation', 'stroke-consultation'];
    const blocked = strokeEventRequires.some(req =>
      pharmacyCannotDeliver.some(c => capabilityMatches(c, req)),
    );
    expect(blocked).toBe(true);
  });

  it('hospital-ed-agent (no cannotDeliverClasses) is not blocked', () => {
    const blocked = ['tpa-dispense'].some(req =>
      [].some(c => capabilityMatches(c, req)),
    );
    expect(blocked).toBe(false);
  });
});

describe('capabilityMatches', () => {
  describe('exact + substring (original behavior)', () => {
    it('matches identical strings', () => {
      expect(capabilityMatches('temperature-monitoring', 'temperature-monitoring')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(capabilityMatches('Temperature-Monitoring', 'temperature-monitoring')).toBe(true);
    });

    it('matches bidirectional substring', () => {
      expect(capabilityMatches('temperature-monitoring', 'temperature')).toBe(true);
      expect(capabilityMatches('temperature', 'temperature-monitoring')).toBe(true);
    });

    it('does not match unrelated capabilities', () => {
      expect(capabilityMatches('temperature-monitoring', 'humidity-monitoring')).toBe(false);
    });
  });

  describe('medical imaging synonym group', () => {
    it('matches ct-scan with imaging-service', () => {
      expect(capabilityMatches('ct-scan', 'imaging-service')).toBe(true);
    });

    it('matches field-ct-scan with ct-scan', () => {
      expect(capabilityMatches('field-ct-scan', 'ct-scan')).toBe(true);
    });

    it('matches stroke-imaging with diagnostic-imaging', () => {
      expect(capabilityMatches('stroke-imaging', 'diagnostic-imaging')).toBe(true);
    });

    it('does not match imaging with unrelated', () => {
      expect(capabilityMatches('imaging-service', 'fire-suppression')).toBe(false);
    });
  });

  describe('cath lab synonym group', () => {
    it('matches cath-lab-activation with pci-procedure', () => {
      expect(capabilityMatches('cath-lab-activation', 'pci-procedure')).toBe(true);
    });

    it('matches coronary-intervention with cardiac-intervention', () => {
      expect(capabilityMatches('coronary-intervention', 'cardiac-intervention')).toBe(true);
    });

    it('enables cardiology-agent selection for stroke requiring cath-lab-activation', () => {
      // The motivating bug from personal-health review
      const agentCaps = ['cath-lab-activation', 'pci-procedure', 'coronary-intervention'];
      const required = ['cath-lab-activation', 'pci-procedure', 'stroke-consultation'];
      // cath-lab and pci both match (same group); stroke-consultation does not
      const matched = required.filter(r => agentCaps.some(a => capabilityMatches(a, r)));
      expect(matched).toContain('cath-lab-activation');
      expect(matched).toContain('pci-procedure');
    });
  });

  describe('tPA dispensing synonym group', () => {
    it('matches tpa-dispense with thrombolytic-administration', () => {
      expect(capabilityMatches('tpa-dispense', 'thrombolytic-administration')).toBe(true);
    });

    it('does NOT match tpa-dispense with controlled-substance-dispense (scope-of-practice boundary)', () => {
      // Important: these are intentionally separate so scope-of-practice
      // filters (Workstream A3) can distinguish "any controlled substance"
      // from "specific thrombolytic authorization".
      expect(capabilityMatches('tpa-dispense', 'controlled-substance-dispense')).toBe(false);
    });
  });

  describe('fall / anaphylaxis / EMS / blood groups', () => {
    it('matches fall-detection with immobility-detection', () => {
      expect(capabilityMatches('fall-detection', 'immobility-detection')).toBe(true);
    });

    it('matches epinephrine-administration with anaphylaxis-treatment', () => {
      expect(capabilityMatches('epinephrine-administration', 'anaphylaxis-treatment')).toBe(true);
    });

    it('matches ambulance-dispatch with ems-dispatch', () => {
      expect(capabilityMatches('ambulance-dispatch', 'ems-dispatch')).toBe(true);
    });

    it('matches blood-unit-dispatch with transfusion-dispatch', () => {
      expect(capabilityMatches('blood-unit-dispatch', 'transfusion-dispatch')).toBe(true);
    });

    it('matches toxic-gas-monitoring with chemical-leak-detection', () => {
      expect(capabilityMatches('toxic-gas-monitoring', 'chemical-leak-detection')).toBe(true);
    });
  });
});

describe('computeCapabilityGap', () => {
  it('returns empty gap when all required match', () => {
    const { gap, matched } = computeCapabilityGap(
      ['cath-lab-activation', 'pci-procedure'],
      ['cath-lab-activation'],
    );
    expect(gap).toEqual([]);
    expect(matched).toEqual(['cath-lab-activation']);
  });

  it('returns full gap when nothing matches', () => {
    const { gap, matched } = computeCapabilityGap(
      ['temperature-monitoring'],
      ['cath-lab-activation', 'pci-procedure'],
    );
    expect(gap).toEqual(['cath-lab-activation', 'pci-procedure']);
    expect(matched).toEqual([]);
  });

  it('returns partial gap when some match', () => {
    const { gap, matched } = computeCapabilityGap(
      ['cath-lab-activation'],
      ['cath-lab-activation', 'tpa-dispense'],
    );
    expect(gap).toEqual(['tpa-dispense']);
    expect(matched).toEqual(['cath-lab-activation']);
  });
});

describe('hasAllCapabilities', () => {
  it('returns true for empty required', () => {
    expect(hasAllCapabilities(['anything'], [])).toBe(true);
  });

  it('returns true when all required capabilities are matched via synonyms', () => {
    expect(
      hasAllCapabilities(
        ['cath-lab-activation', 'coronary-intervention'],
        ['pci-procedure', 'cardiac-intervention'],
      ),
    ).toBe(true);
  });

  it('returns false when a required capability is missing', () => {
    expect(
      hasAllCapabilities(
        ['cath-lab-activation'],
        ['cath-lab-activation', 'tpa-dispense'],
      ),
    ).toBe(false);
  });
});

describe('CAPABILITY_SYNONYMS export', () => {
  it('contains all expected medical groups', () => {
    const flattened = CAPABILITY_SYNONYMS.flat().map(s => s.toLowerCase());
    for (const expected of [
      'ct-scan', 'imaging-service', 'stroke-imaging',
      'cath-lab-activation', 'pci-procedure', 'coronary-intervention',
      'tpa-dispense', 'thrombolytic-administration',
      'fall-detection', 'immobility-detection',
      'epinephrine-administration', 'anaphylaxis-treatment',
      'ambulance-dispatch', 'ems-dispatch',
      'blood-unit-dispatch', 'transfusion-dispatch',
    ]) {
      expect(flattened).toContain(expected);
    }
  });

  it('does NOT include controlled-substance-dispense in the tPA group', () => {
    // Find the group containing 'tpa-dispense'
    const tpaGroup = CAPABILITY_SYNONYMS.find(g => g.includes('tpa-dispense'));
    expect(tpaGroup).toBeDefined();
    expect(tpaGroup).not.toContain('controlled-substance-dispense');
  });
});

/**
 * R21-W3 (R11 P2 #6 applied): matcher parity — `deviceProvides` (the flow
 * runtime/authoring dispatch matcher) MUST be exactly capabilityMatches
 * applied per declared capability. Before the rectification deviceProvides
 * was a second, synonym-blind matcher: authorization accepted by synonym
 * ('cooling' on a 'temperature-control' device) while dispatch refused,
 * and the two sides could never be argued equal — only incidentally
 * aligned. This table pins the one-semantics contract.
 */
describe('R21-W3 matcher parity: deviceProvides ≡ capabilityMatches', () => {
  it('deviceProvides([a], b) === capabilityMatches(a, b) over a parity table', async () => {
    const { deviceProvides } = await import('../../flows/flow-invoker.js');
    const table: Array<[string, string]> = [
      // exact / case / containment
      ['turn-on', 'turn-on'],
      ['Turn-On', 'turn-on'],
      ['temperature-control', 'cooling'], // synonym group member
      ['hvac-control', 'heating'], // synonym group member
      ['fire-detection', 'fire-suppression'], // synonym group member
      ['smoke-detection', 'smoke-detected'], // synonym group member
      ['ct-scan', 'imaging-service'], // synonym group member
      ['emergency-call', 'cooling'], // both real names, unrelated
      ['gate-control', 'cooling'], // unrelated
      ['broadcast', 'set-volume'], // unrelated
      ['controlled-substance-dispense', 'tpa-dispense'], // deliberate NON-synonyms
      ['lighting-control', 'light-control'], // synonym group member
      ['water-leak-detection', 'water-shutoff'], // synonym group member
    ];
    for (const [declared, asked] of table) {
      expect(
        deviceProvides([declared], asked),
        `deviceProvides(['${declared}'], '${asked}')`,
      ).toBe(capabilityMatches(declared, asked));
    }
  });

  it('a multi-capability device matches if ANY declared capability matches (both matchers)', async () => {
    const { deviceProvides } = await import('../../flows/flow-invoker.js');
    const caps = ['turn-on', 'gate-control'];
    for (const asked of ['turn-on', 'cooling', 'gate-control', 'ct-scan']) {
      expect(deviceProvides(caps, asked)).toBe(
        caps.some(c => capabilityMatches(c, asked)),
      );
    }
  });
});

/**
 * P3: extendCapabilitySynonyms — scenario-registered groups extend the
 * process-level matcher (equivalence lane AND the service-text lane);
 * the built-in table itself is never mutated. Group names carry a `-p3`
 * suffix so repeated suite runs stay collision-free.
 */
describe('P3 — extendCapabilitySynonyms (process-level registry)', () => {
  it('a registered group participates in capabilityMatches', async () => {
    const m = await import('../capabilityMatching.js');
    expect(m.capabilityMatches('campus-noise-sensing-p3', 'sound-monitoring-p3')).toBe(false);
    m.extendCapabilitySynonyms([['campus-noise-sensing-p3', 'sound-monitoring-p3']]);
    expect(m.capabilityMatches('campus-noise-sensing-p3', 'sound-monitoring-p3')).toBe(true);
  });

  it('re-registering the same group is a no-op (idempotent scenario loads)', async () => {
    const m = await import('../capabilityMatching.js');
    m.extendCapabilitySynonyms([['campus-noise-sensing-p3', 'sound-monitoring-p3']]);
    // Same membership, different case/order — still a duplicate.
    m.extendCapabilitySynonyms([['SOUND-MONITORING-P3', 'campus-noise-sensing-p3']]);
    const matching = m
      .capabilitySynonymGroups()
      .filter(g => g.map(s => s.toLowerCase()).includes('campus-noise-sensing-p3'));
    expect(matching).toHaveLength(1);
  });

  it('the built-in table itself is never mutated', async () => {
    const m = await import('../capabilityMatching.js');
    expect(m.CAPABILITY_SYNONYMS.flat()).not.toContain('campus-noise-sensing-p3');
  });

  it('registered groups also feed the service-text lane (ServiceBroker semantics)', async () => {
    const m = await import('../capabilityMatching.js');
    // 'noise alert' names one member; the service prose names the other.
    expect(
      m.serviceTextCapabilityMatch(
        'sound-monitoring-p3 alert',
        'campus-noise-sensing-p3 station service',
      ),
    ).toBe(true);
    expect(
      m.serviceTextCapabilityMatch('sound-monitoring-p3 alert', 'unrelated aquarium service'),
    ).toBe(false);
  });
});

describe('P3 — SERVICE_TEXT_KEYWORDS (ServiceBroker convergence)', () => {
  it('keeps the legacy keyword relations verbatim', async () => {
    const m = await import('../capabilityMatching.js');
    expect(m.serviceTextCapabilityMatch('temperature', 'hvac unit in lobby')).toBe(true);
    expect(m.serviceTextCapabilityMatch('request_humidity_data', 'humidity monitoring')).toBe(true);
    expect(m.serviceTextCapabilityMatch('air-quality', 'ventilation service')).toBe(true);
    expect(m.serviceTextCapabilityMatch('security', 'camera service')).toBe(true);
    expect(m.serviceTextCapabilityMatch('lighting', 'dimmer switch')).toBe(true);
    expect(m.serviceTextCapabilityMatch('plumbing', 'camera service')).toBe(false);
  });
});
