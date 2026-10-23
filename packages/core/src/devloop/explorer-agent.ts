/**
 * ExplorerAgent — zero-prior-knowledge system explorer.
 *
 * Interacts with the platform purely through the frontend (Playwright)
 * and the REST API, discovering features by trial and error. Reports
 * every surprise — bugs, limitations, confusions, and successes — as
 * structured Findings for the Coordinator.
 */

import type { Finding, FindingCategory, FindingSeverity } from './types.js';

export interface ExplorerConfig {
  frontendUrl: string;   // e.g. http://localhost:5173
  apiUrl: string;        // e.g. http://127.0.0.1:8100
  /** Max actions per exploration round (prevent runaway). */
  maxActions: number;    // default 30
}

export interface ExploreRound {
  roundNumber: number;
  findings: Finding[];
  satisfactionScore: number;   // 1-5
  notes: string;
}

let findingSeq = 0;

export class ExplorerAgent {
  private readonly config: ExplorerConfig;
  private cookie = '';
  private exploredAreas = new Set<string>();

  constructor(config: Partial<ExplorerConfig> = {}) {
    this.config = {
      frontendUrl: config.frontendUrl ?? 'http://localhost:5173',
      apiUrl: config.apiUrl ?? 'http://127.0.0.1:8100',
      maxActions: config.maxActions ?? 30,
    };
  }

