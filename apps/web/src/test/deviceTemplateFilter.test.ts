/**
 * filterDeviceTemplates — 英文子串 + 中文别名查询（ux-w3 探针 P2：zh-CN UI
 * 下搜「烟感」曾零匹配，注册表 73 项全英文命名）。
 */
import { describe, expect, it } from 'vitest';

import { filterDeviceTemplates } from '../lib/deviceTemplates';
import type { DeviceTemplate } from '../api/types';

const TEMPLATES: readonly DeviceTemplate[] = [
  {
    id: 'smoke-sensor',
    name: 'Smoke Sensor',
    type: 'sensor',
    description: 'smoke detection',
    capabilities: ['detect-smoke', 'read-smoke'],
    defaultBehaviors: [],
  },
  {
    id: 'hvac-controller',
    name: 'HVAC Controller',
    type: 'hvac',
    category: 'climate',
    description: 'air conditioning',
    capabilities: ['set-temperature', 'turn-on', 'turn-off'],
    defaultBehaviors: [],
  },
  {
    id: 'smart-light',
    name: 'Smart Light',
    type: 'light',
    description: 'dimmable light',
    capabilities: ['turn-on', 'turn-off', 'set-brightness'],
    defaultBehaviors: [],
  },
  {
    id: 'people-counter',
    name: 'People Counter',
    type: 'sensor',
    description: 'counts foot traffic',
    capabilities: ['count-people'],
    defaultBehaviors: [],
  },
  {
    id: 'crowd-monitor',
    name: 'Crowd Monitor',
    type: 'sensor',
    description: 'crowd density',
    capabilities: ['monitor-crowd'],
    defaultBehaviors: [],
  },
  {
    id: 'occupancy-sensor',
    name: 'Occupancy Sensor',
    type: 'sensor',
    description: 'room occupancy',
    capabilities: ['detect-occupancy'],
    defaultBehaviors: [],
  },
];

describe('filterDeviceTemplates', () => {
  it('empty query returns everything; english substring matches', () => {
    expect(filterDeviceTemplates(TEMPLATES, '')).toHaveLength(6);
    expect(filterDeviceTemplates(TEMPLATES, 'smoke').map(t => t.id)).toEqual(['smoke-sensor']);
  });

  it('chinese aliases hit the english-named templates', () => {
    expect(filterDeviceTemplates(TEMPLATES, '烟感').map(t => t.id)).toEqual(['smoke-sensor']);
    expect(filterDeviceTemplates(TEMPLATES, '空调').map(t => t.id)).toEqual(['hvac-controller']);
    expect(filterDeviceTemplates(TEMPLATES, '照明').map(t => t.id)).toEqual(['smart-light']);
  });

  it('non-aliased foreign text still returns nothing (honest empty state)', () => {
    expect(filterDeviceTemplates(TEMPLATES, '电梯')).toEqual([]);
  });

  it('R2 商场#4: 「客流」hits the people/crowd family, not only occupancy', () => {
    expect(filterDeviceTemplates(TEMPLATES, '客流').map(t => t.id)).toEqual([
      'people-counter',
      'crowd-monitor',
    ]);
    // 人数/占位 keeps the occupancy family AND reaches people-counter.
    expect(filterDeviceTemplates(TEMPLATES, '占位').map(t => t.id)).toEqual([
      'people-counter',
      'occupancy-sensor',
    ]);
  });
});
