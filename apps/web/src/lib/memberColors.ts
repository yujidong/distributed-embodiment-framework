/**
 * Member colors — stable per-user color assignment for ownership visuals.
 *
 * Device dots (and agent markers) take their border color from their owner's
 * color; the 成员 tab renders the legend. The color is a pure function of the
 * user id (FNV-1a-ish hash → hue), so every client renders the same color for
 * the same user without any server support.
 */

export function colorForUserId(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
