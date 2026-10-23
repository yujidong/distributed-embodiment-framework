/**
 * wallCleanup — 纵墙重建与交接连续性（R93 根因回归：提取器只产横向行程
 * 条带，垂直墙是一叠长度=墙厚的短条带，旧版被滑动均值聚类叠回墙厚后
 * 遭 KEEP_LENGTH 过滤，整层纵墙全灭、交接全断）。
 */

import { describe, expect, it } from 'vitest';

import { simplifyWalls, type WallBox } from '../components/interior/wallCleanup';

const CELL = 0.16;

/** 提取器风格：垂直墙 = 逐行短条带（长度=墙厚，逐行推进 cross）。 */
function verticalWallStrips(x: number, z0: number, z1: number, thick = CELL * 2): WallBox[] {
  const out: WallBox[] = [];
  for (let r = Math.round(z0 / CELL); r < Math.round(z1 / CELL); r++) {
    out.push([x, r * CELL, thick, CELL]);
  }
  return out;
}

const verticals = (walls: WallBox[]) => walls.filter(w => w[3] > w[2] && w[4] === undefined);
const horizontals = (walls: WallBox[]) => walls.filter(w => w[2] >= w[3] && w[4] === undefined);
const rotated = (walls: WallBox[]) => walls.filter(w => w[4] !== undefined);

describe('simplifyWalls', () => {
  it('重建纵墙：堆叠短条带还原为全长度垂直墙盒', () => {
    const out = simplifyWalls(verticalWallStrips(10, 0, 8));
    const v = verticals(out);
    expect(v).toHaveLength(1);
    const [cx, cz, w, d] = v[0];
    expect(cx).toBeCloseTo(10, 1);
    expect(cz).toBeCloseTo(4, 1);
    expect(d).toBeGreaterThan(7.5);
    expect(w).toBeLessThan(0.5);
  });

  it('T 型交接连续：纵墙行程穿过横墙（盒体交叠无缝）', () => {
    const strips: WallBox[] = [
      ...verticalWallStrips(10, 0, 8),
      [15, 4.0, 10, CELL], // 横墙 z=4，x 10..20（T 型搭在纵墙上）
    ];
    const out = simplifyWalls(strips);
    const v = verticals(out);
    const h = horizontals(out);
    expect(v).toHaveLength(1);
    expect(h).toHaveLength(1);
    // 纵墙 z 覆盖横墙所在行；横墙 x 覆盖纵墙所在列 → 交接处相交
    expect(v[0][1] - v[0][3] / 2).toBeLessThan(4.0);
    expect(v[0][1] + v[0][3] / 2).toBeGreaterThan(4.0);
    expect(h[0][0] - h[0][2] / 2).toBeLessThanOrEqual(10 + CELL);
    expect(h[0][0] + h[0][2] / 2).toBeGreaterThan(10);
  });

  it('门洞保留：纵墙在 ≥0.8m 空洞处断开为两段', () => {
    const out = simplifyWalls([
      ...verticalWallStrips(10, 0, 3.2),
      ...verticalWallStrips(10, 4.0, 8), // 门洞 z 3.2..4.0
    ]);
    const v = verticals(out);
    expect(v).toHaveLength(2);
    const spans = v.map(([, cz, , d]) => [cz - d / 2, cz + d / 2]).sort((a, b) => a[0] - b[0]);
    expect(spans[0][1]).toBeLessThanOrEqual(3.2 + CELL);
    expect(spans[1][0]).toBeGreaterThanOrEqual(4.0 - CELL);
  });

  it('噪声过滤不回归：孤立短桩与碎片被丢弃', () => {
    const out = simplifyWalls([
      [5, 5, 0.32, CELL], // 孤立碎片
      [20, 1.0, 0.9, CELL], // 短桩 < KEEP_LENGTH
      ...verticalWallStrips(10, 0, 8),
    ]);
    expect(out).toHaveLength(1);
  });

  it('横向合并不回归：共线条带跨小间隙拼成整墙', () => {
    const out = simplifyWalls([
      [5, 4.0, 10, CELL],
      [10.3, 4.0, 0.5, CELL], // 与左段间隙 0.05m
      [15, 4.1, 9, CELL], // 逐行错位 0.1m
    ]);
    const h = horizontals(out);
    expect(h).toHaveLength(1);
    expect(h[0][2]).toBeGreaterThan(19);
  });

  it('真实规模数据：纵墙占比显著非零（bldg-d-f1 形态回归）', () => {
    // 40×40 网格房间：四面墙 + 一道纵隔断 + 一道横隔断
    const strips: WallBox[] = [];
    for (let r = 0; r < 250; r++) {
      strips.push([10, r * CELL, 0.32, CELL]); // 左墙
      strips.push([30, r * CELL, 0.32, CELL]); // 右墙
      strips.push([20, r * CELL, 0.32, CELL]); // 纵隔断
    }
    for (let c = 62; c < 188; c++) {
      strips.push([c * CELL, 0, 0.32, CELL]); // 顶墙（横向行程）
      strips.push([c * CELL, 39.84, 0.32, CELL]); // 底墙
    }
    strips.push([20, 20.0, 20, CELL]); // 横隔断
    const out = simplifyWalls(strips);
    expect(verticals(out).length).toBeGreaterThanOrEqual(3);
    expect(horizontals(out).length).toBeGreaterThanOrEqual(3);
  });
});

