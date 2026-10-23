/**
 * Wall-geometry cleanup for raster-extracted interiors. The plan mask
 * extractor emits one thin box per pixel-row run — a single straight wall
 * becomes dozens of staircase-shifted strips, plus stray fragments from
 * text/legend/stair/furniture noise. Client-side faithful vectorization is
 * out of scope; this pass is deliberately AGGRESSIVE and structural:
 *
 *   drop tiny fragments → cluster near-parallel lines by running-mean
 *   cross axis → merge collinear runs → keep only walls long enough to be
 *   structural (short stubs are noise by definition).
 *
 * Curved/diagonal walls (R94): the same row-run extraction turns arcs and
 * steep diagonal walls into dashed stair fragments (1-cell runs are dropped
 * by the extractor). A curve pass runs BEFORE the axis merge: endpoint-
 * linked strip chains → recursive Douglas-Peucker-style split → circle fit
 * (Kasa) for arcs / PCA line fit for diagonals → coverage-gated acceptance
 * (text/annotation chains are sparse and rejected) → consumed strips are
 * resampled as dense ROTATED boxes (5th tuple element, plan radians);
 * everything else falls through to the axis pipeline unchanged.
 *
 * Room identity lives in the floor tints + labels + furniture kits; walls
 * only need to speak the big shapes (perimeter, major partitions).
 *
 * Pure geometry in plan meters; no Babylon imports (SRP, unit-testable).
 */

/** [cx, cz, w, d, rot?] — rot 为平面弧度（x 轴向 z 轴），缺省 = 轴对齐。 */
export type WallBox = [number, number, number, number, number?];

/** 碎片丢弃：长度与面积同时低于限值直接丢。 */
const MIN_LENGTH = 0.5;
const MIN_AREA = 0.1;
/** 结构墙最短保留长度 —— 短于此的 都是楼梯/家具符号/文字噪声。 */
const KEEP_LENGTH = 1.2;
/** 同轴线聚类的滑动均值容差（吸收楼梯状逐行错位）。 */
const LINE_TOL = 0.25;
/** 共线段拼接收口间隙（远小于门洞宽，不会把门洞焊死）。 */
const JOIN_GAP = 0.35;

/** 弧/斜墙检测：短划成链的端点邻接距离。 */
const CURVE_LINK = 1.2;
/** 拟合生效的最小条带数（短于此一律退回轴管线）。 */
const CURVE_MIN_SEG = 8;
/** 弧半径下限 —— 门拱 R≈0.9m 被此排除；立面弧 R≫5m。 */
const ARC_R_MIN = 3.0;
/** 圆拟合径向残差上限（提取条带中心抖动 ~±1 格）。 */
const ARC_RDEV_MAX = 0.28;
/** 斜线拟合垂向残差上限。 */
const LINE_RMS_MAX = 0.22;
/** 斜墙最短展长。 */
const LINE_SPAN_MIN = 3.0;
/** 消耗判定：条带中心距拟合几何的容差（容差外的分叉条带留给轴管线）。 */
const CONSUME_TOL = 0.3;
/** 链内沿拟合轴允许的最大空洞（提取器丢 1 格短划造成的虚线间隙）。 */
const CURVE_GAP_MAX = 1.2;
/** 覆盖度下限：墙沿拟合轴近连续；文字/标注链稀疏，被此排除。 */
const CURVE_FILL_MIN = 0.55;
/** 分段递归深度上限（退化链兜底，永不栈溢出）。 */
const CURVE_MAX_DEPTH = 24;
/** 共心弧段合并的圆心距/半径差容差与角向空洞容差（= CURVE_GAP_MAX/R）。 */
const ARC_MERGE_CENTER = 1.5;
const ARC_MERGE_R = 0.5;
/** 大跨度桥接（R95）：仅当圆参数高度一致时才允许跨越 >CURVE_GAP_MAX 的空洞。
 *  阈值按短弧拟合抖动标定（~35° 弧段的圆心抖动 ~1m、半径抖动 ~0.8m），
 *  真正的门洞防护由门点/门摆排除规则承担，不靠本阈值。 */
