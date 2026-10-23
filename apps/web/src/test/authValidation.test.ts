/**
 * authValidation tests (R2-UX-21a / UX-R2 batch 8): the pure rules behind
 * AuthPage's inline localized validation (form noValidate — the browser's
 * English bubbles no longer fire). Register-only rules must not fire in
 * login mode; the invite code is required only when the gate is on.
 */

import { describe, expect, it } from 'vitest';

import { validateAuthForm, type AuthFormValues } from '../lib/authValidation';

const VALUES: AuthFormValues = {
  displayName: '小王',
  email: 'a@example.com',
  password: 'super-secret',
  inviteCode: 'EAF-ABCDE-23456',
};

describe('validateAuthForm', () => {
  it('accepts a complete login and a complete register form', () => {
    expect(validateAuthForm('login', VALUES, false)).toEqual({});
    expect(validateAuthForm('register', VALUES, true)).toEqual({});
  });

  it('login mode only checks email + password presence', () => {
    const errors = validateAuthForm(
      'login',
      { displayName: '', email: '', password: '', inviteCode: '' },
      true,
    );
    expect(errors).toEqual({
      email: 'validation.emailRequired',
      password: 'validation.passwordRequired',
    });
    // No register-only keys leak into login mode.
    expect(errors.displayName).toBeUndefined();
    expect(errors.inviteCode).toBeUndefined();
  });

  it('register requires a display name', () => {
    const errors = validateAuthForm('register', { ...VALUES, displayName: '  ' }, false);
    expect(errors.displayName).toBe('validation.displayNameRequired');
  });

  it('flags a malformed email separately from a missing one', () => {
    expect(validateAuthForm('login', { ...VALUES, email: 'not-an-email' }, false).email).toBe(
      'validation.emailInvalid',
    );
    expect(validateAuthForm('login', { ...VALUES, email: ' ' }, false).email).toBe(
      'validation.emailRequired',
    );
  });

  it('enforces the 8-char password only in register mode', () => {
    expect(validateAuthForm('register', { ...VALUES, password: 'short' }, false).password).toBe(
      'validation.passwordTooShort',
    );
    // Login never blocks a short password — the stored hash decides.
    expect(validateAuthForm('login', { ...VALUES, password: 'short' }, false)).toEqual({});
  });

  it('requires the invite code only when the gate is on', () => {
    expect(validateAuthForm('register', { ...VALUES, inviteCode: '' }, true).inviteCode).toBe(
      'validation.inviteCodeRequired',
    );
    expect(validateAuthForm('register', { ...VALUES, inviteCode: '' }, false).inviteCode).toBeUndefined();
  });
});
