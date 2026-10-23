/**
 * DeviceActionSheet — console device quick actions (UX-W1 wave-1 task B).
 *
 * Picking a device dot on the console map (WorldSelection objectType
 * 'device') slides this card up over the map's bottom edge: device identity
 * + live state (from the console's snapshot poll — the sheet never fetches
 * its own copy) + the executable command face derived from the device's
 * declared capabilities (lib/deviceCommands, mirroring the core read-only
 * predicate and deriveDeviceCommands — observation capabilities never show
 * up as commands).
 *
 * Execution goes through api.sendDeviceCommand (the same endpoint the
 * DeploymentPanel command test uses); feedback reuses its conventions:
 * parseParamsJson for the optional params JSON input and commandFeedback
 * for the result toast (a safety-gate-parked 202 is a soft-block notice,
 * not an error). Server teaching texts (read-only capability, 403
 * permission, device offline) surface verbatim via the toast. After a
 * successful send the console pulls one fresh snapshot so the device dot /
 * state row updates in place instead of waiting for the next poll tick.
 *
 * Permission boundary: `canExecute` (SimulationView: env owner/builder, or
 * any legacy scenario console) gates the execute button — viewers and
 * anonymous readers of a public environment see the command face but no
 * execute affordance.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { SnapshotDevice } from '../api/types';
import { commandFeedback, parseParamsJson } from '../lib/hass';
import { deriveDeviceCommandFace } from '../lib/deviceCommands';
import { commandDisplay, formatDeviceState } from '../lib/deviceDisplay';
import type { WorldModelDevice } from '../lib/worldModel';
import { useAppStore } from '../store/useAppStore';
import { Icon } from './ui/Icon';

export interface DeviceActionSheetProps {
  simulationId: string;
  device: WorldModelDevice;
  /** Live snapshot row for this device (undefined before the first snapshot). */
  live: SnapshotDevice | undefined;
  /** Env zone display name (undefined for legacy scenarios without names). */
  zoneName?: string;
  /** false hides the execute button (viewer / anonymous reader). */
  canExecute: boolean;
  onClose: () => void;
}

export function DeviceActionSheet({
  simulationId,
  device,
  live,
  zoneName,
  canExecute,
  onClose,
}: DeviceActionSheetProps) {
  const { t } = useTranslation('deviceActions');
  const pushToast = useAppStore(s => s.pushToast);
  const setSnapshot = useAppStore(s => s.setSnapshot);
  const [command, setCommand] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState('');
  const [sending, setSending] = useState(false);

  const commands = deriveDeviceCommandFace(device.capabilities);
  // A picked command that disappears (capabilities edited mid-session) falls
  // back to no selection instead of sending a stale name.
  const activeCommand = command !== null && commands.includes(command) ? command : null;

  const execute = async () => {
    if (activeCommand === null || sending) return;
    const parsed = parseParamsJson(paramsText);
    if (parsed.error !== undefined) {
      pushToast(parsed.error, 'error');
      return;
    }
    setSending(true);
    try {
      const result = await api.sendDeviceCommand(
        simulationId,
        device.id,
        activeCommand,
        parsed.params,
      );
      const feedback = commandFeedback(result);
      pushToast(
        feedback.text,
        feedback.kind === 'error' ? 'error' : feedback.kind === 'ok' ? 'success' : 'info',
      );
      if (feedback.kind === 'ok') {
        // In-place refresh through the console's existing snapshot channel —
        // the poll loop keeps it current from here. Wait ~1 tick first: the
        // command lands on the NEXT engine tick, so an immediate re-fetch can
        // return the pre-command snapshot and flash the stale state (ux-w1
        // probe saw sheet show "off" while the API already had "on").
        await new Promise(resolve => setTimeout(resolve, 1200));
        setSnapshot(await api.getSnapshot(simulationId));
      }
    } catch (error) {
      // R2-UX-03: the 409 DEVICE_NOT_MANAGED envelope is English with no
      // way forward — localize by code and say where to go (binding an
      // agent is a world-page act; Flow orchestration is NOT gated by it).
      if (error instanceof ApiClientError && error.code === 'DEVICE_NOT_MANAGED') {
        pushToast(
          error.message.includes('frozen snapshot')
            ? t('deviceNotManagedStale')
            : t('deviceNotManaged'),
          'error',
        );
      } else {
        // Server teaching texts (read-only capability / 403 / offline) verbatim.
        pushToast(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="device-action-sheet" data-testid="device-action-sheet">
      <header className="device-action-sheet__header">
        <div className="device-action-sheet__identity">
          <strong>{device.name}</strong>
          <span className="device-action-sheet__meta">
            {device.type}
            {zoneName !== undefined ? ` · ${zoneName}` : ''}
          </span>
        </div>
        <button
          className="link-button device-action-sheet__close"
          aria-label={t('close')}
          onClick={onClose}
        >
          <Icon icon={X} size={14} />
        </button>
      </header>
      <div className="device-action-sheet__state">
        <span className="device-action-sheet__state-label">{t('stateLabel')}</span>
        <span className="device-action-sheet__state-value" data-testid="device-action-state">
          {live === undefined
            ? t('stateUnknown')
            : live.stateRedacted === true
              ? t('stateRedacted', { status: live.status ?? '' })
              : formatDeviceState(live.state)}
        </span>
      </div>
      {commands.length === 0 ? (
        <p className="page-note">{t('noCommands')}</p>
      ) : (
        <div className="device-action-sheet__commands" role="group" aria-label={t('commandsLabel')}>
          {commands.map(name => {
            // UX-R2: friendly label for common commands + the raw token as
            // the subtitle (the exact command stays discoverable); unknown
            // commands render the raw token only.
            const display = commandDisplay(name);
            return (
              <button
                key={name}
                // aria-label keeps the RAW token as the accessible name —
                // the exact command is the API vocabulary (and the subtitle
                // duplicates it visually anyway).
                aria-label={name}
                className={`device-action-sheet__command${
                  name === activeCommand ? ' device-action-sheet__command--active' : ''
                }`}
                onClick={() => setCommand(current => (current === name ? null : name))}
              >
                <span className="device-action-sheet__command-label">{display.label}</span>
                {display.known && (
                  <span className="device-action-sheet__command-raw">{display.raw}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {activeCommand !== null && (
        <div className="device-action-sheet__exec">
          <input
            value={paramsText}
            onChange={event => setParamsText(event.target.value)}
            placeholder={t('paramsPlaceholder')}
            aria-label={t('paramsLabel')}
          />
          {canExecute ? (
            <button disabled={sending} onClick={() => void execute()}>
              {sending ? t('executing') : t('execute', { command: activeCommand })}
            </button>
          ) : (
            <span className="page-note">{t('viewerNote')}</span>
          )}
        </div>
      )}
    </aside>
  );
}
