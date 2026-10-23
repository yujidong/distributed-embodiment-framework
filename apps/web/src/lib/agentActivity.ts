/**
 * Agent 活化（UX-W4 campus-walk traversal）— campus-3d avatar 的决策驱动
 * 迁移信号，纯函数层（无 Babylon 依赖，vitest 直测）：
 *
 * - `agentActivityTargets` — 世界会话快照的 recentDecisions 环（新决策在
 *   尾）→ 每个 agent 最新一条带 zoneId 的决策；超过保鲜窗（墙钟 TTL）
 *   的记录失效，调用方据此让 avatar 逐渐回到辖区质心；
 * - `activityAnchorForZone` — 目标 zone → avatar 锚点（scene meters）：
 *   zone 质心 + 该层中部高度，与 lib/campus3d `agentPlacements` 的辖区
 *   锚点同一套几何，保证「飞出去」和「回家」落在同一坐标系。
 *
 * 动画本身（lerp、instance/材质原地写回）在 components/campus/agents.ts；
 * 决策→zone 的判定全部在此文件，渲染层不做映射。
 */

import type { EnvZone, RuntimeDecisionRecord } from '../api/types';
import {
  resolveStoreyHeight,
  zoneCentroidMeters,
  type GeoAnchor,
  type Vec3,
} from './campus3d';

/**
 * 决策活性的保鲜窗（墙钟 ms）：一条决策让 avatar 驻留目标 zone 的时长；
 * 超时即视为「无决策」，avatar 平滑回辖区。取 60 s ≈ 15 个快照轮询周期
 * （4 s），一次活跃事件簇内的连续决策会不断续期。
 */
export const AGENT_ACTIVITY_TTL_MS = 60_000;

export interface AgentActivityTarget {
  zoneId: string;
  /** 决策记录的 ISO 时间戳（透出便于调试/测试）。 */
  at: string;
}

/**
 * recentDecisions → 每个 agent 的当前活性目标。同一 agent 取最新一条带
 * zoneId 的决策（环内顺序即时间序，后写覆盖先写）；zoneId 缺失的决策
 * （无法定位的触发）不构成位置信号；超过 TTL 的记录直接失效。
 */
export function agentActivityTargets(
  decisions: readonly RuntimeDecisionRecord[],
  nowMs: number,
  ttlMs: number = AGENT_ACTIVITY_TTL_MS,
): Map<string, AgentActivityTarget> {
  const targets = new Map<string, AgentActivityTarget>();
  for (const record of decisions) {
    const zoneId = record.zoneId ?? null;
    if (!zoneId) continue;
    const atMs = Date.parse(record.at);
    // 时间戳不可读或已过保鲜窗 → 不构成信号（未来时间戳按新鲜处理，
    // 吸收快照端与浏览器的轻微时钟偏差）。
    if (!Number.isFinite(atMs) || nowMs - atMs > ttlMs) continue;
    targets.set(record.agentId, { zoneId, at: record.at });
  }
  return targets;
}

/**
 * 目标 zone → avatar 锚点（scene meters，x = east, y = up, z = south）：
 * 质心同 agentPlacements 的 zoneCentroidMeters，高度为该层层中
 * （floor * storeyHeight + sh/2）。zone 无任何几何（无 polygon 且无
 * bounds）→ null，调用方保持原位（诚实不动，不猜位置）。
 */
export function activityAnchorForZone(
  zone: EnvZone | undefined,
  options: { storeyHeight?: number | null; anchor?: GeoAnchor | null } = {},
): Vec3 | null {
  const centroid = zoneCentroidMeters(zone, options.anchor ?? null);
  if (!centroid) return null;
  const sh = resolveStoreyHeight(options.storeyHeight);
  return { x: centroid.x, y: (zone?.floor ?? 0) * sh + sh / 2, z: centroid.z };
}
