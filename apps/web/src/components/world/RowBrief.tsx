/**
 * RowBrief — Track F 信息分级: the inline brief (简介) a sidebar list row
 * expands to on click, between the bare name and the full detail view.
 * Rendered below the row when the row's toggle state is open; ends with the
 * 「查看完整详情」 link-button that opens the existing detail view
 * (selectObject / selectService). The open state itself lives in the row
 * component (local useState).
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function RowBrief({
  onOpenDetail,
  children,
}: {
  /** Open the full detail view (the row's pre-Track-F click target). */
  onOpenDetail: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('worldSidebarLib');
  return (
    <div className="object-list__brief">
      {children}
      <button className="link-button object-list__brief-detail" onClick={onOpenDetail}>
        {t('viewFullDetails')}
      </button>
    </div>
  );
}
