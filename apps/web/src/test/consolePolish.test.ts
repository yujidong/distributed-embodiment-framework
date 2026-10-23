/**
 * UX-R2 console polish (persona 流水线 R2 批次 7) — lib 纯函数套件：
 *
 * - lib/deviceDisplay（PM 补充）：命令显示名映射（常见命令中文名 + 原命令
 *   副标；未知命令不编造标签）与设备状态键值友好渲染
 *   （开 · 亮度 80 · 温度 22.5°C；未知键兜底原文）；
 * - lib/llmWarning（R2-UX-05）：server 硬编码英文 llmWarning 的四个已知
 *   模板映射到本地文案，未知模板回落原文；
 * - lib/llmHealth（R2-FEAT-10）：LLM 徽标运行时健康推导；
 * - lib/demoPlaylist.demoPlayableState（R2-UX-08）：不可播放三态
 *   （无剧本/太短/已过）；
 * - R2-UX-11：core 在 reasoningParams 带 context:'none' 时 i18next 命中
 *   `_none` 模板（空括号「（）」修复的端到端一半）。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import { commandDisplay, formatDeviceState } from '../lib/deviceDisplay';
import { demoPlayableState, MIN_DEMO_SCENES, type DemoScene } from '../lib/demoPlaylist';
import { llmChipHealth } from '../lib/llmHealth';
import { localizedLlmWarning } from '../lib/llmWarning';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('commandDisplay (lib/deviceDisplay)', () => {
  it('maps common commands to a friendly label and keeps the raw token', () => {
    expect(commandDisplay('turn-on')).toEqual({ label: '开启', raw: 'turn-on', known: true });
    expect(commandDisplay('set-temperature')).toEqual({
      label: '设定温度',
      raw: 'set-temperature',
      known: true,
    });
  });

  it('unknown commands render the raw token only (no invented label)', () => {
    expect(commandDisplay('set-flux-capacitor')).toEqual({
      label: 'set-flux-capacitor',
      raw: 'set-flux-capacitor',
      known: false,
    });
  });

  it('localizes with the active language (en-US)', async () => {
    await i18n.changeLanguage('en-US');
    expect(commandDisplay('turn-off').label).toBe('Turn off');
  });
});

describe('formatDeviceState (lib/deviceDisplay)', () => {
  it('renders the PM example shape: 开 · 亮度 80 · 温度 22.5°C', () => {
    expect(formatDeviceState({ power: 'on', brightness: 80, temperature: 22.5 })).toBe(
      '开 · 亮度 80 · 温度 22.5°C',
    );
  });

  it('booleans get semantic wording per key family (presence/lock/charging)', () => {
    expect(formatDeviceState({ power: false })).toBe('关');
    expect(formatDeviceState({ smoke: true })).toBe('烟雾 有');
    expect(formatDeviceState({ locked: true })).toBe('门锁 已锁定');
    expect(formatDeviceState({ charging: false })).toBe('充电 未充电');
  });

  it('unknown keys fall back to the raw key name (nothing silently dropped)', () => {
    expect(formatDeviceState({ power: 'off', fluxCapacitor: 1.21 })).toBe('关 · fluxCapacitor 1.21');
  });

  it('non-object states fall back to compact JSON; long states truncate', () => {
    expect(formatDeviceState('online')).toBe('"online"');
    const many = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`k${i}`, i]),
    );
    const text = formatDeviceState(many);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('k5');
  });

  it('skips identity keys (zoneId/status) — the sheet header shows those', () => {
    expect(
      formatDeviceState({ zoneId: 'hall', status: 'active', power: 'on', temperature: 22.5 }),
    ).toBe('开 · 温度 22.5°C');
  });
});

describe('localizedLlmWarning (R2-UX-05)', () => {
  it('maps each known server template to localized copy', () => {
    const cases: Array<[string, string]> = [
      [
        'LLM preset "llm" was requested but LLM_BASE_URL is not configured on this server — running rule-only …',
        '请求了 LLM 模式',
      ],
      [
        'Agents in this world use LLM decisions (declared or by default) but LLM_BASE_URL is not configured on this server — running rule-only …',
        '未配置 LLM_BASE_URL',
      ],
      [
        'This environment has no agents — nothing can make LLM decisions; running rule-only.',
        '没有 Agent',
      ],
      [
        'This environment runs rule-only: every agent explicitly opts out of LLM decisions (llm: null) — …',
        '显式关闭了 LLM 决策',
      ],
      [
        'The LLM backend is configured but no model is set — set LLM_MODEL …',
        '未设置模型',
      ],
    ];
    for (const [warning, marker] of cases) {
      const localized = localizedLlmWarning(warning);
      expect(localized).toContain(marker);
      expect(localized).not.toBe(warning);
    }
  });

  it('unknown templates fall back to the raw text verbatim', () => {
    expect(localizedLlmWarning('Something entirely new from a future server')).toBe(
      'Something entirely new from a future server',
    );
  });
});

describe('llmChipHealth (R2-FEAT-10)', () => {
  it('declared llm on an unreachable backend is DOWN (loud chip)', () => {
    expect(llmChipHealth('llm', 'llm-unreachable')).toBe('down');
  });

  it('healthy and unknown postures keep the declared chip', () => {
    expect(llmChipHealth('llm', 'llm')).toBe('healthy');
    expect(llmChipHealth('llm', null)).toBe('unknown');
    expect(llmChipHealth('rule-only', 'llm-unreachable')).toBe('healthy');
    expect(llmChipHealth('rule-only', 'rule-test')).toBe('healthy');
  });
});

describe('demoPlayableState (R2-UX-08)', () => {
  const scenes: DemoScene[] = [
    { id: 'e1', type: 'temperature-spike', zoneId: 'z', atSimTimeSec: 60 },
    { id: 'e2', type: 'smoke-detected', zoneId: 'z', atSimTimeSec: 120 },
    { id: 'e3', type: 'temperature-normal', zoneId: 'z', atSimTimeSec: 300 },
  ];

  it('splits the unplayable states: none / tooShort / elapsed', () => {
    expect(demoPlayableState([], 0)).toBe('none');
    expect(demoPlayableState(scenes.slice(0, MIN_DEMO_SCENES - 1), 0)).toBe('tooShort');
    expect(demoPlayableState(scenes, 300)).toBe('elapsed');
    expect(demoPlayableState(scenes, undefined)).toBe('elapsed');
    expect(demoPlayableState(scenes, 0)).toBe('playable');
  });
});

describe('R2-UX-11: context:none hits the _none reasoning template', () => {
  it('precheck.independent with context renders no empty parens (zh)', () => {
    const text = i18n.t('decisionReasoning:precheck.independent', {
      zone: 'region-1',
      required: '',
      context: 'none',
    });
    expect(text).toContain('无额外能力要求');
    expect(text).not.toContain('（）');
  });

  it('rule.independent with context renders no empty parens (zh)', () => {
    const text = i18n.t('decisionReasoning:rule.independent', {
      required: '',
      missing: '',
      context: 'none',
    });
    expect(text).toContain('无额外能力要求');
    expect(text).not.toContain('（）');
  });

  it('the base template still renders when requirements exist', () => {
    const text = i18n.t('decisionReasoning:precheck.independent', {
      zone: 'region-1',
      required: 'temperature-control',
    });
    expect(text).toContain('temperature-control');
  });

  it('en-US mirrors the _none templates', async () => {
    await i18n.changeLanguage('en-US');
    const text = i18n.t('decisionReasoning:precheck.independent', {
      zone: 'region-1',
      required: '',
      context: 'none',
    });
    expect(text).toContain('no specific capabilities');
    expect(text).not.toContain('()');
  });
});
