/**
 * Server-side message catalog — chrome (user-visible) strings only.
 *
 * Per the locked i18n decision: `error.code` tokens, validation messages
 * with field paths, LLM prompts, server logs, and eval-persisted errors stay
 * English. This catalog holds ONLY the strings surfaced to end users via
 * notification titles, the viewer notice, /api/me/manifest deployment notes,
 * quota/rate-limit text, and the /api/docs HTML chrome.
 *
 * Key shape: dot-namespaced (`chrome.<area>.<key>`). Param interpolation
 * uses `{name}` placeholders — `t(locale, 'chrome.manifest.devicesToBuy',
 * { count: 3, total: 1200 })` resolves `{count}` and `{total}` inside the
 * string. Unknown params are left as-is.
 *
 * Adding a language: copy the `en-US` block, add a top-level entry, and
 * `normalizeLocale` (shared/i18n.ts) will route to it once the locale
 * prefix is registered there.
 */

import type { UiLocale } from '@active-collaboration/shared';

/** A single message may be a constant string or a parameterized function. */
export type Message = string | ((params: Record<string, string | number>) => string);

/** Nested message catalog — `chrome.<area>.<key>` lives two levels deep. */
export type MessageCatalog = {
  chrome: {
    role: {
      viewerNotice: Message;
    };
    notif: {
      agreementProposed: Message;
      /** T-309: the consumer nudged the provider about a proposed agreement. */
      agreementReminded: Message;
      /** R77-F5 residual: the stale-proposal sweep's aggregated provider reminder. */
      agreementProposedStale: Message;
      agreementAccepted: Message;
      agreementRejected: Message;
      agreementSuspended: Message;
      /** D3 (R28, T-080): the consumer held the agreement (bounded pause). */
      agreementHeld: Message;
      /** D3 (R28, T-080): the consumer resumed the held agreement. */
      agreementResumed: Message;
      agreementTerminated: Message;
      agreementTerminatedByEnvOwner: Message;
      agreementInvokeFailed: Message;
      /** T-049: the provider agent of the agreement was removed (cascade). */
      agreementProviderRemoved: Message;
      /** R6-E-F08 failover: the watchdog suspended the agreement (provider heartbeat lost). */
      agreementProviderUnreachable: Message;
      /** R6-E-F08 failover: the provider recovered — terminated + re-signed a successor. */
      agreementProviderRecovered: Message;
      /** T-403: the derived service backing the agreement was regenerated (cascade). */
      agreementDerivedRegenerated: Message;
      /** R14: the provider revoked the computation a data agreement delivers on. */
      agreementComputeDropped: Message;
      /** R14 Wave-B: the provider countered a proposed agreement (T-059). */
      agreementCountered: Message;
      /** R14 Wave-B: access requested on a hidden service (T-058b). */
      serviceAccessRequested: Message;
      /** R14 Wave-B: access granted (or extended) on a hidden service. */
      serviceAccessGranted: Message;
      /** R14 Wave-B: the access grant was revoked. */
      serviceAccessRevoked: Message;
      /** R14 Wave-B: rate-limited nudge on a pending access request. */
      serviceAccessReminded: Message;
      /** T-069 (R23): a new service matched the recipient's standing ask (需求板). */
      askMatched: Message;
      /** T-504 (R24): the provider's own publish satisfied a standing ask (one-shot match signal). */
      askMatchedProvider: Message;
      proposalEscalated: Message;
      /** R33 (Care F2): the author nudged the decider about an escalated proposal. */
      proposalReminded: Message;
      proposalRejected: Message;
      proposalApplied: Message;
      /** T39 (R3): the batch digest title for a micro-burst of auto-applied proposals. */
      proposalAppliedBatch: Message;
      proposalReverted: Message;
      /** T-004: an auto-applied proposal reached the env owner (no human verdict). */
      proposalAutoApplied: Message;
      /** T-072: the delegated member decided + applied a proposal on the owner's world. */
      proposalDelegateApplied: Message;
      memberAdded: Message;
      memberJoined: Message;
      /** T-026: a member's role changed (promotion or demotion). */
      memberRoleChanged: Message;
      /** T-026: a member was removed from the environment. */
      memberRemoved: Message;
      termsUnlimited: Message;
      /** T-108: anonymous replay share minted on the owner's environment. */
      shareCreated: Message;
      /** T-072: zone-claim decision rights delegated to the recipient. */
      governanceDelegationGranted: Message;
      /** T-072: the delegation was revoked (owner act or membership end). */
      governanceDelegationRevoked: Message;
    };
    manifest: {
      pureSoftwareAgent: Message;
      devicesToBuy: Message;
      unmatchedDevices: Message;
      bridgedDevices: Message;
      emptyWorldHint: Message;
    };
    env: {
      /** T-063(c): list-card hint on a world with 0 zones/devices/agents. */
      emptyWorldCard: Message;
    };
    digest: {
      /** T-071: the arrival briefing digest's title (the "since you left" line). */
      title: Message;
      /** T-071: category labels (proposals decided / agreements changed / devices installed / world & governance). */
      proposals: Message;
      agreements: Message;
      devices: Message;
      world: Message;
    };
    governance: {
      /**
       * T-063(e): the CODE-AUTHORED governance notes stored in aiReview
       * (LLM-authored reasons stay verbatim). Same locale-capture pattern
       * as notification titles.
       */
      zoneClaimAutonomy: Message;
      highRiskBypass: Message;
      reviewUnavailableEscalate: Message;
      reviewTimeoutAutoApprove: Message;
      reviewerUnavailableAutoApprove: Message;
      reviewerUnavailableEscalate: Message;
      /** S1 (Task 2): injection-marker guard — code-authored, localized. */
      injectionGuardEscalate: Message;
    };
    docs: {
      htmlLang: Message;
      introParagraph: Message;
    };
    /**
     * Alpha capacity gating (EAF_INVITE_ONLY, schema v57): the registration
     * invite gate's teaching copy. User-facing chrome (same class as the
     * quota/rate-limit texts) — the copy NEVER echoes any part of the code.
     */
    auth: {
      /** 403 INVITE_REQUIRED — invite-only deployment, no code supplied. */
      inviteRequired: Message;
      /** 403 INVITE_INVALID — unknown code OR exhausted (one merged answer). */
      inviteInvalid: Message;
      /** 410 INVITE_GONE — expired or revoked (ask for a FRESH code). */
      inviteGone: Message;
    };
  };
};

