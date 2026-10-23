/**
 * G4: HH:MM:SS 时钟时间——跟随当前 i18n 语言（此前多处硬编码 'zh-CN'，
 * 英文界面也显示中文区域格式）。无效输入原样返回。
 */

import i18n from '../i18n/config';

export function localClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(i18n.language, { hour12: false });
}
