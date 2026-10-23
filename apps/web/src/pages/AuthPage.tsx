/**
 * AuthPage — login/register toggle. Errors render inline (409 duplicate
 * email, 401 bad credentials, 400 validation); on success the store's auth
 * slice is filled from GET /auth/me (never the token) and the guard routes
 * home. Alpha capacity gating (EAF_INVITE_ONLY): when the public health
 * probe reports auth.inviteOnly, the register form collects an invite code
 * and the gate's 403/410 rejections render as localized teaching copy.
 *
 * R2-UX-21a / UX-R2: the form is `noValidate` — client-side checks run
 * through lib/authValidation.ts and render per-field localized errors
 * (auth-field__error) instead of the browser's English-only bubbles. Field
 * edits clear both their own error and the submit banner (R2-UX-21b).
 */

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { usePublicHealth } from '../hooks/useEnvironments';
import {
  validateAuthForm,
  type AuthField,
  type AuthValidationKey,
} from '../lib/authValidation';
import { useAppStore } from '../store/useAppStore';

type Mode = 'login' | 'register';

type FieldErrors = Partial<Record<AuthField, AuthValidationKey>>;

export function AuthPage() {
  const login = useAppStore(s => s.login);
  const register = useAppStore(s => s.register);
  const { t } = useTranslation('authPage');
  // Public probe — tells us whether the invite-code field is required. When
  // the probe fails (offline server), default to hiding the field; the
  // server's 403 INVITE_REQUIRED still teaches the requirement on submit.
  const health = usePublicHealth();
  const inviteOnly = health.data?.auth.inviteOnly === true;

  const [mode, setMode] = useState<Mode>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // A1: 密码可见性切换。
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // R2-UX-21b: any edit clears the stale submit banner; the edited field's
  // own inline error clears too (the user is fixing it right now).
  const editField = (field: AuthField, set: (value: string) => void) => (value: string) => {
    set(value);
    setError(null);
    setFieldErrors(current => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // Inline localized validation replaces the native bubbles (noValidate).
    const errors = validateAuthForm(mode, { displayName, email, password, inviteCode }, inviteOnly);
    if (Object.values(errors).some(key => key !== undefined)) {
      setFieldErrors(errors);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    const failure =
      mode === 'login'
        ? await login(email.trim(), password)
        : await register(displayName.trim(), email.trim(), password, inviteCode.trim() || undefined);
    setBusy(false);
    if (failure) setError(failure);
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setFieldErrors({});
  };

  const fieldError = (field: AuthField) => {
    const key = fieldErrors[field];
    return key ? (
      <span className="auth-field__error" role="alert">
        {t(key)}
      </span>
    ) : null;
  };

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img className="auth-brand__logo" src="/logo.svg" alt="" />
        <h1 className="auth-brand__name">Embodied Agent Framework</h1>
        <p className="auth-brand__tagline">{t('tagline')}</p>
      </div>
      <form className="auth-card" noValidate onSubmit={event => void submit(event)}>
        <div className="auth-card__tabs">
          <button
            type="button"
            className={mode === 'login' ? 'auth-tab auth-tab--active' : 'auth-tab'}
            onClick={() => switchMode('login')}
          >
            {t('tabLogin')}
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'auth-tab auth-tab--active' : 'auth-tab'}
            onClick={() => switchMode('register')}
          >
            {t('tabRegister')}
          </button>
        </div>
        {mode === 'register' && (
          <label className="auth-field">
            <span className="auth-field__label">{t('displayNameLabel')}</span>
            <input
              value={displayName}
              onChange={event => editField('displayName', setDisplayName)(event.target.value)}
              placeholder={t('displayNamePlaceholder')}
              aria-invalid={fieldErrors.displayName !== undefined}
            />
            {fieldError('displayName')}
          </label>
        )}
        <label className="auth-field">
          <span className="auth-field__label">{t('emailLabel')}</span>
          <input
            type="email"
            value={email}
            onChange={event => editField('email', setEmail)(event.target.value)}
            placeholder="you@example.com"
            aria-invalid={fieldErrors.email !== undefined}
          />
          {fieldError('email')}
        </label>
        <label className="auth-field">
          <span className="auth-field__label">{t('passwordLabel')}</span>
          <span className="auth-field__password">
            <input
              type={passwordVisible ? 'text' : 'password'}
              value={password}
              onChange={event => editField('password', setPassword)(event.target.value)}
              placeholder={mode === 'register' ? t('passwordRegisterPlaceholder') : ''}
              aria-invalid={fieldErrors.password !== undefined}
            />
            <button
              type="button"
              className="link-button auth-field__toggle-password"
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible(visible => !visible)}
            >
              {passwordVisible ? t('hidePassword') : t('showPassword')}
            </button>
          </span>
          {fieldError('password')}
        </label>
        {mode === 'register' && inviteOnly && (
          <label className="auth-field">
            <span className="auth-field__label">{t('inviteCodeLabel')}</span>
            <input
              value={inviteCode}
              onChange={event => editField('inviteCode', setInviteCode)(event.target.value)}
              placeholder={t('inviteCodePlaceholder')}
              autoComplete="off"
              aria-invalid={fieldErrors.inviteCode !== undefined}
            />
            <span className="auth-field__hint">{t('inviteCodeHint')}</span>
            {fieldError('inviteCode')}
          </label>
        )}
        {error && <p className="auth-card__error">{error}</p>}
        <button className="primary-button auth-card__submit" disabled={busy} type="submit">
          {busy ? t('submitBusy') : mode === 'login' ? t('submitLogin') : t('submitRegister')}
        </button>
      </form>
    </div>
  );
}
