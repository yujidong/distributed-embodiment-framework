/**
 * DeviceForm — the 设备 tab's embedded ad-hoc create/edit form (W6-2).
 *
 * Create mode (device === null): name, type (chips from the device-type
 * vocabulary — union of the catalog's device_types and the env's device
 * types — plus free text), capability chips (>= 1), zone select (required),
 * optional brand, position (grid: optional x/y, blank = auto-arrange; geo:
 * 「地图点选」 arms the store's device pick so the next map click sets
 * {lat, lng}), and a collapsed initial-state JSON editor.
 *
 * Edit mode: same form prefilled (device owner or env owner); blank brand /
 * initialState / grid position are sent as null (cleared server-side); a
 * capability change warns that derived services resync (W3).
 *
 * The REST response is applied to the world store optimistically — the
 * world-stream broadcast dedupes by id, and the derived-service resync
 * arrives as service frames.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, WorldDevice } from '../../api/types';
import { capabilityVocabulary } from '../../lib/agentWizard';
import { useDeviceTemplates } from '../../hooks/useDeviceTemplates';
import {
  buildCreateDevicePayload,
  buildPatchDevicePayload,
  capabilitiesChanged,
  createDeviceFormFields,
  deviceFormError,
  deviceFormFieldsFromDevice,
  deviceTypeVocabulary,
} from '../../lib/deviceForm';
import { readLatLng } from '../../lib/geo';
import { useAppStore } from '../../store/useAppStore';
import type { DeviceTemplate } from '../../api/types';
import { Icon } from '../ui/Icon';
import { DeviceTemplateChips } from './DeviceTemplateChips';
import { ZonePositionPicker } from './ZonePositionPicker';

export interface DeviceFormProps {
  world: EnvironmentDetail;
  /** null → create mode; a device → edit mode (prefilled). */
  device: WorldDevice | null;
  onClose: () => void;
}

