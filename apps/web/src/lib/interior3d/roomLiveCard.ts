/**
 * Room live card assembly (UX-W4) — pure data for the interior walk's E
 * card: room readings (temperature / co2 / occupancy / alert, resolved
 * against the room's OWNING zone) + the devices physically inside the
 * room (point-in-room-box against the raster room patches).
 *
 * Page renders; this module owns the shape so vitest can pin it.
 */

import type { InteriorDevice, RasterInterior } from '../../components/interior/types';

export interface RoomLiveInput {
  tempC: number | null;
  co2: number | null;
  occupancy: number | null;
  alert: boolean;
}

export interface RoomCardData {
  code: string;
  live: RoomLiveInput;
  devices: InteriorDevice[];
}

/** Raster room entry for a code (null when the code isn't a raster room). */
export function roomOfRaster(
  raster: Pick<RasterInterior, 'rooms'>,
  code: string,
): NonNullable<RasterInterior['rooms']>[number] | null {
  return raster.rooms?.find(r => r.code === code) ?? null;
}

/** Devices whose plan position falls inside any of the room's patches. */
export function devicesInRoom(
  raster: Pick<RasterInterior, 'rooms'>,
  code: string,
  devices: readonly InteriorDevice[],
): InteriorDevice[] {
  const room = roomOfRaster(raster, code);
  if (!room) return [];
  return devices.filter(d =>
    room.boxes.some(
      ([cx, cz, w, dep]) => Math.abs(d.x - cx) <= w / 2 && Math.abs(d.z - cz) <= dep / 2,
    ),
  );
}

/** Assemble the E-card payload for one picked room. */
export function assembleRoomCard(args: {
  code: string;
  raster: Pick<RasterInterior, 'rooms'>;
  devices: readonly InteriorDevice[];
  live: RoomLiveInput;
}): RoomCardData {
  return {
    code: args.code,
    live: args.live,
    devices: devicesInRoom(args.raster, args.code, args.devices),
  };
}
