/**
 * Toasts — transient notifications (world-stream edits by other members,
 * session expiry, action failures). Rendered globally; the store caps the
 * queue and auto-dismisses (4s; error toasts linger 8s — T8). Kinds tint the
 * border + icon (info/success/warn/error); the stack is an aria-live polite
 * region so screen readers announce arrivals.
 *
 * UX-W1: a toast is no longer click-anywhere-to-dismiss — each has an
 * explicit close button, an optional bold title above the body, and an
 * optional action button (runs its callback and dismisses the toast).
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAppStore, type ToastKind } from '../store/useAppStore';
import { Icon } from './ui/Icon';

const KIND_ICON: Record<ToastKind, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

export function Toasts() {
  const toasts = useAppStore(s => s.toasts);
  const dismissToast = useAppStore(s => s.dismissToast);
  const { t } = useTranslation('common');

  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <Icon icon={KIND_ICON[toast.kind]} size={16} className="toast__icon" />
          <div className="toast__content">
            {toast.title !== undefined && <p className="toast__title">{toast.title}</p>}
            <p className="toast__text">{toast.text}</p>
            {toast.action !== undefined && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  toast.action?.onClick();
                  dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            className="toast__close"
            aria-label={t('ui.closeToast')}
            onClick={() => dismissToast(toast.id)}
          >
            <Icon icon={X} size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
