/**
 * NL response generator — Phase 3 of the agent cognitive architecture
 * (design §5.5 explanation generation, §6.2 NL output).
 *
 * Renders human-readable responses FROM structured data only (the
 * single-truth principle: the NL product is a projection of the
 * CognitiveDecision + execution result, never an independent generation —
 * what the decision record says and what the operator reads can never
 * diverge).
 *
 * Template-first (design Phase 3: "v1 模板优先——零成本、确定性"): every
 * common pattern is a deterministic template, so identical inputs yield
 * byte-identical responses (snapshot-testable, training-export consumable).
 * An optional `polishWithLLM` seam lets callers upgrade the final wording
 * through an LLM without ever changing the facts (complex explanations);
 * when it is absent or fails, the template output stands unchanged.
 *
 * Pure module: no IO, no clock (LLM polish arrives as an injected async
 * function). Never throws.
 */

import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import { truncateForStorage } from '../utils/truncate.js';
import { unitOf } from '@active-collaboration/shared';
import type {
  NLAskData,
  NLCommandContradiction,
  NLCommandIntent,
  NLDeviceView,
  NLExecutedAction,
  NLExecutionResult,
  NLZoneView,
} from './types.js';

// ============================================================================
// Formatting helpers
// ============================================================================

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value);
}

/**
 * T66j (R6, u4-F10): status-template readings carry the platform unit
 * (shared PARAM_UNITS — one source with snapshot/ask/read faces). Booleans
 * and strings stay bare; an unknown parameter renders bare (never an
 * invented unit).
 */
function formatReading(key: string, value: unknown): string {
  const unit = typeof value === 'number' ? unitOf(key) : null;
  return `${key} ${formatValue(value)}${unit !== null ? ` ${unit}` : ''}`;
}

function formatParams(params: Record<string, unknown> | undefined): string {
  if (params === undefined || Object.keys(params).length === 0) return '';
  const body = Object.entries(params)
    .map(([key, value]) => {
      const unit =
        /temperature|setpoint/i.test(key) && typeof value === 'number' ? '°C'
        : /humidity|brightness|power/i.test(key) && typeof value === 'number' ? '%'
        : '';
      return `${key} ${formatValue(value)}${unit}`;
    })
    .join(', ');
  return ` (${body})`;
}

function zoneList(zones: readonly string[]): string {
  return zones.length > 0 ? zones.join(', ') : 'no specific zone';
}

function capSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Deterministic template rendering of the main response. */

// ============================================================================
// Locale (D2-F3): the template lines follow the OPERATOR's language.
// ============================================================================

export type NLResponseLocale = 'zh' | 'en';

/** Detect the operator's language from their raw command (CJK-ratio heuristic). */
export function detectUserLocale(text: string): NLResponseLocale {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return cjk >= Math.max(1, Math.floor(text.length * 0.15)) ? 'zh' : 'en';
}

