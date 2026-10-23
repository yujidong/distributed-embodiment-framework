/**
 * ZonePanel — the 设备 tab's 区域管理 view (W6-2), env owner only.
 *
 * There is no zone CRUD API: zones live in the environment's map_data, so
 * every mutation here assembles a full mapData body (lib/zoneForm.ts —
 * existing geo center/zoom and scheduled events are preserved) and PATCHes
 * the environment. The REST response refreshes the world store; the
 * world-sync environment-updated frame carries the same zones to everyone
 * else.
 *
 * - Grid worlds: 「新建区域」 inline form (id slug auto-derived from the
 *   name until edited, name, optional type, bounds min<max, optional
 *   baseline key=value rows).
 * - Geo worlds: 「绘制区域」 arms the store's zone draw — map clicks append
 *   vertices (live preview on the canvas), dblclick or the banner's 完成
 *   ends the draw, then this panel collects id/name/type/baseline and saves
 *   the polygon. 重新绘制 discards and re-arms.
 * - UX-W2: every zone row also offers 编辑 (same form prefilled — building
 *   tier, consentClass, adjacency chips, envelopeU, rooms, base occupant
 *   schedule), geo 编辑顶点 (draggable handles on the map; 完成并保存 PATCHes
 *   the edited ring), grid 画布拖拽 (arm the canvas drag — WorldViewPage
 *   PATCHes the translated bounds on drop), and the 楼栋生成器 batch entry.
 * - Deletion is blocked while devices or scheduled events reference the
 *   zone (moving devices is out of scope).
 */

import { useMemo, useState } from 'react';
import { ArrowLeft, MapPin, X } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, EnvZone } from '../../api/types';
import {
  BASELINE_KEY_SUGGESTIONS,
  buildGeoZone,
  buildGridZone,
  createZoneFormFields,
  finishPolygon,
  mapDataWithUpdatedZone,
  mapDataWithZone,
  mapDataWithoutZone,
  mergeZoneEdits,
  slugifyZoneId,
  zoneDeleteBlocker,
  zoneFormError,
  zoneToFormFields,
  type ZoneFormFields,
} from '../../lib/zoneForm';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { BuildingGeneratorPanel } from './BuildingGeneratorPanel';
import { useTranslation } from 'react-i18next';

export interface ZonePanelProps {
  world: EnvironmentDetail;
  onClose: () => void;
}

const CONSENT_CLASSES = ['standard', 'supervised', 'restricted'] as const;

