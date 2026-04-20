import dagre from 'dagre';
import type { DagNode, DagEdge } from '@shared/types';

export const NODE_W = 180;
export const NODE_H = 90;

// ── Dagre auto-layout (top → bottom) ─────────────────────────────────────────

export function applyDagreLayout(nodes: DagNode[], edges: DagEdge[]): DagNode[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source_node_id, e.target_node_id));

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (!pos) return n;
    return { ...n, position_x: pos.x - NODE_W / 2, position_y: pos.y - NODE_H / 2 };
  });
}

// ── Chapter bounding boxes for group overlays ─────────────────────────────────

export interface ChapterBox {
  chapter: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAD = 20;

export function computeChapterBoxes(nodes: DagNode[]): ChapterBox[] {
  const map = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

  for (const n of nodes) {
    if (n.node_type === 'boss') continue; // boss nodes span chapters — exclude from grouping
    const key = n.chapter ?? '其他';
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { minX: n.position_x, minY: n.position_y, maxX: n.position_x + NODE_W, maxY: n.position_y + NODE_H });
    } else {
      map.set(key, {
        minX: Math.min(existing.minX, n.position_x),
        minY: Math.min(existing.minY, n.position_y),
        maxX: Math.max(existing.maxX, n.position_x + NODE_W),
        maxY: Math.max(existing.maxY, n.position_y + NODE_H),
      });
    }
  }

  return Array.from(map.entries()).map(([chapter, b]) => ({
    chapter,
    x: b.minX - PAD,
    y: b.minY - PAD,
    width:  b.maxX - b.minX + PAD * 2,
    height: b.maxY - b.minY + PAD * 2,
  }));
}