/** Template strings per locale. Facts (device ids/numbers) are interpolated. */
const STRINGS: Record<NLResponseLocale, Record<string, string>> = {
  en: {
    anomaly: 'I see an anomaly',
    emergency: 'This is an emergency',
    opportunity: 'I see an opportunity',
    inZone: ' in {zones}',
    donePrefix: "I've",
    issuedUnverified: "I've issued (NOT verified — {verdict}):",
    verificationLine: 'Verification: {verdict}{explanation}.',
    triedFailed: 'I tried to act on my devices but every command failed',
    plannedNothing: 'I planned device adjustments ({detail}) but nothing executed.',
    handlingSelf: "I'm handling this myself.",
    initiateAc: "I can't handle this alone — I'm initiating a collaboration with other agents.",
    needPartners: 'I need partners with: {caps}.',
    invokeFlowStarted: 'I started the "{flow}" procedure{params} — run {runId} finished with status {runStatus}.',
    invokeFlowRefused: 'I could not start the "{flow}" procedure — {reason}.',
    invokeFlowNoLane: 'I chose the "{flow}" procedure for this{params} — but no flow-invocation lane is wired here, so nothing was executed.',
    defer: "I'm deferring action for now.",
    escalate: "This is beyond what I can safely do on my own — I've escalated it to the owner.",
    wait: "I'm monitoring the situation for now.",
    refused: 'Some intended actions were refused: {reasons}.',
    clamped: 'Values adjusted into device-safe ranges: {items}.',
    escalatePromise: "If things get worse, I'll escalate to your owner.",
    fallbackDefault: 'Understood — no action was needed.',
    statusPrefix: 'Current state —',
    noReadings: 'I have no zones with readings in my view yet.',
    otherParams: ' (else: {rest})',
    truncatedParams: ' (+{count} more parameters not listed — name one to ask)',
    zoneCandidates: 'Closest zones to your mention: {candidates}.',
    actuators: 'My actuators: {devices}.',
    offlineNote: '(offline devices: {devices})',
    devicesLine: 'My devices: {devices}.',
    onlineState: 'online',
    offlineState: 'offline',
    askFallback: "I don't have the data to answer that yet.",
    situationRead: 'My read of the current situation: {type} (severity {severity}/5).',
  },
  zh: {
    anomaly: '我发现一处异常',
    emergency: '这是紧急情况',
    opportunity: '我发现一个机会',
    inZone: '（区域：{zones}）',
    donePrefix: '我已完成：',
    issuedUnverified: '我已下发（未经核验——{verdict}）：',
    verificationLine: '核验结论：{verdict}{explanation}。',
    triedFailed: '我尝试操作我的设备但每条命令都失败了',
    plannedNothing: '我计划了设备调整（{detail}），但没有执行任何一条。',
    handlingSelf: '我会自行处理。',
    initiateAc: '这超出了我单独处理的能力——我正在发起与其他智能体的协作。',
    needPartners: '我需要具备以下能力的伙伴：{caps}。',
    invokeFlowStarted: '我已启动流程「{flow}」{params}——运行 {runId} 以状态 {runStatus} 结束。',
    invokeFlowRefused: '我无法启动流程「{flow}」——{reason}。',
    invokeFlowNoLane: '我为这件事选择了流程「{flow}」{params}——但此处没有接线流程调用通道，因此没有执行任何操作。',
    defer: '我暂时先不动作。',
    escalate: '这超出了我能安全独立处理的范围——我已升级给所有者。',
    wait: '我正在持续观察局势。',
    refused: '部分计划操作被拒绝：{reasons}。',
    clamped: '数值已调整到设备安全范围内：{items}。',
    escalatePromise: '如果情况恶化，我会升级给你的所有者。',
    fallbackDefault: '收到——无需动作。',
    statusPrefix: '当前状态——',
    noReadings: '我管辖的区域暂时还没有读数。',
    otherParams: '（其余：{rest}）',
    truncatedParams: '（另有 {count} 项参数未列出，可指名问询）',
    zoneCandidates: '与你提到的名称最接近的分区：{candidates}。',
    actuators: '我可操作的设备：{devices}。',
    offlineNote: '（离线设备：{devices}）',
    devicesLine: '我的设备：{devices}。',
    onlineState: '在线',
    offlineState: '离线',
    askFallback: '我暂时没有能回答这个问题的数据。',
    situationRead: '我对当前态势的判断：{type}（严重度 {severity}/5）。',
  },
};

function t(key: string, locale: NLResponseLocale): string {
  return STRINGS[locale][key] ?? STRINGS.en[key] ?? key;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}

