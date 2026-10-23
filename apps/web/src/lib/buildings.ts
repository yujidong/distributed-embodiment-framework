/**
 * Building grouping (W4 map navigation) — pure helpers behind the world
 * map's 楼栋 chip row:
 *
 * - `listBuildings` derives the distinct building ids across zones (zones
 *   carry an optional `buildingId`; environments without any building
 *   metadata render no chips at all);
 * - `zoneIdsInBuilding` collects the zone ids of ONE building, the fit
 *   target when a building chip is focused.
 */

export interface ZoneBuildingRef {
  id: string;
  buildingId?: string;
}

/** Distinct non-empty building ids, sorted for a stable chip order. */
export function listBuildings(zones: readonly ZoneBuildingRef[]): string[] {
  const set = new Set<string>();
  for (const zone of zones) {
    if (typeof zone.buildingId === 'string' && zone.buildingId.trim() !== '') {
      set.add(zone.buildingId);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Ids of the zones belonging to one building (empty set when none match). */
export function zoneIdsInBuilding(
  zones: readonly ZoneBuildingRef[],
  buildingId: string,
): Set<string> {
  return new Set(zones.filter(zone => zone.buildingId === buildingId).map(zone => zone.id));
}

/**
 * Display label for a building chip: raw ids like `dorm1-bldg` are technical,
 * so strip the conventional suffix and uppercase (`dorm1-bldg` → `DORM1`).
 */
export function formatBuildingId(buildingId: string): string {
  return buildingId.replace(/-(bldg|building)$/i, '').toUpperCase();
}

export interface ZoneFloorRef {
  floor?: number;
  /** Zone type — 'outdoor' marks the ground-level exterior (R101). */
  type?: string;
}

/** R101: a zone whose type marks it as the building's exterior ground. */
export function zoneIsOutdoor(zone: Pick<ZoneFloorRef, 'type'>): boolean {
  return /^outdoor$/i.test(zone.type ?? '');
}

export interface FloorLabeling {
  /**
   * Display label for one storey number — used by the floor-switcher chips,
   * the zone ⇅ badges and the walk/sim consoles alike (R101: ONE source).
   */
  label(floor: number): string;
  /** True when floor 0 is the outdoor ground (1-based indoor convention). */
  outdoorGround: boolean;
}

/**
 * R101 (li-02/chen-05, three rounds): the ONE floor-grouping + labeling rule
 * behind every floor chip and zone badge. The platform data model is
 * 0-based (building-simulation-design: floor 0 = 地面层), but real
 * environments in the wild author 1-based indoor floors with the outdoor
 * ground at 0 (AIoT 实验楼: 一层 floor=1, 二层 floor=2, 楼外 floor=0) — the
 * old `floor + 1` labeler pushed every indoor floor one storey up and
 * invented a phantom 3F.
 *
 * Convention detection (data-driven, no guessing): when floor 0 exists and
 * contains ONLY outdoor-type zones and at least one zone sits above it, the
 * ground storey is the outdoors — indoor floors label DIRECTLY (floor 1 →
 * "1F") and floor 0 groups separately as 楼外. Otherwise the 0-based model
 * applies: floor N labels "(N+1)F" (outdoor zones ride their storey).
 * Basements always label B1/B2….
 */
export function floorLabeling(
  zones: readonly ZoneFloorRef[],
  outdoorLabel: string,
): FloorLabeling {
  const ground = zones.filter(zone => (zone.floor ?? 0) === 0);
  const outdoorGround =
    ground.length > 0 &&
    ground.every(zoneIsOutdoor) &&
    zones.some(zone => (zone.floor ?? 0) > 0);
  return {
    outdoorGround,
    label: floor => {
      if (floor < 0) return `B${-floor}`;
      if (outdoorGround) return floor === 0 ? outdoorLabel : `${floor}F`;
      return `${floor + 1}F`;
    },
  };
}

/**
 * Default storey for the map's floor switcher (R97): the storey with the
 * most zones (usually the ground-floor lobby level), ties broken towards
 * ground — NOT the lowest storey: with a basement in the set, floors[0] is
 * a B1 that only one or two buildings have, and the default map renders
 * nearly empty.
 */
export function defaultActiveFloor(
  zones: readonly ZoneFloorRef[],
  floors: readonly number[],
): number {
  let best = floors[0] ?? 0;
  let bestCount = -1;
  for (const floor of floors) {
    const count = zones.filter(zone => (zone.floor ?? 0) === floor).length;
    if (count > bestCount || (count === bestCount && Math.abs(floor) < Math.abs(best))) {
      best = floor;
      bestCount = count;
    }
  }
  return best;
}
