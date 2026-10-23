/**
 * InteriorWalkScene — facade over the interior render path.
 *
 * UX-W4: there is now ONE path. The raster path serves every environment —
 * pre-baked plan rasters (`/interior/bldg-*.json`) win; otherwise the page
 * synthesizes an equivalent raster from map_data
 * (lib/interior3d/rasterFromMapData: zone bounds/polygon → perimeter
 * walls, room tints, carved doors, labels). The old polygonPath stub
 * (footprint slab + markers, all interactive features stubbed) is gone —
 * zones without bounds AND without a polygon are rejected upstream with an
 * explicit degrade UI instead of a silent half-scene.
 *
 * Consumers only see `createInteriorWalkScene(options)` and the
 * `InteriorWalkSceneHandle` (pick / place / live overlay / dispose).
 */

import type {
  InteriorWalkSceneHandle,
  InteriorWalkSceneOptions,
} from './types';

export type {
  DeployKind,
  InteriorDevice,
  InteriorWalkSceneHandle,
  RasterInterior,
} from './types';
import { createFromRaster } from './rasterPath';

export function createInteriorWalkScene(
  opts: InteriorWalkSceneOptions,
): InteriorWalkSceneHandle {
  return createFromRaster(opts);
}
