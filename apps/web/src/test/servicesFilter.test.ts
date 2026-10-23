/**
 * R80-FW1 guard — the spatial dimension of service discovery:
 * zoneId filters services by their anchor; zone-less rows (undeclared
 * published offers) never match a zone filter.
 */

import { describe, expect, it } from 'vitest';

import type { WorldService } from '../api/types';
import { filterServices } from '../lib/services';

function svc(partial: Partial<WorldService>): WorldService {
  return partial as WorldService;
}

const SERVICES: WorldService[] = [
  svc({ name: '教室空调控制', semanticType: 'temperature-control', zoneId: 'bldg-a-301' }),
  svc({ name: '图书馆照明', semanticType: 'lighting-control', zoneId: 'lib-2f' }),
  // zone-less: an undeclared published offer — must NEVER match a zone filter
  svc({ name: '校园能源咨询', semanticType: 'energy-consulting' }),
];

describe('filterServices zone dimension (R80-FW1)', () => {
  it('keeps only services anchored in the chosen zone', () => {
    const hits = filterServices(SERVICES, { zoneId: 'bldg-a-301' });
    expect(hits.map(s => s.name)).toEqual(['教室空调控制']);
  });

  it('zone-less rows never match a zone filter', () => {
    expect(filterServices(SERVICES, { zoneId: 'lib-2f' }).map(s => s.name)).toEqual(['图书馆照明']);
  });

  it('composes with the owner-exclusion dimension (R78-F)', () => {
    const withOwner = SERVICES.map((s, i) =>
      svc({ ...s, name: s.name, provider: { id: `a${i}`, name: `agent${i}`, owner: { id: i === 0 ? 'me' : 'other', displayName: '' } } } as Partial<WorldService>),
    );
    const hits = filterServices(withOwner, { zoneId: 'bldg-a-301', excludeOwnerUserId: 'me' });
    expect(hits).toHaveLength(0);
  });
});

describe('filterServices owner dimension (R80-2 「只看我的」)', () => {
  const MINE = svc({
    name: '我的能耗服务',
    semanticType: 'energy-monitoring',
    provider: { id: 'a-mine', name: 'my-agent', owner: { id: 'me', displayName: '我' } },
  } as Partial<WorldService>);
  const THEIRS = svc({
    name: '他人能耗服务',
    semanticType: 'energy-monitoring',
    provider: { id: 'a-theirs', name: 'their-agent', owner: { id: 'other', displayName: '他人' } },
  } as Partial<WorldService>);

  it('ownerUserId keeps only the caller\'s own offers (owner-level, any of their agents)', () => {
    const secondMine = svc({
      name: '我的第二个服务',
      semanticType: 'lighting-control',
      provider: { id: 'a-mine-2', name: 'my-agent-2', owner: { id: 'me', displayName: '我' } },
    } as Partial<WorldService>);
    const hits = filterServices([MINE, THEIRS, secondMine], { ownerUserId: 'me' });
    expect(hits.map(s => s.name)).toEqual(['我的能耗服务', '我的第二个服务']);
  });

  it('ownerUserId is the exact inverse of excludeOwnerUserId and composes with other filters', () => {
    expect(filterServices([MINE, THEIRS], { ownerUserId: 'me' }).map(s => s.name)).toEqual(['我的能耗服务']);
    expect(filterServices([MINE, THEIRS], { excludeOwnerUserId: 'me' }).map(s => s.name)).toEqual(['他人能耗服务']);
    expect(
      filterServices([MINE, THEIRS], { ownerUserId: 'me', semanticType: 'lighting-control' }),
    ).toHaveLength(0);
  });
});
