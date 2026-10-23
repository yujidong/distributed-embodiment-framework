/**
 * Canonical role-label resolver — kills the 5× duplication of `ROLE_LABEL`
 * dictionaries across WorkbenchPage, EnvironmentsHomePage, WorldViewPage,
 * WorldSidebar, CollaborationsPanel. Components call `roleLabel(role)` and
 * get the active-locale string; the keys live in the i18n `common.role`
 * namespace.
 */

import type { EnvRole } from '../api/types';
import { useTranslation } from 'react-i18next';

export function useRoleLabel() {
  const { t } = useTranslation('common');
  return (role: EnvRole | undefined | null): string => {
    if (role === 'owner') return t('role.owner');
    if (role === 'builder') return t('role.builder');
    if (role === 'viewer') return t('role.viewer');
    return role ?? '';
  };
}
