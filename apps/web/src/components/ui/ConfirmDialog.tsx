/**
 * ConfirmDialog — the house confirmation modal (replaces window.confirm).
 *
 * Three tones: `info` (plain), `warn` (caution — amber icon), `danger`
 * (destructive — solid red confirm button and initial focus on CANCEL so
 * pressing Enter/Space blindly cannot commit the action).
 *
 * Two ways to use it:
 *   - Controlled: render <ConfirmDialog open … onConfirm onCancel /> yourself.
 *   - Promise-based: `const confirm = useConfirm(); if (await confirm({…})) …`
 *     backed by the store's confirmRequest and the global <ConfirmHost/>
 *     (mounted in App next to <Toasts/>).
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';

import { useAppStore, type ConfirmTone } from '../../store/useAppStore';
import { Icon } from './Icon';

export interface ConfirmDialogProps {
  open: boolean;
  /** Short header; omit for a single-message dialog (body is the message). */
  title?: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_ICON = { info: Info, warn: AlertTriangle, danger: OctagonAlert } as const;

export function ConfirmDialog({
  open,
  title,
  body,
  confirmText,
  cancelText,
  tone = 'info',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Danger tone: focus CANCEL first — the destructive button must be a
    // deliberate click, never the default focus target.
    (tone === 'danger' ? cancelRef : confirmRef).current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, tone, onCancel]);

  if (!open) return null;
  const ToneIcon = TONE_ICON[tone];
  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className={`confirm-dialog confirm-dialog--${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title ?? body}
        onClick={event => event.stopPropagation()}
      >
        <div className="confirm-dialog__head">
          <Icon icon={ToneIcon} size={18} className="confirm-dialog__icon" />
          {title !== undefined && <p className="confirm-dialog__title">{title}</p>}
        </div>
        <p className={`confirm-dialog__body${title === undefined ? ' confirm-dialog__body--solo' : ''}`}>
          {body}
        </p>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>
            {cancelText ?? t('ui.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? 'danger-button danger-button--solid' : 'primary-button'}
            onClick={onConfirm}
          >
            {confirmText ?? t('ui.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Store-driven host — mount once near the app root (App.tsx). */
export function ConfirmHost() {
  const request = useAppStore(s => s.confirmRequest);
  const resolveConfirm = useAppStore(s => s.resolveConfirm);
  if (request === null) return null;
  return (
    <ConfirmDialog
      open
      title={request.title}
      body={request.body}
      confirmText={request.confirmText}
      cancelText={request.cancelText}
      tone={request.tone ?? 'info'}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />
  );
}

/** Promise-based confirm: `if (await confirm({ body, tone: 'danger' })) …`. */
export function useConfirm() {
  return useAppStore(s => s.requestConfirm);
}
