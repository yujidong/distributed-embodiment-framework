/**
 * CLI i18n — minimal `t()` resolver for the human-mode Chinese patches the
 * CLI carries. The CLI is English-first (operator tool); only the
 * onboarding/overview strings in `me`, `env`, `service`, `notifications`,
 * and `device` commands have Chinese counterparts. JSON output (`--json`)
 * bypasses this entirely — keys + values are wire data, never localized.
 *
 * Mirrors the server's catalog pattern: dot-namespaced keys, `{name}`
 * interpolation, zh-CN source-of-truth for the existing Chinese strings,
 * en-US as the default when no key is found (graceful fallback for the
 * English-first CLI audience).
 *
 * Adding a language: add a bundle entry and extend `normalizeLocale`
 * (shared/i18n.ts) to recognize the prefix.
 */

import type { UiLocale } from '@active-collaboration/shared';

type Bundle = Record<string, string>;

const zhCN: Bundle = {
  'me.overview':
    '环境 {envs} · 我的设备 {devices} · Agent {agents} · 服务 {services} · 收藏 {bookmarks} · 运行中仿真 {running}',
  'me.todo.line': '待办：待批提案 {pendingProposals} · 待处理合约 {pendingAgreements} · 未读通知 {unread}',
  'me.runningScopeNote':
    '  （运行中仿真 {envWide} = 你参与的全部环境内 running/paused sims，含他人创建；其中你创建的 {mine}。配额按「你创建的」计）',
  'me.webhook.unset': '（未设置 webhook —— 通知仅收件箱拉取）',
  'env.guide.set': 'guide: 已设置（用 eaf env guide 查看）',
  'env.guide.unset': '"{name}" 还没有导读 —— owner 可用 eaf env set-guide 设置。',
  'env.serviceMap.header': '服务速查（你可见的服务，eaf agreement propose <id> 一跳签约）:',
  'env.activity.empty': '"{name}" 还没有任何动态。',
  'env.activity.count': '共 {count} 条动态（新→旧）。翻页用 --before；过滤用 --kind / --actor。',
  'env.nextStep': '下一步：eaf env guide {envId} 读环境导读；eaf service list --env {envId} 逛服务市场',
  'env.members.userNotFoundHint':
    '该邮箱尚未注册。可改用挂起式邀请：eaf env members invite <id|name> --email <e> —— 对方注册后自动加入该环境。',
  'service.scopeRequired': 'service list 需要范围：用 --env <id|name>、--mine 或 --all',
  'service.aggregate': '共 {count} 条服务，来自 {envs} 个环境（--env <id|name> 可限定单个环境）',
  'notifications.unread': '未读 {count} 条',
  'device.hardwareBinding.proposal': '含真实硬件绑定（{binding}），需环境 owner 审批后设备才会落地',
  'env.defaultSim.set':
    '环境 "{name}" ({envId}) 的默认仿真已设为 {simId} —— ask/what-if/read 默认道将优先使用它（仅在其运行时生效；停/删后诚实回退并提示）',
  'env.defaultSim.cleared': '已清除环境 "{name}" ({envId}) 的默认仿真绑定。',
  'env.defaultSim.face':
    '默认仿真 {simId} —— ask/what-if/read 默认道优先用它（仅在其运行时生效；`eaf env set-default-sim <env> --clear` 清除）',
};

const enUS: Bundle = {
  'me.overview':
    'Environments {envs} · My devices {devices} · Agents {agents} · Services {services} · Bookmarks {bookmarks} · Running sims {running}',
  'me.todo.line': 'Todo: {pendingProposals} pending proposal(s) · {pendingAgreements} pending agreement(s) · {unread} unread notification(s)',
  'me.runningScopeNote':
    '  (Running sims {envWide} = every running/paused sim across all environments you participate in, others\u0027 included; {mine} of them you created. The quota counts YOUR creations only)',
  'me.webhook.unset': '(no webhook set — notifications via inbox polling only)',
  'env.guide.set': 'guide: set (view with `eaf env guide`)',
  'env.guide.unset': '"{name}" has no guide yet — the owner can set one with `eaf env set-guide`.',
  'env.serviceMap.header': 'Service quick-look (services visible to you; `eaf agreement propose <id>` to sign in one hop):',
  'env.activity.empty': '"{name}" has no activity yet.',
  'env.activity.count': '{count} recent entries (newest first). Page with --before; filter with --kind / --actor.',
  'env.nextStep': 'Next: `eaf env guide {envId}` to read the world guide; `eaf service list --env {envId}` to browse the service market.',
  'env.members.userNotFoundHint':
    'This email is not registered yet. Use the pending invite instead: `eaf env members invite <id|name> --email <e>` — the person joins automatically once they register.',
  'service.scopeRequired': 'service list needs a scope: use --env <id|name>, --mine, or --all',
  'service.aggregate': '{count} service(s) across {envs} environment(s) (use --env <id|name> to narrow)',
  'notifications.unread': '{count} unread',
  'device.hardwareBinding.proposal': 'Includes real-hardware binding ({binding}); the device lands only after the env owner approves the proposal.',
  'env.defaultSim.set':
    'Default simulation of "{name}" ({envId}) set to {simId} — the ask/what-if/read default lanes target it while it is RUNNING; a stopped/deleted sim makes the binding inert (the lanes fall back and disclose).',
  'env.defaultSim.cleared': 'Cleared the default-simulation binding of "{name}" ({envId}).',
  'env.defaultSim.face':
    'default sim: {simId} — the ask/what-if/read default lanes target it while it is RUNNING (`eaf env set-default-sim <env> --clear` to clear)',
};

const BUNDLES: Record<UiLocale, Bundle> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/**
 * Resolve `key` in the active locale, interpolating `params` (`{name}`
 * placeholders). Falls back to en-US, then to the raw key — so the CLI
 * stays English-readable even when a key is missing from both bundles.
 */
export function t(
  locale: UiLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const bundle = BUNDLES[locale] ?? enUS;
  const template = bundle[key] ?? enUS[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