export function renderTemplateNLResponse(
  decision: CognitiveDecision,
  execution: NLExecutionResult,
  options: { locale?: NLResponseLocale } = {},
): string {
  const locale = options.locale ?? 'en';
  const T = (key: string): string => t(key, locale);
  const parts: string[] = [];

  // 1. Situation line — what the agent saw (from the structured assessment).
  const situation = decision.situation;
  if (situation.type === 'anomaly' || situation.type === 'emergency') {
    const zones = fill(T('inZone'), { zones: situation.affectedZones.join(', ') });
    parts.push(
      locale === 'zh'
        ? `${situation.type === 'emergency' ? T('emergency') : T('anomaly')}${zones}（严重度 ${situation.severity}/5）。`
        : `I detected ${situation.type === 'emergency' ? 'an EMERGENCY' : 'an anomaly'}${zones} ` +
          `(severity ${situation.severity}/5).`,
    );
    if (situation.rootCauseHypothesis.length > 0) {
      parts.push(locale === 'zh'
        ? `可能原因：${situation.rootCauseHypothesis}。`
        : `Likely cause: ${situation.rootCauseHypothesis}.`);
    }
  } else if (situation.type === 'opportunity') {
    const zones = fill(T('inZone'), { zones: situation.affectedZones.join(', ') });
    parts.push(`${T('opportunity')}${zones}${locale === 'zh' ? '。' : '.'}`);
  }

  // 2. Action line — what the agent did (or decided to do).
  const primary = decision.actionPlan.primary;
  const succeeded = execution.actions.filter(a => a.success);
  const failed = execution.actions.filter(a => a.success !== true);
  // R51: operator-facing label — the device NAME when the action carried
  // one, a shortened id otherwise; never a full UUID in a reply line.
  const actionLabel = (a: { deviceId: string; deviceName?: string }): string =>
    a.deviceName !== undefined && a.deviceName.length > 0
      ? a.deviceName
      : a.deviceId.length > 12 ? `${a.deviceId.slice(0, 8)}…` : a.deviceId;
  switch (primary.action) {
    case 'handle_independently': {
      if (succeeded.length > 0) {
        const described = succeeded
          .map(a => locale === 'zh'
            ? `将${actionLabel(a)} 设为 ${a.command}${formatParams(a.params)}`
            : `set ${actionLabel(a)} to ${a.command}${formatParams(a.params)}`)
          .join(locale === 'zh' ? '；' : '; ');
        // R103 (zhao-24): the conclusion line follows the VERIFICATION — an
        // unverified/inconclusive batch is never reported as "已完成" (the
        // old reply claimed done with ✓ while its own verification line said
        // UNVERIFIED — two contradictory statements in one reply).
        const verdict = execution.verification?.verdict;
        if (verdict === 'unverified' || verdict === 'inconclusive') {
          parts.push(`${fill(T('issuedUnverified'), { verdict })} ${described}${locale === 'zh' ? '。' : '.'}`);
        } else {
          parts.push(`${T('donePrefix')} ${described}${locale === 'zh' ? '。' : '.'}`);
        }
      } else if (failed.length > 0) {
        const failDetail = failed.map(f => `${actionLabel(f)}: ${f.error ?? 'unknown error'}`).join('; ');
        parts.push(locale === 'zh'
          ? `${T('triedFailed')}（${failDetail}）。`
          : `${T('triedFailed')} (${failDetail}).`);
      } else if (primary.deviceActions !== undefined && primary.deviceActions.length > 0) {
        const planDetail = primary.deviceActions.map(a => `${a.deviceId} ${a.command}`).join(', ');
        parts.push(fill(T('plannedNothing'), { detail: planDetail }));
      } else {
        parts.push(T('handlingSelf'));
      }
      break;
    }
    case 'initiate_ac':
      parts.push(T('initiateAc'));
      if (primary.collaboration?.partnerCapabilities.length !== undefined
        && primary.collaboration.partnerCapabilities.length > 0) {
        parts.push(fill(T('needPartners'), { caps: primary.collaboration.partnerCapabilities.join(', ') }));
      }
      break;
    case 'invoke_flow': {
      // R6-E-F09: the NL lane REALLY invokes flows through the governed
      // runAsAgent lane — the reply mirrors the recorded outcome: started
      // (run id + status), or refused with the gate's teaching reason (a
      // hallucinated flowId is spelled out as such, never as a "match").
      const params = primary.flowParams !== undefined && Object.keys(primary.flowParams).length > 0
        ? ` (${JSON.stringify(primary.flowParams)})`
        : '';
      const invocation = execution.flowInvocation;
      if (invocation?.status === 'invoked') {
        parts.push(fill(T('invokeFlowStarted'), {
          flow: invocation.flowId,
          params,
          runId: invocation.runId ?? 'unknown',
          runStatus: invocation.runStatus ?? 'unknown',
        }));
      } else if (invocation !== undefined) {
        parts.push(fill(T('invokeFlowRefused'), {
          flow: invocation.flowId,
          reason: invocation.reason ?? 'unknown reason',
        }));
      } else {
        parts.push(fill(T('invokeFlowNoLane'), { flow: primary.flowId ?? 'unknown', params }));
      }
      break;
    }
    case 'defer':
      parts.push(T('defer'));
      break;
    case 'escalate':
      parts.push(T('escalate'));
      break;
    case 'wait':
      parts.push(T('wait'));
      break;
  }

  // 3. Bridge honesty — rejections and clamps are always spoken, never hidden.
  if (execution.rejected !== undefined && execution.rejected.length > 0) {
    parts.push(fill(T('refused'), { reasons: execution.rejected.map(r => r.reason).join(' | ') }));
  }
  if (execution.clamped !== undefined && execution.clamped.length > 0) {
    parts.push(fill(T('clamped'), { items: execution.clamped.join('; ') }));
  }

  // 3b. R103 (zhao-24): the verification verdict is spoken whenever it is
  // NOT a plain improvement — the conclusion line and the verdict can never
  // diverge inside one reply (self-report == verification, pinned by test).
  if (execution.verification !== undefined && execution.verification.verdict !== 'improvement') {
    const explanation = (execution.verification.explanation ?? '').replace(/\s+/g, ' ').trim();
    parts.push(fill(T('verificationLine'), {
      verdict: execution.verification.verdict,
      explanation: explanation.length > 0
        ? `${locale === 'zh' ? '——' : ' — '}${explanation.slice(0, 160)}${explanation.length > 160 ? '…' : ''}`
        : '',
    }));
  }

  // 4. Escalation condition — the conditional promise.
  if (decision.actionPlan.escalationCondition !== undefined
    && decision.actionPlan.escalationCondition.length > 0) {
    // D2-F3: the RAW escalationCondition is model-internal calibration
    // talk — the machine channel keeps the exact condition; the operator
    // gets the plain-language promise.
    parts.push(T('escalatePromise'));
  }

  // 5. Explanation fallback — when no template above spoke to the "why".
  if (parts.length === 0 && decision.explanation.summary.length > 0) {
    parts.push(capSentence(decision.explanation.summary));
  } else if (decision.explanation.summary.length > 0
    && primary.action !== 'handle_independently'
    && situation.type === 'normal'
    && parts.length === 0) {
    parts.push(capSentence(decision.explanation.summary));
  }

  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 0 ? joined : T('fallbackDefault');
}

