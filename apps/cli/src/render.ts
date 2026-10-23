/**
 * Shared human-render helpers (T40, R4) — ONE wording per concept, imported
 * by every command face that renders it. R102's failure mode was two faces
 * drifting apart on the same fact (service get warned about declaration
 * drift, agreement get stayed silent); the fix is a shared helper, never a
 * second copy of the sentence. Pure string functions — render-test fixtures
 * cover them (T22 discipline).
 */

/**
 * T40a (R4, u3-F2/u2#2): the declaration-drift warning — the SAME sentence
 * `service get` and `agreement get` render when a provider agent does not
 * declare a service's capability (the bound device still executes it; only
 * the declaration/governance face drifted, so the marker disappears again
 * once the capability is re-declared). BUG-08 ②: timeless wording
 * ("未声明") — the drifted-from-birth case never declared the capability,
 * so "已不再声明" asserted a withdrawal that never happened. Callers
 * prepend their own indentation; the ⚠ marker is part of the shared wording.
 */
export function declarationDriftWarning(capability: string): string {
  return (
    `⚠ provider 未声明 '${capability}'（设备仍可执行）— ` +
    'catalog/agreement rows are marked declaredByProvider:false until re-declared'
  );
}
