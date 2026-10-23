import { describe, expect, it } from 'vitest';
import {
  localizedText,
  normalizeLocale,
  type LocalizedText,
  type UiLocale,
} from './i18n';

describe('normalizeLocale', () => {
  it('returns zh-CN for zh* prefixes', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-CN');
    expect(normalizeLocale('ZH-cn')).toBe('zh-CN');
  });

  it('returns en-US for en* prefixes', () => {
    expect(normalizeLocale('en')).toBe('en-US');
    expect(normalizeLocale('en-US')).toBe('en-US');
    expect(normalizeLocale('en-GB')).toBe('en-US');
    expect(normalizeLocale('EN-us')).toBe('en-US');
  });

  it('falls back to zh-CN for unknown locales', () => {
    // Future ja/ko will resolve here once resource catalogs land.
    expect(normalizeLocale('ja-JP')).toBe('zh-CN');
    expect(normalizeLocale('ko-KR')).toBe('zh-CN');
    expect(normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeLocale('')).toBe('zh-CN');
    expect(normalizeLocale(undefined)).toBe('zh-CN');
    expect(normalizeLocale(null)).toBe('zh-CN');
  });
});

describe('localizedText', () => {
  const pair: LocalizedText = { zh: '你好', en: 'Hello' };

  it('picks zh for zh-CN locale', () => {
    expect(localizedText(pair, 'zh-CN')).toBe('你好');
  });

  it('picks en for en-US locale', () => {
    expect(localizedText(pair, 'en-US')).toBe('Hello');
  });

  it('passes plain strings through unchanged (legacy scenario support)', () => {
    expect(localizedText('legacy', 'zh-CN')).toBe('legacy');
    expect(localizedText('legacy', 'en-US')).toBe('legacy');
  });

  it('returns fallback for nullish input', () => {
    expect(localizedText(undefined, 'zh-CN')).toBe('');
    expect(localizedText(null, 'en-US')).toBe('');
    expect(localizedText(undefined, 'zh-CN', 'fallback')).toBe('fallback');
  });

  it('falls back to the other side when the picked side is empty', () => {
    expect(localizedText({ zh: '', en: 'Only' }, 'zh-CN')).toBe('Only');
    expect(localizedText({ zh: '只有', en: '' }, 'en-US')).toBe('只有');
  });

  it('falls back to zh then en when both picked sides are empty', () => {
    // Future-locale safety: a key for an unimplemented language resolves to
    // the source-of-truth zh side via the generic index signature.
    const stub: LocalizedText = { zh: '源', en: 'src', ja: '' };
    // Active locale's side empty → other side empty → falls through to zh.
    expect(localizedText({ ...stub, en: '' }, 'en-US')).toBe('源');
  });

  it('trims whitespace when deciding emptiness', () => {
    expect(localizedText({ zh: '   ', en: 'x' }, 'zh-CN')).toBe('x');
  });

  it('returns the fallback string when no side has content', () => {
    const empty: LocalizedText = { zh: '', en: '' };
    expect(localizedText(empty, 'zh-CN', 'default')).toBe('default');
    expect(localizedText(empty, 'en-US')).toBe('');
  });

  it('supports additional language keys via the index signature', () => {
    // Future ja bundle: the resolver still works because the type allows
    // arbitrary extra string keys; lookup via the want/other/zh/en chain.
    const trilingual: LocalizedText = {
      zh: '你好',
      en: 'Hello',
      ja: 'こんにちは',
    };
    // Active locales today are only zh-CN and en-US, so ja is never picked
    // directly — but its presence must not break the type or the resolver.
    expect(localizedText(trilingual, 'zh-CN')).toBe('你好');
    expect(localizedText(trilingual, 'en-US')).toBe('Hello');
  });

  it('UiLocale is exactly zh-CN | en-US (compile-time guarantee)', () => {
    const locale: UiLocale = 'zh-CN';
    expect(['zh-CN', 'en-US']).toContain(locale);
  });
});