// ============================================================================
// LLM polish (optional upgrade, never a fact source)
// ============================================================================

const POLISH_INSTRUCTION =
  'Rewrite the agent response so a human operator reads it naturally. Keep EVERY fact, number, device id and promise EXACTLY as given — you may reword, never add, drop or change anything. Answer with the rewritten text only.';

/** Polish the template response through an LLM; facts are frozen. */
export async function generateNLResponse(
  decision: CognitiveDecision,
  executionResult: NLExecutionResult,
  options: {
    polishWithLLM?: (prompt: string, template: string) => Promise<string>;
    locale?: NLResponseLocale;
  } = {},
): Promise<string> {
  const template = renderTemplateNLResponse(decision, executionResult, {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
  });
  if (options.polishWithLLM === undefined) return template;
  try {
    const polished = await options.polishWithLLM(POLISH_INSTRUCTION, template);
    if (typeof polished === 'string' && polished.trim().length > 0) {
      return truncateForStorage(polished.trim()) ?? template;
    }
    return template;
  } catch {
    return template; // polish is best-effort — the template always stands
  }
}

// ============================================================================
// Help + status responses (no decision object exists for these lanes)
// ============================================================================

/** The help text rendered from the agent's ACTUAL capability surface. */
export function generateHelpResponse(input: {
  agentName: string;
  devices: readonly NLDeviceView[];
  zones: readonly NLZoneView[];
}): string {
  const deviceLine = input.devices.length > 0
    ? input.devices.map(d => `${d.deviceId} (${d.type}${d.online ? '' : ', offline'})`).join(', ')
    : 'none';
  const zoneLine = input.zones.length > 0 ? input.zones.map(z => z.zoneId).join(', ') : 'none';
  return (
    `I'm ${input.agentName}. Talk to me in plain language — for example: ` +
    '"make the lobby comfortable", "set the office temperature to 22", ' +
    '"what\'s the status of zone A", "run the morning-prep flow". ' +
    `My devices: ${deviceLine}. My zones: ${zoneLine}. ` +
    'In an emergency (fire, evacuate) I escalate to the owner immediately.'
  );
}

