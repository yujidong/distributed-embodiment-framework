/**
 * API Errors — consistent error wire shape for the whole service
 *
 * Every non-2xx response the API produces has the body
 * `{ error: { code, message, issues?, ...details? } }`. Handlers throw
 * `ApiError`; the error handler installed in `server.ts` serializes it.
 * `issues` carries per-item detail when a failure has several causes
 * (scenario validation being the primary case); `details` carries extra
 * machine-readable fields for a specific code (P4-4: retryAfterSec,
 * quota/limit/current).
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: string[],
    /**
     * Extra machine-readable fields merged into the error object (P4-4) —
     * e.g. `{ retryAfterSec }` on RATE_LIMITED or `{ quota, limit, current }`
     * on QUOTA_EXCEEDED. Keep keys stable: clients branch on them.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Build the standard error response body. */
export function errorBody(
  code: string,
  message: string,
  issues?: string[],
  details?: Record<string, unknown>,
): { error: { code: string; message: string; issues?: string[] } & Record<string, unknown> } {
  return {
    error: {
      code,
      message,
      ...(issues !== undefined ? { issues } : {}),
      ...(details !== undefined ? details : {}),
    },
  };
}
