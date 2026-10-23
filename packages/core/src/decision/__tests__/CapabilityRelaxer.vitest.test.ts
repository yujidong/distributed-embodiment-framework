import { describe, it, expect } from 'vitest';
import { CapabilityRelaxer } from '../CapabilityRelaxer.js';

describe('CapabilityRelaxer', () => {
  let relaxer: CapabilityRelaxer;

  // Use beforeEach pattern inline since this is a simple class.
  function makeRelaxer(): CapabilityRelaxer {
    return new CapabilityRelaxer();
  }

  describe('relax', () => {
    it('returns the same set when no synonyms exist', () => {
      relaxer = makeRelaxer();
      const result = relaxer.relax(['nonexistent-capability']);
      expect(result).toEqual(['nonexistent-capability']);
    });

    it('expands cath-lab-activation to its synonym group', () => {
      relaxer = makeRelaxer();
      const result = relaxer.relax(['cath-lab-activation']);
      expect(result).toContain('cath-lab-activation');
      expect(result).toContain('pci-procedure');
      expect(result).toContain('coronary-intervention');
      expect(result).toContain('cardiac-intervention');
    });

    it('expands ct-scan to imaging group', () => {
      relaxer = makeRelaxer();
      const result = relaxer.relax(['ct-scan']);
      expect(result).toContain('ct-scan');
      expect(result).toContain('imaging-service');
      expect(result).toContain('stroke-imaging');
    });

    it('is idempotent (relaxing an already-relaxed set returns same)', () => {
      relaxer = makeRelaxer();
      const once = relaxer.relax(['cath-lab-activation']);
      const twice = relaxer.relax(once);
      expect(twice.length).toBe(once.length);
      expect(new Set(twice)).toEqual(new Set(once));
    });

    it('handles multiple capabilities', () => {
      relaxer = makeRelaxer();
      const result = relaxer.relax(['cath-lab-activation', 'ct-scan']);
      expect(result).toContain('pci-procedure');
      expect(result).toContain('imaging-service');
      expect(result.length).toBeGreaterThan(2);
    });

    it('handles empty input', () => {
      relaxer = makeRelaxer();
      expect(relaxer.relax([])).toEqual([]);
    });
  });

  describe('hasAnyMatchAfterRelaxation', () => {
    it('finds match via synonym group', () => {
      relaxer = makeRelaxer();
      // Direct match would fail, but after relaxation the synonym matches.
      const result = relaxer.hasAnyMatchAfterRelaxation(
        ['pci-procedure'],
        ['coronary-intervention'], // these are in the same synonym group
      );
      expect(result).toBe(true);
    });

    it('returns false when no match even after relaxation', () => {
      relaxer = makeRelaxer();
      const result = relaxer.hasAnyMatchAfterRelaxation(
        ['cath-lab-activation'],
        ['temperature-monitoring'], // unrelated
      );
      expect(result).toBe(false);
    });
  });
});
