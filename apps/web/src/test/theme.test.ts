/**
 * Theme tests — lib/theme palettes + helpers (TS-side token source for the
 * Leaflet/reactflow overlays) and the store's theme slice (toggle +
 * localStorage persistence + prefers-color-scheme fallback).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collabEdgeColors,
  loadTheme,
  mapColors,
  roleColor,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from '../lib/theme';
import { useAppStore } from '../store/useAppStore';

function stubMatchMedia(lightMatches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: lightMatches && query === '(prefers-color-scheme: light)',
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

describe('lib/theme palettes', () => {
  it('both themes define the same keys, all opaque hex colors', () => {
    const dark = mapColors('dark');
    const light = mapColors('light');
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const value of [...Object.values(dark), ...Object.values(light)]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps the dark palette anchored to the established styles.css colors', () => {
    const dark = mapColors('dark');
    expect(dark.bg).toBe('#0d1117');
    expect(dark.accent).toBe('#4cc2ff');
    expect(dark.sensor).toBe('#2dd4bf');
    expect(dark.actuator).toBe('#f5a524');
    expect(dark.hybrid).toBe('#b07cf0');
    expect(dark.danger).toBe('#f2555a');
    expect(dark.ok).toBe('#3fb950');
  });

  it('deepens the semantic colors in the light theme for contrast', () => {
    const light = mapColors('light');
    const dark = mapColors('dark');
    expect(light.accent).not.toBe(dark.accent);
    expect(light.bg).not.toBe(dark.bg);
    expect(light.text).not.toBe(dark.text);
  });
});

describe('roleColor', () => {
  it('maps the three device roles and falls back to textDim', () => {
    const colors = mapColors('dark');
    expect(roleColor(colors, 'sensor')).toBe(colors.sensor);
    expect(roleColor(colors, 'actuator')).toBe(colors.actuator);
    expect(roleColor(colors, 'hybrid')).toBe(colors.hybrid);
    expect(roleColor(colors, 'unknown')).toBe(colors.textDim);
  });
});

describe('collabEdgeColors', () => {
  it('covers every AC edge status per theme', () => {
    for (const theme of ['dark', 'light'] as const) {
      const colors = mapColors(theme);
      const edges = collabEdgeColors(colors);
      expect(edges.forming).toBe(colors.accent);
      expect(edges.running).toBe(colors.accent);
      expect(edges.completed).toBe(colors.ok);
      expect(edges.failed).toBe(colors.danger);
    }
  });
});

describe('loadTheme', () => {
  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('defaults to dark without a stored choice or matchMedia', () => {
    expect(loadTheme()).toBe('dark');
  });

  it('prefers the stored choice over the system preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubMatchMedia(false);
    expect(loadTheme()).toBe('light');
  });

  it('follows prefers-color-scheme when nothing valid is stored', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    stubMatchMedia(true);
    expect(loadTheme()).toBe('light');
  });
});

describe('store theme slice', () => {
  const initialTheme = THEME_COLORS[useAppStore.getState().theme] ? useAppStore.getState().theme : 'dark';

  afterEach(() => {
    useAppStore.getState().setTheme(initialTheme);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('exposes a valid initial theme', () => {
    expect(['dark', 'light']).toContain(useAppStore.getState().theme);
  });

  it('setTheme updates state and persists to localStorage', () => {
    useAppStore.getState().setTheme('light');
    expect(useAppStore.getState().theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('toggleTheme flips dark ↔ light and persists each step', () => {
    useAppStore.getState().setTheme('dark');
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