/** Replace `{name}` placeholders with values from `params`. */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

function bind(message: Message, params: Record<string, string | number>): string {
  return typeof message === 'function' ? message(params) : interpolate(message, params);
}

// ---------------------------------------------------------------------------
// zh-CN — source of truth, mirrors the original hard-coded strings verbatim.
// ---------------------------------------------------------------------------

const zhCN: MessageCatalog = {
  chrome: {
    role: {
      viewerNotice:
        '你是 viewer：可浏览世界、创建仿真观察、fork 沙箱；不可修改世界或注入事件。',
    },
    notif: {
      agreementProposed: '有新的服务合约提案待你处理',
      agreementReminded: '消费者提醒你：服务合约提案仍在等待你的决定',
      agreementProposedStale: (params) =>
        `你有 ${params.count} 个服务合约提案已等待超过 24 小时，仍未决定`,
      agreementAccepted: '你的服务合约已被接受',
      agreementRejected: '你的服务合约被拒绝',
      agreementSuspended: '你的服务合约被提供方暂停',
      agreementHeld: '消费方暂时挂起了对你服务的消费（有限期 hold）',
      agreementResumed: '消费方已恢复对合约的消费（hold 结束）',
      agreementTerminated: '服务合约已被对方终止',
      agreementTerminatedByEnvOwner: '服务合约已被环境所有者终止（环境治理收口）',
      agreementInvokeFailed: '你的服务被调用失败',
      agreementProviderRemoved: '你消费的服务合约随提供方 Agent 移除而失效',
      agreementProviderUnreachable: '服务合约因提供方 Agent 心跳失联被值守挂起（可恢复）',
      agreementProviderRecovered: '失联的提供方已恢复：原合约已终止并按原条款重签新约',
      agreementDerivedRegenerated: '你消费的服务合约随派生服务重建而失效（附后继语义类型）',
      agreementComputeDropped: '数据服务合约的计算规格被提供方撤销',
      agreementCountered: '你的合约提案被提供方还价——轮到你决定',
      serviceAccessRequested: '有成员请求访问你的隐藏服务',
      serviceAccessGranted: '你请求访问的隐藏服务已向你开放（有期限）',
      serviceAccessRevoked: '你对隐藏服务的访问授权被提供方撤销',
      serviceAccessReminded: '请求方提醒你：隐藏服务的访问请求仍在等待处理',
      askMatched: '有新服务匹配了你的常驻需求（需求板）——可发起合约',
      askMatchedProvider: '你发布的服务匹配了一条常驻需求（需求板）——需求方已收到撮合通知',
      proposalEscalated: '有提案待你审批',
      proposalReminded: '提案作者提醒你：提案仍在等待你的裁决',
      proposalRejected: '你的提案被驳回',
      proposalApplied: '你的提案已通过并应用',
      proposalAppliedBatch: '{count} 项提案已自动应用',
      proposalReverted: '你的提案已被回滚',
      proposalAutoApplied: '有提案未经人工审批已自动应用到你的环境',
      proposalDelegateApplied: '有 zone 认领提案由你委托的裁决人决定并应用到你的环境',
      memberAdded: '你被加入环境「{envName}」',
      memberJoined: '「{email}」已注册并加入环境「{envName}」',
      memberRoleChanged: '你在环境「{envName}」的角色由 {fromRole} 变更为 {toRole}',
      memberRemoved: '你已被移出环境「{envName}」',
      termsUnlimited: '无附加条款（不限）',
      shareCreated: '你的环境「{envName}」生成了匿名回放分享链接，可在环境的分享列表中撤销',
      governanceDelegationGranted: '环境「{envName}」的 owner 将 zone 认领（zone-claim）裁决权委托给你（{zones}）',
      governanceDelegationRevoked: '你在环境「{envName}」的 zone 认领裁决委托已被撤销',
    },
    manifest: {
      pureSoftwareAgent: '纯软件主体：{name} 无绑定设备，部署仅需 Agent 与服务契约',
      devicesToBuy: '{count} 台设备待采购，名录总价约 ¥{total}',
      unmatchedDevices: '{count} 台设备未匹配到名录型号（无品牌或型号不唯一），需人工确认采购渠道',
      bridgedDevices: '{count} 台设备已桥接真实硬件（hass:// 绑定），其余为纯仿真设备',
      emptyWorldHint: '你在该环境中还没有设备与 Agent —— 可先在「名录」放置设备或创建 Agent',
    },
    env: {
      emptyWorldCard:
        '空世界：0 zone / 0 设备 / 0 Agent —— 所有者可导入模板或补建 zone，成员可通过安装提案引导这个世界',
    },
    digest: {
      title: '今日速览（{since} 起）',
      proposals: '已决提案',
      agreements: '合约变动',
      devices: '设备安装与操作',
      world: '世界与治理',
    },
    governance: {
      zoneClaimAutonomy: 'Zone 认主权：低风险提案完全位于作者持有 zone claim 的区域内（§5.3），自动通过',
      highRiskBypass: '高风险提案：跳过 AI 审查，须由环境所有者决定',
      reviewUnavailableEscalate: 'AI 审查不可用（{error}）；已上报环境所有者',
      reviewTimeoutAutoApprove: '审查 LLM 不可用（{error}）；低风险提案按平台策略自动通过——环境所有者可回滚',
      reviewerUnavailableAutoApprove: '语义审查器不可用（未配置 LLM）；低风险提案已通过确定性规则检查，按平台策略自动通过——环境所有者可回滚该决定',
      reviewerUnavailableEscalate: '语义审查器不可用（未配置 LLM）；已上报环境所有者',
      injectionGuardEscalate: '提案载荷携带提示注入特征（{markers}）——已跳过 AI 审查直接上报环境所有者，绝不自动应用',
    },
    docs: {
      htmlLang: 'zh-CN',
      introParagraph:
        '机器可读契约（OpenAPI 3.1，人工维护）：<a href="/api/openapi.yaml">/api/openapi.yaml</a> —— AI agent 与脚本请直接消费该文件。错误格式统一为 <code>{"error":{"code","message","issues?"}}</code>；认证为 <code>Authorization: Bearer</code> 或 Cookie <code>eaf_token</code>。',
    },
    auth: {
      inviteRequired:
        '本平台当前处于邀请制内测阶段，注册需要邀请码。请向平台管理员索取邀请码后再注册。',
      inviteInvalid:
        '邀请码无效或已用完。请核对后重试；若确认无误，请联系平台管理员索取新的邀请码。',
      inviteGone: '邀请码已过期或已被吊销。请联系平台管理员索取新的邀请码。',
    },
  },
};

