/**
 * @vitest-environment node
 *
 * R45 — shenzhen-realistic 分层城市场景的结构不变量。
 *
 * 这个场景的存在理由是语义（docs/plan-r45-realistic-city.md），不是规模：
 * 断言面因此全部是语义不变量——
 *  1. 生成器确定性 + 已提交 JSON 与再生成逐字节一致（防手改漂移）；
 *  2. loader 接受（模板画廊会自动发现该文件，验证失败会被画廊静默跳过）；
 *  3. 组织结构：61 个 agent = 48 管家 + 6 区协调 + 7 市中心，传感器无人管辖；
 *  4. 8 类设施能力面两两不可比（无模板复制）；
 *  5. 事件扇出面按引擎规则（managesZoneIds ∪ 绑定设备所在 zone）精确
 *     匹配设计意图——市级预警只到气象+应急、宝安内涝只到宝安泵站+区协调
 *     +市水务、恢复期只到区协调者；
 *  6. 跨区支援走廊（宝安↔南山变电站互邻）——nan-load-gap 的协作半径
 *     必须够得着宝安的发电机服务。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadScenarioFromFile, type ScenarioDefinition } from './index.js';

const REPO = join(__dirname, '../../../..');
const SCENARIO_FILE = join(REPO, 'config/scenarios/shenzhen-realistic.json');
const GENERATOR = join(REPO, 'scripts/generate-realistic-city.mjs');
const ENRICHER = join(REPO, 'scripts/enrich-scenario-osm.mjs');

const tmpDir = mkdtempSync(join(tmpdir(), 'r45-realistic-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** 与引擎 resolveManagingAgentIds 同一语义：管辖 zone = manages ∪ 绑定设备所在 zone。 */
function fanoutOf(def: ScenarioDefinition, zoneId: string): string[] {
  const deviceZone = new Map(def.devices.map(d => [d.id, d.zoneId]));
  return def.agents
    .filter(a => {
      const zones = new Set([
        ...(a.managesZoneIds ?? []),
        ...(a.boundDeviceIds ?? []).map(id => deviceZone.get(id)).filter((z): z is string => z !== undefined),
      ]);
      return zones.has(zoneId);
    })
    .map(a => a.id)
    .sort();
}

describe('R45 shenzhen-realistic — generator determinism & gallery validity', () => {
  it('regenerates byte-identical to the committed scenario JSON (generate → enrich pipeline)', () => {
    // R61-R64: the gallery JSON is the output of a TWO-stage pipeline — the
    // deterministic generator plus the enrich pass (OSM POI snap + census +
    // climate + Mangkhut calibration + real adjacency) whose inputs are all
    // COMMITTED (config/osm/*), so the whole pipeline stays reproducible.
    const regen = join(tmpDir, 'regen.json');
    execFileSync(process.execPath, [GENERATOR, '--out', regen], { cwd: REPO });
    execFileSync(process.execPath, [ENRICHER, regen, regen], {
      cwd: REPO,
      env: { ...process.env, OSM_SNAP: 'on' },
    });
    expect(readFileSync(regen, 'utf-8')).toBe(readFileSync(SCENARIO_FILE, 'utf-8'));
  }, 120_000);

  it('loads through the core loader (template-gallery contract)', () => {
    const def = loadScenarioFromFile(SCENARIO_FILE);
    expect(def.zones).toHaveLength(62); // 6 区 + 48 设施 + 1 市指挥域 + 7 市 HQ
    expect(def.devices).toHaveLength(1993);
    expect(def.agents).toHaveLength(61);
    expect(def.events.filter(e => !e.id.startsWith('mangkhut-'))).toHaveLength(17); // + 150 hourly series
  });
});

describe('R45 shenzhen-realistic — organizational structure', () => {
  const def = loadScenarioFromFile(SCENARIO_FILE);

  it('splits 61 agents into 48 keepers + 6 coordinators + 7 municipal centers', () => {
    const keepers = def.agents.filter(a => a.id.endsWith('-keeper'));
    const coordinators = def.agents.filter(a => a.id.endsWith('-coordinator'));
    const centers = def.agents.filter(a => a.id.startsWith('city-'));
    expect(keepers).toHaveLength(48);
    expect(coordinators).toHaveLength(6);
    expect(centers).toHaveLength(7);
  });

  it('keeps all 1800 grid sensors agent-unbound (data feeds the physics field, not an LLM)', () => {
    const bound = new Set(def.agents.flatMap(a => a.boundDeviceIds ?? []));
    const sensors = def.devices.filter(d => /-sn-[thwa]\d{3}$/.test(d.id));
    expect(sensors).toHaveLength(1800);
    expect(sensors.every(s => !bound.has(s.id))).toBe(true);
  });

  it('gives every keeper 3-5 devices and exactly one facility zone; coordinators own the whole district', () => {
    for (const a of def.agents) {
      if (a.id.endsWith('-keeper')) {
        expect(a.boundDeviceIds.length, a.id).toBeGreaterThanOrEqual(3);
        expect(a.boundDeviceIds.length, a.id).toBeLessThanOrEqual(5);
        expect(a.managesZoneIds, a.id).toHaveLength(1);
      }
      if (a.id.endsWith('-coordinator')) {
        expect(a.managesZoneIds, a.id).toHaveLength(9); // 1 district + 8 facility zones
        expect(a.boundDeviceIds, a.id).toHaveLength(1); // one representative observing device
      }
    }
  });

  it('keeps the 8 facility-kind capability faces pairwise incomparable (no template copies)', () => {
    const districtZones = def.zones.filter(z => z.type === 'district').map(z => z.id);
    expect(districtZones.length).toBeGreaterThan(0);
    for (const zoneId of districtZones) {
      const prefix = zoneId.split('-')[0];
      const kinds = ['substation', 'pump', 'shelter', 'hospital', 'school', 'hub', 'weather', 'metro'];
      const faces = kinds.map(k => {
        const keeper = def.agents.find(a => a.id === `${prefix}-${k}-keeper`);
        expect(keeper, `${prefix}-${k}-keeper`).toBeDefined();
        return new Set(keeper!.capabilities);
      });
      for (let i = 0; i < faces.length; i += 1) {
        for (let j = i + 1; j < faces.length; j += 1) {
          const sub = [...faces[i]].every(c => faces[j].has(c));
          const sup = [...faces[j]].every(c => faces[i].has(c));
          expect(sub || sup, `${kinds[i]} vs ${kinds[j]} in ${zoneId} must be incomparable`).toBe(false);
        }
      }
    }
  });

  it('runs every agent on the same vLLM-served model', () => {
    for (const a of def.agents) expect(a.llm?.model).toBe('ac-decision-v5');
  });

  it('R45-P1: all 7 municipal centers are coordinators (dispatcher, not executor) — keepers/coordinators are not', () => {
    for (const a of def.agents) {
      if (a.id.startsWith('city-')) {
        expect(a.decisionPolicy?.role, a.id).toBe('coordinator');
      } else {
        expect(a.decisionPolicy?.role, a.id).toBeUndefined();
      }
    }
  });
});