/**
 * Operator-facing device label: the human name when present, the id only as a
 * disambiguator (raw UUIDs are unreadable — R47 gap).
 */
function deviceLabel(device: { deviceId: string; name?: string }): string {
  if (device.name !== undefined && device.name.length > 0) return device.name;
  return device.deviceId.length > 12 ? `${device.deviceId.slice(0, 8)}…` : device.deviceId;
}

/**
 * T10 (R2, u2-F4): fold a parameter key for FOCUS matching — case and
 * separator insensitive, so the ask's spelling 「pm25」 matches the
 * parameter key `pm2_5` (both fold to `pm25`). Exact folded equality only —
 * never a substring match, so `co2` cannot swallow `co2_baseline`.
 */
function foldParamKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The status answer rendered from the live zone/device view. */
export function generateStatusResponse(input: {
  /** Minimal device view — identity + online state; commands filter the actuator line. */
  devices: ReadonlyArray<{ deviceId: string; name?: string; online: boolean; commands?: readonly string[] }>;
  zones: readonly NLZoneView[];
  targetZones?: readonly string[];
  /**
   * R99: parameters the question actually asked about — the zone line LEADS
   * with these and collapses everything else into one short trailing clause
   * (a single-parameter question must not dump the full parameter list).
   */
  focusParameters?: readonly string[];
  /**
   * T10 (R2, u3-F5): closest zones for a mention that missed every matcher
   * threshold — rendered as a teaching tail so a missed shorthand ("B栋1F")
   * never silently dumps the whole jurisdiction.
   */
  zoneCandidates?: ReadonlyArray<{ zoneId: string; name?: string }>;
  /** Operator language (detectUserLocale of the raw question); en default. */
  locale?: NLResponseLocale;
}): string {
  const locale = input.locale ?? 'en';
  const focus = new Set((input.focusParameters ?? []).map(foldParamKey));
  const wanted = input.targetZones !== undefined && input.targetZones.length > 0
    ? input.zones.filter(z => input.targetZones!.includes(z.zoneId))
    : input.zones;
  const lines: string[] = [];
  if (wanted.length > 0) {
    for (const zone of wanted.slice(0, 8)) {
      const entries = Object.entries(zone.parameters ?? {});
      // T10: focus matching folds case/underscores (pm25 ↔ pm2_5) — a
      // focused hit renders ALL matched parameters (never truncated).
      const focused = focus.size > 0
        ? entries.filter(([key]) => focus.has(foldParamKey(key)))
        : [];
      const listed = focused.length > 0 ? focused : entries.slice(0, 6);
      const head = listed
        .map(([key, value]) => formatReading(key, value))
        .join(', ');
      let tail = '';
      if (focused.length > 0) {
        const rest = entries.filter(([key]) => !focus.has(foldParamKey(key)));
        tail = rest.length > 0
          ? fill(t('otherParams', locale), {
              rest: rest.slice(0, 3).map(([key, value]) => formatReading(key, value)).join(', ') +
                (rest.length > 3 ? ' …' : ''),
            })
          : '';
      } else if (entries.length > listed.length) {
        // T10: the non-focused truncation is EXPLICIT — the answer says how
        // many parameters it left out instead of silently dropping them
        // (探针未覆盖 ≠ 探针无发现, the same honesty shape as the ask lane).
        tail = fill(t('truncatedParams', locale), { count: String(entries.length - listed.length) });
      }
      const params = head.length > 0
        ? head + tail
        : locale === 'zh' ? '暂无读数' : 'no readings yet';
      lines.push(`${zone.name !== undefined && zone.name.length > 0 ? `${zone.name} (${zone.zoneId})` : zone.zoneId}: ${params}`);
    }
  } else {
    lines.push(t('noReadings', locale));
  }
  const devicesWithCommands = input.devices.filter(d => (d.commands?.length ?? 0) > 0);
  if (devicesWithCommands.length > 0) {
    lines.push(fill(t('actuators', locale), {
      devices: devicesWithCommands.map(d => `${deviceLabel(d)}${d.online ? '' : ` (${t('offlineState', locale)})`}`).join(', '),
    }));
  }
  const offline = input.devices.filter(d => d.online !== true);
  if (offline.length > 0 && devicesWithCommands.every(d => d.online)) {
    lines.push(fill(t('offlineNote', locale), { devices: offline.map(deviceLabel).join(', ') }));
  }
  const candidates = input.zoneCandidates ?? [];
  if (candidates.length > 0) {
    lines.push(fill(t('zoneCandidates', locale), {
      candidates: candidates
        .map(z => (z.name !== undefined && z.name.length > 0 ? `${z.name} (${z.zoneId})` : z.zoneId))
        .join(locale === 'zh' ? '、' : ', '),
    }));
  }
  return `${t('statusPrefix', locale)} ${lines.join(' ')}`;
}

