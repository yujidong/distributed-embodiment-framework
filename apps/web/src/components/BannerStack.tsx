/**
 * BannerStack (UX-W1) — 页面级横幅的统一收纳容器：
 *
 * - 同屏横幅（会话状态 / 拓扑漂移 / 决策态势 / 导读 …）不再各自占一行叠
 *   罗汉，统一进栈，按级别排序：安全(safety) > 治理(governance) > 信息(info)，
 *   同级保持传入顺序（稳定排序）；
 * - 超过 BANNER_STACK_VISIBLE_COUNT 条时多余的折叠为「还有 N 条」，点击展开 /
 *   收起（折叠状态只是视图态，不持久化）；
 * - 每条带级别色条（CSS ::before，safety= danger / governance= warn /
 *   info= accent）；传入 onDismiss 的条目才渲染关闭钮，不传 = 常驻。
 *
 * 不收纳的横幅：EstopBanner（急停是全局安全面，fixed 底部、永不折叠）、
 * DemoModeBanner（演示旁白条挂在路由树外、覆盖任意页面）。两者只在视觉
 * 上对齐色条语言（styles.css UX-W1 段）。
 *
 * 排序与折叠拆分是纯函数（sortBannerItems / splitBannerItems），vitest 直测。
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 横幅级别：安全 > 治理 > 信息（栈内排序即按此优先级）。 */
export type BannerTone = 'safety' | 'governance' | 'info';

export interface BannerStackItem {
  /** 稳定 key，同时是排查用的语义标识（如 'world-session' / 'drift'）。 */
  id: string;
  tone: BannerTone;
  content: ReactNode;
  /** 传入即可关闭（栈渲染关闭钮并回调）；不传 = 常驻条目。 */
  onDismiss?: () => void;
}

const TONE_PRIORITY: Record<BannerTone, number> = { safety: 0, governance: 1, info: 2 };

/** 折叠阈值：可见条目超过该数时，多余的收进「还有 N 条」。 */
export const BANNER_STACK_VISIBLE_COUNT = 2;

/** 按级别排序：safety > governance > info；同级保持传入顺序（sort 稳定）。 */
export function sortBannerItems<T extends Pick<BannerStackItem, 'tone'>>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => TONE_PRIORITY[a.tone] - TONE_PRIORITY[b.tone]);
}

/** 折叠拆分：前 visibleCount 条直接可见，返回剩余（被折叠）条数。 */
export function splitBannerItems<T>(
  items: readonly T[],
  visibleCount: number = BANNER_STACK_VISIBLE_COUNT,
): { visible: T[]; collapsedCount: number } {
  const limit = Math.max(0, visibleCount);
  return {
    visible: items.slice(0, limit),
    collapsedCount: Math.max(0, items.length - limit),
  };
}

export function BannerStack({ items }: { items: readonly BannerStackItem[] }) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const sorted = sortBannerItems(items);
  if (sorted.length === 0) return null;
  const { visible, collapsedCount } = splitBannerItems(sorted);
  const shown = expanded ? sorted : visible;
  return (
    <div className="banner-stack">
      {shown.map(item => (
        <div key={item.id} className={`banner-stack__item banner-stack__item--${item.tone}`}>
          <div className="banner-stack__content">{item.content}</div>
          {item.onDismiss !== undefined && (
            <button
              type="button"
              className="banner-stack__dismiss"
              aria-label={t('bannerStack.dismiss')}
              onClick={item.onDismiss}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      ))}
      {collapsedCount > 0 && (
        <button
          type="button"
          className="banner-stack__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? (
            <>
              <ChevronUp size={13} aria-hidden /> {t('bannerStack.collapse')}
            </>
          ) : (
            <>
              <ChevronDown size={13} aria-hidden /> {t('bannerStack.more', { count: collapsedCount })}
            </>
          )}
        </button>
      )}
    </div>
  );
}