export function DeviceForm({ world, device, onClose }: DeviceFormProps) {
  const { t } = useTranslation('deviceForm');
  const { t: tGeo } = useTranslation('deviceFormGeo');
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const devicePick = useAppStore(s => s.devicePick);
  const armDevicePick = useAppStore(s => s.armDevicePick);
  const cancelDevicePick = useAppStore(s => s.cancelDevicePick);

  const isGeo = world.mapType === 'geo';
  const [fields, setFields] = useState(() =>
    device ? deviceFormFieldsFromDevice(device) : createDeviceFormFields(world.zones[0]?.id ?? ''),
  );
  const [capabilityInput, setCapabilityInput] = useState('');
  const [catalogTypes, setCatalogTypes] = useState<string[]>([]);
  const [catalogCapabilities, setCatalogCapabilities] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // UX-W3: device-template picker (GET /api/device-templates) — collapsed by
  // default; a pick prefills type/name/capabilities (free text stays).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);

  /**
   * A template pick prefills type/capabilities — the NAME stays blank
   * (R2-FEAT-08: autofilling the English/template name read as「完成」,
   * users shipped English device names; the name input keeps its localized
   * placeholder and the picked template's name shows in the note below).
   */
  const applyTemplate = (template: DeviceTemplate) => {
    setPickedTemplateId(template.id);
    setFields(current => ({
      ...current,
      type: template.type,
      capabilities: [...template.capabilities],
    }));
  };

  // Vocabularies = env + catalog (suggestions only; the form works offline).
  // R2-FEAT-08: keep the catalog's type → capabilities map too, so picking a
  // type scopes the capability chips to what that type actually offers
  // (the 50+ slug 全环境并集墙 was the F4 新手 finding).
  const [catalogCapsByType, setCatalogCapsByType] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .listCatalog()
      .then(models => {
        if (cancelled) return;
        setCatalogTypes([...new Set(models.map(model => model.deviceType))]);
        setCatalogCapabilities([...new Set(models.flatMap(model => model.capabilities))]);
        const byType: Record<string, Set<string>> = {};
        for (const model of models) {
          const bucket = byType[model.deviceType] ?? new Set<string>();
          for (const capability of model.capabilities) bucket.add(capability);
          byType[model.deviceType] = bucket;
        }
        setCatalogCapsByType(
          Object.fromEntries(Object.entries(byType).map(([type, set]) => [type, [...set]])),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // A pick in progress belongs to this form — drop it when the form closes.
  useEffect(() => () => cancelDevicePick(), [cancelDevicePick]);

  const typeVocabulary = useMemo(
    () => deviceTypeVocabulary({ devices: world.devices, catalogDeviceTypes: catalogTypes }),
    [world.devices, catalogTypes],
  );
  const capVocabulary = useMemo(
    () =>
      capabilityVocabulary({
        devices: world.devices,
        services: world.services,
        catalogCapabilities,
      }),
    [world.devices, world.services, catalogCapabilities],
  );
  // R2-FEAT-08: a known type scopes the suggestion chips to that type's
  // capability set; unknown/free-text types keep the full vocabulary. Two
  // sources: the device-TEMPLATE registry (type → capabilities — this is
  // what a template pick just wrote into the type field; react-query cached,
  // shared with DeviceTemplateChips), with the device-model catalog as
  // fallback for hand-typed catalog types.
  const scopedType = fields.type.trim();
  const { templates: deviceTemplates } = useDeviceTemplates();
  const capsForType = useMemo(() => {
    if (scopedType === '') return undefined;
    const fromTemplates = new Set<string>();
    for (const template of deviceTemplates) {
      if (template.type === scopedType) {
        for (const capability of template.capabilities) fromTemplates.add(capability);
      }
    }
    if (fromTemplates.size > 0) return [...fromTemplates];
    return catalogCapsByType[scopedType];
  }, [scopedType, deviceTemplates, catalogCapsByType]);
  const capSuggestions = capsForType ?? capVocabulary;

  const set = (patch: Partial<typeof fields>) => setFields(current => ({ ...current, ...patch }));
  const addCapability = (value: string) => {
    const capability = value.trim();
    if (capability.length > 0 && !fields.capabilities.includes(capability)) {
      set({ capabilities: [...fields.capabilities, capability] });
    }
    setCapabilityInput('');
  };

  const zoneIds = useMemo(() => new Set(world.zones.map(zone => zone.id)), [world.zones]);
  const formError = deviceFormError(fields, { isGeo, zoneIds });
  const resyncNote = device !== null && capabilitiesChanged(device, fields);
  const pickedPoint = devicePick?.point ?? null;
  const currentGeoPoint = device ? readLatLng(device.position) : null;

  // UX-W4: position picker context — the selected zone, its other devices
  // (stacking reference dots) and the current form position as a point.
  const selectedZone = world.zones.find(zone => zone.id === fields.zoneId);
  const zoneDevices = useMemo(
    () => world.devices.filter(d => d.zoneId === fields.zoneId),
    [world.devices, fields.zoneId],
  );
  const gridCurrent = useMemo(() => {
    const x = Number(fields.posX);
    const y = Number(fields.posY);
    return fields.posX.trim() !== '' && fields.posY.trim() !== '' &&
      Number.isFinite(x) && Number.isFinite(y)
      ? { x, y }
      : null;
  }, [fields.posX, fields.posY]);

  const submit = async () => {
    if (busy || formError !== null) return;
    setBusy(true);
    setSubmitError(null);
    const ctx = { isGeo, geoPoint: pickedPoint };
    try {
      if (device) {
        const updated = await api.patchDevice(device.id, buildPatchDevicePayload(fields, ctx));
        // R98 (li-01): a builder's save converts server-side into a
        // modify-object proposal — say so (with the id) instead of claiming
        // the device changed; a rule-rejected proposal shows its issues.
        if (api.isProposalConversion(updated)) {
          if (updated.status === 'rejected') {
            setSubmitError(
              t('proposalRejected', {
                issues: updated.ruleCheck?.issues?.join('；') ?? updated.status,
              }),
            );
            return;
          }
          pushToast(t('proposalToast', { id: updated.id, status: updated.status }));
        } else {
          applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'device', object: updated });
          pushToast(t('savedToast', { name: updated.name }));
        }
      } else {
        const created = await api.createDevice(world.id, buildCreateDevicePayload(fields, ctx));
        // R100 (li-10 同类排查): a builder's create converts server-side
        // into an install-devices proposal — never render a device the
        // pipeline has not created (same 假删除/假创建 class as delete).
        if (api.isProposalConversion(created)) {
          if (created.status === 'rejected') {
            setSubmitError(
              t('proposalRejected', {
                issues: created.ruleCheck?.issues?.join('；') ?? created.status,
              }),
            );
            return;
          }
          pushToast(
            created.status === 'applied'
              ? t('createProposalAppliedToast', { id: created.id })
              : t('createProposalToast', { id: created.id, status: created.status }),
          );
        } else {
          applyWorldMessage({ kind: 'world', action: 'created', objectType: 'device', object: created });
          pushToast(t('createdToast', { name: created.name }));
        }
      }
      cancelDevicePick();
      onClose();
    } catch (error) {
      // T-009: English API payload — localized framing at the catch site.
      setSubmitError(
        t('submitFailed', {
          error: error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <div className="wizard__header">
        <h4 className="object-detail__name">{device ? t('editTitle') : t('newTitle')}</h4>
      </div>

      <div className="wizard__body">
        <label className="form-field">
          <span className="form-field__label">{t('nameLabel')}</span>
          <input
            value={fields.name}
            onChange={event => set({ name: event.target.value })}
            placeholder={t('namePlaceholder')}
          />
        </label>

        <div className="form-field">
          <span className="form-field__label">{t('typeLabel')}</span>
          <input
            value={fields.type}
            onChange={event => set({ type: event.target.value })}
            placeholder={t('typePlaceholder')}
          />
          {typeVocabulary.length > 0 && (
            <div className="chip-row">
              {typeVocabulary.map(type => (
                <button
                  key={type}
                  className={fields.type === type ? 'chip chip--button chip--active' : 'chip chip--button'}
                  onClick={() => set({ type })}
                >
                  {type}
                </button>
              ))}
            </div>
          )}
          {/* UX-W3: 从设备模板带入（类型 + 能力 + 默认效应说明）。 */}
          <button className="link-button" onClick={() => setTemplatesOpen(open => !open)}>
            <Icon icon={templatesOpen ? ChevronDown : ChevronRight} size={13} /> {t('templatePickerToggle')}
          </button>
          {templatesOpen && (
            <DeviceTemplateChips selectedId={pickedTemplateId} onPick={applyTemplate} />
          )}
        </div>

        <label className="form-field">
          <span className="form-field__label">{t('brandLabel')}</span>
          <input
            value={fields.brand}
            onChange={event => set({ brand: event.target.value })}
            placeholder={t('brandPlaceholder')}
          />
        </label>

        <div className="form-field">
          <span className="form-field__label">{t('capabilitiesLabel')}</span>
          {fields.capabilities.length > 0 && (
            <div className="chip-row">
              {fields.capabilities.map(capability => (
                <button
                  key={capability}
                  className="chip chip--button chip--active"
                  title={t('capabilityRemove')}
                  onClick={() =>
                    set({ capabilities: fields.capabilities.filter(c => c !== capability) })
                  }
                >
                  {capability}{' '}
                  <Icon icon={X} size={12} label={t('capabilityRemoveLabel', { capability })} />
                </button>
              ))}
            </div>
          )}
          <div className="chip-row">
            {capSuggestions
              .filter(capability => !fields.capabilities.includes(capability))
              .map(capability => (
                <button
                  key={capability}
                  className="chip chip--button"
                  title={t('capabilityAdd')}
                  onClick={() => addCapability(capability)}
                >
                  {capability}
                </button>
              ))}
          </div>
          {/* R2-FEAT-08: the scoping is visible — otherwise the shrunk chip
              list reads as「能力丢了」. */}
          {capsForType !== undefined && (
            <p className="object-list__meta">{t('capabilityScopedHint', { type: scopedType })}</p>
          )}
          <div className="form-field__inline">
            <input
              value={capabilityInput}
              onChange={event => setCapabilityInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') addCapability(capabilityInput);
              }}
              placeholder={t('capabilityCustomPlaceholder')}
            />
            <button disabled={capabilityInput.trim().length === 0} onClick={() => addCapability(capabilityInput)}>
              {t('capabilityAddButton')}
            </button>
          </div>
          {resyncNote && <p className="page-note">{t('resyncNote')}</p>}
        </div>

        <label className="form-field">
          <span className="form-field__label">{t('zoneLabel')}</span>
          <select value={fields.zoneId} onChange={event => set({ zoneId: event.target.value })}>
            {fields.zoneId === '' && <option value="">{t('zonePlaceholder')}</option>}
            {world.zones.map(zone => (
              <option key={zone.id} value={zone.id}>
                {zone.name ?? zone.id}
              </option>
            ))}
          </select>
        </label>

        {isGeo ? (
          <div className="form-field">
            <span className="form-field__label">{tGeo('positionLabel')}</span>
            {devicePick?.armed ? (
              <div className="form-field__inline">
                <span className="page-note">{t('geoPickHint')}</span>
                <button onClick={cancelDevicePick}>{t('cancelPick')}</button>
              </div>
            ) : (
              <div className="form-field__inline">
                <button onClick={armDevicePick}>{t('geoPick')}</button>
                {pickedPoint !== null && (
                  <>
                    <span className="object-list__meta">
                      {t('pickedCoord', {
                        lat: pickedPoint.lat.toFixed(5),
                        lng: pickedPoint.lng.toFixed(5),
                      })}
                    </span>
                    <button className="link-button" onClick={cancelDevicePick}>
                      {t('clearPick')}
                    </button>
                  </>
                )}
              </div>
            )}
            {pickedPoint === null && currentGeoPoint !== null && (
              <span className="object-list__meta">
                {t('currentCoord', {
                  lat: currentGeoPoint.lat.toFixed(5),
                  lng: currentGeoPoint.lng.toFixed(5),
                })}
              </span>
            )}
            {/* UX-W4: 平面图只读预览——geo 位置仍由上方大地图点选设置。 */}
            {selectedZone !== undefined && (
              <ZonePositionPicker
                zone={selectedZone}
                isGeo
                interactive={false}
                devices={zoneDevices}
                excludeDeviceId={device?.id}
                current={pickedPoint ?? currentGeoPoint}
              />
            )}
          </div>
        ) : (
          <div className="form-field">
            <span className="form-field__label">{t('positionLabel')}</span>
            <div className="form-field__inline">
              <input
                value={fields.posX}
                onChange={event => set({ posX: event.target.value })}
                placeholder="X"
                inputMode="decimal"
              />
              <input
                value={fields.posY}
                onChange={event => set({ posY: event.target.value })}
                placeholder="Y"
                inputMode="decimal"
              />
            </div>
            {/* UX-W4: 点击平面图回填 X/Y（世界单位，zone bounds 空间）。 */}
            {selectedZone !== undefined && (
              <ZonePositionPicker
                zone={selectedZone}
                isGeo={false}
                interactive
                devices={zoneDevices}
                excludeDeviceId={device?.id}
                current={gridCurrent}
                onPick={point => set({ posX: String(point.x), posY: String(point.y) })}
              />
            )}
          </div>
        )}

        <div className="form-field">
          <button className="link-button" onClick={() => set({ initialStateOpen: !fields.initialStateOpen })}>
            <Icon icon={fields.initialStateOpen ? ChevronDown : ChevronRight} size={13} /> {t('initialState')}
          </button>
          {fields.initialStateOpen && (
            <textarea
              className="dialog__textarea wizard__params"
              value={fields.initialStateJson}
              onChange={event => set({ initialStateJson: event.target.value })}
              placeholder={t('initialStatePlaceholder')}
              rows={4}
            />
          )}
        </div>
      </div>

      {submitError !== null && <p className="page-note--error">{submitError}</p>}

      <div className="wizard__footer">
        {/* R97: 校验提示放按钮旁（此前在表单底部，侧栏滚动后不可见 → 看似静默失败） */}
        {formError !== null && <span className="page-note--error">{formError}</span>}
        <button className="link-button" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </button>
        <span className="wizard__footer-spacer" />
        <button
          className="primary-button"
          disabled={busy || formError !== null}
          /* R2-FEAT-08: a disabled submit with no explanation reads as「点
             不动」 — the title carries the same reason the footer shows. */
          title={formError ?? undefined}
          onClick={() => void submit()}
        >
          {busy ? t('submitting') : device ? t('save') : t('create')}
        </button>
      </div>
    </div>
  );
}
