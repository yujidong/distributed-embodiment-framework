/**
 * CollaborationGraph — standalone reactflow canvas: agents as fixed nodes on
 * a circle, dynamic edges derived from the WS event stream (deriveCollabEdges).
 *
 * RETIRED FROM THE CONSOLE LAYOUT (W7): collaborations now render as a layer
 * on the map canvases (WorldMap / GeoWorldMap `collabEdges` prop). The
 * component is kept for reuse/debug views.
 *
 * Layout is STATIC: node positions are memoized from the agent id list only,
 * never recomputed when edges change (edge-driven re-layout is a classic
 * jitter bug). Edge styles: forming = animated dashed, running = solid
 * accent, completed = solid green, failed = red; terminal edges fade out via
 * deriveCollabEdges' wall-clock keep windows, so a 1s ticker re-derives
 * while any edge exists.
 */

import { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useTranslation } from 'react-i18next';

import type { SnapshotAgent } from '../api/types';
import { deriveCollabEdges } from '../lib/collabGraph';
import { collabEdgeColors, mapColors } from '../lib/theme';
import { useAppStore } from '../store/useAppStore';

const CANVAS_CENTER_X = 210;
const CANVAS_CENTER_Y = 150;
const RADIUS_X = 170;
const RADIUS_Y = 105;
const NODE_W = 132;

export interface CollabAgentNodeData {
  name: string;
  agentId: string;
  activeACCount: number;
  llmEnabled: boolean;
}

function CollabAgentNode({ data }: NodeProps<CollabAgentNodeData>) {
  const { t } = useTranslation('collaborationGraph');
  return (
    <div className="collab-node">
      <Handle type="target" position={Position.Top} className="zone-handle" />
      <div className="collab-node__name">{data.name}</div>
      <div className="collab-node__id" title={data.agentId}>{data.agentId}</div>
      {data.activeACCount > 0 && (
        <span className="collab-node__badge" title={t('activeAcTitle')}>
          AC×{data.activeACCount}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="zone-handle" />
    </div>
  );
}

const nodeTypes = { collabAgent: CollabAgentNode };

/** Fixed circle positions, keyed by agent id — stable across edge updates. */
function circlePositions(agentIds: string[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const sorted = [...agentIds].sort();
  sorted.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / Math.max(sorted.length, 1) - Math.PI / 2;
    positions.set(id, {
      x: CANVAS_CENTER_X + RADIUS_X * Math.cos(angle) - NODE_W / 2,
      y: CANVAS_CENTER_Y + RADIUS_Y * Math.sin(angle) - 28,
    });
  });
  return positions;
}

export interface CollaborationGraphProps {
  agents: SnapshotAgent[];
}

export function CollaborationGraph({ agents }: CollaborationGraphProps) {
  const eventLog = useAppStore(s => s.eventLog);
  const theme = useAppStore(s => s.theme);
  const { t } = useTranslation('collaborationGraph');
  // Wall-clock ticker: terminal edges expire ~10s after completion.
  const [now, setNow] = useState(() => Date.now());
  const hasEdges = useAppStore(s =>
    s.eventLog.some(e => e.family === 'collaboration'),
  );

  useEffect(() => {
    if (!hasEdges) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [hasEdges]);

  const agentIdsKey = agents.map(a => a.id).join(',');

  const nodes = useMemo<Node[]>(() => {
    const positions = circlePositions(agentIdsKey ? agentIdsKey.split(',') : []);
    return agents.map(agent => ({
      id: agent.id,
      type: 'collabAgent',
      position: positions.get(agent.id) ?? { x: 0, y: 0 },
      data: {
        name: agent.name,
        agentId: agent.id,
        activeACCount: agent.activeACCount,
        llmEnabled: agent.llmEnabled,
      } satisfies CollabAgentNodeData,
      draggable: false,
      connectable: false,
    }));
    // Positions come from the id list only, so data refreshes (badge counts)
    // update node data in place without ever moving a node — static layout.
  }, [agentIdsKey, agents]);

  const edges = useMemo<Edge[]>(() => {
    // The store log is newest-first; derivation expects chronological order.
    const chronological = [...eventLog.map(e => e.event)].reverse();
    // Edge colors follow the active theme (lib/theme single source of truth).
    const edgeColors = collabEdgeColors(mapColors(theme));
    return deriveCollabEdges(chronological, now).map(edge => ({
      id: `${edge.key}:${edge.status}`,
      source: edge.source,
      target: edge.target,
      animated: edge.status === 'forming',
      style: {
        stroke: edgeColors[edge.status],
        strokeWidth: 2,
        ...(edge.status === 'forming' ? { strokeDasharray: '6 4' } : {}),
      },
    }));
  }, [eventLog, now, theme]);

  return (
    <div className="collab-graph">
      <div className="collab-graph__title">{t('title')}</div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        fitView
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color={mapColors(theme).border} />
      </ReactFlow>
    </div>
  );
}
