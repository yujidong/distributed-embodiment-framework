/**
 * Console layout state (W7, revised A5) — the canvas-first drawers:
 *
 * - `rightOpen`: the right-hand drawer (chat + event injection + live
 *   panels). OPEN by default since R75: the drawer hosts the Agent 对话
 *   panel — the console's primary natural-language entry — and collapsed-by-
 *   default hid it behind 展开侧栏 (the R12 "can't find the entry" lesson,
 *   re-learned by the R75 persona round). Users who close it keep their
 *   choice via the persisted payload;
 * - `eventOpen`: the bottom event-log/narrative drawer; collapsed to its
 *   header row by default;
 * - `panels`: per-panel collapse state INSIDE the right drawer. `chat` (the
 *   AgentChatPanel) is OPEN by default — it is the interaction surface —
 *   while inject/fault/collab/live stay collapsed (progressive disclosure
 *   for the configuration panels);
 * - `focus`: 专注模式 — hides both drawers for a pure map+collab view.
 *   It is a WITHIN-VISIT zen mode: a fresh console entry always starts
 *   unfocused (loadConsoleLayoutForEntry), because entering the console with
 *   both drawers hidden silently drops the chat — the world session's
 *   primary NL entry — with zero hint (R84-F6: explorers clicked 进入世界仿真
 *   into a focus-mode console and read "no chat, no feedback" as a dead
 *   button; 退出专注 "self-healed" it).
 *
 * Persisted in localStorage under a v3 key (earlier payloads are ignored so
 * existing users pick up the new open-by-default chat — bump the key again
 * whenever the defaults change meaningfully). Pure toggles keep the
 * component thin and the transitions unit-testable.
 */

export interface ConsoleLayout {
  rightOpen: boolean;
  eventOpen: boolean;
  focus: boolean;
  panels: {
    /** EventInjectPanel (event injection form). */
    inject: boolean;
    /** FaultPanel (fault toggles). */
    fault: boolean;
    /** CollaborationsPanel (collaboration list). */
    collab: boolean;
    /** AgentChatPanel (natural-language agent interface, Phase 3). */
    chat: boolean;
    /** LivePanels (T3: 实时读数 4 面板组——按需展开，不再默认堆首屏). */
    live: boolean;
  };
}

export type ConsolePanelId = keyof ConsoleLayout['panels'];

export const DEFAULT_CONSOLE_LAYOUT: ConsoleLayout = {
  rightOpen: true,
  eventOpen: false,
  focus: false,
  panels: { inject: false, fault: false, collab: false, chat: true, live: false },
};

const STORAGE_KEY = 'ac.consoleLayout.v3';

export function toggleRightDrawer(layout: ConsoleLayout): ConsoleLayout {
  return { ...layout, rightOpen: !layout.rightOpen };
}

export function toggleEventDrawer(layout: ConsoleLayout): ConsoleLayout {
  return { ...layout, eventOpen: !layout.eventOpen };
}

export function toggleFocusMode(layout: ConsoleLayout): ConsoleLayout {
  return { ...layout, focus: !layout.focus };
}

export function togglePanel(layout: ConsoleLayout, panel: ConsolePanelId): ConsoleLayout {
  return { ...layout, panels: { ...layout.panels, [panel]: !layout.panels[panel] } };
}

export function loadConsoleLayout(): ConsoleLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CONSOLE_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONSOLE_LAYOUT;
    const record = parsed as Record<string, unknown>;
    const panels =
      typeof record.panels === 'object' && record.panels !== null
        ? (record.panels as Record<string, unknown>)
        : {};
    // Missing fields fall back to the DEFAULTS (single source of truth) —
    // a stored payload predating a new default still gets the new default
    // for the field it never persisted.
    const bool = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback;
    return {
      rightOpen: bool(record.rightOpen, DEFAULT_CONSOLE_LAYOUT.rightOpen),
      eventOpen: bool(record.eventOpen, DEFAULT_CONSOLE_LAYOUT.eventOpen),
      focus: bool(record.focus, DEFAULT_CONSOLE_LAYOUT.focus),
      panels: {
        inject: bool(panels.inject, DEFAULT_CONSOLE_LAYOUT.panels.inject),
        fault: bool(panels.fault, DEFAULT_CONSOLE_LAYOUT.panels.fault),
        collab: bool(panels.collab, DEFAULT_CONSOLE_LAYOUT.panels.collab),
        chat: bool(panels.chat, DEFAULT_CONSOLE_LAYOUT.panels.chat),
        live: bool(panels.live, DEFAULT_CONSOLE_LAYOUT.panels.live),
      },
    };
  } catch {
    // Corrupt payload or unavailable storage — fall back to defaults.
    return DEFAULT_CONSOLE_LAYOUT;
  }
}

/**
 * UX-W1: whether the user has ANY persisted console layout. ≤1024px viewports
 * default the right drawer to COLLAPSED on a fresh console entry (map-first;
 * the floating rail button reopens it) — but only when nothing was persisted;
 * an explicit open/close choice keeps winning.
 */
export function hasPersistedConsoleLayout(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveConsoleLayout(layout: ConsoleLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Non-fatal: the layout just won't survive a reload.
  }
}

/**
 * R84-F6: layout for a FRESH console entry (SimulationView mount). Focus mode
 * is stripped — entering the console into a pure-map view hides the Agent
 * 对话 panel (the world session's primary NL entry) with no on-screen hint,
 * which the F6 explorers read as「进入世界仿真」silently doing nothing. The
 * stripped payload is persisted back so storage converges instead of
 * re-arming focus on every later mount. Everything else (drawer/panel
 * choices) survives as before.
 */
export function loadConsoleLayoutForEntry(): ConsoleLayout {
  const layout = loadConsoleLayout();
  if (!layout.focus) return layout;
  const unfocused = { ...layout, focus: false };
  saveConsoleLayout(unfocused);
  return unfocused;
}
