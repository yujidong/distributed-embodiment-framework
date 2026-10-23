/**
 * R2-BUG-01: 漫游楼栋推导回落链（InteriorWalkPage 的唯一事实源，纯函数以便
 * vitest 直测）。
 *
 * 旧启发式只认「有 positioned rooms 的楼」（R82 太仓导览楼时代）——参数化
 * 模板 / 楼栋生成器 / OSM 导入 / starter-home（zone 连 buildingId 都没有）
 * 一律 building=null，漫游页 Loading 门永闭、超时计时器也不启动。回落链：
 *   1. hinted zone（?zone= 深链）自带的 buildingId；
 *   2. 第一个「有 positioned rooms 且有 buildingId」的 zone 的楼
 *      （太仓导览楼启发式，保留原位）；
 *   3. 第一个有 buildingId 的 zone 的楼；
 *   4. 全部 zone 合成伪楼栋（buildingId 规范化为 __default__ 再喂
 *      rasterFromMapData —— 它按 buildingId 过滤）。
 * zones 为空 → null（页面走显式降级页，而不是永久 Loading）。
 */

import type { EnvZone } from '../../api/types';

/** 伪楼栋 id：环境内 zone 全无 buildingId 时合成（starter-home / 手绘环境）。 */
export const WALK_PSEUDO_BUILDING_ID = '__default__';

export interface WalkFloorEntry {
  zone: EnvZone;
  floor: number;
}

export interface WalkBuildingResolution {
  buildingId: string;
  /** 每层一条（同层多 zone 折叠，hinted zone 赢自己层的槽位），按 floor 升序。 */
  floors: WalkFloorEntry[];
  /** 喂给 rasterFromMapData 的 zone 集（伪楼栋档已规范化 buildingId）。 */
  zones: EnvZone[];
  /**
   * hinted zone 未落在解析出的楼栋里（或 ?zone= 指向未知 zone）时，URL 应
   * 校正到的 zone id（落点楼第一层的 zone）；无需校正为 null。
   */
  fallbackZoneId: string | null;
}

const hasPositionedRooms = (z: EnvZone): boolean =>
  Array.isArray(z.rooms) &&
  z.rooms.some(r => Array.isArray(r.pos) && r.pos.length === 2);

function floorsFor(buildingZones: readonly EnvZone[], hinted: EnvZone | undefined): WalkFloorEntry[] {
  const byFloor = new Map<number, WalkFloorEntry>();
  for (const z of buildingZones) {
    const floor = z.floor ?? 0;
    if (!byFloor.has(floor)) byFloor.set(floor, { zone: z, floor });
  }
  if (hinted !== undefined) {
    byFloor.set(hinted.floor ?? 0, { zone: hinted, floor: hinted.floor ?? 0 });
  }
  return [...byFloor.values()].sort((a, b) => a.floor - b.floor);
}

export function resolveWalkBuilding(
  zones: readonly EnvZone[],
  zoneParam: string | null,
): WalkBuildingResolution | null {
  if (zones.length === 0) return null;
  const hinted = zoneParam ? zones.find(z => z.id === zoneParam) : undefined;

  const buildingId =
    hinted?.buildingId ??
    zones.find(z => z.buildingId != null && hasPositionedRooms(z))?.buildingId ??
    zones.find(z => z.buildingId != null)?.buildingId ??
    null;

  if (buildingId === null) {
    // 回落链第 4 档：无 zone 声明 buildingId → 全部 zone 合成伪楼栋。
    const normalized = zones.map(z => ({
      ...z,
      buildingId: z.buildingId ?? WALK_PSEUDO_BUILDING_ID,
    }));
    const hintedN = hinted ? normalized.find(z => z.id === hinted.id) : undefined;
    const floors = floorsFor(normalized, hintedN);
    return {
      buildingId: WALK_PSEUDO_BUILDING_ID,
      floors,
      zones: normalized,
      fallbackZoneId:
        zoneParam && hintedN === undefined ? (floors[0]?.zone.id ?? null) : null,
    };
  }

  const inBuilding = zones.filter(z => z.buildingId === buildingId);
  const hintedIn = hinted !== undefined && hinted.buildingId === buildingId ? hinted : undefined;
  const floors = floorsFor(inBuilding, hintedIn);
  return {
    buildingId,
    floors,
    zones: zones as EnvZone[],
    fallbackZoneId:
      zoneParam && hintedIn === undefined ? (floors[0]?.zone.id ?? null) : null,
  };
}