export function ZonePanel({ world, onClose }: ZonePanelProps) {
  const { t } = useTranslation('zone');
  const confirm = useConfirm();
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const zoneDraw = useAppStore(s => s.zoneDraw);
  const startZoneDraw = useAppStore(s => s.startZoneDraw);
  const cancelZoneDraw = useAppStore(s => s.cancelZoneDraw);
  const startZoneVertexEdit = useAppStore(s => s.startZoneVertexEdit);
  const startZoneBoundsEdit = useAppStore(s => s.startZoneBoundsEdit);

  const isGeo = world.mapType === 'geo';
  /** Non-null while the (grid or post-draw geo) form is open. */
  const [fields, setFields] = useState<ZoneFormFields | null>(null);
  /** UX-W2: non-null = the form edits this zone instead of creating one. */
  const [editingZone, setEditingZone] = useState<EnvZone | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  /** The id stays auto-derived from the name until the user edits it. */
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const existingZoneIds = useMemo(() => new Set(world.zones.map(zone => zone.id)), [world.zones]);
  const drawVertices = zoneDraw?.vertices ?? [];
  const drawActive = zoneDraw?.active ?? false;
  /** Finished polygon waiting for its metadata form (geo, create mode). */
  const drawnPolygon = !drawActive && zoneDraw?.editingZoneId === undefined
    ? finishPolygon(drawVertices)
    : null;
  /** UX-W2 vertex editing: the zone whose ring is on the map right now. */
  const vertexEditZone =
    zoneDraw?.editingZoneId !== undefined
      ? world.zones.find(zone => zone.id === zoneDraw.editingZoneId) ?? null
      : null;
  const editedPolygon = vertexEditZone !== null ? finishPolygon(drawVertices) : null;

  const set = (patch: Partial<ZoneFormFields>) =>
    setFields(current => (current ? { ...current, ...patch } : current));
  const setName = (name: string) => {
    setFields(current =>
      current ? { ...current, name, ...(idTouched ? {} : { id: slugifyZoneId(name) }) } : current,
    );
  };

  const formError = fields
    ? zoneFormError(fields, {
        isGeo,
        existingZoneIds,
        ...(editingZone !== null ? { editingZoneId: editingZone.id } : {}),
      })
    : null;

  const applyEnvUpdate = (updated: EnvironmentDetail) => {
    applyWorldMessage({
      kind: 'world',
      action: 'updated',
      objectType: 'environment',
      object: updated,
    });
  };

  const patchZones = async (
    mapData: Parameters<typeof api.patchEnvironment>[1]['mapData'],
    toast: string,
    after: () => void,
  ) => {
    setBusy(true);
    setSubmitError(null);
    try {
      const updated = await api.patchEnvironment(world.id, { mapData });
      applyEnvUpdate(updated);
      pushToast(toast);
      after();
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const closeForm = () => {
    setFields(null);
    setEditingZone(null);
    setIdTouched(false);
    setSubmitError(null);
  };

  const saveZone = async (zone: EnvZone) => {
    await patchZones(mapDataWithZone(world, zone), t('createdToast', { name: zone.name ?? zone.id }), () => {
      closeForm();
      cancelZoneDraw();
    });
  };

  /** UX-W2 edit mode: the form rebuilds the zone; non-form keys survive. */
  const saveEditedZone = async () => {
    if (!fields || !editingZone) return;
    const built =
      isGeo && editingZone.polygon !== undefined
        ? buildGeoZone(fields, editingZone.polygon)
        : buildGridZone(fields);
    const updated = mergeZoneEdits(editingZone, built);
    await patchZones(
      mapDataWithUpdatedZone(world, updated),
      t('updatedToast', { name: updated.name ?? updated.id }),
      closeForm,
    );
  };

  /** UX-W2 vertex editing: 完成并保存 writes the edited ring back. */
  const saveVertexEdit = async () => {
    if (!vertexEditZone || editedPolygon === null) return;
    const updated: EnvZone = { ...vertexEditZone, polygon: editedPolygon };
    await patchZones(
      mapDataWithUpdatedZone(world, updated),
      t('updatedToast', { name: updated.name ?? updated.id }),
      cancelZoneDraw,
    );
  };

  const removeZone = async (zone: EnvZone) => {
    const blocker = zoneDeleteBlocker(world, zone.id);
    if (blocker !== null) {
      pushToast(blocker);
      return;
    }
    if (!(await confirm({ body: t('deleteConfirm', { name: zone.name ?? zone.id }), tone: 'danger' }))) return;
    try {
      const updated = await api.patchEnvironment(world.id, {
        mapData: mapDataWithoutZone(world, zone.id),
      });
      applyEnvUpdate(updated);
      pushToast(t('deleteToast', { name: zone.name ?? zone.id }));
    } catch (error) {
      pushToast(t('deleteFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const openForm = () => {
    setFields(createZoneFormFields());
    setEditingZone(null);
    setIdTouched(false);
    setSubmitError(null);
  };

  const openEditForm = (zone: EnvZone) => {
    setFields(zoneToFormFields(zone));
    setEditingZone(zone);
    setIdTouched(true);
    setSubmitError(null);
  };

  const deviceCountByZone = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of world.devices) {
      counts.set(device.zoneId, (counts.get(device.zoneId) ?? 0) + 1);
    }
    return counts;
  }, [world.devices]);

  if (generatorOpen) {
    return (
      <div className="zone-panel">
        <button className="link-button" onClick={() => setGeneratorOpen(false)}>
          <Icon icon={ArrowLeft} size={14} /> {t('back')}
        </button>
        <BuildingGeneratorPanel world={world} onClose={() => setGeneratorOpen(false)} />
      </div>
    );
  }

  /** Adjacency chip candidates: every OTHER zone (self-reference excluded). */
  const adjacentCandidates = fields !== null
    ? world.zones.filter(zone => zone.id !== fields.id)
    : [];

  return (
    <div className="zone-panel">
      <button className="link-button" onClick={onClose}>
        <Icon icon={ArrowLeft} size={14} /> {t('back')}
      </button>
      <h4 className="object-detail__name">{t('title')}</h4>

      {/* UX-W2 vertex editing rides the map; this bar saves/discards. */}
      {vertexEditZone !== null && (
        <div className="form-field">
          <p className="page-note">
            {t('vertexEditing', { name: vertexEditZone.name ?? vertexEditZone.id, count: drawVertices.length })}
          </p>
          <div className="form-field__inline">
            <button
              className="primary-button"
              disabled={busy || editedPolygon === null}
              onClick={() => void saveVertexEdit()}
            >
              {busy ? t('submitting') : t('vertexFinish')}
            </button>
            <button className="link-button" disabled={busy} onClick={cancelZoneDraw}>
              {t('cancel')}
            </button>
          </div>
          {submitError !== null && <p className="page-note--error">{submitError}</p>}
        </div>
      )}

      <div className="object-list">
        {world.zones.length === 0 && <EmptyState compact icon={MapPin} title={t('empty')} />}
        {world.zones.map(zone => {
          const blocker = zoneDeleteBlocker(world, zone.id);
          return (
            <div key={zone.id} className="zone-row">
              <div className="zone-row__main">
                <span className="object-list__name" title={zone.name ?? zone.id}>{zone.name ?? zone.id}</span>
                <span className="object-list__meta">
                  {zone.id}
                  {zone.type ? ` · ${zone.type}` : ''}
                  {zone.buildingId ? ` · ${zone.buildingId}` : ''}
                  {zone.floor !== undefined ? ` · F${zone.floor}` : ''}
                  {' · '}{t('deviceCount', { count: deviceCountByZone.get(zone.id) ?? 0 })}
                </span>
                <span className="zone-row__actions">
                  <button className="link-button" onClick={() => openEditForm(zone)}>
                    {t('edit')}
                  </button>
                  {isGeo && zone.polygon !== undefined && (
                    <button
                      className="link-button"
                      onClick={() => startZoneVertexEdit(zone.id, zone.polygon!)}
                    >
                      {t('editVertices')}
                    </button>
                  )}
                  {!isGeo && zone.bounds !== undefined && (
                    <button className="link-button" onClick={() => startZoneBoundsEdit(zone.id)}>
                      {t('editBounds')}
                    </button>
                  )}
                  <button
                    className="danger-button"
                    title={blocker ?? undefined}
                    onClick={() => void removeZone(zone)}
                  >
                    {t('delete')}
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Geo: the draw lives on the map; the metadata form follows. */}
      {isGeo && fields === null && (
        <div className="form-field">
          {drawActive ? (
            <p className="page-note">
              {t('drawing', { count: drawVertices.length })}
              <button className="link-button" onClick={cancelZoneDraw}>
                {t('cancelDraw')}
              </button>
            </p>
          ) : drawnPolygon !== null ? (
            <div className="form-field__inline">
              <span className="page-note">{t('drawn', { count: drawnPolygon.length })}</span>
              <button className="primary-button" onClick={openForm}>
                {t('fillInfo')}
              </button>
              <button onClick={startZoneDraw}>{t('redraw')}</button>
            </div>
          ) : (
            <button className="primary-button world-sidebar__create" onClick={startZoneDraw}>
              {t('drawZone')}
            </button>
          )}
        </div>
      )}

      {!isGeo && fields === null && (
        <button className="primary-button world-sidebar__create" onClick={openForm}>
          {t('newZone')}
        </button>
      )}

      {fields === null && (
        <button className="world-sidebar__create" onClick={() => setGeneratorOpen(true)}>
          {t('generatorOpen')}
        </button>
      )}

      {fields !== null && (
        <div className="wizard">
          <div className="wizard__body">
            {isGeo && editingZone === null && drawnPolygon !== null && (
              <p className="page-note">{t('polygonVertices', { count: drawnPolygon.length })}</p>
            )}
            <label className="form-field">
              <span className="form-field__label">{t('nameLabel')}</span>
              <input
                value={fields.name}
                onChange={event => setName(event.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </label>
            <label className="form-field">
              <span className="form-field__label">{t('idLabel')}</span>
              <input
                value={fields.id}
                disabled={editingZone !== null}
                onChange={event => {
                  setIdTouched(true);
                  set({ id: event.target.value });
                }}
                placeholder={t('idPlaceholder')}
              />
            </label>
            <label className="form-field">
              <span className="form-field__label">{t('typeLabel')}</span>
              <input
                value={fields.type}
                onChange={event => set({ type: event.target.value })}
                placeholder={t('typePlaceholder')}
              />
            </label>
            {!isGeo && (
              <div className="form-field">
                <span className="form-field__label">{t('boundsLabel')}</span>
                <div className="form-field__inline">
                  <input value={fields.minX} onChange={e => set({ minX: e.target.value })} placeholder="minX" inputMode="decimal" />
                  <input value={fields.maxX} onChange={e => set({ maxX: e.target.value })} placeholder="maxX" inputMode="decimal" />
                </div>
                <div className="form-field__inline">
                  <input value={fields.minY} onChange={e => set({ minY: e.target.value })} placeholder="minY" inputMode="decimal" />
                  <input value={fields.maxY} onChange={e => set({ maxY: e.target.value })} placeholder="maxY" inputMode="decimal" />
                </div>
                <span className="form-field__label">{t('heightLabel')}</span>
                <div className="form-field__inline">
                  <input value={fields.minZ} onChange={e => set({ minZ: e.target.value })} placeholder={t('minZPlaceholder')} inputMode="decimal" />
                  <input value={fields.maxZ} onChange={e => set({ maxZ: e.target.value })} placeholder={t('maxZPlaceholder')} inputMode="decimal" />
                </div>
              </div>
            )}

            {/* ── UX-W2: building tier + governance. ── */}
            <div className="form-field">
              <div className="form-field__inline">
                <label className="form-field">
                  <span className="form-field__label">{t('buildingIdLabel')}</span>
                  <input
                    value={fields.buildingId}
                    onChange={e => set({ buildingId: e.target.value })}
                    placeholder={t('buildingIdPlaceholder')}
                  />
                </label>
                <label className="form-field">
                  <span className="form-field__label">{t('floorLabel')}</span>
                  <input
                    value={fields.floor}
                    onChange={e => set({ floor: e.target.value })}
                    placeholder={t('floorPlaceholder')}
                    inputMode="numeric"
                  />
                </label>
              </div>
              {/* R2-UX-24: floor 0 is the silent default of the手绘/表单 path —
                  every zone then stacks on y∈[0, storeyHeight] in 3D (the
                  persona's「平板楼」). Teach the storey convention instead of
                  letting a multi-storey building collapse onto one level. */}
              {fields.floor.trim() !== '' && Number(fields.floor) === 0 && (
                <span className="page-note">{t('floorZeroHint')}</span>
              )}
              <label className="form-field">
                <span className="form-field__label">{t('consentLabel')}</span>
                <select
                  value={fields.consentClass}
                  onChange={e =>
                    set({ consentClass: e.target.value as ZoneFormFields['consentClass'] })
                  }
                >
                  <option value="">{t('consentDefault')}</option>
                  {CONSENT_CLASSES.map(value => (
                    <option key={value} value={value}>
                      {t(value === 'supervised' ? 'consentSupervised' : value === 'restricted' ? 'consentRestricted' : 'consentDefault')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span className="form-field__label">{t('envelopeULabel')}</span>
                <input
                  value={fields.envelopeU}
                  onChange={e => set({ envelopeU: e.target.value })}
                  placeholder="0.3"
                  inputMode="decimal"
                />
              </label>
            </div>

            <div className="form-field">
              <span className="form-field__label">{t('adjacentLabel')}</span>
              {adjacentCandidates.length === 0 && (
                <span className="page-note">{t('adjacentEmpty')}</span>
              )}
              <div className="chip-row">
                {adjacentCandidates.map(zone => {
                  const active = fields.adjacentZoneIds.includes(zone.id);
                  return (
                    <button
                      key={zone.id}
                      className={`chip chip--button${active ? ' chip--active' : ''}`}
                      onClick={() =>
                        set({
                          adjacentZoneIds: active
                            ? fields.adjacentZoneIds.filter(id => id !== zone.id)
                            : [...fields.adjacentZoneIds, zone.id],
                        })
                      }
                    >
                      {zone.name ?? zone.id}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="form-field">
              <span className="form-field__label">{t('roomsLabel')}</span>
              {fields.roomRows.map((row, index) => (
                <div key={index} className="iface-row">
                  <input
                    value={row.name}
                    onChange={event =>
                      set({
                        roomRows: fields.roomRows.map((r, i) =>
                          i === index ? { ...r, name: event.target.value } : r,
                        ),
                      })
                    }
                    placeholder={t('roomNamePlaceholder')}
                  />
                  <input
                    value={row.code}
                    onChange={event =>
                      set({
                        roomRows: fields.roomRows.map((r, i) =>
                          i === index ? { ...r, code: event.target.value } : r,
                        ),
                      })
                    }
                    placeholder={t('roomCodePlaceholder')}
                  />
                  <button
                    className="link-button"
                    title={t('roomRemove')}
                    onClick={() => set({ roomRows: fields.roomRows.filter((_, i) => i !== index) })}
                  >
                    <Icon icon={X} size={12} />
                  </button>
                </div>
              ))}
              <button
                className="link-button"
                onClick={() => set({ roomRows: [...fields.roomRows, { name: '', code: '' }] })}
              >
                {t('roomAdd')}
              </button>
            </div>

            <div className="form-field">
              <span className="form-field__label">{t('scheduleLabel')}</span>
              <label className="form-field__checkbox">
                <input
                  type="checkbox"
                  checked={fields.scheduleEnabled}
                  onChange={e => set({ scheduleEnabled: e.target.checked })}
                />
                {t('scheduleEnable')}
              </label>
              {fields.scheduleEnabled && (
                <>
                  <div className="form-field__inline">
                    <input
                      value={fields.scheduleCount}
                      onChange={e => set({ scheduleCount: e.target.value })}
                      placeholder={t('scheduleCountPlaceholder')}
                      inputMode="numeric"
                    />
                    <input
                      value={fields.scheduleStart}
                      onChange={e => set({ scheduleStart: e.target.value })}
                      placeholder="08:00"
                    />
                    <input
                      value={fields.scheduleEnd}
                      onChange={e => set({ scheduleEnd: e.target.value })}
                      placeholder="18:00"
                    />
                  </div>
                  <label className="form-field__checkbox">
                    <input
                      type="checkbox"
                      checked={fields.scheduleRepeatDaily}
                      onChange={e => set({ scheduleRepeatDaily: e.target.checked })}
                    />
                    {t('scheduleRepeatDaily')}
                  </label>
                </>
              )}
            </div>

            <div className="form-field">
              <span className="form-field__label">{t('baselineLabel')}</span>
              {fields.baselineRows.map((row, index) => (
                <div key={index} className="iface-row">
                  <input
                    value={row.key}
                    onChange={event =>
                      set({
                        baselineRows: fields.baselineRows.map((r, i) =>
                          i === index ? { ...r, key: event.target.value } : r,
                        ),
                      })
                    }
                    placeholder={t('paramKeyPlaceholder')}
                  />
                  <input
                    value={row.value}
                    onChange={event =>
                      set({
                        baselineRows: fields.baselineRows.map((r, i) =>
                          i === index ? { ...r, value: event.target.value } : r,
                        ),
                      })
                    }
                    placeholder={t('paramValuePlaceholder')}
                  />
                  <button
                    className="link-button"
                    title={t('paramRemove')}
                    onClick={() =>
                      set({ baselineRows: fields.baselineRows.filter((_, i) => i !== index) })
                    }
                  >
                    <Icon icon={X} size={12} />
                  </button>
                </div>
              ))}
              <div className="chip-row">
                {BASELINE_KEY_SUGGESTIONS.filter(
                  key => !fields.baselineRows.some(row => row.key.trim() === key),
                ).map(key => (
                  <button
                    key={key}
                    className="chip chip--button"
                    title={t('paramAddTitle')}
                    onClick={() =>
                      set({ baselineRows: [...fields.baselineRows, { key, value: '' }] })
                    }
                  >
                    {key}
                  </button>
                ))}
                <button
                  className="link-button"
                  onClick={() => set({ baselineRows: [...fields.baselineRows, { key: '', value: '' }] })}
                >
                  {t('paramAdd')}
                </button>
              </div>
            </div>
          </div>

          {formError !== null && <p className="page-note">{formError}</p>}
          {submitError !== null && <p className="page-note--error">{submitError}</p>}

          <div className="wizard__footer">
            <button className="link-button" disabled={busy} onClick={closeForm}>
              {t('cancel')}
            </button>
            <span className="wizard__footer-spacer" />
            {editingZone !== null ? (
              <button
                className="primary-button"
                disabled={busy || formError !== null}
                onClick={() => void saveEditedZone()}
              >
                {busy ? t('submitting') : t('saveEdit')}
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={busy || formError !== null || (isGeo && drawnPolygon === null)}
                onClick={() => {
                  if (!fields) return;
                  void saveZone(
                    isGeo && drawnPolygon !== null
                      ? buildGeoZone(fields, drawnPolygon)
                      : buildGridZone(fields),
                  );
                }}
              >
                {busy ? t('submitting') : t('save')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
