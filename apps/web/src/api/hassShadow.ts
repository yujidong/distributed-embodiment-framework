/**
 * Shadow-world API (HIL 反向映射 P2) — /api/environments/:id/shadow wrappers.
 *
 * Same shape as hassReverseSync.ts: a SEPARATE module from client.ts (that
 * file is owned by another workstream), cookie session, the server's
 * `{ error: { code, message } }` envelope re-thrown as ApiClientError.
 */

import { ApiClientError } from './client';
import type { components } from './generated';

type Schema = components['schemas'];

export type HassShadowStatus = Schema['HassShadowStatus'];
export type HassShadowObservation = Schema['HassShadowObservation'];
export type HassShadowDeviceStatus = Schema['HassShadowDeviceStatus'];

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = body as { error?: { code?: string; message?: string } } | null;
    if (errorBody?.error) {
      throw new ApiClientError(
        response.status,
        errorBody.error.code ?? 'HTTP_ERROR',
        errorBody.error.message ?? `HTTP ${response.status}`,
      );
    }
    throw new ApiClientError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
  }
  return body as T;
}

/** GET /api/environments/:id/shadow — 404 (SHADOW_NOT_FOUND) when none. */
export function getHassShadow(envId: string): Promise<HassShadowStatus> {
  return request<HassShadowStatus>(`/environments/${envId}/shadow`);
}

/** POST /api/environments/:id/shadow — create (or re-fork with refresh). */
export function createHassShadow(envId: string, refresh = false): Promise<HassShadowStatus> {
  return request<HassShadowStatus>(`/environments/${envId}/shadow`, {
    method: 'POST',
    body: JSON.stringify(refresh ? { refresh: true } : {}),
  });
}

/** DELETE /api/environments/:id/shadow — stop the fork. */
export function deleteHassShadow(envId: string): Promise<void> {
  return request<void>(`/environments/${envId}/shadow`, { method: 'DELETE' });
}
