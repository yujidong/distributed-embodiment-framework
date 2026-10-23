/**
 * Locale dictionary parity — zh-CN and en-US must stay key-for-key identical.
 *
 * The zh bundle is the source of truth; en tracks it. A key present on only
 * one side renders the raw key path (or the fallback-locale string) in the
 * other locale, which is exactly the class of silent i18n breakage this
 * suite exists to catch. Also asserts no empty-string values, because
 * `returnEmptyString: false` would make an empty zh value fall through to
 * en-US text inside the Chinese UI.
 */

import { describe, expect, it } from 'vitest';

import { enUS } from '../i18n/en-US';
import { zhCN } from '../i18n/zh-CN';

type Bundle = Record<string, unknown>;

function flatten(bundle: Bundle, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(bundle)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [nestedPath, nestedValue] of flatten(value as Bundle, path)) {
        out.set(nestedPath, nestedValue);
      }
    } else if (typeof value === 'string') {
      out.set(path, value);
    }
  }
  return out;
}

const zh = flatten(zhCN as Bundle);
const en = flatten(enUS as Bundle);

describe('i18n locale parity (zh-CN vs en-US)', () => {
  it('both bundles define the same set of keys', () => {
    const onlyZh = [...zh.keys()].filter((k) => !en.has(k));
    const onlyEn = [...en.keys()].filter((k) => !zh.has(k));
    expect(
      {
        'keys only in zh-CN (add them to en-US)': onlyZh,
        'keys only in en-US (add them to zh-CN)': onlyEn,
      },
      'locale dictionaries have diverged — every user-facing key must exist in BOTH bundles',
    ).toEqual({
      'keys only in zh-CN (add them to en-US)': [],
      'keys only in en-US (add them to zh-CN)': [],
    });
  });

  it('no locale value is an empty string', () => {
    const emptyZh = [...zh.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
    const emptyEn = [...en.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
    expect(
      { 'empty values in zh-CN': emptyZh, 'empty values in en-US': emptyEn },
      'empty values break zh-CN because returnEmptyString:false falls through to en-US text',
    ).toEqual({ 'empty values in zh-CN': [], 'empty values in en-US': [] });
  });

  it('interpolation placeholders match between locales', () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const mismatches: string[] = [];
    for (const [key, zhValue] of zh) {
      const enValue = en.get(key);
      if (enValue === undefined) continue; // covered by the parity assertion
      if (JSON.stringify(placeholders(zhValue)) !== JSON.stringify(placeholders(enValue))) {
        mismatches.push(`${key}: zh=${placeholders(zhValue).join(',')} en=${placeholders(enValue).join(',')}`);
      }
    }
    expect(mismatches, 'placeholder sets differ between zh-CN and en-US').toEqual([]);
  });
});
