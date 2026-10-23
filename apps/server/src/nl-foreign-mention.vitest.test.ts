/**
 * R78 病灶 A guard — the NL foreign-mention teaching pass (pure function).
 *
 * Four assertions from docs/plan-r78-systemic.md §病灶 A:
 *  ① naming a foreign env device → teaching names owner + services + agreement path
 *  ② naming an OWN surface device → null (normal operation, no teaching)
 *  ③ naming nothing that exists → null (the existing "not found" flow stands)
 *  ④ bilingual — zh default, en on locale
 */

import { describe, expect, it } from 'vitest';

import {
  foreignMentionTeaching,
  type ForeignMentionDevice,
  type ForeignMentionService,
} from './nl-foreign-mention.js';

const DEVICES: ForeignMentionDevice[] = [
  { deviceId: 'gree-3f', name: '格力空调-3F会议室', type: 'hvac', zoneId: 'meeting', ownerId: 'u-dc', ownerName: '机房运维老陈' },
  { deviceId: 'own-plug', name: '我方智能插座', type: 'smart-plug', zoneId: 'room', ownerId: 'u-me', ownerName: '小我' },
  { deviceId: 'aqara-fp2', name: 'Aqara人体存在传感器FP2', type: 'motion-sensor', zoneId: 'room', ownerId: 'u-lib', ownerName: '图书馆员小郑' },
];

const SERVICES: ForeignMentionService[] = [
  { id: 's1', name: '格力空调-3F会议室: 温度控制', semanticType: 'temperature-control', sourceDeviceId: 'gree-3f', visibility: 'members' },
  { id: 's2', name: '格力空调-3F会议室: 制冷', semanticType: 'cooling', sourceDeviceId: 'gree-3f', visibility: 'members' },
  { id: 's3', name: '我方智能插座: 通断', semanticType: 'switch', sourceDeviceId: 'own-plug', visibility: 'members' },
  // No service backs the Aqara sensor (the services-none teaching branch).
];

const OWN_SURFACE = new Set(['own-plug']);

describe('foreignMentionTeaching (R78 病灶 A)', () => {
  it('① foreign device mention → owner + its services + agreement path', () => {
    const teaching = foreignMentionTeaching(
      { text: '打开格力空调', devices: DEVICES, agentSurfaceDeviceIds: OWN_SURFACE, services: SERVICES },
      'zh-CN',
    );
    expect(teaching).not.toBeNull();
    expect(teaching!).toContain('机房运维老陈');
    expect(teaching!).toContain('格力空调-3F会议室: 温度控制');
    expect(teaching!).toContain('发起合约');
    expect(teaching!).toContain('/api/services/');
  });

  it('② own-surface device mention → null (no teaching, normal ops)', () => {
    expect(
      foreignMentionTeaching(
        { text: '打开我方智能插座', devices: DEVICES, agentSurfaceDeviceIds: OWN_SURFACE, services: SERVICES },
        'zh-CN',
      ),
    ).toBeNull();
  });

  it('③ non-existent device → null (existing not-found flow stands)', () => {
    expect(
      foreignMentionTeaching(
        { text: '打开不存在的核聚变反应堆', devices: DEVICES, agentSurfaceDeviceIds: OWN_SURFACE, services: SERVICES },
        'zh-CN',
      ),
    ).toBeNull();
  });

  it('④ bilingual: en locale names the same facts in English', () => {
    const teaching = foreignMentionTeaching(
      { text: '打开格力空调', devices: DEVICES, agentSurfaceDeviceIds: OWN_SURFACE, services: SERVICES },
      'en-US',
    );
    expect(teaching).not.toBeNull();
    expect(teaching!).toContain('belongs to 机房运维老陈');
    expect(teaching!).toContain('propose an agreement');
  });

  it('foreign device with NO services → the derive-it teaching branch', () => {
    const teaching = foreignMentionTeaching(
      { text: '打开Aqara人体存在传感器FP2', devices: DEVICES, agentSurfaceDeviceIds: OWN_SURFACE, services: SERVICES },
      'zh-CN',
    );
    expect(teaching).not.toBeNull();
    expect(teaching!).toContain('图书馆员小郑');
    expect(teaching!).toContain('没有以服务形式暴露能力');
  });
});

