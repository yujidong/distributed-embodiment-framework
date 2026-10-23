/**
 * EstopBanner — the global emergency-stop banner (P3b): while a user is
 * logged in it polls GET /api/hass/estop every 5s and, when the E-stop is
 * engaged, shows a fixed red banner ("所有真实设备指令已被拦截") everywhere
 * in the UI with a 解除 button. Hidden when logged out (no polling) and when
 * inactive. The state → banner derivation lives in lib/hass (unit-tested).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import type { HassEstopState } from '../api/types';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { estopBannerModel } from '../lib/hass';
import { useAppStore } from '../store/useAppStore';

const ESTOP_POLL_MS = 5000;

export function EstopBanner() {
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const { t } = useTranslation('estopBanner');
  const [state, setState] = useState<HassEstopState | null>(null);

  // Logout clears the last banner state (no polling while logged out).
  useEffect(() => {
    if (user === null) setState(null);
  }, [user]);

  // R31 F12: visibility-gated — the e-stop poll only runs in a visible tab.
  useVisibleInterval(() => {
    void (async () => {
      try {
        setState(await api.getHassEstop());
      } catch {
        // Tolerate failures — the banner simply keeps its last state.
      }
    })();
  }, ESTOP_POLL_MS, user !== null);

  const model = estopBannerModel(state);
  if (!model.visible) return null;

  const clear = async () => {
    try {
      setState(await api.clearHassEstop());
    } catch (error) {
      pushToast(t('clearFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div className="estop-banner" role="alert">
      <span className="estop-banner__text">{model.text}</span>
      {/* R2-UX-04: positive scope note — only real-device (hass) commands
          are gated; the simulation world is unaffected (R2-WONT-02). */}
      <span className="estop-banner__scope">{t('scopeNote')}</span>
      <button className="estop-banner__clear" onClick={() => void clear()}>
        {t('clear')}
      </button>
    </div>
  );
}
