/**
 * R78 病灶 B — quota visibility, pure layer.
 *
 * The server already 429s loudly (QUOTA_EXCEEDED with current/limit) and
 * /api/me/quotas introspects; the gap was the CREATION surfaces never
 * showing usage — users hit 429 only at submit (the R77 F4 finding). This
 * module turns (current, limit) into the badge/disabled state every
 * creation button shares.
 */

export interface QuotaState {
  /** `${current}/${limit}` for display. */
  label: string;
  /** True at 100% — creation must be blocked up front with the reason. */
  exhausted: boolean;
  /** >=90% — the badge takes the warning tone. */
  nearLimit: boolean;
  /** The disable-with-reason title for the gated button. */
  title: string | null;
}

export function quotaState(
  kind: string,
  current: number,
  limit: number | undefined,
): QuotaState {
  if (limit === undefined) {
    // Limits unknown (quota endpoint failed / anonymous) — never block on
    // missing data; the server 429 remains the final guarantee.
    return { label: `${current}`, exhausted: false, nearLimit: false, title: null };
  }
  const exhausted = current >= limit;
  const nearLimit = !exhausted && limit > 0 && current / limit >= 0.9;
  return {
    label: `${current}/${limit}`,
    exhausted,
    nearLimit,
    title: exhausted
      ? `${kind} 配额已满（${current}/${limit}）——清理不再使用的对象，或联系部署方调整配额`
      : null,
  };
}
