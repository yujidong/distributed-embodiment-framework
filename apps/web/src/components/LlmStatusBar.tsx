/**
 * LlmStatusBar — the simulation console's prominent LLM-mode line (usability
 * fix): which decision mode the run is in (LLM + model name, or rule-only
 * with a plain-language consequence note), plus the degradation warning as a
 * warning-style banner when the server had to fall back to rule-only. The
 * warning carries an expandable "how to enable the LLM" guide (vLLM install
 * → serve → LLM_BASE_URL → restart), collapsed by default.
 *
 * `llm`/`llmModel`/`llmWarning` come from the sim info response (create
 * result or list entry); when the console was opened without one, the caller
 * passes the mode derived from the snapshot's per-agent llmEnabled flags and
 * model/warning stay undefined.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { localizedLlmWarning } from '../lib/llmWarning';

export interface LlmStatusBarProps {
  llm: 'llm' | 'rule-only';
  /** Model the shared client uses (LLM mode, when known). */
  llmModel?: string;
  /** Server degradation notice (agents wanted an LLM but none is configured). */
  llmWarning?: string;
}

// Enable-guide command snippets (language-neutral, mirroring the deployment
// docs — vLLM is the sole backend since R44-B).
const GUIDE_SERVE_COMMAND =
  'vllm serve Qwen/Qwen2.5-7B-Instruct --served-model-name Qwen/Qwen2.5-7B-Instruct';
const GUIDE_ENV_POWERSHELL =
  '$env:LLM_BASE_URL="http://127.0.0.1:8000/v1"; $env:LLM_MODEL="Qwen/Qwen2.5-7B-Instruct"';
const GUIDE_ENV_BASH =
  'export LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=Qwen/Qwen2.5-7B-Instruct';

export function LlmStatusBar({ llm, llmModel, llmWarning }: LlmStatusBarProps) {
  const { t } = useTranslation('simView');
  // Session-local expand state for the "how to enable" guide (collapsed by
  // default on every mount — no persistence).
  const [guideOpen, setGuideOpen] = useState(false);
  return (
    <div
      className={`llm-status${llm === 'rule-only' ? ' llm-status--rule-only' : ''}${
        llmWarning ? ' llm-status--warning' : ''
      }`}
      data-testid="llm-status-bar"
    >
      <span className="llm-status__mode">
        {llm === 'llm'
          ? t('llmStatusLlm', { model: llmModel ?? t('llmModelUnknown') })
          : t('llmStatusRuleOnly')}
      </span>
      {llmWarning && (
        // R2-UX-05: the server's degradation notice is hardcoded English —
        // map the known templates to localized lines (raw fallback inside).
        <span className="llm-status__warning">{localizedLlmWarning(llmWarning)}</span>
      )}
      {llmWarning && (
        <button
          type="button"
          className="link-button llm-status__guide-toggle"
          aria-expanded={guideOpen}
          onClick={() => setGuideOpen(open => !open)}
        >
          {t('llmGuide.toggle')}
        </button>
      )}
      {llmWarning && guideOpen && (
        <ol className="llm-status__guide">
          <li>{t('llmGuide.stepInstall')}</li>
          <li>
            {t('llmGuide.stepServe')} <code>{GUIDE_SERVE_COMMAND}</code>
          </li>
          <li>
            {t('llmGuide.stepEnv')}
            <div className="llm-status__guide-env">
              <span>PowerShell:</span> <code>{GUIDE_ENV_POWERSHELL}</code>
            </div>
            <div className="llm-status__guide-env">
              <span>bash:</span> <code>{GUIDE_ENV_BASH}</code>
            </div>
          </li>
          <li>{t('llmGuide.stepRestart')}</li>
        </ol>
      )}
    </div>
  );
}
