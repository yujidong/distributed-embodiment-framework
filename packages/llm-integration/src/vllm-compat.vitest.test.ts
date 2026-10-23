/**
 * @vitest-environment node
 *
 * vLLM compatibility suite (DevLoop R20 / S-vLLM).
 *
 * Exercises OpenAICompatibleProvider against a LOCAL fake vLLM server
 * (house pattern: real node:http on a free port — the provider's
 * cross-fetch bypasses global fetch stubs, so mocking fetch is not enough
 * for wire-level assertions).
 *
 * Every scenario below mirrors behavior DOCUMENTED by vLLM's OpenAI-
 * compatible server (docs.vllm.ai, "Online Serving" / "Reasoning Outputs"
 * / `vllm serve` engine args), not invented shapes:
 *
 *  (a) standard non-streaming chat completion with a usage block
 *  (b) --reasoning-parser qwen3 output: reasoning split into a separate
 *      field (`reasoning`, formerly `reasoning_content`) with a CLEAN
 *      content — AND the un-parsed variant where raw <think> stays in
 *      content (client-side T-103 stripping must keep working for both)
 *  (c) --served-model-name: the response `model` echoes a name that can
 *      differ from the requested one
 *  (d) error bodies: 404 NotFoundError "The model `X` does not exist."
 *      (unknown model) and 400 BadRequestError (context length exceeded)
 *  (e) finish_reason "length" / "content_filter" (text still returned)
 *  (f) degenerate 200 with empty choices (honest LLMError, T-102)
 *
 * Graceful = the R10 contract: parse the good shapes, surface an honest
 * LLMError (with correct transient/permanent classification) for the bad
 * ones — never a TypeError, never a silent wrong answer.
 */

import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LLMClient } from './client';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { isTransientLLMError, LLMError } from './types';

const REQUESTED_MODEL = 'Qwen/Qwen3-8B';
const SERVED_MODEL = 'qwen3-8b'; // what --served-model-name publishes

/**
 * What the fake server answers for POST /v1/chat/completions in the next
 * provider call. Tests set this per-case (the house "mutable scenario"
 * pattern — one server, many documented behaviors).
 */
let chatHandler: (body: Record<string, any>) => { status?: number; json: unknown } = () => ({
  json: standardCompletion(),
});

/** vLLM's documented non-streaming success shape (usage always present). */
function standardCompletion(content = 'ok'): Record<string, unknown> {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1755900000,
    model: SERVED_MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3443, completion_tokens: 63, total_tokens: 3506 },
  };
}

/** vLLM's documented error envelope (object/type/param/code fields). */
function vllmError(status: number, type: string, message: string): Record<string, unknown> {
  return { object: 'error', message, type, param: null, code: status };
}

let server: Server;
let baseUrl = '';
/** Bodies captured from the last chat POST (for request-shape assertions). */
let lastChatBody: Record<string, any> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      // vLLM GET /v1/models ("List available models"): object list with
      // data[].id — this is also what the provider's healthCheck probes.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: SERVED_MODEL, object: 'model', created: 1755900000, owned_by: 'vllm' }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        lastChatBody = JSON.parse(raw);
        const answer = chatHandler(lastChatBody!);
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vllmError(404, 'NotFoundError', 'Not Found')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

function makeProvider(timeout?: number): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ baseURL: baseUrl, model: REQUESTED_MODEL, ...(timeout !== undefined ? { timeout } : {}) });
}

const messages = [{ role: 'user' as const, content: '机房温度超标，需要协作处理吗？' }];

