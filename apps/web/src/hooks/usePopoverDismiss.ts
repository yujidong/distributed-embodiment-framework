/**
 * V6: popover 的 Esc / 点击外部关闭。ref 包住「触发按钮 + 弹层」的容器，
 * 因此点触发按钮不算「外部」（开/关仍由按钮自己的 onClick 控制）。
 */

import { useEffect, type RefObject } from 'react';

export function usePopoverDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const el = ref.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [ref, open, onClose]);
}
