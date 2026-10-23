/**
 * Strip qwen-style thinking tags from model response content.
 *
 * qwen3-family models (and other reasoning-tuned backends) emit
 * `<think ...>...</think>` blocks wrapping their internal reasoning — often
 * including DRAFT JSON objects. These are not part of the actual answer and
 * break JSON parsers downstream if left in place, so every chat-style
 * provider applies this before returning content.
 */
export function stripThinkBlocks(content: string): string {
  return content.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/g, '').trim();
}
