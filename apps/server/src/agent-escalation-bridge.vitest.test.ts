/**
 * @vitest-environment node
 *
 * R40-A3（认知架构 §7.5 升级通道）server 半边：AGENT_ESCALATION 世界事件 →
 * 环境 owner 的 agent.escalated 通知。测试姿势与 notifications.vitest.test.ts
 * 的 "AC join-response pings the initiator owner" 同款——结构化 fake runtime
 * 直接 fire 总线事件，无需 LLM/物理。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { EventType, type EngineRuntime, type SystemEvent } from '@active-collaboration/core';

import { AgentEscalationBridge } from './agent-escalation-bridge.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

interface NotificationJson {
  id: string;
  envId: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
}

/** 结构化 fake runtime：记录订阅并在 fire 时派发（同 AcAgreementBridge 测试）。 */
function makeFakeRuntime(): {
  fire: (type: string, payload: Record<string, unknown>) => void;
  runtime: EngineRuntime;
} {
  const listeners: Array<{ types: string[] | undefined; listener: (event: SystemEvent) => void }> = [];
  return {
    fire: (type, payload) => {
      for (const entry of listeners) {
        if (entry.types === undefined || entry.types.includes(type)) {
          entry.listener({ type, source: 'engine-runtime:test', payload } as unknown as SystemEvent);
        }
      }
    },
    runtime: {
      subscribe: (listener: (event: SystemEvent) => void, types?: unknown) => {
        listeners.push({ types: (Array.isArray(types) ? types : [types]) as string[], listener });
        return () => undefined;
      },
    } as unknown as EngineRuntime,
  };
}

describe('agent escalation bridge (R40-A3, §7.5)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let stranger: TestUser;
  let envId: string;
  let agentId: string;
  let fake: ReturnType<typeof makeFakeRuntime>;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('escalation-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    agentId = ctx.app.envStore.agentsOf(envId)[0]!.id;

    fake = makeFakeRuntime();
    const bridge = new AgentEscalationBridge({
      envStore: ctx.app.envStore,
      notificationStore: ctx.app.notificationStore,
    });
    bridge.attach(envId, fake.runtime);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function inbox(token: string): Promise<{ notifications: NotificationJson[]; unreadCount: number }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('AGENT_ESCALATION 落 owner 的 agent.escalated 通知（body 带决策上下文）', async () => {
    fake.fire(EventType.AGENT_ESCALATION, {
      agentId,
      eventId: 'evt-esc-1',
      eventType: 'temperature-spike',
      decision: 'defer',
      severity: 5,
      confidence: 0.3,
      reason: 'escalation pressure=0.7≥0.4 (confidence=0.3, risk=1, authority=full)',
      zoneId: 'zone-a',
    });

    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.unreadCount).toBe(1);
    const notice = ownerInbox.notifications[0];
    expect(notice.kind).toBe('agent.escalated');
    expect(notice.envId).toBe(envId);
    expect(notice.refId).toBe('evt-esc-1');
    expect(notice.body).toMatchObject({
      agentId,
      eventId: 'evt-esc-1',
      eventType: 'temperature-spike',
      decision: 'defer',
      severity: 5,
      confidence: 0.3,
      zoneId: 'zone-a',
    });
    expect(String(notice.body.summary)).toContain('没有执行任何设备命令');
    // 他人不收件（通知是环境 owner 的门铃）。
    expect((await inbox(stranger.token)).notifications).toHaveLength(0);
  });

  it('同一事件的重复升级在 owner 读过之前去重（dedupeUnread）', async () => {
    const fire = () => fake.fire(EventType.AGENT_ESCALATION, {
      agentId,
      eventId: 'evt-esc-dup',
      reason: 'severity≥4 emergency with confidence=0.3<0.5',
    });
    fire();
    fire();
    fire();
    const box = await inbox(owner.token);
    expect(box.notifications.filter(n => n.kind === 'agent.escalated')).toHaveLength(1);

    // 读过之后，门铃可以再响。
    await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${box.notifications[0].id}/read`,
      headers: auth(owner.token),
    });
    fire();
    const after = await inbox(owner.token);
    const unread = after.notifications.filter(n => n.kind === 'agent.escalated' && n.readAt === null);
    expect(unread).toHaveLength(1);
  });

  it('无 agentId 的畸形事件被忽略（不落通知、不抛错）', async () => {
    fake.fire(EventType.AGENT_ESCALATION, { eventId: 'evt-broken' });
    expect((await inbox(owner.token)).notifications).toHaveLength(0);
  });
});
