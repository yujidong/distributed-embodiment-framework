/**
 * ServiceForm — the 服务 tab's publish/edit form (W6).
 *
 * Publish mode (service === null): pick the provider among MY agents, name,
 * semantic type (chips from the capability vocabulary + custom), description,
 * interface params (key → description rows, serialized to interface_json,
 * omitted when empty) and visibility. Edit mode: same form prefilled for a
 * published service (the provider is fixed — it has no PATCH field).
 *
 * Derived services never use this form: their only allowed mutation is the
 * visibility cycle handled inline in ServicesPanel (server answers 409 to
 * anything else by design).
 */

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, ServiceVisibility, WorldAgent, WorldService } from '../../api/types';
import { capabilityVocabulary } from '../../lib/agentWizard';
import { SERVICE_VISIBILITY_LABEL } from '../../lib/services';
import {
  VISIBILITY_EXPLAIN,
  buildCreateServicePayload,
  buildPatchServicePayload,
  createServiceFormFields,
  duplicateServicesOfType,
  serviceFormError,
  serviceFormFieldsFromService,
  type InterfaceRow,
} from '../../lib/serviceForm';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

const VISIBILITIES: readonly ServiceVisibility[] = ['public', 'members', 'hidden'];

export interface ServiceFormProps {
  world: EnvironmentDetail;
  /** null → publish mode; a published service → edit mode (prefilled). */
  service: WorldService | null;
  /** The caller's agents in this env (provider select, publish mode). */
  myAgents: readonly WorldAgent[];
  onClose: () => void;
}

