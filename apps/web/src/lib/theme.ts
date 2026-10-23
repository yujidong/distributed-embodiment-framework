/**
 * Theme — TS 侧的设计 token 单一事实源。
 *
 * Leaflet / reactflow 覆盖层通过 JS API 接收具体色值（不能用 CSS 变量），
 * 因此这里维护与 styles.css `:root` / `[data-theme='light']` 一致的双主题
 * 调色板——改任一侧的语义色时必须同步另一侧（styles.css 文件头有同样提示）。
 *
 * 主题偏好持久化在 localStorage（key: eaf-theme），未存储时跟随
 * prefers-color-scheme；index.html 的内联脚本用同一 key 防首屏闪烁。
 */

import type { CollabEdgeStatus } from './collabGraph';

export type ThemeName = 'dark' | 'light';

/** 与 styles.css 变量一一对应的语义色（覆盖层用到的子集）。 */
export interface MapColors {
  bg: string;
  bgPanel: string;
  bgRaised: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  sensor: string;
  actuator: string;
  hybrid: string;
  danger: string;
  /** 故障注入红（--danger-strong）：比 danger 更深一档。 */
  dangerStrong: string;
  ok: string;
}

export const THEME_COLORS: Record<ThemeName, MapColors> = {
  dark: {
    bg: '#0d1117',
    bgPanel: '#161b22',
    bgRaised: '#1c2330',
    /* 与 styles.css 同步：border 对比略加强，text-dim 调亮一档。 */
    border: '#39414f',
    text: '#d6dde6',
    textDim: '#9ba6b5',
    accent: '#4cc2ff',
    sensor: '#2dd4bf',
    actuator: '#f5a524',
    hybrid: '#b07cf0',
    danger: '#f2555a',
    dangerStrong: '#e5484d',
    ok: '#3fb950',
  },
  light: {
    bg: '#f2f4f8',
    bgPanel: '#ffffff',
    bgRaised: '#eef1f6',
    border: '#c4ccd9',
    text: '#1c2430',
    textDim: '#525c6b',
    accent: '#0b74bd',
    sensor: '#0d9488',
    actuator: '#b45309',
    hybrid: '#7c3aed',
    danger: '#cf222e',
    dangerStrong: '#c2252b',
    ok: '#1a7f37',
  },
};

/** 按主题取覆盖层色板。 */
export function mapColors(theme: ThemeName): MapColors {
  return THEME_COLORS[theme];
}

/** 设备角色 → 点填充色；未知角色回落 textDim（与 .device-dot 默认一致）。 */
export function roleColor(colors: MapColors, role: string): string {
  if (role === 'sensor') return colors.sensor;
  if (role === 'actuator') return colors.actuator;
  if (role === 'hybrid') return colors.hybrid;
  return colors.textDim;
}

/** On-map AC 协作边颜色（WorldMap / GeoWorldMap / CollaborationGraph 共用）。 */
export function collabEdgeColors(colors: MapColors): Record<CollabEdgeStatus, string> {
  return {
    forming: colors.accent,
    running: colors.accent,
    completed: colors.ok,
    failed: colors.danger,
  };
}

// ---------------------------------------------------------------------------
// 主题偏好持久化
// ---------------------------------------------------------------------------

export const THEME_STORAGE_KEY = 'eaf-theme';

/**
 * 初始主题：localStorage 里的显式选择优先，否则跟随系统
 * prefers-color-scheme，再回落暗色（控制台默认）。
 */
export function loadTheme(): ThemeName {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage 不可用（隐私模式）——继续回落。
  }
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

export function saveTheme(theme: ThemeName): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 非致命：选择只是不会跨刷新保留。
  }
}
