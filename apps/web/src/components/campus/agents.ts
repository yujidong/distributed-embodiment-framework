/**
 * Campus agent avatars + collaboration edges:
 *
 * - one stylized avatar per agent (capsule body + hovering octahedron head,
 *   accent tint, white edge overlay like the buildings), with a GUI nameplate
 *   card pinned above (same linked-label plumbing as the building labels);
 * - collaboration edges between avatars, derived from the polled snapshot's
 *   advisory per-agent AC list (lib/campus3d `collabEdgesFromSnapshot`):
 *   running = solid bright line, forming = translucent dashed — the
 *   lib/collabGraph status semantics;
 * - the edge layer SYNCS in place (GeoWorldMap's R31-F1 discipline): keyed
 *   registry, created/removed only when an edge appears/disappears or its
 *   status flips (dash-ness is baked into the line kind, so a status flip
 *   recreates that one line) — the 4 s poll cadence never rebuilds the scene;
 * - UX-W4 agent 活化: avatars MIGRATE toward the zone of their latest
 *   decision (lib/agentActivity maps decisions → zone anchors; the render
 *   loop drives `tick` — a ~1 s smoothstep lerp writing body/head/nameplate
 *   positions IN PLACE, never a family rebuild) and drift home when the
 *   signal goes stale; a newly appearing collaboration edge pulses its line
 *   color once (edge-layer `tick`, same in-place discipline). Avatar meshes
 *   stay unfrozen for this — frozen world matrices would ignore the writes.
 *
 * Placement is pure (lib/campus3d `agentPlacements`).
 */

