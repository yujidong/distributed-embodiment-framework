/**
 * UX-W3 template parameter form — pure validation for the parameterized
 * scenario templates (meta.vars). The create dialog's 模板 tab opens a small
 * form for cards whose summary carries `vars`; the validated values go to
 * POST /api/scenario-templates/:id/instantiate and the expanded scenario is
 * imported through the standing POST /api/environments path.
 */

import type { ScenarioTemplateVar } from '../api/types';

/** Raw form state: one string input per declared var, prefilled with defaults. */
export type TemplateVarInputs = Record<string, string>;

export function defaultTemplateVarInputs(vars: readonly ScenarioTemplateVar[]): TemplateVarInputs {
  const inputs: TemplateVarInputs = {};
  for (const v of vars) inputs[v.name] = String(v.default);
  return inputs;
}

export interface TemplateVarFieldError {
  name: string;
  /** i18n key under `environments.create.templateVars.*`. */
  reason: 'notInt' | 'outOfRange';
}

export type TemplateVarValidation =
  | { ok: true; values: Record<string, number> }
  | { ok: false; errors: TemplateVarFieldError[] };

/**
 * Validate the raw inputs against the declared vars: every declared var must
 * be an integer within [min, max]. Undeclared inputs are ignored; a missing
 * input falls back to the declared default (the server does the same, but
 * the form always prefills so this is just belt-and-braces).
 */
export function validateTemplateVarInputs(
  vars: readonly ScenarioTemplateVar[],
  inputs: TemplateVarInputs,
): TemplateVarValidation {
  const values: Record<string, number> = {};
  const errors: TemplateVarFieldError[] = [];
  for (const v of vars) {
    const raw = (inputs[v.name] ?? '').trim();
    if (raw === '') {
      values[v.name] = v.default;
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      errors.push({ name: v.name, reason: 'notInt' });
      continue;
    }
    if (value < v.min || value > v.max) {
      errors.push({ name: v.name, reason: 'outOfRange' });
      continue;
    }
    values[v.name] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