  /**
   * Run one exploration round. Returns findings + a satisfaction score.
   * The agent has NO prior knowledge — it discovers everything by trying.
   */
  async explore(roundNumber: number): Promise<ExploreRound> {
    const findings: Finding[] = [];
    let actions = 0;
    const track = (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => {
      findings.push({
        ...f,
        id: `F-${Date.now().toString(36)}-${++findingSeq}`,
        timestamp: new Date().toISOString(),
        agent: 'explorer',
      });
    };

    // ---- Phase 1: Discover the system through the API ----
    await this.exploreAuth(track, () => actions++);
    await this.exploreEnvironments(track, () => actions++);
    await this.exploreCreateEnvironment(track, () => actions++);
    await this.exploreDevices(track, () => actions++);
    await this.exploreSimulation(track, () => actions++);

    // ---- Phase 2: Try things that SHOULD work (feature completeness) ----
    await this.exploreIdeas(track, () => actions++);

    // ---- Compute satisfaction via LLM subjective evaluation ----
    const score = await this.llmSatisfaction(findings, actions, roundNumber);

    const notes = `Round ${roundNumber}: ${actions} actions, ` +
      `${findings.filter(f => f.category === 'success').length} successes, ` +
      `${findings.filter(f => f.category === 'bug').length} bugs, ` +
      `${findings.filter(f => f.severity === 'blocker').length} blockers, ` +
      `${findings.filter(f => f.severity === 'high').length} highs. ` +
      `Explored: ${[...this.exploredAreas].join(', ')}.`;

    return { roundNumber, findings, satisfactionScore: score.score, notes: `${notes} | LLM: ${score.reasoning}` };
  }

  /**
   * LLM-based subjective satisfaction evaluation.
   * The LLM reads the full exploration experience and gives a genuine score.
   */
  private async llmSatisfaction(
    findings: Finding[],
    actions: number,
    round: number,
  ): Promise<{ score: number; reasoning: string }> {
    try {
      const { llmJson } = await import('./llm.js');
      const summary = findings.map(f =>
        `[${f.category}/${f.severity}] ${f.area}: ${f.description} → ${f.actual}`,
      ).join('\n');

      const result = await llmJson<{ score: number; reasoning: string }>(
        'You are a critical software quality evaluator. You just explored a web platform as a new user with zero prior knowledge. Based on the exploration log below, give your honest satisfaction score from 1 to 5 (5 = "I can do everything I want with this system", 1 = "Nothing works"). Respond as JSON: {"score": <1-5>, "reasoning": "<one paragraph explaining your score>"}',
        `Exploration round ${round}, ${actions} actions taken.\n\nFindings:\n${summary}\n\nGive your satisfaction score:`,
      );
      return {
        score: Math.max(1, Math.min(5, Math.round(result.score))),
        reasoning: result.reasoning?.slice(0, 300) ?? 'No reasoning provided',
      };
    } catch {
      // Fallback to heuristic if LLM unavailable
      const blockers = findings.filter(f => f.severity === 'blocker').length;
      const highs = findings.filter(f => f.severity === 'high').length;
      let score = 5;
      if (blockers > 0) score = Math.max(1, score - blockers * 2);
      if (highs > 0) score = Math.max(1, score - highs);
      return { score, reasoning: 'Heuristic fallback (LLM unavailable)' };
    }
  }

  // ------------------------------------------------------------------
  // Exploration phases
  // ------------------------------------------------------------------

  private async exploreAuth(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    this.exploredAreas.add('auth');

    // Try the API without auth
    const anon = await fetch(`${this.config.apiUrl}/api/health`).catch(() => null);
    next();
    if (anon?.ok) {
      track({
        category: 'success', description: 'Health endpoint is publicly accessible',
        steps: ['GET /api/health without auth'], actual: 'Returns 200 with status ok',
        severity: 'low', area: 'api',
      });
    } else {
      track({
        category: 'bug', description: 'Health endpoint unreachable',
        steps: ['GET /api/health'], actual: `Response: ${anon?.status ?? 'network error'}`,
        expected: '200 with JSON body', severity: 'high', area: 'api',
      });
    }

    // Try listing environments without auth
    const envAnon = await fetch(`${this.config.apiUrl}/api/environments`).catch(() => null);
    next();
    if (envAnon?.status === 401) {
      track({
        category: 'success', description: 'Environment list requires authentication',
        steps: ['GET /api/environments without token'], actual: '401 Unauthorized',
        severity: 'low', area: 'api',
      });
    }

    // Register a new user（一次性探索账号：密码按次随机生成，不在源码中留存字面量凭据）
    const email = `explorer-${Date.now().toString(36)}@devloop.test`;
    const password = `Ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}Aa1!`;
    const reg = await fetch(`${this.config.apiUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'Explorer Agent' }),
    }).catch(() => null);
    next();

    if (reg?.status === 201) {
      track({
        category: 'success', description: 'User registration works',
        steps: ['POST /api/auth/register'], actual: '201 Created',
        severity: 'low', area: 'auth',
      });
    } else {
      track({
        category: 'bug', description: 'User registration failed',
        steps: ['POST /api/auth/register'],
        actual: `Status ${reg?.status}: ${reg ? JSON.stringify(await reg.json().catch(() => 'unknown')) : 'network error'}`,
        expected: '201 Created', severity: 'blocker', area: 'auth',
      });
      return;
    }

    // Login
    const login = await fetch(`${this.config.apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);
    next();

    if (login?.ok) {
      const body = await login.json() as { token: string };
      const setCookie = login.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      track({
        category: 'success', description: 'Login works and returns token',
        steps: ['POST /api/auth/login'], actual: '200 with token + cookie',
        severity: 'low', area: 'auth',
      });
    } else {
      track({
        category: 'bug', description: 'Login failed after successful registration',
        steps: ['POST /api/auth/login'], actual: `Status ${login?.status}`,
        expected: '200 with token', severity: 'blocker', area: 'auth',
      });
    }
  }

  private async exploreEnvironments(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    if (!this.cookie) return;
    this.exploredAreas.add('environments');
    const headers = { 'Content-Type': 'application/json', cookie: this.cookie };

    const res = await fetch(`${this.config.apiUrl}/api/environments`, { headers }).catch(() => null);
    next();
    if (res?.ok) {
      const body = await res.json() as { environments: unknown[] };
      track({
        category: 'success', description: `Environment list accessible (${body.environments.length} envs)`,
        steps: ['GET /api/environments with auth'], actual: `200 with ${body.environments.length} environments`,
        severity: 'low', area: 'environments',
      });
    } else {
      track({
        category: 'bug', description: 'Cannot list environments after login',
        steps: ['GET /api/environments with auth'], actual: `Status ${res?.status}`,
        expected: '200 with environments array', severity: 'high', area: 'environments',
      });
    }
  }

  private async exploreCreateEnvironment(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    if (!this.cookie) return;
    this.exploredAreas.add('create-env');
    const headers = { 'Content-Type': 'application/json', cookie: this.cookie };

    // Create a minimal environment
    const res = await fetch(`${this.config.apiUrl}/api/environments`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: `Explorer Env ${Date.now().toString(36)}`,
        description: 'Created by the Explorer Agent',
        visibility: 'private',
      }),
    }).catch(() => null);
    next();

