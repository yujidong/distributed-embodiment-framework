/**
 * R2-UX-14: HH:MM ↔ sec-of-day helpers for the flow trigger's time-of-day
 * fields (atTimeOfDaySec / activeWindowSimSec) — the canvas used to expose
 * raw second counts; these back the `<input type="time">` editors. Pure
 * functions so vitest can pin the round-trip.
 */

/** Sec-of-day → `HH:MM` (clamped into [0, 86400), sub-minute precision dropped). */
export function secOfDayToHhmm(sec: number): string {
  const clamped = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `HH:MM` → sec-of-day; undefined when the text is not a valid clock time. */
export function hhmmToSecOfDay(raw: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (match === null) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return undefined;
  return h * 3600 + m * 60;
}
