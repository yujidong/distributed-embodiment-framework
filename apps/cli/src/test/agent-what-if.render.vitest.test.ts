/**
 * T27 (R3, u1-F4) — the what-if human face: fork PROVENANCE must render
 * (which world was simulated, its sim-time anchor, the window). Batch 2
 * shipped forkSource/simTimeSec in --json only, so a user watching her own
 * accelerated sim read a "sim-time 270" answer against her live 110,520
 * world without any on-screen hint that the fork tested a different world.
 * Pure render fixtures — no server boot — CLI fast lane.
 */

import { describe, expect, test } from 'vitest';

import { renderWhatIf } from '../commands/agent.js';

describe('renderWhatIf — fork provenance (T27, R3)', () => {
  test('the fork line renders kind + sim id + sim-time anchor + window after the verdict', () => {
    const { header } = renderWhatIf({
      agentId: 'agent-1',
      simulationId: 'sim-mine',
      simTimeSec: 270,
      forkSource: { kind: 'world-session', simulationId: 'sim-env-world-session' },
      result: {
        verdict: 'inconclusive',
        confidence: 0.6,
        delta: { temperature_bldg: 0, energy_bldg: 0 },
        explanation: 'Simulated 600s from sim-time 270 …',
        scenario: { durationSec: 600 },
      },
    });
    expect(header).toHaveLength(2);
    expect(header[0]).toContain('what-if: inconclusive');
    expect(header[0]).toContain('(confidence 0.6)');
    // The provenance line — the point of T27.
    expect(header[1]).toContain('fork 来源: world-session sim-env-world-session');
    expect(header[1]).toContain('@ sim-time 270s');
    expect(header[1]).toContain('（600s 模拟窗）');
  });

  test('an explicit --sim fork names the simulation kind (the world the user pointed at)', () => {
    const { header } = renderWhatIf({
      simTimeSec: 110520,
      forkSource: { kind: 'simulation', simulationId: 'sim-a6a43ee5-mu47nrde-2' },
      result: {
        verdict: 'improvement',
        confidence: 0.85,
        delta: { temperature_bldg: -1.2 },
        scenario: { durationSec: 1800 },
      },
    });
    expect(header[1]).toContain('fork 来源: simulation sim-a6a43ee5-mu47nrde-2');
    expect(header[1]).toContain('@ sim-time 110520s');
    expect(header[1]).toContain('（1800s 模拟窗）');
  });

  test('pre-R81 responses without fork fields render without the line (never "?" soup)', () => {
    const { header } = renderWhatIf({
      result: { verdict: 'neutral', confidence: 0.9, delta: { temperature: 0.1 } },
    });
    expect(header).toHaveLength(1);
    expect(header[0]).toContain('what-if: neutral');
  });

  test('the explanation rides the tail; disambiguation notes render by default (R101 anchor)', () => {
    const { tail } = renderWhatIf({
      simTimeSec: 5,
      forkSource: { kind: 'simulation', simulationId: 'sim-x' },
      result: {
        verdict: 'degradation',
        explanation: 'the zone crosses the comfort band',
        notes: [
          'unrelated note',
          'ambiguous target — the clause matches 2 devices (AC A (a)@z1, AC B (b)@z1); using AC A (a)@z1 — first match',
        ],
        scenario: { durationSec: 600 },
      },
    });
    expect(tail).toContain('the zone crosses the comfort band');
    expect(tail.some(l => l.includes('⚠') && l.includes('ambiguous target'))).toBe(true);
    expect(tail.some(l => l.includes('unrelated note'))).toBe(false);
  });
});