import {
  Color3,
  Color4,
  LinesMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import type { CampusAgentPlacement, CampusCollabEdge, Vec3 } from '../../lib/campus3d';
import { createCampusLabels, type CampusLabelThresholds, type CampusLabels } from './labels';

export interface CampusPickAgent {
  kind: 'agent';
  agentId: string;
  agentName: string;
}

/** Avatar accent — lib/theme light `accent` (#0b74bd), matching the 2D markers. */
const AGENT_COLOR = new Color3(0.043, 0.455, 0.741);
const NAMEPLATE_LIFT = 2.4;
/** Edge styling: accent solid (running) / translucent dashed (forming). */
const EDGE_RUNNING_COLOR = new Color3(0.043, 0.455, 0.741);
const EDGE_FORMING_COLOR = new Color3(0.48, 0.54, 0.62);
const EDGE_LIFT = 0.9;
/** UX-W4: 决策驱动迁移的时长（ms）与协作边出现瞬间的脉冲时长/颜色。 */
const MIGRATION_MS = 1000;
const EDGE_PULSE_MS = 1000;
const EDGE_PULSE_COLOR = new Color3(1, 0.85, 0.35);
/** Head hover offset above the capsule center (build-time constant). */
const HEAD_LIFT = 1.35;

export interface CampusAgentMeshes {
  /** Avatar meshes (picking + layer toggling). */
  meshes: Mesh[];
  /** agent id → avatar CURRENT position (edge endpoints; live during migration). */
  positionById: ReadonlyMap<string, Vec3>;
  /** Distance-tier refresh for nameplates (render loop, ~150 ms cadence). */
  update(cameraRadius: number): void;
  /**
   * UX-W4 agent 活化: 决策驱动的目标锚点表（agentId → scene meters，
   * lib/agentActivity 计算）；表外的 agent 回辖区原锚点。只登记差异 —
   * 位置写在 tick 里逐帧推进（原地写，不重建）。
   */
  setActivityTargets(targets: ReadonlyMap<string, Vec3>): void;
  /** 渲染循环驱动：推进迁移插值；返回 true = 仍有 avatar 在飞（调用方标 dirty）。 */
  tick(nowMs: number): boolean;
  /** 我的视角 (W5): avatars NOT owned by the focus owner render translucent. */
  setDimmed(dimIds: ReadonlySet<string> | null): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** Per-agent visual bundle (body + head + nameplate anchor key + motion state). */
interface AgentVisual {
  id: string;
  body: Mesh;
  head: Mesh;
  nameplateKey: string;
  /** 辖区锚点（placement 原始位置）—— 无活性信号时的归宿。 */
  home: Vec3;
  /** 当前写出位置（flight 起点）。 */
  current: Vec3;
  /** 收敛目标（activity target 或 home）。 */
  desired: Vec3;
  flight: { from: Vec3; to: Vec3; startAt: number } | null;
}

function vecEquals(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function lerpVec(from: Vec3, to: Vec3, k: number): Vec3 {
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    z: from.z + (to.z - from.z) * k,
  };
}

export function buildCampusAgents(
  scene: Scene,
  placements: readonly CampusAgentPlacement[],
  labelThresholds: CampusLabelThresholds,
): CampusAgentMeshes {
  const meshes: Mesh[] = [];
  const positionById = new Map<string, Vec3>();
  const nameplates: CampusLabels[] = [];
  const visuals = new Map<string, AgentVisual>();

  for (const placement of placements) {
    const { x, y, z } = placement.position;
    const body = MeshBuilder.CreateCapsule(`campus-agent-${placement.id}`, {
      radius: 0.45,
      height: 1.5,
      tessellation: 12,
      capSubdivisions: 6,
    }, scene);
    body.position.set(x, y, z);
    const material = new StandardMaterial(`campus-agent-${placement.id}-mat`, scene);
    material.diffuseColor = AGENT_COLOR;
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.Black();
    body.material = material;
    body.enableEdgesRendering();
    body.edgesWidth = 1.4;
    body.edgesColor = new Color4(1, 1, 1, 0.65);
    body.metadata = {
      pick: {
        kind: 'agent',
        agentId: placement.id,
        agentName: placement.name,
      } satisfies CampusPickAgent,
      baseColor: AGENT_COLOR,
    };
    // NOT frozen (UX-W4): decision-driven migration writes positions every
    // frame during a flight — freezeWorldMatrix would swallow the writes.
    meshes.push(body);

    // Hovering diamond above the capsule (twin-style "mind" marker).
    const head = MeshBuilder.CreatePolyhedron(`campus-agent-${placement.id}-head`, {
      type: 1,
      size: 0.28,
    }, scene);
    head.position.set(x, y + HEAD_LIFT, z);
    head.material = material;
    head.isPickable = false;
    meshes.push(head);

    const home = { x, y, z };
    positionById.set(placement.id, { ...home });
    visuals.set(placement.id, {
      id: placement.id,
      body,
      head,
      nameplateKey: `agent-${placement.id}`,
      home,
      current: { ...home },
      desired: { ...home },
      flight: null,
    });
  }

  if (placements.length > 0) {
    nameplates.push(
      createCampusLabels(
        scene,
        placements.map(placement => ({
          key: `agent-${placement.id}`,
          // Near-tier label (declutter: campus zoom keeps building names only).
          kind: 'agent' as const,
          text: placement.name,
          position: {
            x: placement.position.x,
            y: placement.position.y + NAMEPLATE_LIFT,
            z: placement.position.z,
          },
        })),
        labelThresholds,
      ),
    );
  }

  let enabled = true;
  let lastRadius = 0;
  let dimIds: ReadonlySet<string> | null = null;
  const applyNameplates = () => {
    // Past maxRadius every card hides — forces the layer-off state.
    for (const plate of nameplates) plate.update(enabled ? lastRadius : Number.MAX_VALUE);
  };
  /** In-place position write: body + head + nameplate anchor + edge endpoint map. */
  const writePosition = (visual: AgentVisual, pos: Vec3) => {
    visual.body.position.set(pos.x, pos.y, pos.z);
    visual.head.position.set(pos.x, pos.y + HEAD_LIFT, pos.z);
    for (const plate of nameplates) {
      plate.moveAnchor?.(visual.nameplateKey, { x: pos.x, y: pos.y + NAMEPLATE_LIFT, z: pos.z });
    }
    positionById.set(visual.id, { ...pos });
    visual.current = { ...pos };
  };
  return {
    meshes,
    positionById,
    update(cameraRadius: number) {
      lastRadius = cameraRadius;
      applyNameplates();
    },
    setActivityTargets(targets) {
      const now = performance.now();
      for (const visual of visuals.values()) {
        const next = targets.get(visual.id) ?? visual.home;
        if (vecEquals(next, visual.desired)) continue;
        visual.desired = { ...next };
        visual.flight = { from: { ...visual.current }, to: { ...next }, startAt: now };
      }
    },
    tick(nowMs) {
      let animating = false;
      for (const visual of visuals.values()) {
        if (!visual.flight) continue;
        const t01 = Math.min(Math.max((nowMs - visual.flight.startAt) / MIGRATION_MS, 0), 1);
        const k = t01 * t01 * (3 - 2 * t01); // smoothstep — 起步与落点都无速度跳变
        writePosition(visual, lerpVec(visual.flight.from, visual.flight.to, k));
        if (t01 >= 1) {
          visual.flight = null;
        } else {
          animating = true;
        }
      }
      return animating;
    },
    setDimmed(next) {
      dimIds = next;
      for (const mesh of meshes) {
        const agentId = (mesh.metadata?.pick as CampusPickAgent | undefined)?.agentId;
        if (!agentId) continue;
        (mesh.material as StandardMaterial).alpha = dimIds?.has(agentId) ? 0.3 : 1;
      }
    },
    setEnabled(next: boolean) {
      enabled = next;
      for (const mesh of meshes) mesh.setEnabled(enabled);
      applyNameplates();
    },
    dispose() {
      for (const plate of nameplates) plate.dispose();
      // disposeMaterialAndTextures=true — per-agent materials are ours;
      // without it every family rebuild leaks them (batch C1).
      for (const mesh of meshes) mesh.dispose(false, true);
    },
  };
}

// ---------------------------------------------------------------------------
// Collaboration edge layer (in-place keyed sync)
// ---------------------------------------------------------------------------

export interface CampusCollabEdgeLayer {
  sync(edges: readonly CampusCollabEdge[], positionById: ReadonlyMap<string, Vec3>): void;
  /**
   * UX-W4: 新边出现瞬间的颜色脉冲推进（line 颜色/透明度原地写回）；
   * 返回 true = 仍有脉冲在播（调用方标 dirty）。
   */
  tick(nowMs: number): boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createCollabEdgeLayer(scene: Scene): CampusCollabEdgeLayer {
  interface EdgeEntry {
    line: LinesMesh;
    status: CampusCollabEdge['status'];
    baseColor: Color3;
    baseAlpha: number;
    /** Wall-ms pulse expiry (0 = not pulsing). */
    pulseUntil: number;
  }
  const registry = new Map<string, EdgeEntry>();
  let enabled = true;

  const makeLine = (edge: CampusCollabEdge, from: Vec3, to: Vec3): LinesMesh => {
    const points = [
      new Vector3(from.x, from.y + EDGE_LIFT, from.z),
      new Vector3(to.x, to.y + EDGE_LIFT, to.z),
    ];
    const line =
      edge.status === 'running'
        ? MeshBuilder.CreateLines(`campus-edge-${edge.key}`, { points, updatable: false }, scene)
        : MeshBuilder.CreateDashedLines(
            `campus-edge-${edge.key}`,
            { points, dashSize: 1.2, gapSize: 0.8, updatable: false },
            scene,
          );
    line.color = edge.status === 'running' ? EDGE_RUNNING_COLOR : EDGE_FORMING_COLOR;
    line.alpha = edge.status === 'running' ? 0.95 : 0.55;
    line.isPickable = false;
    line.setEnabled(enabled);
    return line;
  };

  return {
    sync(edges, positionById) {
      const seen = new Set<string>();
      for (const edge of edges) {
        const from = positionById.get(edge.from);
        const to = positionById.get(edge.to);
        if (!from || !to) continue;
        seen.add(edge.key);
        const existing = registry.get(edge.key);
        // Dash-ness is baked into the line kind — a status flip recreates
        // just this one line (positions are static per avatar family build).
        // 状态翻转重建不脉冲（同一条边）；只有全新出现的 key 脉冲一次。
        if (existing && existing.status === edge.status) continue;
        existing?.line.dispose();
        registry.set(edge.key, {
          line: makeLine(edge, from, to),
          status: edge.status,
          baseColor: edge.status === 'running' ? EDGE_RUNNING_COLOR : EDGE_FORMING_COLOR,
          baseAlpha: edge.status === 'running' ? 0.95 : 0.55,
          pulseUntil: existing ? 0 : performance.now() + EDGE_PULSE_MS,
        });
      }
      for (const [key, entry] of registry) {
        if (!seen.has(key)) {
          entry.line.dispose();
          registry.delete(key);
        }
      }
    },
    tick(nowMs) {
      let active = false;
      for (const entry of registry.values()) {
        if (entry.pulseUntil <= 0) continue;
        const remain = entry.pulseUntil - nowMs;
        if (remain <= 0) {
          entry.pulseUntil = 0;
          entry.line.color = entry.baseColor;
          entry.line.alpha = entry.baseAlpha;
          continue;
        }
        active = true;
        const k = remain / EDGE_PULSE_MS; // 1 → 0：亮度随余量衰减
        entry.line.color = Color3.Lerp(entry.baseColor, EDGE_PULSE_COLOR, k);
        entry.line.alpha = Math.min(1, entry.baseAlpha + 0.45 * k);
      }
      return active;
    },
    setEnabled(next: boolean) {
      enabled = next;
      for (const entry of registry.values()) entry.line.setEnabled(enabled);
    },
    dispose() {
      for (const entry of registry.values()) entry.line.dispose();
      registry.clear();
    },
  };
}