/** The /ask answer rendered from the structured ask data. */
export function generateAskResponse(data: NLAskData, locale: NLResponseLocale = 'en'): string {
  if (data.zones !== undefined && data.zones.length > 0) {
    return generateStatusResponse({
      zones: data.zones.map(z => ({
        zoneId: z.zoneId,
        ...(z.name !== undefined ? { name: z.name } : {}),
        parameters: z.parameters,
      })),
      devices: (data.devices ?? []).map(d => ({
        deviceId: d.deviceId,
        ...(d.name !== undefined ? { name: d.name } : {}),
        online: d.online,
      })),
      locale,
    });
  }
  if (data.assessment !== undefined) {
    const situation = data.assessment.situation;
    const summary = data.assessment.explanation.summary.length > 0
      ? data.assessment.explanation.summary
      : data.assessment.actionPlan.primary.reasoning;
    return capSentence(
      `${fill(t('situationRead', locale), { type: situation.type, severity: String(situation.severity) })} ` +
      `${summary}.`,
    );
  }
  if (data.devices !== undefined && data.devices.length > 0) {
    return fill(t('devicesLine', locale), {
      devices: data.devices.map(d => `${deviceLabel(d)} (${d.online ? t('onlineState', locale) : t('offlineState', locale)})`).join(', '),
    });
  }
  return t('askFallback', locale);
}

/**
 * R103 (zhao-24): the contradiction declaration — prepended to the final
 * response AFTER any LLM polish, so the one fact polish may never reword
 * (a conflict was detected, the conflicting parts did NOT run) always
 * reaches the operator verbatim.
 */
export function renderContradictionDeclaration(
  contradictions: readonly NLCommandContradiction[],
  locale: NLResponseLocale,
): string {
  const parts = [...new Set(contradictions.map(c => c.kind))].map(kind =>
    kind === 'parameter-hold'
      ? (locale === 'zh' ? '「设定目标值」与「保持不变」相互冲突' : 'set-to-value conflicts with keep-unchanged')
      : (locale === 'zh' ? '「打开/关闭」与「保持原状」相互冲突' : 'toggle conflicts with keep-in-current-state'));
  return locale === 'zh'
    ? `⚠ 指令存在矛盾：${parts.join('；')}——冲突的部分我没有执行，请明确要哪一个后重新下达。`
    : `⚠ The command contradicts itself: ${parts.join('; ')} — I did NOT execute the conflicting parts; please clarify and reissue.`;
}

/** Render the emergency-lane response (used before any decision exists). */export function generateEmergencyResponse(intent: NLCommandIntent): string {
  const zones = intent.targetZones !== undefined && intent.targetZones.length > 0
    ? ` in ${zoneList(intent.targetZones)}`
    : '';
  return (
    `EMERGENCY acknowledged${zones} — I have skipped normal decision-making and escalated ` +
    'to the environment owner immediately. No device actions were taken by me; ' +
    'follow your site emergency procedure first.'
  );
}

/** Format one executed action for logs/CLI tables. */
export function formatExecutedAction(action: NLExecutedAction): string {
  const label = action.deviceName !== undefined && action.deviceName.length > 0
    ? `${action.deviceName} (${action.deviceId.slice(0, 8)})`
    : action.deviceId;
  return `${label} ${action.command}${formatParams(action.params)} → ${action.success ? 'ok' : `FAILED (${action.error ?? 'unknown error'})`}`;
}
