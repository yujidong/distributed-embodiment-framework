/**
 * FlowWizard (R14 P1-1; R2-UX-20 更名「引导式造 Flow」) — the guided builder on FlowsPage:
 * ① pick the trigger (zone + parameter + comparison + threshold), ② pick
 * the action from the capabilities actually executable in that zone,
 * ③ preview the generated flow (auto name, editable) and create it.
 *
 * The emitted flow is always the canonical zone-scoped shape (see
 * lib/flowWizard.ts), so it passes server-side validation and runs against
 * devices IN the trigger zone. When the zone has no agent-bound actuator
 * device the wizard stops at step ② with an explicit hint + a link to the
 * devices tab instead of silently creating a flow that can never fire.
 *
 * The canvas editor stays available as the advanced path; this wizard is
 * the teaching main path. Pure logic lives in lib/flowWizard.ts (vitest).
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { CreateFlowInput, EnvironmentDetail, Flow } from '../../api/types';
import {
  WIZARD_OPS,
  buildFlowFromWizard,
  wizardTriggerReady,
  zoneActionOptions,
  zoneParameters,
  type WizardOp,
} from '../../lib/flowWizard';

export function FlowWizard({
  env,
  onCreate,
  onCreated,
  onClose,
}: {
  env: EnvironmentDetail;
  /** Parent-owned create mutation (keeps the toast/selection logic there). */
  onCreate: (input: CreateFlowInput) => Promise<Flow>;
  onCreated: (flow: Flow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('flows');
  const zones = env.zones;

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? '');
  const [parameter, setParameter] = useState(() => zoneParameters(zones[0])[0] ?? 'temperature');
  const [op, setOp] = useState<WizardOp>('>');
  const [thresholdText, setThresholdText] = useState('');
  const [capability, setCapability] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zone = zones.find(z => z.id === zoneId);
  const zoneName = zone?.name ?? zoneId;
  const threshold = thresholdText === '' ? NaN : Number(thresholdText);
  const actionOptions = useMemo(
    () => zoneActionOptions(zoneId, env.devices, env.agents),
    [zoneId, env.devices, env.agents],
  );
  // Default to the first option when the picked one isn't available (zone switch).
  const selectedCapability = actionOptions.some(option => option.capability === capability)
    ? capability
    : (actionOptions[0]?.capability ?? '');

  const autoName = t('wizard.autoName', {
    zone: zoneName,
    parameter,
    op,
    threshold: thresholdText,
    capability: selectedCapability,
  });
  const autoGoal = t('wizard.autoGoal', {
    zone: zoneName,
    parameter,
    op,
    threshold: thresholdText,
    capability: selectedCapability,
  });

  const pickZone = (nextZoneId: string) => {
    setZoneId(nextZoneId);
    setParameter(zoneParameters(zones.find(z => z.id === nextZoneId))[0] ?? 'temperature');
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const flow = await onCreate(
        buildFlowFromWizard({
          zoneId,
          parameter,
          op,
          threshold,
          capability: selectedCapability,
          name: nameTouched && name.trim() !== '' ? name.trim() : autoName,
          goal: autoGoal,
        }),
      );
      onCreated(flow);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
      setCreating(false);
    }
  };

  const stepTitle =
    step === 0 ? t('wizard.stepTrigger') : step === 1 ? t('wizard.stepAction') : t('wizard.stepPreview');

  return (
    <div className="flow-wizard">
      <h3 className="flow-wizard__title">{t('wizard.title')}</h3>
      <p className="flow-wizard__step">{stepTitle}</p>

      {step === 0 && (
        <>
          <label className="flow-wizard__field">
            <span className="object-detail__label">{t('wizard.zoneLabel')}</span>
            <select
              aria-label={t('wizard.zoneLabel')}
              value={zoneId}
              onChange={event => pickZone(event.target.value)}
            >
              {zones.map(z => (
                <option key={z.id} value={z.id}>
                  {z.name ?? z.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flow-wizard__field">
            <span className="object-detail__label">{t('wizard.parameterLabel')}</span>
            <select
              aria-label={t('wizard.parameterLabel')}
              value={parameter}
              onChange={event => setParameter(event.target.value)}
            >
              {zoneParameters(zone).map(param => (
                <option key={param} value={param}>
                  {param}
                </option>
              ))}
            </select>
          </label>
          <div className="flow-wizard__row">
            <label className="flow-wizard__field">
              <span className="object-detail__label">{t('wizard.opLabel')}</span>
              <select
                aria-label={t('wizard.opLabel')}
                value={op}
                onChange={event => setOp(event.target.value as WizardOp)}
              >
                {WIZARD_OPS.map(operator => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </label>
            <label className="flow-wizard__field">
              <span className="object-detail__label">{t('wizard.thresholdLabel')}</span>
              <input
                aria-label={t('wizard.thresholdLabel')}
                type="number"
                value={thresholdText}
                onChange={event => setThresholdText(event.target.value)}
              />
            </label>
          </div>
        </>
      )}

      {step === 1 &&
        (actionOptions.length === 0 ? (
          <div className="flow-wizard__empty">
            <p className="page-note page-note--error">{t('wizard.noActuator', { zone: zoneName })}</p>
            <Link className="link-button" to={`/environments/${env.id}?tab=devices`}>
              {t('wizard.goAddDevice')}
            </Link>
          </div>
        ) : (
          <fieldset className="flow-wizard__field">
            <legend className="object-detail__label">{t('wizard.actionLabel')}</legend>
            {actionOptions.map(option => (
              <label key={option.capability} className="check-list__item">
                <input
                  type="radio"
                  name="flow-wizard-capability"
                  checked={selectedCapability === option.capability}
                  onChange={() => setCapability(option.capability)}
                />
                {option.capability}（{option.deviceNames.join(', ')}）
              </label>
            ))}
          </fieldset>
        ))}

      {step === 2 && (
        <>
          <p className="flow-wizard__summary">
            {t('wizard.summary', {
              zone: zoneName,
              parameter,
              op,
              threshold: thresholdText,
              capability: selectedCapability,
            })}
          </p>
          <label className="flow-wizard__field">
            <span className="object-detail__label">{t('wizard.nameLabel')}</span>
            <input
              aria-label={t('wizard.nameLabel')}
              value={nameTouched ? name : autoName}
              onChange={event => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
          </label>
          {error !== null && <p className="page-note page-note--error">{t('wizard.createFailed', { error })}</p>}
        </>
      )}

      <div className="flow-wizard__actions">
        <button className="link-button" onClick={onClose}>
          {t('wizard.cancel')}
        </button>
        {step > 0 && (
          <button onClick={() => setStep(current => (current - 1) as 0 | 1)}>{t('wizard.back')}</button>
        )}
        {step < 2 && (
          <button
            className="primary-button"
            disabled={
              step === 0
                ? !wizardTriggerReady({ zoneId, parameter, threshold })
                : actionOptions.length === 0
            }
            onClick={() => setStep(current => (current + 1) as 1 | 2)}
          >
            {t('wizard.next')}
          </button>
        )}
        {step === 2 && (
          <button className="primary-button" disabled={creating} onClick={() => void create()}>
            {creating ? t('wizard.creating') : t('wizard.create')}
          </button>
        )}
      </div>
    </div>
  );
}
