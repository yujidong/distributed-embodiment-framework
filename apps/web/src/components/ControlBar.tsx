/**
 * ControlBar — simulation lifecycle controls + the W7 status header (one
 * coherent status zone: state pill, live readouts, activity indicator and
 * the running-quiet guidance chip live here, next to the controls).
 *
 * Server-authoritative: every button is an API call; the UI never assumes
 * the outcome — after each call we pull one fresh snapshot and let the
 * polling loop keep it current.
 *
 * Legal transitions (mirroring EngineRuntime):
 * - start  : created | paused (also used to change speed while running)
 * - pause  : running
 * - resume : paused
 * - step   : created | paused (manual ticking; pointless while running)
 * - stop   : anything but stopped
 */

import { useEffect, useRef, useState } from 'react';
import { MonitorPlay, OctagonAlert, Sparkles, XCircle } from 'lucide-react';

import * as api from '../api/client';
import type { EngineRuntimeState, EngineSnapshot, PublicHealth } from '../api/types';
import { stepToInChunks } from '../lib/demoPlaylist';
import { deriveSimStatus, formatSimTime, nextScheduledEventSec } from '../lib/simStatus';
import { deriveLlmLine } from '../lib/llmMetrics';
import { llmChipHealth } from '../lib/llmHealth';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { useAppStore, type StreamStatus } from '../store/useAppStore';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui/Icon';
import { useConfirm } from './ui/ConfirmDialog';

/** R2-FEAT-10: /api/health posture poll cadence for the LLM chip. */
const HEALTH_POLL_MS = 20_000;

/**
 * A4 speed presets — semantic steps instead of raw numbers. The value is the
 * engine speed (sim-seconds per tick); no server-side cap.
 */
const SPEED_PRESETS = [
  { value: 1, labelKey: 'speedPreset.realtime' },
  { value: 60, labelKey: 'speedPreset.demo' },
  { value: 400, labelKey: 'speedPreset.turbo' },
] as const;

