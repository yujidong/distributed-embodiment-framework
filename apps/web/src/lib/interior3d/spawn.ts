/**
 * R2-BUG-02: 漫游出生点纯函数（rasterPath 装配，vitest 直测）。
 *
 * 修复前 hint 出生 `yaw = Math.atan2(-dxc, -dzc)` 背对楼栋中心（世界前向 =
 * (sin yaw, cos yaw)），且 backOff 把出生点推到 anchor 标记的「楼外侧」——
 * 相机出生在楼外面朝楼外，1F 出生场景只剩天空与草地。现语义：
 *
 * - hint 出生点取 anchor（房间标记）朝**建筑中心**一侧 backOff 米处 ——
 *   保证仍在楼内（anchor 在楼包络内，朝楼心方向收缩不越界）；
 * - 朝向面向 anchor（「面朝房间」，与 :597 旧注释的意图一致）；
 * - 出生点若落进墙体盒，沿同一方向朝 anchor 逐步收缩（spawnAt t: 1 → 0），
 *   由调用方传入 isBlocked 判定（保守轴对齐包围，略大无妨）。
 */

export interface SpawnAnchor {
  x: number;
  z: number;
}

export interface ResolvedSpawn extends SpawnAnchor {
  /** 世界前向 = (sin yaw, cos yaw)。 */
  yaw: number;
}

/** hint 出生：anchor 朝 center 一侧 backOff 米、面向 anchor。 */
export function resolveHintedSpawn(
  anchor: SpawnAnchor,
  center: SpawnAnchor,
  isBlocked: (x: number, z: number) => boolean,
  backOff = 4,
): ResolvedSpawn {
  const dxc = center.x - anchor.x;
  const dzc = center.z - anchor.z;
  const len = Math.hypot(dxc, dzc) || 1;
  const spawnAt = (t: number): SpawnAnchor => ({
    x: anchor.x + (dxc / len) * (backOff * t),
    z: anchor.z + (dzc / len) * (backOff * t),
  });
  let spawn = spawnAt(1);
  if (isBlocked(spawn.x, spawn.z)) {
    for (let t = 0.9; t >= 0; t -= 0.1) {
      const c = spawnAt(t);
      if (!isBlocked(c.x, c.z)) {
        spawn = c;
        break;
      }
    }
  }
  // 面向 anchor：spawn 在 anchor 朝 center 一侧 → anchor - spawn ∝ (-dxc, -dzc)。
  return { ...spawn, yaw: Math.atan2(-dxc, -dzc) };
}
