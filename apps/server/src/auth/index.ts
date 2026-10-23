/**
 * Authentication plumbing — JWT (Bearer header or httpOnly cookie)
 *
 * Registers `@fastify/cookie` + `@fastify/jwt` and installs two route hooks:
 *
 * - `app.authenticate` — rejects with 401 UNAUTHORIZED unless a valid token
 *   identifies an existing user; attaches `request.user`. T-062: the 401
 *   body carries a machine-readable `error.reason` (missing | bad_scheme |
 *   malformed | expired | stale_version | unknown_user) and a teaching
 *   message per reason, plus a RFC 6750 `WWW-Authenticate` response header,
 *   so the next "agent token 401s but curl works" report is attributable
 *   from the response alone.
 * - `app.optionalAuth` — attaches `request.user` when a valid token is
 *   present; never rejects for a MISSING or time-stale credential (logged-
 *   out browsers keep reading public routes). R13 (IB-F06): a credential
 *   that IS present but broken for sender-side reasons (bad_scheme /
 *   malformed / wrong_key) rejects with the same attributable 401 as
 *   `authenticate` — silently ignoring it made public endpoints mask token
 *   diagnostics. Used on public reads (environment detail) and the LEGACY
 *   /api/scenarios* and /api/simulations* routes, which stay open during
 *   the P2a transition so the current (credential-less) frontend keeps
 *   working.
 *
 * Tokens are accepted from either the `Authorization: Bearer <jwt>` header
 * or the httpOnly `eaf_token` cookie set at login (browser clients). The
 * Bearer scheme keyword is matched case-insensitively (RFC 6750) and the
 * token is unquoted when a client wrapped it in literal quotes — both are
 * recurring LLM-agent copy artifacts (T-062 evidence: round11 server.log).
 *
 * P4-4: tokens carry the issuer's `token_version` as the `tv` claim and only
 * authenticate while it matches the user's current row value — logout-all
 * (routes/auth.ts) bumps the version to invalidate every outstanding token.
 */

import { createHash } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import fastifyJwt, { type FastifyJWT } from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../errors.js';
import type { UserStore } from '../db/user-store.js';
import { ApiKeyStore, API_KEY_PREFIX } from '../db/api-key-store.js';

/** Cookie carrying the JWT for browser clients. */
export const AUTH_COOKIE = 'eaf_token';

/** Identity attached to authenticated requests. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Why a presented credential failed to authenticate (T-062). Surfaced as
 * `error.reason` on 401s and in the `WWW-Authenticate` header — every value
 * names a DIFFERENT writer (client vs server vs time), which is what makes
 * the next occurrence attributable.
 */
export type AuthFailureReason =
  | 'missing' // no Authorization header AND no cookie — client never sent one
  | 'bad_scheme' // Authorization present but not "Bearer <token>"
  | 'malformed' // not a parsable JWT (truncated / mangled in copy-paste)
  | 'wrong_key' // well-formed JWT but signed by a different secret (server rotation / wrong base URL)
  | 'expired' // valid signature, past its 7d exp
  | 'stale_version' // valid signature but tv mismatch — a logout-all happened
  | 'unknown_user'; // signing user no longer exists (fresh DB / deleted user)

/** All 401 reasons our middleware can emit (for tests / openapi docs). */
export const AUTH_FAILURE_REASONS: readonly AuthFailureReason[] = [
  'missing',
  'bad_scheme',
  'malformed',
  'wrong_key',
  'expired',
  'stale_version',
  'unknown_user',
];

/** Teaching message per failure reason — says what to DO next. */
export const AUTH_FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  missing:
    'Authentication required: send "Authorization: Bearer <token>" (from POST /api/auth/login) or the eaf_token cookie',
  bad_scheme:
    'Authentication header must use the Bearer scheme: "Authorization: Bearer <token>" (scheme keyword is case-insensitive; do not prefix with Basic/Token)',
  malformed:
    'Bearer token is malformed (truncated or mangled in copy-paste). Re-login via POST /api/auth/login and pass the token byte-for-byte',
  wrong_key:
    'Bearer token is well-formed but signed by a DIFFERENT server (secret rotation, or you are pointing at another instance/port). Re-login against the server you are calling',
  expired:
    'Bearer token has expired (7d at issue). Re-login via POST /api/auth/login for a fresh token',
  stale_version:
    'Bearer token was revoked by a logout-all (token_version bumped). Re-login via POST /api/auth/login for a fresh token',
  unknown_user:
    'Bearer token is signed correctly but its user no longer exists (deleted account or a fresh database). Re-register and re-login',
};

