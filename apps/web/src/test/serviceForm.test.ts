/**
 * Service form tests (W6):
 * - interface rows → interface_json serialization (blank keys dropped,
 *   all-empty → omitted on create, {} on patch so edits can clear);
 * - create vs patch payload shapes (optional fields omitted vs sent);
 * - the derived-service visibility cycle 公开 → 成员 → 隐藏 → 公开;
 * - form validation (provider / name / semanticType required).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { WorldService } from '../api/types';
import {
  buildCreateServicePayload,
  buildPatchServicePayload,
  createServiceFormFields,
  duplicateServicesOfType,
  interfaceToRows,
  nextVisibility,
  rowsToInterface,
  serviceFormError,
  serviceFormFieldsFromService,
  type ServiceFormFields,
} from '../lib/serviceForm';

// serviceFormError reads the active i18next bundle; pin to zh-CN so the
// validation-message assertions stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

function fields(overrides: Partial<ServiceFormFields> = {}): ServiceFormFields {
  return {
    ...createServiceFormFields('agent-1'),
    name: '能耗日报',
    semanticType: 'energy-monitoring',
    ...overrides,
  };
}

describe('interface rows ↔ json', () => {
  it('serializes rows to an object, trimming and dropping blank keys', () => {
    expect(
      rowsToInterface([
        { key: ' zoneId ', description: ' 区域 id ' },
        { key: '  ', description: 'ignored' },
        { key: 'limit', description: '' },
      ]),
    ).toEqual({ zoneId: '区域 id', limit: '' });
  });

  it('empty editor → undefined (create omits the field)', () => {
    expect(rowsToInterface([])).toBeUndefined();
    expect(rowsToInterface([{ key: ' ', description: 'x' }])).toBeUndefined();
  });

  it('interfaceToRows round-trips through rowsToInterface', () => {
    const iface = { zoneId: '区域 id', limit: '上限' };
    expect(rowsToInterface(interfaceToRows(iface))).toEqual(iface);
  });

  it('interfaceToRows stringifies non-string values defensively', () => {
    expect(interfaceToRows({ n: 3 })).toEqual([{ key: 'n', description: '3' }]);
  });
});

describe('payload builders', () => {
  it('create omits description/interface when empty', () => {
    expect(buildCreateServicePayload(fields())).toEqual({
      name: '能耗日报',
      semanticType: 'energy-monitoring',
      visibility: 'public',
    });
  });

  it('create includes trimmed description and interface when present', () => {
    expect(
      buildCreateServicePayload(
        fields({
          description: ' 每日汇总 ',
          rows: [{ key: 'zoneId', description: '区域 id' }],
          visibility: 'members',
        }),
      ),
    ).toEqual({
      name: '能耗日报',
      semanticType: 'energy-monitoring',
      description: '每日汇总',
      interface: { zoneId: '区域 id' },
      visibility: 'members',
    });
  });

  it('patch always sends description + interface (empty clears server-side)', () => {
    expect(buildPatchServicePayload(fields({ description: '', rows: [] }))).toEqual({
      name: '能耗日报',
      semanticType: 'energy-monitoring',
      description: '',
      interface: {},
      visibility: 'public',
    });
  });

  it('serviceFormFieldsFromService prefills for edit', () => {
    const service: WorldService = {
      id: 's1',
      envId: 'env-1',
      name: '能耗日报',
      semanticType: 'energy-monitoring',
      description: '每日汇总',
      interface: { zoneId: '区域 id' },
      origin: 'published',
      sourceDeviceId: null,
      visibility: 'hidden',
      unbacked: false,
      consumable: true,
      provider: { id: 'a1', name: 'AgentA', owner: { id: 'user-a', displayName: '我' } },
      reputation: { score: 0.7, attempts: 0, successes: 0 },
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(serviceFormFieldsFromService(service)).toEqual({
      providerAgentId: 'a1',
      name: '能耗日报',
      semanticType: 'energy-monitoring',
      description: '每日汇总',
      rows: [{ key: 'zoneId', description: '区域 id' }],
      visibility: 'hidden',
    });
  });
});

describe('visibility cycle (derived services)', () => {
  it('cycles 公开 → 成员 → 隐藏 → 公开', () => {
    expect(nextVisibility('public')).toBe('members');
    expect(nextVisibility('members')).toBe('hidden');
    expect(nextVisibility('hidden')).toBe('public');
  });
});

describe('validation', () => {
  it('requires provider (publish), name and semanticType', () => {
    expect(serviceFormError(fields({ providerAgentId: '' }), { requireProvider: true })).toBe(
      '请选择提供者 Agent。',
    );
    expect(serviceFormError(fields({ providerAgentId: '' }), { requireProvider: false })).toBeNull();
    expect(serviceFormError(fields({ name: ' ' }), { requireProvider: true })).toBe(
      '请填写服务名称。',
    );
    expect(serviceFormError(fields({ semanticType: '' }), { requireProvider: true })).toBe(
      '请选择或输入语义类型。',
    );
    expect(serviceFormError(fields(), { requireProvider: true })).toBeNull();
  });
});

describe('duplicateServicesOfType (R80-1 重复发布警告)', () => {
  function offer(id: string, agentId: string, semanticType: string): WorldService {
    return {
      id,
      semanticType,
      provider: { id: agentId, name: agentId, owner: { id: 'user-a', displayName: '我' } },
    } as WorldService;
  }
  const services = [
    offer('s1', 'agent-1', 'energy-monitoring'),
    offer('s2', 'agent-1', 'lighting-control'),
    offer('s3', 'agent-2', 'energy-monitoring'),
  ];

  it('matches same provider agent + same semantic type only', () => {
    expect(duplicateServicesOfType(services, 'agent-1', 'energy-monitoring').map(s => s.id)).toEqual(['s1']);
    // Another provider's same-type offer is legitimate competition — silent.
    expect(duplicateServicesOfType(services, 'agent-2', 'lighting-control')).toEqual([]);
  });

  it('trims the type and ignores blank input', () => {
    expect(duplicateServicesOfType(services, 'agent-1', ' energy-monitoring ').map(s => s.id)).toEqual(['s1']);
    expect(duplicateServicesOfType(services, 'agent-1', '')).toEqual([]);
    expect(duplicateServicesOfType(services, '', 'energy-monitoring')).toEqual([]);
  });
});
