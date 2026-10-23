/**
 * Server i18n entry — exports the `t()` resolver, the Accept-Language parser,
 * and the request-scoped locale helper.
 *
 * `t()` looks up dot-namespaced keys (`chrome.viewerNotice`) in the message
 * catalog and interpolates `{name}` placeholders. It reads the locale from
 * the AsyncLocalStorage when no locale is passed explicitly — so deep throw
 * sites can simply call `t('chrome.quota.exhausted', { quota, limit })`.
 */

import { normalizeLocale, type UiLocale } from '@active-collaboration/shared';

import { lookupMessage } from './messages.js';
export { MESSAGES, type MessageCatalog, type Message } from './messages.js';
export { DEFAULT_LOCALE } from './request-locale.js';

/**
 * Resolve a message. The locale MUST be passed explicitly — there is no
 * AsyncLocalStorage fallback by design. Route handlers read `request.locale`
 * and forward it; background tasks capture the locale at scheduling time.
 */
export function t(
  locale: UiLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  return lookupMessage(locale, key, params ?? {});
}

/**
 * Parse an HTTP `Accept-Language` header value into a `UiLocale`. Picks the
 * highest-quality (q-max) tag the catalog understands, defaulting to `zh-CN`.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc9110#field.accept-language
 * Examples handled:
 *   'en-US,en;q=0.9,zh-CN;q=0.8'  → 'en-US' (en wins on q)
 *   'zh-CN,zh;q=0.9,en;q=0.8'     → 'zh-CN' (zh wins on q)
 *   '*'                          → 'zh-CN' (default)
 *   '' / undefined                → 'zh-CN'
 */
export function acceptLanguageToLocale(header: string | undefined): UiLocale {
  if (!header) return 'zh-CN';
  const entries = header
    .split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';').map(s => s.trim());
      const qParam = params.find(p => p.startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 1 };
    })
    .filter(e => e.tag.length > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of entries) {
    if (tag === '*') continue;
    const locale = normalizeLocale(tag);
    // `normalizeLocale` collapses everything unknown to zh-CN; only return
    // when the tag actually mapped to a non-default locale, so a later
    // 'zh-CN' entry can't override an earlier 'en'.
    if (locale !== 'zh-CN' || tag.toLowerCase().startsWith('zh')) return locale;
  }
  return 'zh-CN';
}

/** Resolve a `?lang=` query-string value (WS upgrade) into a `UiLocale`. */
export function queryLangToLocale(raw: string | undefined): UiLocale {
  return normalizeLocale(raw);
}
