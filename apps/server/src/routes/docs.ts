/**
 * API-contract routes — serve the hand-curated OpenAPI document
 *
 * - `GET /api/openapi.yaml`  the raw OpenAPI 3.1 document (text/yaml). This is
 *   THE machine-readable contract for programmatic consumers (AI agents); it
 *   is hand-maintained against the route code, not generated.
 * - `GET /api/docs`          a zero-dependency HTML page: download link plus
 *   the endpoint list grouped by tag, rendered server-side from the same
 *   YAML file (so the two never drift apart).
 *
 * Both routes are public (a contract is useless behind auth).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse as parseYaml } from 'yaml';

import type { UiLocale } from '@active-collaboration/shared';
import { t } from '../i18n/index.js';

/** apps/server/openapi.yaml — `../../` from both src/routes and dist/routes. */
const OPENAPI_FILE = resolve(__dirname, '..', '..', 'openapi.yaml');

interface OpenApiOperation {
  summary?: string;
  tags?: string[];
}

interface OpenApiDocument {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** Read + parse the spec once per process (it only changes on deploy). */
function loadSpec(): { raw: string; doc: OpenApiDocument } {
  const raw = readFileSync(OPENAPI_FILE, 'utf-8');
  return { raw, doc: parseYaml(raw) as OpenApiDocument };
}

let cached: { raw: string; doc: OpenApiDocument } | null = null;
function spec(): { raw: string; doc: OpenApiDocument } {
  cached ??= loadSpec();
  return cached;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderDocsPage(doc: OpenApiDocument, locale: UiLocale): string {
  // tag name → description, in document order; operations without a tag land
  // in a catch-all group at the end.
  const tagOrder: string[] = [];
  const grouped = new Map<string, Array<{ method: string; path: string; summary: string }>>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (typeof operation !== 'object' || operation === null) continue;
      const op = operation as OpenApiOperation;
      const tag = op.tags?.[0] ?? 'other';
      if (!grouped.has(tag)) {
        grouped.set(tag, []);
        tagOrder.push(tag);
      }
      grouped.get(tag)!.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
      });
    }
  }

  const sections = tagOrder
    .map(tag => {
      const rows = grouped
        .get(tag)!
        .map(
          ({ method, path, summary }) =>
            `<tr><td class="m m-${method.toLowerCase()}">${method}</td>` +
            `<td><code>${escapeHtml(path)}</code></td>` +
            `<td>${escapeHtml(summary)}</td></tr>`,
        )
        .join('\n');
      return `<h2>${escapeHtml(tag)}</h2>\n<table>${rows}</table>`;
    })
    .join('\n');

  const title = escapeHtml(doc.info?.title ?? 'API');
  const version = escapeHtml(doc.info?.version ?? '');
  const htmlLang = t(locale, 'chrome.docs.htmlLang');
  const intro = t(locale, 'chrome.docs.introParagraph');
  return `<!doctype html>
<html lang="${escapeHtml(htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — API docs</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.4rem; } h2 { margin-top: 1.8rem; font-size: 1.05rem; text-transform: capitalize; }
  table { border-collapse: collapse; width: 100%; }
  td { border-bottom: 1px solid #e5e7eb; padding: 4px 10px 4px 0; font-size: 0.9rem; vertical-align: top; }
  .m { font-family: ui-monospace, monospace; font-weight: 700; width: 4.5rem; }
  .m-get { color: #0a7ea4; } .m-post { color: #1a7f37; } .m-patch { color: #9a6700; }
  .m-put { color: #9a6700; } .m-delete { color: #cf222e; }
  code { font-family: ui-monospace, monospace; }
  .note { color: #57606a; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${title} <span class="note">v${version}</span></h1>
<p>${intro}</p>
${sections}
</body>
</html>
`;
}

export function registerDocsRoutes(app: FastifyInstance): void {
  app.get('/api/openapi.yaml', async (_request, reply) => sendOpenApiYaml(reply));

  app.get('/api/docs', async (request, reply) => sendDocsPage(request, reply));
}

// ============================================================================
// R1 (B1-7 / P-02) contract-entry aliases — the SAME content at the root
// ============================================================================

/**
 * The doc lane told users to fetch `/openapi.yaml`, but only
 * `/api/openapi.yaml` existed — the root path fell into the SPA fallback and
 * returned 200 HTML. The root names are now served (from the SAME cached
 * spec, so they cannot drift) as content, not redirects: `curl
 * http://host/openapi.yaml` must yield the YAML itself. These are REAL
 * files in the user's mind, not client-side views — the not-found handler
 * in server.ts dispatches them here before any SPA fallback, and treats
 * other file-looking misses as honest 404s.
 */
export function sendOpenApiYaml(reply: FastifyReply): FastifyReply {
  return reply.header('content-type', 'text/yaml; charset=utf-8').send(spec().raw);
}

/** The contract as JSON — the same document, machine-translated once. */
export function sendOpenApiJson(reply: FastifyReply): FastifyReply {
  return reply.header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(spec().doc));
}

/** The grouped docs page (same render as /api/docs). */
export function sendDocsPage(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.header('content-type', 'text/html; charset=utf-8').send(renderDocsPage(spec().doc, request.locale));
}