// ---------------------------------------------------------------------------
// en-US — translation pass. Plain-English phrasing; keeps the same param
// placeholders so callers don't need a per-locale code path.
// ---------------------------------------------------------------------------

const enUS: MessageCatalog = {
  chrome: {
    role: {
      viewerNotice:
        "You're a viewer: browse the world, run observation simulations, and fork sandboxes; you can't modify the world or inject events.",
    },
    notif: {
      agreementProposed: 'You have a new service-agreement proposal to review',
      agreementReminded: 'Reminder from the consumer: a service-agreement proposal is still awaiting your decision',
      agreementProposedStale: (params) =>
        `${params.count} service-agreement proposal(s) have been awaiting your decision for over 24 hours`,
      agreementAccepted: 'Your service agreement was accepted',
      agreementRejected: 'Your service agreement was rejected',
      agreementSuspended: 'Your service agreement was suspended by the provider',
      agreementHeld: 'The consumer held your service agreement (bounded consumption pause)',
      agreementResumed: 'The consumer resumed the held agreement',
      agreementTerminatedByEnvOwner: 'The service agreement was terminated by the environment owner (governance close-out)',
      agreementTerminated: 'The service agreement was terminated by the other party',
      agreementInvokeFailed: 'Your service failed to execute',
      agreementProviderRemoved: 'A service agreement you consume ended: its provider agent was removed',
      agreementProviderUnreachable: 'A service agreement was parked by the watchdog: its provider agent lost heartbeat (recoverable)',
      agreementProviderRecovered: 'The unreachable provider is back: the parked agreement was terminated and re-signed on identical terms',
      agreementDerivedRegenerated: 'A service agreement you consume ended: its derived service was regenerated (successor semantic types attached)',
      agreementComputeDropped: 'The computation behind a data agreement was revoked by the provider',
      agreementCountered: 'Your agreement proposal was countered by the provider — your move',
      serviceAccessRequested: 'A member requested access to one of your hidden services',
      serviceAccessGranted: 'Access to a hidden service was granted to you (time-limited)',
      serviceAccessRevoked: 'Your access grant to a hidden service was revoked by the provider',
      serviceAccessReminded: 'Reminder from the requester: an access request is still awaiting your decision',
      askMatched: 'A new service matched your standing ask (demand board) — you can propose an agreement',
      askMatchedProvider:
        'Your published service matched a standing ask (demand board) — the asker has been notified of the match',
      proposalEscalated: 'A proposal is waiting for your approval',
      proposalReminded: 'Reminder from the proposal author: a proposal is still awaiting your decision',
      proposalRejected: 'Your proposal was rejected',
      proposalApplied: 'Your proposal was approved and applied',
      proposalAppliedBatch: '{count} proposals auto-applied',
      proposalReverted: 'Your proposal was rolled back',
      proposalAutoApplied: 'A proposal was auto-applied to your environment (no human review)',
      proposalDelegateApplied:
        'A zone-claim proposal was decided by your delegated decider and applied to your environment',
      memberAdded: 'You were added to the environment "{envName}"',
      memberJoined: '"{email}" registered into the environment "{envName}"',
      memberRoleChanged: 'Your role in the environment "{envName}" changed from {fromRole} to {toRole}',
      memberRemoved: 'You were removed from the environment "{envName}"',
      termsUnlimited: 'No additional terms (unlimited)',
      shareCreated:
        'An anonymous replay share link was created for your environment "{envName}" — revoke it from the environment\'s share list',
      governanceDelegationGranted:
        'The owner of environment "{envName}" delegated zone-claim decisions to you ({zones})',
      governanceDelegationRevoked:
        'Your zone-claim decision delegation in environment "{envName}" was revoked',
    },
    manifest: {
      pureSoftwareAgent: 'Software-only agent: {name} has no bound devices — deployment needs only the agent and its service agreements',
      devicesToBuy: '{count} device(s) to procure; catalog total ≈ ¥{total}',
      unmatchedDevices: '{count} device(s) could not be matched to a catalog model (no brand, or brand+model not unique); confirm the procurement channel manually',
      bridgedDevices: '{count} device(s) already bridged to real hardware (hass:// binding); the rest are simulation-only',
      emptyWorldHint: "You don't have any devices or agents in this environment yet — drop a device from the Catalog or create an Agent to start",
    },
    env: {
      emptyWorldCard:
        'Empty world: 0 zones / 0 devices / 0 agents — the owner can import a template or add zones, and members can bootstrap it through install proposals',
    },
    digest: {
      title: "Today at a glance (since {since})",
      proposals: 'Proposals decided',
      agreements: 'Agreements changed',
      devices: 'Devices installed & operated',
      world: 'World & governance',
    },
    governance: {
      zoneClaimAutonomy: 'Zone-claim autonomy: low-risk proposal fully inside zones stewarded by the author (§5.3)',
      highRiskBypass: 'High-risk proposal: AI review is bypassed, the environment owner must decide',
      reviewUnavailableEscalate: 'AI review unavailable ({error}); escalated to the environment owner',
      reviewTimeoutAutoApprove:
        'Review LLM unavailable ({error}); low-risk proposal auto-approved per platform policy — the environment owner can revert',
      reviewerUnavailableAutoApprove:
        'Semantic reviewer unavailable (no LLM configured); the low-risk proposal passed the deterministic rule check and platform policy auto-approves it — the environment owner can revert this decision',
      reviewerUnavailableEscalate: 'Semantic reviewer unavailable (no LLM configured); escalated to the environment owner',
      injectionGuardEscalate:
        'The proposal payload carries prompt-injection markers ({markers}) — AI review is skipped, the environment owner must decide; it is never auto-applied',
    },
    docs: {
      htmlLang: 'en',
      introParagraph:
        'Machine-readable contract (OpenAPI 3.1, hand-maintained): <a href="/api/openapi.yaml">/api/openapi.yaml</a> — AI agents and scripts should consume that file directly. Errors use the shape <code>{"error":{"code","message","issues?"}}</code>; auth is <code>Authorization: Bearer</code> or the <code>eaf_token</code> cookie.',
    },
    auth: {
      inviteRequired:
        'This platform is in invite-only alpha — registration needs an invite code. Ask the platform administrator for one and try again.',
      inviteInvalid:
        'The invite code is invalid or already used up. Double-check it and retry; if it looks right, ask the platform administrator for a new one.',
      inviteGone:
        'The invite code has expired or was revoked. Ask the platform administrator for a new one.',
    },
  },
};

export const MESSAGES: Record<UiLocale, MessageCatalog> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/**
 * Look up a dot-path key (e.g. `'chrome.notif.agreementProposed'`) in the
 * catalog for `locale`. Falls back to zh-CN, then to the raw key.
 */
export function lookupMessage(
  locale: UiLocale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const candidates: MessageCatalog[] = [MESSAGES[locale], MESSAGES['zh-CN']].filter(
    (c): c is MessageCatalog => c !== undefined,
  );
  for (const catalog of candidates) {
    const found = resolve(catalog, key);
    if (found !== undefined) return bind(found, params);
  }
  return key;
}

function resolve(catalog: MessageCatalog, key: string): Message | undefined {
  const parts = key.split('.');
  // The catalog shape is fixed at `{ chrome: { <area>: { <key>: Message } } }`
  // — three parts expected.
  if (parts.length !== 3) return undefined;
  const [ns, area, leaf] = parts;
  if (ns !== 'chrome') return undefined;
  const block = (catalog as Record<string, Record<string, Record<string, Message>>>)[ns]?.[area];
  if (!block) return undefined;
  return block[leaf];
}
