/**
 * NotFoundPage — the router's catch-all (`*`): an unknown URL lands here
 * with a link back to the workbench.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation('notFoundPage');
  return (
    <div className="page-note error-boundary">
      <h2 className="error-boundary__title">{t('title')}</h2>
      <p>{t('body')}</p>
      <div className="error-boundary__actions">
        <Link className="link-button" to="/">
          {t('backToWorkbench')}
        </Link>
      </div>
    </div>
  );
}
