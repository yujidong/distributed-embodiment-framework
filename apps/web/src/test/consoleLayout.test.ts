/**
 * W7/A5 + R75 console layout reducers + localStorage persistence: drawer
 * toggles, per-panel collapse state, v3 key (older payloads ignored),
 * corrupt/partial payload fallback with default merging.
 *
 * R75 defaults: the right drawer opens with the Agent 对话 panel — the
 * console's primary NL entry must be visible without finding 展开侧栏.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONSOLE_LAYOUT,
  loadConsoleLayout,
  loadConsoleLayoutForEntry,
  saveConsoleLayout,
  toggleEventDrawer,
  toggleFocusMode,
  togglePanel,
  toggleRightDrawer,
} from '../lib/consoleLayout';

describe('console layout toggles', () => {
  // Toggle reducers are pure — exercise them from an explicit known state so
  // the tests stay meaningful whatever the shipped defaults are.
  const ALL_CLOSED = {
    rightOpen: false,
    eventOpen: false,
    focus: false,
    panels: { inject: false, fault: false, collab: false, chat: false, live: false },
  };

  it('toggles each drawer independently', () => {
    const rightOn = toggleRightDrawer(ALL_CLOSED);
    expect(rightOn.rightOpen).toBe(true);
    expect(rightOn.eventOpen).toBe(false);
    const eventOn = toggleEventDrawer(rightOn);
    expect(eventOn).toEqual({ ...ALL_CLOSED, rightOpen: true, eventOpen: true });
    const focused = toggleFocusMode(eventOn);
    expect(focused.focus).toBe(true);
    expect(toggleFocusMode(focused).focus).toBe(false);
    // The input is never mutated.
    expect(ALL_CLOSED.rightOpen).toBe(false);
  });

  it('toggles right-drawer panels independently', () => {
    const injectOn = togglePanel(ALL_CLOSED, 'inject');
    expect(injectOn.panels).toEqual({ inject: true, fault: false, collab: false, chat: false, live: false });
    const collabOn = togglePanel(injectOn, 'collab');
    expect(collabOn.panels).toEqual({ inject: true, fault: false, collab: true, chat: false, live: false });
    expect(togglePanel(collabOn, 'inject').panels.inject).toBe(false);
    expect(ALL_CLOSED.panels.inject).toBe(false);
  });
});

describe('console layout persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('R75 defaults: drawer open with the Agent 对话 panel live; config panels stay collapsed', () => {
    expect(loadConsoleLayout()).toEqual(DEFAULT_CONSOLE_LAYOUT);
    expect(DEFAULT_CONSOLE_LAYOUT).toEqual({
      rightOpen: true,
      eventOpen: false,
      focus: false,
      panels: { inject: false, fault: false, collab: false, chat: true, live: false },
    });
  });

  it('ignores legacy v1/v2 payloads so old users get the R75 defaults', () => {
    window.localStorage.setItem(
      'ac.consoleLayout.v1',
      '{"rightOpen":true,"eventOpen":true,"focus":false}',
    );
    window.localStorage.setItem(
      'ac.consoleLayout.v2',
      '{"rightOpen":false,"eventOpen":false,"focus":false,"panels":{"chat":false}}',
    );
    expect(loadConsoleLayout()).toEqual(DEFAULT_CONSOLE_LAYOUT);
  });

  it('round-trips a saved layout', () => {
    const layout = {
      rightOpen: true,
      eventOpen: true,
      focus: true,
      panels: { inject: true, fault: false, collab: true, chat: false, live: false },
    };
    saveConsoleLayout(layout);
    expect(loadConsoleLayout()).toEqual(layout);
  });

  it('falls back to defaults on a corrupt payload', () => {
    window.localStorage.setItem('ac.consoleLayout.v3', '{not json');
    expect(loadConsoleLayout()).toEqual(DEFAULT_CONSOLE_LAYOUT);
    window.localStorage.setItem('ac.consoleLayout.v3', '"a string"');
    expect(loadConsoleLayout()).toEqual(DEFAULT_CONSOLE_LAYOUT);
  });

  it('fills missing/wrong-typed fields with the CURRENT defaults (single source)', () => {
    window.localStorage.setItem(
      'ac.consoleLayout.v3',
      '{"eventOpen":true,"rightOpen":"yes","panels":{"fault":true,"inject":"no"}}',
    );
    // rightOpen/chat fall to the CURRENT defaults (open/live), not hardcoded
    // falses — the fallback uses DEFAULT_CONSOLE_LAYOUT as its source.
    expect(loadConsoleLayout()).toEqual({
      rightOpen: DEFAULT_CONSOLE_LAYOUT.rightOpen,
      eventOpen: true,
      focus: DEFAULT_CONSOLE_LAYOUT.focus,
      panels: {
        inject: false,
        fault: true,
        collab: DEFAULT_CONSOLE_LAYOUT.panels.collab,
        chat: DEFAULT_CONSOLE_LAYOUT.panels.chat,
        live: DEFAULT_CONSOLE_LAYOUT.panels.live,
      },
    });
  });
});

/**
 * R84-F6: a fresh console entry never starts in focus mode — entering with
 * both drawers hidden dropped the Agent 对话 panel (the world session's
 * primary NL entry) with zero hint, which explorers read as「进入世界仿真」
 * silently doing nothing.
 */
describe('console layout on fresh console entry (R84-F6)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('strips a persisted focus mode and keeps every other choice', () => {
    const focused = {
      rightOpen: false,
      eventOpen: true,
      focus: true,
      panels: { inject: true, fault: false, collab: true, chat: false, live: true },
    };
    saveConsoleLayout(focused);
    expect(loadConsoleLayoutForEntry()).toEqual({ ...focused, focus: false });
  });

  it('persists the stripped payload so storage stops re-arming focus', () => {
    saveConsoleLayout({ ...DEFAULT_CONSOLE_LAYOUT, focus: true });
    loadConsoleLayoutForEntry();
    // A plain load (e.g. a later toggle base) no longer sees focus either.
    expect(loadConsoleLayout().focus).toBe(false);
  });

  it('is a no-op when focus is not persisted', () => {
    saveConsoleLayout(DEFAULT_CONSOLE_LAYOUT);
    expect(loadConsoleLayoutForEntry()).toEqual(DEFAULT_CONSOLE_LAYOUT);
  });

  it('falls back to the unfocused defaults on an empty/corrupt store', () => {
    expect(loadConsoleLayoutForEntry()).toEqual(DEFAULT_CONSOLE_LAYOUT);
    window.localStorage.setItem('ac.consoleLayout.v3', '{not json');
    expect(loadConsoleLayoutForEntry()).toEqual(DEFAULT_CONSOLE_LAYOUT);
  });
});