const ARC_MERGE_STRICT_CENTER = 1.0;
const ARC_MERGE_STRICT_R = 0.8;
/** 桥接弧长上限 —— 双开门 ~1.8m 之上、提取丢_dropout 的典型尺度内。 */
const ARC_BRIDGE_MAX = 2.2;
/** 桥接排除探测半径：门点/门摆碎条带出现在缺口弦中点附近 → 真门洞，不桥接。 */
const BRIDGE_PROBE = 1.0;
/** 弧端点搭接（R95）：端点近旁有未消耗条带（交接直墙）时外延的弧长。 */
const ARC_END_EXTEND = 0.3;
const JUNCTION_PROBE = 0.6;
/** 单条弧重采样的弦盒数上限。 */
const ARC_MAX_CHORDS = 64;

interface Seg {
  start: number;
  end: number;
  cross: number;
  thick: number;
}

export function simplifyWalls(
  walls: readonly WallBox[],
  doors: ReadonlyArray<readonly [number, number]> = [],
): WallBox[] {
  const cell = gridCell(walls);
  // 弧/斜墙先行：被消耗的条带不再进轴管线（避免旋转盒与阶梯轴盒双重渲染）
  const { boxes: curves, consumed } = curveWalls(walls, cell, doors);
  const rest = walls.filter((_, i) => !consumed.has(i));
  const horizontal = rest.filter(w => w[2] >= w[3]);
  const vertical = rest.filter(w => w[2] < w[3]);
  return [
    ...curves,
    ...mergeAxis(horizontal, true),
    ...mergeAxis(vertical, false),
    // 纵墙重建：提取器只产横向行程条带（垂直墙 = 一叠短条带，长度=墙厚），
    // 直接进 mergeAxis 会被滑动均值聚类按 cross 轴叠成一簇、合并回墙厚
    // 长度后遭 KEEP_LENGTH 过滤 —— 整层纵墙全灭、交接处全断（R93 根因）。
    // 把条带栅格化回占用网格后补一遍列行程扫描，纵墙以真实长度复活；
    // 行程在 T/L/十字交接处互相穿过（盒体交叠），交接无缝。
    ...mergeAxis(verticalRuns(horizontal, cell), false),
  ];
}

