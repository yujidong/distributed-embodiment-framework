/**
 * R2-UX-06 — 事件注入「常用事件」chip 选中回映射：
 *
 * type 命中下拉 PRESETS 的 chip（如 smoke-detected）点击后下拉显示选中的
 * 预置项，而不是一律落「自定义…」；下拉没有的 type（person-enter 等）
 * 才走自定义输入框。参数/数值/严重度仍由 chip 预填且可编辑。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScenarioDefinition } from '../api/types';
import { EventInjectPanel } from '../components/EventInjectPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';

const SCENARIO = {
  zones: [{ id: 'zone-1', name: '一区' }],
  events: [],
} as unknown as ScenarioDefinition;

function typeSelect(): HTMLSelectElement {
  return screen.getByLabelText('类型') as HTMLSelectElement;
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  useAppStore.setState({ simulationId: 'sim-1', snapshot: null });
});

afterEach(cleanup);

describe('EventInjectPanel quick chips (R2-UX-06)', () => {
  it('a chip whose type exists in the dropdown selects that preset (not 自定义)', () => {
    render(<EventInjectPanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByRole('button', { name: '浓烟告警' }));
    // smoke-detected is PRESETS[3] — the dropdown shows it selected…
    expect(typeSelect().value).toBe('3');
    // …the custom input stays hidden…
    expect(screen.queryByLabelText('自定义类型')).toBeNull();
    // …and the chip's own parameter/value still prefill (editable).
    expect((screen.getByLabelText('参数') as HTMLInputElement).value).toBe('smoke');
    expect((screen.getByLabelText('数值') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('严重度') as HTMLSelectElement).value).toBe('critical');
  });

  it('a chip whose type is NOT in the dropdown falls back to 自定义', () => {
    render(<EventInjectPanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByRole('button', { name: '人员进入' }));
    expect(typeSelect().value).toBe('-1');
    expect((screen.getByLabelText('自定义类型') as HTMLInputElement).value).toBe('person-enter');
  });

  it('a dropdown-known chip keeps its own (possibly divergent) value', () => {
    render(<EventInjectPanel scenario={SCENARIO} />);
    // temperature-spike: dropdown preset value 32, quick chip value 34 —
    // the chip's script wins (the field stays editable afterwards).
    fireEvent.click(screen.getByRole('button', { name: '温度越限' }));
    expect(typeSelect().value).toBe('0');
    expect((screen.getByLabelText('数值') as HTMLInputElement).value).toBe('34');
  });
});
