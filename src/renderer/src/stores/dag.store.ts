import { create } from 'zustand'
import i18n from '../i18n';
import { IPC } from '@shared/ipc-channels'
import { normalizeDagEdges } from '@shared/dag-graph'
import { syncDagProgressWithChapterDependencies } from '@shared/dag-progress'
import type { DagNode, DagEdge, DagGraph, IpcResponse } from '@shared/types'

function syncNodesWithEdges(nodes: DagNode[], edges: DagEdge[]): DagNode[] {
  return syncDagProgressWithChapterDependencies(nodes, edges)
}

function normalizeEdgesForNodes(nodes: DagNode[], edges: DagEdge[]): DagEdge[] {
  return normalizeDagEdges(nodes, edges, {
    getSource: (edge) => edge.source_node_id,
    getTarget: (edge) => edge.target_node_id
  }).edges
}

function stringArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function edgesEqual(a: DagEdge[], b: DagEdge[]): boolean {
  if (a.length !== b.length) return false
  return a.every((edge, index) => {
    const other = b[index]
    return (
      !!other &&
      edge.id === other.id &&
      edge.source_node_id === other.source_node_id &&
      edge.target_node_id === other.target_node_id
    )
  })
}

function needsLocalSync(currentNodes: DagNode[], currentEdges: DagEdge[], nextNodes: DagNode[], nextEdges: DagEdge[]): boolean {
  if (!edgesEqual(currentEdges, nextEdges)) return true
  if (currentNodes.length !== nextNodes.length) return true
  const nextById = new Map(nextNodes.map((node) => [node.id, node]))
  return currentNodes.some((node) => {
    const next = nextById.get(node.id)
    return (
      !next ||
      node.status !== next.status ||
      !stringArrayEqual(node.prerequisites, next.prerequisites)
    )
  })
}

interface DAGState {
  nodes: DagNode[]
  edges: DagEdge[]
  selectedNodeId: string | null
  isGenerating: boolean

  setDAG: (nodes: DagNode[], edges: DagEdge[]) => void
  setEdges: (edges: DagEdge[]) => void
  setNodePositions: (positions: Array<{ id: string; x: number; y: number }>) => void
  updateNode: (id: string, data: Partial<DagNode>) => void
  addNode: (node: DagNode) => void
  addEdge: (edge: DagEdge) => void
  deleteNode: (id: string) => void
  selectNode: (id: string | null) => void
  setGenerating: (v: boolean) => void
  loadDAG: (courseId: string) => Promise<void>
  saveDAG: (courseId: string) => Promise<void>
}

export const useDAGStore = create<DAGState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isGenerating: false,

  setDAG: (nodes, edges) => {
    const normalizedEdges = normalizeEdgesForNodes(nodes, edges)
    set({ nodes: syncNodesWithEdges(nodes, normalizedEdges), edges: normalizedEdges })
  },

  setEdges: (edges) =>
    set((state) => {
      const normalizedEdges = normalizeEdgesForNodes(state.nodes, edges)
      return {
        edges: normalizedEdges,
        nodes: syncNodesWithEdges(state.nodes, normalizedEdges)
      }
    }),

  setNodePositions: (positions) =>
    set((state) => {
      const positionById = new Map(positions.map((position) => [position.id, position]))
      return {
        nodes: state.nodes.map((node) => {
          const position = positionById.get(node.id)
          if (!position) return node
          return {
            ...node,
            position_x: position.x,
            position_y: position.y
          }
        })
      }
    }),

  updateNode: (id, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...data } : n))
    })),

  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),

  addEdge: (edge) =>
    set((state) => {
      const nextEdges = normalizeEdgesForNodes(state.nodes, [...state.edges, edge])
      return {
        edges: nextEdges,
        nodes: syncNodesWithEdges(state.nodes, nextEdges)
      }
    }),

  deleteNode: (id) =>
    set((state) => {
      const nextNodes = state.nodes
        .filter((n) => n.id !== id)
        .map((n) => ({
          ...n,
          prerequisites: n.prerequisites.filter((p) => p !== id)
        }))
      const nextEdges = state.edges.filter(
        (e) => e.source_node_id !== id && e.target_node_id !== id
      )
      const normalizedEdges = normalizeEdgesForNodes(nextNodes, nextEdges)
      return {
        nodes: syncNodesWithEdges(nextNodes, normalizedEdges),
        edges: normalizedEdges,
        selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId
      }
    }),

  selectNode: (id) => set({ selectedNodeId: id }),

  setGenerating: (v) => set({ isGenerating: v }),

  loadDAG: async (courseId) => {
    set({ nodes: [], edges: [], selectedNodeId: null })
    const res = (await window.api.invoke(IPC.DB_DAG_GET, courseId)) as IpcResponse<DagGraph>
    if (res.success && res.data) {
      const normalizedEdges = normalizeEdgesForNodes(res.data.nodes, res.data.edges)
      set({ nodes: syncNodesWithEdges(res.data.nodes, normalizedEdges), edges: normalizedEdges })
    }
  },

  saveDAG: async (courseId) => {
    const { nodes, edges } = get()
    const normalizedEdges = normalizeEdgesForNodes(nodes, edges)
    const syncedNodes = syncNodesWithEdges(nodes, normalizedEdges)
    if (needsLocalSync(nodes, edges, syncedNodes, normalizedEdges)) {
      set({
        nodes: syncedNodes,
        edges: normalizedEdges
      })
    }
    const res = (await window.api.invoke(IPC.DB_DAG_SAVE, {
      courseId,
      nodes: syncedNodes,
      edges: normalizedEdges
    })) as IpcResponse<DagGraph>
    if (!res.success) throw new Error(res.error ?? i18n.t('errors.save_roadmap_failed'))
  }
}))
