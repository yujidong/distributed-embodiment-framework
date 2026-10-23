import { describe, expect, it } from 'vitest';

import { acceptLanguageToLocale, queryLangToLocale, t, MESSAGES } from './index.js';

describe('t()', () => {
  it('resolves dot-namespaced keys for zh-CN (source of truth)', () => {
    expect(t('zh-CN', 'chrome.role.viewerNotice')).toBe(
      '你是 viewer：可浏览世界、创建仿真观察、fork 沙箱；不可修改世界或注入事件。',
    );
    expect(t('zh-CN', 'chrome.notif.agreementProposed')).toBe('有新的服务合约提案待你处理');
    expect(t('zh-CN', 'chrome.notif.termsUnlimited')).toBe('无附加条款（不限）');
  });

  it('resolves dot-namespaced keys for en-US', () => {
    expect(t('en-US', 'chrome.role.viewerNotice')).toContain("You're a viewer");
    expect(t('en-US', 'chrome.notif.agreementProposed')).toBe(
      'You have a new service-agreement proposal to review',
    );
  });

  it('interpolates {name} placeholders', () => {
    expect(t('zh-CN', 'chrome.manifest.devicesToBuy', { count: 3, total: 1200 })).toBe(
      '3 台设备待采购，名录总价约 ¥1200',
    );
    expect(t('en-US', 'chrome.manifest.devicesToBuy', { count: 3, total: 1200 })).toBe(
      '3 device(s) to procure; catalog total ≈ ¥1200',
    );
  });

  it('leaves unknown placeholders intact', () => {
    expect(t('zh-CN', 'chrome.manifest.devicesToBuy', { count: 3 })).toBe(
      '3 台设备待采购，名录总价约 ¥{total}',
    );
  });

  it('falls back to zh-CN when a key is missing in en-US', () => {
    // Hand-curate a missing-key scenario by deleting the en-US entry at runtime.
    const original = (MESSAGES['en-US'].chrome.notif as { agreementProposed?: string }).agreementProposed;
    (MESSAGES['en-US'].chrome.notif as { agreementProposed?: string }).agreementProposed = undefined as unknown as string;
    try {
      // The resolver treats `undefined` leaf as missing and falls back to zh-CN.
      expect(t('en-US', 'chrome.notif.agreementProposed')).toBe('有新的服务合约提案待你处理');
    } finally {
      (MESSAGES['en-US'].chrome.notif as { agreementProposed?: string }).agreementProposed = original;
    }
  });

  it('returns the raw key when the key is unknown to both locales', () => {
    expect(t('zh-CN', 'chrome.area.thatDoesNotExist')).toBe('chrome.area.thatDoesNotExist');
    expect(t('en-US', 'not.a.real.key')).toBe('not.a.real.key');
  });

  it('rejects keys that are not exactly three dot-parts', () => {
    expect(t('zh-CN', 'chrome')).toBe('chrome');
    expect(t('zh-CN', 'chrome.notif')).toBe('chrome.notif');
    expect(t('zh-CN', 'a.b.c.d')).toBe('a.b.c.d');
  });
});

describe('acceptLanguageToLocale()', () => {
  it('returns en-US when en* tags win on quality', () => {
    expect(acceptLanguageToLocale('en-US,en;q=0.9,zh-CN;q=0.8')).toBe('en-US');
    expect(acceptLanguageToLocale('en-GB,en;q=0.9')).toBe('en-US');
    expect(acceptLanguageToLocale('en')).toBe('en-US');
  });

  it('returns zh-CN when zh* tags win on quality', () => {
    expect(acceptLanguageToLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
    expect(acceptLanguageToLocale('zh-TW')).toBe('zh-CN');
    expect(acceptLanguageToLocale('zh')).toBe('zh-CN');
  });

  it('respects q-values to break ties in document order', () => {
    // zh has higher q than en → zh-CN
    expect(acceptLanguageToLocale('en;q=0.5, zh;q=0.9')).toBe('zh-CN');
    // en has higher q than zh → en-US
    expect(acceptLanguageToLocale('zh;q=0.5, en;q=0.9')).toBe('en-US');
  });

  it('defaults to zh-CN for empty, wildcard, or unknown tags', () => {
    expect(acceptLanguageToLocale('')).toBe('zh-CN');
    expect(acceptLanguageToLocale(undefined)).toBe('zh-CN');
    expect(acceptLanguageToLocale('*')).toBe('zh-CN');
    expect(acceptLanguageToLocale('fr-FR,de;q=0.8')).toBe('zh-CN');
    expect(acceptLanguageToLocale('ja-JP')).toBe('zh-CN'); // ja bundle not yet shipped
  });
});

describe('queryLangToLocale()', () => {
  it('normalizes ?lang= values', () => {
    expect(queryLangToLocale('en-US')).toBe('en-US');
    expect(queryLangToLocale('en')).toBe('en-US');
    expect(queryLangToLocale('zh-CN')).toBe('zh-CN');
    expect(queryLangToLocale('ZH-TW')).toBe('zh-CN');
    expect(queryLangToLocale(undefined)).toBe('zh-CN');
    expect(queryLangToLocale('fr')).toBe('zh-CN');
  });
});
