/**
 * @vitest-environment node
 *
 * Global LLM request queue governance (R15-C1): concurrency limiting, wait
 * accounting (the C3 attribution number) and runtime resize. The queue is
 * module-private, so it is exercised through LLMClient.chat against a local
 * HTTP stub — the provider's own node-fetch bypasses global fetch stubs.
 */

import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getLLMQueueStats, LLMClient, setLLMMaxConcurrent } from '../src/client';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let server: Server;
let baseUrl = '';
let delayMs = 40;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }, delayMs);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  setLLMMaxConcurrent(3); // restore the default for other suites
});

describe('global LLM queue (R15-C1)', () => {
  it('stats expose wait accounting for latency attribution', () => {
    const stats = getLLMQueueStats();
    expect(stats).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
      waitCount: expect.any(Number),
      avgWaitMs: expect.any(Number),
      maxWaitMs: expect.any(Number),
      depthHighWater: expect.any(Number),
    });
  });

  it('serializes calls beyond the limit and records their wait', async () => {
    setLLMMaxConcurrent(1);
    delayMs = 40;
    const client = new LLMClient('openai-compatible', {
      baseURL: baseUrl, apiKey: 'k', model: 'stub-model',
    });
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const before = getLLMQueueStats();

    const calls = Promise.all([
      client.chat({ messages }),
      client.chat({ messages }),
      client.chat({ messages }),
    ]);
    // Mid-flight: limit 1 → exactly 1 executing against the stub, 2 queued.
    await sleep(15);
    const mid = getLLMQueueStats();
    expect(mid.active).toBe(1);
    expect(mid.queued).toBe(2);
    expect(mid.depthHighWater).toBeGreaterThanOrEqual(2);

    const responses = await calls;
    expect(responses).toHaveLength(3);
    expect(responses[0]!.content).toBe('ok');
    const after = getLLMQueueStats();
    expect(after.waitCount).toBeGreaterThanOrEqual(before.waitCount + 3);
    expect(after.maxWaitMs).toBeGreaterThan(0);
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('resize takes effect immediately; invalid values are ignored', () => {
    setLLMMaxConcurrent(2);
    expect(getLLMQueueStats().maxConcurrent).toBe(2);
    setLLMMaxConcurrent(0);
    setLLMMaxConcurrent(Number.NaN);
    expect(getLLMQueueStats().maxConcurrent).toBe(2);
    setLLMMaxConcurrent(3);
    expect(getLLMQueueStats().maxConcurrent).toBe(3);
  });
});