/** 栅格单元 = 条带深度（短边）的众数（= 提取器的 CELL_PX*mpp，各楼不同）。 */
function gridCell(walls: readonly WallBox[]): number {
  const freq = new Map<number, number>();
  for (const [, , w, d] of walls) {
    const key = Math.round(Math.min(w, d) * 100) / 100;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  let cell = 0;
  let best = -1;
  for (const [key, n] of freq) {
    if (n > best) {
      best = n;
      cell = key;
    }
  }
  return cell;
}

/**
 * 列行程扫描：横向条带 → 占用网格 → 每列的连续行段合成纵墙条带。
 * 门洞（≥0.8m 的空洞）会截断列行程，不会被焊死；横墙只贡献 1~2 行
 * 标记，列行程长度过短被 KEEP_LENGTH 自然过滤。
 */
function verticalRuns(horizontal: readonly WallBox[], cell: number): WallBox[] {
  if (horizontal.length === 0 || cell <= 0) return [];
  const cols = new Map<number, number[]>();
  for (const [cx, cz, w, d] of horizontal) {
    const r0 = Math.round((cz - d / 2) / cell);
    const r1 = Math.round((cz + d / 2) / cell);
    const c0 = Math.round((cx - w / 2) / cell);
    const c1 = Math.round((cx + w / 2) / cell);
    for (let c = c0; c < c1; c++) {
      const rows = cols.get(c) ?? [];
      for (let r = r0; r < r1; r++) rows.push(r);
      cols.set(c, rows);
    }
  }
  // 行程拼接容差（吸收楼梯状逐行错位；远小于门洞宽）
  const gapCells = Math.max(1, Math.round(JOIN_GAP / cell));
  const out: WallBox[] = [];
  for (const [c, rows] of cols) {
    rows.sort((a, b) => a - b);
    let r0 = rows[0];
    let prev = rows[0];
    const emit = (r1: number) => {
      const len = (r1 + 1 - r0) * cell;
      if (len <= cell) return; // 单格标记 = 横墙/噪声，纵墙至少 2 格
      out.push([c * cell + cell / 2, (r0 + r1 + 1) / 2 * cell, cell, len]);
    };
    for (const r of rows.slice(1)) {
      if (r - prev - 1 <= gapCells) {
        prev = r;
      } else {
        emit(prev);
        r0 = r;
        prev = r;
      }
    }
    emit(prev);
  }
  return out;
}

/** 沿 single 轴合并：横轴滑动均值聚类 → 簇内共线拼接 → 结构长度过滤。 */
function mergeAxis(list: readonly WallBox[], alongX: boolean): WallBox[] {
  const segs: Seg[] = list
    .map(([cx, cz, w, d]) =>
      alongX
        ? { start: cx - w / 2, end: cx + w / 2, cross: cz, thick: d }
        : { start: cz - d / 2, end: cz + d / 2, cross: cx, thick: w },
    )
    .filter(seg => seg.end - seg.start >= MIN_LENGTH || seg.end * seg.thick >= MIN_AREA)
    .sort((a, b) => a.cross - b.cross || a.start - b.start);

  // 横轴聚类：与簇内滑动均值接近的段并入同一墙线（吸收逐行错位）
  const lines: Seg[][] = [];
  for (const seg of segs) {
    let best: Seg[] | null = null;
    let bestDist = Infinity;
    for (const line of lines) {
      const mean = line.reduce((acc, l) => acc + l.cross, 0) / line.length;
      const dist = Math.abs(mean - seg.cross);
      if (dist < bestDist) {
        bestDist = dist;
        best = line;
      }
    }
    if (best && bestDist <= LINE_TOL + (best[0]?.thick ?? 0) * 0.5) best.push(seg);
    else lines.push([seg]);
  }

  const out: WallBox[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.start - b.start);
    let cur = { ...line[0] };
    for (const nxt of line.slice(1)) {
      if (nxt.start - cur.end <= JOIN_GAP) {
        cur.end = Math.max(cur.end, nxt.end);
        cur.thick = Math.max(cur.thick, nxt.thick);
        cur.cross = (cur.cross * 0.7 + nxt.cross * 0.3);
      } else {
        emit(out, cur, alongX);
        cur = { ...nxt };
      }
    }
    emit(out, cur, alongX);
  }
  return out;
}

function emit(out: WallBox[], seg: Seg, alongX: boolean): void {
  const len = seg.end - seg.start;
  if (len < KEEP_LENGTH) return; // 结构长度过滤：短桩全是噪声
  const center = (seg.start + seg.end) / 2;
  if (alongX) out.push([center, seg.cross, len, seg.thick]);
  else out.push([seg.cross, center, seg.thick, len]);
}

// ---------------------------------------------------------------------------
// 弧/斜墙恢复（R94）
// ---------------------------------------------------------------------------

interface CurvePoint {
  i: number; // 条带在输入数组中的下标（消耗标记用）
  x: number;
  z: number;
  w: number;
  d: number;
}

type ArcSeg = { kind: 'arc'; cx: number; cz: number; r: number; a0: number; span: number };
type LineSeg = { kind: 'line'; cx: number; cz: number; len: number; theta: number };

/**
 * 弧/斜墙检测：raw 条带 → 端点邻接链 → 递归分段拟合 → 旋转盒序列。
 * 返回旋转盒与被消耗的条带下标（未消耗的全部退回轴管线，语义零回退）。
 */
