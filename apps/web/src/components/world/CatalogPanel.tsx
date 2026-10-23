/**
 * CatalogPanel — 名录 tab of the world view: search/filter the real-hardware
 * device catalog (q / device_type / vendor) and, for builders, instantiate a
 * model into a chosen zone of the current environment.
 *
 * Placement prefers the world stream (the server broadcasts the created
 * device to every subscriber); the REST response is also applied locally so
 * the dot appears even when the stream is down — the reducer's id-dedupe
 * makes the double-apply a no-op.
 */

import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { CatalogModelSummary, EnvironmentDetail } from '../../api/types';
import { polygonCentroid } from '../../lib/geo';
import { slugifyZoneId } from '../../lib/zoneForm';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import { DeviceTemplateChips } from './DeviceTemplateChips';
import { reportCapabilityDemand } from '../../lib/capabilityDemand';
import { useMyQuotas } from '../../hooks/useEnvironments';
import { quotaState } from '../../lib/quota';
import { useTranslation } from 'react-i18next';

export interface CatalogPanelProps {
  world: EnvironmentDetail;
}

export function CatalogPanel({ world }: CatalogPanelProps) {
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const geoPlacement = useAppStore(s => s.geoPlacement);
  const armGeoPlacement = useAppStore(s => s.armGeoPlacement);
  const cancelGeoPlacement = useAppStore(s => s.cancelGeoPlacement);
  const { t } = useTranslation('catalog');
  // R78-B: the devices-per-env quota on the placement surface (the 429-at-
  // submit surprise was R77 F4). Unknown limit never blocks.
  const quotasQuery = useMyQuotas();
  const deviceQuota = quotaState(
    '设备',
    world.devices.length,
    quotasQuery.data?.quotas.devicesPerEnv.limit,
  );

  const [q, setQ] = useState('');
  const [deviceType, setDeviceType] = useState('');
  const [vendor, setVendor] = useState('');
  const [models, setModels] = useState<CatalogModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R80-FW3: a zero-hit search on a meaningful query is catalog-gap demand —
  // report the term (effect, session-deduped, fire-and-forget).
  useEffect(() => {
    if (!loading && !error && models.length === 0 && q.trim().length >= 2) {
      reportCapabilityDemand(q.trim(), 'catalog-zero-hit', world.id);
    }
  }, [loading, error, models.length, q, world.id]);
  /** Model id currently waiting for a zone pick. */
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [placeZoneId, setPlaceZoneId] = useState(world.zones[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  // R76-F2 (blank-canvas onboarding): a zero-zone world dead-ended the whole
  // placement flow — the zone dropdown was empty with no way forward. The
  // empty state below offers first-zone creation inline (POST …/zones:
  // owner creates directly, builder's call converts to an install-zones
  // proposal — the server handles both, T-055).
  const [zoneFormOpen, setZoneFormOpen] = useState(false);
  const [zoneName, setZoneName] = useState('');
  const [zoneError, setZoneError] = useState<string | null>(null);

  const canBuild = world.myRole === 'owner' || world.myRole === 'builder';
  const isGeo = world.mapType === 'geo';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listCatalog({ q, deviceType, vendor })
      .then(result => {
        if (!cancelled) setModels(result);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q, deviceType, vendor]);

  /** Default position for a zone pick: polygon centroid in geo worlds. */
  const defaultPosition = (zoneId: string): Record<string, unknown> | undefined => {
    if (!isGeo) return undefined;
    const polygon = world.zones.find(zone => zone.id === zoneId)?.polygon;
    if (!polygon || polygon.length < 3) return undefined;
    const centroid = polygonCentroid(polygon);
    return { lat: centroid.lat, lng: centroid.lng };
  };

  const place = async (model: CatalogModelSummary) => {
    if (busy || !placeZoneId) return;
    setBusy(true);
    try {
      const position = defaultPosition(placeZoneId);
      const device = await api.instantiateDevice(world.id, {
        modelId: model.id,
        zoneId: placeZoneId,
        ...(position !== undefined ? { position } : {}),
      });
      applyWorldMessage({ kind: 'world', action: 'created', objectType: 'device', object: device });
      pushToast(t('placed', { name: device.name }));
      setPlacingId(null);
    } catch (error) {
      const message =
        error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error);
      pushToast(t('placeFailed', { error: message }));
    } finally {
      setBusy(false);
    }
  };

  /** First-zone creation from the blank-canvas empty state (name only). */
  const createFirstZone = async () => {
    const name = zoneName.trim();
    if (busy || name.length === 0) return;
    setBusy(true);
    setZoneError(null);
    try {
      const result = await api.createZone(world.id, { id: slugifyZoneId(name), name });
      if (api.isProposalConversion(result)) {
        // Builder path: the zone is a proposal until the pipeline approves
        // it — a rule rejection is taught in place (fix and resubmit).
        if (result.status === 'rejected') {
          setZoneError(result.ruleCheck?.issues?.join('; ') ?? t('createZoneFailed', { error: result.status }));
          return;
        }
        pushToast(t('zoneProposalToast', { status: result.status }));
      } else {
        // Owner path: the zone exists now — merge it locally (the world
        // stream's environment-updated frame dedupes to the same state).
        applyWorldMessage({
          kind: 'world',
          action: 'updated',
          objectType: 'environment',
          object: { id: world.id, zones: [...world.zones, result] },
        });
        pushToast(t('zoneCreatedToast', { name: result.name ?? result.id }));
        setPlaceZoneId(result.id);
      }
      setZoneFormOpen(false);
      setZoneName('');
    } catch (error) {
      setZoneError(
        error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="catalog-panel">
      <p className="page-note catalog-panel__quota">
        {t('deviceQuotaPrefix')} <span
          className={`quota-badge${deviceQuota.nearLimit ? ' quota-badge--warn' : ''}${deviceQuota.exhausted ? ' quota-badge--full' : ''}`}
        >{deviceQuota.label}</span>
      </p>
      <div className="catalog-panel__filters">
        <input
          value={q}
          onChange={event => setQ(event.target.value)}
          placeholder={t('searchPlaceholder')}
        />
        <input
          value={deviceType}
          onChange={event => setDeviceType(event.target.value)}
          placeholder={t('typePlaceholder')}
        />
        <input
          value={vendor}
          onChange={event => setVendor(event.target.value)}
          placeholder={t('vendorPlaceholder')}
        />
      </div>
      {/* UX-W3: type-filter suggestions from the device-template registry —
          typing in the 类型 input narrows these chips; a pick sets the filter. */}
      {deviceType.trim().length > 0 && (
        <DeviceTemplateChips
          query={deviceType}
          limit={8}
          onPick={template => setDeviceType(template.type)}
        />
      )}
      {error && <p className="env-card__error">{t('loadFailed', { error })}</p>}
      {loading && <p className="page-note">{t('loading')}</p>}
      {canBuild && world.zones.length === 0 && (
        <div className="catalog-empty-zones">
          <p className="page-note">{t('noZonesGuide')}</p>
          {world.myRole === 'builder' && (
            <p className="page-note">{t('builderZoneHint')}</p>
          )}
          {zoneFormOpen ? (
            <div className="form-field">
              <div className="form-field__inline">
                <input
                  value={zoneName}
                  onChange={event => setZoneName(event.target.value)}
                  placeholder={t('zoneNamePlaceholder')}
                />
                <button
                  className="primary-button"
                  disabled={busy || zoneName.trim().length === 0}
                  onClick={() => void createFirstZone()}
                >
                  {t('createZone')}
                </button>
                <button disabled={busy} onClick={() => { setZoneFormOpen(false); setZoneError(null); }}>
                  {t('cancel')}
                </button>
              </div>
              {zoneError !== null && <p className="page-note--error">{zoneError}</p>}
            </div>
          ) : (
            <button className="primary-button" onClick={() => setZoneFormOpen(true)}>
              {t('createFirstZone')}
            </button>
          )}
        </div>
      )}
      {!loading && !error && models.length === 0 && <EmptyState compact icon={Package} title={t('empty')} />}
      {models.map(model => (
        <div key={model.id} className="catalog-row">
          <div className="catalog-row__main">
            <span className="catalog-row__name">{model.name}</span>
            <span className="catalog-row__meta">
              {model.vendor} {model.model} · {model.deviceType} · {t('capabilities', { count: model.capabilities.length })}
              {model.priceCny !== null ? ` · ¥${model.priceCny}` : ''}
            </span>
          </div>
          {canBuild && (
            <div className="catalog-row__actions">
              {geoPlacement?.modelId === model.id ? (
                <>
                  <span className="catalog-row__hint">{t('geoHint')}</span>
                  <button disabled={busy} onClick={cancelGeoPlacement}>
                    {t('cancelPick')}
                  </button>
                </>
              ) : placingId === model.id ? (
                <>
                  <select
                    value={placeZoneId}
                    onChange={event => setPlaceZoneId(event.target.value)}
                  >
                    {world.zones.map(zone => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name ?? zone.id}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary-button"
                    disabled={busy || !placeZoneId}
                    onClick={() => void place(model)}
                  >
                    {t('confirm')}
                  </button>
                  {isGeo && (
                    <button
                      disabled={busy || !placeZoneId}
                      title={t('geoPickTitle')}
                      onClick={() => {
                        armGeoPlacement({ modelId: model.id, zoneId: placeZoneId });
                        setPlacingId(null);
                      }}
                    >
                      {t('geoPick')}
                    </button>
                  )}
                  <button disabled={busy} onClick={() => setPlacingId(null)}>
                    {t('cancel')}
                  </button>
                </>
              ) : (
                <button
                  disabled={world.zones.length === 0 || geoPlacement !== null || deviceQuota.exhausted}
                  title={
                    world.zones.length === 0
                      ? t('noZones')
                      : deviceQuota.title ?? undefined
                  }
                  onClick={() => {
                    setPlacingId(model.id);
                    setPlaceZoneId(world.zones[0]?.id ?? '');
                  }}
                >
                  {t('place')}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
