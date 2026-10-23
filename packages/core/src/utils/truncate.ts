/**
 * Storage cap for stored LLM text (T-106). `reasoning` / `rawResponse`
 * fields are embedded in trajectory JSONL, snapshot decisions and the WS
 * snapshot push — a 5MB model answer must never reach storage at full
 * size (cap at write time, the standing lesson). 16KB keeps the readable
 * head of any sane explanation; full text belongs in debug logging only.
 */
export const STORED_LLM_TEXT_CAP = 16 * 1024;

/**
 * Truncate oversized LLM text for STORAGE with an explicit marker
 * (`…[truncated N of M chars]` — N chars dropped of M total). Inputs at or
 * under the cap are returned byte-identical (no marker).
 */
export function truncateForStorage(text: string, cap?: number): string;
export function truncateForStorage(text: string | undefined, cap?: number): string | undefined;
export function truncateForStorage(
  text: string | undefined,
  cap: number = STORED_LLM_TEXT_CAP,
): string | undefined {
  if (text === undefined || text.length <= cap) return text;
  return `${text.slice(0, cap)}…[truncated ${text.length - cap} of ${text.length} chars]`;
}
