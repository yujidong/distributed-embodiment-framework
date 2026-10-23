/**
 * mapHint（W4 世界视图地图操作提示）——dismiss 的 localStorage 持久化与
 * 默认（未关闭）行为。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadMapHintDismissed, saveMapHintDismissed } from '../lib/mapHint';

describe('mapHint persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('is not dismissed by default', () => {
    expect(loadMapHintDismissed()).toBe(false);
  });

  it('stays dismissed after save', () => {
    saveMapHintDismissed();
    expect(loadMapHintDismissed()).toBe(true);
  });

  it('treats unexpected payloads as not dismissed', () => {
    window.localStorage.setItem('ac.mapHint.dismissed', 'yes');
    expect(loadMapHintDismissed()).toBe(false);
  });
});
