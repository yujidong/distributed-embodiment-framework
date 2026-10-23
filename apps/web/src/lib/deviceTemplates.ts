/**
 * UX-W3 device-template catalog helpers — filtering / grouping / fallback for
 * the GET /api/device-templates surface (DeviceForm suggestions, CatalogPanel
 * type filter, the interior-walk deploy palette).
 *
 * Honest degradation: when the API is unreachable the callers fall back to
 * FALLBACK_DEVICE_TEMPLATES (a small static wordlist mirroring the starter
 * palette) and mark the UI degraded instead of pretending the full catalog
 * loaded.
 */

import type { DeviceTemplate } from '../api/types';
import type { DeployKind } from '../components/interior/types';
import { DEPLOY_TYPES } from './interior3d/deployCatalog';

/**
 * Static fallback wordlist (the pre-UX-W3 deploy palette, DEPLOY_TYPES) —
 * used only when GET /api/device-templates fails. One source of truth: the
 * palette entries are re-shaped into the DeviceTemplate form here.
 */
export const FALLBACK_DEVICE_TEMPLATES: DeviceTemplate[] = DEPLOY_TYPES.map(kind => ({
  id: kind.type,
  name: kind.name,
  type: kind.type,
  description: kind.name,
  capabilities: [...kind.capabilities],
  defaultBehaviors: [],
}));

/** 中文常用词 → 英文模板关键词（注册表 73 项全英文命名，zh-CN UI 下搜
 *  中文应命中——ux-w3 探针 P2）。命中时把英文关键词并入查询词。
 *  R2（商场#4）：别名改多词产出——「客流」曾错指 occupancy 族，而
 *  people-counter / crowd-monitor 都不含 occupancy 子串搜不到；客流/人流
 *  改指 people/crowd 族。 */
const ZH_QUERY_ALIASES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/烟感|烟雾|烟火/, ['smoke']],
  [/温湿度|温度/, ['temperature']],
  [/湿度/, ['humidity']],
  [/照明|灯/, ['light']],
  [/空调|暖通/, ['hvac']],
  [/新风|通风|排风/, ['ventil']],
  [/门禁|门锁/, ['lock']],
  [/摄像头|摄像|监控/, ['camera']],
  [/电表|能耗|计量/, ['meter']],
  [/充电桩?/, ['charg']],
  [/喷淋|灭火|消防/, ['sprinkler']],
  [/水泵|排水/, ['pump']],
  [/空气净化|空气/, ['air']],
  [/客流|人流/, ['people', 'crowd']],
  [/人数|占位/, ['occupancy', 'people']],
  [/广播|音箱|扬声/, ['speaker']],
  [/窗帘|遮阳/, ['curtain']],
  [/电梯/, ['elevator']],
  [/机器人/, ['robot']],
  [/风扇|风机/, ['fan']],
  [/投影/, ['projector']],
];

/** Case-insensitive substring match over id / name / type / category / capabilities. */
export function filterDeviceTemplates(
  templates: readonly DeviceTemplate[],
  query: string,
): DeviceTemplate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...templates];
  const terms = [q, ...ZH_QUERY_ALIASES.filter(([re]) => re.test(query)).flatMap(([, en]) => en)];
  return templates.filter(template =>
    terms.some(term =>
      template.id.toLowerCase().includes(term) ||
      template.name.toLowerCase().includes(term) ||
      template.type.toLowerCase().includes(term) ||
      (template.category ?? '').toLowerCase().includes(term) ||
      template.capabilities.some(capability => capability.toLowerCase().includes(term)),
    ),
  );
}

export interface DeviceTemplateGroup {
  /** Category key; '' = uncategorized (renders as「未分类」). */
  category: string;
  templates: DeviceTemplate[];
}

/** Group by category (sorted; uncategorized last), templates keep input order. */
export function groupDeviceTemplatesByCategory(
  templates: readonly DeviceTemplate[],
): DeviceTemplateGroup[] {
  const groups = new Map<string, DeviceTemplate[]>();
  for (const template of templates) {
    const category = template.category ?? '';
    const bucket = groups.get(category) ?? [];
    bucket.push(template);
    groups.set(category, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([category, groupTemplates]) => ({ category, templates: groupTemplates }));
}

/** A registry template → an interior-walk deploy palette entry. */
export function templateToDeployKind(template: DeviceTemplate): DeployKind {
  return {
    type: template.type,
    name: template.name,
    capabilities: [...template.capabilities],
  };
}

/**
 * One-line effect summary for the picker's note (defaultBehaviors +
 * environmentEffects count) — '' when the template declares neither.
 */
export function deviceTemplateEffectsNote(template: DeviceTemplate): string {
  const parts: string[] = [];
  if (template.defaultBehaviors.length > 0) parts.push(...template.defaultBehaviors);
  const effects = template.environmentEffects?.length ?? 0;
  if (effects > 0) parts.push(`${effects} env-effects`);
  return parts.join(' · ');
}
