/**
 * Qwen3 thinking-suppression toggle tests (LLM_DISABLE_THINKING).
 *
 * Default ON: structured-output lanes send chat_template_kwargs
 * {enable_thinking: false}; LLM_DISABLE_THINKING=0/false/off restores the
 * default template (A/B escape hatch) and the field is omitted entirely.
 */

import { describe, it, expect } from 'vitest';
import { isThinkingDisabled, noThinkingTemplateKwargs, DISABLE_THINKING_ENV } from './thinking';

describe('isThinkingDisabled', () => {
  it('defaults to ON when the env is unset', () => {
    expect(isThinkingDisabled({})).toBe(true);
  });

  it.each(['0', 'false', 'off', 'FALSE', 'Off'])('%s disables suppression', value => {
    expect(isThinkingDisabled({ [DISABLE_THINKING_ENV]: value })).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'anything'])('%s keeps suppression on', value => {
    expect(isThinkingDisabled({ [DISABLE_THINKING_ENV]: value })).toBe(true);
  });
});

describe('noThinkingTemplateKwargs', () => {
  it('returns enable_thinking:false while suppression is on', () => {
    expect(noThinkingTemplateKwargs({})).toEqual({ enable_thinking: false });
  });

  it('returns undefined when the operator turned suppression off', () => {
    expect(noThinkingTemplateKwargs({ [DISABLE_THINKING_ENV]: '0' })).toBeUndefined();
  });
});
