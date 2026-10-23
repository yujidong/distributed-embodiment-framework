/**
 * Locale helpers — web-side wrapper. The web app reads runtime strings from
 * i18next (`useTranslation` / `t()`) for UI chrome and from the wire DTO
 * (`localizedText()`) for bilingual content authored in scenarios / seed
 * data.
 *
 * Implementation note: the canonical `LocalizedText` type + resolver live
 * in `packages/shared/src/i18n.ts` and the server consumes them at runtime
 * through the CJS build. The web app (Vite/ESM) cannot reliably resolve the
 * shared package's CJS `__exportStar` re-exports at bundle time, so the
 * small resolver is duplicated here. The type-only import from shared keeps
 * the contract honest; if the resolver ever diverges, the type system still
 * catches the drift. Re-unify when shared ships an ESM build.
 */

import type { LocalizedText, UiLocale } from '@active-collaboration/shared';

export type { LocalizedText, UiLocale };

import i18n from '../i18n/config';

/** Read the active UI locale from i18next (falls back to zh-CN). */
export function currentLocale(): UiLocale {
  const lang = i18n.language;
  if (!lang) return 'zh-CN';
  return lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** True when the active locale is any zh* variant. */
export function prefersChinese(): boolean {
  return currentLocale() === 'zh-CN';
}

function trimNonEmpty(s: string | undefined | null): string | undefined {
  if (s === undefined || s === null) return undefined;
  const trimmed = s.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Pick the display string from a localized value. Accepts `LocalizedText`
 * objects (from Phase 3 scenarios / future bilingual wire data) and plain
 * strings (legacy pass-through). Returns `undefined` when the value is empty
 * or missing so callers can `??` it.
 *
 * Fallback chain when the picked side is empty: the other side → `zh` →
 * `en` → undefined.
 */
export function localizedText(value: LocalizedText | string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  const locale = currentLocale();
  const want = locale === 'zh-CN' ? 'zh' : 'en';
  const other = locale === 'zh-CN' ? 'en' : 'zh';
  const picked =
    trimNonEmpty(value[want]) ??
    trimNonEmpty(value[other]) ??
    trimNonEmpty(value.zh) ??
    trimNonEmpty(value.en);
  return picked;
}