describe('R45 shenzhen-realistic — event fan-out by jurisdiction', () => {
  const def = loadScenarioFromFile(SCENARIO_FILE);

  const expected: Record<string, string[]> = {
    // 市级预警只到气象台 + 应急局（sz-city-command 唯二管辖者）
    'city-typhoon-blue': ['city-emergency', 'city-meteo'],
    'city-typhoon-landfall': ['city-emergency', 'city-meteo'],
    // 区级灾害：本区设施管家 + 区协调者 + 职能条线的市中心
    'bao-flood-critical': ['bao-coordinator', 'bao-pump-keeper', 'city-drainage'],
    'yan-storm-surge': ['city-drainage', 'yan-coordinator', 'yan-pump-keeper'],
    'nan-power-outage': ['city-energy', 'nan-coordinator', 'nan-substation-keeper'],
    'fu-evacuation-order': ['city-emergency', 'city-health', 'fu-coordinator', 'fu-shelter-keeper'],
    'luo-metro-ingress': ['city-drainage', 'luo-coordinator', 'luo-metro-keeper'],
    'yan-port-traffic': ['city-traffic', 'yan-coordinator', 'yan-hub-keeper'],
    'luo-hospital-casualty': ['city-health', 'luo-coordinator', 'luo-hospital-keeper'],
    'long-school-air': ['city-env', 'long-coordinator', 'long-school-keeper'],
    // yan-wind-gust superseded by the hourly series (R63)
    'nan-load-gap': ['city-energy', 'nan-coordinator', 'nan-substation-keeper'],
    // 恢复期例行确认：只到区协调者（不应惊动市级中心）
    'bao-recovery': ['bao-coordinator'],
    'nan-recovery': ['nan-coordinator'],
    'fu-recovery': ['fu-coordinator'],
    'luo-recovery': ['luo-coordinator'],
    'yan-recovery': ['yan-coordinator'],
    'long-recovery': ['long-coordinator'],
  };

  it('matches the designed fan-out for the semantic chain events', () => {
    // R63 appended 102+ hourly series events (same zones, hourly cadence) —
    // the fan-out CONTRACT covers the semantic chain, identified by the ids
    // the design enumerated (the series carries mangkhut-* ids).
    const semantic = def.events.filter(e => !e.id.startsWith('mangkhut-'));
    expect(semantic.map(e => e.id).sort()).toEqual(Object.keys(expected).sort());
    expect(def.events.filter(e => e.id.startsWith('mangkhut-')).length).toBeGreaterThan(90);
    for (const e of semantic) {
      expect(fanoutOf(def, e.zoneId), e.id).toEqual(expected[e.id]);
    }
  });

  it('keeps every event fan-out within the 1-8 semantic band (no district-wide broadcast)', () => {
    for (const e of def.events.filter(ev => !ev.id.startsWith('mangkhut-'))) {
      const n = fanoutOf(def, e.zoneId).length;
      expect(n, e.id).toBeGreaterThanOrEqual(1);
      expect(n, e.id).toBeLessThanOrEqual(8);
    }
  });

  it('preserves the Bao’an↔Nanshan substation support corridor (cross-district dispatch reachability)', () => {
    const bao = def.zones.find(z => z.id === 'bao-substation');
    const nan = def.zones.find(z => z.id === 'nan-substation');
    expect(bao?.adjacentZoneIds).toContain('nan-substation');
    expect(nan?.adjacentZoneIds).toContain('bao-substation');
    // city-energy must be able to reach Bao'an generators it may dispatch
    const energy = def.agents.find(a => a.id === 'city-energy');
    expect(energy?.boundDeviceIds).toEqual(
      expect.arrayContaining(['bao-substation-g1', 'bao-substation-g2']),
    );
  });
});
