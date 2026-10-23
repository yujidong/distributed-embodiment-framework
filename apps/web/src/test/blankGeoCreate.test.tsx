/**
 * UX-W2 blank-world geo tier (CreateEnvironmentDialog, blank mode):
 *
 * - `buildBlankEnvironmentBody` (pure): grid/geo payload shapes + the
 *   center/zoom validation contract — mirrors the server empty-world branch
 *   (apps/server/src/routes/environments.ts:449-487 → parseMapDataInput →
 *   geo.ts parseGeoMapData: mapData.center {lat,lng} required, zoom 1..19).
 * - Page-level: the dialog shows the inline validation error and stays put
 *   on an invalid geo center (no POST fires); a valid geo form POSTs the
 *   wire body the server contract expects.
 *
 * After creation the page navigates to `/environments/:id` — the world page
 * there offers the geo/3D view tiers for geo environments (GeoWorldMap /
 * campus-3d are covered by their own probes, see
 * data/campus-e2e/ui/probe-campus3d*.mjs).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildBlankEnvironmentBody, EnvironmentsHomePage } from '../pages/EnvironmentsHomePage';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

// Assertions use the zh-CN bundle; pin it like the other page tests.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_FORM = {
  name: '  我的 geo 世界  ',
  description: '  太仓校区  ',
  mapType: 'grid' as const,
  geoLat: '',
  geoLng: '',
  geoZoom: '',
  visibility: 'private' as const,
  membersPlan: false,
};

describe('buildBlankEnvironmentBody', () => {
  it('builds the grid payload (no mapData) with trimmed fields', () => {
    const result = buildBlankEnvironmentBody(BASE_FORM);
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({
      name: '我的 geo 世界',
      description: '太仓校区',
      mapType: 'grid',
      visibility: 'private',
    });
  });

  it('builds the geo payload with center and optional zoom', () => {
    const result = buildBlankEnvironmentBody({
      ...BASE_FORM,
      mapType: 'geo',
      geoLat: '31.27',
      geoLng: '120.74',
      geoZoom: '16',
    });
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({
      name: '我的 geo 世界',
      description: '太仓校区',
      mapType: 'geo',
      mapData: { center: { lat: 31.27, lng: 120.74 }, zoom: 16 },
      visibility: 'private',
    });
  });

  it('omits zoom when the field is left empty', () => {
    const result = buildBlankEnvironmentBody({
      ...BASE_FORM,
      mapType: 'geo',
      geoLat: '31.27',
      geoLng: '120.74',
    });
    expect(result.error).toBeUndefined();
    expect(result.body?.mapData).toEqual({ center: { lat: 31.27, lng: 120.74 } });
  });

  it('rejects a missing name and out-of-range / non-numeric centers', () => {
    expect(buildBlankEnvironmentBody({ ...BASE_FORM, name: '   ' }).error).toBe('create.nameRequired');
    const geo = { ...BASE_FORM, mapType: 'geo' as const, geoLat: '31.27', geoLng: '120.74' };
    expect(buildBlankEnvironmentBody({ ...geo, geoLat: '91' }).error).toBe('create.geoCenterInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoLat: '-90.1' }).error).toBe('create.geoCenterInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoLng: '181' }).error).toBe('create.geoCenterInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoLat: '' }).error).toBe('create.geoCenterInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoLat: 'abc' }).error).toBe('create.geoCenterInvalid');
    // Boundary values are accepted.
    expect(buildBlankEnvironmentBody({ ...geo, geoLat: '-90', geoLng: '180' }).error).toBeUndefined();
  });

  it('rejects a zoom outside 1–19', () => {
    const geo = { ...BASE_FORM, mapType: 'geo' as const, geoLat: '31.27', geoLng: '120.74' };
    expect(buildBlankEnvironmentBody({ ...geo, geoZoom: '0' }).error).toBe('create.geoZoomInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoZoom: '20' }).error).toBe('create.geoZoomInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoZoom: 'x' }).error).toBe('create.geoZoomInvalid');
    expect(buildBlankEnvironmentBody({ ...geo, geoZoom: '1' }).error).toBeUndefined();
    expect(buildBlankEnvironmentBody({ ...geo, geoZoom: '19' }).error).toBeUndefined();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub fetch; records request bodies so tests can assert the POST payload. */
function stubFetch() {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url === '/api/environments') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ id: 'env-geo-1', name: 'geo world' }, 201);
      }
      if (url.startsWith('/api/scenario-templates?')) return jsonResponse({ templates: [] });
      return jsonResponse({ environments: [] });
    }),
  );
  return posts;
}

async function openBlankGeoDialog(posts: Record<string, unknown>[]) {
  renderWithProviders(<EnvironmentsHomePage />);
  (await screen.findByText('+ 新建环境')).click();
  (await screen.findByRole('button', { name: '空白环境' })).click();
  fireEvent.change(await screen.findByLabelText('环境名称'), { target: { value: 'geo world' } });
  fireEvent.change(screen.getByLabelText('地图类型'), { target: { value: 'geo' } });
  return posts;
}

describe('CreateEnvironmentDialog — blank geo tier (UX-W2)', () => {
  it('blocks submit with an inline error when the geo center is missing/invalid', async () => {
    const posts = await openBlankGeoDialog(stubFetch());

    screen.getByRole('button', { name: '创建' }).click();

    expect(
      await screen.findByText('geo 中心点无效——纬度需为 -90~90、经度需为 -180~180 的数字。'),
    ).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('POSTs mapType geo with mapData center/zoom for a valid form', async () => {
    const posts = await openBlankGeoDialog(stubFetch());
    fireEvent.change(screen.getByLabelText('中心纬度（-90~90）'), { target: { value: '31.27' } });
    fireEvent.change(screen.getByLabelText('中心经度（-180~180）'), { target: { value: '120.74' } });
    fireEvent.change(screen.getByLabelText('缩放级别（可选，1–19）'), { target: { value: '16' } });

    screen.getByRole('button', { name: '创建' }).click();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      name: 'geo world',
      description: '',
      mapType: 'geo',
      mapData: { center: { lat: 31.27, lng: 120.74 }, zoom: 16 },
      visibility: 'private',
    });
  });
});
