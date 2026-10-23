/**
 * UX-W3 device-template query — the built-in registry behind
 * GET /api/device-templates (DeviceForm suggestions, CatalogPanel type
 * filter, the interior-walk deploy palette).
 *
 * Honest degradation: a failed fetch does NOT empty the pickers — the hook
 * swaps in the small static fallback wordlist and flags `degraded` so the UI
 * can say「模板目录不可用，已回落到内置词表」instead of pretending the full
 * catalog loaded.
 */

import { useQuery } from '@tanstack/react-query';

import * as api from '../api/client';
import type { DeviceTemplate } from '../api/types';
import { FALLBACK_DEVICE_TEMPLATES } from '../lib/deviceTemplates';
import { queryKeys } from '../lib/queryClient';

export interface DeviceTemplatesResult {
  templates: DeviceTemplate[];
  /** true = the API call failed and `templates` is the static fallback. */
  degraded: boolean;
  isLoading: boolean;
}

export function useDeviceTemplates(): DeviceTemplatesResult {
  const query = useQuery({
    queryKey: queryKeys.deviceTemplates.list(),
    queryFn: () => api.listDeviceTemplates(),
    // Bundled read-only content (sorted registry) — cache for the session.
    staleTime: Infinity,
    retry: false,
  });
  if (query.isError) {
    return { templates: FALLBACK_DEVICE_TEMPLATES, degraded: true, isLoading: false };
  }
  return { templates: query.data ?? [], degraded: false, isLoading: query.isLoading };
}
