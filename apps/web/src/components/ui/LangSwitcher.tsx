/**
 * Language switcher — small cycle button mirroring the theme toggle's
 * placement in the app header. Persists the chosen locale to localStorage
 * (`eaf-lang`) via i18next's LanguageDetector cache.
 *
 * Clicking cycles zh-CN ↔ en-US; the i18n `languageChanged` event propagates
 * to every `useTranslation()` consumer, so the UI flips instantly without a
 * reload.
 */

import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type AppLocale } from '../../i18n/config';

export function LangSwitcher() {
  const { i18n, t } = useTranslation('common');
  const current = (i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US') as AppLocale;
  const next: AppLocale = current === 'zh-CN' ? 'en-US' : 'zh-CN';

  const handleClick = () => {
    void i18n.changeLanguage(next);
  };

  return (
    <button
      type="button"
      className="icon-button"
      onClick={handleClick}
      title={t('lang.switch')}
      aria-label={t('lang.switch')}
    >
      <Languages size={16} />
    </button>
  );
}

/** Re-export for callers that need the list without importing the config module. */
export { SUPPORTED_LOCALES };
