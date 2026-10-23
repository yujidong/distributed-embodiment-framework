/**
 * API client — thin wrapper around native fetch.
 *
 * Maps the platform's `{error:{code,message,issues?}}` wire shape onto
 * CliError with the right exit code (401→3, 404→4, everything else→1) and
 * connection failures onto "server unreachable at …" (exit 1).
 */

import WebSocket from 'ws';

import { EXIT, CliError } from './errors.js';

export interface ApiErrorShape {
  error?: { code?: string; message?: string; issues?: string[] };
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private token?: string,
    /**
     * T125 (R19-u1 F3): the UI locale sent as `Accept-Language` so every
     * server-side localized teaching (what-if parse refusals, governance
     * notes, notification titles) answers in the caller's `--lang` instead
     * of always the server's zh-CN default. Undefined = header omitted.
     */
    private locale?: string,
  ) {}

  /** The localization headers every request carries. */
  private localeHeaders(): Record<string, string> {
    return this.locale ? { 'accept-language': this.locale } : {};
  }

  /** Client with a different token (used right after login). */
  withToken(token: string | undefined): ApiClient {
    return new ApiClient(this.baseUrl, token, this.locale);
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  /**
   * GET a non-JSON body verbatim (Fix-22: the NDJSON training export).
   * Same error mapping as request().
   */
  async getText(path: string): Promise<string> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.localeHeaders(),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      });
    } catch (error) {
      const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
      const detail = cause ? ` (${cause})` : '';
      throw new CliError(`server unreachable at ${this.baseUrl}${detail}`, EXIT.ERROR);
    }
    const text = await response.text();
    if (!response.ok) {
      let shape: ApiErrorShape = {};
      try {
        shape = JSON.parse(text) as ApiErrorShape;
      } catch {
        // not a JSON error body — fall through to the generic message
      }
      const code = shape.error?.code ?? `HTTP_${response.status}`;
      const message = shape.error?.message ?? `GET ${path} failed with HTTP ${response.status}`;
      const exitCode =
        response.status === 401 ? EXIT.AUTH : response.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR;
      // T58: the raw body rides along for the --json stdout carrier.
      throw new CliError(`${message} [${code}]`, exitCode, shape.error?.issues, Object.keys(shape).length > 0 ? shape : undefined);
    }
    return text;
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  put(path: string, body: unknown): Promise<unknown> {
    return this.request('PUT', path, body);
  }

  patch(path: string, body: unknown): Promise<unknown> {
    return this.request('PATCH', path, body);
  }

  delete(path: string): Promise<unknown> {
    return this.request('DELETE', path);
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...this.localeHeaders(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
      const detail = cause ? ` (${cause})` : '';
      throw new CliError(`server unreachable at ${this.baseUrl}${detail}`, EXIT.ERROR);
    }

    if (response.status === 204) return undefined;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const shape = (parsed ?? {}) as ApiErrorShape;
      const code = shape.error?.code ?? `HTTP_${response.status}`;
      const message = shape.error?.message ?? `${method} ${path} failed with HTTP ${response.status}`;
      const exitCode =
        response.status === 401 ? EXIT.AUTH : response.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR;
      // T58: the raw body rides along for the --json stdout carrier.
      throw new CliError(`${message} [${code}]`, exitCode, shape.error?.issues, Object.keys(shape).length > 0 ? shape : undefined);
    }
    return parsed;
  }

  /**
   * Open a WebSocket to a server path (stream consumption, Fix-11 Phase 2).
   * http(s) → ws(s); the stored token goes in the Authorization header.
   */
  openWebSocket(path: string): WebSocket {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${path.startsWith('/') ? path : `/${path}`}`;
    return new WebSocket(url, {
      ...this.localeHeaders(),
      ...(this.token ? { headers: { authorization: `Bearer ${this.token}` } } : {}),
    });
  }
}

/** Require a stored token; throws the exit-3 "not logged in" error otherwise. */
export function requireToken(token: string | undefined): string {
  if (!token) {
    throw new CliError('not logged in — run `eaf auth login` first', EXIT.AUTH);
  }
  return token;
}
