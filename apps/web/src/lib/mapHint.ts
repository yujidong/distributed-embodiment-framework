/**
 * Map-interaction hint (W4) — the world view shows a one-time floating card
 * (「滚轮缩放 · 拖拽平移 · 点击查看详情」) over the map canvas; dismissing it
 * persists to localStorage so returning users are not nagged. Best-effort:
 * private-mode failures just mean the hint reappears on reload.
 */

const STORAGE_KEY = 'ac.mapHint.dismissed';

export function loadMapHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMapHintDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Non-fatal: the hint simply shows again next visit.
  }
}