function curveWalls(
  walls: readonly WallBox[],
  cell: number,
  doors: ReadonlyArray<readonly [number, number]>,
): { boxes: WallBox[]; consumed: Set<number> } {
  const consumed = new Set<number>();
  const boxes: WallBox[] = [];
  if (walls.length === 0 || cell <= 0) return { boxes, consumed };

  const segs: Array<ArcSeg | LineSeg> = [];
  for (const chain of chainStrips(walls)) {
    const pts: CurvePoint[] = chain.map(i => ({
      i,
      x: walls[i][0],
      z: walls[i][1],
      w: walls[i][2],
      d: walls[i][3],
    }));
    fitOrSplit(pts, 0, segs, consumed);
  }

  // 未消耗条带（门摆/分叉/交接直墙碎段）：桥接排除与端点搭接的探测输入
  const orphans: Array<readonly [number, number]> = [];
  for (let i = 0; i < walls.length; i++) {
    if (!consumed.has(i)) orphans.push([walls[i][0], walls[i][1]]);
  }
  const nearOrphan = (x: number, z: number, r: number): boolean =>
    orphans.some(([ox, oz]) => Math.hypot(ox - x, oz - z) <= r);
  const nearDoor = (x: number, z: number, r: number): boolean =>
    doors.some(([dx, dz]) => Math.hypot(dx - x, dz - z) <= r);

  // 斜线 → 单个旋转盒（整段展长，厚度 = 格宽）
  for (const s of segs) {
    if (s.kind === 'line') boxes.push([s.cx, s.cz, s.len, cell, s.theta]);
  }

  // 共心弧段合并（同一立面弧被门洞/交接打断的多段）→ 弦盒重采样
  const arcs = segs.filter((s): s is ArcSeg => s.kind === 'arc');
  arcs.sort((a, b) => a.cx - b.cx || a.cz - b.cz || a.r - b.r || a.a0 - b.a0);
  const merged: ArcSeg[] = [];
  for (const arc of arcs) {
    const m = merged[merged.length - 1];
    const centerDist = m ? Math.hypot(arc.cx - m.cx, arc.cz - m.cz) : Infinity;
    const rDiff = m ? Math.abs(arc.r - m.r) : Infinity;
    // 常规合并闸（R94 语义：参数近 → 仅小空洞容差直接拼接）；
    // 严格一致闸（R95：参数高度一致 → 允许 ≤2.2m 桥接，门洞证据排除）
    const normalClose = m && centerDist < ARC_MERGE_CENTER && rDiff < ARC_MERGE_R;
    const strictClose = m && centerDist < ARC_MERGE_STRICT_CENTER && rDiff < ARC_MERGE_STRICT_R;
    if (m && (normalClose || strictClose)) {
      const tol = CURVE_GAP_MAX / m.r; // 角向空洞容差
      const rel = (((arc.a0 - m.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // 大跨度桥接（R95）：缺口弦中点附近的门点/门摆碎段 = 真门洞证据 ——
      // 门洞不桥接；无任何证据（提取 dropout）且圆参数高度一致才桥接
      const bridgeable = (gapA0: number, gapA1: number): boolean => {
        const mid = (gapA0 + gapA1) / 2;
        const px = m.cx + m.r * Math.cos(mid);
        const pz = m.cz + m.r * Math.sin(mid);
        return !nearDoor(px, pz, BRIDGE_PROBE) && !nearOrphan(px, pz, BRIDGE_PROBE);
      };
      const bridgeTol = ARC_BRIDGE_MAX / m.r;
      if (normalClose && rel <= m.span + tol) {
        // arc 起点落在 m 角域内或紧随其后 → 延伸尾部
        m.span = Math.min(Math.max(m.span, rel + arc.span), 2 * Math.PI);
        continue;
      }
      if (strictClose && rel <= m.span + bridgeTol && bridgeable(m.a0 + m.span, m.a0 + rel)) {
        m.span = Math.min(rel + arc.span, 2 * Math.PI);
        continue;
      }
      const gapBefore = (2 * Math.PI - rel - arc.span + 2 * Math.PI) % (2 * Math.PI);
      if (normalClose && gapBefore <= tol) {
        // arc 终点紧接着 m 起点 → 向前延伸
        m.a0 = arc.a0;
        m.span = Math.min(m.span + gapBefore + arc.span, 2 * Math.PI);
        continue;
      }
      if (strictClose && gapBefore <= bridgeTol && bridgeable(arc.a0 + arc.span, m.a0)) {
        m.a0 = arc.a0;
        m.span = Math.min(m.span + gapBefore + arc.span, 2 * Math.PI);
        continue;
      }
    }
    merged.push({ ...arc });
  }
  for (const arc of merged) {
    // 弧端点搭接（R95）：端点旁有未消耗条带 = 交接直墙证据，外延 ≤0.3m
    // 让末端弦盒与轴对齐墙盒交叠 —— 交接不见缝；真门洞旁无此证据
    const ext = ARC_END_EXTEND / arc.r;
    const sx = arc.cx + arc.r * Math.cos(arc.a0);
    const sz = arc.cz + arc.r * Math.sin(arc.a0);
    if (nearOrphan(sx, sz, JUNCTION_PROBE)) {
      arc.a0 -= ext;
      arc.span += ext;
    }
    const ex = arc.cx + arc.r * Math.cos(arc.a0 + arc.span);
    const ez = arc.cz + arc.r * Math.sin(arc.a0 + arc.span);
    if (nearOrphan(ex, ez, JUNCTION_PROBE)) arc.span += ext;
    arc.span = Math.min(arc.span, 2 * Math.PI);
  }
  for (const { cx, cz, r, a0, span } of merged) {
    // 弦高（sagitta）≤ 格宽/4 的步长；弧再平缓也不超过 ARC_MAX_CHORDS 盒
    const dth = Math.min(2 * Math.acos(Math.max(-1, 1 - cell / (4 * r))), 0.35);
    const n = Math.min(ARC_MAX_CHORDS, Math.max(2, Math.ceil(span / dth)));
    for (let k = 0; k < n; k++) {
      const t0 = a0 + (span * k) / n;
      const t1 = a0 + (span * (k + 1)) / n;
      const x0 = cx + r * Math.cos(t0);
      const z0 = cz + r * Math.sin(t0);
      const x1 = cx + r * Math.cos(t1);
      const z1 = cz + r * Math.sin(t1);
      const len = Math.hypot(x1 - x0, z1 - z0) * 1.15; // 微重叠消拼缝
      boxes.push([
        (x0 + x1) / 2,
        (z0 + z1) / 2,
        len,
        cell,
        Math.atan2(z1 - z0, x1 - x0),
      ]);
    }
  }
  return { boxes, consumed };
}

/** 端点邻接成链（并查集；扫描窗口按 cx 排序剪枝，确定性顺序）。 */
function chainStrips(walls: readonly WallBox[]): number[][] {
  const n = walls.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const ends = walls.map(([cx, cz, w]) => ({
    x0: cx - w / 2,
    x1: cx + w / 2,
    z: cz,
  }));
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => walls[a][0] - walls[b][0] || walls[a][1] - walls[b][1],
  );
  for (let ai = 0; ai < n; ai++) {
    const i = order[ai];
    for (let bi = ai + 1; bi < n; bi++) {
      const j = order[bi];
      if (walls[j][0] - walls[i][0] > CURVE_LINK + (walls[i][2] + walls[j][2]) / 2) break;
      if (Math.abs(walls[j][1] - walls[i][1]) > CURVE_LINK + (walls[i][3] + walls[j][3]) / 2 + 0.5)
        continue;
      const dist = Math.min(
        Math.hypot(ends[i].x0 - ends[j].x0, ends[i].z - ends[j].z),
        Math.hypot(ends[i].x0 - ends[j].x1, ends[i].z - ends[j].z),
        Math.hypot(ends[i].x1 - ends[j].x0, ends[i].z - ends[j].z),
        Math.hypot(ends[i].x1 - ends[j].x1, ends[i].z - ends[j].z),
      );
      if (dist <= CURVE_LINK) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const g = groups.get(find(i)) ?? [];
    g.push(i);
    groups.set(find(i), g);
  }
  return [...groups.values()]
    .map(g => g.sort((a, b) => walls[a][0] - walls[b][0] || walls[a][1] - walls[b][1]))
    .sort((a, b) => walls[a[0]][0] - walls[b[0]][0] || walls[a[0]][1] - walls[b[0]][1]);
}

/** Kasa 代数圆拟合（确定性闭式解）。 */
function circleFit(pts: readonly CurvePoint[]): { cx: number; cz: number; r: number; rdev: number } | null {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const mz = pts.reduce((a, p) => a + p.z, 0) / n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, suvv = 0, svvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.z - mz;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; suvv += u * v * v; svvv += v * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const bu = (suuu + suvv) / 2;
  const bv = (svvv + svuu) / 2;
  const uc = (bu * svv - bv * suv) / det;
  const vc = (suu * bv - suv * bu) / det;
  const cx = mx + uc;
  const cz = mz + vc;
  const rs = pts.map(p => Math.hypot(p.x - cx, p.z - cz));
  const r = rs.reduce((a, b) => a + b, 0) / n;
  if (r < 1e-6) return null;
  const rdev = Math.sqrt(rs.reduce((a, rr) => a + (rr - r) ** 2, 0) / n);
  return { cx, cz, r, rdev };
}

/** PCA 主线拟合：方向角 + 垂向 rms + 投影区间。 */
function lineFit(pts: readonly CurvePoint[]): {
  theta: number;
  rms: number;
  u0: number;
  u1: number;
  mx: number;
  mz: number;
} {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const mz = pts.reduce((a, p) => a + p.z, 0) / n;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    szz += (p.z - mz) ** 2;
    sxz += (p.x - mx) * (p.z - mz);
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(theta);
  const dz = Math.sin(theta);
  let rms = 0;
  let u0 = Infinity, u1 = -Infinity;
  for (const p of pts) {
    rms += (-(p.x - mx) * dz + (p.z - mz) * dx) ** 2;
    const u = (p.x - mx) * dx + (p.z - mz) * dz;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
  }
  return { theta, rms: Math.sqrt(rms / n), u0, u1, mx, mz };
}

/** 角域展长与起始角（最大角间隙的补集）。 */
function angularSpan(angs: readonly number[]): { span: number; a0: number } {
  const sorted = [...angs].sort((a, b) => a - b);
  if (sorted.length < 2) return { span: 0, a0: sorted[0] ?? 0 };
  let maxGap = -1;
  let maxIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    const gap =
      i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : sorted[0] + 2 * Math.PI - sorted[i];
    if (gap > maxGap) {
      maxGap = gap;
      maxIdx = i;
    }
  }
  return {
    span: 2 * Math.PI - maxGap,
    a0: sorted[(maxIdx + 1) % sorted.length],
  };
}

/**
 * 沿拟合轴的覆盖度：墙条带近连续（提取丢 1 格短划留下 ≤~1m 空洞），
 * 文字/标注链稀疏破碎 —— 填充率与最大空洞双闸排除伪拟合。
 */
function coverage(intervals: Array<{ u: number; half: number }>): { fill: number; maxGap: number } {
  const ivs = intervals
    .map(({ u, half }) => ({ lo: u - half, hi: u + half }))
    .sort((a, b) => a.lo - b.lo);
  let covered = 0;
  let maxGap = 0;
  let ce = ivs[0].lo;
  let ch = ivs[0].hi;
  for (const { lo, hi } of ivs.slice(1)) {
    if (lo > ch) {
      if (lo - ch > maxGap) maxGap = lo - ch;
      covered += ch - ce;
      ce = lo;
      ch = hi;
    } else if (hi > ch) {
      ch = hi;
    }
  }
  covered += ch - ce;
  const span = ivs[ivs.length - 1].hi - ivs[0].lo;
  return { fill: span > 0 ? covered / span : 0, maxGap };
}

/**
 * 递归分段拟合（Douglas-Peucker 式）：整段能拟合圆/斜线就接受并消耗
 * 条带，否则在最大偏差处切开递归；都不行的条带原样退回轴管线。
 */
function fitOrSplit(
  pts: readonly CurvePoint[],
  depth: number,
  out: Array<ArcSeg | LineSeg>,
  consumed: Set<number>,
): void {
  if (pts.length < CURVE_MIN_SEG || depth > CURVE_MAX_DEPTH) return;

  // 1) 圆拟合（弧墙优先 —— 共圆是更强的结构信号）
  const cf = circleFit(pts);
  if (cf && cf.r >= ARC_R_MIN && cf.rdev <= ARC_RDEV_MAX) {
    const angs = pts.map(p => Math.atan2(p.z - cf.cz, p.x - cf.cx));
    const { span, a0 } = angularSpan(angs);
    if ((span * 180) / Math.PI >= 8) {
      const { fill, maxGap } = coverage(
        pts.map(p => {
          const tx = -(p.z - cf.cz) / cf.r;
          const tz = (p.x - cf.cx) / cf.r;
          return {
            u: Math.atan2(p.z - cf.cz, p.x - cf.cx),
            half: ((p.w * Math.abs(tx) + p.d * Math.abs(tz)) / 2) / cf.r,
          };
        }),
      );
      if (fill >= CURVE_FILL_MIN && maxGap * cf.r <= CURVE_GAP_MAX) {
        for (const p of pts) {
          if (Math.abs(Math.hypot(p.x - cf.cx, p.z - cf.cz) - cf.r) <= CONSUME_TOL) {
            consumed.add(p.i);
          }
        }
        out.push({ kind: 'arc', cx: cf.cx, cz: cf.cz, r: cf.r, a0, span });
        return;
      }
    }
  }

  // 2) 斜线拟合（12°..78° —— 近轴墙留给轴管线，语义不回退）
  const lf = lineFit(pts);
  const degRaw = Math.abs((lf.theta * 180) / Math.PI) % 180;
  const deg = Math.min(degRaw, 180 - degRaw);
  if (deg >= 12 && deg <= 78 && lf.rms <= LINE_RMS_MAX && lf.u1 - lf.u0 >= LINE_SPAN_MIN) {
    const dx = Math.cos(lf.theta);
    const dz = Math.sin(lf.theta);
    const { fill, maxGap } = coverage(
      pts.map(p => ({
        u: (p.x - lf.mx) * dx + (p.z - lf.mz) * dz,
        half: (p.w * Math.abs(dx) + p.d * Math.abs(dz)) / 2,
      })),
    );
    if (fill >= CURVE_FILL_MIN && maxGap <= CURVE_GAP_MAX) {
      for (const p of pts) {
        const u = (p.x - lf.mx) * dx + (p.z - lf.mz) * dz;
        const perp = Math.abs(-(p.x - lf.mx) * dz + (p.z - lf.mz) * dx);
        if (u >= lf.u0 - 0.2 && u <= lf.u1 + 0.2 && perp <= CONSUME_TOL) consumed.add(p.i);
      }
      const um = (lf.u0 + lf.u1) / 2;
      out.push({
        kind: 'line',
        cx: lf.mx + um * dx,
        cz: lf.mz + um * dz,
        len: lf.u1 - lf.u0,
        theta: lf.theta,
      });
      return;
    }
  }

  // 3) 分裂：弦（最远点对；大链退化为 PCA 轴端点控制 O(n²) 开销）+
  // 最大垂偏处切开（退化则放弃，退回轴管线）
  let x1: number, z1: number, x2: number, z2: number;
  if (pts.length <= 500) {
    let bi = 0, bj = 1, bd = -1;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const dd = (pts[a].x - pts[b].x) ** 2 + (pts[a].z - pts[b].z) ** 2;
        if (dd > bd) {
          bd = dd;
          bi = a;
          bj = b;
        }
      }
    }
    x1 = pts[bi].x; z1 = pts[bi].z; x2 = pts[bj].x; z2 = pts[bj].z;
  } else {
    const dx = Math.cos(lf.theta);
    const dz = Math.sin(lf.theta);
    x1 = lf.mx + lf.u0 * dx; z1 = lf.mz + lf.u0 * dz;
    x2 = lf.mx + lf.u1 * dx; z2 = lf.mz + lf.u1 * dz;
  }
  const chordLen = Math.hypot(x2 - x1, z2 - z1);
  if (chordLen < 1e-6) return;
  const ux = (x2 - x1) / chordLen;
  const uz = (z2 - z1) / chordLen;
  let kMax = -1;
  let maxPerp = -1;
  const projs = pts.map(p => (p.x - x1) * ux + (p.z - z1) * uz);
  for (let k = 0; k < pts.length; k++) {
    const perp = Math.abs(-(pts[k].x - x1) * uz + (pts[k].z - z1) * ux);
    if (perp > maxPerp) {
      maxPerp = perp;
      kMax = k;
    }
  }
  if (kMax < 0) return;
  const tMax = projs[kMax];
  const left = pts.filter((_, k) => projs[k] <= tMax);
  const right = pts.filter((_, k) => projs[k] > tMax);
  if (left.length === 0 || right.length === 0 || left.length === pts.length) return;
  fitOrSplit(left, depth + 1, out, consumed);
  fitOrSplit(right, depth + 1, out, consumed);
}
