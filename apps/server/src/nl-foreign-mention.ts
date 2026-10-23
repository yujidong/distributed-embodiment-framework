/**
 * R78 病灶 A — NL 命令的「越权指名」事后教学 pass（纯函数）。
 *
 * 架构约束（docs/plan-r78-systemic.md §0.5）：Agent 设备面 = 自有绑定，
 * 跨组织能力只走 service。本模块【不】扩大 Agent 的指挥面——它只做两件事：
 *   1. 只读名称识别：命令文本是否指名了「环境内存在、但不在该 Agent 面上」
 *      的设备（复用 R49 的 CJK 折叠匹配器 resolveDeviceMentions）；
 *   2. 生成教学文案：点名 owner、其暴露的对应服务、合约路径。
 *
 * 挂在路由层（agent-nl.ts），Agent 返回「无动作」后运行；只产出文字，
 * 不产出任何设备提案——边界 gate 语义零变化。
 */

import { bestNameFragmentMatches } from '@active-collaboration/core';

/** One env device as the teaching pass sees it (read-only view). */
export interface ForeignMentionDevice {
  deviceId: string;
  name: string;
  type: string;
  zoneId?: string;
  ownerId: string;
  ownerName: string;
}

/** One service row, reduced to what the teaching names. */
export interface ForeignMentionService {
  id: string;
  name: string;
  semanticType: string;
  sourceDeviceId: string | null;
  visibility: string;
}

export interface ForeignMentionInput {
  text: string;
  devices: readonly ForeignMentionDevice[];
  /** The agent's OWN surface (bound) device ids — mentions inside it are normal. */
  agentSurfaceDeviceIds: ReadonlySet<string>;
  services: readonly ForeignMentionService[];
  /**
   * R78-A 修订：设备 ids that ACTUALLY got commanded this turn. Teaching
   * fires only when the named foreign device is NOT among them — a mixed
   * turn (own device acted + foreign device ignored) still teaches.
   */
  actedDeviceIds?: ReadonlySet<string>;
  /**
   * R76-F4：当前用户自己拥有的环境设备 ids。同名候选（e.g. 多人放了同款
   * 「Aqara智能窗帘电机（开合帘版）」）匹配度相同时优先解析为本人设备——
   * 指名自己的设备绝不应触发「属于他人」的教学。
   */
  ownDeviceIds?: ReadonlySet<string>;
}

const STRINGS = {
  'zh-CN': {
    header: (device: string, owner: string) =>
      `「${device}」属于 ${owner}，不在我的管理范围内（我只能操作自己绑定的设备）。`,
    requesterHeader: (device: string, owner: string) =>
      `「${device}」是 ${owner} 的私有设备——你（请求者）不是它的所有者，无权通过任何 Agent 直接操作它。`,
    servicesLine: (names: string) => `它的能力已作为服务暴露：${names}。`,
    servicesNone: '它目前没有以服务形式暴露能力（可请其主人为该设备绑定 Agent 派生服务）。',
    path: '如需使用，请在「服务」市场找到对应服务并发起合约——合约批准后即可消费（POST /api/services/{id}/agreements）。',
  },
  'en-US': {
    header: (device: string, owner: string) =>
      `"${device}" belongs to ${owner} and is outside what I manage (I can only operate my own bound devices).`,
    requesterHeader: (device: string, owner: string) =>
      `"${device}" is ${owner}'s private device — you (the requester) are not its owner, so no agent may be driven to operate it directly.`,
    servicesLine: (names: string) => `Its capabilities are exposed as services: ${names}.`,
    servicesNone: 'It currently exposes no services (its owner can bind an agent to derive them).',
    path: 'To use it, open the service marketplace and propose an agreement on the matching service — once accepted it is consumable (POST /api/services/{id}/agreements).',
  },
} as const;

/** Match a locale to the string table (unknown locales fall back to zh-CN). */
function stringsFor(locale: string | undefined) {
  return locale === 'en-US' || locale === 'en' ? STRINGS['en-US'] : STRINGS['zh-CN'];
}

/**
 * R76-F5: the teaching text for a KNOWN foreign device (owner + its exposed
 * services + the agreement path) — shared by the foreign-mention pass below
 * and the NL command lane's 403 denial (agent-nl.ts), so the blocked request
 * and the after-the-fact hint never drift into two languages/qualities.
 */
export function foreignDeviceTeaching(
  device: { name: string; ownerName: string },
  itsServices: readonly ForeignMentionService[],
  locale: string | undefined,
): string {
  const T = stringsFor(locale);
  const serviceLine =
    itsServices.length > 0
      ? T.servicesLine(itsServices.map(s => s.name).join('、'))
      : T.servicesNone;
  return `${T.header(device.name, device.ownerName)} ${serviceLine} ${T.path}`;
}

/**
 * R99 (simtest-r1 zhao-10): the REQUESTER-accurate denial teaching for the
 * execution-layer 403 (agent-nl.ts nlDenialTeaching). The device-ownership
 * gate keys on WHO ASKED, so the agent-voice header above ("我只能操作自己
 * 绑定的设备") mislabels the denial whenever the device IS bound to the
 * agent — the true reason is the requester is not the device owner. Same
 * services + agreement-path tail; only the header names the real cause.
 */
export function foreignDeviceRequesterTeaching(
  device: { name: string; ownerName: string },
  itsServices: readonly ForeignMentionService[],
  locale: string | undefined,
): string {
  const T = stringsFor(locale);
  const serviceLine =
    itsServices.length > 0
      ? T.servicesLine(itsServices.map(s => s.name).join('、'))
      : T.servicesNone;
  return `${T.requesterHeader(device.name, device.ownerName)} ${serviceLine} ${T.path}`;
}

/**
 * The teaching line for a foreign mention, or null when the text names
 * nothing outside the agent's surface (normal case — no teaching).
 */
export function foreignMentionTeaching(
  input: ForeignMentionInput,
  locale: string | undefined,
): string | null {
  // 与 NL 命令解析器同一个碎片匹配器（bestNameFragmentMatches）——「指名了
  // 什么设备」的判定在两处消费方之间不可能漂移。
  // R76-F4 own-first：自有候选（Agent 面 + 本轮已执行 + 用户本人拥有的设备）
  // 在同等匹配度下排前；若最强匹配落在自有设备上，本次指名解析为本人设备，
  // 不再教学（同名误路由的修复）。严格更强的他人指名（更长的独有名称碎片）
  // 仍然教学。
  const own = new Set([
    ...input.agentSurfaceDeviceIds,
    ...(input.actedDeviceIds ?? []),
    ...(input.ownDeviceIds ?? []),
  ]);
  const mentioned = bestNameFragmentMatches(input.text, input.devices, 3, 3, own);
  const topId = mentioned[0];
  if (topId === undefined || own.has(topId)) return null;

  const device = input.devices.find(d => d.deviceId === topId);
  if (device === undefined) return null;

  const itsServices = input.services
    .filter(s => s.sourceDeviceId === device.deviceId)
    .slice(0, 3);
  return foreignDeviceTeaching(device, itsServices, locale);
}
