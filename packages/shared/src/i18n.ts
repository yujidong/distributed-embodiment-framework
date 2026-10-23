/**
 * Internationalization primitives — canonical `LocalizedText` type and a pure
 * locale resolver. No `navigator` / DOM dependencies: this lives in the leaf
 * `shared` package so the scenario loader (`core`), the server response
 * shapers, the web UI, and the CLI all import from one place.
 *
 * Future languages (ja, ko, …) add a key to `LocalizedText` without changing
 * the type — `localizedText()` falls back to `zh` then `en` when the active
 * locale has no entry, so half-translated content still renders.
 */

/**
 * A string that exists in at least the two flagship languages. The index
 * signature keeps the door open for additional languages without a schema
 * migration: `LocalizedText` is structurally `{ zh, en, …? }`.
 */
export interface LocalizedText {
  zh: string;
  en: string;
  /** Future languages (ja, ko, …). Unknown to current UI resolvers. */
  [extra: string]: string;
}

/** Supported UI locales (drives resource catalogs, switcher, server `t()`). */
export type UiLocale = 'zh-CN' | 'en-US';

/**
 * Narrow an arbitrary string to a `UiLocale`. Defaults to `zh-CN` (the
 * project's content source-of-truth) for anything unrecognized, including
 * future locales we have no resource bundle for yet.
 */
export function normalizeLocale(raw: string | undefined | null): UiLocale {
  if (!raw) return 'zh-CN';
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  // Future ja / ko bundles: uncomment once resource catalogs land.
  // if (lower.startsWith('ja')) return 'ja-JP';
  // if (lower.startsWith('ko')) return 'ko-KR';
  return 'zh-CN';
}

/**
 * Pick the display string from a localized value. Pure — no global state.
 *
 * Accepts either a `LocalizedText` object or a plain `string` (legacy
 * scenario files and seed data); plain strings pass through unchanged so
 * the migration to `{zh, en}` objects can happen incrementally.
 *
 * Fallback chain when the picked side is empty/missing: the other side →
 * `zh` → `en` → `fallback` → `''`.
 */
export function localizedText(
  value: LocalizedText | string | undefined | null,
  locale: UiLocale,
  fallback?: string,
): string {
  if (value === undefined || value === null) return fallback ?? '';
  if (typeof value === 'string') return value;
  const want = locale === 'zh-CN' ? 'zh' : 'en';
  const other = locale === 'zh-CN' ? 'en' : 'zh';
  const picked =
    trimNonEmpty(value[want]) ??
    trimNonEmpty(value[other]) ??
    trimNonEmpty(value.zh) ??
    trimNonEmpty(value.en);
  return picked ?? fallback ?? '';
}

function trimNonEmpty(s: string | undefined | null): string | undefined {
  if (s === undefined || s === null) return undefined;
  const trimmed = s.trim();
  return trimmed === '' ? undefined : trimmed;
}
