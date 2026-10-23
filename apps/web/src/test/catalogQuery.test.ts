/**
 * Catalog filter → query string tests (GET /api/catalog params).
 */

import { describe, expect, it } from 'vitest';

import { buildCatalogQuery } from '../lib/catalogQuery';

describe('buildCatalogQuery', () => {
  it('builds an empty string without filters', () => {
    expect(buildCatalogQuery({})).toBe('');
    expect(buildCatalogQuery({ q: '', deviceType: '', vendor: '' })).toBe('');
    expect(buildCatalogQuery({ q: '   ', vendor: ' ' })).toBe('');
  });

  it('maps deviceType to the snake_case device_type param', () => {
    expect(buildCatalogQuery({ deviceType: 'hvac' })).toBe('?device_type=hvac');
  });

  it('combines filters in a stable order and trims whitespace', () => {
    expect(buildCatalogQuery({ q: ' 空调 ', deviceType: ' hvac', vendor: '格力' })).toBe(
      `?device_type=hvac&vendor=${encodeURIComponent('格力')}&q=${encodeURIComponent('空调')}`,
    );
  });

  it('URL-encodes values', () => {
    const query = buildCatalogQuery({ q: 'a&b=c' });
    expect(query).toBe(`?q=${encodeURIComponent('a&b=c')}`);
  });
});
