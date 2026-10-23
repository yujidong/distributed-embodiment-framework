/**
 * Flow ↔ reactflow graph serialization (FlowsPage canvas editor).
 *
 * One trigger node (type 'trigger', id TRIGGER_NODE_ID) plus one card node
 * per plan node (type 'action' / 'delegate' / 'service' / 'notify' / 'wait',
 * id = PlanNode.id). Edges encode `dependsOn`
 * (dep → node); the trigger node carries no edges — action nodes without
 * dependsOn are the first wave by definition.
 *
 * Layout is a simple layered pass (Kahn waves): wave index → x column, index
 * within the wave → y row. No external layout dependency.
 *
 * graphToFlow re-validates for immediate feedback (the server re-runs the
 * core validateFlow pass on save anyway): cycles and self-loops are errors,
 * isolated action nodes (no edges at all while other action nodes exist)
 * are warnings. Edges touching the trigger node are ignored with a warning —
 * the trigger has no dependency semantics.
 */

import type { Edge, Node } from 'reactflow';

import type {
  Flow,
  FlowDelegateNode,
  FlowNotifyNode,
  FlowPlanAnyNode,
  FlowPlanNode,
  FlowServiceNode,
  FlowTrigger,
  FlowWaitNode,
} from '../api/types';
import i18n from '../i18n/config';

export const TRIGGER_NODE_ID = 'trigger';

export const TRIGGER_KIND_LABEL: Record<FlowTrigger['kind'], string> = new Proxy(
  {} as Record<FlowTrigger['kind'], string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string') {
        if (prop === 'event') return i18n.t('flowGraphLib:triggerKindEvent');
        if (prop === 'condition') return i18n.t('flowGraphLib:triggerKindCondition');
        if (prop === 'schedule') return i18n.t('flowGraphLib:triggerKindSchedule');
      }
      return undefined as unknown as string;
    },
  },
);

/** Minimal data payloads; the node components extend these with callbacks. */
export interface TriggerNodeData {
  trigger: FlowTrigger;
}

export interface ActionNodeData {
  planNode: FlowPlanNode;
}

/** Mechanism A: delegate node card payload (canvas renders it read-only in v1). */
export interface DelegateNodeData {
  planNode: FlowDelegateNode;
}

/** R6-B-F03: service node card payload (canvas renders it read-only). */
export interface ServiceNodeData {
  planNode: FlowServiceNode;
}

/** FEAT-05 / R2-FEAT-06: notify node card payload (canvas-authored). */
export interface NotifyNodeData {
  planNode: FlowNotifyNode;
}

/** FEAT-06 / R2-FEAT-06: wait node card payload (canvas-authored). */
export interface WaitNodeData {
  planNode: FlowWaitNode;
}

export type FlowGraphNode = Node<
  TriggerNodeData | ActionNodeData | DelegateNodeData | ServiceNodeData | NotifyNodeData | WaitNodeData
>;

export interface FlowGraphIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

// Layout metrics (px) — wide columns: the node cards carry inline forms.
const TRIGGER_X = 0;
const TRIGGER_Y = 60;
const COLUMN_X = 480;
const COLUMN_GAP = 460;
const ROW_GAP = 260;

// ---------------------------------------------------------------------------
// flowToGraph
// ---------------------------------------------------------------------------

/**
 * Layered layout: Kahn waves over the dependsOn DAG. Cyclic leftovers are
 * appended in one final column so a broken draft still renders (the cycle is
 * reported on serialize/save).
 */
function layeredPositions(
  planNodes: ReadonlyArray<Pick<FlowPlanNode, 'id'> & { dependsOn?: string[] }>,
): Map<string, { x: number; y: number }> {
  const ids = planNodes.map(node => node.id);
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const node of planNodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!idSet.has(dep) || dep === node.id) continue;
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependents.get(dep)!.push(node.id);
    }
  }

  const waveOf = new Map<string, number>();
  let wave = ids.filter(id => (indegree.get(id) ?? 0) === 0);
  let depth = 0;
  const placed = new Set<string>();
  while (wave.length > 0) {
    const next: string[] = [];
    for (const id of wave) {
      waveOf.set(id, depth);
      placed.add(id);
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    wave = next;
    depth += 1;
  }
  // Cyclic leftovers: one extra column, plan order preserved.
  const leftovers = ids.filter(id => !placed.has(id));
  for (const id of leftovers) waveOf.set(id, depth);

  const rowCount = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const column = waveOf.get(id) ?? 0;
    const row = rowCount.get(column) ?? 0;
    rowCount.set(column, row + 1);
    positions.set(id, { x: COLUMN_X + column * COLUMN_GAP, y: row * ROW_GAP });
  }
  return positions;
}

/** Node-type discriminant: the mutually exclusive block a plan node carries. */
function planNodeType(planNode: Flow['plan']['nodes'][number]): 'action' | 'delegate' | 'service' | 'notify' | 'wait' {
  if ('delegate' in planNode) return 'delegate';
  if ('service' in planNode) return 'service';
  if ('notify' in planNode) return 'notify';
  if ('wait' in planNode) return 'wait';
  return 'action';
}

