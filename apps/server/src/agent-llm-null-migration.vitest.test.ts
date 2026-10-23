/**
 * @vitest-environment node
 *
 * NF2701 (DevLoop R27, from T-601) — migration v46: recover AUTHOR-INTENDED
 * llm:null from pre-fix rows. Pre-T-601, createAgent/updateAgent collapsed
 * an explicit `llm: null` to SQL NULL, destroying the distinction the fix
 * made first-class. The migration flips a row to explicit 'null' ONLY where
 * the proposal pipeline preserved the author's exact intent; every other
 * SQL NULL row stays as-is (bulk-flipping would force rule-only on agents
 * whose authors never authored an llm block — a behavior change, not
 * normalization). Also pins the LIVE-path half of the assessment: SQL NULL
 * bridges to key-omitted and resolveAgentLlmClient treats it as "use
 * shared".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environmentToScenario } from './environment-bridge.js';
import {
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { normalizeAgentLlmNullIntent } from './db/database.js';

describe('NF2701 — migration v46 agent llm:null intent recovery', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: 'Migration Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  // See agent-llm-null.vitest.test.ts: an unclosed app leaks its native
  // better-sqlite3 handle into worker-thread teardown (0xC0000005 risk).
  afterEach(async () => {
    await ctx?.cleanup();
  });

  function insertLegacyAgent(name: string, llmJson: string | null): string {
    const row = ctx.app.envStore.createAgent({
      envId,
      ownerId: owner.id,
      name,
      capabilities: [],
      ...(llmJson !== null ? { llm: JSON.parse(llmJson) as Record<string, unknown> } : {}),
    });
    if (llmJson === null) {
      // Fabricate the PRE-FIX storage state (post-T-601 createAgent with
      // llm:null would store 'null' — the whole point is the legacy shape).
      ctx.app.db
        .prepare('UPDATE agent_instances SET llm_json = NULL WHERE id = ?')
        .run(row.id);
    }
    return row.id;
  }

  function insertProposal(
    kind: 'modify-object' | 'install-agents',
    payload: Record<string, unknown>,
    status = 'applied',
  ): string {
    const id = `prop-${Math.random().toString(36).slice(2, 10)}`;
    ctx.app.db
      .prepare(
        `INSERT INTO proposals (id, env_id, author_id, kind, payload_json, risk_level, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'low', ?, ?)`,
      )
      .run(id, envId, owner.id, kind, JSON.stringify(payload), status, new Date().toISOString());
    return id;
  }

  function insertApplyLog(proposalId: string, after: Record<string, unknown>): void {
    ctx.app.db
      .prepare(
        `INSERT INTO command_log (env_id, actor_id, proposal_id, kind, payload_json, wall_time)
         VALUES (?, ?, ?, 'install-agents', ?, ?)`,
      )
      .run(envId, owner.id, proposalId, JSON.stringify({ before: null, after }), new Date().toISOString());
  }

  it('migration v46 is registered', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 46')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 46, name: 'agent-llm-null-intent-recovery' });
  });

  it('flips rows with POSITIVE null intent: applied modify-object patch.llm === null', () => {
    const legacy = insertLegacyAgent('Patch Null', null);
    insertProposal('modify-object', { targetId: legacy, patch: { llm: null } });

    const stats = normalizeAgentLlmNullIntent(ctx.app.db);
    expect(stats.modifyObject).toBe(1);
    expect(ctx.app.envStore.getAgent(legacy)!.llm_json).toBe('null');
  });

  it('flips install-agents created ids whose AUTHORED entry declared llm:null (index-parallel)', () => {
    const withBlock = insertLegacyAgent('With Block', '{"provider":"openai-compatible","model":"m"}');
    const explicitNull = insertLegacyAgent('Explicit Null', null);
    const proposalId = insertProposal('install-agents', {
      agents: [
        { name: 'With Block', capabilities: [], llm: { provider: 'openai-compatible', model: 'm' } },
        { name: 'Explicit Null', capabilities: [], llm: null },
      ],
    });
    insertApplyLog(proposalId, { agents: [{ id: withBlock }, { id: explicitNull }] });

    const stats = normalizeAgentLlmNullIntent(ctx.app.db);
    expect(stats.installAgents).toBe(1);
    expect(ctx.app.envStore.getAgent(explicitNull)!.llm_json).toBe('null');
    // The sibling with an authored BLOCK is untouched.
    expect(ctx.app.envStore.getAgent(withBlock)!.llm_json).toBe('{"provider":"openai-compatible","model":"m"}');
  });

  it('leaves evidence-less SQL NULL rows AS-IS (the honest default: absent = shared)', () => {
    const neverSpecified = insertLegacyAgent('Never Specified', null);
    // A modify-object proposal with a DIFFERENT patch is not null evidence.
    const other = insertLegacyAgent('Other Patch', null);
    insertProposal('modify-object', { targetId: other, patch: { name: 'Renamed' } });
    // Non-applied proposals are not evidence (the intent never landed).
    const reverted = insertLegacyAgent('Reverted', null);
    insertProposal('modify-object', { targetId: reverted, patch: { llm: null } }, 'reverted');

    const stats = normalizeAgentLlmNullIntent(ctx.app.db);
    expect(stats.modifyObject).toBe(0);
    expect(stats.installAgents).toBe(0);
    for (const agent of [neverSpecified, other, reverted]) {
      expect(ctx.app.envStore.getAgent(agent)!.llm_json).toBeNull();
    }
  });

  it('is idempotent (a second run flips nothing)', () => {
    const legacy = insertLegacyAgent('Patch Null', null);
    insertProposal('modify-object', { targetId: legacy, patch: { llm: null } });
    expect(normalizeAgentLlmNullIntent(ctx.app.db).modifyObject).toBe(1);
    expect(normalizeAgentLlmNullIntent(ctx.app.db)).toEqual({ modifyObject: 0, installAgents: 0 });
  });

  it('corrupt proposal payloads are skipped, never guessed', () => {
    const legacy = insertLegacyAgent('Corrupt Target', null);
    const id = insertProposal('modify-object', { targetId: legacy, patch: { llm: null } });
    ctx.app.db
      .prepare('UPDATE proposals SET payload_json = ? WHERE id = ?')
      .run('{not json', id);
    const stats = normalizeAgentLlmNullIntent(ctx.app.db);
    expect(stats.modifyObject).toBe(0);
    expect(ctx.app.envStore.getAgent(legacy)!.llm_json).toBeNull();
  });

  it('LIVE PATH (the assessment): a migrated row bridges to llm:null (rule-only); an evidence-less SQL NULL row bridges key-omitted (shared fall-through)', async () => {
    const migrated = insertLegacyAgent('Migrated', null);
    insertProposal('modify-object', { targetId: migrated, patch: { llm: null } });
    normalizeAgentLlmNullIntent(ctx.app.db);
    const absent = insertLegacyAgent('Absent', null);

    const env = ctx.app.envStore.getEnvironment(envId)!;
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    // The exact scenario-agent values the runtime's resolveAgentLlmClient
    // reads (its SQL-NULL handling is pinned by core's EngineRuntime.llm-null
    // suite + agent-llm-null link 2 — the assessment's live-path half).
    expect(scenario.agents.find(a => a.id === migrated)!.llm).toBeNull();
    expect(scenario.agents.find(a => a.id === absent)!.llm).toBeUndefined();
  });
});
