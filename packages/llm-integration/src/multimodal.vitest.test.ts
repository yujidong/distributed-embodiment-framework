/**
 * Multimodal message support (B-D floorplan vision importer):
 *
 * - `ChatMessage.content` accepts OpenAI-style content parts
 *   (`{type:'text'}` / `{type:'image_url'}`).
 * - The OpenAI-compatible provider forwards parts unchanged (native shape).
 * - `messageContentToText` flattens parts for logging/cache keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { messageContentToText, type ChatMessage } from './types';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function visionMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'You read floor plans.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What rooms do you see?' },
        { type: 'image_url', image_url: { url: IMAGE_DATA_URI } },
      ],
    },
  ];
}

function lastRequestBody(): Record<string, any> {
  const init = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1];
  return JSON.parse(init.body);
}

describe('multimodal chat messages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('OpenAI-compatible provider forwards content parts unchanged', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const provider = new OpenAICompatibleProvider({ baseURL: 'http://localhost:8000/v1', model: 'm' });

    await provider.chat({ messages: visionMessages() });

    const userMessage = lastRequestBody().messages[1];
    expect(userMessage.content).toEqual([
      { type: 'text', text: 'What rooms do you see?' },
      { type: 'image_url', image_url: { url: IMAGE_DATA_URI } },
    ]);
  });

  it('messageContentToText flattens parts with an image placeholder', () => {
    const text = messageContentToText([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: IMAGE_DATA_URI } },
    ]);
    expect(text).toContain('hello');
    expect(text).toContain('[image ');
    expect(text).not.toContain(IMAGE_DATA_URI);
  });
});
