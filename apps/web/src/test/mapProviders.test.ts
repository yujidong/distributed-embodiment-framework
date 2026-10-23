/**
 * Map tile provider registry tests (§11.4, src/lib/mapProviders.ts)
 *
 * Registry integrity: every provider carries attribution and a Leaflet-style
 * XYZ URL ({z}/{x}/{y} in SOME order — Esri uses z/y/x); the required
 * providers exist; the default is enabled; Amap stays disabled without its
 * account-bound env keys; the localStorage persistence round-trips and
 * rejects unknown/disabled stored values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAP_PROVIDER_ID,
  MAP_PROVIDERS,
  defaultEnabledProviderId,
  getMapProvider,
  loadMapProviderId,
  saveMapProviderId,
} from '../lib/mapProviders';

/** Re-import the registry with the Amap keys stubbed out (local .env must not leak in). */
async function loadRegistryWithAmapDisabled() {
  vi.stubEnv('VITE_AMAP_KEY', '');
  vi.stubEnv('VITE_AMAP_JSCODE', '');
  vi.resetModules();
  return await import('../lib/mapProviders');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('map provider registry', () => {
  it('contains the required providers with unique ids', () => {
    const ids = MAP_PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of ['osm', 'carto-voyager', 'carto-dark', 'esri-satellite', 'amap']) {
      expect(ids).toContain(required);
    }
  });

  it('every provider has an attribution and a valid XYZ tile URL', () => {
    for (const provider of MAP_PROVIDERS) {
      expect(provider.attribution.length).toBeGreaterThan(0);
      expect(provider.tileUrl.startsWith('https://')).toBe(true);
      // {z}/{x}/{y} placeholders in some order (Esri: {z}/{y}/{x}).
      expect(provider.tileUrl).toContain('{z}');
      expect(provider.tileUrl).toContain('{x}');
      expect(provider.tileUrl).toContain('{y}');
      // {s} subdomains must be declared when the URL uses them.
      if (provider.tileUrl.includes('{s}')) {
        expect(provider.subdomains?.length).toBeGreaterThan(0);
      }
      expect(provider.maxZoom).toBeGreaterThan(0);
      expect(['street', 'satellite', 'light']).toContain(provider.style);
      // Disabled entries must explain why (shown as the chip tooltip).
      if (!provider.enabled) {
        expect(provider.disabledReason).toBeTruthy();
      }
    }
  });

  it('esri-satellite uses the ArcGIS {z}/{y}/{x} tile order', () => {
    expect(getMapProvider('esri-satellite')?.tileUrl).toContain('/tile/{z}/{y}/{x}');
    expect(getMapProvider('esri-satellite')?.style).toBe('satellite');
  });

  it('the declared default is amap (CARTO tiles are blocked from the deployment network)', () => {
    // Default switched carto-voyager → amap (see lib/mapProviders.ts header):
    // CARTO serves API-KEY-REQUIRED watermarks from the deployment network.
    expect(DEFAULT_MAP_PROVIDER_ID).toBe('amap');
    // amap activates only with VITE_AMAP_KEY/VITE_AMAP_JSCODE provisioned —
    // without keys the default reports its disabledReason rather than
    // silently failing (covered by the disabled-registry test below).
    const provider = getMapProvider(DEFAULT_MAP_PROVIDER_ID);
    expect(provider).toBeDefined();
    if (!provider!.enabled) {
      expect(provider!.disabledReason).toContain('VITE_AMAP_KEY');
    }
  });

  it('R2-FEAT-01: a disabled declared default never reaches the map — the effective default falls back to the first enabled provider', async () => {
    const mod = await loadRegistryWithAmapDisabled();
    expect(mod.getMapProvider(mod.DEFAULT_MAP_PROVIDER_ID)?.enabled).toBe(false);
    // The effective default must be an ENABLED provider (osm/carto entries
    // are keyless) — the pre-fix behavior handed the disabled amap id to
    // GeoWorldMap, which then never created a tile layer (grey void, zero
    // tile requests, no explanation).
    const effective = mod.defaultEnabledProviderId();
    expect(effective).toBe('osm');
    expect(mod.getMapProvider(effective)?.enabled).toBe(true);
    expect(mod.loadMapProviderId()).toBe(effective);
  });

  it('amap is disabled without VITE_AMAP_KEY + VITE_AMAP_JSCODE, with a reason', async () => {
    const mod = await loadRegistryWithAmapDisabled();
    const amap = mod.getMapProvider('amap');
    expect(amap).toBeDefined();
    expect(amap?.enabled).toBe(false);
    expect(amap?.disabledReason).toContain('VITE_AMAP_KEY');
    expect(amap?.disabledReason).toContain('VITE_AMAP_JSCODE');
  });
});

describe('map provider persistence (localStorage)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('falls back to the effective default when nothing is stored', () => {
    // R2-FEAT-01: the effective default, not the declared one — when amap is
    // keyless-disabled the fallback is the first enabled provider.
    expect(loadMapProviderId()).toBe(defaultEnabledProviderId());
    expect(getMapProvider(loadMapProviderId())?.enabled).toBe(true);
  });

  it('round-trips a saved enabled provider', () => {
    saveMapProviderId('carto-dark');
    expect(loadMapProviderId()).toBe('carto-dark');
  });

  it('rejects unknown or disabled stored ids', async () => {
    const mod = await loadRegistryWithAmapDisabled();
    mod.saveMapProviderId('amap'); // disabled → not loadable
    // R2-FEAT-01: falls back to the effective (enabled) default, not the
    // disabled declared default.
    expect(mod.loadMapProviderId()).toBe(mod.defaultEnabledProviderId());
    expect(mod.getMapProvider(mod.loadMapProviderId())?.enabled).toBe(true);

    window.localStorage.setItem('eaf.geoMapProvider', 'no-such-provider');
    expect(mod.loadMapProviderId()).toBe(mod.defaultEnabledProviderId());
  });
});
