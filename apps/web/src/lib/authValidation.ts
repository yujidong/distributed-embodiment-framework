/**
 * R2-UX-21a / UX-R2 batch 8: AuthPage inline validation, pure so the rules
 * are vitest-direct. The login/register form is `noValidate` — the browser's
 * native bubbles are English-only and clash with the Chinese UI, so the page
 * validates here and renders per-field localized errors
 * (authPage.validation.*). Server-side teaching errors (409 duplicate email,
 * 403/410 invite gate) are unaffected — they still render verbatim.
 */

export type AuthMode = 'login' | 'register';

export type AuthField = 'displayName' | 'email' | 'password' | 'inviteCode';

export type AuthValidationKey =
  | 'validation.displayNameRequired'
  | 'validation.emailRequired'
  | 'validation.emailInvalid'
  | 'validation.passwordRequired'
  | 'validation.passwordTooShort'
  | 'validation.inviteCodeRequired';

export interface AuthFormValues {
  displayName: string;
  email: string;
  password: string;
  inviteCode: string;
}

/** Deliberately permissive: local@domain.tld — the server stays the authority. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const REGISTER_PASSWORD_MIN_LENGTH = 8;

/**
 * Validate the auth form for the current mode. Returns a field → i18n-key
 * map (empty = valid). Register-only rules (display name, 8-char password,
 * invite code when the gate is on) do not fire in login mode.
 */
export function validateAuthForm(
  mode: AuthMode,
  values: AuthFormValues,
  inviteOnly: boolean,
): Partial<Record<AuthField, AuthValidationKey>> {
  const errors: Partial<Record<AuthField, AuthValidationKey>> = {};
  if (mode === 'register' && values.displayName.trim() === '') {
    errors.displayName = 'validation.displayNameRequired';
  }
  const email = values.email.trim();
  if (email === '') {
    errors.email = 'validation.emailRequired';
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = 'validation.emailInvalid';
  }
  if (values.password === '') {
    errors.password = 'validation.passwordRequired';
  } else if (mode === 'register' && values.password.length < REGISTER_PASSWORD_MIN_LENGTH) {
    errors.password = 'validation.passwordTooShort';
  }
  if (mode === 'register' && inviteOnly && values.inviteCode.trim() === '') {
    errors.inviteCode = 'validation.inviteCodeRequired';
  }
  return errors;
}
