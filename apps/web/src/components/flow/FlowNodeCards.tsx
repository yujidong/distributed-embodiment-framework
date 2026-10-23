/**
 * Flow node cards — the reactflow node types of the flow editor canvas.
 *
 * Both cards are thin forms over the node data written by lib/flowGraph.ts
 * (trigger / planNode); shared context (zones, agents, capability vocabulary,
 * update callbacks, validation highlights) comes from FlowEditorContext so
 * node data stays a clean serializable payload.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { useTranslation } from 'react-i18next';

import type {
  EnvZone,
  FlowCondition,
  FlowPlanAnyNode,
  FlowPlanNode,
  FlowTrigger,
  WorldAgent,
  WorldDevice,
} from '../../api/types';
import {
  type ActionNodeData,
  type DelegateNodeData,
  type NotifyNodeData,
  type ServiceNodeData,
  type TriggerNodeData,
  type WaitNodeData,
} from '../../lib/flowGraph';
import { hhmmToSecOfDay, secOfDayToHhmm } from '../../lib/timeOfDay';

/** Trigger-kind order for the trigger-mode dropdown (matches flowGraph.ts). */
const TRIGGER_KIND_ORDER: Array<FlowTrigger['kind']> = ['event', 'condition', 'schedule'];

export interface FlowEditorCtx {
  zones: EnvZone[];
  agents: WorldAgent[];
  /**
   * T-051(b): env devices — the action node's deviceId pin dropdown lists
   * the assignee's bound devices from here (pins must name a device bound
   * to the assignee, or the server 422s).
   */
  devices: WorldDevice[];
  /** Capability vocabulary: agents' ∪ devices' capabilities (datalist). */
  capabilities: string[];
  /** All action-node ids on the canvas (compensateNodeId dropdown). */
  nodeIds: string[];
  /** builder/owner can edit; viewers get a read-only canvas. */
  readOnly: boolean;
  /** Node ids to highlight from the latest validation report. */
  errorNodeIds: ReadonlySet<string>;
  warningNodeIds: ReadonlySet<string>;
  updateTrigger: (trigger: FlowTrigger) => void;
  /** R2-FEAT-06: widened to the plan-node union (canvas-authored notify/wait). */
  updatePlanNode: (id: string, planNode: FlowPlanAnyNode) => void;
}

export const FlowEditorContext = createContext<FlowEditorCtx | null>(null);

function useFlowEditor(): FlowEditorCtx {
  const ctx = useContext(FlowEditorContext);
  if (ctx === null) throw new Error('flow node rendered outside FlowEditorContext');
  return ctx;
}

function nodeClass(ctx: FlowEditorCtx, id: string): string {
  if (ctx.errorNodeIds.has(id)) return 'flow-node flow-node--error';
  if (ctx.warningNodeIds.has(id)) return 'flow-node flow-node--warning';
  return 'flow-node';
}

const CONDITION_OPS: Array<FlowCondition['op']> = ['==', '!=', '>', '<', '>=', '<='];

/** Parse a condition value: booleans and numbers infer, else string. */
export function parseConditionValue(raw: string): number | boolean | string {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return raw;
}

