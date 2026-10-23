/**
 * useInteriorDeploy placement-failure classification (DEPLOY-F1): the walk
 * page flashes a localized hint when the server rejects a placement —
 * 401/403 (anonymous / non-member) reads differently from other errors.
 */

import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../api/client';
import { placeFailureKind } from '../hooks/useInteriorDeploy';

describe('placeFailureKind', () => {
  it('classifies 403 (non-member) as forbidden', () => {
    expect(placeFailureKind(new ApiClientError(403, 'FORBIDDEN', 'not a member'))).toBe('forbidden');
  });

  it('classifies 401 (anonymous) as forbidden', () => {
    expect(placeFailureKind(new ApiClientError(401, 'UNAUTHORIZED', 'login required'))).toBe('forbidden');
  });

  it('classifies other API errors as generic errors', () => {
    expect(placeFailureKind(new ApiClientError(500, 'INTERNAL', 'boom'))).toBe('error');
    expect(placeFailureKind(new ApiClientError(422, 'VALIDATION', 'bad payload'))).toBe('error');
  });

  it('classifies non-API failures (network etc.) as generic errors', () => {
    expect(placeFailureKind(new TypeError('fetch failed'))).toBe('error');
    expect(placeFailureKind('weird')).toBe('error');
    expect(placeFailureKind(undefined)).toBe('error');
  });
});
