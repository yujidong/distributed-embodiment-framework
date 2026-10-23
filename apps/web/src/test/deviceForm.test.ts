/**
 * Device form tests (W6-2):
 * - device-type vocabulary (union of env device types + catalog device_types);
 * - validation (name/type required, ≥1 capability, zone required + existing,
 *   grid x/y both-or-neither + numeric, initial-state JSON optional-valid);
 * - payload builders (create omits blanks/unpicked; patch sends null to
 *   clear brand/initialState/grid position and omits geo position without a
 *   fresh map pick);
 * - the derived-service resync note trigger (capabilitiesChanged).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { WorldDevice } from '../api/types';
import {
  buildCreateDevicePayload,
  buildPatchDevicePayload,
  capabilitiesChanged,
  createDeviceFormFields,
  deviceFormError,
  deviceFormFieldsFromDevice,
  deviceTypeVocabulary,
  parseInitialStateJson,
  type DeviceFormFields,
} from '../lib/deviceForm';

// deviceFormError reads the active i18next bundle; pin to zh-CN so the
// validation-message substring assertions stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

const GRID_CTX = { isGeo: false, zoneIds: new Set(['zone-1', 'zone-2']) };
const GEO_CTX = { isGeo: true, zoneIds: new Set(['zone-1', 'zone-2']) };

function validFields(overrides: Partial<DeviceFormFields> = {}): DeviceFormFields {
  return {
    ...createDeviceFormFields('zone-1'),
    name: '客厅灯',
    type: 'lamp',
    capabilities: ['switch'],
    ...overrides,
  };
}

function makeDevice(overrides: Partial<WorldDevice> = {}): WorldDevice {
  return {
    id: 'dev-1',
    envId: 'env-1',
    name: '客厅灯',
    type: 'lamp',
    brand: '格力',
    capabilities: ['switch'],
    zoneId: 'zone-1',
    position: { x: 2, y: 3 },
    initialState: { power: false },
    binding: 'sim://dev-1',
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('deviceTypeVocabulary', () => {
  it('unions env device types with catalog device_types, sorted', () => {
    const vocabulary = deviceTypeVocabulary({
      devices: [{ type: 'lamp' }, { type: 'hvac' }, { type: 'lamp' }],
      catalogDeviceTypes: ['curtain', 'hvac'],
    });
    expect(vocabulary).toEqual(['curtain', 'hvac', 'lamp']);
  });

  it('works without the catalog (offline suggestions shrink)', () => {
    expect(deviceTypeVocabulary({ devices: [{ type: 'lamp' }] })).toEqual(['lamp']);
  });
});

describe('parseInitialStateJson', () => {
  it('accepts blank as absent', () => {
    expect(parseInitialStateJson('  ')).toEqual({ ok: true, value: undefined });
  });

  it('accepts a plain object', () => {
    expect(parseInitialStateJson('{"power": false}')).toEqual({ ok: true, value: { power: false } });
  });

  it('rejects arrays, scalars and broken JSON', () => {
    expect(parseInitialStateJson('[1]').ok).toBe(false);
    expect(parseInitialStateJson('42').ok).toBe(false);
    expect(parseInitialStateJson('{nope').ok).toBe(false);
  });
});

describe('deviceFormError', () => {
  it('passes a valid grid form without position', () => {
    expect(deviceFormError(validFields(), GRID_CTX)).toBeNull();
  });

  it('requires name, type and ≥1 capability', () => {
    expect(deviceFormError(validFields({ name: ' ' }), GRID_CTX)).toContain('名称');
    expect(deviceFormError(validFields({ type: '' }), GRID_CTX)).toContain('类型');
    expect(deviceFormError(validFields({ capabilities: [] }), GRID_CTX)).toContain('能力');
  });

  it('requires a zone that still exists', () => {
    expect(deviceFormError(validFields({ zoneId: '' }), GRID_CTX)).toContain('区域');
    expect(deviceFormError(validFields({ zoneId: 'gone' }), GRID_CTX)).toContain('不存在');
  });

  it('grid position: x/y both-or-neither and numeric', () => {
    expect(deviceFormError(validFields({ posX: '1', posY: '2' }), GRID_CTX)).toBeNull();
    expect(deviceFormError(validFields({ posX: '1' }), GRID_CTX)).toContain('同时');
    expect(deviceFormError(validFields({ posX: 'a', posY: '2' }), GRID_CTX)).toContain('数字');
  });

  it('geo form ignores the grid position inputs', () => {
    expect(deviceFormError(validFields({ posX: 'oops' }), GEO_CTX)).toBeNull();
  });

  it('rejects invalid initial-state JSON', () => {
    expect(deviceFormError(validFields({ initialStateJson: '[1]' }), GRID_CTX)).toContain('JSON');
  });
});

describe('payload builders', () => {
  it('create: omits brand/position/initialState when blank', () => {
    expect(buildCreateDevicePayload(validFields(), { isGeo: false, geoPoint: null })).toEqual({
      name: '客厅灯',
      type: 'lamp',
      capabilities: ['switch'],
      zoneId: 'zone-1',
    });
  });

  it('create: includes grid position only when both coords are set', () => {
    const payload = buildCreateDevicePayload(validFields({ posX: '1.5', posY: '2' }), {
      isGeo: false,
      geoPoint: null,
    });
    expect(payload.position).toEqual({ x: 1.5, y: 2 });
  });

  it('create (geo): uses the map-picked point, ignores grid inputs', () => {
    const payload = buildCreateDevicePayload(validFields({ posX: '9', posY: '9' }), {
      isGeo: true,
      geoPoint: { lat: 31.3, lng: 120.6 },
    });
    expect(payload.position).toEqual({ lat: 31.3, lng: 120.6 });
    // No pick → no position key (zone-centroid fallback server-side).
    expect(
      buildCreateDevicePayload(validFields(), { isGeo: true, geoPoint: null }),
    ).not.toHaveProperty('position');
  });

  it('create: includes brand and initialState when provided', () => {
    const payload = buildCreateDevicePayload(
      validFields({ brand: ' 格力 ', initialStateJson: '{"power": false}' }),
      { isGeo: false, geoPoint: null },
    );
    expect(payload.brand).toBe('格力');
    expect(payload.initialState).toEqual({ power: false });
  });

  it('patch: blank brand/initialState/grid position clear server-side (null)', () => {
    const payload = buildPatchDevicePayload(validFields(), { isGeo: false, geoPoint: null });
    expect(payload.brand).toBeNull();
    expect(payload.initialState).toBeNull();
    expect(payload.position).toBeNull();
  });

  it('patch: filled values are sent through', () => {
    const payload = buildPatchDevicePayload(
      validFields({ brand: '美的', posX: '1', posY: '2', initialStateJson: '{"on": true}' }),
      { isGeo: false, geoPoint: null },
    );
    expect(payload).toMatchObject({
      brand: '美的',
      position: { x: 1, y: 2 },
      initialState: { on: true },
    });
  });

  it('patch (geo): omits position without a fresh pick, sets it when picked', () => {
    expect(
      buildPatchDevicePayload(validFields(), { isGeo: true, geoPoint: null }),
    ).not.toHaveProperty('position');
    expect(
      buildPatchDevicePayload(validFields(), { isGeo: true, geoPoint: { lat: 1, lng: 2 } }).position,
    ).toEqual({ lat: 1, lng: 2 });
  });
});

describe('edit prefill + resync note', () => {
  it('prefills from the device, pretty-printing initialState', () => {
    const fields = deviceFormFieldsFromDevice(makeDevice());
    expect(fields).toMatchObject({
      name: '客厅灯',
      type: 'lamp',
      brand: '格力',
      capabilities: ['switch'],
      zoneId: 'zone-1',
      posX: '2',
      posY: '3',
    });
    expect(JSON.parse(fields.initialStateJson)).toEqual({ power: false });
    // A device without optional fields prefills blank.
    const bare = deviceFormFieldsFromDevice(
      makeDevice({ brand: null, position: null, initialState: null }),
    );
    expect(bare).toMatchObject({ brand: '', posX: '', posY: '', initialStateJson: '' });
  });

  it('capabilitiesChanged detects any set difference', () => {
    const device = makeDevice({ capabilities: ['switch', 'dim'] });
    expect(capabilitiesChanged(device, { capabilities: ['switch', 'dim'] })).toBe(false);
    expect(capabilitiesChanged(device, { capabilities: ['dim', 'switch'] })).toBe(false);
    expect(capabilitiesChanged(device, { capabilities: ['switch'] })).toBe(true);
    expect(capabilitiesChanged(device, { capabilities: ['switch', 'dim', 'x'] })).toBe(true);
  });
});