describe('R78-A 修订 — mixed-intent teaching', () => {
  const SERVICES: ForeignMentionService[] = [
    { id: 's1', name: '格力空调-3F会议室: 温度控制', semanticType: 'temperature-control', sourceDeviceId: 'gree-3f', visibility: 'members' },
  ];

  it('teaches when the agent acted on its OWN device but ignored the named foreign one', () => {
    const teaching = foreignMentionTeaching(
      {
        text: '打开格力空调-3F会议室和我方智能插座',
        devices: DEVICES,
        agentSurfaceDeviceIds: OWN_SURFACE,
        services: SERVICES,
        actedDeviceIds: new Set(['own-plug']), // 只执行了自有设备
      },
      'zh-CN',
    );
    expect(teaching).not.toBeNull();
    expect(teaching!).toContain('机房运维老陈');
    expect(teaching!).toContain('发起合约');
  });

  it('does NOT teach when the foreign device itself was acted on (gate already handled it)', () => {
    const teaching = foreignMentionTeaching(
      {
        text: '打开格力空调-3F会议室',
        devices: DEVICES,
        agentSurfaceDeviceIds: OWN_SURFACE,
        services: SERVICES,
        actedDeviceIds: new Set(['gree-3f']),
      },
      'zh-CN',
    );
    expect(teaching).toBeNull();
  });
});

describe('R76-F4 — same-name devices resolve own-first', () => {
  // The R76 failure shape: 林姐与阿May/小苏名下各有「Aqara智能窗帘电机
  // （开合帘版）」— the user named THEIR OWN device and got told it
  // "belongs to 林姐" because the equal-run tie picked the foreign copy.
  const SAME_NAME: ForeignMentionDevice[] = [
    { deviceId: 'curtain-lin', name: 'Aqara智能窗帘电机（开合帘版）', type: 'curtain', zoneId: 'living', ownerId: 'u-lin', ownerName: '街区运营者林姐' },
    { deviceId: 'curtain-mine', name: 'Aqara智能窗帘电机（开合帘版）', type: 'curtain', zoneId: 'bedroom', ownerId: 'u-me', ownerName: '小我' },
  ];
  const SERVICES: ForeignMentionService[] = [
    { id: 's1', name: 'Aqara智能窗帘电机（开合帘版）: 开合', semanticType: 'curtain-control', sourceDeviceId: 'curtain-lin', visibility: 'members' },
  ];

  it('naming MY OWN same-named device → null (no false ownership teaching)', () => {
    const teaching = foreignMentionTeaching(
      {
        text: '打开Aqara智能窗帘电机（开合帘版）',
        devices: SAME_NAME,
        agentSurfaceDeviceIds: new Set(['curtain-mine']), // bound to the agent I addressed
        services: SERVICES,
      },
      'zh-CN',
    );
    expect(teaching).toBeNull();
  });

  it('user-owned same-named device (not on this agent surface) → null', () => {
    const teaching = foreignMentionTeaching(
      {
        text: '打开Aqara智能窗帘电机（开合帘版）',
        devices: SAME_NAME,
        agentSurfaceDeviceIds: new Set(),
        services: SERVICES,
        ownDeviceIds: new Set(['curtain-mine']), // the caller's own env device
      },
      'zh-CN',
    );
    expect(teaching).toBeNull();
  });

  it('a strictly stronger FOREIGN reference still teaches (own-first only breaks ties)', () => {
    const devices: ForeignMentionDevice[] = [
      { deviceId: 'curtain-mine', name: '智能窗帘电机', type: 'curtain', zoneId: 'bedroom', ownerId: 'u-me', ownerName: '小我' },
      { deviceId: 'curtain-lin', name: 'Aqara智能窗帘电机（开合帘版）', type: 'curtain', zoneId: 'living', ownerId: 'u-lin', ownerName: '街区运营者林姐' },
    ];
    const teaching = foreignMentionTeaching(
      {
        text: '打开Aqara智能窗帘电机（开合帘版）',
        devices,
        agentSurfaceDeviceIds: new Set(['curtain-mine']),
        services: SERVICES,
      },
      'zh-CN',
    );
    expect(teaching).not.toBeNull();
    expect(teaching!).toContain('街区运营者林姐');
    expect(teaching!).toContain('发起合约');
  });
});