/** Serialize a flow definition into reactflow nodes + dependsOn edges. */
export function flowToGraph(flow: Pick<Flow, 'trigger' | 'plan'>): {
  nodes: FlowGraphNode[];
  edges: Edge[];
} {
  const positions = layeredPositions(flow.plan.nodes);
  const nodes: FlowGraphNode[] = [
    {
      id: TRIGGER_NODE_ID,
      type: 'trigger',
      position: { x: TRIGGER_X, y: TRIGGER_Y },
      data: { trigger: flow.trigger } satisfies TriggerNodeData,
      deletable: false,
    },
    ...flow.plan.nodes.map((planNode): FlowGraphNode => {
      const position = positions.get(planNode.id) ?? { x: COLUMN_X, y: 0 };
      // Mechanism A & co.: a node carrying a non-action block renders on its
      // own card (delegate / service stay read-only; notify / wait are
      // canvas-authored since R2-FEAT-06). (planNodeType keeps `type` and
      // the data payload correlated; TS cannot see that through the union,
      // hence the cast.)
      return {
        id: planNode.id,
        type: planNodeType(planNode),
        position,
        data: { planNode: { ...planNode, dependsOn: [...(planNode.dependsOn ?? [])] } },
      } as FlowGraphNode;
    }),
  ];
  const idSet = new Set(flow.plan.nodes.map(node => node.id));
  const edges: Edge[] = [];
  for (const planNode of flow.plan.nodes) {
    for (const dep of planNode.dependsOn ?? []) {
      // Dangling refs cannot be drawn; the server-side validator reports them.
      if (!idSet.has(dep) || dep === planNode.id) continue;
      edges.push({
        id: `${dep}->${planNode.id}`,
        source: dep,
        target: planNode.id,
      });
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// graphToFlow
// ---------------------------------------------------------------------------

/** Any plan node card (action or one of the block kinds) — all serialize into plan.nodes. */
function isPlanNodeCard(node: Node): boolean {
  return (
    node.type === 'action' ||
    node.type === 'delegate' ||
    node.type === 'service' ||
    node.type === 'notify' ||
    node.type === 'wait'
  );
}

/** Detect a cycle over dependsOn edges (Kahn leftover). */
function findCycle(dependsOn: Map<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, deps] of dependsOn) {
    indegree.set(id, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), id]);
    }
  }
  const queue = [...dependsOn.keys()].filter(id => (indegree.get(id) ?? 0) === 0);
  const placed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    placed.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  return [...dependsOn.keys()].filter(id => !placed.has(id));
}

/**
 * Re-serialize the canvas into a trigger + plan nodes, with immediate
 * validation issues. Node order follows canvas order (stable across
 * round-trips); dependsOn order follows edge insertion order.
 */
export function graphToFlow(
  nodes: readonly Node[],
  edges: readonly Edge[],
): {
  trigger: FlowTrigger | null;
  planNodes: FlowPlanAnyNode[];
  issues: FlowGraphIssue[];
} {
  const issues: FlowGraphIssue[] = [];

  const triggerNode = nodes.find(node => node.id === TRIGGER_NODE_ID || node.type === 'trigger');
  const trigger =
    triggerNode !== undefined
      ? ((triggerNode.data as TriggerNodeData).trigger ?? null)
      : null;
  if (trigger === null) {
    issues.push({ level: 'error', message: i18n.t('flowGraphLib:errorMissingTrigger') });
  }

  const actionNodes = nodes.filter(isPlanNodeCard);
  const actionIds = new Set(actionNodes.map(node => node.id));

  const dependsOn = new Map<string, string[]>();
  const touched = new Set<string>();
  for (const node of actionNodes) dependsOn.set(node.id, []);

  for (const edge of edges) {
    if (edge.source === edge.target) {
      issues.push({ level: 'error', nodeId: edge.target, message: i18n.t('flowGraphLib:errorSelfLoop') });
      continue;
    }
    if (edge.source === TRIGGER_NODE_ID || edge.target === TRIGGER_NODE_ID) {
      issues.push({
        level: 'warning',
        message: i18n.t('flowGraphLib:warningTriggerIgnored'),
      });
      continue;
    }
    if (!actionIds.has(edge.source) || !actionIds.has(edge.target)) continue;
    dependsOn.get(edge.target)!.push(edge.source);
    touched.add(edge.source);
    touched.add(edge.target);
  }

  const cyclic = findCycle(dependsOn);
  for (const id of cyclic) {
    issues.push({ level: 'error', nodeId: id, message: i18n.t('flowGraphLib:errorCycle') });
  }

  if (actionNodes.length > 1) {
    for (const node of actionNodes) {
      if (!touched.has(node.id)) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: i18n.t('flowGraphLib:warningIsolated', { nodeId: node.id }),
        });
      }
    }
  }

  const planNodes: FlowPlanAnyNode[] = actionNodes.map(node => {
    const planNode = (
      node.data as
        | ActionNodeData
        | DelegateNodeData
        | ServiceNodeData
        | NotifyNodeData
        | WaitNodeData
    ).planNode;
    const deps = dependsOn.get(node.id) ?? [];
    const { dependsOn: _dropped, ...rest } = planNode;
    return { ...rest, ...(deps.length > 0 ? { dependsOn: deps } : {}) };
  });

  return { trigger, planNodes, issues };
}