/** RFC 6750 error code per reason, for the WWW-Authenticate header. */
function wwwAuthenticateError(reason: AuthFailureReason): string {
  return reason === 'missing' ? 'error="invalid_request"' : 'error="invalid_token"';
}

/** Short stable fingerprint of a token so logs attribute bursts without leaking credentials. */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * Expected base64url signature length per JWT algorithm (R13 CB-F02). Our
 * tokens are always HS256 (43 chars / 32 bytes); the other entries keep the
 * rule honest if the signer ever widens.
 */
const EXPECTED_SIGNATURE_CHARS: Record<string, number> = {
  HS256: 43,
  HS384: 64,
  HS512: 86,
};

/**
 * True when the token's signature segment length does NOT match its declared
 * algorithm — the signature of a TRUNCATED token (cut inside the signature,
 * header+payload intact). This is the deterministic truncation probe behind
 * the malformed-vs-wrong_key classification (see resolveUser).
 */
function signatureLengthMismatch(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false; // not even JWT-shaped; parse error handles it
  let alg: string | undefined;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string };
    alg = typeof header.alg === 'string' ? header.alg : undefined;
  } catch {
    return false; // undecodable header → malformed via the parse path
  }
  const expected = alg !== undefined ? EXPECTED_SIGNATURE_CHARS[alg] : undefined;
  if (expected === undefined) return false; // unknown alg → keep fast-jwt's verdict
  return parts[2].length !== expected;
}

interface TokenPayload {
  sub: string;
  email: string;
  /**
   * Token version at issue time (P4-4). Must match the user's current
   * users.token_version — POST /api/auth/logout-all bumps it, invalidating
   * every previously issued token. Tokens minted before P4-4 carry no tv
   * and stop authenticating once schema v8 is applied.
   */
  tv?: number;
}

// `@fastify/jwt` owns `request.user` (it decorates the request itself).
// Typing FastifyJWT['user'] as `AuthUser | null` makes request.user our
// resolved identity: null until authenticate/optionalAuth attaches one.
// We never call request.jwtVerify(), so the plugin never overwrites it.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: AuthUser | null;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  jwtSecret: string;
  userStore: UserStore;
  /** R55: external-caller credentials (eak_…) resolve to their owning user. */
  apiKeyStore?: ApiKeyStore;
}