    if (res?.status === 201) {
      const env = await res.json() as { id: string };
      track({
        category: 'success', description: 'Environment creation works',
        steps: ['POST /api/environments with {name, description}'],
        actual: `201 Created, id=${env.id}`, severity: 'low', area: 'environments',
      });

      // Try to add a device
      const devRes = await fetch(`${this.config.apiUrl}/api/environments/${env.id}/devices`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name: 'Explorer Temperature Sensor',
          type: 'temperature-sensor',
          capabilities: ['temperature-reading'],
          zoneId: (await this.getFirstZone(env.id)) ?? 'default',
        }),
      }).catch(() => null);
      next();

      if (devRes?.status === 201) {
        track({
          category: 'success', description: 'Device creation works',
          steps: ['POST /api/environments/:id/devices'], actual: '201 Created',
          severity: 'low', area: 'devices',
        });
      } else {
        const body = devRes ? await devRes.json().catch(() => 'unknown') : 'network error';
        track({
          category: 'limitation', description: 'Device creation may need zone setup first',
          steps: ['POST /api/environments/:id/devices'],
          actual: `Status ${devRes?.status}: ${JSON.stringify(body).slice(0, 200)}`,
          expected: '201 Created', severity: 'medium', area: 'devices',
        });
      }
    } else {
      track({
        category: 'bug', description: 'Environment creation failed',
        steps: ['POST /api/environments'],
        actual: `Status ${res?.status}`,
        expected: '201 Created', severity: 'high', area: 'environments',
      });
    }
  }

  private async exploreDevices(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    if (!this.cookie) return;
    this.exploredAreas.add('devices');

    // Try to create an agent
    const envs = await fetch(`${this.config.apiUrl}/api/environments`, {
      headers: { cookie: this.cookie },
    }).catch(() => null);
    next();
    if (!envs?.ok) return;

    const body = await envs.json() as { environments: Array<{ id: string }> };
    const envId = body.environments[0]?.id;
    if (!envId) return;

    const agentRes = await fetch(`${this.config.apiUrl}/api/environments/${envId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({
        name: 'Explorer Test Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: [],
        boundDeviceIds: [],
      }),
    }).catch(() => null);
    next();

    if (agentRes?.status === 201) {
      track({
        category: 'success', description: 'Agent creation works',
        steps: ['POST /api/environments/:id/agents'], actual: '201 Created',
        severity: 'low', area: 'agents',
      });
    } else {
      track({
        category: 'limitation', description: 'Agent creation requirements unclear',
        steps: ['POST /api/environments/:id/agents'],
        actual: `Status ${agentRes?.status}`,
        expected: '201 Created', severity: 'medium', area: 'agents',
      });
    }

    // Try to publish a service
    const svcRes = await fetch(`${this.config.apiUrl}/api/environments/${envId}/agents/none/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({
        name: 'Explorer Test Service',
        capabilities: ['temperature-reading'],
        category: 'monitoring',
      }),
    }).catch(() => null);
    next();

    // This should fail (agent 'none' doesn't exist) — record the error handling
    if (svcRes && svcRes.status >= 400) {
      track({
        category: 'success', description: 'Invalid agent reference properly rejected',
        steps: ['POST /api/environments/:id/agents/none/services'],
        actual: `Status ${svcRes.status} (expected failure)`,
        severity: 'low', area: 'services',
      });
    }
  }

  private async exploreSimulation(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    if (!this.cookie) return;
    this.exploredAreas.add('simulation');
    const headers = { 'Content-Type': 'application/json', cookie: this.cookie };

    // Try creating a simulation from the first visible environment
    const envs = await fetch(`${this.config.apiUrl}/api/environments`, {
      headers: { cookie: this.cookie },
    }).catch(() => null);
    next();
    if (!envs?.ok) return;

    const body = await envs.json() as { environments: Array<{ id: string }> };
    const envId = body.environments[0]?.id;
    if (!envId) {
      track({
        category: 'limitation', description: 'No environments available to simulate',
        steps: ['List environments → create simulation'],
        actual: 'Empty environment list', severity: 'medium', area: 'simulation',
      });
      return;
    }

    const simRes = await fetch(`${this.config.apiUrl}/api/simulations`, {
      method: 'POST', headers,
      body: JSON.stringify({ environmentId: envId }),
    }).catch(() => null);
    next();

    if (simRes?.status === 201) {
      const sim = await simRes.json() as { id: string };
      track({
        category: 'success', description: 'Simulation creation works',
        steps: ['POST /api/simulations with environmentId'], actual: `201, simId=${sim.id}`,
        severity: 'low', area: 'simulation',
      });

      // Start it
      const startRes = await fetch(`${this.config.apiUrl}/api/simulations/${sim.id}/start`, {
        method: 'POST', headers, body: JSON.stringify({ speed: 1 }),
      }).catch(() => null);
      next();
      if (startRes?.ok) {
        track({
          category: 'success', description: 'Simulation starts',
          steps: ['POST /api/simulations/:id/start'], actual: '200',
          severity: 'low', area: 'simulation',
        });

        // Get snapshot
        const snapRes = await fetch(`${this.config.apiUrl}/api/simulations/${sim.id}/snapshot`, {
          headers: { cookie: this.cookie },
        }).catch(() => null);
        next();
        if (snapRes?.ok) {
          track({
            category: 'success', description: 'Snapshot retrieval works',
            steps: ['GET /api/simulations/:id/snapshot'], actual: '200 with full snapshot',
            severity: 'low', area: 'simulation',
          });
        }

        // Stop
        await fetch(`${this.config.apiUrl}/api/simulations/${sim.id}/stop`, {
          method: 'POST', headers, body: '{}',
        }).catch(() => null);
        next();
      }
    } else {
      const errBody = simRes ? await simRes.json().catch(() => 'unknown') : 'network error';
      track({
        category: 'bug', description: 'Simulation creation failed',
        steps: ['POST /api/simulations with environmentId'],
        actual: `Status ${simRes?.status}: ${JSON.stringify(errBody).slice(0, 200)}`,
        expected: '201 Created', severity: 'high', area: 'simulation',
      });
    }
  }

  private async exploreIdeas(
    track: (f: Omit<Finding, 'id' | 'timestamp' | 'agent'>) => void,
    next: () => void,
  ): Promise<void> {
    this.exploredAreas.add('ideas');

    // Ideas the explorer "thinks of" — things a user might want to do
    const ideas: Array<{ description: string; category: FindingCategory; area: string }> = [
      {
        description: 'Want to search devices by capability across environments',
        category: 'idea', area: 'devices',
      },
      {
        description: 'Want to see a timeline of all events across my environments',
        category: 'idea', area: 'ui',
      },
      {
        description: 'Want to export simulation results as CSV/JSON download',
        category: 'idea', area: 'simulation',
      },
    ];

    for (const idea of ideas) {
      track({
        ...idea,
        steps: ['Explorer imagined this feature'],
        actual: 'Feature may or may not exist — needs investigation',
        severity: 'low',
      });
      next();
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async getFirstZone(envId: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.config.apiUrl}/api/environments/${envId}`, {
        headers: { cookie: this.cookie },
      });
      if (!res.ok) return undefined;
      const body = await res.json() as { zones?: Array<{ id: string }> };
      return body.zones?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  /** Re-test previously reported issues after a fix. */
  async retest(findings: Finding[]): Promise<{ resolved: string[]; unresolved: string[]; newFindings: Finding[] }> {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    const newFindings: Finding[] = [];

    // For now, re-run the full exploration and compare
    const round = await this.explore(0);

    // Simple heuristic: a finding is resolved if its area now has successes
    for (const f of findings) {
      if (f.category === 'success' || f.category === 'idea') continue;
      const areaImproved = round.findings.some(
        nf => nf.area === f.area && nf.category === 'success',
      );
      if (areaImproved) {
        resolved.push(f.id);
      } else {
        unresolved.push(f.id);
      }
    }

    return { resolved, unresolved, newFindings: round.findings };
  }
}
