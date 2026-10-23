/**
 * ObservabilityCard — the workbench 系统 card (P4-4, admins only)
 *
 * Polls GET /api/admin/observability every 10 s and renders a compact row
 * list: 运行时间 / 运行中仿真 / LLM tokens（自启动）/ 缓存命中率 / 429 响应数.
 * The WorkbenchPage mounts it only when `user.isAdmin` (the endpoint 403s
 * otherwise); a failed poll keeps the last good data (same tolerance as the
 * E-stop banner). The row derivation lives in lib/observability (unit-tested).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import type { AdminObservability } from '../api/types';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { observabilityCardRows } from '../lib/observability';

const OBSERVABILITY_POLL_MS = 10_000;

export function ObservabilityCard() {
  const { t } = useTranslation('observability');
  const [summary, setSummary] = useState<AdminObservability | null>(null);

  // R31 F12: visibility-gated — the admin summary poll only runs in a
  // visible tab (one catch-up tick on return).
  useVisibleInterval(() => {
    void (async () => {
      try {
        setSummary(await api.getAdminObservability());
      } catch {
        // Tolerate failures (403 after admin-list change, server down) — the
        // card keeps its last good data.
      }
    })();
  }, OBSERVABILITY_POLL_MS);

  if (summary === null) return null;

  return (
    <section className="workbench-section observability-card">
      <h4 className="workbench-section__title">{t('cardHeader')}</h4>
      <div className="object-list">
        {observabilityCardRows(summary).map(row => (
          <div key={row.label} className="object-list__item workbench-row" title={row.title}>
            <span className="object-list__name">{row.label}</span>
            <span className="object-list__meta">{row.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
