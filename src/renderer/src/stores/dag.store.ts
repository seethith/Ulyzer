import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { DagNode, DagEdge, DagGraph, IpcResponse } from '@shared/types';

interface DAGState {
  nodes: DagNode[];
  edges: DagEdge[];
  selectedNodeId: string | null;
  isGenerating: boolean;

  setDAG: (nodes: DagNode[], edges: DagEdge[]) => void;
  updateNode: (id: string, data: Partial<DagNode>) => void;
  addNode: (node: DagNode) => void;
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  setGenerating: (v: boolean) => void;
  loadDAG: (courseId: string) => Promise<void>;
  saveDAG: (courseId: string) => Promise<void>;
}

export const useDAGStore = create<DAGState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isGenerating: false,

  setDAG: (nodes, edges) => set({ nodes, edges }),

  updateNode: (id, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...data } : n)),
    })),

  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),

  deleteNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter(
        (e) => e.source_node_id !== id && e.target_node_id !== id
      ),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    })),

  selectNode: (id) => set({ selectedNodeId: id }),

  setGenerating: (v) => set({ isGenerating: v }),

  loadDAG: async (courseId) => {
    const res = (await window.api.invoke(IPC.DB_DAG_GET, courseId)) as IpcResponse<DagGraph>;
    if (res.success && res.data) {
      set({ nodes: res.data.nodes, edges: res.data.edges });
    }
  },

  saveDAG: async (courseId) => {
    const { nodes, edges } = get();
    await window.api.invoke(IPC.DB_DAG_SAVE, { courseId, nodes, edges });
  },
}));
