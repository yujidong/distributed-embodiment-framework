/**
 * @vitest-environment node
 *
 * R40-A2（信任校准平台声誉桥，认知架构 §7.3）：平台声誉喂入后
 * MetaCognition.buildContext 的 partner trust 与纯私有基线的差异 + 冲突
 * 时的收缩方向。
 *
 * 接线背景：EngineRuntime 持有共享 ReputationTracker（negotiator 在用），
 * R40 起在装配/持久载入/协作完成后把平台声誉推给各 agent 的
 * MetaCognition.setPlatformReputation（见 runtime/reputation.vitest.test.ts
 * 的运行时接线测试）。本文件钉住"喂入后信任混合真的生效"的纯逻辑面。
 */

import { describe, expect, it } from 'vitest';

import { MetaCognition } from '../meta.js';

const BOUNDARY_INPUT = {
  capabilities: ['temperature-control'],
  devices: [{ deviceId: 'hvac-1', capabilities: ['temperature-control'], online: true }],
};

describe('platform reputation bridge (R40-A2)', () => {
  it('喂入平台声誉后 buildContext 的 partner trust 偏离纯私有基线', () => {
    // 纯私有基线：只有私有经历（3 次成功 1 次失败）。
    const baseline = new MetaCognition({ agentId: 'agent-a' });
    for (const success of [true, true, true, false]) {
      baseline.trust.recordInteraction('agent-b', success);
    }
    const baselineTrust = baseline.buildContext(BOUNDARY_INPUT)
      .partnerTrust.find(p => p.partnerId === 'agent-b');
    expect(baselineTrust).toBeDefined();
    expect(baselineTrust!.platformReputation).toBe(0.5); // 平台分量缺席 = 中性

    // 平台侧喂入高声誉（模拟 EngineRuntime 的推送）：混合分应上升。
    const bridged = new MetaCognition({ agentId: 'agent-a' });
    for (const success of [true, true, true, false]) {
      bridged.trust.recordInteraction('agent-b', success);
    }
    bridged.setPlatformReputation('agent-b', 0.95);

    const bridgedTrust = bridged.buildContext(BOUNDARY_INPUT)
      .partnerTrust.find(p => p.partnerId === 'agent-b');
    expect(bridgedTrust).toBeDefined();
    expect(bridgedTrust!.platformReputation).toBeCloseTo(0.95, 3);
    // 混合分高于纯私有基线（平台高声誉把信任拉上去），但仍低于平台分
    // 本身（私有经历里那次失败仍在说话）。
    expect(bridgedTrust!.trustScore).toBeGreaterThan(baselineTrust!.trustScore);
    expect(bridgedTrust!.trustScore).toBeLessThan(0.95);
  });

  it('零私有经历时平台声誉独立成立（陌生伙伴可被排名）', () => {
    const meta = new MetaCognition({ agentId: 'agent-a' });
    meta.setPlatformReputation('stranger-high', 0.9);
    meta.setPlatformReputation('stranger-low', 0.1);

    const partners = meta.buildContext(BOUNDARY_INPUT).partnerTrust;
    const high = partners.find(p => p.partnerId === 'stranger-high');
    const low = partners.find(p => p.partnerId === 'stranger-low');
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // 零交互 → 平台权重 w=1：混合分就是平台分。
    expect(high!.trustScore).toBeCloseTo(0.9, 3);
    expect(low!.trustScore).toBeCloseTo(0.1, 3);
    expect(high!.shouldCollaborate).toBe(true);
    expect(low!.shouldCollaborate).toBe(false);
  });

  it('平台声誉与私有经历冲突时收缩方向正确：经历渐增，混合分从平台侧移向私有侧', () => {
    // 冲突场景：平台声誉 0.9（好名声），私有经历全败（被坑过）。
    // 贝叶斯收缩的方向断言：
    //  1) 任何时候 trustScore ≤ platformReputation（坏经历不放大信任）；
    //  2) 私有交互越多，trustScore 越靠近私有 Laplace 分（(0+1)/(n+2)），
    //     即单调下降且逐渐摆脱平台分的影响。
    const meta = new MetaCognition({ agentId: 'agent-a' });
    meta.setPlatformReputation('agent-b', 0.9);

    let previous = 0.9; // 零交互时混合分 = 平台分
    const scores: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      meta.trust.recordInteraction('agent-b', false); // 又一次失败
      const trust = meta.buildContext(BOUNDARY_INPUT)
        .partnerTrust.find(p => p.partnerId === 'agent-b')!;
      expect(trust.trustScore).toBeLessThanOrEqual(0.9 + 1e-9); // 不超过平台分
      expect(trust.trustScore).toBeLessThanOrEqual(previous + 1e-9); // 单调向私有侧收缩
      previous = trust.trustScore;
      scores.push(trust.trustScore);
    }
    // 10 次失败后：平台权重 1/(1+10/5)=1/3，私有 Laplace 分 1/12 →
    // 混合分 ≈ 0.333*0.9 + 0.667*0.083 ≈ 0.361——远低于平台分，靠近私有分。
    expect(scores[9]).toBeLessThan(0.4);
    expect(scores[9]).toBeGreaterThan(0.083); // 仍受平台分一点拖拽（混合，不是覆盖）
    // 高声誉陌生人三次失败后不再被推荐协作（§7.3 的原始承诺）。
    const trust = meta.buildContext(BOUNDARY_INPUT)
      .partnerTrust.find(p => p.partnerId === 'agent-b')!;
    expect(trust.shouldCollaborate).toBe(false);
  });

  it('反向冲突也成立：平台低声誉 + 私有全胜 → 混合分不低于平台分且向私有侧上升', () => {
    const meta = new MetaCognition({ agentId: 'agent-a' });
    meta.setPlatformReputation('agent-b', 0.1);

    let previous = 0.1;
    for (let i = 0; i < 6; i += 1) {
      meta.trust.recordInteraction('agent-b', true);
      const trust = meta.buildContext(BOUNDARY_INPUT)
        .partnerTrust.find(p => p.partnerId === 'agent-b')!;
      expect(trust.trustScore).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(trust.trustScore).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = trust.trustScore;
    }
    // 6 次全胜：平台权重 1/(1+6/5)≈0.455，私有 Laplace 分 7/8=0.875 →
    // 混合 ≈ 0.53——私有证据已主导。
    expect(previous).toBeGreaterThan(0.5);
  });
});