// T109 (R18, u1-F1): the WHAT-IF lane's jurisdiction disclosure — a
// cross-district intervention used to render a bare delta table (it read
// like the agent could operate the foreign zone). The disclosure now LEADS
// the human face (same first-line discipline as the ask face), from the
// structured top-level field — R102 holds even if a server join drifts.
describe('renderWhatIf — jurisdiction disclosure (T109, R18)', () => {
  const CROSS_NOTE =
    '⚠ 你点名的干预目标分区「B栋1F」不在该 agent 的辖区——下面的预演是对他人辖区设备的 fork 演练，' +
    '不代表该 agent 有操作权；真正执行需经辖区管理方（合约或提案）。该分区由 B栋管家 管理' +
    '（`eaf agent list --env` 查看花名册）。 (The intervention target zone(s) are outside this ' +
    "agent's jurisdiction — the prediction below is a fork simulation of another district's device, " +
    "not an authority to act; executing it for real requires the district's manager (an agreement or a proposal).)";

  test('a cross-district intervention: the disclosure line LEADS, before the verdict + provenance', () => {
    const { header } = renderWhatIf({
      agentId: 'keeper-a',
      simulationId: 'sim-1',
      jurisdictionNote: CROSS_NOTE,
      simTimeSec: 12,
      forkSource: { kind: 'world-session', simulationId: 'sim-env-world-session' },
      result: {
        verdict: 'neutral',
        confidence: 0.7,
        delta: { temperature_bldg_b_f1: 0.024, energy_bldg_b_f1: 156.25 },
        explanation: 'Simulated 600s from sim-time 12 …',
        scenario: { durationSec: 600 },
      },
    });
    expect(header).toHaveLength(3);
    expect(header[0]).toBe(CROSS_NOTE);
    expect(header[0]).toContain('不在该 agent 的辖区');
    expect(header[0]).toContain('B栋管家');
    expect(header[1]).toContain('what-if: neutral');
    expect(header[2]).toContain('fork 来源: world-session');
  });

  test('an in-jurisdiction intervention: no disclosure line — zero打扰 (the normal path)', () => {
    const { header } = renderWhatIf({
      agentId: 'keeper-a',
      simulationId: 'sim-1',
      simTimeSec: 12,
      forkSource: { kind: 'simulation', simulationId: 'sim-mine' },
      result: { verdict: 'improvement', delta: { temperature_zone_a: -0.5 }, scenario: { durationSec: 600 } },
    });
    expect(header.some(line => line.includes('不在该 agent 的辖区'))).toBe(false);
    expect(header[0]).toContain('what-if: improvement');
  });
});

// T130 (R21-F2): an INERT default-sim binding (the bound sim stopped or
// deleted) used to answer the single-candidate what-if with NO ⚠ line —
// the fork provenance was honest (T127 leg B) but the fall-back itself was
// silent. The disclosure must LEAD the header (the same first-line
// discipline as T109/T122), worded by the ACTUAL fall-back world, with the
// `eaf env set-default-sim <env> --clear` guidance, and the live-binding
// wording must never stand in for it.
describe('renderWhatIf — inert default-sim binding (T130, R21-F2)', () => {
  const INERT_SESSION_NOTE =
    '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到权威 world session；' +
    '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
    "(The environment's default simulation sim-owner-1 is not running — fell back to " +
    'the standard default-world adjudication; clear or rebind it with ' +
    '`eaf env set-default-sim <env> --clear`.)';
  const INERT_OWN_SIM_NOTE =
    '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到你自己唯一运行中的仿真 sim-mine-1；' +
    '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
    "(The environment's default simulation sim-owner-1 is not running — fell back to " +
    'your single running simulation sim-mine-1; clear or rebind it with ' +
    '`eaf env set-default-sim <env> --clear`.)';

  test('a fall-back to the world session: the ⚠ line LEADS, and the fork provenance names that same world', () => {
    const { header } = renderWhatIf({
      agentId: 'keeper-a',
      simulationId: 'sim-env-world-session',
      defaultSimNote: INERT_SESSION_NOTE,
      simTimeSec: 42,
      forkSource: { kind: 'world-session', simulationId: 'sim-env-world-session' },
      result: { verdict: 'neutral', delta: { temperature_zone_a: 0 }, scenario: { durationSec: 600 } },
    });
    expect(header).toHaveLength(3);
    expect(header[0]).toBe(INERT_SESSION_NOTE);
    expect(header[0]).toContain('⚠');
    expect(header[0]).toContain('已停止运行');
    expect(header[0]).toContain('env set-default-sim');
    expect(header[0]).toContain('--clear');
    expect(header[1]).toContain('what-if: neutral');
    // T127 honesty: provenance still names the world the prediction tested.
    expect(header[2]).toContain('fork 来源: world-session sim-env-world-session');
  });

  test('a fall-back to the caller\'s OWN sim: the ⚠ line names that world (never the hardcoded session wording)', () => {
    const { header } = renderWhatIf({
      agentId: 'keeper-a',
      simulationId: 'sim-mine-1',
      defaultSimNote: INERT_OWN_SIM_NOTE,
      simTimeSec: 7,
      forkSource: { kind: 'simulation', simulationId: 'sim-mine-1' },
      result: { verdict: 'improvement', delta: { temperature_zone_a: -0.5 }, scenario: { durationSec: 600 } },
    });
    expect(header[0]).toBe(INERT_OWN_SIM_NOTE);
    expect(header[0]).toContain('回退到你自己唯一运行中的仿真 sim-mine-1');
    expect(header[2]).toContain('fork 来源: simulation sim-mine-1');
  });

  test('the live-binding wording never appears on the inert branch', () => {
    const { header } = renderWhatIf({
      agentId: 'keeper-a',
      simulationId: 'sim-env-world-session',
      defaultSimNote: INERT_SESSION_NOTE,
      simTimeSec: 42,
      forkSource: { kind: 'world-session', simulationId: 'sim-env-world-session' },
      result: { verdict: 'neutral', scenario: { durationSec: 600 } },
    });
    expect(header.join('\n')).not.toContain('使用环境默认仿真');
  });
});
