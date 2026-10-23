/**
 * R2-BUG-02: 漫游 hint 出生点（lib/interior3d/spawn.ts）——
 * 出生点在 anchor 朝建筑中心一侧、面朝 anchor（房间标记）；修复前
 * yaw 背对楼心 + 出生点被 backOff 推到楼外，1F 首屏只剩天空草地。
 * R2-FEAT-12: roomLabelText 显示名规则（name 主 code 次，id 不裸显）。
 */

import { describe, expect, it } from 'vitest';

import { resolveHintedSpawn } from '../lib/interior3d/spawn';
import { roomLabelText } from '../lib/interior3d/labels';

const NO_BLOCK = () => false;

describe('resolveHintedSpawn', () => {
  it('出生点在 anchor 朝楼心一侧 backOff 米处', () => {
    const s = resolveHintedSpawn({ x: 2, z: 2 }, { x: 10, z: 10 }, NO_BLOCK, 4);
    // 楼心方向 (1,1)/√2；出生点 = anchor + dir*4
    expect(s.x).toBeCloseTo(2 + 4 / Math.SQRT2, 6);
    expect(s.z).toBeCloseTo(2 + 4 / Math.SQRT2, 6);
  });

  it('yaw 面向 anchor（世界前向 = (sin yaw, cos yaw)）', () => {
    const anchor = { x: 2, z: 2 };
    const s = resolveHintedSpawn(anchor, { x: 10, z: 10 }, NO_BLOCK, 4);
    const fwd = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
    const to = { x: anchor.x - s.x, z: anchor.z - s.z };
    const len = Math.hypot(to.x, to.z);
    const dot = (fwd.x * to.x + fwd.z * to.z) / len;
    expect(dot).toBeGreaterThan(0.999); // 前向与「望向 anchor」同向
  });

  it('出生点落进墙体时沿楼心方向朝 anchor 收缩', () => {
    // backOff=4 处被墙挡（x > 3.5 堵，即 t > 0.375），收缩到 t=0.3（1.2m 处）放行
    const isBlocked = (x: number, _z: number) => x > 3.5;
    const s = resolveHintedSpawn({ x: 2, z: 2 }, { x: 10, z: 2 }, isBlocked, 4);
    expect(s.x).toBeCloseTo(2 + 4 * 0.3, 6);
    expect(s.z).toBeCloseTo(2, 6);
  });

  it('anchor 与楼心重合（退化）不炸：原地出生', () => {
    const s = resolveHintedSpawn({ x: 5, z: 5 }, { x: 5, z: 5 }, NO_BLOCK);
    expect(s.x).toBe(5);
    expect(s.z).toBe(5);
    expect(Number.isFinite(s.yaw)).toBe(true);
  });
});

describe('roomLabelText — R2-FEAT-12 显示名规则', () => {
  it('name 与 code 不同 → 显示 name（zone-as-room 的 id 不裸显）', () => {
    expect(roomLabelText({ code: 'living-room', name: '客厅' })).toBe('客厅');
    expect(roomLabelText({ code: 'Y-201', name: '会议室' })).toBe('会议室');
  });

  it('name === code（太仓预烘焙）或缺失 → 回退 code', () => {
    expect(roomLabelText({ code: 'A-1005B', name: 'A-1005B' })).toBe('A-1005B');
    expect(roomLabelText({ code: 'D-4021', name: '' })).toBe('D-4021');
    expect(roomLabelText({ code: 'D-4021' })).toBe('D-4021');
  });
});