describe('vLLM fake-server compatibility', () => {
  it('(a) standard non-streaming completion: request shape, content, usage, served-model echo', async () => {
    chatHandler = () => ({ json: standardCompletion('{"decision":"collaborate"}') });
    const provider = makeProvider();

    const response = await provider.chat({ messages });

    // Request side: the provider's wire contract with vLLM.
    expect(lastChatBody!.model).toBe(REQUESTED_MODEL);
    expect(lastChatBody!.messages).toEqual(messages);
    expect(lastChatBody!.temperature).toBe(0.7); // T-104 default
    expect(lastChatBody!.max_tokens).toBe(2000); // provider default
    expect(lastChatBody!.stream).toBeUndefined(); // platform is non-streaming
    // Response side: content + token accounting + the model vLLM echoes.
    expect(response.content).toBe('{"decision":"collaborate"}');
    expect(response.usage).toEqual({ promptTokens: 3443, completionTokens: 63, totalTokens: 3506 });
    expect(response.model).toBe(SERVED_MODEL);
  });

  it('(a) LLMClient end-to-end through the shared queue against the fake vLLM', async () => {
    chatHandler = () => ({ json: standardCompletion('queued-ok') });
    const client = new LLMClient('openai-compatible', { baseURL: baseUrl, model: REQUESTED_MODEL });

    const response = await client.chat({ messages });
    expect(response.content).toBe('queued-ok');
    expect(response.model).toBe(SERVED_MODEL);
  });

  it('(b1) --reasoning-parser qwen3 split: clean content + ignored reasoning field (legacy name)', async () => {
    chatHandler = () => ({
      json: {
        ...standardCompletion('{"outcome":"allow"}'),
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{"outcome":"allow"}',
            reasoning_content: '温度 31 度超过阈值，但风机可独立处理。',
          },
          finish_reason: 'stop',
        }],
      },
    });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    // The answer arrives pre-split: content is used as-is (no <think> to
    // strip), the reasoning field is extra JSON the provider ignores.
    expect(response.content).toBe('{"outcome":"allow"}');
    expect(response.usage?.totalTokens).toBe(3506);
  });

  it('(b1) --reasoning-parser qwen3 split: current `reasoning` field name', async () => {
    chatHandler = () => ({
      json: {
        ...standardCompletion('{"outcome":"reject"}'),
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{"outcome":"reject"}',
            reasoning: '跨方数据访问未在协议中登记。',
          },
          finish_reason: 'stop',
        }],
      },
    });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    expect(response.content).toBe('{"outcome":"reject"}');
  });

  it('(b2) NO reasoning parser: raw <think> stays in content — T-103 client-side strip handles it', async () => {
    chatHandler = () => ({
      json: standardCompletion(
        '<think>草稿 {"outcome":"escalate"} 不对，先看阈值</think>\n{"outcome":"allow"}',
      ),
    });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    // The draft JSON inside <think> must NOT leak into the answer.
    expect(response.content).toBe('{"outcome":"allow"}');
    expect(response.content).not.toContain('escalate');
  });

  it('(b3) reasoning-only output (content null): honest LLMError, not a TypeError', async () => {
    chatHandler = () => ({
      json: {
        ...standardCompletion(''),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null, reasoning: '仍在思考，未产出结论' },
          finish_reason: 'stop',
        }],
      },
    });
    const provider = makeProvider();

    const error = await provider.chat({ messages }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('no message content');
  });

  it('(c) served-model-name: echoed model differs from the requested one — no error, echo reported', async () => {
    chatHandler = () => ({ json: { ...standardCompletion('ok'), model: 'some-other-alias' } });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    // The provider never asserts requested == echoed (vLLM legitimately
    // answers with the served name); it reports what the server said.
    expect(lastChatBody!.model).toBe(REQUESTED_MODEL);
    expect(response.model).toBe('some-other-alias');
    expect(response.content).toBe('ok');
  });

  it('(d1) unknown model: vLLM 404 NotFoundError envelope → honest LLMError, permanent (no retry)', async () => {
    chatHandler = () => ({
      status: 404,
      json: vllmError(404, 'NotFoundError', 'The model `Qwen/Qwen3-8B` does not exist.'),
    });
    const provider = makeProvider();

    const error = await provider.chat({ messages }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('404');
    expect(error.cause).toBeInstanceOf(Error);
    expect(String(error.cause.message)).toContain('does not exist');
    // T-022: a model-name mismatch must not burn decision retries.
    expect(isTransientLLMError(error)).toBe(false);
  });

  it('(d2) context length exceeded: vLLM 400 BadRequestError envelope → honest LLMError, permanent', async () => {
    chatHandler = () => ({
      status: 400,
      json: vllmError(400, 'BadRequestError',
        'This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens (4937 in the messages, 63 in the completion). Please reduce the length of the messages or completion.'),
    });
    const provider = makeProvider();

    const error = await provider.chat({ messages }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('400');
    expect(isTransientLLMError(error)).toBe(false);
  });

  it('(e1) finish_reason "length": truncated text is still returned (truncation is visible downstream)', async () => {
    chatHandler = () => ({
      json: {
        ...standardCompletion('{"outcome":"all'),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"outcome":"all' },
          finish_reason: 'length',
        }],
      },
    });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    // Documented platform behavior: the text is handed through; JSON
    // truncation is handled by the lenient downstream parsers (T-103).
    expect(response.content).toBe('{"outcome":"all');
  });

  it('(e2) finish_reason "content_filter": surviving text is still returned, no crash', async () => {
    chatHandler = () => ({
      json: {
        ...standardCompletion('机房温度正常'),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '机房温度正常' },
          finish_reason: 'content_filter',
        }],
      },
    });
    const provider = makeProvider();

    const response = await provider.chat({ messages });
    expect(response.content).toBe('机房温度正常');
    expect(response.usage?.totalTokens).toBe(3506);
  });

  it('(f) empty choices on a 200: honest LLMError naming the model', async () => {
    chatHandler = () => ({
      json: {
        id: 'chatcmpl-abc123',
        object: 'chat.completion',
        created: 1755900000,
        model: SERVED_MODEL,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      },
    });
    const provider = makeProvider();

    const error = await provider.chat({ messages }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('no choices');
    expect(error.message).toContain(REQUESTED_MODEL);
  });

  it('healthCheck probes GET /v1/models and resolves true while vLLM answers', async () => {
    const provider = makeProvider();
    await expect(provider.healthCheck()).resolves.toBe(true);
  });

  it('server-side abort: caller AbortSignal is named as the cause, not a timeout', async () => {
    chatHandler = () => ({ json: standardCompletion('late') });
    const provider = makeProvider(10_000);
    const controller = new AbortController();
    const pending = provider.chat({ messages, signal: controller.signal });
    controller.abort();
    const error = await pending.catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('aborted by the caller');
  });
});
