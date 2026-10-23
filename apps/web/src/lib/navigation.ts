/**
 * Navigation holder — a module-level reference to the router's navigate
 * function, registered once by App (which lives inside the Router).
 *
 * The zustand store and class components (ErrorBoundary) cannot call
 * useNavigate; they go through navigateTo instead. Component code should
 * prefer useNavigate directly.
 */

import type { NavigateFunction, NavigateOptions } from 'react-router-dom';

let navigateFn: NavigateFunction | null = null;

/** Called once from App on mount (and whenever the navigate identity changes). */
export function setNavigate(fn: NavigateFunction): void {
  navigateFn = fn;
}

/** Navigate from non-component code. No-ops before the router is mounted. */
export function navigateTo(path: string, options?: NavigateOptions): void {
  navigateFn?.(path, options);
}
