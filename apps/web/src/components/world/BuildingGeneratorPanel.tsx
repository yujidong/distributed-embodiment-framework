/**
 * BuildingGeneratorPanel — UX-W2 楼栋生成器 (environment builder): batch
 * 「楼栋 → N 层 × 每层 M zone」 from the 区域管理 panel.
 *
 * Like every zone mutation there is no zone CRUD API: the generated batch
 * appends to mapData.zones via one PATCH (lib/zoneForm mapDataWithZones —
 * other mapData keys preserved, server merges key-by-key). The form derives
 * a preview (pure lib/buildingGenerator functions) and the 生成 button is
 * blocked while the batch is invalid (blank building id, bad counts, naming
 * collisions with existing zones).
 *
 * - grid worlds: floors stack vertically (storeyPitch), zones side by side;
 * - geo worlds: the rectangular footprint splits into per-zone lng strips
 *   copied onto every floor (floor is the discriminator);
 * - presets (医院/酒店/办公楼) fill type/prefix/counts/baseline/schedule;
 * - adjacency switches declare same-floor chains and cross-floor links.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail } from '../../api/types';
import {
  BUILDING_PRESETS,
  DEFAULT_GRID_LAYOUT,
  DEFAULT_NAMING_PATTERN,
  buildingGeneratorError,
  defaultGeoFootprintHalfDeg,
  generateBuildingZones,
  type BuildingGeneratorConfig,
} from '../../lib/buildingGenerator';
import { dayClockToSimSec, mapDataWithZones, scheduleFormError } from '../../lib/zoneForm';
import { useAppStore } from '../../store/useAppStore';

export interface BuildingGeneratorPanelProps {
  world: EnvironmentDetail;
  onClose: () => void;
}

function numberOr(raw: string, fallback: number): number {
  const value = Number(raw.trim());
  return raw.trim().length > 0 && Number.isFinite(value) ? value : fallback;
}

export function BuildingGeneratorPanel({ world, onClose }: BuildingGeneratorPanelProps) {
  const { t } = useTranslation('zone');
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);

  const isGeo = world.mapType === 'geo';
  const center = world.mapCenter ?? { lat: 0, lng: 0 };

  const [buildingId, setBuildingId] = useState('');
  const [floors, setFloors] = useState('3');
  const [zonesPerFloor, setZonesPerFloor] = useState('4');
  const [namingPattern, setNamingPattern] = useState(DEFAULT_NAMING_PATTERN);
  const [zoneNamePrefix, setZoneNamePrefix] = useState('zone');
  const [type, setType] = useState('');
  const [linkSameFloor, setLinkSameFloor] = useState(true);
  const [linkAdjacentFloors, setLinkAdjacentFloors] = useState(true);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCount, setScheduleCount] = useState('4');
  const [scheduleStart, setScheduleStart] = useState('08:00');
  const [scheduleEnd, setScheduleEnd] = useState('18:00');
  // Grid layout / geo footprint (strings; invalid inputs fall back to the
  // defaults so a half-typed field never breaks the preview).
  const [originX, setOriginX] = useState(String(DEFAULT_GRID_LAYOUT.originX));
  const [originY, setOriginY] = useState(String(DEFAULT_GRID_LAYOUT.originY));
  const [zoneWidth, setZoneWidth] = useState(String(DEFAULT_GRID_LAYOUT.zoneWidth));
  const [zoneHeight, setZoneHeight] = useState(String(DEFAULT_GRID_LAYOUT.zoneHeight));
  const [gapX, setGapX] = useState(String(DEFAULT_GRID_LAYOUT.gapX));
  const [storeyPitch, setStoreyPitch] = useState(String(DEFAULT_GRID_LAYOUT.storeyPitch));
  const [minLat, setMinLat] = useState(() => String(center.lat - defaultGeoFootprintHalfDeg(3)));
  const [maxLat, setMaxLat] = useState(() => String(center.lat + defaultGeoFootprintHalfDeg(3)));
  const [minLng, setMinLng] = useState(() => String(center.lng - defaultGeoFootprintHalfDeg(3)));
  const [maxLng, setMaxLng] = useState(() => String(center.lng + defaultGeoFootprintHalfDeg(3)));
  // R2-UX-24: while the footprint fields are untouched they follow the
  // floors count (defaultGeoFootprintHalfDeg); once the user edits any of
  // them the override wins and floor changes no longer move the footprint.
  const [footprintTouched, setFootprintTouched] = useState(false);
  const floorsNum = numberOr(floors, 3);
  useEffect(() => {
    if (!isGeo || footprintTouched) return;
    const half = defaultGeoFootprintHalfDeg(floorsNum);
    setMinLat(String(center.lat - half));
    setMaxLat(String(center.lat + half));
    setMinLng(String(center.lng - half));
    setMaxLng(String(center.lng + half));
  }, [isGeo, footprintTouched, floorsNum, center.lat, center.lng]);
  const editFootprint = (setter: (value: string) => void) => (value: string) => {
    setFootprintTouched(true);
    setter(value);
  };

  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const applyPreset = (presetId: string) => {
    const preset = BUILDING_PRESETS.find(entry => entry.id === presetId);
    if (!preset) return;
    setType(preset.type);
    setZoneNamePrefix(preset.zoneNamePrefix);
    setFloors(String(preset.floors));
    setZonesPerFloor(String(preset.zonesPerFloor));
    if (preset.occupantSchedule !== undefined) {
      setScheduleEnabled(true);
      setScheduleCount(String(preset.occupantSchedule.count));
      setScheduleStart(secondsToClock(preset.occupantSchedule.startSimTimeSec));
      setScheduleEnd(secondsToClock(preset.occupantSchedule.endSimTimeSec));
    } else {
      setScheduleEnabled(false);
    }
  };

  const config = useMemo<BuildingGeneratorConfig>(
    () => ({
      buildingId: buildingId.trim(),
      floors: Number(floors.trim()),
      zonesPerFloor: Number(zonesPerFloor.trim()),
      namingPattern: namingPattern.trim() || DEFAULT_NAMING_PATTERN,
      zoneNamePrefix: zoneNamePrefix.trim(),
      type: type.trim(),
      linkSameFloor,
      linkAdjacentFloors,
      ...(scheduleEnabled
        ? {
            occupantSchedule: {
              count: numberOr(scheduleCount, 0),
              startSimTimeSec: dayClockToSimSec(scheduleStart) ?? 0,
              endSimTimeSec: dayClockToSimSec(scheduleEnd) ?? 0,
            },
          }
        : {}),
      grid: {
        originX: numberOr(originX, DEFAULT_GRID_LAYOUT.originX),
        originY: numberOr(originY, DEFAULT_GRID_LAYOUT.originY),
        zoneWidth: Math.max(1, numberOr(zoneWidth, DEFAULT_GRID_LAYOUT.zoneWidth)),
        zoneHeight: Math.max(1, numberOr(zoneHeight, DEFAULT_GRID_LAYOUT.zoneHeight)),
        gapX: Math.max(0, numberOr(gapX, DEFAULT_GRID_LAYOUT.gapX)),
        storeyPitch: Math.max(1, numberOr(storeyPitch, DEFAULT_GRID_LAYOUT.storeyPitch)),
      },
      ...(isGeo
        ? {
            // R2-UX-24: fall back to the floors-scaled default footprint,
            // not the legacy fixed ±0.0005° pancake.
            geo: {
              minLat: numberOr(minLat, center.lat - defaultGeoFootprintHalfDeg(floorsNum)),
              maxLat: numberOr(maxLat, center.lat + defaultGeoFootprintHalfDeg(floorsNum)),
              minLng: numberOr(minLng, center.lng - defaultGeoFootprintHalfDeg(floorsNum)),
              maxLng: numberOr(maxLng, center.lng + defaultGeoFootprintHalfDeg(floorsNum)),
            },
          }
        : {}),
    }),
    [
      buildingId, floors, floorsNum, zonesPerFloor, namingPattern, zoneNamePrefix, type,
      linkSameFloor, linkAdjacentFloors,
      scheduleEnabled, scheduleCount, scheduleStart, scheduleEnd,
      originX, originY, zoneWidth, zoneHeight, gapX, storeyPitch,
      minLat, maxLat, minLng, maxLng, isGeo, center,
    ],
  );

  const existingZoneIds = useMemo(() => new Set(world.zones.map(zone => zone.id)), [world.zones]);
  const configError = useMemo(
    () => buildingGeneratorError(config, existingZoneIds),
    [config, existingZoneIds],
  );
  const scheduleError = useMemo(
    () =>
      scheduleFormError({
        scheduleEnabled,
        scheduleCount,
        scheduleStart,
        scheduleEnd,
      }),
    [scheduleEnabled, scheduleCount, scheduleStart, scheduleEnd],
  );
  const formError = configError ?? scheduleError;

  const preview = useMemo(
    () => (formError === null ? generateBuildingZones(config) : []),
    [config, formError],
  );

  const generate = async () => {
    if (formError !== null || preview.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const updated = await api.patchEnvironment(world.id, {
        mapData: mapDataWithZones(world, preview),
      });
      applyWorldMessage({
        kind: 'world',
        action: 'updated',
        objectType: 'environment',
        object: updated,
      });
      pushToast(
        t('generator.generatedToast', { buildingId: config.buildingId, count: preview.length }),
      );
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard building-generator">
      <div className="wizard__body">
        <p className="page-note">{t('generator.title')}</p>
        <div className="form-field">
          <span className="form-field__label">{t('generator.presetLabel')}</span>
          <div className="chip-row">
            {BUILDING_PRESETS.map(preset => (
              <button
                key={preset.id}
                className="chip chip--button"
                onClick={() => applyPreset(preset.id)}
              >
                {t(`generator.preset${preset.id === 'hospital' ? 'Hospital' : preset.id === 'hotel' ? 'Hotel' : 'Office'}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="form-field">
          <span className="form-field__label">{t('generator.buildingIdLabel')}</span>
          <input
            value={buildingId}
            onChange={event => setBuildingId(event.target.value)}
            placeholder={t('generator.buildingIdPlaceholder')}
          />
        </label>
        <div className="form-field">
          <div className="form-field__inline">
            <label className="form-field">
              <span className="form-field__label">{t('generator.floorsLabel')}</span>
              <input value={floors} onChange={e => setFloors(e.target.value)} inputMode="numeric" />
            </label>
            <label className="form-field">
              <span className="form-field__label">{t('generator.zonesPerFloorLabel')}</span>
              <input value={zonesPerFloor} onChange={e => setZonesPerFloor(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <div className="form-field__inline">
            <label className="form-field">
              <span className="form-field__label">{t('generator.prefixLabel')}</span>
              <input value={zoneNamePrefix} onChange={e => setZoneNamePrefix(e.target.value)} />
            </label>
            <label className="form-field">
              <span className="form-field__label">{t('generator.typeLabel')}</span>
              <input value={type} onChange={e => setType(e.target.value)} />
            </label>
          </div>
        </div>
        <label className="form-field">
          <span className="form-field__label">{t('generator.patternLabel')}</span>
          <input value={namingPattern} onChange={e => setNamingPattern(e.target.value)} />
          {/* R2-FEAT-05: the pattern scopes BOTH ids and display names now —
              say so (it used to silently affect ids only). */}
          <span className="form-field__hint">{t('generator.patternHint')}</span>
        </label>
        <div className="form-field">
          <label className="form-field__checkbox">
            <input
              type="checkbox"
              checked={linkSameFloor}
              onChange={e => setLinkSameFloor(e.target.checked)}
            />
            {t('generator.linkSameFloor')}
          </label>
          <label className="form-field__checkbox">
            <input
              type="checkbox"
              checked={linkAdjacentFloors}
              onChange={e => setLinkAdjacentFloors(e.target.checked)}
            />
            {t('generator.linkAdjacentFloors')}
          </label>
        </div>
        <div className="form-field">
          <label className="form-field__checkbox">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={e => setScheduleEnabled(e.target.checked)}
            />
            {t('generator.scheduleLabel')}
          </label>
          {scheduleEnabled && (
            <div className="form-field__inline">
              <input
                value={scheduleCount}
                onChange={e => setScheduleCount(e.target.value)}
                placeholder={t('generator.scheduleCountPlaceholder')}
                inputMode="numeric"
              />
              <input value={scheduleStart} onChange={e => setScheduleStart(e.target.value)} placeholder="08:00" />
              <input value={scheduleEnd} onChange={e => setScheduleEnd(e.target.value)} placeholder="18:00" />
            </div>
          )}
        </div>
        <div className="form-field">
          <span className="form-field__label">{t('generator.layoutLabel')}</span>
          {!isGeo && (
            <>
              <div className="form-field__inline">
                <input value={originX} onChange={e => setOriginX(e.target.value)} placeholder={t('generator.originXPlaceholder')} inputMode="decimal" />
                <input value={originY} onChange={e => setOriginY(e.target.value)} placeholder={t('generator.originYPlaceholder')} inputMode="decimal" />
              </div>
              <div className="form-field__inline">
                <input value={zoneWidth} onChange={e => setZoneWidth(e.target.value)} placeholder={t('generator.widthPlaceholder')} inputMode="decimal" />
                <input value={zoneHeight} onChange={e => setZoneHeight(e.target.value)} placeholder={t('generator.heightPlaceholder')} inputMode="decimal" />
              </div>
              <div className="form-field__inline">
                <input value={gapX} onChange={e => setGapX(e.target.value)} placeholder={t('generator.gapPlaceholder')} inputMode="decimal" />
                <input value={storeyPitch} onChange={e => setStoreyPitch(e.target.value)} placeholder={t('generator.pitchPlaceholder')} inputMode="decimal" />
              </div>
            </>
          )}
          {isGeo && (
            <>
              <div className="form-field__inline">
                <input value={minLat} onChange={e => editFootprint(setMinLat)(e.target.value)} placeholder={t('generator.minLatPlaceholder')} inputMode="decimal" />
                <input value={maxLat} onChange={e => editFootprint(setMaxLat)(e.target.value)} placeholder={t('generator.maxLatPlaceholder')} inputMode="decimal" />
              </div>
              <div className="form-field__inline">
                <input value={minLng} onChange={e => editFootprint(setMinLng)(e.target.value)} placeholder={t('generator.minLngPlaceholder')} inputMode="decimal" />
                <input value={maxLng} onChange={e => editFootprint(setMaxLng)(e.target.value)} placeholder={t('generator.maxLngPlaceholder')} inputMode="decimal" />
              </div>
              {!footprintTouched && (
                <span className="page-note">{t('generator.footprintAutoHint')}</span>
              )}
            </>
          )}
        </div>

        {preview.length > 0 && (
          <div className="form-field">
            <span className="form-field__label">{t('generator.previewTitle', { count: preview.length })}</span>
            <div className="building-generator__preview">
              {preview.map(zone => (
                <div key={zone.id} className="building-generator__preview-row">
                  <span className="object-list__name">{zone.id}</span>
                  <span className="object-list__meta">
                    {zone.name} · F{zone.floor}
                    {zone.adjacentZoneIds !== undefined ? ` · ⇄ ${zone.adjacentZoneIds.length}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {formError !== null && <p className="page-note">{formError}</p>}
        {submitError !== null && <p className="page-note--error">{submitError}</p>}
      </div>

      <div className="wizard__footer">
        <button className="link-button" disabled={busy} onClick={onClose}>
          {t('generator.cancel')}
        </button>
        <span className="wizard__footer-spacer" />
        <button
          className="primary-button"
          disabled={busy || formError !== null || preview.length === 0}
          onClick={() => void generate()}
        >
          {busy ? t('generator.generating') : t('generator.generate', { count: preview.length })}
        </button>
      </div>
    </div>
  );
}

/** HH:MM for a sim-day second (preset schedules → form inputs). */
function secondsToClock(simDaySec: number): string {
  const h = Math.floor(simDaySec / 3600);
  const m = Math.floor((simDaySec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
