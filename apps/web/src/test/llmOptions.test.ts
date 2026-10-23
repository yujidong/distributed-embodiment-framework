/**
 * llmOptions（仿真创建 LLM 选项/说明映射）——三个预设都有 option 与 hint
 * key，且在 zh-CN / en-US 的 world 命名空间里都能解析出文案。
 */

import { describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { LlmClientPreset } from '../api/types';
import { LLM_HINT_KEYS, LLM_OPTION_KEYS } from '../lib/llmOptions';

const PRESETS: Array<LlmClientPreset> = ['none', 'auto', 'llm'];

describe('llmOptions', () => {
  it('covers every preset with an option label and a hint', () => {
    for (const preset of PRESETS) {
      expect(LLM_OPTION_KEYS[preset]).toBeTruthy();
      expect(LLM_HINT_KEYS[preset]).toBeTruthy();
    }
  });

  it('resolves hint keys in both locales (world namespace)', () => {
    for (const lng of ['zh-CN', 'en-US']) {
      for (const preset of PRESETS) {
        const hint = i18n.t(LLM_HINT_KEYS[preset], { ns: 'world', lng });
        expect(hint).not.toBe(LLM_HINT_KEYS[preset]);
        expect(hint.length).toBeGreaterThan(0);
      }
    }
  });
});
