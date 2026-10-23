/**
 * Map tile providers — the pluggable basemap registry for the geo world view
 * (§11.4, GeoWorldMap).
 *
 * Every provider is a plain raster-tile XYZ endpoint in Leaflet conventions:
 * `{z}/{x}/{y}` placeholders in some order (Esri uses z/y/x), optional `{s}`
 * subdomains, optional `{r}` retina suffix (Leaflet fills it when
 * `detectRetina` is on; empty otherwise). None of the default providers
 * needs an API key.
 *
 * Amap (高德) is the exception: its JS-API key + security code are account
 * bound, so the entry ships DISABLED until both `VITE_AMAP_KEY` and
 * `VITE_AMAP_JSCODE` are set in the web app's env (apps/web/.env.local).
 * Without them the registry stays build-safe and the UI shows the chip
 * greyed out with the reason.
 *
 * The user's choice persists in localStorage; the declared default is
 * `amap` (CARTO tiles are blocked from the deployment network), but a
 * DISABLED default never reaches the map — `loadMapProviderId` falls back
 * to the first enabled provider (R2-FEAT-01).
 */

import i18n from '../i18n/config';

export type MapProviderStyle = 'street' | 'satellite' | 'light';

export interface MapTileProvider {
  id: string;
  /** Chip label in the style switcher (resolved lazily via `providerName`). */
  name: string;
  attribution: string;
  tileUrl: string;
  /** Leaflet `subdomains` option (only when the URL has `{s}`). */
  subdomains?: string[];
  maxZoom: number;
  style: MapProviderStyle;
  /** Disabled entries render as a greyed-out chip with `disabledReason`. */
  enabled: boolean;
  disabledReason?: string;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTRIBUTION =
  `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

/** Provider id → i18n key for the chip label. */
const PROVIDER_NAME_KEY: Record<string, string> = {
  osm: 'mapProvidersLib:nameOsm',
  'carto-voyager': 'mapProvidersLib:nameCartoVoyager',
  'carto-dark': 'mapProvidersLib:nameCartoDark',
  'esri-satellite': 'mapProvidersLib:nameEsriSatellite',
  amap: 'mapProvidersLib:nameAmap',
};

/** Resolve a provider's display name in the active locale (call at render time). */
export function providerName(id: string): string {
  const key = PROVIDER_NAME_KEY[id];
  return key ? i18n.t(key) : id;
}

/** Resolve the amap disabled reason in the active locale. */
export function amapDisabledReason(): string {
  return i18n.t('mapProvidersLib:amapDisabledReason');
}

/** Amap activates only when both the JS-API key and the security code exist. */
const AMAP_KEY = import.meta.env.VITE_AMAP_KEY as string | undefined;
const AMAP_JSCODE = import.meta.env.VITE_AMAP_JSCODE as string | undefined;
const AMAP_ENABLED = Boolean(AMAP_KEY && AMAP_JSCODE);

export const MAP_PROVIDERS: readonly MapTileProvider[] = [
  {
    id: 'osm',
    name: '',
    attribution: OSM_ATTRIBUTION,
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    style: 'street',
    enabled: true,
  },
  {
    id: 'carto-voyager',
    name: '',
    attribution: CARTO_ATTRIBUTION,
    tileUrl: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    maxZoom: 20,
    style: 'light',
    enabled: true,
  },
  {
    id: 'carto-dark',
    name: '',
    attribution: CARTO_ATTRIBUTION,
    tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    maxZoom: 20,
    style: 'street',
    enabled: true,
  },
  {
    // Esri World Imagery uses the {z}/{y}/{x} tile order (not z/x/y).
    id: 'esri-satellite',
    name: '',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, ' +
      'and the GIS User Community',
    tileUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    style: 'satellite',
    enabled: true,
  },
  {
    // Standard Amap raster tile endpoint (road map, style=8). Activation
    // requires the account-bound JS-API credentials — see the file header.
    // TODO: once keys are provisioned, also wire window._AMapSecurityConfig
    //       (jscode) before any Amap JS-API usage.
    id: 'amap',
    name: '',
    attribution: '&copy; <a href="https://lbs.amap.com/">高德地图 AutoNavi</a>',
    tileUrl:
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18,
    style: 'street',
    enabled: AMAP_ENABLED,
    ...(AMAP_ENABLED
      ? {}
      : { disabledReason: 'Set VITE_AMAP_KEY and VITE_AMAP_JSCODE in apps/web/.env.local to enable' }),
  },
];

/**
 * Declared default basemap for city (geo) environments.
 * carto-voyager 瓦片在本网络被 CARTO 门槛拦截（满屏 API KEY REQUIRED 水印），
 * 默认切到高德栅格（国内可达、无密钥门槛）；key 配置见 .env.local。
 *
 * R2-FEAT-01: 该默认值可能处于 disabled（无 VITE_AMAP_KEY）——消费方一律走
 * `defaultEnabledProviderId()` / `loadMapProviderId()`，它们会把 disabled 的
 * 默认值回落到第一个 enabled provider，绝不把 disabled id 交给地图（否则
 * GeoWorldMap 不建瓦片层：零瓦片请求、全灰、零提示）。
 */
export const DEFAULT_MAP_PROVIDER_ID = 'amap';

/**
 * R2-FEAT-01: the EFFECTIVE default — the declared default when enabled,
 * otherwise the first enabled provider in the registry (osm/carto entries
 * are keyless-enabled, so this never stays disabled in practice).
 */
export function defaultEnabledProviderId(): string {
  const declared = getMapProvider(DEFAULT_MAP_PROVIDER_ID);
  if (declared?.enabled) return declared.id;
  return MAP_PROVIDERS.find(p => p.enabled)?.id ?? DEFAULT_MAP_PROVIDER_ID;
}

const STORAGE_KEY = 'eaf.geoMapProvider';

export function getMapProvider(id: string): MapTileProvider | undefined {
  const provider = MAP_PROVIDERS.find(p => p.id === id);
  if (!provider) return undefined;
  // Resolve the localized name and the amap disabled reason at lookup time so
  // a language change reflects on the next render without rebuilding the
  // registry. The English/Chinese strings both carry the env var names so the
  // existing test assertions stay valid.
  return {
    ...provider,
    name: providerName(provider.id),
    ...(provider.id === 'amap' && !provider.enabled
      ? { disabledReason: amapDisabledReason() }
      : {}),
  };
}

/**
 * The persisted provider id, validated: an unknown or disabled stored value
 * (e.g. amap after the keys were removed) falls back to the effective
 * default — which itself is validated (R2-FEAT-01), so the returned id is
 * ALWAYS an enabled provider when the registry has one.
 */
export function loadMapProviderId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const provider = getMapProvider(stored);
      if (provider?.enabled) return provider.id;
    }
  } catch {
    // localStorage unavailable (privacy mode) — fall through to default.
  }
  return defaultEnabledProviderId();
}

export function saveMapProviderId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
}