/** conditions 列表编辑：path / op / value 行，可增删（AND 语义）。 */
export function ConditionsEditor({
  conditions,
  readOnly,
  onChange,
}: {
  conditions: FlowCondition[];
  readOnly: boolean;
  onChange: (conditions: FlowCondition[]) => void;
}) {
  const { t } = useTranslation('flows');
  const updateRow = (index: number, patch: Partial<FlowCondition>) => {
    onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  return (
    <div className="flow-conditions">
      {conditions.map((condition, index) => (
        <div key={index} className="flow-conditions__row">
          <input
            aria-label={t('conditionPathAria')}
            placeholder={t('conditionPathPlaceholder')}
            value={condition.path}
            disabled={readOnly}
            onChange={event => updateRow(index, { path: event.target.value })}
          />
          <select
            aria-label={t('conditionOpAria')}
            value={condition.op}
            disabled={readOnly}
            onChange={event =>
              updateRow(index, { op: event.target.value as FlowCondition['op'] })
            }
          >
            {CONDITION_OPS.map(op => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            aria-label={t('conditionValueAria')}
            placeholder={t('conditionValuePlaceholder')}
            value={String(condition.value)}
            disabled={readOnly}
            onChange={event => updateRow(index, { value: parseConditionValue(event.target.value) })}
          />
          {!readOnly && (
            <button
              type="button"
              className="link-button"
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              {t('conditionRemove')}
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="link-button"
          onClick={() => onChange([...conditions, { path: '', op: '>', value: 0 }])}
        >
          {t('conditionAdd')}
        </button>
      )}
    </div>
  );
}

function ZoneSelect({
  value,
  allowEmpty,
  zones,
  readOnly,
  onChange,
}: {
  value: string | undefined;
  allowEmpty: boolean;
  zones: EnvZone[];
  readOnly: boolean;
  onChange: (zoneId: string | undefined) => void;
}) {
  const { t } = useTranslation('flows');
  return (
    <select
      aria-label={t('fieldZoneAria')}
      value={value ?? ''}
      disabled={readOnly}
      onChange={event => onChange(event.target.value === '' ? undefined : event.target.value)}
    >
      {allowEmpty ? (
        <option value="">{t('zoneAnyOption')}</option>
      ) : (
        <option value="">{t('zonePickOption')}</option>
      )}
      {zones.map(zone => (
        <option key={zone.id} value={zone.id}>
          {zone.name ?? zone.id}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: number | undefined;
  readOnly: boolean;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="flow-node__field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        value={value ?? ''}
        disabled={readOnly}
        onChange={event =>
          onChange(event.target.value === '' ? undefined : Number(event.target.value))
        }
      />
    </label>
  );
}

/**
 * R2-UX-14: sec-of-day field as an HH:MM clock input (replaces the raw
 * 「84600=23:30」 second count); clearing the input unsets the value.
 */
function TimeOfDayField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: number | undefined;
  readOnly: boolean;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="flow-node__field">
      <span>{label}</span>
      <input
        type="time"
        aria-label={label}
        value={value === undefined ? '' : secOfDayToHhmm(value)}
        disabled={readOnly}
        onChange={event => {
          if (event.target.value === '') {
            onChange(undefined);
            return;
          }
          const sec = hhmmToSecOfDay(event.target.value);
          if (sec !== undefined) onChange(sec);
        }}
      />
    </label>
  );
}

/** Trigger node: kind dropdown + the kind-specific field form. */
export function TriggerNodeCard({ id, data, selected }: NodeProps<TriggerNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { trigger } = data;
  const readOnly = ctx.readOnly;

  const switchKind = (kind: FlowTrigger['kind']) => {
    if (kind === trigger.kind) return;
    if (kind === 'event') {
      ctx.updateTrigger({ kind: 'event' });
    } else if (kind === 'condition') {
      ctx.updateTrigger({ kind: 'condition', zoneId: ctx.zones[0]?.id ?? '', conditions: [] });
    } else {
      ctx.updateTrigger({ kind: 'schedule' });
    }
  };

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--trigger${selected ? ' flow-node--selected' : ''}`}>
      <div className="flow-node__title">{t('triggerTitle')}</div>
      <label className="flow-node__field">
        <span>{t('triggerMode')}</span>
        <select
          aria-label={t('triggerModeAria')}
          value={trigger.kind}
          disabled={readOnly}
          onChange={event => switchKind(event.target.value as FlowTrigger['kind'])}
        >
          {TRIGGER_KIND_ORDER.map(kind => (
            <option key={kind} value={kind}>
              {t(`triggerKind.${kind}`)}
            </option>
          ))}
        </select>
      </label>

      {trigger.kind === 'event' && (
        <>
          <label className="flow-node__field">
            <span>{t('triggerEventType')}</span>
            <input
              aria-label={t('triggerEventTypeAria')}
              placeholder={t('triggerEventTypePlaceholder')}
              value={trigger.eventType ?? ''}
              disabled={readOnly}
              onChange={event =>
                ctx.updateTrigger({ ...trigger, eventType: event.target.value || undefined })
              }
            />
          </label>
          <label className="flow-node__field">
            <span>{t('triggerZone')}</span>
            <ZoneSelect
              value={trigger.zoneId}
              allowEmpty
              zones={ctx.zones}
              readOnly={readOnly}
              onChange={zoneId => ctx.updateTrigger({ ...trigger, zoneId })}
            />
          </label>
          <label className="flow-node__field">
            <span>{t('triggerParam')}</span>
            <input
              aria-label={t('triggerParamAria')}
              placeholder={t('triggerParamPlaceholder')}
              value={trigger.parameter ?? ''}
              disabled={readOnly}
              onChange={event =>
                ctx.updateTrigger({ ...trigger, parameter: event.target.value || undefined })
              }
            />
          </label>
          <div className="flow-node__field">
            <span>{t('triggerMatchConditions')}</span>
            <ConditionsEditor
              conditions={trigger.conditions ?? []}
              readOnly={readOnly}
              onChange={conditions => ctx.updateTrigger({ ...trigger, conditions })}
            />
          </div>
        </>
      )}

      {trigger.kind === 'condition' && (
        <>
          <label className="flow-node__field">
            <span>{t('triggerZoneRequired')}</span>
            <ZoneSelect
              value={trigger.zoneId}
              allowEmpty={false}
              zones={ctx.zones}
              readOnly={readOnly}
              onChange={zoneId => ctx.updateTrigger({ ...trigger, zoneId: zoneId ?? '' })}
            />
          </label>
          <div className="flow-node__field">
            <span>{t('triggerConditions')}</span>
            <ConditionsEditor
              conditions={trigger.conditions}
              readOnly={readOnly}
              onChange={conditions => ctx.updateTrigger({ ...trigger, conditions })}
            />
          </div>
          <NumberField
            label={t('triggerCooldown')}
            value={trigger.cooldownSimSec}
            readOnly={readOnly}
            onChange={cooldownSimSec => ctx.updateTrigger({ ...trigger, cooldownSimSec })}
          />
          <NumberField
            label={t('triggerHysteresis')}
            value={trigger.hysteresisSimC}
            readOnly={readOnly}
            onChange={hysteresisSimC => ctx.updateTrigger({ ...trigger, hysteresisSimC })}
          />
          {/* FEAT-01: time-of-day active window [start, end) (start > end crosses midnight). */}
          <TimeOfDayField
            label={t('triggerActiveWindowStart')}
            value={trigger.activeWindowSimSec?.[0]}
            readOnly={readOnly}
            onChange={start => {
              const end = trigger.activeWindowSimSec?.[1];
              ctx.updateTrigger({
                ...trigger,
                activeWindowSimSec:
                  start === undefined && end === undefined
                    ? undefined
                    : [start ?? 0, end ?? 86400],
              });
            }}
          />
          <TimeOfDayField
            label={t('triggerActiveWindowEnd')}
            value={trigger.activeWindowSimSec?.[1]}
            readOnly={readOnly}
            onChange={end => {
              const start = trigger.activeWindowSimSec?.[0];
              ctx.updateTrigger({
                ...trigger,
                activeWindowSimSec:
                  start === undefined && end === undefined
                    ? undefined
                    : [start ?? 0, end ?? 86400],
              });
            }}
          />
        </>
      )}

      {trigger.kind === 'schedule' && (
        <>
          <NumberField
            label={t('triggerAtSimTime')}
            value={trigger.atSimTimeSec}
            readOnly={readOnly}
            onChange={atSimTimeSec => ctx.updateTrigger({ ...trigger, atSimTimeSec })}
          />
          <NumberField
            label={t('triggerEverySimSec')}
            value={trigger.everySimSec}
            readOnly={readOnly}
            onChange={everySimSec => ctx.updateTrigger({ ...trigger, everySimSec })}
          />
          <NumberField
            label={t('triggerStartSimSec')}
            value={trigger.startAtSimTimeSec}
            readOnly={readOnly}
            onChange={startAtSimTimeSec => ctx.updateTrigger({ ...trigger, startAtSimTimeSec })}
          />
          <NumberField
            label={t('triggerEndSimSec')}
            value={trigger.endAtSimTimeSec}
            readOnly={readOnly}
            onChange={endAtSimTimeSec => ctx.updateTrigger({ ...trigger, endAtSimTimeSec })}
          />
          {/* FEAT-01 / R2-UX-14: daily time-of-day anchor as an HH:MM clock. */}
          <TimeOfDayField
            label={t('triggerAtTimeOfDay')}
            value={trigger.atTimeOfDaySec}
            readOnly={readOnly}
            onChange={atTimeOfDaySec => ctx.updateTrigger({ ...trigger, atTimeOfDaySec })}
          />
          {/* FEAT-01: occupancy-relative daily anchor (e.g. 到馆前 30 分钟预冷). */}
          {trigger.relativeToOccupancy === undefined ? (
            !readOnly && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  ctx.updateTrigger({
                    ...trigger,
                    relativeToOccupancy: { before: 'arrive', offsetSec: 1800 },
                  })
                }
              >
                {t('triggerRelOccAdd')}
              </button>
            )
          ) : (
            <div className="flow-node__field">
              <span>{t('triggerRelOcc')}</span>
              <ZoneSelect
                value={trigger.relativeToOccupancy.zoneId}
                allowEmpty
                zones={ctx.zones}
                readOnly={readOnly}
                onChange={zoneId =>
                  ctx.updateTrigger({
                    ...trigger,
                    relativeToOccupancy: { ...trigger.relativeToOccupancy!, zoneId },
                  })
                }
              />
              <select
                aria-label={t('triggerRelOccBeforeAria')}
                value={trigger.relativeToOccupancy.before}
                disabled={readOnly}
                onChange={event =>
                  ctx.updateTrigger({
                    ...trigger,
                    relativeToOccupancy: {
                      ...trigger.relativeToOccupancy!,
                      before: event.target.value as 'arrive' | 'depart',
                    },
                  })
                }
              >
                <option value="arrive">{t('triggerRelOccArrive')}</option>
                <option value="depart">{t('triggerRelOccDepart')}</option>
              </select>
              <NumberField
                label={t('triggerRelOccOffset')}
                value={trigger.relativeToOccupancy.offsetSec}
                readOnly={readOnly}
                onChange={offsetSec =>
                  ctx.updateTrigger({
                    ...trigger,
                    relativeToOccupancy: { ...trigger.relativeToOccupancy!, offsetSec: offsetSec ?? 0 },
                  })
                }
              />
              {!readOnly && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    const { relativeToOccupancy: _dropped, ...rest } = trigger;
                    ctx.updateTrigger(rest);
                  }}
                >
                  {t('triggerRelOccRemove')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

/** Action node: one plan node (capability/assignee/params/guard/onFail). */
export function ActionNodeCard({ id, data, selected }: NodeProps<ActionNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { planNode } = data;
  const readOnly = ctx.readOnly;

  // R2-BUG-03: params 的 JSON 文本域——边敲边提交（合法即入编辑器态，非法
  // 标红不提交），不再失焦才提交。旧机制（onBlur commit）在「点保存」手势中
  // 由 mousedown 触发 blur → dirty 首翻 → 工具栏 dirty chip 首次插入 DOM →
  // Chromium 不再把 mouseup/click 派发给保存按钮，保存静默失效。
  const [paramsText, setParamsText] = useState(() =>
    planNode.params !== undefined ? JSON.stringify(planNode.params) : '',
  );
  const [paramsError, setParamsError] = useState(false);
  // Re-sync when the node identity or its committed params change (flow
  // switch / external edit); own onChange commits re-serialize to the same
  // object, so this fires right after a commit too — resetting the text to
  // the canonical serialization is a no-op for well-formatted drafts.
  const serializedParams = planNode.params !== undefined ? JSON.stringify(planNode.params) : '';
  useEffect(() => {
    setParamsText(serializedParams);
    setParamsError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, serializedParams]);

  const patch = (p: Partial<FlowPlanNode>) => ctx.updatePlanNode(id, { ...planNode, ...p });

  // T-051(b): deviceId pin options — the assignee's bound devices when one
  // is picked; for auto-assignment, every device bound to at least one
  // agent (the runtime only actuates agent-bound devices, so an unbound
  // pin could never resolve).
  const pinOptions = useMemo(() => {
    const assignee = ctx.agents.find(agent => agent.id === planNode.assigneeAgentId);
    if (assignee !== undefined) {
      const bound = new Set(assignee.boundDeviceIds);
      return ctx.devices.filter(device => bound.has(device.id));
    }
    const boundIds = new Set(ctx.agents.flatMap(agent => agent.boundDeviceIds));
    return ctx.devices.filter(device => boundIds.has(device.id));
  }, [ctx.agents, ctx.devices, planNode.assigneeAgentId]);

  // R2-UX-15: capability datalist — pinned device narrows the vocabulary to
  // that device's own capabilities; unpinned keeps the env-wide list.
  const capabilityOptions = useMemo(() => {
    if (planNode.deviceId !== undefined) {
      const pinned = ctx.devices.find(device => device.id === planNode.deviceId);
      if (pinned !== undefined) return pinned.capabilities;
    }
    return ctx.capabilities;
  }, [ctx.devices, ctx.capabilities, planNode.deviceId]);

  // R2-BUG-03(a): commit on every change — valid JSON object lands in the
  // editor state immediately (so the dirty chip is already mounted long
  // before the user reaches for the save button); invalid drafts flag red
  // and never commit. No blur-commit path remains.
  const handleParamsChange = (raw: string) => {
    setParamsText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      setParamsError(false);
      if (planNode.params !== undefined) {
        const { params: _dropped, ...rest } = planNode;
        ctx.updatePlanNode(id, rest);
      }
      return;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParamsError(true);
        return;
      }
      setParamsError(false);
      patch({ params: parsed as Record<string, unknown> });
    } catch {
      setParamsError(true);
    }
  };

  const onFailPolicy = planNode.onFail?.policy ?? '';

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--action${selected ? ' flow-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <div className="flow-node__title">
        {t('actionTitle')} <span className="flow-node__id">{planNode.id}</span>
      </div>
      <label className="flow-node__field">
        <span>{t('actionCapability')}</span>
        <input
          aria-label={t('actionCapabilityAria')}
          list={`flow-capability-options-${id}`}
          placeholder={t('actionCapabilityPlaceholder')}
          value={planNode.capability}
          disabled={readOnly}
          onChange={event => patch({ capability: event.target.value })}
        />
        {/* R2-UX-15: 钉定设备后候选收窄到该设备的能力集（不再全环境词表）。 */}
        <datalist id={`flow-capability-options-${id}`}>
          {capabilityOptions.map(capability => (
            <option key={capability} value={capability} />
          ))}
        </datalist>
      </label>
      <label className="flow-node__field">
        <span>{t('actionAssignee')}</span>
        <select
          aria-label={t('actionAssigneeAria')}
          value={planNode.assigneeAgentId ?? ''}
          disabled={readOnly}
          onChange={event => {
            const assigneeAgentId = event.target.value === '' ? undefined : event.target.value;
            // T-051(b): a pin must name one of the ASSIGNEE's bound devices
            // (the server 422s otherwise) — switching the assignee drops a
            // pin that is no longer bound to it, instead of authoring an
            // invalid flow the editor cannot resolve in-UI.
            if (
              planNode.deviceId !== undefined &&
              assigneeAgentId !== undefined &&
              !ctx.devices.some(
                device =>
                  device.id === planNode.deviceId &&
                  ctx.agents
                    .find(agent => agent.id === assigneeAgentId)
                    ?.boundDeviceIds.includes(device.id),
              )
            ) {
              const { deviceId: _dropped, ...rest } = planNode;
              ctx.updatePlanNode(id, { ...rest, assigneeAgentId });
              return;
            }
            patch({ assigneeAgentId });
          }}
        >
          <option value="">{t('actionAssigneeAuto')}</option>
          {ctx.agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flow-node__field">
        <span>{t('actionDevicePin')}</span>
        <select
          aria-label={t('actionDevicePinAria')}
          value={planNode.deviceId ?? ''}
          disabled={readOnly}
          onChange={event =>
            patch({ deviceId: event.target.value === '' ? undefined : event.target.value })
          }
        >
          <option value="">{t('actionDevicePinAuto')}</option>
          {pinOptions.map(device => (
            <option key={device.id} value={device.id}>
              {device.name} · {device.id}
            </option>
          ))}
        </select>
        <span className="flow-node__hint">{t('actionDevicePinHint')}</span>
      </label>
      <label className="flow-node__field">
        <span>{t('actionParams')}</span>
        <textarea
          aria-label={t('actionParamsAria')}
          rows={2}
          placeholder='{"target": 24}'
          value={paramsText}
          disabled={readOnly}
          onChange={event => handleParamsChange(event.target.value)}
        />
        {paramsError && <span className="flow-node__error">{t('actionParamsError')}</span>}
      </label>
      <label className="flow-node__field">
        <span>{t('actionCondition')}</span>
        <input
          aria-label={t('actionConditionAria')}
          placeholder="zone.temperature > 30"
          value={planNode.condition ?? ''}
          disabled={readOnly}
          onChange={event => patch({ condition: event.target.value || undefined })}
        />
      </label>
      <label className="flow-node__field">
        <span>{t('actionOnFail')}</span>
        <select
          aria-label={t('actionOnFailAria')}
          value={onFailPolicy}
          disabled={readOnly}
          onChange={event => {
            const policy = event.target.value;
            if (policy === '') {
              const { onFail: _dropped, ...rest } = planNode;
              ctx.updatePlanNode(id, rest);
            } else {
              patch({ onFail: { policy: policy as 'abort' | 'retry' | 'compensate' } });
            }
          }}
        >
          <option value="">{t('actionOnFailDefault')}</option>
          <option value="abort">{t('actionOnFailAbort')}</option>
          <option value="retry">{t('actionOnFailRetry')}</option>
          <option value="compensate">{t('actionOnFailCompensate')}</option>
        </select>
      </label>
      {onFailPolicy === 'retry' && (
        <NumberField
          label={t('actionRetries')}
          value={planNode.onFail?.retries}
          readOnly={readOnly}
          onChange={retries =>
            patch({ onFail: { policy: 'retry', ...(retries !== undefined ? { retries } : {}) } })
          }
        />
      )}
      {onFailPolicy === 'compensate' && (
        <label className="flow-node__field">
          <span>{t('actionCompensateNode')}</span>
          <select
            aria-label={t('actionCompensateNodeAria')}
            value={planNode.onFail?.compensateNodeId ?? ''}
            disabled={readOnly}
            onChange={event =>
              patch({
                onFail: {
                  policy: 'compensate',
                  ...(event.target.value !== ''
                    ? { compensateNodeId: event.target.value }
                    : {}),
                },
              })
            }
          >
            <option value="">{t('actionCompensateNodePick')}</option>
            {ctx.nodeIds
              .filter(nodeId => nodeId !== id)
              .map(nodeId => (
                <option key={nodeId} value={nodeId}>
                  {nodeId}
                </option>
              ))}
          </select>
        </label>
      )}
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

/**
 * Mechanism A: delegate node card — a bounded LLM judgment step. v1 renders
 * it read-only (delegate nodes are authored via flow JSON / CLI / REST; the
 * canvas must still display them faithfully, edges included).
 */
export function DelegateNodeCard({ id, data, selected }: NodeProps<DelegateNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { planNode } = data;
  const spec = planNode.delegate;
  const fallback =
    spec.fallback?.policy === 'node'
      ? t('delegateFallbackNode', { nodeId: spec.fallback.nodeId })
      : t('delegateFallbackNone');

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--delegate${selected ? ' flow-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <div className="flow-node__title">
        {t('delegateTitle')} <span className="flow-node__id">{planNode.id}</span>
      </div>
      <div className="flow-node__field">
        <span>{t('delegateMode')}</span>
        <code>{spec.mode}</code>
        {planNode.assigneeAgentId !== undefined ? (
          <span className="flow-node__id"> · {planNode.assigneeAgentId}</span>
        ) : null}
      </div>
      <label className="flow-node__field">
        <span>{t('delegateQuestion')}</span>
        <textarea aria-label={t('delegateQuestion')} value={spec.question} rows={2} readOnly />
      </label>
      {spec.budget !== undefined ? (
        <div className="flow-node__field">
          <span>{t('delegateBudget')}</span>
          <code>
            {t('delegateBudgetSummary', {
              commands: spec.budget.maxCommands,
              devices: spec.budget.deviceIds.length,
              allowed: spec.budget.allowedCommands.join(', '),
            })}
          </code>
        </div>
      ) : null}
      {spec.outputs !== undefined && spec.outputs.length > 0 ? (
        <div className="flow-node__field">
          <span>{t('delegateOutputs')}</span>
          <code>{spec.outputs.join(', ')}</code>
        </div>
      ) : null}
      <div className="flow-node__field">
        <span>{t('delegateFallback')}</span>
        <code>
          {fallback} · {t('delegateTimeout')}: {spec.timeoutMs ?? 30000}ms
        </code>
      </div>
      <p className="flow-node__field flow-node__id">{t('delegateReadOnlyHint')}</p>
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

/**
 * R6-B-F03: service node card — a cross-tenant invocation via an active
 * agreement. Rendered read-only like the delegate card: service nodes are
 * authored via flow JSON / CLI / REST; the canvas must still display them
 * faithfully, edges included.
 */
export function ServiceNodeCard({ id, data, selected }: NodeProps<ServiceNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { planNode } = data;
  const spec = planNode.service;

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--service${selected ? ' flow-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <div className="flow-node__title">
        {t('serviceTitle')} <span className="flow-node__id">{planNode.id}</span>
      </div>
      <div className="flow-node__field">
        <span>{t('serviceService')}</span>
        <code>{spec.serviceId ?? spec.semanticType ?? ''}</code>
      </div>
      {spec.action !== undefined ? (
        <div className="flow-node__field">
          <span>{t('serviceAction')}</span>
          <code>{spec.action}</code>
        </div>
      ) : null}
      {planNode.params !== undefined ? (
        <div className="flow-node__field">
          <span>{t('serviceParams')}</span>
          <code>{JSON.stringify(planNode.params)}</code>
        </div>
      ) : null}
      <p className="flow-node__field flow-node__id">{t('serviceReadOnlyHint')}</p>
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

/**
 * FEAT-05 / R2-FEAT-06: notify node card — a deterministic notification to
 * the user inbox. Canvas-authored (to / target / message form); the engine
 * semantics are unchanged (FlowNotifyInvoker seam, `flow.notification`).
 */
export function NotifyNodeCard({ id, data, selected }: NodeProps<NotifyNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { planNode } = data;
  const spec = planNode.notify;
  const readOnly = ctx.readOnly;

  const patchNotify = (notify: NotifyNodeData['planNode']['notify']) =>
    ctx.updatePlanNode(id, { ...planNode, notify });

  // 切换收件方类型时重置 target 到该类型的合法形态（agent id / 角色名 /
  // owner 不带 target），避免把 agent id 误留成角色名。
  const switchTo = (to: 'agent' | 'role' | 'owner') => {
    if (to === spec.to) return;
    if (to === 'owner') {
      patchNotify({ to, message: spec.message });
    } else if (to === 'agent') {
      patchNotify({ to, target: ctx.agents[0]?.id, message: spec.message });
    } else {
      patchNotify({ to, target: 'owner', message: spec.message });
    }
  };

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--notify${selected ? ' flow-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <div className="flow-node__title">
        {t('notifyTitle')} <span className="flow-node__id">{planNode.id}</span>
      </div>
      <label className="flow-node__field">
        <span>{t('notifyTo')}</span>
        <select
          aria-label={t('notifyToAria')}
          value={spec.to}
          disabled={readOnly}
          onChange={event => switchTo(event.target.value as 'agent' | 'role' | 'owner')}
        >
          <option value="owner">{t('notifyToOwner')}</option>
          <option value="agent">{t('notifyToAgent')}</option>
          <option value="role">{t('notifyToRole')}</option>
        </select>
      </label>
      {spec.to === 'agent' && (
        <label className="flow-node__field">
          <span>{t('notifyTargetAgent')}</span>
          <select
            aria-label={t('notifyTargetAgentAria')}
            value={spec.target ?? ''}
            disabled={readOnly}
            onChange={event =>
              patchNotify({ ...spec, target: event.target.value === '' ? undefined : event.target.value })
            }
          >
            <option value="">{t('notifyTargetAgentPick')}</option>
            {ctx.agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {spec.to === 'role' && (
        <label className="flow-node__field">
          <span>{t('notifyTargetRole')}</span>
          <select
            aria-label={t('notifyTargetRoleAria')}
            value={spec.target ?? 'owner'}
            disabled={readOnly}
            onChange={event => patchNotify({ ...spec, target: event.target.value })}
          >
            <option value="owner">{t('notifyRoleOwner')}</option>
            <option value="builder">{t('notifyRoleBuilder')}</option>
            <option value="viewer">{t('notifyRoleViewer')}</option>
          </select>
        </label>
      )}
      <label className="flow-node__field">
        <span>{t('notifyMessage')}</span>
        <textarea
          aria-label={t('notifyMessageAria')}
          placeholder={t('notifyMessagePlaceholder')}
          value={spec.message}
          rows={2}
          disabled={readOnly}
          onChange={event => patchNotify({ ...spec, message: event.target.value })}
        />
      </label>
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

/**
 * FEAT-06 / R2-FEAT-06: wait node card — a deterministic sim-second delay
 * (挂起态进 checkpoint、due 时刻续跑；语义不变，画布补创作入口).
 */
export function WaitNodeCard({ id, data, selected }: NodeProps<WaitNodeData>) {
  const ctx = useFlowEditor();
  const { t } = useTranslation('flows');
  const { planNode } = data;
  const readOnly = ctx.readOnly;

  return (
    <div className={`${nodeClass(ctx, id)} flow-node--wait${selected ? ' flow-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="zone-handle" />
      <div className="flow-node__title">
        {t('waitTitle')} <span className="flow-node__id">{planNode.id}</span>
      </div>
      <NumberField
        label={t('waitSimSec')}
        value={planNode.wait.simSec}
        readOnly={readOnly}
        onChange={simSec =>
          ctx.updatePlanNode(id, { ...planNode, wait: { simSec: simSec ?? 0 } })
        }
      />
      <Handle type="source" position={Position.Right} className="zone-handle" />
    </div>
  );
}

export const flowNodeTypes = {
  trigger: TriggerNodeCard,
  action: ActionNodeCard,
  delegate: DelegateNodeCard,
  service: ServiceNodeCard,
  notify: NotifyNodeCard,
  wait: WaitNodeCard,
};
