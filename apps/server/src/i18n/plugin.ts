/**
 * Fastify i18n plugin — runs once per request to decorate `request.locale`.
 *
 * Resolution order:
 *   1. `?lang=` query parameter (covers WS upgrade requests, which can't
 *      send headers after the handshake; also lets users share a localized
 *      URL).
 *   2. `Accept-Language` header.
 *   3. Default `zh-CN` (preserves pre-i18n behavior for the content, which
 *      is zh-source-of-truth).
 *
 * Registered early in `buildServer`, after cookie/jwt and rate-limit, before
 * any route that reads `request.locale`.
 *
 * Deep throw sites and background tasks that don't see `request` capture the
 * locale explicitly at scheduling time — see `proposal-service.ts` for the
 * pattern. AsyncLocalStorage is intentionally NOT installed process-wide;
 * explicit parameter passing is more auditable and doesn't risk leaking the
 * locale across unrelated concurrent requests.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { UiLocale } from '@active-collaboration/shared';

import { acceptLanguageToLocale, queryLangToLocale } from './index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved user locale for this request. Default: zh-CN. */
    locale: UiLocale;
  }
}

export async function registerI18n(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const fromQuery =
      typeof request.query === 'object' &&
      request.query !== null &&
      'lang' in request.query &&
      typeof request.query.lang === 'string'
        ? queryLangToLocale(request.query.lang)
        : undefined;
    const fromHeader = acceptLanguageToLocale(request.headers['accept-language']);
    request.locale = fromQuery ?? fromHeader;
  });
}
