import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, {
  Background,
  Controls,
  BackgroundVariant,
  MarkerType,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Save, LayoutGrid } from 'lucide-react';
import type { DagNode, DagEdge } from '@shared/types';
import { useDAGStore } from '../../stores/dag.store';
import { DAGNodeComponent, ChapterGroupNode } from './DAGNode';
import { NodeBubble } from './NodeBubble';
import { applyDagreLayout, computeChapterBoxes } from './dagLayout';
import type { ChapterBox } from './dagLayout';

const nodeTypes = {
  dagNode:      DAGNodeComponent,
  chapterGroup: ChapterGroupNode,
};

interface DAGCanvasProps {
  onSave: () => void;
}

// ── Converters ────────────────────────────────────────────────────────────────

function toRFNode(n: DagNode): Node<DagNode> {
  return {
    id: n.id,
    type: 'dagNode',
    position: { x: n.position_x, y: n.position_y },
    data: n,
    selected: false,
    zIndex: 2,
  };
}

function toGroupNode(box: ChapterBox, index: number): Node<ChapterBox> {
  return {
    id: `__group_${index}`,
    type: 'chapterGroup',
    position: { x: box.x, y: box.y },
    data: box,
    selectable: false,
    draggable: false,
    zIndex: 1,
  };
}

function toRFEdge(
  e: DagEdge,
  highlighted: boolean,
  dimmed: boolean,
): Edge {
  return {
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    type: 'smoothstep',
    style: {
      stroke: highlighted ? 'var(--accent)' : dimmed ? 'var(--border)' : 'var(--text3)',
      strokeWidth: highlighted ? 2.5 : 1.5,
      opacity: dimmed ? 0.25 : 1,
      transition: 'stroke 0.15s, opacity 0.15s, stroke-width 0.15s',
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: highlighted ? 'var(--accent)' : dimmed ? 'var(--border)' : 'var(--text3)',
      width: 14,
      height: 14,
    },
    animated: false,
  };
}

// ── DAGCanvas ─────────────────────────────────────────────────────────────────

export const DAGCanvas: React.FC<DAGCanvasProps> = ({ onSave }) => {
  const { t } = useTranslation();
  const { nodes, edges, selectedNodeId, isGenerating, updateNode, selectNode, setDAG } =
    useDAGStore();

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // ── Connected edges for hover highlight ──────────────────────────────────────
  const connectedEdgeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    return new Set(
      edges
        .filter((e) => e.source_node_id === hoveredNodeId || e.target_node_id === hoveredNodeId)
        .map((e) => e.id)
    );
  }, [hoveredNodeId, edges]);

  // ── Chapter group boxes ───────────────────────────────────────────────────────
  const chapterBoxes = useMemo(() => computeChapterBoxes(nodes), [nodes]);

  // ── ReactFlow nodes/edges ────────────────────────────────────────────────────
  const rfNodes = useMemo<Node[]>(() => [
    ...chapterBoxes.map((box, i) => toGroupNode(box, i)),
    ...nodes.map(toRFNode),
  ], [nodes, chapterBoxes]);

  const rfEdges = useMemo<Edge[]>(() => {
    const anyHover = hoveredNodeId !== null;
    return edges.map((e) =>
      toRFEdge(
        e,
        anyHover && connectedEdgeIds.has(e.id),
        anyHover && !connectedEdgeIds.has(e.id),
      )
    );
  }, [edges, hoveredNodeId, connectedEdgeIds]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  // ── Auto-layout on first load ─────────────────────────────────────────────────
  const layoutAppliedRef = useRef(false);
  useEffect(() => {
    if (nodes.length > 0 && !layoutAppliedRef.current) {
      layoutAppliedRef.current = true;
      const laid = applyDagreLayout(nodes, edges);
      setDAG(laid, edges);
    }
    if (nodes.length === 0) layoutAppliedRef.current = false;
  }, [nodes.length]);  

  // ── Re-layout button ─────────────────────────────────────────────────────────
  const handleRelayout = useCallback(() => {
    const laid = applyDagreLayout(nodes, edges);
    setDAG(laid, edges);
  }, [nodes, edges, setDAG]);

  // ── ReactFlow handlers ───────────────────────────────────────────────────────
  const handleInit = useCallback((_instance: ReactFlowInstance) => {}, []);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      applyNodeChanges(changes, rfNodes);
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateNode(change.id, {
            position_x: change.position.x,
            position_y: change.position.y,
          });
        }
      }
    },
    [rfNodes, updateNode]
  );

  const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type === 'chapterGroup') return;
      const dagNode = nodes.find((n) => n.id === node.id);
      if (!dagNode) return;
      selectNode(dagNode.id === selectedNodeId ? null : dagNode.id);
    },
    [nodes, selectedNodeId, selectNode]
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_event, node) => {
    if (node.type !== 'chapterGroup') setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

  const onPaneClick = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* ReactFlow canvas */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onInit={handleInit}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={2}
          style={{ backgroundColor: 'var(--bg)' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={28}
            size={1.5}
            color="var(--border)"
          />
          <Controls
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
              overflow: 'hidden',
              boxShadow: 'var(--shadow)',
            }}
          />
        </ReactFlow>


        {/* Toolbar: re-layout + save */}
        <div style={{
          position: 'absolute', top: 10, left: 10,
          display: 'flex', gap: 6, zIndex: 10,
        }}>
          <button
            onClick={handleRelayout}
            title={t('dag_toolbar.relayout')}
            style={{
              width: 32, height: 32, borderRadius: 'var(--r)',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--surface)',
              color: 'var(--text2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', boxShadow: 'var(--shadow)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={onSave}
            title={t('dag_toolbar.save_title')}
            style={{
              width: 32, height: 32, borderRadius: 'var(--r)',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--surface)',
              color: 'var(--text2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', boxShadow: 'var(--shadow)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
          >
            <Save size={14} />
          </button>
        </div>

        {/* Empty state */}
        {nodes.length === 0 && !isGenerating && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🗺️</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>
                {t('dag_canvas.empty_title')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                {t('dag_canvas.empty_subtitle')}
              </div>
            </div>
          </div>
        )}

        {/* Generating indicator */}
        {isGenerating && (
          <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 20, padding: '6px 14px', fontSize: 12, color: 'var(--text2)',
            display: 'flex', alignItems: 'center', gap: 6,
            boxShadow: 'var(--shadow)', pointerEvents: 'none',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              backgroundColor: 'var(--accent)',
              animation: 'cursor-blink 0.9s steps(1) infinite',
              display: 'inline-block',
            }} />
            {t('dag_canvas.generating')}
          </div>
        )}
      </div>

      {/* Node sidebar */}
      {selectedNode && (
        <NodeBubble
          node={selectedNode}
          allNodes={nodes}
          onClose={() => selectNode(null)}
        />
      )}
    </div>
  );
};
