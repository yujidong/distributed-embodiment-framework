/**
 * OnboardingChecklist (W1b) — the workbench 新手引导 card shown under the
 * greeting header until all three steps are done (or the user dismisses it;
 * persisted in localStorage). Step states derive from the overview payload
 * (lib/onboarding.ts); each unfinished step deep-links to where it can be
 * completed:
 * - ① → /environments?create=templates (create dialog opens on the 模板 tab)
 * - ② → /environments/:firstEnvId?tab=blueprints (sidebar opens on 蓝图)
 * - ③ → /environments/:firstEnvId (world view, sim controls on top)
 *
 * R2-FEAT-07: reaching allDone no longer makes the card vanish silently —
 * it renders once as an all-checked celebration (「完成」) and only hides
 * after the user closes that. Dismissal is recoverable: the workbench's
 * 「重新显示新手引导」entry calls resetOnboardingPrefs() and remounts the
 * card (the page keys it on a reset counter).
 */

import { useEffect, useState } from 'react';
import { Check, PartyPopper, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { MeOverview } from '../api/types';
import { deriveOnboarding, type OnboardingStepId } from '../lib/onboarding';
import { Icon } from './ui/Icon';

const DISMISS_KEY = 'ac.onboarding.dismissed';
const CELEBRATED_KEY = 'ac.onboarding.celebrated';

function loadFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Private mode etc. — the state lives for this session only.
  }
}

function clearFlag(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same private-mode caveat.
  }
}

/** 「重新显示新手引导」: undo both 不再显示 and the one-time celebration. */
export function resetOnboardingPrefs(): void {
  clearFlag(DISMISS_KEY);
  clearFlag(CELEBRATED_KEY);
}

/** Workbench offers the re-show entry only when there is something to undo. */
export function onboardingWasHidden(): boolean {
  return loadFlag(DISMISS_KEY) || loadFlag(CELEBRATED_KEY);
}

export function OnboardingChecklist({
  overview,
  onHidden,
}: {
  overview: MeOverview;
  /** Fired when the card hides itself (dismiss / celebration close) so the
   *  page can surface the 「重新显示新手引导」 recovery entry (R2-FEAT-07). */
  onHidden?: () => void;
}) {
  const { t } = useTranslation('workbench');
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(() => loadFlag(DISMISS_KEY));
  const [celebrated, setCelebrated] = useState(() => loadFlag(CELEBRATED_KEY));

  const state = deriveOnboarding(overview);

  // Steps can become undone again (the env was deleted, …): re-arm the
  // celebration so a later re-completion is acknowledged too.
  useEffect(() => {
    if (!state.allDone && celebrated) {
      clearFlag(CELEBRATED_KEY);
      setCelebrated(false);
    }
  }, [state.allDone, celebrated]);

  if (dismissed) return null;

  const dismiss = () => {
    saveFlag(DISMISS_KEY);
    setDismissed(true);
    onHidden?.();
  };

  const closeCelebration = () => {
    saveFlag(CELEBRATED_KEY);
    setCelebrated(true);
    onHidden?.();
  };

  const actionFor = (id: OnboardingStepId): (() => void) | null => {
    switch (id) {
      case 'createEnvironment':
        return () => navigate('/environments?create=templates');
      case 'installBlueprint':
        return state.firstEnvId !== null
          ? () => navigate(`/environments/${state.firstEnvId}?tab=blueprints`)
          : null;
      case 'runSimulation':
        return state.firstEnvId !== null
          ? () => navigate(`/environments/${state.firstEnvId}`)
          : null;
    }
  };

  // R2-FEAT-07: one-time all-checked celebration instead of vanishing.
  if (state.allDone) {
    if (celebrated) return null;
    return (
      <section className="onboarding onboarding--celebration">
        <div className="onboarding__header">
          <h4 className="onboarding__title">
            <Icon icon={PartyPopper} size={16} /> {t('onboarding.celebrateTitle')}
          </h4>
          <button className="link-button onboarding__dismiss" onClick={closeCelebration}>
            <Icon icon={X} size={14} /> {t('onboarding.celebrateClose')}
          </button>
        </div>
        <p className="onboarding__celebrate-note">{t('onboarding.celebrateNote')}</p>
        <ol className="onboarding__steps">
          {state.steps.map(step => (
            <li key={step.id} className="onboarding-step onboarding-step--done">
              <span className="onboarding-step__check">
                <Icon icon={Check} size={14} />
              </span>
              <span className="onboarding-step__text">
                <span className="onboarding-step__title">{t(`onboarding.${step.id}.title`)}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section className="onboarding">
      <div className="onboarding__header">
        <h4 className="onboarding__title">{t('onboarding.title')}</h4>
        <button className="link-button onboarding__dismiss" onClick={dismiss}>
          <Icon icon={X} size={14} /> {t('onboarding.dismiss')}
        </button>
      </div>
      <ol className="onboarding__steps">
        {state.steps.map(step => {
          const action = step.done ? null : actionFor(step.id);
          return (
            <li
              key={step.id}
              className={step.done ? 'onboarding-step onboarding-step--done' : 'onboarding-step'}
            >
              <span className="onboarding-step__check">
                {step.done && <Icon icon={Check} size={14} />}
              </span>
              <span className="onboarding-step__text">
                <span className="onboarding-step__title">{t(`onboarding.${step.id}.title`)}</span>
                <span className="onboarding-step__note">{t(`onboarding.${step.id}.note`)}</span>
              </span>
              {action !== null && (
                <button className="primary-button" onClick={action}>
                  {t(`onboarding.${step.id}.action`)}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
