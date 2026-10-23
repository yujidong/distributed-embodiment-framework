/**
 * Reverse-sync API (HIL 反向映射 P1) — /api/hass/reverse-sync wrappers.
 *
 * Deliberately a SEPARATE module from client.ts (that file is owned by
 * another workstream): same conventions though — cookie session
 * (`credentials: 'include'`), the server's `{ error: { code, message } }`
 * envelope re-thrown as ApiClientError.
 */

import { ApiClientError } from './client';
import type { components } from './generated';

type Schema = components['schemas'];

export type HassReverseSyncPolicy = Schema['HassReverseSyncPolicy'];
export type HassReverseSyncChange = Schema['HassReverseSyncChange'];
export type HassReverseSyncDriftEntry = Schema['HassReverseSyncDriftEntry'];
export type HassReverseSyncAlignment = Schema['HassReverseSyncAlignment'];
export type HassReverseSyncStatus = Schema['HassReverseSyncStatus'];
export type HassReverseSyncAlignResult = Schema['HassReverseSyncAlignResult'];

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
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

/** GET /api/hass/reverse-sync — policy + E-stop + current drift + recent. */
export function getHassReverseSync(): Promise<HassReverseSyncStatus> {
  return request<HassReverseSyncStatus>('/hass/reverse-sync');
}

/** POST /api/hass/reverse-sync/align-now — one manual snapshot alignment. */
export function alignHassReverseSyncNow(): Promise<HassReverseSyncAlignResult> {
  return request<HassReverseSyncAlignResult>('/hass/reverse-sync/align-now', { method: 'POST' });
}
