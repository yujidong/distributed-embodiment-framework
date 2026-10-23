/**
 * LlmStatusBar（仿真控制台 LLM 状态条）——LLM 模式显示模型名，
 * rule-only 显示直白说明，llmWarning 存在时带警示样式与文案。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import i18n from '../i18n/config';
import { LlmStatusBar } from '../components/LlmStatusBar';

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});

afterEach(cleanup);

describe('LlmStatusBar', () => {
  it('shows the LLM mode with the model name', () => {
    render(<LlmStatusBar llm="llm" llmModel="qwen3:14b" />);
    expect(screen.getByTestId('llm-status-bar').textContent).toContain('qwen3:14b');
    expect(screen.getByTestId('llm-status-bar').textContent).toContain('vLLM');
  });

  it('falls back to an unknown-model label when the model is missing', () => {
    render(<LlmStatusBar llm="llm" />);
    expect(screen.getByTestId('llm-status-bar').textContent).toContain('unknown model');
  });

  it('labels rule-only as TEST mode, never production-grade', () => {
    render(<LlmStatusBar llm="rule-only" />);
    const bar = screen.getByTestId('llm-status-bar');
    expect(bar.textContent).toContain('rule-only');
    expect(bar.textContent).toContain('TEST MODE');
    expect(bar.textContent).toContain('not production-grade');
    expect(bar.className).toContain('llm-status--rule-only');
  });

  it('renders the degradation warning with warning styling', () => {
    render(<LlmStatusBar llm="rule-only" llmWarning="LLM_BASE_URL is not configured" />);
    const bar = screen.getByTestId('llm-status-bar');
    expect(bar.textContent).toContain('LLM_BASE_URL is not configured');
    expect(bar.className).toContain('llm-status--warning');
  });

  it('omits the warning block when there is none', () => {
    render(<LlmStatusBar llm="llm" llmModel="qwen3:14b" />);
    expect(screen.getByTestId('llm-status-bar').className).not.toContain('llm-status--warning');
  });

  it('offers the enable guide only when a warning is present', () => {
    render(<LlmStatusBar llm="rule-only" />);
    expect(screen.queryByRole('button', { name: 'How to enable?' })).toBeNull();

    cleanup();
    render(<LlmStatusBar llm="rule-only" llmWarning="LLM_BASE_URL is not configured" />);
    expect(screen.getByRole('button', { name: 'How to enable?' })).toBeTruthy();
  });

  it('expands the guide with the key setup steps and collapses it again', () => {
    render(<LlmStatusBar llm="rule-only" llmWarning="LLM_BASE_URL is not configured" />);
    const bar = screen.getByTestId('llm-status-bar');
    const toggle = screen.getByRole('button', { name: 'How to enable?' });

    // Collapsed by default.
    expect(bar.querySelector('.llm-status__guide')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    const guide = bar.querySelector('.llm-status__guide');
    expect(guide).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(guide!.textContent).toContain('docs.vllm.ai');
    expect(guide!.textContent).toContain('vllm serve Qwen/Qwen2.5-7B-Instruct');
    expect(guide!.textContent).toContain('$env:LLM_BASE_URL');
    expect(guide!.textContent).toContain('export LLM_BASE_URL=http://127.0.0.1:8000/v1');
    expect(guide!.textContent).toContain('Restart the API service');

    fireEvent.click(toggle);
    expect(bar.querySelector('.llm-status__guide')).toBeNull();
  });

  it('R2-UX-05: a known server warning template renders localized (zh-CN)', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <LlmStatusBar
        llm="rule-only"
        llmWarning="Agents in this world use LLM decisions (declared or by default) but LLM_BASE_URL is not configured on this server — running rule-only (deterministic rule decisions, no LLM calls)."
      />,
    );
    const bar = screen.getByTestId('llm-status-bar');
    // 第二行不再是英文原文——映射到本地文案（lib/llmWarning）。
    expect(bar.textContent).toContain('未配置 LLM_BASE_URL');
    expect(bar.textContent).not.toContain('running rule-only');
  });

  it('R2-UX-05: an unknown warning template falls back to the raw text', () => {
    render(<LlmStatusBar llm="rule-only" llmWarning="A brand-new future warning" />);
    expect(screen.getByTestId('llm-status-bar').textContent).toContain(
      'A brand-new future warning',
    );
  });
});