/** Shared preset select so the present/normal bars render identical options. */
export function SpeedSelect({
  speed,
  disabled,
  onChange,
}: {
  speed: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  const { t } = useTranslation('sim');
  // R14: a non-preset speed (e.g. set via CLI or a snapshot from another
  // client) must still render — without this option the select shows blank.
  const isPreset = SPEED_PRESETS.some(preset => preset.value === speed);
  return (
    <label className="control-bar__speed">
      {t('speed')}
      <select
        value={speed}
        disabled={disabled}
        onChange={event => onChange(Number(event.target.value))}
      >
        {SPEED_PRESETS.map(preset => (
          <option key={preset.value} value={preset.value}>
            {t(preset.labelKey)}
          </option>
        ))}
        {!isPreset && <option value={speed}>{t('speedPreset.custom', { value: speed })}</option>}
      </select>
    </label>
  );
}

const STATE_LABEL_KEYS: Record<EngineRuntimeState, string> = {
  created: 'state.created',
  running: 'state.running',
  paused: 'state.paused',
  stopped: 'state.stopped',
};

const STREAM_LABEL_KEYS: Record<Exclude<StreamStatus, 'idle'>, string> = {
  connecting: 'stream.connecting',
  open: 'stream.open',
  reconnecting: 'stream.reconnecting',
  down: 'stream.down',
};

/** Demo hero event target: scenario meta heroEventId resolved to its event. */
export interface HeroEventTarget {
  id: string;
  atSimTimeSec: number;
}

export interface ControlBarProps {
  snapshot: EngineSnapshot | null;
  /** Wave-2 demo hint: when present, show the「高光时刻」jump button. */
  heroEvent?: HeroEventTarget | null;
  /** 演示模式：render the minimal bar (play/pause/speed + exit) only. */
  present?: boolean;
  onEnterPresent?: () => void;
  onExitPresent?: () => void;
}

export function ControlBar({ snapshot, heroEvent = null, present = false, onEnterPresent, onExitPresent }: ControlBarProps) {
  const simulationId = useAppStore(s => s.simulationId);
  const simulationInfo = useAppStore(s => s.simulationInfo);
  const streamStatus = useAppStore(s => s.streamStatus);
  const latestEventAt = useAppStore(s => s.eventLog[0]?.at ?? null);
  const setSnapshot = useAppStore(s => s.setSnapshot);
  const setSimulationError = useAppStore(s => s.setSimulationError);
  const simulationError = useAppStore(s => s.simulationError);
  const backToDetail = useAppStore(s => s.backToDetail);
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { t } = useTranslation('sim');

  // R2-FEAT-10: the LLM chip reflects RUNTIME health, not just the sim's
  // declared creation-time mode — a dead provider used to leave the chip
  // reading「LLM: llm」forever. Public endpoint, best-effort: a failed poll
  // keeps the last posture (chip falls back to the declared mode).
  const [health, setHealth] = useState<PublicHealth | null>(null);
  useVisibleInterval(() => {
    void api
      .getPublicHealth()
      .then(setHealth)
      .catch(() => undefined);
  }, HEALTH_POLL_MS, user !== null);

  const [speed, setSpeed] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  // UX-W1: 停止确认的局部二次确认态（替代 window.confirm —— 全局
  // ConfirmDialog 由另一任务落地，本文件不引新依赖）。
  const [confirmingStop, setConfirmingStop] = useState(false);

  // T-028/EA-F03: adopt the sim's REAL pace. The local state used to be
  // seeded at 1× and only ever changed by the user, so attaching to an
  // existing sim (workbench 运行中仿真, /simulations/:id deep link, or a
  // speed set from the CLI / another browser) showed "1× 实时" while the
  // readout said ×400 — and pause+开始 silently retargeted the stale local
  // speed. Skipped while `busy` so a speed change in flight (start() doubles
  // as set-speed) is not overwritten by the previous poll's snapshot.
  const snapshotSpeed = snapshot?.speed ?? null;
  useEffect(() => {
    if (snapshotSpeed === null || busy) return;
    setSpeed(current => (current === snapshotSpeed ? current : snapshotSpeed));
  }, [snapshotSpeed, busy]);

  const state: EngineRuntimeState | null = snapshot?.state ?? null;
  const stopped = state === 'stopped';

  // Status header: a 1s wall-clock ticker keeps the activity age and the
  // quiet-period guidance live between snapshot polls.
  const consoleOpenedAtRef = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const latestDecisionAt = snapshot?.recentDecisions.length
    ? snapshot.recentDecisions[snapshot.recentDecisions.length - 1].at
    : null;
  const lastActivityAt = Math.max(
    Date.parse(latestEventAt ?? '') || 0,
    Date.parse(latestDecisionAt ?? '') || 0,
  );
  const status = deriveSimStatus({
    state,
    simTimeSec: snapshot?.simTimeSec ?? 0,
    streamStatus,
    lastActivityAt: lastActivityAt > 0 ? lastActivityAt : null,
    nextScheduledAtSec: snapshot
      ? nextScheduledEventSec(snapshot.scheduledEvents, snapshot.simTimeSec)
      : null,
    consoleOpenedAt: consoleOpenedAtRef.current,
    now,
  });

  // P4-2: triage/cache readout (null when neither feature is active).
  const llmLine = deriveLlmLine(snapshot);

  const refreshSnapshot = async (id: string) => {
    const fresh = await api.getSnapshot(id);
    setSnapshot(fresh);
  };

  // T7: remember the last attempted lifecycle action so the error banner can
  // offer a real 重试 entry instead of a dead-end red line.
  const lastActionRef = useRef<((id: string) => Promise<unknown>) | null>(null);

  const run = async (action: (id: string) => Promise<unknown>) => {
    if (!simulationId || busy) return;
    lastActionRef.current = action;
    setBusy(true);
    setSimulationError(null);
    try {
      await action(simulationId);
      await refreshSnapshot(simulationId);
    } catch (error) {
      setSimulationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryLastAction = () => {
    if (lastActionRef.current) void run(lastActionRef.current);
  };

  // R2-UX-04 入口上浮：急停过去埋在 运行→部署→安全闸 折叠区。控制台安全位
  // 给一个直发入口（仅登录用户；急停是全局真实设备闸，不随 sim 作用域）。
  // 范围说明必须诚实——只拦真实设备指令，仿真命令不受影响（R2-WONT-02）。
  const engageEstop = async () => {
    if (!(await confirm({ body: t('estop.confirmBody'), tone: 'danger' }))) return;
    try {
      await api.engageHassEstop();
      // EstopBanner 的 5s 轮询随即接管展示「已激活 + 解除」。
      pushToast(t('estop.engagedToast'), 'info');
    } catch (error) {
      pushToast(
        t('estop.failedToast', { error: error instanceof Error ? error.message : String(error) }),
        'error',
      );
    }
  };

  // T1: 停止即终态（时间轴终结、不可恢复）——误触代价高，需二次确认。
  // 局部确认态：第一次点「停止」原地展开确认行，确认/取消后复位。
  const confirmAndStop = () => {
    setConfirmingStop(false);
    void run(id => api.stopSimulation(id));
  };

  const onSpeedChange = (next: number) => {
    setSpeed(next);
    // While running, start() doubles as "set speed" (engine semantics).
    if (state === 'running') {
      void run(id => api.startSimulation(id, next));
    }
  };

  const canStart = state === 'created' || state === 'paused';
  const canPause = state === 'running';
  const canResume = state === 'paused';
  const canStep = state === 'created' || state === 'paused';
  const canStop = state !== null && !stopped;

  // Wave-2「高光时刻」: pause (when running) then step-to the hero event's
  // atSimTimeSec (CLI `sim step --to` semantics). Disabled once the sim clock
  // has passed the moment.
  const heroTargetSec = heroEvent?.atSimTimeSec ?? null;
  const heroPassed = heroTargetSec !== null && (snapshot?.simTimeSec ?? 0) >= heroTargetSec;
  const canJumpHero = heroTargetSec !== null && !heroPassed && state !== null && !stopped;

  const jumpToHero = () => {
    if (heroTargetSec === null) return;
    void run(async id => {
      // step requires created|paused — pause a running sim first.
      if (state === 'running') await api.pauseSimulation(id);
      // T-114: walk in ≤EAF_MAX_STEP_TICKS chunks — one big step --to would
      // 422 STEP_TOO_LARGE on a fresh 1× sim and abort the jump.
      await stepToInChunks(
        heroTargetSec,
        snapshot?.simTimeSec ?? 0,
        speed,
        async target => (await api.stepSimulationTo(id, target)).simTimeSec,
      );
    });
  };

  // 演示模式：只保留播放/暂停与速率的最小控制条（+ 退出入口）。
  if (present) {
    return (
      <div className="control-bar control-bar--present">
        <div className="control-bar__buttons">
          <button disabled={busy || !canStart} onClick={() => void run(id => api.startSimulation(id, speed))}>
            {t('buttons.start')}
          </button>
          <button disabled={busy || !canPause} onClick={() => void run(id => api.pauseSimulation(id))}>
            {t('buttons.pause')}
          </button>
          <button disabled={busy || !canResume} onClick={() => void run(id => api.resumeSimulation(id))}>
            {t('buttons.resume')}
          </button>
          <SpeedSelect speed={speed} disabled={busy || stopped} onChange={onSpeedChange} />
        </div>
        <span className="control-bar__simtime" title={t('simTime')}>
          {formatSimTime(snapshot?.simTimeSec ?? 0)}
        </span>
        {onExitPresent && (
          <button
            className="focus-toggle focus-toggle--active"
            title={t('present.exitTitle')}
            onClick={onExitPresent}
          >
            <Icon icon={XCircle} size={14} /> {t('present.exit')}
          </button>
        )}
        {simulationError && <span className="control-bar__error">{t('actionFailed', { error: simulationError })}</span>}
      </div>
    );
  }

  return (
    <div className="control-bar">
      <div className="control-bar__buttons">
        <button disabled={busy || !canStart} onClick={() => void run(id => api.startSimulation(id, speed))}>
          {t('buttons.start')}
        </button>
        <button disabled={busy || !canPause} onClick={() => void run(id => api.pauseSimulation(id))}>
          {t('buttons.pause')}
        </button>
        <button disabled={busy || !canResume} onClick={() => void run(id => api.resumeSimulation(id))}>
          {t('buttons.resume')}
        </button>
        <button disabled={busy || !canStep} onClick={() => void run(id => api.stepSimulation(id, 1))}>
          {t('buttons.step1')}
        </button>
        <button disabled={busy || !canStep} onClick={() => void run(id => api.stepSimulation(id, 10))}>
          {t('buttons.step10')}
        </button>
        <button
          className="danger-button"
          disabled={busy || !canStop}
          onClick={() => setConfirmingStop(true)}
        >
          {t('buttons.stop')}
        </button>
        {confirmingStop && !stopped && (
          // UX-W1 局部二次确认（原 window.confirm）：停止即终态。
          <span className="control-bar__confirm" role="alertdialog" aria-label={t('stopConfirm')}>
            <span className="control-bar__confirm-text">{t('stopConfirm')}</span>
            <button className="danger-button" disabled={busy} onClick={confirmAndStop}>
              {t('stopConfirmYes')}
            </button>
            <button className="link-button" disabled={busy} onClick={() => setConfirmingStop(false)}>
              {t('stopConfirmNo')}
            </button>
          </span>
        )}
        {heroEvent && (
          <button
            className="control-bar__hero"
            disabled={busy || !canJumpHero}
            title={
              heroPassed
                ? t('hero.passedTitle', { id: heroEvent.id, sec: heroEvent.atSimTimeSec })
                : t('hero.jumpTitle', { id: heroEvent.id, sec: heroEvent.atSimTimeSec })
            }
            onClick={jumpToHero}
          >
            <Icon icon={Sparkles} size={14} /> {t('hero.label')}
          </button>
        )}
        <SpeedSelect speed={speed} disabled={busy || stopped} onChange={onSpeedChange} />
      </div>
      <div className="control-bar__readout">
        {state !== null && (
          <span className={`state-pill state-pill--${state}`}>{t(STATE_LABEL_KEYS[state])}</span>
        )}
        {simulationInfo && (
          // R2-FEAT-10: the chip reflects RUNTIME health — declared 'llm'
          // on an unreachable backend is a loud「不可达」badge, not「llm」.
          simulationInfo.llm === 'llm' &&
          llmChipHealth(simulationInfo.llm, health?.decision.mode ?? null) === 'down' ? (
            <span
              className="badge badge--llm-down"
              title={health?.decision.unreachableDetail ?? t('llmChipDownTitle')}
            >
              {t('llmChipDown')}
            </span>
          ) : (
            <span className={`badge ${simulationInfo.llm === 'llm' ? 'badge--llm' : 'badge--rule'}`}>
              {t('llmChip', { mode: simulationInfo.llm })}
            </span>
          )
        )}
        {streamStatus !== 'idle' && (
          <span
            className={`stream-badge${streamStatus === 'down' ? ' stream-badge--down' : ''}`}
            title={t('streamTitle')}
          >
            {t(STREAM_LABEL_KEYS[streamStatus])}
          </span>
        )}
        <span className="control-bar__simtime" title={t('simTime')}>
          {formatSimTime(snapshot?.simTimeSec ?? 0)}
        </span>
        <span>×{snapshot?.speed ?? speed}</span>
        <span>{t('tick', { n: snapshot?.tickCount ?? 0 })}</span>
        {llmLine && (
          <span className="status-chip" title={t('llmLineTitle')}>
            {llmLine}
          </span>
        )}
        <span
          className={`activity-indicator activity-indicator--${status.activityTone}`}
          title={t('activity.title')}
        >
          {status.activityAgeSec === null
            ? t('activity.none')
            : t('activity.age', { sec: status.activityAgeSec })}
        </span>
        {status.guidance && (
          <span className={`status-chip status-chip--${status.guidance.tone}`}>
            {status.guidance.text}
          </span>
        )}
      </div>
      {stopped && (
        <div className="control-bar__stopped" role="status">
          {/* T1: 停止是终态——给出明确引导而不是一行小字返回链接。 */}
          <span className="control-bar__stopped-text">
            <strong>{t('stopped.title')}</strong> {t('stopped.hint')}
          </span>
          <button className="link-button" onClick={backToDetail}>
            {t('back')}
          </button>
        </div>
      )}
      {onEnterPresent && (
        <button
          className="focus-toggle"
          title={t('presentMode.title')}
          onClick={onEnterPresent}
        >
          <Icon icon={MonitorPlay} size={14} /> {t('presentMode.label')}
        </button>
      )}
      {user !== null && (
        // R2-UX-04: prominent console entry for the e-stop (was buried under
        // 运行→部署→安全闸). Scope copy stays honest — real-device gate only.
        <button
          className="estop-entry"
          title={t('estop.entryTitle')}
          onClick={() => void engageEstop()}
        >
          <Icon icon={OctagonAlert} size={14} /> {t('estop.entry')}
        </button>
      )}
      {/* T7: 错误从一行小字升级为 banner——区分「连接中断自动重试中」
          （给手动刷新快照入口）与「操作失败」（给重试/关闭入口）。 */}
      {(streamStatus === 'reconnecting' || streamStatus === 'down') && (
        <div className="error-banner error-banner--inline control-bar__banner" role="alert">
          <span>{t('errorBanner.streamDown')}</span>
          <button
            disabled={busy || !simulationId}
            onClick={() => simulationId && void refreshSnapshot(simulationId)}
          >
            {t('errorBanner.refreshSnapshot')}
          </button>
        </div>
      )}
      {simulationError && (
        <div className="error-banner error-banner--inline control-bar__banner" role="alert">
          <span>{t('actionFailed', { error: simulationError })}</span>
          <button disabled={busy} onClick={retryLastAction}>
            {t('errorBanner.retry')}
          </button>
          <button className="link-button" onClick={() => setSimulationError(null)}>
            {t('errorBanner.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
