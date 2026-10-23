/**
 * Device display names (UX-R2 console polish, PM batch-7 addendum) — the
 * console's DeviceActionSheet used to show raw capability tokens as command
 * buttons (`set-temperature`) and the device state as one bare JSON line.
 *
 * Two pure, i18n-aware helpers (global-i18next convention, same as
 * lib/happeningNow.ts):
 *
 * - `commandDisplay` — a friendly Chinese/English label for common command
 *   tokens (i18n `deviceActions:commandNames.*`), with the ORIGINAL token
 *   kept as the subtitle so the exact command stays discoverable. Unknown
 *   commands render the raw token only (no invented label).
 * - `formatDeviceState` — key-value friendly state rendering
 *   (开 · 亮度 80 · 温度 22.5°C). Known keys get a localized label and unit
 *   formatting (i18n `deviceActions:stateKeys.*`); unknown keys fall back to
 *   the raw `key: value` text, and non-object states to compact JSON.
 */

import i18n from '../i18n/config';
import { compactJson } from './hass';

export interface CommandDisplay {
  /** Localized label, or the raw token when no mapping exists. */
  label: string;
  /** The original command token (rendered as the button's subtitle). */
  raw: string;
  /** false when the label IS the raw token (no known mapping). */
  known: boolean;
}

export function commandDisplay(command: string): CommandDisplay {
  const key = `deviceActions:commandNames.${command}`;
  if (i18n.exists(key)) {
    return { label: i18n.t(key), raw: command, known: true };
  }
  return { label: command, raw: command, known: false };
}

/** State keys whose numeric value carries a unit suffix. */
const UNIT_KEYS: Readonly<Record<string, string>> = {
  temperature: '°C',
  targettemperature: '°C',
  humidity: '%',
  co2: ' ppm',
  brightness: '',
};

/** Keys that are device IDENTITY, not state — the sheet header/zone line
 * already shows them; the state row skips them. */
const SKIP_KEYS = new Set(['zoneid', 'status']);

/** Max state entries before the readout truncates with an ellipsis. */
const MAX_STATE_ENTRIES = 4;

/** Boolean state keys rendered as presence (有/无), not on/off. */
const PRESENCE_KEYS = new Set(['smoke', 'motion', 'leak', 'water', 'presence']);
/** Boolean state keys rendered as lock state (已锁定/未锁定). */
const LOCK_KEYS = new Set(['locked', 'lock']);
/** Boolean state keys rendered as charging state (充电中/未充电). */
const CHARGING_KEYS = new Set(['charging']);

function stateValueText(key: string, value: unknown): string {
  const lower = key.toLowerCase();
  if (typeof value === 'boolean') {
    if (PRESENCE_KEYS.has(lower)) {
      return i18n.t(value ? 'deviceActions:stateValue.present' : 'deviceActions:stateValue.absent');
    }
    if (LOCK_KEYS.has(lower)) {
      return i18n.t(value ? 'deviceActions:stateValue.locked' : 'deviceActions:stateValue.unlocked');
    }
    if (CHARGING_KEYS.has(lower)) {
      return i18n.t(value ? 'deviceActions:stateValue.charging' : 'deviceActions:stateValue.notCharging');
    }
    return i18n.t(value ? 'deviceActions:stateValue.on' : 'deviceActions:stateValue.off');
  }
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'on' || v === 'off') {
      return i18n.t(`deviceActions:stateValue.${v}`);
    }
    if (v === 'locked' || v === 'unlocked') {
      return i18n.t(`deviceActions:stateValue.${v}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    const unit = UNIT_KEYS[lower];
    return unit !== undefined ? `${value}${unit}` : String(value);
  }
  return compactJson(value, 24);
}

/**
 * Friendly key-value state line. Power-style keys (power/state/on) render
 * value-only (「开」/「off」); other keys render「标签 值」. Unknown keys keep
 * the raw key name — nothing is silently dropped.
 */
export function formatDeviceState(state: unknown, maxEntries: number = MAX_STATE_ENTRIES): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return compactJson(state, 96);
  }
  const entries = Object.entries(state as Record<string, unknown>).filter(
    ([key]) => !SKIP_KEYS.has(key.toLowerCase()),
  );
  if (entries.length === 0) return compactJson(state, 96);
  const parts: string[] = [];
  for (const [key, value] of entries.slice(0, maxEntries)) {
    const lower = key.toLowerCase();
    const valueText = stateValueText(key, value);
    if (lower === 'power' || lower === 'state' || lower === 'on') {
      parts.push(valueText);
      continue;
    }
    const labelKey = `deviceActions:stateKeys.${lower}`;
    const label = i18n.exists(labelKey) ? i18n.t(labelKey) : key;
    parts.push(`${label} ${valueText}`);
  }
  if (entries.length > maxEntries) parts.push('…');
  return parts.join(' · ');
}
