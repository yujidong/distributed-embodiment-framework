/**
 * FlowCanvas — the reactflow canvas of the flow editor: trigger + action
 * node cards (see FlowNodeCards.tsx), edges = dependsOn.
 *
 * The parent (FlowsPage) owns nodes/edges state (useNodesState/useEdgesState)
 * and the FlowEditorContext value; this component is only the canvas chrome.
 * onConnect adds a dependsOn edge (self-loops refused; cycles are reported
 * on save via graphToFlow, matching the server-side validator).
 */

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { TRIGGER_NODE_ID } from '../../lib/flowGraph';
import { mapColors } from '../../lib/theme';
import { useAppStore } from '../../store/useAppStore';
import { flowNodeTypes } from './FlowNodeCards';

export interface FlowCanvasProps {
  nodes: Node[];
  edges: Edge[];
  readOnly: boolean;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({
  nodes,
  edges,
  readOnly,
  onNodesChange,
  onEdgesChange,
  onConnect,
}: FlowCanvasProps) {
  const theme = useAppStore(s => s.theme);

  const connect = (connection: Connection) => {
    // No self-loops; the trigger node takes no dependency edges.
    if (connection.source === connection.target) return;
    if (connection.target === TRIGGER_NODE_ID) return;
    onConnect(connection);
  };

  return (
    <div className="flow-canvas" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={flowNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color={mapColors(theme).border} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
