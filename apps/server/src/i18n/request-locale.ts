/**
 * Reserved for future AsyncLocalStorage-based locale propagation.
 *
 * The current i18n design uses explicit `request.locale` reads (in route
 * handlers) and explicit locale capture at scheduling time (for background
 * tasks like proposal-service's LLM review). If a future deep-throw site
 * can't easily thread the locale through, install ALS here and re-export
 * `getCurrentLocale` / `runWithLocale`.
 */

export const DEFAULT_LOCALE = 'zh-CN' as const;