export function ServiceForm({ world, service, myAgents, onClose }: ServiceFormProps) {
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const { t } = useTranslation('serviceForm');

  const [fields, setFields] = useState(() =>
    service
      ? serviceFormFieldsFromService(service)
      : createServiceFormFields(myAgents[0]?.id ?? ''),
  );
  const [catalogCapabilities, setCatalogCapabilities] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listCatalog()
      .then(models => {
        if (cancelled) return;
        setCatalogCapabilities([...new Set(models.flatMap(model => model.capabilities))]);
      })
      .catch(() => {
        // Suggestions only — ignore catalog failures.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const vocabulary = useMemo(
    () =>
      capabilityVocabulary({
        devices: world.devices,
        services: world.services,
        catalogCapabilities,
      }),
    [world.devices, world.services, catalogCapabilities],
  );

  const set = (patch: Partial<typeof fields>) => setFields(current => ({ ...current, ...patch }));
  const setRow = (index: number, patch: Partial<InterfaceRow>) =>
    setFields(current => ({
      ...current,
      rows: current.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));

  const formError = serviceFormError(fields, { requireProvider: service === null });
  // Mechanism D: a flow-service's interface is GENERATED from the backing
  // flow's inputs surface — the editor hides and the PATCH omits `interface`.
  const interfaceManaged = service !== null && service.origin === 'flow';
  // R80-1: the duplicate-publish advisory (publish mode only) — the provider
  // already lists this semantic type. Warn inline, never block (the server's
  // 201 echoes the same check as `warnings`).
  const duplicates = useMemo(
    () =>
      service === null
        ? duplicateServicesOfType(world.services, fields.providerAgentId, fields.semanticType)
        : [],
    [service, world.services, fields.providerAgentId, fields.semanticType],
  );

  const submit = async () => {
    if (busy || formError !== null) return;
    setBusy(true);
    setSubmitError(null);
    try {
      if (service) {
        const updated = await api.patchService(
          service.id,
          buildPatchServicePayload(fields, { interfaceManaged }),
        );
        applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'service', object: updated });
        pushToast(t('savedToast', { name: updated.name }));
      } else {
        const published = await api.publishService(
          world.id,
          fields.providerAgentId,
          buildCreateServicePayload(fields),
        );
        applyWorldMessage({
          kind: 'world',
          action: 'created',
          objectType: 'service',
          object: published,
        });
        pushToast(t('publishedToast', { name: published.name }));
      }
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
        <h4 className="object-detail__name">{service ? t('editTitle') : t('newTitle')}</h4>
      </div>

      <div className="wizard__body">
        {service ? (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('providerLabel')}</span>
            {service.provider.name}
          </div>
        ) : (
          <label className="form-field">
            <span className="form-field__label">{t('providerAgentLabel')}</span>
            <select
              value={fields.providerAgentId}
              onChange={event => set({ providerAgentId: event.target.value })}
            >
              {myAgents.map(agent => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="form-field">
          <span className="form-field__label">{t('nameLabel')}</span>
          <input
            value={fields.name}
            onChange={event => set({ name: event.target.value })}
            placeholder={t('namePlaceholder')}
          />
        </label>

        <div className="form-field">
          <span className="form-field__label">{t('semanticTypeLabel')}</span>
          <input
            value={fields.semanticType}
            onChange={event => set({ semanticType: event.target.value })}
            placeholder={t('semanticTypePlaceholder')}
          />
          <div className="chip-row">
            {vocabulary.map(type => (
              <button
                key={type}
                className={
                  fields.semanticType === type
                    ? 'chip chip--button chip--active'
                    : 'chip chip--button'
                }
                onClick={() => set({ semanticType: type })}
              >
                {type}
              </button>
            ))}
          </div>
          {duplicates.length > 0 && (
            <p className="page-note" data-testid="duplicate-warning">
              {t('duplicateWarning', {
                type: fields.semanticType.trim(),
                count: duplicates.length,
                names: duplicates
                  .slice(0, 3)
                  .map(existing => existing.name)
                  .join(', '),
              })}
            </p>
          )}
        </div>

        <label className="form-field">
          <span className="form-field__label">{t('descriptionLabel')}</span>
          <textarea
            className="dialog__textarea wizard__params"
            value={fields.description}
            onChange={event => set({ description: event.target.value })}
            placeholder={t('descriptionPlaceholder')}
            rows={3}
          />
        </label>

        {interfaceManaged ? (
          <div className="form-field">
            <span className="form-field__label">{t('interfaceLabel')}</span>
            <p className="page-note">{t('interfaceManagedNote')}</p>
          </div>
        ) : (
        <div className="form-field">
          <span className="form-field__label">{t('interfaceLabel')}</span>
          {fields.rows.map((row, index) => (
            <div key={index} className="iface-row">
              <input
                value={row.key}
                onChange={event => setRow(index, { key: event.target.value })}
                placeholder={t('interfaceKeyPlaceholder')}
              />
              <input
                value={row.description}
                onChange={event => setRow(index, { description: event.target.value })}
                placeholder={t('interfaceDescriptionPlaceholder')}
              />
              <button
                className="link-button"
                title={t('interfaceRemoveTitle')}
                onClick={() =>
                  setFields(current => ({
                    ...current,
                    rows: current.rows.filter((_, i) => i !== index),
                  }))
                }
              >
                <Icon icon={X} size={12} />
              </button>
            </div>
          ))}
          <button
            className="link-button"
            onClick={() =>
              setFields(current => ({
                ...current,
                rows: [...current.rows, { key: '', description: '' }],
              }))
            }
          >
            {t('interfaceAdd')}
          </button>
        </div>
        )}

        <div className="form-field">
          <span className="form-field__label">{t('visibilityLabel')}</span>
          {VISIBILITIES.map(visibility => (
            <label key={visibility} className="check-list__item">
              <input
                type="radio"
                name="service-visibility"
                checked={fields.visibility === visibility}
                onChange={() => set({ visibility })}
              />
              <span>
                {SERVICE_VISIBILITY_LABEL[visibility]}
                <span className="object-list__meta"> — {VISIBILITY_EXPLAIN[visibility]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {formError !== null && <p className="page-note">{formError}</p>}
      {submitError !== null && <p className="page-note--error">{submitError}</p>}

      <div className="wizard__footer">
        <button className="link-button" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </button>
        <span className="wizard__footer-spacer" />
        <button
          className="primary-button"
          disabled={busy || formError !== null}
          onClick={() => void submit()}
        >
          {busy ? t('submitting') : service ? t('save') : t('publish')}
        </button>
      </div>
    </div>
  );
}
