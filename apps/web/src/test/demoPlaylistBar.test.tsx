/**
 * R2-UX-08 — DemoPlaylistBar 灰置三态文案：
 *
 * 不可播放原因拆开为「太短 / 已过」（「无剧本」保持无 chrome，引导在世界
 * 页入口）——不再一律给错误的「剧本时刻已过」tooltip。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DemoPlaylistBar } from '../components/DemoPlaylistBar';
import i18n from '../i18n/config';
import type { DemoScene } from '../lib/demoPlaylist';

const SCENES: DemoScene[] = [
  { id: 'e1', type: 'temperature-spike', zoneId: 'z', atSimTimeSec: 60 },
  { id: 'e2', type: 'smoke-detected', zoneId: 'z', atSimTimeSec: 120 },
  { id: 'e3', type: 'temperature-normal', zoneId: 'z', atSimTimeSec: 300 },
];

function renderBar(state: 'playable' | 'none' | 'tooShort' | 'elapsed', scenes = SCENES) {
  return render(
    <DemoPlaylistBar
      scenes={scenes}
      currentIndex={null}
      state={state}
      busy={false}
      onStart={() => undefined}
      onStop={() => undefined}
    />,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(cleanup);

describe('DemoPlaylistBar idle states (R2-UX-08)', () => {
  it('playable: enabled with the start hint', () => {
    renderBar('playable');
    const button = screen.getByRole('button', { name: /播放演示剧本/ });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('title')).toContain('逐幕播放');
  });

  it('tooShort: disabled with the too-short reason (not the elapsed lie)', () => {
    renderBar('tooShort', SCENES.slice(0, 2));
    const button = screen.getByRole('button', { name: /播放演示剧本/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('不足 3 个');
    expect(button.getAttribute('title')).not.toContain('时刻已过');
  });

  it('elapsed: disabled with the elapsed reason', () => {
    renderBar('elapsed');
    const button = screen.getByRole('button', { name: /播放演示剧本/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('时刻已过');
  });

  it('none (zero timed events): no console chrome — guidance lives on the world page', () => {
    const { container } = renderBar('none', []);
    expect(container.firstChild).toBeNull();
  });
});
