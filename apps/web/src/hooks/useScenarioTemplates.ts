/**
 * Scenario-template queries (W1b onboarding) — the create-environment
 * dialog's 模板 tab. The template list is bundled seed content (immutable for
 * the process lifetime server-side), localized per request: the query carries
 * the active i18n language as `?lang=` and is keyed by it, so switching the
 * UI language refetches the localized names/descriptions. One-click creation
 * reuses api.createEnvironment directly from the dialog, same as the
 * blank/import submit paths.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { queryKeys } from '../lib/queryClient';

/** GET /api/scenario-templates — summaries of the bundled seed scenarios. */
export function useScenarioTemplateList() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useQuery({
    queryKey: queryKeys.scenarioTemplates.list(lang),
    queryFn: () => api.getScenarioTemplates(lang),
  });
}