/** 提取器风格弧墙短划：沿圆弧按行步进撒轴对齐短条带（局部陡处更短）。 */
function arcStrips(
  cx: number,
  cz: number,
  r: number,
  a0: number,
  a1: number,
  cell = CELL,
): WallBox[] {
  const out: WallBox[] = [];
  const steps = Math.max(12, Math.round(((a1 - a0) * r) / (cell * 0.9)));
  for (let k = 0; k <= steps; k++) {
    const t = a0 + ((a1 - a0) * k) / steps;
    const x = cx + r * Math.cos(t);
    const z = cz + r * Math.sin(t);
    // 轴对齐短条带：切向投影长度（模拟行程提取的量化），厚度恒为 1 格
    const tx = -Math.sin(t);
    const w = Math.max(cell * 2, cell * 6 * Math.abs(tx));
    out.push([Math.round(x / cell) * cell, Math.round(z / cell) * cell, w, cell]);
  }
  return out;
}

describe('simplifyWalls — 弧/斜墙恢复（R94）', () => {
  it('圆弧墙连续化：虚线短划 → 共圆弦盒序列，缺口被桥接', () => {
    const strips = arcStrips(50, 50, 20, 0, Math.PI / 2);
    const out = simplifyWalls(strips);
    const rot = rotated(out);
    expect(rot.length).toBeGreaterThanOrEqual(4);
    // 弦盒端点链连续：相邻弦盒中心角步进均匀且无大洞
    const angs = rot
      .map(([x, z]) => Math.atan2(z - 50, x - 50))
      .sort((a, b) => a - b);
    for (let i = 1; i < angs.length; i++) {
      expect(angs[i] - angs[i - 1]).toBeLessThan(0.15);
    }
    // 覆盖原始角域
    expect(angs[0]).toBeLessThan(0.15);
    expect(angs[angs.length - 1]).toBeGreaterThan(Math.PI / 2 - 0.15);
    // 所有弦盒落在拟合圆上
    for (const [x, z] of rot) {
      expect(Math.abs(Math.hypot(x - 50, z - 50) - 20)).toBeLessThan(0.5);
    }
  });

  it('门拱排除：R≈0.9m 的四分之一圆短划不产生旋转盒', () => {
    const strips = arcStrips(10, 10, 0.9, 0, Math.PI / 2);
    const out = simplifyWalls(strips);
    expect(rotated(out)).toHaveLength(0);
  });

  it('斜墙消锯齿：65° 楼梯状条带 → 单个旋转盒，角度与展长正确', () => {
    const theta = (65 * Math.PI) / 180;
    const strips: WallBox[] = [];
    const span = 12;
    const steps = Math.round((span * Math.sin(theta)) / CELL);
    for (let k = 0; k <= steps; k++) {
      const u = (span * k) / steps;
      const x = 10 + u * Math.cos(theta);
      const z = 5 + u * Math.sin(theta);
      // 行程提取：每行一段，长度=墙厚/tan ≈ 2~3 格
      strips.push([Math.round(x / CELL) * CELL, Math.round(z / CELL) * CELL, CELL * 3, CELL]);
    }
    const out = simplifyWalls(strips);
    const rot = rotated(out);
    expect(rot).toHaveLength(1);
    const [cx, cz, w, , r] = rot[0];
    expect(Math.abs((r! * 180) / Math.PI)).toBeCloseTo(65, 0);
    expect(w).toBeGreaterThan(span * 0.9);
    expect(w).toBeLessThan(span * 1.15);
    // 中心贴线
    expect(Math.abs(-(cx - 10) * Math.sin(theta) + (cz - 5) * Math.cos(theta))).toBeLessThan(0.3);
  });

  it('稀疏文字链排除：大间隙短划不拟合出弧', () => {
    // 沿同一圆周但间距 2m+ 的稀疏短划（标注/文字形态）
    const strips: WallBox[] = [];
    for (let k = 0; k < 10; k++) {
      const t = (Math.PI / 2) * (k / 9);
      strips.push([50 + 20 * Math.cos(t), 50 + 20 * Math.sin(t), CELL * 3, CELL]);
    }
    const out = simplifyWalls(strips);
    expect(rotated(out)).toHaveLength(0);
  });

  it('轴对齐直墙不被弧管线消耗（横向/纵墙路径不回退）', () => {
    // 一条 12m 横墙 + 一条 8m 纵墙（提取器条带形态）
    const strips: WallBox[] = [];
    for (let c = 0; c < 75; c++) strips.push([c * CELL + 5, 20, CELL, CELL]);
    strips.push(...verticalWallStrips(5, 12, 20));
    const out = simplifyWalls(strips);
    expect(rotated(out)).toHaveLength(0);
    expect(horizontals(out).length).toBeGreaterThanOrEqual(1);
    expect(verticals(out).length).toBeGreaterThanOrEqual(1);
  });

  it('圆形大厅：全圆短划 → 近 360° 弦盒环', () => {
    const strips = arcStrips(30, 30, 10, 0, 2 * Math.PI - 0.05);
    const out = simplifyWalls(strips);
    const rot = rotated(out);
    expect(rot.length).toBeGreaterThanOrEqual(12);
    const angs = rot.map(([x, z]) => Math.atan2(z - 30, x - 30));
    const { length } = angs;
    // 角域覆盖 > 300°
    const sorted = [...angs].sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 0; i < length; i++) {
      const gap = i + 1 < length ? sorted[i + 1] - sorted[i] : sorted[0] + 2 * Math.PI - sorted[i];
      if (gap > maxGap) maxGap = gap;
    }
    expect(2 * Math.PI - maxGap).toBeGreaterThan((300 * Math.PI) / 180);
  });

  it('确定性：同一输入两次输出完全一致', () => {
    const strips = [
      ...arcStrips(50, 50, 20, 0, Math.PI / 2),
      ...arcStrips(30, 30, 10, Math.PI, Math.PI * 1.5),
    ];
    const a = simplifyWalls(strips);
    const b = simplifyWalls(strips);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('simplifyWalls — 交接搭接与大跨度桥接（R95）', () => {
  it('弧端点搭接：端点旁有交接直墙条带时弧外延与其交叠', () => {
    // 四分之一圆弧 + 起点处一条正交直墙（交接）；直墙距弧端 0.4m
    const strips = arcStrips(50, 50, 15, 0, Math.PI / 2);
    // 直墙（纵向，轴管线会渲染它），墙端距弧起点 (65,50) 0.4m
    strips.push(...verticalWallStrips(65.4, 46, 50.5));
    const out = simplifyWalls(strips);
    const rot = rotated(out);
    expect(rot.length).toBeGreaterThanOrEqual(4);
    // 弧起点角应越过 0（向交接墙外延）→ 最外弦盒越过原弧起点
    const angs = rot.map(([x, z]) => Math.atan2(z - 50, x - 50)).sort((a, b) => a - b);
    expect(angs[0]).toBeLessThan(0);
    // 外延有限（拟合会吞入交接墙边缘条带 + 端点外延，总体仍局部）
    expect(angs[0]).toBeGreaterThan(-0.25);
  });

  it('大跨度桥接：共圆高度一致且无门证据的 2m 空洞被桥接', () => {
    // 同一圆上两段弧，空洞弧长 ~1.6m（0.107rad @ R15）
    const strips = [
      ...arcStrips(50, 50, 15, 0, 0.6),
      ...arcStrips(50, 50, 15, 0.6 + 0.107, 1.4),
    ];
    const out = simplifyWalls(strips, []);
    const angs = rotated(out)
      .map(([x, z]) => Math.atan2(z - 50, x - 50))
      .sort((a, b) => a - b);
    // 弦盒角步进全程连续（空洞被弦盒跨过；阈值为采样步长 ~0.144 之上）
    for (let i = 1; i < angs.length; i++) {
      expect(angs[i] - angs[i - 1]).toBeLessThan(0.16);
    }
  });

  it('门洞排除：缺口弦中点有门点时同圆两段不桥接', () => {
    const gapMid = 0.6 + 0.0535;
    const doorX = 50 + 15 * Math.cos(gapMid);
    const doorZ = 50 + 15 * Math.sin(gapMid);
    const strips = [
      ...arcStrips(50, 50, 15, 0, 0.6),
      ...arcStrips(50, 50, 15, 0.707, 1.4),
    ];
    const out = simplifyWalls(strips, [[doorX, doorZ]]);
    const angs = rotated(out)
      .map(([x, z]) => Math.atan2(z - 50, x - 50))
      .sort((a, b) => a - b);
    // 门洞处应仍有明显角向缺口
    let maxGap = 0;
    for (let i = 1; i < angs.length; i++) maxGap = Math.max(maxGap, angs[i] - angs[i - 1]);
    expect(maxGap).toBeGreaterThan(0.07);
  });

  it('门摆排除：缺口附近有未消耗碎条带（门摆）时不桥接', () => {
    const strips = [
      ...arcStrips(50, 50, 15, 0, 0.6),
      ...arcStrips(50, 50, 15, 0.707, 1.4),
    ];
    // 缺口中点旁撒门摆碎段（短、不构成链 ≥8）
    const mid = 0.6535;
    for (let k = 0; k < 5; k++) {
      const t = mid + k * 0.004;
      strips.push([50 + 15 * Math.cos(t) + 0.3, 50 + 15 * Math.sin(t), CELL * 2, CELL]);
    }
    const out = simplifyWalls(strips, []);
    const angs = rotated(out)
      .map(([x, z]) => Math.atan2(z - 50, x - 50))
      .sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < angs.length; i++) maxGap = Math.max(maxGap, angs[i] - angs[i - 1]);
    expect(maxGap).toBeGreaterThan(0.07);
  });
});
