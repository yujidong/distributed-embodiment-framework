/**
 * G2: 共享加载占位——替换全站散落的裸文本「加载中…」Suspense fallback。
 * 一个简单的旋转指示 + 文案（默认 common:loading），aria-live 礼貌播报。
 */

import { useTranslation } from 'react-i18next';

export function Loading({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div className={`loading-indicator${className ? ` ${className}` : ''}`} role="status">
      <span className="loading-indicator__spinner" aria-hidden />
      <span>{label ?? t('loading')}</span>
    </div>
  );
}
