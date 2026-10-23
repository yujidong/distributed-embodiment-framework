/**
 * DevLoop LLM helper — wraps the OpenAI-compatible endpoint (vLLM) for the
 * three agents' reasoning needs.
 */

// SSRF 防护：端点仅接受 http/https（env 值异常时回退本地默认，绝不
// 以 file:/data: 等协议或畸形 URL 发起请求）。
const LLM_BASE = (() => {
  const raw = process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8000/v1';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://127.0.0.1:8000/v1';
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:8000/v1';
  }
})();
const MODEL = process.env.DEVLOOP_MODEL ?? process.env.LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';

export async function llmChat(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2048,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM chat failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`LLM chat returned no message content (model "${MODEL}")`);
  }
  return content;
}

/** Ask LLM to output JSON; strips markdown fences and <think> blocks. */
export async function llmJson<T>(system: string, user: string): Promise<T> {
  const raw = await llmChat(system, user, { temperature: 0.3 });
  // Strip <think>...</think> if present (qwen3 reasoning mode)
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown code fences
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : cleaned;
  return JSON.parse(jsonStr.trim()) as T;
}
