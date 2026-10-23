/**
 * T4 相对时间（「3 分钟前」）：收件箱/日志类列表的默认时间表达；超过 7
 * 天回落为本地化绝对日期。跟随当前 i18n 语言，`now` 可注入以便测试。
 */

import i18n from '../i18n/config';

const MINUTE_SEC = 60;
const HOUR_SEC = 3600;
const DAY_SEC = 86400;
const WEEK_SEC = 7 * DAY_SEC;

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const t = i18n.getFixedT(i18n.language, 'common');
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < MINUTE_SEC) return t('time.justNow');
  if (diffSec < HOUR_SEC) return t('time.minutesAgo', { count: Math.floor(diffSec / MINUTE_SEC) });
  if (diffSec < DAY_SEC) return t('time.hoursAgo', { count: Math.floor(diffSec / HOUR_SEC) });
  if (diffSec < WEEK_SEC) return t('time.daysAgo', { count: Math.floor(diffSec / DAY_SEC) });
  return new Date(ms).toLocaleDateString(i18n.language);
}
