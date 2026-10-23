/**
 * R31 QW5 — useVisibleInterval 可见性门控轮询：
 *
 * - 可见时立即执行一次并按节奏运行；
 * - document.hidden 时跳过 tick（后台标签页零请求）；
 * - visibilitychange → visible 触发一次补拉；
 * - enabled=false 时不启动（卸载 interval）。
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useVisibleInterval } from '../hooks/useVisibleInterval';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('useVisibleInterval (R31 QW5)', () => {
  it('可见时：挂载立即执行 + 按 interval 执行', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => useVisibleInterval(callback, 1500));

    expect(callback).toHaveBeenCalledTimes(1); // 挂载即一拍

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(callback).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('隐藏时跳过 tick；回到可见补拉一次后恢复节奏', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => useVisibleInterval(callback, 1500));
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      setHidden(true);
      vi.advanceTimersByTime(6000);
    });
    expect(callback).toHaveBeenCalledTimes(1); // 后台零执行

    act(() => {
      setHidden(false); // visibilitychange → visible：立即补一拍
    });
    expect(callback).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(callback).toHaveBeenCalledTimes(3); // 节奏恢复
  });

  it('enabled=false：不执行也不注册 interval', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useVisibleInterval(callback, 100, enabled), {
      initialProps: { enabled: false },
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1); // 重新启用立即执行
  });

  it('卸载清理 interval 与 visibilitychange 监听', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const { unmount } = renderHook(() => useVisibleInterval(callback, 100));
    unmount();

    act(() => {
      vi.advanceTimersByTime(1000);
      setHidden(false); // 卸载后的事件不再触发回调
    });
    expect(callback).toHaveBeenCalledTimes(1); // 仅挂载那一拍
  });
});
