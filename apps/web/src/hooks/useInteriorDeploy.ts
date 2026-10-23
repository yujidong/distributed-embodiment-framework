/**
 * useInteriorDeploy — R82 phase 2: the IoT deployment state machine for the
 * interior walk, extracted from the page (SRP: the page renders, the hook
 * owns deploy state and platform calls).
 *
 * Owns:
 * - the active deploy kind (palette selection) and its ghost placement
 * - plan-meter → lat/lng placement → POST /environments/:id/devices
 * - the active-simulation lookup (device commands route through the sim)
 * - device on/off toggling (sim command + local visual flip)
 * - the current floor's devices mapped into plan meters
 *
 * Callers pass { envId, env, setEnv, current, geoMapping, onPlaceFailed? }
 * and receive the deploy palette data plus refs safe to use inside the
 * render loop. Server-side placement failures surface via onPlaceFailed
 * (DEPLOY-F1) so the page can flash a localized hint.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import * as api from '../api/client';
import type { EnvZone } from '../api/types';
import type { PlanGeoMapping } from '../lib/interior3d/geoPlan';
import { latLngToPlanMeters, planToLatLng } from '../lib/interior3d/geoPlan';
import type { DeployKind, InteriorDevice } from '../components/interior/types';

const ACTIVE_STATES = new Set(['created', 'running', 'paused']);

/** DEPLOY-F1: classify a placement failure for user-facing feedback —
 *  401/403 (anonymous / non-member) reads differently from other errors. */
export function placeFailureKind(error: unknown): 'forbidden' | 'error' {
  if (error instanceof api.ApiClientError && (error.status === 401 || error.status === 403)) {
    return 'forbidden';
  }
  return 'error';
}

interface UseInteriorDeployArgs {
  envId: string;
  env: Awaited<ReturnType<typeof api.getEnvironment>> | null;
  setEnv: (env: Awaited<ReturnType<typeof api.getEnvironment>>) => void;
  current: { zone: EnvZone } | null;
  geoMapping: PlanGeoMapping | null;
  /** Server rejected the placement (DEPLOY-F1: was console.warn-only silence). */
  onPlaceFailed?: (kind: 'forbidden' | 'error') => void;
  /** Placement attempted where NO geo mapping exists (non-geo world) —
   *  the ghost already says "unavailable", but an E/click attempt must not
   *  be silently swallowed either (ux-w4 probe P3①). */
  onPlaceUnavailable?: () => void;
}

export function useInteriorDeploy({
  envId,
  env,
  setEnv,
  current,
  geoMapping,
  onPlaceFailed,
  onPlaceUnavailable,
}: UseInteriorDeployArgs) {
  const [deployKind, setDeployKind] = useState<DeployKind | null>(null);
  // UX-W3: optional custom device name for the next placement (blank falls
  // back to the old「类型 + 时刻」auto-name).
  const [deployName, setDeployName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localOn, setLocalOn] = useState<Record<string, boolean>>({});
  const [simId, setSimId] = useState<string | null>(null);

  // active simulation (device commands route through the sim)
  useEffect(() => {
    if (!env) return;
    let alive = true;
    api
      .listSimulations()
      .then(sims => {
        if (!alive) return;
        const active = sims.filter(
          s => s.environmentId === envId && ACTIVE_STATES.has(s.state),
        );
        setSimId(active[0]?.id ?? null);
      })
      .catch(() => alive && setSimId(null));
    return () => {
      alive = false;
    };
  }, [env, envId]);

  // current floor's devices → plan meters
  const devices: InteriorDevice[] = useMemo(() => {
    if (!env || !current) return [];
    const zoneId = current.zone.id;
    // Non-geo worlds have no lat/lng mapping — but grid/bounds device
    // positions already live in the SAME world-unit space the runtime raster
    // uses as plan meters (ux-w4 probe B2: devices vanished from the walk
    // entirely in grid worlds; deployment stays honestly disabled there,
    // SEEING devices must not be).
    return (env.devices ?? [])
      .filter(d => d.zoneId === zoneId)
      .flatMap(d => {
        const pos = d.position as { lat?: number; lng?: number; x?: number; y?: number } | null;
        let plan: { x: number; z: number } | null = null;
        if (geoMapping) {
          plan =
            pos && typeof pos.lat === 'number' && typeof pos.lng === 'number'
              ? latLngToPlanMeters(geoMapping, pos.lat, pos.lng)
              : null;
        } else if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
          plan = { x: pos.x, z: pos.y };
        }
        // A device with no usable position is skipped from the spatial scene
        // (stacking everything at 0,0 is a lie) — it still exists in the
        // sidebar/API surfaces.
        if (plan === null) return [];
        return [{
          id: d.id,
          name: d.name,
          type: d.type,
          on: localOn[d.id] ?? Boolean((d.initialState as { status?: string } | null)?.status === 'on'),
          ...plan,
        }];
      });
  }, [env, current, geoMapping, localOn]);

  // deploy placement: plan meters → lat/lng → POST device → refresh env
  const busyRef = useRef(false);
  const placeRef = useRef<(x: number, z: number) => void>(() => {});
  placeRef.current = (x: number, z: number) => {
    const kind = deployKind;
    const zone = current?.zone;
    const mapping = geoMapping;
    if (!kind || !env || !zone || busyRef.current) return;
    if (!mapping) {
      // Non-geo world: deployment is honestly disabled, but the attempt
      // itself deserves the same visible feedback as an invalid spot.
      onPlaceUnavailable?.();
      return;
    }
    const { lat, lng } = planToLatLng(mapping, x, z);
    const customName = deployName.trim();
    busyRef.current = true;
    setBusy(true);
    api
      .createDevice(envId, {
        name:
          customName !== ''
            ? customName
            : `${kind.name} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        type: kind.type,
        capabilities: [...kind.capabilities],
        zoneId: zone.id,
        position: { lat, lng },
        initialState: { status: 'on' },
      })
      .then(() => api.getEnvironment(envId).then(setEnv))
      .then(() => setDeployName(''))
      .catch(e => {
        console.warn('device place failed:', e);
        onPlaceFailed?.(placeFailureKind(e));
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  // device toggle: sim command + local visual flip
  const toggleRef = useRef<(device: InteriorDevice) => void>(() => {});
  toggleRef.current = (device: InteriorDevice) => {
    if (simId) {
      void api
        .sendDeviceCommand(simId, device.id, device.on ? 'turn_off' : 'turn_on')
        .catch(() => undefined);
    }
    // 以最新 localOn 为基准翻转（传入的设备快照可能滞后）：未覆盖过才用快照值
    setLocalOn(prev => ({ ...prev, [device.id]: !(prev[device.id] ?? device.on) }));
  };

  return {
    deployKind,
    setDeployKind,
    deployName,
    setDeployName,
    busy,
    simId,
    devices,
    place: (x: number, z: number) => placeRef.current(x, z),
    toggleDevice: (device: InteriorDevice) => toggleRef.current(device),
  };
}
