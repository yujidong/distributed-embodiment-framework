/**
 * i18next initialization — runs once on app boot (imported as a side-effect
 * from `main.tsx` before <App /> mounts).
 *
 * Detection order (matches the locked-in i18n decision):
 *   1. localStorage `eaf-lang` — explicit user override (mirrors `eaf-theme`).
 *   2. navigator.language / navigator.languages — browser default.
 *   3. fallbackLng `zh-CN` — the project's content source-of-truth.
 *
 * Resources are bundled (not lazy-loaded): the catalog is small enough that
 * one round-trip beats the i18n-chunks-per-route complexity. Add a language
 * by extending `normalizeLocale` (shared/i18n.ts) and adding a bundle here.
 */

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { zhCN } from './zh-CN';
import { enUS } from './en-US';

export const LANG_STORAGE_KEY = 'eaf-lang';
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

void i18n
  .use(initReactI18next)
  .use(LanguageDetector)
  .init({
    resources: {
      'zh-CN': zhCN,
      'en-US': enUS,
    },
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LOCALES],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnEmptyString: false,
  });

export default i18n;
