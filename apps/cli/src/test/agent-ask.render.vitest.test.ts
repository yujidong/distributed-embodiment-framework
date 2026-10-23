/**
 * T130 (R21-F2) — the ask human face: an INERT default-sim binding (the
 * bound sim stopped/deleted while the agent still answers from a fall-back
 * world) must render the ⚠ disclosure + the rebind/--clear guidance on the
 * human stream. R21 spot-check leg B (r21-u3-ask-inert-binding) caught the
 * server answering 200 with zero disclosure; the fix makes the server join
 * the note, and THIS file pins the face: the note renders whether it rides
 * the body join or only the standalone field (the R102 line — never
 * json-only), and the live-binding wording never doubles as the inert one.
 * Pure render fixtures — no server boot — CLI fast lane.
 */

import { describe, expect, test } from 'vitest';

import { renderAskLines } from '../commands/agent.js';

// The exact `defaultSimNoteOf` stale-branch shapes (agreements/targeting.ts
// — the server serializer these fixtures mirror), one per fall-back kind.
const INERT_WORLD_SESSION_NOTE =
  '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到权威 world session；' +
  '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
  '(The environment\'s default simulation sim-owner-1 is not running — fell back to ' +
  'the standard default-world adjudication; clear or rebind it with ' +
  '`eaf env set-default-sim <env> --clear`.)';
const INERT_OWN_SIM_NOTE =
  '⚠ 环境默认仿真 sim-owner-1 已停止运行——本次回退到你自己唯一运行中的仿真 sim-mine-1；' +
  '可用 `eaf env set-default-sim <env> --clear` 清除或重新绑定。 ' +
  "(The environment's default simulation sim-owner-1 is not running — fell back to " +
  'your single running simulation sim-mine-1; clear or rebind it with ' +
  '`eaf env set-default-sim <env> --clear`.)';

describe('renderAskLines — inert default-sim binding (T130, R21-F2)', () => {
  test('the ⚠ fall-back disclosure renders with the --clear guidance (server joined it into the body)', () => {
    const lines = renderAskLines({
      agentId: 'keeper-a',
      simulationId: 'sim-env-world-session',
      defaultSimNote: INERT_WORLD_SESSION_NOTE,
      naturalLanguageResponse: `${INERT_WORLD_SESSION_NOTE}\nA栋1F (zone-a): temperature 21°C`,
      intent: { action: 'answer' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('⚠');
    expect(lines[0]).toContain('已停止运行');
    expect(lines[0]).toContain('env set-default-sim');
    expect(lines[0]).toContain('--clear');
    expect(lines[0]).toContain('权威 world session');
    // The answer itself survives the join.
    expect(lines[0]).toContain('A栋1F (zone-a): temperature 21°C');
    // The join means the note appears exactly once — no doubled ⚠ block.
    expect(lines[0].split('已停止运行')).toHaveLength(2);
  });

  test('the standalone note only (pre-join payload) still renders — R102 holds even if the server join drifts', () => {
    const lines = renderAskLines({
      agentId: 'keeper-a',
      simulationId: 'sim-mine-1',
      defaultSimNote: INERT_OWN_SIM_NOTE,
      naturalLanguageResponse: 'A栋1F (zone-a): temperature 21°C',
    });
    expect(lines).toContain(INERT_OWN_SIM_NOTE);
    expect(lines).toContain('A栋1F (zone-a): temperature 21°C');
    expect(lines.some(l => l.includes('env set-default-sim') && l.includes('--clear'))).toBe(true);
  });

  test('an own-sim fall-back names THAT world (never the hardcoded session wording)', () => {
    const lines = renderAskLines({
      agentId: 'keeper-a',
      simulationId: 'sim-mine-1',
      defaultSimNote: INERT_OWN_SIM_NOTE,
      naturalLanguageResponse: `${INERT_OWN_SIM_NOTE}\nA栋1F (zone-a): temperature 21°C`,
    });
    expect(lines.join('\n')).toContain(`回退到你自己唯一运行中的仿真 sim-mine-1`);
  });

  test('a no-binding answer renders zero disclosure (the normal path stays silent)', () => {
    const lines = renderAskLines({
      agentId: 'keeper-a',
      simulationId: 'sim-mine-1',
      naturalLanguageResponse: 'A栋1F (zone-a): temperature 21°C',
    });
    expect(lines).toEqual(['A栋1F (zone-a): temperature 21°C']);
  });
});
