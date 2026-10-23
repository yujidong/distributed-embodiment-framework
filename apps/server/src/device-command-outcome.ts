/**
 * Device-command outcome shaping (POST /api/simulations/:id/commands) —
 * the helpers that translate the engine's (double-wrapped) command outcome
 * into the route's HTTP response vocabulary, split out of
 * routes/simulations.ts at the arch-guard size ceiling (same R21-W1 house
 * pattern as device-command-gates.ts).
 *
 * The engine wraps device results twice: the coordinator reports
 * `{success, result:<device ExecutionResult>, executionTime}` and the
 * device ExecutionResult is itself `{success, result?, error?}`.
 */

/**
 * Dig the safety gate's PENDING_CONFIRMATION marker out of a command result.
 * The engine wraps device results twice (coordinator → device), so the
 * HADevice result — whose `result.code` carries the marker — sits at
 * `outcome.result.result`.
 */
export function pendingConfirmationId(outcome: unknown): string | undefined {
  if (typeof outcome !== 'object' || outcome === null) return undefined;
  const deviceResult = (outcome as { result?: unknown }).result;
  if (typeof deviceResult !== 'object' || deviceResult === null) return undefined;
  const payload = (deviceResult as { result?: unknown }).result;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { code, pendingId } = payload as { code?: unknown; pendingId?: unknown };
  return code === 'PENDING_CONFIRMATION' && typeof pendingId === 'string' ? pendingId : undefined;
}

/**
 * S3 (breaking response contract): flatten the engine's double-wrapped
 * command SUCCESS to a single layer. The coordinator reports
 * `{success:true, result:<device ExecutionResult>, executionTime}` and the
 * device ExecutionResult is itself `{success:true, result:<payload>}` — the
 * HTTP body now spreads the INNER object to the top level, keeping exactly
 * one `success: true` (symmetric with the single-layer failure envelope).
 * A non-object inner result (defensive) keeps a plain `result` field.
 */
export function flattenCommandSuccess(outcome: unknown): Record<string, unknown> {
  if (typeof outcome !== 'object' || outcome === null) return { success: true };
  const { result: inner, ...outer } = outcome as { result?: unknown } & Record<string, unknown>;
  if (typeof inner === 'object' && inner !== null) {
    return { ...outer, ...(inner as Record<string, unknown>) };
  }
  return { ...outer, ...(inner !== undefined ? { result: inner } : {}) };
}

/**
 * Flatten the engine's double-wrapped device failure (Fix-1): the coordinator
 * reports `{success:true, result:<device ExecutionResult>}` even when the
 * DEVICE failed — returns the device-level `{error, code?}` in that case,
 * null when the command genuinely succeeded.
 */
export function unwrapDeviceFailure(outcome: unknown): { error: string; code?: string } | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const deviceResult = (outcome as { result?: unknown }).result;
  if (typeof deviceResult !== 'object' || deviceResult === null) return null;
  const failure = deviceResult as { success?: unknown; error?: unknown; result?: unknown };
  if (failure.success !== false || typeof failure.error !== 'string') return null;
  const payload = failure.result;
  const code =
    typeof payload === 'object' && payload !== null
      ? (payload as { code?: unknown }).code
      : undefined;
  return { error: failure.error, ...(typeof code === 'string' ? { code } : {}) };
}