export async function registerAuth(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, { secret: options.jwtSecret });

  // NB: no decorateRequest('user') — @fastify/jwt already did that (null default).

  /** RFC 6750: auth-scheme is case-insensitive; tolerate extra spaces + literal quote-wrapping. */
  const extractBearerToken = (header: string): { token: string } | { reason: AuthFailureReason } => {
    const match = /^bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return { reason: 'bad_scheme' };
    let token = match[1].trim();
    if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
      token = token.slice(1, -1);
    }
    if (!token) return { reason: 'bad_scheme' };
    return { token };
  };

  const resolveUser = (
    request: FastifyRequest,
  ): { user: AuthUser; reason?: undefined } | { user: null; reason: AuthFailureReason; tokenFp?: string } => {
    let token: string | undefined;
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.length > 0) {
      const parsed = extractBearerToken(header);
      if ('reason' in parsed) return { user: null, reason: parsed.reason };
      token = parsed.token;
    } else if (typeof request.headers['x-api-key'] === 'string' && request.headers['x-api-key'].length > 0) {
      token = request.headers['x-api-key'];
    } else {
      token = request.cookies[AUTH_COOKIE];
    }
    if (!token) return { user: null, reason: 'missing' };
    // R55: an API key is an alternative BEARER/X-API-Key credential for the
    // outside world — it resolves to its owning user (permissions inherit)
    // and stashes its scope for routes that enforce one.
    if (token.startsWith(API_KEY_PREFIX)) {
      const store = options.apiKeyStore;
      if (store === undefined) return { user: null, reason: 'missing' };
      const keyRow = store.verifyKey(token);
      if (keyRow === null) return { user: null, reason: 'wrong_key', tokenFp: tokenFingerprint(token) };
      const keyUser = options.userStore.findById(keyRow.user_id);
      if (!keyUser) return { user: null, reason: 'unknown_user', tokenFp: tokenFingerprint(token) };
      (request as FastifyRequest & { apiKeyScope?: { envId: string; serviceId: string | null } }).apiKeyScope = {
        envId: keyRow.env_id,
        serviceId: keyRow.service_id,
      };
      return { user: { id: keyUser.id, email: keyUser.email, displayName: keyUser.display_name } };
    }
    let payload: FastifyJWT['payload'];
    try {
      payload = app.jwt.verify<TokenPayload>(token);
    } catch (err) {
      // fast-jwt error codes separate time (expired) from shape (malformed)
      // from key provenance (invalid signature = a different server signed it).
      //
      // R13 (CB-F02) — deterministic truncated-token rule, documented:
      // a token cut INSIDE the payload fails JWT shape parsing → malformed
      // (IB's 40-char truncation). A token cut INSIDE the signature leaves
      // a syntactically fine header.payload but a signature segment whose
      // LENGTH no longer matches the algorithm (HS256 ⇒ 43 base64url chars);
      // fast-jwt reports FAST_JWT_INVALID_SIGNATURE, which used to classify
      // as wrong_key (CB's sighting) and blame secret rotation for what is
      // a copy-paste truncation. Rule: signature-LENGTH mismatch ⇒ malformed;
      // only a FULL-LENGTH signature that fails verification is wrong_key.
      const code = (err as { code?: string }).code;
      let reason: AuthFailureReason =
        code === 'FAST_JWT_EXPIRED' ? 'expired' : code === 'FAST_JWT_INVALID_SIGNATURE' ? 'wrong_key' : 'malformed';
      if (code === 'FAST_JWT_INVALID_SIGNATURE' && signatureLengthMismatch(token)) {
        reason = 'malformed';
      }
      return { user: null, reason, tokenFp: tokenFingerprint(token) };
    }
    const row = options.userStore.findById(payload.sub);
    if (!row) return { user: null, reason: 'unknown_user', tokenFp: tokenFingerprint(token) };
    // P4-4: the token must carry the user's CURRENT token_version — a stale
    // tv (or none, for pre-v8 tokens) means a logout-all happened since issue.
    if (payload.tv === undefined || payload.tv !== row.token_version) {
      return { user: null, reason: 'stale_version', tokenFp: tokenFingerprint(token) };
    }
    return { user: { id: row.id, email: row.email, displayName: row.display_name } };
  };

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const resolved = resolveUser(request);
    if (!resolved.user) {
      const reason = resolved.reason;
      // T-062: one log line per rejected credential so bursts are attributable
      // from server.log alone (reason + fingerprint, never the token itself).
      request.log.warn(
        { reason, tokenFp: resolved.tokenFp, url: request.url },
        'auth rejected (token fingerprint present = a credential WAS sent)',
      );
      const message = AUTH_FAILURE_MESSAGES[reason];
      reply.header(
        'WWW-Authenticate',
        `Bearer realm="eaf", ${wwwAuthenticateError(reason)}, error_description="${reason}"`,
      );
      throw new ApiError(401, 'UNAUTHORIZED', message, undefined, { reason });
    }
    request.user = resolved.user;
  });

  app.decorate('optionalAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    // R13 (IB-F06): a PRESENT credential that fails for SENDER-side reasons
    // (bad_scheme | malformed | wrong_key) now rejects even on public-read
    // routes — swallowing it made every public endpoint silently validate
    // nothing, so a truncated-token probe against a public env false-passed
    // with 200 (the round-13 InfraBuilder's auth test landed exactly there).
    // Time/state reasons (expired | stale_version | unknown_user) and a
    // missing credential still downgrade to anonymous: a stale cookie must
    // not lock a logged-out browser out of public reads.
    const resolved = resolveUser(request);
    if (resolved.user !== null) {
      request.user = resolved.user;
      return;
    }
    const reason = resolved.reason;
    if (reason === 'bad_scheme' || reason === 'malformed' || reason === 'wrong_key') {
      request.log.warn(
        { reason, tokenFp: resolved.tokenFp, url: request.url },
        'auth rejected on optional-auth route (credential was sent and is broken)',
      );
      reply.header(
        'WWW-Authenticate',
        `Bearer realm="eaf", ${wwwAuthenticateError(reason)}, error_description="${reason}"`,
      );
      throw new ApiError(401, 'UNAUTHORIZED', AUTH_FAILURE_MESSAGES[reason], undefined, { reason });
    }
    request.user = null;
  });
}
