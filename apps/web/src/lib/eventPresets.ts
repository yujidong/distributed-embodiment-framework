/**
 * eventPresets — 事件注入面板的「常用事件」快捷预设（W5）。
 *
 * 点击 chip 只预填表单（type/parameter/value/severity），不直接提交；
 * zoneId 仍由用户选择。字段语义对齐引擎
 * packages/core/src/runtime/EngineRuntime.ts 的 injectEvent：
 *
 * - occupancy：非场参数，走 setZoneOccupancy，value 必须是数值（人数）；
 * - temperature：数值写入物理场；
 * - smoke：PhysicalParameter.SMOKE 在 PhysicalEnvironment 注册为数值模型
 *   （SimpleFunctionModel，base 0，烟雾浓度），SpatialField 也按数值存储，
 *   所以这里用数值 1 而不是引擎 EVENT_TYPE_DEFAULTS 里的布尔 true
 *   （coerceEventValue 两者都接受，数值与注册模型一致）。
 */

export type EventSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface EventQuickPreset {
  /** 预填到类型输入框的引擎事件类型。 */
  type: string;
  /** chip 文案的 i18n key（eventInject.quick.* 下）。 */
  labelKey: string;
  parameter: string;
  value: number;
  severity: EventSeverity;
}

export const QUICK_EVENT_PRESETS: readonly EventQuickPreset[] = [
  { type: 'person-enter', labelKey: 'personEnter', parameter: 'occupancy', value: 20, severity: 'low' },
  { type: 'temperature-spike', labelKey: 'temperatureHigh', parameter: 'temperature', value: 34, severity: 'high' },
  { type: 'temperature-normal', labelKey: 'temperatureRecover', parameter: 'temperature', value: 24, severity: 'medium' },
  { type: 'smoke-detected', labelKey: 'smokeAlarm', parameter: 'smoke', value: 1, severity: 'critical' },
];
